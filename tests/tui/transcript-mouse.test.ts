import { describe, expect, test } from 'vitest';
import { createMouseFilter, inTranscript, type TranscriptWheel } from '../../src/interfaces/tui/input/transcript-mouse.js';

const ESC = String.fromCharCode(27);

describe('transcript mouse input', () => {
  test('consumes reports and preserves ordinary input across split reports', () => {
    const wheels: TranscriptWheel[] = [], filter = createMouseFilter(wheel => wheels.push(wheel));
    expect(filter('hello' + ESC + '[<64;')).toBe('hello');
    expect(filter('3;5Mworld')).toBe('world');
    expect(filter('[<65;3;5M')).toBe('');
    expect(filter('[<0;3;5m')).toBe('');
    expect(filter('literal [<tag> text')).toBe('literal [<tag> text');
    expect(wheels).toEqual([{ x: 2, y: 4, direction: 'older' }, { x: 2, y: 4, direction: 'newer' }]);
  });

  test('报告在 `[<` 之前被终端读取切断时重组，不把协议字节写进 composer', async () => {
    const wheels: TranscriptWheel[] = [];
    // 原始输入刚以 ESC / ESC[ 结束：这就是 Ink 交付裸 `[` 的唯一依据。
    let rawEscape = false;
    const filter = createMouseFilter(wheel => wheels.push(wheel), () => { const value = rawEscape; rawEscape = false; return value; });
    // 真实 Ink 场景：ESC[ 先到，150ms 后 <64;20;8M 才到。
    expect(filter(ESC + '[')).toBe('');
    rawEscape = true;
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(filter('<64;20;8M')).toBe('');
    expect(wheels).toEqual([{ x: 19, y: 7, direction: 'older' }]);

    // ESC 单独到达时仍是普通按键；下一段补齐 `[<` 后整份报告被消费。
    expect(filter(ESC)).toBe(ESC);
    expect(filter('[<65;20;8M')).toBe('');
    expect(wheels[1]).toEqual({ x: 19, y: 7, direction: 'newer' });

    // 前缀之前的正文照常进入 composer，报告紧跟其后。
    expect(filter('正文' + ESC + '[')).toBe('正文');
    expect(filter('<64;1;1M')).toBe('');
    expect(wheels).toHaveLength(3);

    // 真实 Ink 交付路径：parseKeypress 已去掉 ESC，只剩 `[` 单独到达。
    rawEscape = true;
    expect(filter('[')).toBe('');
    expect(filter('<64;20;8M')).toBe('');
    expect(wheels[3]).toEqual({ x: 19, y: 7, direction: 'older' });

    // 报告体本身被切断时前缀必须一起留着，否则只剩半截报告流入正文。
    expect(filter(ESC + '[')).toBe('');
    expect(filter('<64;20;')).toBe('');
    expect(filter('8M')).toBe('');
    expect(wheels[4]).toEqual({ x: 19, y: 7, direction: 'older' });
  });

  test('普通方括号正文原样进入 composer，不被前缀缓冲吞掉', () => {
    const wheels: TranscriptWheel[] = [], filter = createMouseFilter(wheel => wheels.push(wheel));
    // 没有未完成的 ESC 前缀：`[` 当场进入 composer，随后的 Enter 仍是独立提交键。
    expect(filter('a[')).toBe('a[');
    expect(filter('\r')).toBe('\r');
    expect(filter('b]')).toBe('b]');
    expect(filter('见 [tag] 与 [<3 文本')).toBe('见 [tag] 与 [<3 文本');
    expect(wheels).toEqual([]);

    // 待收缓冲有界：像报告体但超长的残片不再滞留，原样进入 composer。
    const unbounded = '[<' + '1;'.repeat(60);
    expect(filter(unbounded)).toBe(unbounded);
    expect(filter('<64;20;8M')).toBe('<64;20;8M');
  });

  test('navigation is limited to the measured transcript rectangle', () => {
    const region = { x: 2, y: 3, width: 20, height: 8 };
    expect(inTranscript({ x: 2, y: 3, direction: 'older' }, region)).toBe(true);
    for (const point of [{ x: 1, y: 3 }, { x: 22, y: 3 }, { x: 2, y: 11 }]) {
      expect(inTranscript({ ...point, direction: 'older' }, region)).toBe(false);
    }
    expect(inTranscript({ x: 2, y: 3, direction: 'older' }, null)).toBe(false);
  });
});
