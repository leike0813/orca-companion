/**
 * Home 的 Scope 恢复与查找测试（IP-04，Owner: `m2-deliver-planning-tui`）。
 *
 * 断言可观察行为：解析结果经 `ScopeSetupPort.resolveHome` 进入哪个屏幕、是否调用了创建端口。界面文案只
 * 取关键语义片段，不锁整屏。
 */

import { afterEach, describe, expect, test } from 'vitest';
import { createElement } from 'react';
import { cleanup } from 'ink-testing-library';

import { Home } from '../../src/interfaces/tui/screens/home.js';
import type { ScopeCandidate } from '../../src/interfaces/tui/ports.js';
import { createFakePorts, renderComponent, renderTui, settle, type FakePorts } from './harness.js';

afterEach(() => {
  cleanup();
});

function initializeCalls(fake: FakePorts): number {
  return fake.calls.filter((call) => call.name === 'initialize').length;
}

function snapshotCalls(fake: FakePorts): number {
  return fake.calls.filter((call) => call.name === 'snapshot').length;
}

describe('Home 的 Scope 恢复与查找', () => {
  test('Scenario: 存在唯一 Scope 时直接恢复，不重复创建', async () => {
    const fake = createFakePorts({
      home: { kind: 'restore', coordinationScopeId: 'scope-restored' },
      snapshot: { coordinationScopeId: 'scope-restored' },
    });
    const rendered = renderTui(fake.ports);
    await settle(12);

    const frame = rendered.lastFrame() ?? '';
    expect(frame).toContain('scope-restored');
    // 直接进入该 Scope 的 workspace：命中恢复路径就意味着加载了选中 Session 的快照。
    expect(snapshotCalls(fake)).toBeGreaterThan(0);
    // 恢复不创建新 Scope。
    expect(initializeCalls(fake)).toBe(0);
  });

  test('Scenario: 无匹配 Scope 时进入向导，确认前零持久化', async () => {
    const fake = createFakePorts({ home: { kind: 'wizard' } });
    const rendered = renderTui(fake.ports);
    await settle(12);

    // 零 Scope 时先呈现向导入口，且不隐式创建。
    expect(rendered.lastFrame() ?? '').toContain('还没有 Coordination Scope');
    expect(initializeCalls(fake)).toBe(0);

    rendered.stdin.write('n');
    await settle(12);

    expect(rendered.lastFrame() ?? '').toContain('初始化向导');
    expect(fake.calls.filter((call) => call.name === 'verify').length).toBeGreaterThan(0);
    expect(initializeCalls(fake)).toBe(0);
  });

  test('Scenario: 多个 Scope 时列出候选并要求显式选择，不自动绑定或创建', async () => {
    const candidates: readonly ScopeCandidate[] = [
      { coordinationScopeId: 'scope-1', mode: 'route_planning', controlState: 'active' },
      { coordinationScopeId: 'scope-2', mode: 'route_planning', controlState: 'paused' },
    ];
    const fake = createFakePorts({
      home: { kind: 'choose', candidates },
      snapshot: { coordinationScopeId: 'scope-2' },
    });
    const rendered = renderTui(fake.ports);
    await settle(12);

    const frame = rendered.lastFrame() ?? '';
    for (const candidate of candidates) {
      expect(frame).toContain(candidate.coordinationScopeId);
    }
    // 未选择前不进入任何 Scope：既不加载快照，也不创建。
    expect(snapshotCalls(fake)).toBe(0);
    expect(initializeCalls(fake)).toBe(0);

    rendered.stdin.write('\u001B[B');
    await settle(4);
    rendered.stdin.write('\r');
    await settle(12);

    expect(snapshotCalls(fake)).toBeGreaterThan(0);
    expect(initializeCalls(fake)).toBe(0);
    expect(rendered.lastFrame() ?? '').toContain('scope-2');
  });

  test('窄屏下候选仍逐条列出且身份可辨（直接渲染 Home 并显式传宽）', async () => {
    const candidates: readonly ScopeCandidate[] = [
      { coordinationScopeId: 'scope-1', mode: 'route_planning', controlState: 'active' },
      { coordinationScopeId: 'scope-2', mode: 'execution_coordination', controlState: 'active' },
    ];
    const rendered = renderComponent(
      createElement(Home, {
        resolution: { kind: 'choose', candidates },
        onSelectScope: () => undefined,
        onStartWizard: () => undefined,
        availableWidth: 12,
      }),
    );
    await settle(2);

    const frame = rendered.lastFrame() ?? '';
    for (const candidate of candidates) {
      expect(frame).toContain(candidate.coordinationScopeId);
    }
  });
});
