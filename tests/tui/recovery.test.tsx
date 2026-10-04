/**
 * Recovery 与 Segment 可观察（`tui/recovery-observability`「Recovery 与 Segment 可观察」）。
 *
 * 只断言界面里可观察的事实：Recovery Capsule 的 coverage 与已知缺口、剩余预算、替代 Segment 与
 * superseded 的原 Segment、失败 Recovery 形成的 blocker，以及迟到结果只进入 Event Drawer 的审计历史。
 *
 * Recovery 详情经项目工作记录入口读取；固定框内滚动观察换行后的身份与事实。
 */

import { describe, expect, test } from 'vitest';

import { COMMAND_IDS, type CommandId } from '../../src/interfaces/tui/components/command-palette.js';
import {
  createFakePorts,
  frameText,
  makeRecovery,
  makeWorkPackageExecution,
  renderTui,
  settle,
  type RenderedTui,
} from './harness.js';
import { createFakeGraphBasis } from '../support/graph-basis.js';

/* -------------------------------------------------------------------------- */
/* 依据下钻的跨屏返回（IP-04）                                                  */
/* -------------------------------------------------------------------------- */

/** 打开项目面板的「工作记录与依据」详情，并从末项进入依据下钻。 */
async function enterBasisFromWorkDetails(rendered: RenderedTui): Promise<void> {
  await press(rendered, '\u0002');
  for (let step = 0; step < 4; step += 1) await press(rendered, '\u001b[B');
  await press(rendered, '\r');
  await press(rendered, '\r');
  // 详情里的 Enter 打开依据入口页；↓ 选到「执行依据（当前图）」再进入来源目录。
  await press(rendered, '\u001b[B');
  await press(rendered, '\r');
  await settle(2);
}

async function pressEscape(rendered: RenderedTui): Promise<void> {
  rendered.stdin.write('\u001b');
  await new Promise((resolve) => setTimeout(resolve, 40));
  await settle(2);
}

describe('依据下钻的返回语义', () => {
  test('从项目工作详情进入并逐层返回：栏目、对象、草稿与 Session 都不变', async () => {
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
      sources: [
        {
          id: 'plan:graph-1:1:2',
          label: '初始 Implementation Plan',
          ref: { kind: 'initial_plan', graph: { graphId: 'graph-1', generation: 1, version: 2 } },
          sourceVersion: 'plan-3',
          unavailable: null,
        },
      ],
    });
    const rendered = renderTui({ ...fake.ports, graphBasis: basis.port });
    await settle();

    // 先留一个未发送的草稿：返回后必须原样还在。
    rendered.stdin.write('未发送的草稿');
    await settle(2);

    await enterBasisFromWorkDetails(rendered);
    expect(frameText(rendered)).toContain('依据来源目录');
    expect(frameText(rendered)).toContain('初始 Implementation Plan');

    await pressEscape(rendered);
    expect(frameText(rendered)).toContain('执行依据与历史图');
    await pressEscape(rendered);
    const back = frameText(rendered);
    // 回到原栏目、原对象与原详情，而不是关闭项目面板。
    expect(back).toContain('项目面板');
    expect(back).toContain('详情');
    expect(back).toContain('Enter 依据与历史');
    expect(back).toContain('未发送的草稿');
    expect(fake.executeCount()).toBe(0);

    rendered.unmount();
  });

  test('从 Inspector 进入并逐层返回：选择、栏目与滚动位置保留', async () => {
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

    await press(rendered, '\u0007');
    await press(rendered, '\u001b[B');
    expect(frameText(rendered)).toContain('2 第二个工作包');
    await press(rendered, '\t');
    expect(frameText(rendered)).toContain('src/b.ts');

    await press(rendered, '\r');
    expect(frameText(rendered)).toContain('Enter 打开依据与历史目录');
    // 完整记录的末项 Enter 才进入依据：再按一次进入目录入口。
    await press(rendered, '\r');
    expect(frameText(rendered)).toContain('执行依据与历史图');
    await press(rendered, '\r');
    expect(frameText(rendered)).toContain('图版本历史');

    await pressEscape(rendered);
    expect(frameText(rendered)).toContain('执行依据与历史图');
    await pressEscape(rendered);
    const back = frameText(rendered);
    expect(back).toContain('Graph Inspector');
    // 返回后仍是同一个节点与同一个栏目。
    expect(back).toContain('2 第二个工作包');
    expect(back).toContain('src/b.ts');
    expect(fake.executeCount()).toBe(0);

    rendered.unmount();
  });
});


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

async function readWorkDetails(rendered: RenderedTui): Promise<string> {
  await press(rendered, '\u0002');
  for (let step = 0; step < 4; step += 1) await press(rendered, '\u001b[B');
  await press(rendered, '\r');
  const frames: string[] = [];
  for (let step = 0; step < 120; step += 1) {
    const frame = frameText(rendered).replace(/[\s│]/gu, '');
    frames.push(frame);
    if (frame.includes('Enter打开依据来源与历史图版本目录')) break;
    await press(rendered, '\u001b[B');
  }
  expect(frames.at(-1)).toContain('Enter打开依据来源与历史图版本目录');
  await press(rendered, '\u001b');
  await new Promise(resolve => setTimeout(resolve, 60));
  await press(rendered, '\u001b');
  await new Promise(resolve => setTimeout(resolve, 60));
  return frames.join('\n');
}

describe('recovery-observability / Recovery 与 Segment 可观察', () => {
  test('Scenario: partial coverage 与缺口可见', async () => {
    const fake = createFakePorts({
      snapshot: {
        frontier: [makeWorkPackageExecution('wp-1', { state: 'implementing', role: 'implementation' })],
        recoveries: [
          makeRecovery({
            role: 'planner',
            capsule: { ref: 'cap-1', coverage: 'partial', gaps: ['g1'] },
            sourceSegmentId: 's0',
            replacementSegmentId: 's2',
            supersededSegmentId: 's0',
            remainingBudget: 1,
            budgetLimit: 2,
          }),
        ],
      },
    });

    const rendered = renderTui(fake.ports);
    await settle();
    const rows = await readWorkDetails(rendered);

    expect(rows).toContain('recovery'); // recovery 分区
    // Capsule 的 coverage 与已知缺口是独立字段，不被合并成「已恢复」。
    expect(rows).toContain('capsulecap-1coverage=partialgaps=g1');
    // 剩余 Recovery 预算。
    expect(rows).toContain('budgetremaining=1/2');
    // 替代 Segment 与原 provider Segment 分开呈现，并标出被取代的原 Segment。
    expect(rows).toContain('segments0->s2');
    expect(rows).toContain('supersededs0');

    // 只读投影：展示 Recovery 不产生任何写。
    expect(fake.executeCount()).toBe(0);
    rendered.unmount();
  });

  test('Scenario: 迟到结果只补历史', async () => {
    const fake = createFakePorts({
      snapshot: {
        frontier: [makeWorkPackageExecution('wp-1', { state: 'implementing', role: 'implementation' })],
        recoveries: [
          makeRecovery({
            sourceSegmentId: 's0',
            replacementSegmentId: 's2',
            supersededSegmentId: 's0',
            acceptedResultRef: null,
          }),
        ],
      },
    });

    const rendered = renderTui(fake.ports);
    await settle();
    expect(await readWorkDetails(rendered)).toContain('supersededs0');
    expect(frameText(rendered)).toContain('implementing');

    // 被 superseded 的原 Session 在替代 Dispatch 被接受后返回结果。
    fake.emit({
      kind: 'recovery-status-changed',
      coordinationScopeId: 'scope-1',
      recoveryId: 'recovery-1',
      status: 'recovered',
      eventId: 'event-late-result',
      coordinatorSessionId: null,
    });
    await settle(2);

    // 结果只作为审计历史：既不改写 transcript，也不出现在主视图。
    const afterEvent = frameText(rendered);
    expect(afterEvent).not.toContain('recovery-status-changed');
    expect(afterEvent).toContain('先看看地图');

    await runPaletteCommand(rendered, 'event-drawer');
    await settle(2);
    const list=frameText(rendered);
    expect(list).toContain('[recovery]');
    await press(rendered,'\r');
    const drawer = frameText(rendered);
    expect(drawer).toContain('recovery-1');
    expect(drawer.replace(/\s|│/g,'')).toContain('recovery-status-changedrecovery-1->recovered');

    // 关闭抽屉后当前 Work Package 生命周期不变。
    await press(rendered,'\u001b');await new Promise(resolve=>setTimeout(resolve,60));
    await press(rendered,'\u001b');await new Promise(resolve=>setTimeout(resolve,60));await settle();
    expect(frameText(rendered)).toContain('implementing');
    expect(fake.executeCount()).toBe(0);
    rendered.unmount();
  });

  test('Scenario: Recovery 失败投影为 blocker', async () => {
    const fake = createFakePorts({
      snapshot: {
        frontier: [
          makeWorkPackageExecution('wp-1', {
            state: 'blocked',
            blockerRefs: ['recovery:transcript-unavailable'],
          }),
        ],
        recoveries: [
          makeRecovery({
            status: 'blocked',
            blockingReason: 'transcript 不可用',
            replacementSegmentId: null,
            supersededSegmentId: null,
            // Recovery 失败是终结结果 `failed`（`blocked` 是 Recovery 状态，不是 terminal outcome）。
            terminalOutcome: 'failed',
          }),
        ],
      },
    });

    const rendered = renderTui(fake.ports);
    await settle();
    const frame = frameText(rendered);

    // 失败以明确 blocker 呈现（Recovery 行与 Work Package 的 blockerRefs 都可见）。
    const rows = await readWorkDetails(rendered);
    expect(rows).toContain('!transcript不可用');
    expect(rows).toContain('recovery:transcript-unavailable');
    expect(rows).toContain('validatorblocked');
    // 没有替代 Segment 就没有「已恢复」。
    expect(rows).toContain('segmentsegment-1->none');
    expect(frame).not.toContain('recovered');
    expect(frame).not.toContain('已恢复');

    expect(fake.executeCount()).toBe(0);
    rendered.unmount();
  });
});
