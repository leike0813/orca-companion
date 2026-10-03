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
    if (frame.includes('历史图版本和依据全文读取')) break;
    await press(rendered, '\u001b[B');
  }
  expect(frames.at(-1)).toContain('历史图版本和依据全文读取');
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
