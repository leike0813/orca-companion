/**
 * unknown 与 unverifiable 的如实呈现（`tui/recovery-observability`「unknown 与 unverifiable 的如实呈现」）。
 *
 * 断言两件可观察事实：mutation 的 unknown 结果被呈现为「待对账」（不是失败、也不是已停止），并且
 * 刷新 / 重绘 / resize 只重算展示，不产生任何重试、对账写入或派发（`execute` 计数为 0）。
 */

import { describe, expect, test } from 'vitest';
import { createElement } from 'react';

import { TuiApp } from '../../src/interfaces/tui/app.js';
import { COMMAND_IDS, type CommandId } from '../../src/interfaces/tui/components/command-palette.js';
import { SIDEBAR_COLLAPSED_MARKER } from '../../src/interfaces/tui/components/sidebar.js';
import {
  createFakePorts,
  frameText,
  makeWorkPackageExecution,
  renderTui,
  settle,
  type RenderedTui,
} from './harness.js';

async function press(rendered: RenderedTui, input: string): Promise<void> {
  rendered.stdin.write(input);
  await settle(2);
}

/** 走 Command Palette：Ctrl+P → 按目标索引次数的 Down → Enter。 */
async function runPaletteCommand(rendered: RenderedTui, command: CommandId): Promise<void> {
  await press(rendered, '\u0010');
  const index = COMMAND_IDS.indexOf(command);
  for (let step = 0; step < index; step += 1) {
    await press(rendered, '\u001b[B');
  }
  await press(rendered, '\r');
}

describe('recovery-observability / unknown 与 unverifiable 的如实呈现', () => {
  test('Scenario: unknown 不呈现为失败', async () => {
    const fake = createFakePorts({
      executeResult: { kind: 'unknown', code: 'stop-unconfirmed', message: '停止未被确认' },
    });

    const rendered = renderTui(fake.ports);
    await settle();
    // 折叠 Sidebar：状态行才有足够宽度完整显示提示（满密度时状态行只剩 58 列）。
    await press(rendered, '\u0002');
    expect(frameText(rendered)).toContain(SIDEBAR_COLLAPSED_MARKER);

    // 无危险态，因此 Cancel 立即提交一次 Worker 停止请求。
    await runPaletteCommand(rendered, 'cancel');
    await settle(2);

    expect(fake.executeIntents).toContainEqual({ kind: 'scope-control', action: 'cancel' });
    const frame = frameText(rendered);
    // 该动作呈现为待对账。
    expect(frame).toContain('unknown(stop-unconfirmed)');
    expect(frame).toContain('需对账');
    // 不呈现为停止失败或已停止。
    expect(frame).not.toContain('失败');
    expect(frame).not.toContain('已停止');
    // 界面不乐观显示终态：控制状态仍来自快照。
    expect(frame).toContain('scope control · active');
    expect(frame).not.toContain('cancelling');

    rendered.unmount();
  });

  test('Scenario: 展示不触发重试', async () => {
    const fake = createFakePorts({
      snapshot: {
        frontier: [
          makeWorkPackageExecution('wp-1', {
            state: 'unknown',
            role: 'validator',
            attemptId: 'a1',
            liveness: 'unverifiable',
          }),
        ],
      },
    });

    const rendered = renderTui(fake.ports);
    await settle();
    const frame = frameText(rendered);
    // unknown 与 unverifiable 如实呈现，既不是失败也不是已停止。
    expect(frame).toContain('wp-1 [unknown]');
    expect(frame).not.toContain('失败');
    expect(frame).not.toContain('已停止');

    // 整宽的 Graph Inspector 给出完整 liveness 事实：unverifiable 不被读作已停止。
    await press(rendered, '\u0007');
    expect(frameText(rendered)).toContain('liveness=unverifiable');
    expect(frameText(rendered)).toContain('[unknown]');
    await press(rendered, '\u001b');

    // 反复重绘与 resize。
    const framesBefore = rendered.frames.length;
    rendered.stdout.emit('resize');
    await settle(2);
    rendered.rerender(
      createElement(TuiApp, {
        ports: fake.ports,
        terminalWidth: 100,
        initialScopeId: null,
        onExit: () => undefined,
      }),
    );
    await settle(2);
    rendered.stdout.emit('resize');
    await settle(2);

    // 重绘确实发生了（不是「什么都没跑」的假绿）。
    expect(rendered.frames.length).toBeGreaterThan(framesBefore);
    // 展示只需要已持久化的状态：不产生新的重试、对账写入或派发。
    expect(fake.executeCount()).toBe(0);
    expect(fake.executeIntents).toEqual([]);
    expect(frameText(rendered)).toContain('wp-1 [unknown]');

    rendered.unmount();
  });
});
