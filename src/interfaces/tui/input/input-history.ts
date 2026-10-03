import type { UiDraft } from '../../../application/ports/ui-input-store.js';
import type { HistoryMetadata, TranscriptReadingPort } from '../../../application/coordinator/history.js';
import { HISTORY_CHUNK_BYTES } from '../../../application/coordinator/history.js';
import { MAX_USER_MESSAGE_CHARS } from '../../../application/coordinator/user-message.js';
import { textDraft } from './composer-editor.js';

/** Full recall uses the original user entry, never labels or historical paste IDs. */
export async function readHistoricalInput(port: TranscriptReadingPort, session: string, entryId: string, signal?: AbortSignal): Promise<UiDraft> {
  let text = '', offset = 0;
  for (;;) {
    signal?.throwIfAborted();
    const range = await port.body({ coordinatorSessionId: session,
      source: { kind: 'history', entryId, contentRevision: 1 }, offset, maxBytes: HISTORY_CHUNK_BYTES });
    signal?.throwIfAborted();
    if (range === null || range.offset !== offset || range.end < offset) throw new Error('历史输入原文不可用');
    text += range.text;
    if (text.length > MAX_USER_MESSAGE_CHARS) throw new RangeError('历史输入超过消息长度上限');
    if (range.end === range.byteLength) return textDraft(text);
    if (range.end === offset) throw new Error('历史输入读取没有进展');
    offset = range.end;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

/** One scalar keyset and one preview; the saved original UiDraft remains untouched. */
export class InputHistory {
  private generation = 0;
  private original: UiDraft | null = null;
  private selected: HistoryMetadata | null = null;
  private upper = 0;
  private session = '';
  private preview: UiDraft | null = null;
  private readonly reading: TranscriptReadingPort;
  constructor(reading: TranscriptReadingPort) { this.reading = reading; }
  get active(): boolean { return this.original !== null; }
  get draft(): UiDraft | null { return this.preview; }
  cancel(): UiDraft | null {
    this.generation++;
    const original = this.original;
    this.original = null; this.selected = null; this.preview = null;
    return original;
  }
  /** Cursor-only edits keep recall; text/paste edits adopt through the caller's old pipeline. */
  canMove(draft: UiDraft, direction: 'older' | 'newer'): boolean {
    return this.active && draft.text === this.preview?.text &&
      (direction === 'older' ? draft.cursor === 0 : draft.cursor === draft.text.length);
  }
  async move(session: string, draft: UiDraft, direction: 'older' | 'newer'): Promise<UiDraft | null> {
    const inspection = this.reading.inspection;
    if (inspection === undefined) throw new Error('输入历史不可用');
    const generation = ++this.generation;
    if (this.original === null || this.session !== session) {
      if (direction === 'newer') return null;
      const snapshot = await inspection.snapshot(session);
      if (generation !== this.generation) return null;
      this.original = draft; this.session = session; this.upper = snapshot.upperSequence;
      this.selected = null;
    }
    const page = await inspection.users({ coordinatorSessionId: session, upperSequence: this.upper, direction,
      ...(this.selected === null ? {} : direction === 'older' ? { before: this.selected.sequence } : { after: this.selected.sequence }) });
    if (generation !== this.generation) return null;
    const entry = direction === 'older' ? page.entries.at(-1) : page.entries[0];
    if (entry === undefined) return direction === 'newer' ? this.cancel() : this.preview;
    const recalled = await readHistoricalInput(this.reading, session, entry.entryId);
    if (generation !== this.generation) return null;
    this.selected = entry; this.preview = recalled;
    return recalled;
  }
}
