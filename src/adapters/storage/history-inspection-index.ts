/**
 * IC-04 派生索引：可信工具调用的引用与字节范围（design D-03）。
 *
 * 权威原文只有一份。参数仍然留在 `conversation_entries.metadata`，这里既不复制它，也不调用
 * `json_extract` / `json_each` 去解析它：扫描器直接在 UTF-8 字节上跑一个有限状态机，得到的偏移
 * 就是原文本偏移，可以交给 `substr(CAST(metadata AS BLOB), …)` 精确读回任意一段。
 *
 * 状态可序列化并跨调用续扫，所以一次索引推进只需要固定字节预算：参数即使有 5 MiB，也不会在
 * 任何一次调用里把整段 metadata 读进内存，扫描还可以在分块边界安全暂停。
 */

/** 单次读取原 metadata 的块大小；与历史正文的分块大小保持一致。 */
export const TOOL_CALL_SCAN_CHUNK_BYTES = 16 * 1024;
/** 身份字段的捕获上限；超过即不建立定位，只保留字节范围。 */
const IDENTITY_CAPTURE_BYTES = 512;

const ACTIVITY_KINDS = ['query', 'action', 'unclassified'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** 一个已提交调用的定位：身份来自原记录，参数只有原 metadata 中的字节范围。 */
export type ToolCallSpan = {
  readonly ordinal: number;
  readonly callId: string;
  readonly name: string;
  readonly operationId: string;
  readonly activityKind: ActivityKind;
  readonly argsStart: number;
  readonly argsEnd: number;
};

/** 一个调用的可信结局：配对结果优先，其次是真实 unknown 观测，都没有才是未确认。 */
export type CallStatus = 'ok' | 'rejected' | 'unknown' | 'unconfirmed';

/** 活动摘要计数；读组状态只看这四个计数，不回扫成员。 */
export type ActivityTally = {
  readonly memberCount: number;
  readonly okCount: number;
  readonly rejectedCount: number;
  readonly unknownCount: number;
  readonly unconfirmedCount: number;
};

/** 组的结局取最值得注意的那个成员：unknown > rejected > ok > unconfirmed。 */
export function activityStatusOf(tally: ActivityTally): CallStatus {
  if (tally.unknownCount > 0) return 'unknown';
  if (tally.rejectedCount > 0) return 'rejected';
  if (tally.okCount > 0) return 'ok';
  return 'unconfirmed';
}

/** 计数增减都只改一个桶，因此成员状态变化是 O(1)，不随组大小增长。 */
export function tallyOf(tally: ActivityTally, status: CallStatus, delta: number): ActivityTally {
  return { memberCount: tally.memberCount,
    okCount: tally.okCount + (status === 'ok' ? delta : 0),
    rejectedCount: tally.rejectedCount + (status === 'rejected' ? delta : 0),
    unknownCount: tally.unknownCount + (status === 'unknown' ? delta : 0),
    unconfirmedCount: tally.unconfirmedCount + (status === 'unconfirmed' ? delta : 0) };
}

type PendingCall = {
  callId: string | null;
  name: string | null;
  operationId: string | null;
  activityKind: string | null;
  argsStart: number | null;
  argsEnd: number | null;
};

type Frame = {
  readonly kind: 'object' | 'array';
  /** 已读到、等待取值的键。 */
  key: string | null;
  /** 该数组是顶层 `toolCalls`。 */
  readonly toolCalls: boolean;
  /** 该对象是 `toolCalls` 的一个元素；只有它可能产生调用。 */
  readonly element: boolean;
  readonly call: PendingCall | null;
  /** 该帧是某个元素的 `args` 值容器时，记录它在栈中的深度与起点。 */
  readonly argsOwner: number | null;
  readonly argsStart: number | null;
};

type OpenString = { readonly start: number; readonly bytes: number[]; over: boolean; escaped: boolean };
type ClosedString = { readonly start: number; readonly end: number; readonly value: string | null };

/** 可 JSON 往返的扫描状态；`pos` 是下一段未消费字节在原 metadata 中的绝对偏移。 */
export type MetadataScanState = {
  pos: number;
  stack: Frame[];
  open: OpenString | null;
  closed: ClosedString | null;
  ordinal: number;
  /** 已完成但本次不发出的定位；条目数预算用尽时留在状态里，下一次调用先发出它们。 */
  pending: ToolCallSpan[];
};

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const COLON = 0x3a;

const decoder = new TextDecoder('utf-8', { fatal: true });

function isWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function top(state: MetadataScanState): Frame | null {
  return state.stack[state.stack.length - 1] ?? null;
}

function blankCall(): PendingCall {
  return { callId: null, name: null, operationId: null, activityKind: null, argsStart: null, argsEnd: null };
}

/** 未知或缺失的分类一律收敛为 `unclassified`：分类只由响应接受点写入，扫描不猜测语义。 */
function activityKindOf(raw: string | null): ActivityKind {
  return raw !== null && (ACTIVITY_KINDS as readonly string[]).includes(raw) ? raw as ActivityKind : 'unclassified';
}

/** JSON 字符串体的反转义；捕获上限内才可能走到这里。 */
function unescapeJson(text: string): string {
  if (!text.includes(String.fromCharCode(BACKSLASH))) return text;
  return text.replace(/\\(u[0-9a-fA-F]{4}|["\\/bfnrt])/g, (_match, escaped: string) => {
    switch (escaped) {
      case 'b': return '\b';
      case 'f': return '\f';
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'u': return String.fromCharCode(parseInt(escaped.slice(1), 16));
      default: return escaped;
    }
  });
}

function decodeStringBody(bytes: readonly number[]): string {
  return unescapeJson(decoder.decode(Uint8Array.from(bytes)));
}

function applyStringValue(frame: Frame, token: ClosedString): void {
  const call = frame.call;
  if (call === null) return;
  if (frame.key === 'args') { call.argsStart = token.start; call.argsEnd = token.end; return; }
  if (token.value === null) return;
  if (frame.key === 'callId') call.callId = token.value;
  else if (frame.key === 'name') call.name = token.value;
  else if (frame.key === 'operationId') call.operationId = token.value;
  else if (frame.key === 'activityKind') call.activityKind = token.value;
}

function toSpan(call: PendingCall, ordinal: number): ToolCallSpan | null {
  if (call.callId === null || call.name === null || call.operationId === null) return null;
  const start = call.argsStart ?? 0;
  return { ordinal, callId: call.callId, name: call.name, operationId: call.operationId,
    activityKind: activityKindOf(call.activityKind), argsStart: start, argsEnd: call.argsEnd ?? start };
}

export function createMetadataScanState(): MetadataScanState {
  return { pos: 0, stack: [], open: null, closed: null, ordinal: 0, pending: [] };
}

/**
 * 消费原 metadata 的一段字节，返回这一段里完成的调用定位。
 *
 * `chunkStart` 是 `chunk[0]` 在原 metadata 中的绝对字节偏移；状态按块续扫，跨块的字符串、
 * 转义与嵌套容器都从 `state` 里继续，不依赖任何块内缓冲。
 */
export function scanMetadataBytes(state: MetadataScanState, chunk: Uint8Array, chunkStart: number, maxSpans = Number.POSITIVE_INFINITY): readonly ToolCallSpan[] {
    const spans: ToolCallSpan[] = state.pending;
    state.pending = [];
    let i = 0;
    let pos = chunkStart;
    while (i < chunk.length) {
      const byte = chunk[i]!;
      if (state.open !== null) {
        const open = state.open;
        if (open.escaped) open.escaped = false;
        else if (byte === BACKSLASH) open.escaped = true;
        else if (byte === QUOTE) {
          state.closed = { start: open.start, end: pos + 1, value: open.over ? null : decodeStringBody(open.bytes) };
          state.open = null;
        } else if (!open.over) {
          if (open.bytes.length < IDENTITY_CAPTURE_BYTES) open.bytes.push(byte);
          else { open.over = true; open.bytes.length = 0; }
        }
        i += 1; pos += 1;
        continue;
      }
      if (state.closed !== null) {
        if (isWhitespace(byte)) { i += 1; pos += 1; continue; }
        const parent = top(state);
        if (byte === COLON) {
          if (parent !== null) parent.key = state.closed.value;
          state.closed = null;
          i += 1; pos += 1;
          continue;
        }
        if (parent !== null) applyStringValue(parent, state.closed);
        state.closed = null;
        continue;
      }
      if (isWhitespace(byte)) { i += 1; pos += 1; continue; }
      if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
        const parent = top(state);
        const element = byte === OPEN_BRACE && parent !== null && parent.toolCalls;
        const owner = byte === OPEN_BRACE && parent !== null && parent.element && parent.key === 'args' && parent.call !== null;
        if (owner && parent !== null && parent.call !== null) parent.call.argsStart = pos;
        state.stack.push({ kind: byte === OPEN_BRACE ? 'object' : 'array', key: null,
          toolCalls: byte === OPEN_BRACKET && parent !== null && parent.kind === 'object' && parent.key === 'toolCalls' && state.stack.length === 1,
          element, call: element ? blankCall() : null, argsOwner: owner ? state.stack.length - 1 : null, argsStart: owner ? pos : null });
        if (parent !== null) parent.key = null;
        i += 1; pos += 1;
        continue;
      }
      if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
        const closed = state.stack.pop();
        if (closed !== undefined) {
          if (closed.argsOwner !== null) {
            const owner = state.stack[closed.argsOwner]?.call ?? null;
            if (owner !== null) owner.argsEnd = pos + 1;
          }
          const parent = top(state);
          if (parent !== null) parent.key = null;
          if (closed.element && closed.call !== null) {
            const span = toSpan(closed.call, state.ordinal);
            if (span !== null) {
              state.ordinal += 1;
              // 条目预算用尽就在这里停下：位置与栈都留在状态里，剩余字节下次继续。
              // 收尾括号必须先消费掉，否则下一次调用会拿它去弹上一层栈。
              if (spans.length >= maxSpans) { pos += 1; state.pending = [span]; break; }
              spans.push(span);
            }
          }
        }
        i += 1; pos += 1;
        continue;
      }
      if (byte === QUOTE) { state.open = { start: pos, bytes: [], over: false, escaped: false }; i += 1; pos += 1; continue; }
      // 数字、字面量、逗号与已经消费过的冒号：与定位无关，逐字节跳过。
      i += 1; pos += 1;
    }
    state.pos = pos;
    return spans;
}

/** 已经持有完整 metadata 文本时的单次扫描（提交路径）；仍然按块驱动，不整段解析。 */
export function scanMetadataText(text: string): readonly ToolCallSpan[] {
    const bytes = new TextEncoder().encode(text);
    const state = createMetadataScanState();
    const spans: ToolCallSpan[] = [];
    for (let start = 0; start < bytes.length; start += TOOL_CALL_SCAN_CHUNK_BYTES)
        spans.push(...scanMetadataBytes(state, bytes.subarray(start, start + TOOL_CALL_SCAN_CHUNK_BYTES), start));
    return spans;
}
