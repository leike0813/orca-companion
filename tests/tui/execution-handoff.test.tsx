import { chooseCommand } from './harness.js';
/**
 * Execution Handoff 复用既有交互（IP-09，`tui/recovery-observability`）。
 *
 * 断言的是交接交互的可观察后果：复用 Command Palette 与 Handoff Review 入口、只投影
 * `ExecutionHandoffState`、cutover 后自动选中记录里的 Target、Source 转为只读、Target 等到用户下一条
 * 普通 Prompt 才回到普通会话，以及灾难路径 fail closed（不打开 cutover 路径、Source 仍是唯一 owner）。
 *
 * 「运行身份不变」用可观察的同一性证明：cutover 前后项目工作/预算详情里的身份与引用保持可读，且
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
import { createFakeGraphBasis } from '../support/graph-basis.js';

describe('依据下钻与弹窗的层级（IP-04）', () => {
  test('依据页打开时执行新弹窗会结束下钻，弹窗关闭后回到原工作区', async () => {
    const fake = createFakePorts();
    const basis = createFakeGraphBasis({
      versions: [
        {
          graphId: 'graph-1',
          generation: 1,
          version: 2,
          recordKind: 'initial',
          parentVersion: null,
          patchId: null,
          mapRevision: 3,
          planRevision: 3,
          orcaRunId: 'run-1',
          recordedAt: Date.UTC(2026, 9, 1),
          generationStatus: 'candidate',
          current: true,
        },
      ],
    });
    const rendered = renderTui({ ...fake.ports, graphBasis: basis.port });
    await settle();

    // 从项目面板的工作详情进入：那里没有覆盖层，因此 Ctrl+P 仍能打开新弹窗。
    await pressKey(rendered, '\u0002');
    for (let step = 0; step < 4; step += 1) await pressKey(rendered, '\u001b[B');
    await pressKey(rendered, '\r');
    await pressKey(rendered, '\r');
    expect(frameText(rendered)).toContain('执行依据与历史图');

    // 弹窗有自己的返回语义：打开即结束依据下钻，不叠加在依据页面之上。
    await openSessionPicker(rendered);
    expect(frameText(rendered)).toContain('Session Picker');
    expect(frameText(rendered)).not.toContain('执行依据与历史图');

    // Session Picker 下面还压着 Command Palette：Esc 逐层返回两次才回到工作区。
    await pressEscape(rendered);
    await pressEscape(rendered);
    const back = frameText(rendered);
    expect(back).not.toContain('执行依据与历史图');
    expect(back).not.toContain('Session Picker');
    expect(back).toContain('普通消息');
    expect(fake.executeCount()).toBe(0);

    rendered.unmount();
  });
});


async function pressKey(rendered: RenderedTui, input: string): Promise<void> {
  rendered.stdin.write(input);
  await settle(2);
}

/** 打开 Command Palette 并选中第 `index` 个命令后执行。 */
async function runPaletteCommand(rendered: RenderedTui, index: number): Promise<void> {
  await chooseCommand(rendered,COMMAND_IDS[index]!);
  if(index===COMMAND_IDS.indexOf('execution-handoff')){await pressKey(rendered,'\r');await settle();}
}
async function openSessionPicker(rendered: RenderedTui): Promise<void> {
  await runPaletteCommand(rendered, COMMAND_IDS.indexOf('session-picker'));
}

function expectSelectedSession(frame: string, sessionId: string): void {
  const row = frame.split('\n').find((line) => line.includes(sessionId)&&/[✔√]/u.test(line)) ?? '';
  expect(row).toMatch(/[✔√]/u);
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
  mode:'execution_coordination',
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

async function runIdentityLines(rendered: RenderedTui): Promise<string> {
  await pressKey(rendered, '\u0002');
  for (let step = 0; step < 4; step += 1) await pressKey(rendered, '\u001b[B');
  await pressKey(rendered, '\r');
  const frames: string[] = [];
  for (let step = 0; step < 100; step += 1) {
    const frame = frameText(rendered).replace(/[\s│]/gu, '');
    frames.push(frame);
    if (frame.includes('Enter打开依据来源与历史图版本目录')) break;
    await pressKey(rendered, '\u001b[B');
  }
  expect(frames.at(-1)).toContain('Enter打开依据来源与历史图版本目录');
  await pressEscape(rendered);
  for (let step = 0; step < 3; step += 1) await pressKey(rendered, '\u001b[A');
  await pressKey(rendered, '\r');
  frames.push(frameText(rendered).replace(/[\s│]/gu, ''));
  await pressEscape(rendered);
  await pressEscape(rendered);
  return frames.join('\n');
}

describe('recovery-observability / Execution Handoff 复用既有交互', () => {
  test('Scenario: 执行责任交接不改变运行身份', async () => {
    const fake = createFakePorts({ snapshot: EXECUTION_SNAPSHOT });
    const rendered = renderTui(fake.ports);
    await settle();

    const identities = ['wp-1', '/wt/wp1', 'attempt-7', 'head-1', 'worker-recovery:已用2', '批准引用limit-1'];
    const identityBefore = await runIdentityLines(rendered);
    for (const identity of identities) expect(identityBefore).toContain(identity);

    await runPaletteCommand(rendered, COMMAND_IDS.indexOf('execution-handoff'));

    // prepare 的 Target 就是当前选中 Session；已复核（`reviewed`）的记录不再重复提交 review——
    // 复核只对 `prepared` 提案有效，重复复核会被用例拒绝。
    expect(fake.calls.find((call) => call.name === 'execution-handoff.prepare')?.detail).toBe('session-b');
    expect(fake.calls.map((call) => call.name)).not.toContain('execution-handoff.review');

    await pressKey(rendered, '\t');
    const overlay = frameText(rendered);
    expect(overlay).toContain('Execution Handoff Review');
    expect(overlay).toContain('转移责任');
    expect(overlay).toContain('execution_coordination_lease');

    // 待转移责任是闭集：运行身份不在其中，因此界面也不表达「运行身份已变更」。
    const rows = executionHandoffRows(HANDOFF, true).join('\n');
    expect(rows).toContain('保持不变');
    expect(rows).toContain('execution_coordination_lease');
    expect(rows).not.toContain('attempt-7');
    expect(rows).not.toContain('/wt/wp1');

    await pressKey(rendered, '\u001b[C');
    await pressKey(rendered, '\r');

    expect(
      fake.calls.filter((call) => call.name === 'execution-handoff.cutover').map((call) => call.detail),
    ).toEqual([HANDOFF_ID]);

    const after = frameText(rendered);
    expect(after).not.toContain('Execution Handoff Review');
    // cutover 后仍从真实界面入口核对原 Work Package、attempt、worktree、baseline 与预算引用。
    const identityAfter = await runIdentityLines(rendered);
    for (const identity of identities) expect(identityAfter).toContain(identity);
    expect(after).not.toContain('运行身份已变更');

    rendered.unmount();
  });

  test('Scenario: 交接后等待用户 Prompt', async () => {
    const fake = createFakePorts({ snapshot: EXECUTION_SNAPSHOT });
    const rendered = renderTui(fake.ports);
    await settle();

    // 审阅优先消费输入：全局键位不穿透。因此先切到 Source（session-a），再打开审阅；
    // 这样仍能观察 cutover 是否自动选中记录里的 Target（session-b）。
    await openSessionPicker(rendered);
    await pressKey(rendered, '\u001b[A');
    await pressKey(rendered, '\r');
    await openSessionPicker(rendered);
    expectSelectedSession(frameText(rendered), 'session-a');
    await pressEscape(rendered);

    await runPaletteCommand(rendered, COMMAND_IDS.indexOf('execution-handoff'));
    await pressKey(rendered, '\t');
    // cutover 之前 Target 处于 awaiting_user_prompt：还没有被唤醒。
    expect(frameText(rendered)).toContain('awaiting_user_prompt');

    await pressKey(rendered, '\u001b[C');
    await pressKey(rendered, '\r');

    // cutover 完成后自动选中 Target（记录里的 targetSessionId），而不是停留在 Source。
    await openSessionPicker(rendered);
    expectSelectedSession(frameText(rendered), 'session-a');
    await pressKey(rendered,'\u001b[B');await pressKey(rendered,'\r');

    const cutoverFrame = frameText(rendered);
    expect(cutoverFrame).not.toContain('Execution Handoff Review');
    expect(cutoverFrame).toContain('session-b');

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
    expectSelectedSession(frameText(rendered), 'session-b');
    expect(fake.executeIntents).toEqual([]);

    rendered.unmount();
  });

  test('Scenario: 交接灾难路径 fail closed —— review 被拒绝时不自动激活 Target', async () => {
    // 只有 `prepared` 提案会被复核；复核被拒绝即 fail closed，且界面不得再给出 cutover 路径。
    const fake = createFakePorts({
      snapshot: {
        mode:'execution_coordination',
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

    // 审阅优先消费输入：先合法返回（Esc），再查看选中 Session。
    // Source 仍是唯一 owner：Target 未被激活，也没有任何业务意图。
    await pressEscape(rendered);
    await openSessionPicker(rendered);
    expectSelectedSession(frameText(rendered), 'session-b');
    expect(fake.executeIntents).toEqual([]);

    rendered.unmount();
  });

  test('Scenario: 交接灾难路径 fail closed —— 宿主报告 blocked 时不可确认 cutover', async () => {
    // 宿主在 checkpoint 不可恢复时把记录置为 blocked；即使 prepare 已被接受，也不得进入可确认的
    // cutover（因此 fake 的 review 返回值在本例中不会被触达）。
    const fake = createFakePorts({
      snapshot: {
        mode:'execution_coordination', ...EXECUTION_SNAPSHOT, handoffs: [makeExecutionHandoff({ handoffId: HANDOFF_ID, phase: 'blocked' })] },
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

    // 审阅优先消费输入：先合法返回（Esc）。
    // Source 仍是唯一 owner。
    await pressEscape(rendered);
    await openSessionPicker(rendered);
    expectSelectedSession(frameText(rendered), 'session-b');
    expect(fake.executeIntents).toEqual([]);

    rendered.unmount();
  });
});
