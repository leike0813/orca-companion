/**
 * 初始化向导的核验与原子创建测试（IP-04，Owner: `m2-deliver-planning-tui`）。
 *
 * 断言可观察行为：核验只是只读端口调用、确认前 `initialize` 计数恒为 0、确认后恰好一次，以及向导不
 * 出现预算/权限类输入项。失败项与创建结果只取关键语义片段，不锁整屏文案。
 */

import { afterEach, describe, expect, test } from 'vitest';
import { cleanup } from 'ink-testing-library';

import { WIZARD_CHECKS } from '../../src/interfaces/tui/ports.js';
import {
  allChecksOk,
  createFakePorts,
  DEFAULT_PROPOSAL,
  renderTui,
  settle,
  type FakePorts,
  type FakePortsOptions,
  type RenderedTui,
} from './harness.js';

afterEach(() => {
  cleanup();
});

function callsNamed(fake: FakePorts, name: string): number {
  return fake.calls.filter((call) => call.name === name).length;
}

/**
 * Ink 会把孤立的 ESC 当作不完整转义序列缓存 20ms 再作为 escape 事件冲刷，所以退出向导的断言必须
 * 等过这个窗口。
 */
async function settleEscape(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 60));
  await settle(8);
}

/** 从「没有 Scope」的 Home 进入向导，并等待自动核验落地。 */
async function enterWizard(options: FakePortsOptions = {}): Promise<{ readonly fake: FakePorts; readonly rendered: RenderedTui }> {
  const fake = createFakePorts({ ...options, home: { kind: 'wizard' } });
  const rendered = renderTui(fake.ports);
  await settle(12);
  rendered.stdin.write('n');
  await settle(12);
  return { fake, rendered };
}

describe('初始化向导的核验与原子创建', () => {
  test('Scenario: 确认后原子创建最小 Scope，且恰好一次 initialize', async () => {
    const { fake, rendered } = await enterWizard();

    // 核验全部通过后展示 Review；此时仍没有任何写入。
    expect(rendered.lastFrame() ?? '').toContain('Review');
    expect(callsNamed(fake, 'verify')).toBe(1);
    expect(callsNamed(fake, 'proposal')).toBe(1);
    expect(callsNamed(fake, 'initialize')).toBe(0);

    rendered.stdin.write('\r');
    await settle(12);

    const initializeCalls = fake.calls.filter((call) => call.name === 'initialize');
    expect(initializeCalls).toHaveLength(1);
    // 界面把宿主准备好的提议原样交给应用层，不自行生成身份。
    expect(initializeCalls[0]?.detail).toEqual(DEFAULT_PROPOSAL);

    // 初始化只建立 Scope/Planning Cycle/首个 Session：不派发执行意图，也不准备 Orca Run/Task/worktree。
    expect(callsNamed(fake, 'execute')).toBe(0);
    expect(fake.calls.filter((call) => call.name.startsWith('handoff.')).length).toBe(0);

    // 创建成功后进入该 Scope 的 workspace。
    expect(rendered.lastFrame() ?? '').toContain(DEFAULT_PROPOSAL.coordinationScopeId);

    // 已经离开向导，后续按键不会重复创建。
    rendered.stdin.write('\r');
    await settle(12);
    expect(callsNamed(fake, 'initialize')).toBe(1);
  });

  test('Scenario: 向导不收集预算与权限，只核验五个允许项', async () => {
    const { fake, rendered } = await enterWizard();
    const frame = rendered.lastFrame() ?? '';

    // 核验集合恰为 repository/worktree、Orca 能力与身份、Model Configuration、tracker。
    expect([...WIZARD_CHECKS]).toEqual(['repository', 'orca', 'identity', 'model', 'tracker']);
    for (const checkId of WIZARD_CHECKS) {
      expect(frame).toContain(checkId);
    }

    // 这些输入项属于 Execution Authorization Manifest，不得出现在初始化向导。
    for (const forbidden of ['Worker Profile', '预算', '依赖权限', 'Git 集成', 'accepted risk', '风险']) {
      expect(frame).not.toContain(forbidden);
    }

    expect(callsNamed(fake, 'initialize')).toBe(0);
  });

  test('Scenario: 核验失败停留在向导且零写入', async () => {
    const checks = allChecksOk().map((check) =>
      check.id === 'orca' ? { ...check, ok: false, detail: 'orchestration 能力缺失' } : check,
    );
    const { fake, rendered } = await enterWizard({ checks });

    const frame = rendered.lastFrame() ?? '';
    expect(frame).toContain('初始化向导');
    expect(frame).toContain('orca');
    expect(frame).toContain('核验失败');
    // 失败时不准备创建提议，也不展示可确认的 Review。
    expect(callsNamed(fake, 'proposal')).toBe(0);
    expect(frame).not.toContain('Review');

    // 即使尝试确认，也不产生任何 Scope 或 Planning Cycle 记录。
    rendered.stdin.write('\r');
    await settle(12);
    expect(callsNamed(fake, 'initialize')).toBe(0);
    expect(rendered.lastFrame() ?? '').toContain('初始化向导');
  });

  test('Scenario: 确认前退出不留记录，重新启动仍进入向导', async () => {
    const { fake, rendered } = await enterWizard();
    expect(rendered.lastFrame() ?? '').toContain('Review');

    rendered.stdin.write('\u001B');
    await settleEscape();
    expect(rendered.lastFrame() ?? '').toContain('还没有 Coordination Scope');
    expect(callsNamed(fake, 'initialize')).toBe(0);

    // 重启：没有任何 Scope 被写入，所以同一仓库仍走向导路径。
    rendered.unmount();
    const restarted = renderTui(fake.ports);
    await settle(12);
    expect(restarted.lastFrame() ?? '').toContain('还没有 Coordination Scope');

    restarted.stdin.write('n');
    await settle(12);
    expect(restarted.lastFrame() ?? '').toContain('初始化向导');
    expect(callsNamed(fake, 'initialize')).toBe(0);
  });
});

