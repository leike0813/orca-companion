/**
 * Execution Handoff 复用既有交互（IP-09，`tui/recovery-observability`）。
 *
 * 断言的是交接交互的可观察后果：复用 Command Palette 与 Handoff Review 入口、只投影
 * `ExecutionHandoffState`、cutover 后自动选中记录里的 Target、Source 转为只读、Target 等到用户下一条
 * 普通 Prompt 才回到普通会话，以及灾难路径 fail closed（不打开 cutover 路径、Source 仍是唯一 owner）。
 *
 * 「运行身份不变」用可观察的同一性证明：cutover 前后 Sidebar 里由快照投影出的身份行逐字相同，且
 * `executionHandoffRows` 明确把 Run/Task/Dispatch/Attempt/worktree/Authorization/预算排除在待转移责任
 * 之外。
 */

import { describe, expect, test } from 'vitest';

import type { SemanticEvent } from '../../src/application/controller-service.js';
import { COMMAND_IDS } from '../../src/interfaces/tui/components/command-palette.js';
import { executionHandoffRows } from '../../src/interfaces/tui/components/handoff-review.js';
import {
  createFakePorts,
  frameText,
  makeExecutionHandoff,
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

/** 打开 Command Palette 并选中第 `index` 个命令后执行。 */
async function runPaletteCommand(rendered: RenderedTui, index: number): Promise<void> {
  await pressKey(rendered, '\u0010');
  for (let step = 0; step < index; step += 1) {
    await pressKey(rendered, '\u001b[B');
  }
  await pressKey(rendered, '\r');
  await settle();
}

async function openSessionPicker(rendered: RenderedTui): Promise<void> {
  await runPaletteCommand(rendered, COMMAND_IDS.indexOf('session-picker'));
}

/** Ink 把单独一个 `ESC` 当作可能的分块转义序列前缀挂起后再回放，因此按 Esc 必须等真实时间。 */
async function pressEscape(rendered: RenderedTui): Promise<void> {
  rendered.stdin.write('\u001b');
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 40);
  await promise;
  await settle(2);
}

const HANDOFF_ID = 'execution-handoff-1';

/** 一次已复核、等待 cutover 的 Execution Handoff；Source 是 session-a，Target 是 session-b。 */
const HANDOFF = makeExecutionHandoff({
  handoffId: HANDOFF_ID,
  sourceSessionId: 'session-a',
  targetSessionId: 'session-b',
  phase: 'reviewed',
});

const EXECUTION_SNAPSHOT: SnapshotOverrides = {
  handoffs: [HANDOFF],
  executionLeaseHolderSessionId: 'session-a',
  frontier: [
    makeWorkPackageExecution('wp-1', {
      state: 'implementing',
      role: 'implementation',
      attemptId: 'attempt-7',
      liveness: 'live',
      worktreePath: '/wt/wp1',
      baselineHead: 'head-1',
    }),
  ],
  budgets: [{ budgetKey: 'worker-recovery', approvedLimitRef: 'limit-1', consumed: 2 }],
};

/**
 * Sidebar 一列的内容。Sidebar 与主视图处在同一行文本里，用左框线 `│` 切出右列，避免把主视图的
 * 状态行/提示也算进运行身份。
 */
function sidebarColumn(frame: string): readonly string[] {
  return frame.split('\n').map((line) => {
    const index = line.lastIndexOf('│');
    return index === -1 ? '' : line.slice(index + 1);
  });
}

/**
 * Sidebar 里由快照投影出的运行身份行（Run/Task/Dispatch/Attempt/worktree/Authorization/预算）。
 * 40 列会裁切行尾，因此只取这些行做逐字比较，不比较整屏。
 */
function runIdentityLines(frame: string): readonly string[] {
  return sidebarColumn(frame).filter(
    (line) =>
      line.includes('wp-1') ||
      line.includes('worktree=') ||
      line.includes('baseline=') ||
      line.includes('attempt=') ||
      line.includes('worker-recovery'),
  );
}

describe('recovery-observability / Execution Handoff 复用既有交互', () => {
  test('Scenario: 执行责任交接不改变运行身份', async () => {
    const fake = createFakePorts({ snapshot: EXECUTION_SNAPSHOT });
    const rendered = renderTui(fake.ports);
    await settle();

    const identityBefore = runIdentityLines(frameText(rendered));
    expect(identityBefore.join('\n')).toContain('worktree=/wt/wp1');
    expect(identityBefore.join('\n')).toContain('attempt=attempt-7');
    expect(identityBefore.join('\n')).toContain('worker-recovery 2/limit-1');

    await runPaletteCommand(rendered, COMMAND_IDS.indexOf('execution-handoff'));

    // prepare 的 Target 就是当前选中 Session；已复核（`reviewed`）的记录不再重复提交 review——
    // 复核只对 `prepared` 提案有效，重复复核会被用例拒绝。
    expect(fake.calls.find((call) => call.name === 'execution-handoff.prepare')?.detail).toBe('session-b');
    expect(fake.calls.map((call) => call.name)).not.toContain('execution-handoff.review');

    const overlay = frameText(rendered);
    expect(overlay).toContain('Execution Handoff Review');
    expect(overlay).toContain(`execution handoff ${HANDOFF_ID} phase=reviewed`);
    expect(overlay).toContain('source session-a -> target session-b');
    expect(overlay).toContain(
      '待转移责任: execution_coordination_lease, pending_interactions, worker_lifecycle_events',
    );
    expect(overlay).toContain(
      '运行身份（Run/Task/Dispatch/Attempt/worktree/Authorization/预算）保持不变',
    );
    // 待转移责任是闭集：运行身份不在其中，因此界面也不表达「运行身份已变更」。
    const rows = executionHandoffRows(HANDOFF, true).join('\n');
    expect(rows).toContain('保持不变');
    expect(rows).toContain('execution_coordination_lease');
    expect(rows).not.toContain('attempt-7');
    expect(rows).not.toContain('/wt/wp1');

    await pressKey(rendered, '\r');

    expect(
      fake.calls.filter((call) => call.name === 'execution-handoff.cutover').map((call) => call.detail),
    ).toEqual([HANDOFF_ID]);

    const after = frameText(rendered);
    expect(after).not.toContain('Execution Handoff Review');
    // 在途 Worker 与 worktree、预算身份逐字不变：cutover 只转移责任，不重建运行身份。
    expect(runIdentityLines(after)).toEqual(identityBefore);
    expect(after).not.toContain('运行身份已变更');

    rendered.unmount();
  });

  test('Scenario: 交接后等待用户 Prompt', async () => {
    const fake = createFakePorts({ snapshot: EXECUTION_SNAPSHOT });
    const rendered = renderTui(fake.ports);
    await settle();

    await runPaletteCommand(rendered, COMMAND_IDS.indexOf('execution-handoff'));
    // cutover 之前 Target 处于 awaiting_user_prompt：还没有被唤醒。
    expect(frameText(rendered)).toContain('target awaiting_user_prompt');

    // 确认前把选中 Session 切到 Source，用于观察 cutover 是否自动选中记录里的 Target。
    await openSessionPicker(rendered);
    await pressKey(rendered, '\u001b[A');
    await pressKey(rendered, '\r');
    await openSessionPicker(rendered);
    expect(frameText(rendered)).toContain('>  session-a active pending=0');
    await pressEscape(rendered);
    expect(frameText(rendered)).toContain('Execution Handoff Review');

    await pressKey(rendered, '\r');

    // cutover 完成后自动选中 Target（记录里的 targetSessionId），而不是停留在 Source。
    await openSessionPicker(rendered);
    expect(frameText(rendered)).toContain('>? session-b active pending=1');
    await pressEscape(rendered);

    const cutoverFrame = frameText(rendered);
    expect(cutoverFrame).not.toContain('Execution Handoff Review');
    expect(cutoverFrame).toContain('cutover 完成');

    // Worker 事件只增量落盘，不唤醒 Target 模型。
    expect(fake.executeCount()).toBe(0);
    const workerEvent: SemanticEvent = {
      eventId: 'worker-event-1',
      coordinatorSessionId: 'session-b',
      kind: 'worker-liveness-changed',
      coordinationScopeId: 'scope-1',
      dispatchId: 'dispatch-1',
      liveness: 'live',
    };
    fake.emit(workerEvent);
    await settle();
    expect(fake.executeCount()).toBe(0);

    // 用户发送下一条普通 Prompt 时 Target 仍是可写的普通会话。
    rendered.stdin.write('继续');
    await settle(2);
    expect(frameText(rendered)).toContain('继续');
    await pressKey(rendered, '\r');
    expect(fake.executeIntents.map((intent) => intent.kind)).toEqual(['send-session-message']);
    const sent = fake.executeIntents[0];
    if (sent?.kind === 'send-session-message') {
      expect(sent.coordinatorSessionId).toBe('session-b');
    }

    // Source transcript 只读：切回 Source 后 composer 拒绝输入，也不产生新意图。
    await openSessionPicker(rendered);
    await pressKey(rendered, '\u001b[A');
    await pressKey(rendered, '\r');
    expect(frameText(rendered)).toContain('(只读：该 Session 已交接)');
    const intentsBeforeSourceTyping = fake.executeIntents.length;
    rendered.stdin.write('x');
    await settle(2);
    expect(frameText(rendered)).toContain('(只读：该 Session 已交接)');
    await pressKey(rendered, '\r');
    expect(fake.executeIntents).toHaveLength(intentsBeforeSourceTyping);

    rendered.unmount();
  });

  test('Scenario: 交接灾难路径 fail closed —— prepare 被拒绝时不进入 cutover', async () => {
    const fake = createFakePorts({
      snapshot: EXECUTION_SNAPSHOT,
      executionHandoff: {
        prepare: { kind: 'rejected', code: 'no-capsule', message: 'checkpoint 不可恢复' },
      },
    });
    const rendered = renderTui(fake.ports);
    await settle();

    await runPaletteCommand(rendered, COMMAND_IDS.indexOf('execution-handoff'));

    const called = fake.calls.map((call) => call.name);
    expect(called).toContain('execution-handoff.prepare');
    expect(called).not.toContain('execution-handoff.review');
    expect(called).not.toContain('execution-handoff.cutover');

    // 不打开 review / cutover 路径，只呈现 blocker。
    const frame = frameText(rendered);
    expect(frame).not.toContain('Execution Handoff Review');
    expect(frame).toContain('no-capsule');

    // Source 仍是唯一 owner：选中 Session 不变，Target 未被激活。
    await openSessionPicker(rendered);
    expect(frameText(rendered)).toContain('>? session-b active pending=1');
    expect(fake.executeIntents).toEqual([]);

    rendered.unmount();
  });

  test('Scenario: 交接灾难路径 fail closed —— review 被拒绝时不自动激活 Target', async () => {
    // 只有 `prepared` 提案会被复核；复核被拒绝即 fail closed，且界面不得再给出 cutover 路径。
    const fake = createFakePorts({
      snapshot: {
        ...EXECUTION_SNAPSHOT,
        handoffs: [makeExecutionHandoff({ handoffId: HANDOFF_ID, phase: 'prepared' })],
      },
      executionHandoff: {
        review: { kind: 'rejected', code: 'no-capsule', message: 'Capsule 无法生成' },
      },
    });
    const rendered = renderTui(fake.ports);
    await settle();

    await runPaletteCommand(rendered, COMMAND_IDS.indexOf('execution-handoff'));

    const called = fake.calls.map((call) => call.name);
    expect(called).toContain('execution-handoff.review');
    // 复核被拒绝即 fail closed：不会自动 cutover，也不会切换选中 Session。
    expect(called).not.toContain('execution-handoff.cutover');
    expect(frameText(rendered)).toContain('no-capsule');

    // Source 仍是唯一 owner：Target 未被激活，也没有任何业务意图。
    await openSessionPicker(rendered);
    expect(frameText(rendered)).toContain('>? session-b active pending=1');
    expect(fake.executeIntents).toEqual([]);

    rendered.unmount();
  });

  test('Scenario: 交接灾难路径 fail closed —— 宿主报告 blocked 时不可确认 cutover', async () => {
    // 宿主在 checkpoint 不可恢复时把记录置为 blocked；即使 prepare 已被接受，也不得进入可确认的
    // cutover（因此 fake 的 review 返回值在本例中不会被触达）。
    const fake = createFakePorts({
      snapshot: { ...EXECUTION_SNAPSHOT, handoffs: [makeExecutionHandoff({ handoffId: HANDOFF_ID, phase: 'blocked' })] },
      executionHandoff: {
        review: { kind: 'rejected', code: 'capsule-unrecoverable', message: 'Source checkpoint 不可恢复' },
      },
    });
    const rendered = renderTui(fake.ports);
    await settle();

    await runPaletteCommand(rendered, COMMAND_IDS.indexOf('execution-handoff'));

    // blocked 记录不进入可确认的交接：没有 review、没有 cutover。
    const called = fake.calls.map((call) => call.name);
    expect(called).not.toContain('execution-handoff.review');
    expect(called).not.toContain('execution-handoff.cutover');

    // fail closed 必须可见：界面展示该 blocked 记录与原因，而不是「没有待审阅的记录」。
    const frame = frameText(rendered);
    expect(frame).toContain('Execution Handoff Review');
    expect(frame).toContain('Source 仍是唯一 owner');

    // Source 仍是唯一 owner。
    await openSessionPicker(rendered);
    expect(frameText(rendered)).toContain('>? session-b active pending=1');
    expect(fake.executeIntents).toEqual([]);

    rendered.unmount();
  });
});
