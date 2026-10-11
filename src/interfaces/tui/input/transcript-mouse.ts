import { useStdin, useStdout } from 'ink';
import { useEffect, useRef } from 'react';

export type TranscriptRegion = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
export type TranscriptWheel = { readonly x: number; readonly y: number; readonly direction: 'older' | 'newer' };

/** SGR 报告的待收字节上限：只用于被终端读取切断的报告体，不吞掉无界输入。 */
const MAX_PENDING = 64;

/**
 * Consume SGR reports, including a report split anywhere before or inside `[<`.
 *
 * `isPrefixPending` 报告原始输入刚刚以 ESC / ESC[ 结束：Ink 交付这种被截断的序列时会去掉 ESC，
 * 只送来一个裸 `[`，它与用户键入的 `[` 无法从按键标志区分。只有确认存在未完成的 ESC 前缀时
 * 才暂留这个 `[`，普通 `[` 当场进入 composer，不改变输入时序。
 */
export function createMouseFilter(onWheel: (wheel: TranscriptWheel) => void, isPrefixPending?: () => boolean) {
  let pending = '';
  return (input: string): string => {
    let value = pending + input, output = '';
    pending = '';
    while (value) {
      const start = value.indexOf('[<');
      if (start < 0) {
        const held = value.endsWith('\u001b[') ? 2 : value.endsWith('[') && isPrefixPending?.() === true ? 1 : 0;
        pending = value.slice(value.length - held);
        return output + value.slice(0, value.length - held);
      }
      const prefix = start > 0 && value.charCodeAt(start - 1) === 27 ? start - 1 : start;
      output += value.slice(0, prefix);
      const body = value.slice(start);
      const report = /^\[<(\d+);(\d+);(\d+)([Mm])/u.exec(body);
      if (!report) {
        // 报告体被切断：连同前缀 ESC 一起留着，否则下一段只剩半截报告。
        if (/^\[<[\d;]*$/u.test(body) && body.length + (prefix > 0 ? 1 : 0) <= MAX_PENDING) {
          pending = prefix > 0 ? `\u001b${body}` : body;
          return output;
        }
        return output + body;
      }
      const button = Number(report[1]);
      if (report[4] === 'M' && (button & 64) !== 0 && (button & 3) <= 1) {
        onWheel({ x: Number(report[2]) - 1, y: Number(report[3]) - 1, direction: (button & 1) === 0 ? 'older' : 'newer' });
      }
      value = body.slice(report[0].length);
    }
    return output;
  };
}

export function inTranscript(wheel: TranscriptWheel, region: TranscriptRegion | null): boolean {
  return region !== null && wheel.x >= region.x && wheel.x < region.x + region.width &&
    wheel.y >= region.y && wheel.y < region.y + region.height;
}

export function useTranscriptMouse(enabled: boolean, onWheel: (wheel: TranscriptWheel) => void) {
  const { stdout } = useStdout();
  const { stdin } = useStdin();
  const callback = useRef(onWheel);
  callback.current = onWheel;
  // 原始字节是唯一能区分「被 Ink 截断的 ESC[」与用户键入 `[` 的信号；一个事件消费一次。
  const prefix = useRef(false);
  useEffect(() => {
    const onData = (data: Buffer | string) => {
      prefix.current = data.toString().endsWith('\u001b') || data.toString().endsWith('\u001b[');
    };
    stdin.on('data', onData);
    return () => { stdin.off('data', onData); prefix.current = false; };
  }, [stdin]);
  const filter = useRef<ReturnType<typeof createMouseFilter> | null>(null);
  filter.current ??= createMouseFilter(
    wheel => callback.current(wheel),
    () => { const pending = prefix.current; prefix.current = false; return pending; },
  );
  useEffect(() => {
    if (!enabled || !stdout.isTTY) return;
    stdout.write('\u001b[?1000h\u001b[?1006h');
    return () => { stdout.write('\u001b[?1006l\u001b[?1000l'); };
  }, [enabled, stdout]);
  return filter.current;
}
