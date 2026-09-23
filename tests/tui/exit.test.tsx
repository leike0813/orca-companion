/**
 * 前台 Exit 与 Ctrl+C（IP-06，`tui/execution-control`）。
 *
 * 断言的是可观察事实：危险态下先出确认提示、确认前不退出，以及退出路径**不提交任何意图**——Exit 只结束
 * 前台进程，不等同 Cancel，也不隐式 Pause。`renderTui` 的 `onExit` 是 no-op，因此这里自行渲染 `TuiApp`
 * 并注入 spy，才能断言「真的退出了一次」而不是「退出没发生也没人发现」。
 */

import { describe, expect, test, vi } from 'vitest';
import { createElement } from 'react';

import { TuiApp } from '../../src/interfaces/tui/app.js';
import { requiresConfirmation } from '../../src/interfaces/tui/components/control-bar.js';
import type { ControlHazardsView } from '../../src/application/execution/execution-view.js';
import {
  createFakePorts,
  frameText,
  makeWorkPackageExecution,
  renderComponent,
  settle,
  type FakePorts,
  type RenderedTui,
  type SnapshotOverrides,
} from './harness.js';

const CTRL_C = '\u0003';
const CONFIRM_EXIT = '确认退出前台进程';

async function pressKey(rendered: RenderedTui, input: string): Promise<void> {
  rendered.stdin.write(input);
  await settle(2);
}

/** Ink 把单独一个 `ESC` 当作可能的分块转义序列前缀挂起 20ms 再回放，因此按 Esc 必须等真实时间。 */
async function pressEscape(rendered: RenderedTui): Promise<void> {
  rendered.stdin.write('\u001b');
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 40);
  await promise;
  await settle(2);
}

/** 与 `renderTui` 同一装配，只把 `onExit` 换成 spy；退出语义因此可观察。 */
function renderWithExitSpy(fake: FakePorts) {
  const onExit = vi.fn();
  const rendered = renderComponent(
    createElement(TuiApp, { ports: fake.ports, terminalWidth: 100, initialScopeId: null, onExit }),
  );
  return { rendered, onExit };
}

/** 危险态：存在活跃 Worker，因此 Exit 与 Cancel 都必须先确认。 */
function hazardousSnapshot(overrides: SnapshotOverrides = {}): SnapshotOverrides {
  return {
    frontier: [
      makeWorkPackageExecution('wp-1', {
        state: 'implementing',
        role: 'implementation',
        attemptId: 'attempt-1',
        liveness: 'live',
        worktreePath: '/tmp/wt/wp-1',
      }),
    ],
    ...overrides,
  };
}

describe('tui/execution-control / 前台 Exit 与 Ctrl+C', () => {
  test('Scenario: Exit 不等同 Cancel —— 确认后退出前台进程，但不产生任何 scope-control 意图', async () => {
    const fake = createFakePorts({ snapshot: hazardousSnapshot() });
    const { rendered, onExit } = renderWithExitSpy(fake);
    await settle();

    await pressKey(rendered, CTRL_C);
    expect(frameText(rendered)).toContain(CONFIRM_EXIT);
    expect(onExit).not.toHaveBeenCalled();

    await pressKey(rendered, 'y');

    // 前台进程退出了一次，而 Scope 没有被暂停或取消：零意图、零写。
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(fake.executeIntents).toEqual([]);
    expect(fake.executeCount()).toBe(0);
    expect(frameText(rendered)).toContain('scope control · active');
    expect(frameText(rendered)).not.toContain('cancelling');

    rendered.unmount();
  });

  test('Scenario: 危险状态下要求确认 —— 未确认不退出，确认后才退出', async () => {
    const fake = createFakePorts({ snapshot: hazardousSnapshot() });
    const { rendered, onExit } = renderWithExitSpy(fake);
    await settle();

    // 危险态按下 Ctrl+C：只有提示，没有退出。
    await pressKey(rendered, CTRL_C);
    expect(frameText(rendered)).toContain(CONFIRM_EXIT);
    expect(onExit).not.toHaveBeenCalled();

    // `n` 放弃退出。
    await pressKey(rendered, 'n');
    expect(onExit).not.toHaveBeenCalled();
    expect(frameText(rendered)).not.toContain(CONFIRM_EXIT);

    // Esc 同样放弃退出。
    await pressKey(rendered, CTRL_C);
    expect(frameText(rendered)).toContain(CONFIRM_EXIT);
    await pressEscape(rendered);
    expect(onExit).not.toHaveBeenCalled();
    expect(frameText(rendered)).not.toContain(CONFIRM_EXIT);

    // 确认后才退出，且恰好一次。
    await pressKey(rendered, CTRL_C);
    await pressKey(rendered, 'y');
    expect(onExit).toHaveBeenCalledTimes(1);

    // 退出路径不产生任何意图（含 Cancel）。
    expect(fake.executeIntents).toEqual([]);

    rendered.unmount();
  });

  test('安全态下 Ctrl+C 直接退出，不出现确认提示', async () => {
    const fake = createFakePorts();
    const { rendered, onExit } = renderWithExitSpy(fake);
    await settle();

    await pressKey(rendered, CTRL_C);

    expect(onExit).toHaveBeenCalledTimes(1);
    expect(frameText(rendered)).not.toContain(CONFIRM_EXIT);
    expect(fake.executeIntents).toEqual([]);

    // 判定层：Exit 只在危险态需要确认——没有活跃 Worker/待答交互/未决操作时不需要。
    const safe: ControlHazardsView = {
      activeWorkerCount: 0,
      unverifiedWorkerCount: 0,
      openInteractionCount: 0,
      unresolvedOperationCount: 0,
      hazardous: false,
    };
    const hazardous: ControlHazardsView = { ...safe, activeWorkerCount: 1, hazardous: true };
    expect(requiresConfirmation('exit', safe)).toBe(false);
    expect(requiresConfirmation('exit', hazardous)).toBe(true);

    rendered.unmount();
  });

  test('Scenario: 退出后不继续推进 —— 退出路径不提交任何意图，控制状态保持快照值', async () => {
    const fake = createFakePorts({ snapshot: hazardousSnapshot({ controlState: 'paused' }) });
    const { rendered, onExit } = renderWithExitSpy(fake);
    await settle();

    await pressKey(rendered, CTRL_C);
    await pressKey(rendered, 'y');
    await settle();

    expect(onExit).toHaveBeenCalledTimes(1);
    // 退出不推进任何事：没有 scope-control 意图，也没有任何其它写。
    expect(fake.executeIntents.filter((intent) => intent.kind === 'scope-control')).toEqual([]);
    expect(fake.executeIntents).toEqual([]);
    expect(fake.executeCount()).toBe(0);
    // 控制状态仍是退出前的快照值：Exit 既没有 Pause 也没有 Cancel。
    const frame = frameText(rendered);
    expect(frame).toContain('scope control · paused');
    expect(frame).not.toContain('cancelling');

    rendered.unmount();
  });
});
