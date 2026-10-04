import { chooseCommand } from './harness.js';
/**
 * Execution Authorization Review（IP-01，`coordinator/foreground-execution-runtime`）。
 *
 * 断言的是可观察事实：审阅只读（挂载与打开 Review 都不产生任何写意图）、批准只回传用户看到的那份
 * Manifest 的指纹与 Scope revision、门禁未通过时 Enter 不提交批准。界面不组装 Manifest，也不计算
 * 指纹，因此它不可能把「另一份内容」当成批准对象。
 */

import { describe, expect, test } from 'vitest';

import { type CommandId } from '../../src/interfaces/tui/components/command-palette.js';
import { authorizationApprovable } from '../../src/interfaces/tui/components/authorization-review.js';
import {
  createFakePorts,
  frameText,
  makeAuthorizationReview,
  renderTui,
  settle,
  type RenderedTui,
} from './harness.js';

async function pressKey(rendered: RenderedTui, input: string): Promise<void> {
  rendered.stdin.write(input);
  await settle(2);
}

/** 打开 Command Palette，移动 `index` 格后回车；索引按 `COMMAND_IDS` 查，不写死数字。 */
async function runPaletteCommand(rendered: RenderedTui, command: CommandId): Promise<void> {
  await chooseCommand(rendered,command);
}
describe('tui/execution-authorization / 完整 Manifest 的审阅与一次批准', () => {
  test('Scenario: 打开审阅是只读的 —— 只读取一次审阅事实，不提交任何写意图', async () => {
    const fake = createFakePorts();
    const rendered = renderTui(fake.ports);
    await settle();

    expect(fake.executeCount()).toBe(0);

    await runPaletteCommand(rendered, 'authorize-execution');

    expect(fake.calls.filter((call) => call.name === 'authorization.review')).toHaveLength(1);
    expect(fake.executeCount()).toBe(0);
    // 完整 Manifest 与门禁都可见：审阅界面只显示宿主读好的字段。
    const frame = frameText(rendered);
    expect(frame).toContain('Execution Authorization Review');
    expect(frame).toContain('概览');
    for(let tab=0;tab<4;tab++)await pressKey(rendered,'\t');
    expect(frameText(rendered)).toContain('fingerprint-1');
  });

  test('Scenario: 批准只回传指纹与 revision —— 界面不构造 Manifest 身份', async () => {
    const fake = createFakePorts();
    const rendered = renderTui(fake.ports);
    await settle();

    await runPaletteCommand(rendered, 'authorize-execution');
    await pressKey(rendered, '\r');
    expect(fake.calls.filter(call=>call.name==='authorization.approve')).toHaveLength(0);
    await runPaletteCommand(rendered, 'authorize-execution');
    await pressKey(rendered, '\u001b[C');
    await pressKey(rendered, '\r');

    expect(fake.calls.filter((call) => call.name === 'authorization.approve')).toEqual([
      {
        name: 'authorization.approve',
        detail: { fingerprint: 'fingerprint-1', expectedRevision: 7 },
      },
    ]);
    // 批准本身不是 execute 意图（端口直接回传），因此不产生额外写意图。
    expect(fake.executeCount()).toBe(0);
  });

  test('Scenario: 门禁未通过时不可批准 —— Enter 不提交批准', async () => {
    const fake = createFakePorts({
      authorizationReview: makeAuthorizationReview({
        gate: { ready: false, blockers: ['open_decision_tickets: 仍有 1 张开放 Decision Ticket'] },
      }),
    });
    const rendered = renderTui(fake.ports);
    await settle();

    await runPaletteCommand(rendered, 'authorize-execution');
    expect(frameText(rendered)).toContain('open_decision_tickets');
    await pressKey(rendered, '\u001b[C');
    await pressKey(rendered, '\r');
    expect(fake.calls.filter((call) => call.name === 'authorization.approve')).toHaveLength(0);
  });

  test('投影规则：只有审阅成功且门禁通过才可批准', () => {
    expect(authorizationApprovable(null)).toBe(false);
    expect(authorizationApprovable({ kind: 'rejected', code: 'x', message: 'y' })).toBe(false);
    expect(authorizationApprovable({ kind: 'blocked', code: 'x', message: 'y' })).toBe(false);
    expect(makeAuthorizationReview().kind).toBe('review');
    expect(authorizationApprovable(makeAuthorizationReview())).toBe(true);
    expect(
      authorizationApprovable(
        makeAuthorizationReview({ gate: { ready: false, blockers: ['fog_present: 未清空'] } }),
      ),
    ).toBe(false);
  });
});
