/** Disposable append-only streaming sources; never a recovery checkpoint. */
import { closeSync, ftruncateSync, mkdtempSync, openSync, readSync, rmdirSync, unlinkSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HISTORY_CHUNK_BYTES, HistoryBoundaryError, transcriptBodyQuerySchema,
  type TranscriptBodyQuery, type TranscriptBodyRange, type TranscriptPreview, type TranscriptStreamEvent,
} from '../../application/coordinator/history.js';

export const PREVIEW_STORE_BYTES = 64 * 1024 * 1024;
export const PREVIEW_STORE_ITEMS = 64;
/** 预览为什么不可用；宿主据此记录诊断，读取侧据此显式展示，而不是靠解析文案。 */
export type TranscriptPreviewFailure = 'items_capacity' | 'bytes_capacity' | 'storage_unavailable' | 'unknown_preview';
export type TranscriptPreviewObservation =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'not_saved'; readonly reason: TranscriptPreviewFailure };
export type TranscriptPreviewCloseResult = { readonly disposed: number; readonly failed: number };
type RecordEntry = {
  meta: TranscriptPreview; file: string | null; fd: number | null; pins: number; carry: string;
  /** 非 null 表示这条预览的正文已经不可读；内容版本随之归位，不再有可解析的前缀。 */
  failure: TranscriptPreviewFailure | null;
};
const isMissing = (error: unknown): boolean => typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';

export function createTranscriptPreviewStore(options: {
  readonly maxBytes?: number; readonly maxItems?: number; readonly notificationDelay?: number;
} = {}) {
  const maxBytes = options.maxBytes ?? PREVIEW_STORE_BYTES, maxItems = options.maxItems ?? PREVIEW_STORE_ITEMS;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxItems) || maxItems < 1) throw new RangeError('invalid preview capacity');
  const records = new Map<string, RecordEntry>();
  const listeners = new Set<(session: string) => void>();
  const changed = new Set<string>();
  let directory: string | null = null, bytes = 0, serial = 0, closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const notify = (session: string) => {
    if (closed) return;
    changed.add(session);
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      const pending = [...changed]; changed.clear();
      // A broken subscriber must not take the process down with it, nor starve the other
      // sessions: notifications are a rendering hint, never part of the streaming contract.
      for (const id of pending) for (const listener of [...listeners]) {
        try {
          listener(id);
        } catch {
          /* the next notification re-requests whatever this subscriber missed */
        }
      }
    }, options.notificationDelay ?? 33);
    timer.unref();
  };
  /**
   * 释放一条预览，返回未完成的清理步骤（null 表示全部成功）。
   *
   * 记账与文件状态先归位再报错：临时文件删不掉最多留下一个孤儿文件，绝不能让一次清理失败
   * 把 `bytes` 记歪，或让退出路径抛出去。
   */
  const dispose = (entry: RecordEntry): unknown => {
    let failure: unknown = null;
    if (entry.fd !== null) {
      try { closeSync(entry.fd); } catch (error) { failure ??= error; }
      entry.fd = null;
    }
    if (entry.file !== null) {
      try { unlinkSync(entry.file); } catch (error) { if (!isMissing(error)) failure ??= error; }
      entry.file = null;
    }
    bytes -= entry.meta.byteLength;
    // 没有文件就没有正文：内容版本回到 1，固定中的旧锚点读到的只能是「不可用」。
    entry.meta = { ...entry.meta, byteLength: 0, contentRevision: 1 };
    return failure;
  };
  const evict = (except: string): boolean => {
    const candidates = [...records.entries()].filter(([id, entry]) => id !== except && entry.pins === 0);
    const candidate = candidates.find(([, entry]) => entry.meta.status !== 'streaming') ?? candidates[0];
    if (candidate === undefined) return false;
    const [id, entry] = candidate; dispose(entry); records.delete(id); notify(entry.meta.coordinatorSessionId);
    return true;
  };
  const observe = (event: TranscriptStreamEvent, afterSequence = 0): TranscriptPreviewObservation => {
    if (closed) return { kind: 'not_saved', reason: 'storage_unavailable' };
    if (event.kind === 'started') {
      if (records.has(event.previewId)) return { kind: 'accepted' };
      // 条目上限是硬上限：淘汰不出位置就不登记这一条。少一条预览远好过突破上限——一旦允许
      // 超额，内存、临时文件和「有界」这个前提会一起失效。
      while (records.size >= maxItems) if (!evict(event.previewId)) break;
      if (records.size >= maxItems) {
        notify(event.coordinatorSessionId);
        return { kind: 'not_saved', reason: 'items_capacity' };
      }
      const entry: RecordEntry = { pins: 0, fd: null, file: null, carry: '', failure: null, meta: {
        coordinatorSessionId: event.coordinatorSessionId, previewId: event.previewId,
        afterSequence, contentRevision: 1, byteLength: 0, status: 'streaming', entryId: null,
      } };
      records.set(event.previewId, entry);
      try {
        directory ??= mkdtempSync(join(tmpdir(), 'orca-companion-preview-'));
        entry.file = join(directory, String(++serial));
        entry.fd = openSync(entry.file, 'wx+', 0o600);
      } catch {
        entry.file = null;
        entry.failure = 'storage_unavailable';
        entry.meta = { ...entry.meta, status: 'not_saved' };
      }
      notify(event.coordinatorSessionId);
      return entry.failure === null ? { kind: 'accepted' } : { kind: 'not_saved', reason: entry.failure };
    }
    const entry = records.get(event.previewId);
    if (entry === undefined || entry.meta.coordinatorSessionId !== event.coordinatorSessionId) {
      return { kind: 'not_saved', reason: 'unknown_preview' };
    }
    if (event.kind === 'committed') {
      entry.meta = { ...entry.meta, status: 'committed', entryId: event.entryId };
    } else if (event.kind === 'interrupted') {
      if (entry.meta.status !== 'not_saved') entry.meta = { ...entry.meta, status: 'interrupted' };
    } else if (entry.failure === null && entry.fd !== null) {
      try {
        // A provider may cut between a surrogate pair. Hold the dangling high surrogate back so
        // every encoded range stays whole text: encoding it alone would write U+FFFD and the
        // character would be lost for good.
        const text = entry.carry + event.text;
        const dangling = /[\uD800-\uDBFF]/u.test(text.at(-1) ?? '');
        entry.carry = dangling ? text.at(-1)! : '';
        const whole = dangling ? text.slice(0, -1) : text;
        // Encode only bounded slices; the preview store never joins accumulated text.
        for (let offset = 0; offset < whole.length;) {
          let end = Math.min(whole.length, offset + HISTORY_CHUNK_BYTES / 4);
          if (end < whole.length && /[\uD800-\uDBFF]/u.test(whole[end - 1]!)) end -= 1;
          // The block boundary lands between a surrogate pair as often as the delta boundary
          // does; a half code point would be written as U+FFFD and the character would be lost.
          const block = Buffer.from(whole.slice(offset, end));
          while (bytes + block.length > maxBytes) {
            if (!evict(event.previewId)) { entry.failure = 'bytes_capacity'; throw new RangeError('preview capacity exhausted'); }
          }
          let written = 0;
          while (written < block.length) written += writeSync(entry.fd, block, written, block.length - written, entry.meta.byteLength + written);
          bytes += block.length;
          entry.meta = { ...entry.meta, byteLength: entry.meta.byteLength + block.length,
            contentRevision: entry.meta.byteLength + block.length + 1 };
          offset = end;
        }
      } catch {
        // Roll back a partial block; only fully written UTF-8 ranges are readable.
        try { ftruncateSync(entry.fd, entry.meta.byteLength); } catch { dispose(entry); }
        entry.failure ??= 'storage_unavailable';
        entry.meta = { ...entry.meta, status: 'not_saved' };
      }
    }
    notify(event.coordinatorSessionId);
    return entry.failure === null ? { kind: 'accepted' } : { kind: 'not_saved', reason: entry.failure };
  };
  const body = (input: TranscriptBodyQuery): TranscriptBodyRange | null => {
    const query = transcriptBodyQuerySchema.parse(input);
    if (query.source.kind !== 'preview' || closed) return null;
    const entry = records.get(query.source.previewId);
    if (entry?.fd === null || entry === undefined || entry.meta.coordinatorSessionId !== query.coordinatorSessionId) return null;
    const byteLength = query.source.contentRevision - 1;
    if (byteLength > entry.meta.byteLength || query.offset > byteLength) return null;
    // One look-ahead byte detects an incomplete UTF-8 code point at the end.
    const wanted = Math.min(query.maxBytes, byteLength - query.offset);
    const block = Buffer.alloc(Math.min(wanted + 1, byteLength - query.offset));
    const read = readSync(entry.fd, block, 0, block.length, query.offset);
    const data = block.subarray(0, read);
    if (data.length > 0 && (data[0]! & 0xc0) === 0x80) throw new HistoryBoundaryError('preview offset is not a UTF-8 boundary');
    let end = Math.min(wanted, data.length);
    while (end > 0 && end < data.length && (data[end]! & 0xc0) === 0x80) end -= 1;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, end));
    return { source: query.source, offset: query.offset, end: query.offset + end, byteLength, text };
  };
  return {
    observe, body,
    list: (session: string): readonly TranscriptPreview[] => [...records.values()]
      .filter(entry => entry.meta.coordinatorSessionId === session).map(entry => entry.meta),
    pin: (session: string, id: string): (() => void) => {
      const entry = records.get(id);
      if (entry === undefined || entry.meta.coordinatorSessionId !== session) return () => {};
      entry.pins += 1;
      let released = false;
      return () => { if (!released) { released = true; entry.pins -= 1; } };
    },
    subscribe: (listener: (session: string) => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    stats: () => ({ bytes, items: records.size }),
    /**
     * 关闭并清理全部临时资源。
     *
     * 退出路径不抛：清理失败只按条数上报，宿主据此记录一条诊断。临时文件删不掉最多留下孤儿
     * 文件，绝不能把模型响应或进程退出一起带走。
     */
    close: (): TranscriptPreviewCloseResult => {
      if (closed) return { disposed: 0, failed: 0 };
      closed = true;
      if (timer !== null) { clearTimeout(timer); timer = null; }
      let disposed = 0, failed = 0;
      for (const entry of records.values()) { disposed += 1; if (dispose(entry) !== null) failed += 1; }
      records.clear(); listeners.clear(); changed.clear();
      if (directory !== null) {
        try { rmdirSync(directory); } catch (error) { if (!isMissing(error)) failed += 1; }
        directory = null;
      }
      return { disposed, failed };
    },
  };
}
