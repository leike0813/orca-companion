import { describe, expect, it } from 'vitest';
import {
  DISPLAY_PROJECTION_MAX_DEPTH,
  DISPLAY_PROJECTION_STATE_BYTES,
  advanceDisplayProjection,
  createDisplayProjectionState,
  projectDisplayText,
} from '../../src/adapters/storage/history-display-projection.js';

const encoder = new TextEncoder();
const bytes = (content: string): Uint8Array => encoder.encode(content);

/** 把投影块按显示偏移拼回完整文本；块边界与窗口大小无关。 */
function join(chunks: readonly { start: number; data: Uint8Array }[], byteLength: number): string {
  const parts = [...chunks].sort((a, b) => a.start - b.start);
  let at = 0;
  const out: number[] = [];
  for (const chunk of parts) {
    expect(chunk.start).toBe(at);
    out.push(...chunk.data);
    at += chunk.data.length;
  }
  expect(at).toBe(byteLength);
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(out));
}

/**
 * 用给定预算反复推进直到完成，返回拼回的文本。
 *
 * 每次推进都从 JSON 往返后的游标继续，因此这条路径就是旧历史补齐时走的路径。
 */
function project(body: string, budget: number, maxCalls = 20000): { text: string; calls: number; bytesPerCall: number[] } {
  const source = bytes(body);
  const read = (offset: number, length: number): Uint8Array => source.subarray(offset, offset + length);
  let state = createDisplayProjectionState();
  const chunks: { start: number; data: Uint8Array }[] = [];
  const bytesPerCall: number[] = [];
  let calls = 0;
  for (; calls < maxCalls; calls += 1) {
    const step = advanceDisplayProjection(JSON.parse(JSON.stringify(state)) as typeof state, read, budget);
    expect(step.scannedBytes).toBeLessThanOrEqual(budget);
    chunks.push(...step.chunks);
    bytesPerCall.push(step.scannedBytes);
    state = step.state;
    if (step.complete) break;
    if (step.scannedBytes === 0) throw new Error('projection made no progress');
  }
  expect(calls).toBeLessThan(maxCalls);
  return { text: join(chunks, state.displayBytes), calls, bytesPerCall };
}

const blocks = (visible: readonly string[]): string =>
  JSON.stringify(visible.map(text => ({ type: 'text', text })));

/** 一次性投影：新提交与畸形正文的判定都走这条路径。 */
function projectOnce(body: string): ReturnType<typeof projectDisplayText> {
  const source = bytes(body);
  return projectDisplayText((offset, length) => source.subarray(offset, offset + length), source.length);
}

describe('display projection', () => {
  it('shows only visible text and joins blocks with one newline', () => {
    const body = JSON.stringify([
      { type: 'text', text: '第一段' },
      { type: 'thinking', thinking: '不该显示的推理' },
      { type: 'text', text: '' },
      { type: 'tool_use', id: 'call_1', name: 'read', input: { path: '/tmp/x' } },
      { type: 'text', text: '第二段' },
    ]);
    for (const budget of [1, 2, 3, 7, 16, 64, 4096])
      expect(project(body, budget).text, 'budget ' + budget).toBe('第一段\n第二段');
  });

  it('excludes thought text blocks', () => {
    const body = JSON.stringify([{ type: 'text', text: '可见', thought: true }, { type: 'text', text: '也可见' }]);
    expect(project(body, 3).text).toBe('也可见');
  });

  it('decodes escapes and surrogate pairs at every window boundary', () => {
    const body = JSON.stringify([{ type: 'text', text: 'a\nb\tc\\d"e' }, { type: 'text', text: '\u4f60\u597d🙂\ud83d\ude00' }]);
    const expected = 'a\nb\tc\\d"e\n你好🙂😀';
    for (let budget = 1; budget <= 40; budget += 1)
      expect(project(body, budget).text, 'budget ' + budget).toBe(expected);
  });

  it('reads a thought key written with unicode escapes as thought', () => {
    const body = '[{"type":"text","text":"a","thou\\u0067ht":true},{"type":"text","text":"b"}]';
    expect(project(body, 3).text).toBe('b');
  });

  it('keeps a lone surrogate honest without truncating the rest of the text', () => {
    const body = '[{"type":"text","text":"\\ud83d尾巴"}]';
    for (let budget = 1; budget <= 12; budget += 1)
      expect(project(body, budget).text, 'budget ' + budget).toBe('\uFFFD尾巴');
  });

  it('projects long text block by block without losing or duplicating a byte', () => {
    const long = '中文🙂 line '.repeat(20000);
    const body = blocks([long]);
    expect(body.length).toBeGreaterThan(200000);
    for (const budget of [16 * 1024, 4096, 37])
      expect(project(body, budget).text, 'budget ' + budget).toBe(long);
  });

  it('never reads more than the batch budget per call', () => {
    const body = blocks(['界'.repeat(200000), 'tail']);
    const run = project(body, 64 * 1024);
    // 一次调用最多读预算本身；半个转义的回看字节已从预算中扣除。
    expect(Math.max(...run.bytesPerCall)).toBeLessThanOrEqual(64 * 1024);
    expect(run.text).toBe('界'.repeat(200000) + '\ntail');
  });

  it('records a display range for every visible block', () => {
    const body = blocks(['一', '二']);
    const source = bytes(body);
    const result = projectDisplayText((offset, length) => source.subarray(offset, offset + length), source.length);
    expect(result.complete).toBe(true);
    expect(result.mapping.map(span => [span.displayStart, span.displayEnd])).toEqual([[0, 3], [4, 7]]);
    expect(result.mapping.map(span => new TextDecoder().decode(source.subarray(span.sourceStart, span.sourceEnd)))).toEqual(['一', '二']);
  });

  it('treats a body that is not a block array as having no projection', () => {
    expect(project('{"type":"text","text":"x"}', 8).text).toBe('');
  });

  it('rejects nesting past the bound and keeps the resumable cursor bounded', () => {
    const deep = '[{"type":"tool_use","input":' + '['.repeat(2000) + '0' + ']'.repeat(2000) + '},{"type":"text","text":"visible"}]';
    const source = bytes(deep);
    const step = advanceDisplayProjection(createDisplayProjectionState(), (offset, length) => source.subarray(offset, offset + length), 1600);
    // 深度越界即拒绝；游标本身也保持在落盘预算内，旧历史补齐不会写出无界的行。
    expect(step.state.scan.malformed).toBe(true);
    expect(step.state.scan.stack.length).toBeLessThanOrEqual(DISPLAY_PROJECTION_MAX_DEPTH);
    expect(Buffer.byteLength(JSON.stringify(step.state))).toBeLessThanOrEqual(DISPLAY_PROJECTION_STATE_BYTES);
    // 上限之内的嵌套仍然照常投影。
    const nested = { type: 'tool_use', id: 'call_1', name: 'read', input: Array.from({ length: 30 }, (_, index) => ({ n: index })) };
    expect(project(JSON.stringify([nested, { type: 'text', text: '嵌套内' }]), 64).text).toBe('嵌套内');
  });

  it('never publishes a truncated prefix or trailing junk as a complete source', () => {
    const rejected = [
      '[{"type":"text","text":"可见"', // 缺最后的 ]
      '[{"type":"text","text":"可见"},', // 尾逗号之后截断
      '[{"type":"text","text":"可见"}]垃圾', // 根之后的尾随垃圾
      '[{"type":"text","text":"可见"}] {}', // 根之后还有第二份 JSON
      '[{"type":"text","text":"可见" "x":1}]', // 两个值之间缺逗号
      '[{"type":"text","text":"可见",}]', // 对象尾逗号
      '[,]', // 数组里的空位
      '[{type:"text"}]', // 无引号键
      '[{"type":"text","text":"坏\\q转义"}]', // 不认识的转义
      '[{"type":"text","text":"坏\\u00转义"}]', // unicode 转义位数不足
      '[{"type":"text","thought":tru}]', // 字面量没有闭合
      '[{"type":"text","text":"换\n行"}]', // 字符串里未转义的换行
      '[{"type":"text","text":"x"}}]', // 多余的闭合括号
    ];
    for (const body of rejected) {
      const result = projectOnce(body);
      expect(result.complete, body).toBe(false);
      expect(result.state.scan.malformed, body).toBe(true);
    }
  });

  it('keeps escaped UTF-8, CJK, numbers and literals valid', () => {
    const body = JSON.stringify([
      { type: 'text', text: '你好🙂é\u4f60', thought: false },
      { type: 'tool_use', id: 'call_1', name: 'read', input: { delta: -1.5e3, ok: true, missing: null } },
    ]);
    const result = projectOnce(body);
    expect(result.state.scan.malformed).toBe(false);
    expect(result.complete).toBe(true);
    expect(join(result.chunks, result.state.displayBytes)).toBe('你好🙂é\u4f60');
  });
});
