/**
 * Scope 级控制粒度与 Pause / Resume / Cancel（IP-05、IP-06，`tui/execution-control`）。
 *
 * 断言的是可观察事实：提交的 intent 种类与 action、危险态下确认提示是否出现、以及「终态只来自快照」。
 * 界面不推断终态，`cancelling` 与 `unverifiable` 一律来自 Controller 已持久化的控制状态；控制入口在
 * 结构上不可能以单个 Work Package 为目标（`ControlBar` 没有 Work Package 参数）。
 */

import { describe, expect, test } from 'vitest';

import { COMMAND_IDS, COMMAND_LABELS, type CommandId } from '../../src/interfaces/tui/components/command-palette.js';
import { requiresConfirmation } from '../../src/interfaces/tui/components/control-bar.js';
import type { ControlHazardsView } from '../../src/application/execution/execution-view.js';
import {
  createFakePorts,
  frameText,
  makeWorkPackageExecution,
  renderTui,
  settle,
  type RenderedTui,
  type SnapshotOverrides,
} from './harness.js';

async function pressKey(rendered: RenderedTui, input: string): Promise<void> {
  rendered.stdin.write(input);
  await settle(2);
}

/**
 * Ink 把单独一个 `ESC` 当作可能的分块转义序列前缀挂起 20ms 再回放，因此按 Esc 必须等真实时间。
 */
async function pressEscape(rendered: RenderedTui): Promise<void> {
  rendered.stdin.write('\u001b');
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 40);
  await promise;
  await settle(2);
}

/** 打开 Command Palette，移动 `index` 格后回车；索引按 `COMMAND_IDS` 查，不写死数字。 */
async function runPaletteCommand(rendered: RenderedTui, command: CommandId): Promise<void> {
  const index = COMMAND_IDS.indexOf(command);
  expect(index).toBeGreaterThanOrEqual(0);
  await pressKey(rendered, '\u0010');
  for (let step = 0; step < index; step += 1) {
    await pressKey(rendered, '\u001b[B');
  }
  await pressKey(rendered, '\r');
}

/** 危险态：存在活跃 Worker 或不可核验 Worker，因此 Cancel 必须先确认。 */
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

const CONFIRM_CANCEL = '确认 Cancel 整个 Coordination Scope';
const CONFIRM_EXIT = '确认退出前台进程';

describe('tui/execution-control / Scope 级控制粒度与 Pause 与 Resume', () => {
  test('Scenario: Pause 后不再产生新派发 —— 只提交一次 scope-control pause', async () => {
    const fake = createFakePorts({ snapshot: hazardousSnapshot() });
    const rendered = renderTui(fake.ports);
    await settle();

    await runPaletteCommand(rendered, 'pause');

    // 意图被提交，且没有夹带任何别的写：界面只有「提交一次暂停意图」这一个动作。
    expect(fake.executeIntents).toEqual([{ kind: 'scope-control', action: 'pause' }]);
    expect(fake.executeCount()).toBe(1);

    // 已在运行的 Worker 不被读作已停止：暂停只阻止新派发，它继续到可核验边界。
    const frame = frameText(rendered);
    expect(frame).toContain('wp-1 [implementing] *active');
    expect(frame).toContain('live');

    rendered.unmount();
  });

  test('Scenario: Resume 先对账 —— 只提交意图，终态仍由 Controller 快照决定', async () => {
    const fake = createFakePorts({ snapshot: { controlState: 'paused' } });
    const rendered = renderTui(fake.ports);
    await settle();

    await runPaletteCommand(rendered, 'resume');

    expect(fake.executeIntents).toEqual([{ kind: 'scope-control', action: 'resume' }]);
    // 对账与恢复调度在宿主；界面不乐观改写控制状态，展示的仍是快照里的 `paused`。
    const frame = frameText(rendered);
    expect(frame).toContain('scope control · paused');
    expect(frame).not.toContain('scope control · active');

    rendered.unmount();
  });

  test('Scenario: Pause 不要求确认 —— 危险态下直接提交，不出现任何确认提示', async () => {
    // 危险态由「不可核验 Worker」构成：无法核验的 Worker 不得被读作已停止，因此仍是危险态。
    const fake = createFakePorts({
      snapshot: {
        frontier: [
          makeWorkPackageExecution('wp-1', {
            state: 'unknown',
            role: 'implementation',
            attemptId: 'attempt-1',
            liveness: 'unverifiable',
          }),
        ],
      },
    });
    const rendered = renderTui(fake.ports);
    await settle();

    await runPaletteCommand(rendered, 'pause');

    const frame = frameText(rendered);
    expect(frame).not.toContain(CONFIRM_CANCEL);
    expect(frame).not.toContain(CONFIRM_EXIT);
    expect(fake.executeIntents).toEqual([{ kind: 'scope-control', action: 'pause' }]);

    // 判定层：Pause/Resume 在任何危险态下都不需要确认；Cancel/Exit 需要。
    const hazards: ControlHazardsView = {
      activeWorkerCount: 1,
      unverifiedWorkerCount: 1,
      openInteractionCount: 1,
      unresolvedOperationCount: 1,
      hazardous: true,
    };
    expect(requiresConfirmation('pause', hazards)).toBe(false);
    expect(requiresConfirmation('resume', hazards)).toBe(false);
    expect(requiresConfirmation('cancel', hazards)).toBe(true);

    rendered.unmount();
  });

  test('Scenario: 单个 Work Package 的控制入口不存在', async () => {
    // 结构层：控制命令只有 Scope 级三种，文案以整个 Coordination Scope 为目标，且没有任何以包为目标的命令 id。
    const controlCommands = COMMAND_IDS.filter(
      (command) => command === 'pause' || command === 'resume' || command === 'cancel',
    );
    expect(controlCommands).toEqual(['pause', 'resume', 'cancel']);
    expect(COMMAND_IDS.filter((command) => /wp-|work-package|package/.test(command))).toEqual([]);
    for (const command of controlCommands) {
      expect(COMMAND_LABELS[command]).toContain('整个 Coordination Scope');
    }

    // 运行层：选中一个 Work Package 后，控制入口仍是同一批 Scope 级命令，且 ControlBar 明示无单包控制。
    const fake = createFakePorts({ snapshot: hazardousSnapshot() });
    const rendered = renderTui(fake.ports);
    await settle();

    await pressKey(rendered, '\u0007'); // Ctrl+G：Graph Inspector
    expect(frameText(rendered)).toContain('Graph Inspector');
    await pressKey(rendered, '\u001b[B'); // ↓：选中第一个节点
    expect(frameText(rendered)).toContain('> 第一个工作包');
    await pressEscape(rendered); // Esc：关闭 Inspector

    await pressKey(rendered, '\u0010'); // Ctrl+P：Command Palette
    const frame = frameText(rendered);
    expect(frame).toContain('Pause 整个 Coordination Scope');
    expect(frame).toContain('Resume 整个 Coordination Scope');
    expect(frame).toContain('Cancel 整个 Coordination Scope');
    expect(frame).toContain('Pause/Resume/Cancel 只作用于整个');
    // 选择与查找控制入口本身不写任何东西。
    expect(fake.executeIntents).toEqual([]);

    rendered.unmount();
  });
});

describe('tui/execution-control / Scope 级 Cancel', () => {
  test('Scenario: Cancel 保持 cancelling —— accepted 后仍显示 cancelling，不显示为已停止', async () => {
    // 停止结果尚未确认：Controller 持久化的控制状态就是 `cancelling`。
    const fake = createFakePorts({ snapshot: hazardousSnapshot({ controlState: 'cancelling' }) });
    const rendered = renderTui(fake.ports);
    await settle();

    await runPaletteCommand(rendered, 'cancel');
    await pressKey(rendered, 'y');
    await settle();

    expect(fake.executeIntents).toEqual([{ kind: 'scope-control', action: 'cancel' }]);
    const frame = frameText(rendered);
    expect(frame).toContain('scope control · cancelling');
    // 未确认停止前不得读作终态。
    expect(frame).not.toContain('cancelled');
    expect(frame).not.toContain('已停止');

    rendered.unmount();
  });

  test('Scenario: Cancel 前要求确认 —— 确认前零提交，确认后才提交 cancel', async () => {
    const fake = createFakePorts({ snapshot: hazardousSnapshot() });
    const rendered = renderTui(fake.ports);
    await settle();

    await runPaletteCommand(rendered, 'cancel');
    expect(frameText(rendered)).toContain(CONFIRM_CANCEL);
    // 未确认前不持久化取消意图。
    expect(fake.executeIntents).toEqual([]);

    // `n` 取消待确认动作：既不写状态，也不再显示提示。
    await pressKey(rendered, 'n');
    expect(fake.executeIntents).toEqual([]);
    expect(frameText(rendered)).not.toContain(CONFIRM_CANCEL);

    // Esc 同样是取消。
    await runPaletteCommand(rendered, 'cancel');
    expect(frameText(rendered)).toContain(CONFIRM_CANCEL);
    await pressEscape(rendered);
    expect(fake.executeIntents).toEqual([]);
    expect(frameText(rendered)).not.toContain(CONFIRM_CANCEL);

    // 确认后才提交，且只提交一次。
    await runPaletteCommand(rendered, 'cancel');
    await pressKey(rendered, 'y');
    await settle();
    expect(fake.executeIntents).toEqual([{ kind: 'scope-control', action: 'cancel' }]);

    rendered.unmount();
  });

  test('Scenario: 不可核验结果如实呈现 —— unverifiable 不显示为失败或已停止', async () => {
    const fake = createFakePorts({
      snapshot: {
        controlState: 'unverifiable',
        frontier: [
          makeWorkPackageExecution('wp-1', {
            state: 'unknown',
            role: 'implementation',
            attemptId: 'attempt-1',
            liveness: 'unverifiable',
          }),
        ],
      },
    });
    const rendered = renderTui(fake.ports);
    await settle();

    const frame = frameText(rendered);
    expect(frame).toContain('scope control · unverifiable');
    // Sidebar 的存活三值里有独立文案：不可核验读作「待核验」，而不是「已退出」。
    expect(frame).toContain('unverifiable(待核验)');
    expect(frame).toContain('[unknown]');
    expect(frame).not.toContain('已停止');
    expect(frame).not.toContain('cancelled');
    // 只读投影：渲染不产生任何写。
    expect(fake.executeCount()).toBe(0);

    rendered.unmount();
  });
});
