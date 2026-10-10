import { createElement } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup } from 'ink-testing-library';
import { TuiApp } from '../../src/interfaces/tui/app.js';
import { StartupOnboarding } from '../../src/interfaces/tui/screens/startup-onboarding.js';
import { allChecksOk, createFakePorts, DEFAULT_PROPOSAL, renderComponent, settle } from './harness.js';
import type { WizardCheck } from '../../src/interfaces/tui/ports.js';

afterEach(cleanup);

test('已有 Scope 启动先自动核验环境，逐项显示且失败不会自动重试或加载会话', async () => {
  const fake = createFakePorts({ home: { kind: 'restore', coordinationScopeId: 'scope-a' } });
  const pending = Promise.withResolvers<readonly WizardCheck[]>();
  const verifyEnvironment = vi.fn((report?: (check: WizardCheck) => void) => {
    report?.({ id: 'repository', ok: true, detail: '/repo/main' });
    return pending.promise;
  });
  Object.assign(fake.ports.scopeSetup, { verifyEnvironment });
  const rendered = renderComponent(createElement(TuiApp, { ports: fake.ports, terminalWidth: 80, initialScopeId: 'scope-a', onExit: vi.fn() }));
  await settle();
  expect(verifyEnvironment).toHaveBeenCalledOnce();
  expect(rendered.lastFrame()).toContain('/repo/main');
  expect(fake.calls.some(call => call.name === 'snapshot')).toBe(false);
  pending.resolve([{ id: 'orca', ok: false, detail: 'runtime offline' }]);
  await settle();
  expect(rendered.lastFrame()).toContain('重试');
  await settle(15);
  expect(verifyEnvironment).toHaveBeenCalledOnce();
  rendered.stdin.write('\r');
  await settle();
  expect(verifyEnvironment).toHaveBeenCalledTimes(2);
});

test('已有项目配置仍须明确确认，能力失败不初始化，重试只初始化一次', async () => {
  const fake = createFakePorts({ home: { kind: 'wizard' } });
  const checks = allChecksOk();
  const verify = vi.fn().mockResolvedValueOnce(checks.map(check => check.id === 'model' ? { ...check, ok: false } : check)).mockResolvedValue(checks);
  Object.assign(fake.ports.scopeSetup, { verifyEnvironment: () => Promise.resolve(checks.slice(0, 3)), verify });
  Object.assign(fake.ports, { modelSettings: { load: () => Promise.resolve({ kind: 'loaded', snapshot: { revision: 1 } }) } });
  const ready = vi.fn();
  const rendered = renderComponent(createElement(StartupOnboarding, { ports: fake.ports, width: 80, onReady: ready, onExit: vi.fn() }));
  await settle();
  expect(fake.calls.some(call => call.name === 'initialize')).toBe(false);
  expect(verify).not.toHaveBeenCalled();
  rendered.stdin.write('\r');
  await settle();
  expect(fake.calls.some(call => call.name === 'initialize')).toBe(false);
  expect(ready).not.toHaveBeenCalled();
  rendered.stdin.write('\r');
  rendered.stdin.write('\r');
  await settle();
  expect(fake.calls.filter(call => call.name === 'initialize')).toHaveLength(1);
  expect(ready).toHaveBeenCalledWith(DEFAULT_PROPOSAL.coordinationScopeId);
});
