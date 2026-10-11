/**
 * IC-04 派生显示投影：json_blocks assistant 正文的增量扫描与增量解码（design D-03）。
 *
 * 权威原文仍然只有 conversation_bodies 一份；这里按 fromDurableMessage 的可见文本规则
 * （type 为 text 且 thought 不为 true）把正文投影成一份独立的 UTF-8 显示来源，显示、排版与搜索
 * 共用它，因此读取路径不必解析也不必持有整段响应。
 *
 * 一次推进有两个游标，都在状态里：字节级扫描器定位可见 text 块在原文中的范围，解码游标把该范围
 * 按固定窗口反转义成分段显示文本。因此调用方每次只读固定字节预算，5 MiB 的单个 text 块也不会让任何
 * 一次调用越界；已落盘的块与映射幂等，崩溃后从未完成的位置续扫，不重复也不丢字。
 *
 * 扫描器同时是这份正文的 JSON 语法判定者：结构、转义与分隔符按 JSON 严格核对，容器嵌套有上限，
 * 根闭合之后还要读到正文末尾。因此截断的合法前缀、尾随垃圾和坏字符串都不会被当成一份完整的
 * 显示来源，只有真正完整的正文才登记投影。
 */

import { HISTORY_CHUNK_BYTES } from '../../application/coordinator/history.js';

/** 扫描与解码各自的单次窗口；与历史正文的分块大小一致，中文与 emoji 不会被按字符数绕过。 */
export const DISPLAY_PROJECTION_CHUNK_BYTES = HISTORY_CHUNK_BYTES;
/** type 等身份键的捕获上限；超过即不建立可见文本定位，按没有投影处理。 */
const IDENTITY_CAPTURE_BYTES = 512;
/**
 * 裸字面量（数字与 true/false/null）的捕获上限。
 *
 * 超出即判为非法结构：真实协议正文里不会出现这么长的字面量，因此不需要为它保留有界游标空间。
 */
const BARE_CAPTURE_BYTES = 32;
/** 容器嵌套上限；更深的正文判为非法结构，不建立显示来源，游标也不会随深度无界增长。 */
export const DISPLAY_PROJECTION_MAX_DEPTH = 64;
/** 落盘游标的字节上限；一次准备读写的游标都不会超过它。 */
export const DISPLAY_PROJECTION_STATE_BYTES = 64 * 1024;
/** 一个 unicode 转义的完整长度：反斜杠、u 与四位十六进制。 */
const UNICODE_ESCAPE_BYTES = 6;
/** 一个代理对由两个 unicode 转义组成。 */
const SURROGATE_PAIR_BYTES = 12;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const LOW_U = 0x75;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const COLON = 0x3a;
const COMMA = 0x2c;
const TAB = 0x09;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const HEX4 = /^[0-9a-fA-F]{4}$/;
const NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;
const LITERAL = /^(?:true|false|null)$/;

/** 容器在下一个非空白字节之前只接受这一类结构；这是严格 JSON 语法的唯一来源。 */
type Expect = 'value' | 'key' | 'colon' | 'comma' | 'done';

/** 一个可见 text 块在原文中的字节范围：开引号之后到闭引号之前，不含引号本身。 */
export type DisplayTextSpan = {
  readonly ordinal: number;
  readonly start: number;
  readonly end: number;
};

/** 一段显示文本与它在原文中的对应范围；显示坐标与原文坐标各自独立。 */
export type DisplaySpanMapping = {
  readonly ordinal: number;
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly displayStart: number;
  readonly displayEnd: number;
};

type ElementState = {
  type: string | null;
  thought: boolean;
  textStart: number | null;
  textEnd: number | null;
};

type Frame = {
  readonly kind: 'object' | 'array';
  key: string | null;
  /** 该对象是根数组的一个元素，也就是一个内容块。 */
  readonly element: boolean;
  state: ElementState | null;
  expect: Expect;
  /** 已经收下过成员或值：空容器可闭合，尾逗号与空位一类写法一律拒绝。 */
  nonEmpty: boolean;
};

/** escape：0 是普通字节，1 是刚见过的反斜杠，2..5 是已收下的 unicode 位数。 */
type OpenString = { readonly start: number; readonly asKey: boolean; bytes: number[]; over: boolean; escape: number };
type BareToken = { bytes: number[]; over: boolean };
type ClosedString = { readonly start: number; readonly end: number; readonly value: string | null };

/** 可 JSON 往返的字节级扫描状态；pos 是下一段未消费字节在原文中的绝对偏移。 */
export type DisplayScanState = {
  pos: number;
  stack: Frame[];
  open: OpenString | null;
  /** 正在读的数字或 true/false/null；越过上限或不是合法字面量即判为非法结构。 */
  bare: BareToken | null;
  /** 栈空时生效的根层期待：值 → 闭合。 */
  expect: Expect;
  /** 根不是数组：正文不是内容块数组，没有可投影的形状。 */
  invalid: boolean;
  /** 结构越界、语法不合法，或读到正文末尾时根仍未闭合。 */
  malformed: boolean;
  /** 根已经闭合且正文已经读完；此前不得当作完整来源。 */
  complete: boolean;
  ordinal: number;
  /** 本次条目预算内不发出的定位；预算用尽时留在状态里，下一次调用先发出它们。 */
  pending: DisplayTextSpan[];
};

/**
 * 一次投影推进的完整游标。
 *
 * `span` 是已定位但尚未解码完的块，`decodePos` 是块内已读偏移，decodeTail 保留最多11字节残留转义；状态不依赖调用之间
 * 的内存，因此准备过程可以在任意一次调用后停止。
 */
export type DisplayProjectionState = {
  readonly scan: DisplayScanState;
  readonly span: DisplayTextSpan | null;
  readonly decodePos: number;
  readonly decodeTail: readonly number[];
  /** 已经落盘的显示字节数；也是显示来源的当前长度。 */
  readonly displayBytes: number;
  /** 已经落盘的非空块数：它决定下一个块之前是否写分隔符。 */
  readonly blocks: number;
  /** 当前块的显示起点；null 表示当前块还没有产生任何字节。 */
  readonly openStart: number | null;
};

export type DisplayProjectionRead = (offset: number, length: number) => Uint8Array;

export type DisplayProjectionAdvance = {
  readonly state: DisplayProjectionState;
  readonly chunks: readonly { start: number; data: Uint8Array }[];
  readonly mapping: readonly DisplaySpanMapping[];
  /** 本次实际读取的原文字节数。 */
  readonly scannedBytes: number;
  /** 正文已读完且当前块已解码完：显示来源此时才是完整的。 */
  readonly complete: boolean;
};

const isWhitespace = (byte: number): boolean => byte === 0x20 || byte === TAB || byte === 0x0a || byte === 0x0d;
const isLiteralByte = (byte: number): boolean =>
  (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);
/** 数字与字面量的字符集；其余字节都是它们的终止符。 */
const isBareByte = (byte: number): boolean => isLiteralByte(byte) || byte === 0x2d || byte === 0x2b || byte === 0x2e;
const isBareStart = (byte: number): boolean => isLiteralByte(byte) || byte === 0x2d;
const isHexByte = (byte: number): boolean =>
  (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66);
const closes = (kind: 'object' | 'array', byte: number): boolean =>
  (kind === 'array' && byte === CLOSE_BRACKET) || (kind === 'object' && byte === CLOSE_BRACE);

const top = (state: DisplayScanState): Frame | null => state.stack[state.stack.length - 1] ?? null;

export function createDisplayScanState(): DisplayScanState {
  return { pos: 0, stack: [], open: null, bare: null, expect: 'value', invalid: false, malformed: false, complete: false, ordinal: 0, pending: [] };
}

export function createDisplayProjectionState(): DisplayProjectionState {
  return { scan: createDisplayScanState(), span: null, decodePos: 0, decodeTail: [], displayBytes: 0, blocks: 0, openStart: null };
}

/** 身份键只反转义 unicode 转义；其它转义不属于身份，按原字符保留。 */
function decodeCaptured(bytes: readonly number[]): string {
  const text = decoder.decode(Uint8Array.from(bytes));
  if (!text.includes('\\')) return text;
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * 把一个键的字符串值记到它所属的内容块上。
 *
 * text 只登记内部字节范围：正文再大也不需要把值捕获进状态，因此超过身份键上限的长文本仍然有定位。
 */
function applyStringValue(frame: Frame, token: ClosedString): void {
  if (!frame.element || frame.state === null) return;
  if (frame.key === 'text') { frame.state.textStart = token.start + 1; frame.state.textEnd = token.end - 1; }
  else if (frame.key === 'type' && token.value !== null) frame.state.type = token.value;
}

/** 内容块闭合时才判定：JSON 键顺序不保证 type 早于 text。 */
function finishElement(frame: Frame, state: DisplayScanState): DisplayTextSpan | null {
  const element = frame.state;
  if (element === null || element.type !== 'text' || element.thought || element.textStart === null) return null;
  const span: DisplayTextSpan = { ordinal: state.ordinal, start: element.textStart, end: element.textEnd ?? element.textStart };
  state.ordinal += 1;
  return span;
}

/**
 * 消费原文的一段字节，返回这一段里完成的可见 text 块定位。
 *
 * chunkStart 是 chunk[0] 在原文中的绝对字节偏移；状态按块续扫，跨块的字符串、转义与容器从状态续接。
 * 结构不合法时立即停在这一段：这份正文不会有显示来源，继续扫它不会产出任何可用的结果。
 */
export function scanDisplayBytes(state: DisplayScanState, chunk: Uint8Array, chunkStart: number, maxSpans = Number.POSITIVE_INFINITY): readonly DisplayTextSpan[] {
  const spans: DisplayTextSpan[] = state.pending;
  state.pending = [];
  let i = 0;
  let pos = chunkStart;
  while (i < chunk.length && !state.malformed) {
    const byte = chunk[i]!;
    // 字符串与裸字面量内部的字节不参与结构判断，就地消费并核对转义。
    if (state.open !== null) { scanStringByte(state, byte, pos); i += 1; pos += 1; continue; }
    if (state.bare !== null) {
      if (isBareByte(byte)) { captureBare(state.bare, byte); i += 1; pos += 1; continue; }
      // 终止符不消费：它按落定之后的期待重新判断一次。
      closeBare(state);
      continue;
    }
    if (isWhitespace(byte)) { i += 1; pos += 1; continue; }
    const frame = top(state);
    const expect = frame === null ? state.expect : frame.expect;
    // 根闭合之后只允许空白：尾随垃圾因此被拒绝，而不是被当成一份已经读完的来源。
    if (expect === 'done') { state.malformed = true; break; }
    let closing = false;
    if (expect === 'comma' && frame !== null && closes(frame.kind, byte)) closing = true;
    else if (frame !== null && !frame.nonEmpty && closes(frame.kind, byte) && expect === (frame.kind === 'array' ? 'value' : 'key')) closing = true;
    else if (byte === QUOTE && (expect === 'value' || expect === 'key')) {
      if (frame !== null) frame.nonEmpty = true;
      state.open = { start: pos, asKey: expect === 'key', bytes: [], over: false, escape: 0 };
    } else if ((byte === OPEN_BRACE || byte === OPEN_BRACKET) && expect === 'value') {
      if (state.stack.length >= DISPLAY_PROJECTION_MAX_DEPTH) { state.malformed = true; break; }
      const element = byte === OPEN_BRACE && frame !== null && frame.kind === 'array' && state.stack.length === 1;
      if (state.stack.length === 0 && byte !== OPEN_BRACKET) state.invalid = true;
      if (frame !== null) { frame.key = null; frame.nonEmpty = true; frame.expect = 'comma'; }
      state.stack.push({ kind: byte === OPEN_BRACE ? 'object' : 'array', key: null, element,
        state: element ? { type: null, thought: false, textStart: null, textEnd: null } : null,
        expect: byte === OPEN_BRACE ? 'key' : 'value', nonEmpty: false });
    } else if (isBareStart(byte) && expect === 'value') {
      if (frame !== null) frame.nonEmpty = true;
      state.bare = { bytes: [byte], over: false };
    } else if (byte === COLON && expect === 'colon' && frame !== null) frame.expect = 'value';
    else if (byte === COMMA && expect === 'comma' && frame !== null) frame.expect = frame.kind === 'array' ? 'value' : 'key';
    else { state.malformed = true; break; }
    i += 1; pos += 1;
    if (!closing) continue;
    const span = closeFrame(state);
    // 条目预算用尽就在这里停下：位置与栈都留在状态里，剩余字节下次继续。
    if (span !== null) {
      if (spans.length >= maxSpans) { state.pending = [span]; state.pos = pos; return spans; }
      spans.push(span);
    }
  }
  state.pos = pos;
  return spans;
}

/** 容器闭合：栈空即根结束；返回因此完成的内容块定位。 */
function closeFrame(state: DisplayScanState): DisplayTextSpan | null {
  const closed = state.stack.pop();
  if (closed === undefined) return null;
  if (state.stack.length === 0) state.expect = 'done';
  return closed.element && closed.state !== null ? finishElement(closed, state) : null;
}

/** 字符串里消费一个字节：转义必须完整合法，未转义的控制字符一律拒绝。 */
function scanStringByte(state: DisplayScanState, byte: number, pos: number): void {
  const open = state.open!;
  if (open.escape === 1)
    open.escape = byte === LOW_U ? 2 : SIMPLE_ESCAPES[String.fromCharCode(byte)] === undefined ? -1 : 0;
  else if (open.escape >= 2) {
    if (!isHexByte(byte)) open.escape = -1;
    else open.escape = open.escape < 5 ? open.escape + 1 : 0;
  } else if (byte === BACKSLASH) open.escape = 1;
  else if (byte === QUOTE) {
    state.open = null;
    closeString(state, open, pos);
    return;
  } else if (byte < 0x20) open.escape = -1;
  if (open.escape < 0) { state.malformed = true; return; }
  // 转义序列连反斜杠一起捕获：键名里的 unicode 转义因此能被正确解码。
  if (open.over) return;
  if (open.bytes.length < IDENTITY_CAPTURE_BYTES) open.bytes.push(byte);
  else { open.over = true; open.bytes.length = 0; }
}

/** 字符串结束：键把它记到容器上，值把它记到当前内容块上；两者都让容器继续期待分隔符。 */
function closeString(state: DisplayScanState, open: OpenString, last: number): void {
  const token: ClosedString = { start: open.start, end: last + 1, value: open.over ? null : decodeCaptured(open.bytes) };
  const frame = top(state);
  if (frame === null) state.expect = 'done';
  else if (open.asKey) { frame.key = token.value; frame.expect = 'colon'; }
  else { frame.expect = 'comma'; applyStringValue(frame, token); }
}

/** 裸字面量结束：只有完整的 JSON 数字或 true/false/null 才成立。 */
function closeBare(state: DisplayScanState): void {
  const token = state.bare!;
  state.bare = null;
  const text = token.over ? '' : decoder.decode(Uint8Array.from(token.bytes));
  if (token.over || !(NUMBER.test(text) || LITERAL.test(text))) { state.malformed = true; return; }
  const frame = top(state);
  if (frame === null) state.expect = 'done';
  else {
    frame.expect = 'comma';
    // 只有元素自身的 thought 是真值；其它裸值与定位无关。
    if (frame.element && frame.state !== null && frame.key === 'thought' && text === 'true') frame.state.thought = true;
  }
}

function captureBare(token: BareToken, byte: number): void {
  if (token.over) return;
  if (token.bytes.length < BARE_CAPTURE_BYTES) token.bytes.push(byte);
  else { token.over = true; token.bytes.length = 0; }
}

/**
 * 正文读到末尾。
 *
 * 只有根已经闭合、且没有悬空的字符串或裸字面量，这份 JSON 才是完整的；否则它只是被截断的合法
 * 前缀或坏结构：它不产生显示来源，因此读者永远拿不到一段半截的显示文本。
 */
function endOfSource(state: DisplayScanState): void {
  if (state.stack.length > 0 || state.open !== null || state.bare !== null || state.expect !== 'done')
    state.malformed = true;
  state.complete = true;
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\', '/': '/',
};
function pushCode(out: number[], code: number): void {
  for (const byte of encoder.encode(String.fromCodePoint(code))) out.push(byte);
}

/**
 * 反转义一个窗口，返回输出字节与已消费的源字节数。
 *
 * 末尾未完整的转义不消费：调用方下次从同一个偏移重读，因此 `\n` 落在窗口末尾、或一个代理对的
 * 低半落在窗口末尾时都不会被截断或变成替换字符。`atSourceEnd` 说明这个窗口已经是原文的最后一段：
 * 此时残缺转义不再等待下一段，而是按它真实的样子落成替换字符或原字节，否则就会永远等不到下文。
 */
export function decodeDisplayWindow(data: Uint8Array, atSourceEnd = false): { readonly out: number[]; readonly consumed: number } {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    const byte = data[i]!;
    if (byte !== BACKSLASH) { out.push(byte); i += 1; continue; }
    const rest = data.length - i;
    // 窗口末尾的反斜杠一定是半个转义：不消费，调用方下次从同一个偏移重读。
    if (rest < 2) {
      if (atSourceEnd) out.push(byte);
      else break;
      i += 1;
      continue;
    }
    if (data[i + 1] === LOW_U) {
      if (rest < UNICODE_ESCAPE_BYTES) {
        if (!atSourceEnd) break;
        out.push(byte);
        i += 1;
        continue;
      }
      const hex = String.fromCharCode(data[i + 2]!, data[i + 3]!, data[i + 4]!, data[i + 5]!);
      if (HEX4.test(hex)) {
        const lead = parseInt(hex, 16);
        if (lead >= 0xd800 && lead <= 0xdbff) {
          // 高半代理只有在看过下一个转义之后才能判定它是否成对，因此不足 12 字节时不消费。
          if (rest < SURROGATE_PAIR_BYTES && !atSourceEnd) break;
          if (data[i + 6] === BACKSLASH && data[i + 7] === LOW_U) {
            const low = String.fromCharCode(data[i + 8]!, data[i + 9]!, data[i + 10]!, data[i + 11]!);
            if (HEX4.test(low)) {
              const trail = parseInt(low, 16);
              if (trail >= 0xdc00 && trail <= 0xdfff) {
                // 代理对必须整体编码：逐码元编码会把 emoji 变成替换字符。
                pushCode(out, 0x10000 + ((lead - 0xd800) << 10) + (trail - 0xdc00));
                i += SURROGATE_PAIR_BYTES;
                continue;
              }
            }
          }
          // 证明是孤立代理：它没有可编码的码点，只能落成替换字符，而不是截断后面的正文。
          out.push(0xef, 0xbf, 0xbd);
          i += UNICODE_ESCAPE_BYTES;
          continue;
        }
        pushCode(out, lead);
        i += UNICODE_ESCAPE_BYTES;
        continue;
      }
    }
    if (SIMPLE_ESCAPES[String.fromCharCode(data[i + 1]!)] !== undefined) {
      pushCode(out, SIMPLE_ESCAPES[String.fromCharCode(data[i + 1]!)]!.codePointAt(0)!);
      i += 2;
      continue;
    }
    // 不认识的转义按原字节保留，不丢掉原文里的可见字符。
    out.push(byte);
    i += 1;
  }
  return { out, consumed: i };
}

/** 一次推进的有界结果与可变游标；调用方把 chunks/mapping 落盘后持久化 state。 */
function advance(state: DisplayProjectionState, read: DisplayProjectionRead, budget: number): DisplayProjectionAdvance {
  const scan = state.scan, chunks: { start: number; data: Uint8Array }[] = [], mapping: DisplaySpanMapping[] = [];
  let span = state.span, decodePos = state.decodePos, displayBytes = state.displayBytes, blocks = state.blocks, openStart = state.openStart, scanned = 0;
  let decodeTail = state.decodeTail;
  const emit = (bytes: readonly number[]): void => {
    if (bytes.length === 0) return;
    if (openStart === null) {
      // 分隔符只在块的第一个字节出现时写入，因此空块不留多余空行。
      if (blocks > 0) { chunks.push({ start: displayBytes, data: Uint8Array.from([0x0a]) }); displayBytes += 1; }
      openStart = displayBytes;
      blocks += 1;
    }
    chunks.push({ start: displayBytes, data: Uint8Array.from(bytes) });
    displayBytes += bytes.length;
  };
  const finishSpan = (): void => {
    if (openStart !== null && span !== null)
      mapping.push({ ordinal: span.ordinal, sourceStart: span.start, sourceEnd: span.end, displayStart: openStart, displayEnd: displayBytes });
    openStart = null;
    span = null;
    decodePos = 0;
    decodeTail = [];
  };
  // 根闭合之后仍可能有已定位但未解码完的块：这三个条件都必须满足才能停下。
  while (scanned < budget && (!scan.complete || span !== null || scan.pending.length > 0)) {
    // 结构已经被判为非法：这份正文没有显示来源，再读下去也不会产出可用的结果。
    if (scan.malformed) break;
    if (span === null) {
      // 上一段扫描留下的定位先发出，否则块边界上的那一个会随 EOF 一起丢掉。
      if (scan.pending.length > 0) { span = scan.pending.shift()!; continue; }
      if (scan.complete) break;
      const wanted = Math.min(DISPLAY_PROJECTION_CHUNK_BYTES, budget - scanned);
      const window = read(scan.pos, wanted);
      scanned += window.length;
      const from = scan.pos;
      const found = scanDisplayBytes(scan, window, scan.pos, 1);
      // 读不满就是正文末尾：只有根确实闭合才成立，因此截断的合法前缀不会变成完整来源。
      // 条目预算让扫描提前停在窗口中间时不算末尾，剩下的字节下次继续。
      if (window.length < wanted && scan.pos >= from + window.length) endOfSource(scan);
      if (found.length > 0) {
        span = found[0]!;
        // 条目预算之外的定位退回状态：它们不能随这一次调用一起丢掉。
        if (found.length > 1) scan.pending = [...found.slice(1), ...scan.pending];
      }
      continue;
    }
    // 空块没有可解码的字节：直接结清，否则它会让预算为零的循环永远不前进。
    if (span.end - span.start - decodePos <= 0) { finishSpan(); continue; }
    const spanRemaining = span.end - span.start - decodePos;
    const wanted = Math.min(DISPLAY_PROJECTION_CHUNK_BYTES, spanRemaining, budget - scanned);
    if (wanted <= 0) break;
    const window = read(span.start + decodePos, wanted);
    scanned += window.length;
    if (window.length === 0) throw new Error('Display source ended before its text span');
    decodePos += window.length;
    const atSourceEnd = decodePos >= span.end - span.start;
    const pending = Uint8Array.from([...decodeTail, ...window]);
    const decoded = decodeDisplayWindow(pending, atSourceEnd);
    emit(decoded.out);
    decodeTail = Array.from(pending.subarray(decoded.consumed));
    if (atSourceEnd) finishSpan();
  }
  const finished = (): boolean => scan.complete && !scan.malformed && span === null && scan.pending.length === 0;
  return { state: { scan, span, decodePos, decodeTail, displayBytes, blocks, openStart }, chunks, mapping,
    scannedBytes: scanned, complete: finished() };
}

/**
 * 按固定字节预算推进一次显示投影。
 *
 * 预算耗尽时返回一个可继续的游标：调用方只需落盘 chunks/mapping 与 state，下次从同一位置续扫。
 * `complete` 为真时显示来源才是完整的：根已闭合、正文也已读完，之后读取方才能看到它。
 * 结构非法时 `state.scan.malformed` 为真，这份正文不产生显示来源。
 */
export function advanceDisplayProjection(state: DisplayProjectionState, read: DisplayProjectionRead, budget: number): DisplayProjectionAdvance {
  return advance(state, read, Math.max(0, budget));
}

/**
 * 新提交的一次性投影：写入路径已经持有完整正文，因此循环到完成，仍然按固定窗口解码。
 */
export function projectDisplayText(read: DisplayProjectionRead, byteLength: number): DisplayProjectionAdvance & { readonly byteLength: number } {
  let state = createDisplayProjectionState();
  let chunks: { start: number; data: Uint8Array }[] = [], mapping: DisplaySpanMapping[] = [];
  for (;;) {
    const step = advance(state, read, DISPLAY_PROJECTION_CHUNK_BYTES);
    chunks = [...chunks, ...step.chunks];
    mapping = [...mapping, ...step.mapping];
    state = step.state;
    if (step.complete || state.scan.malformed || step.scannedBytes === 0) break;
  }
  const complete = state.scan.complete && !state.scan.malformed && state.span === null;
  return { state, chunks, mapping, scannedBytes: byteLength, complete, byteLength: state.displayBytes };
}
