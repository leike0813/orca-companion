import { createElement } from 'react';
import { expect, test } from 'vitest';

import { StatusLine, formatContextStatus } from '../../src/interfaces/tui/components/status-line.js';
import type { StatusLineProps } from '../../src/interfaces/tui/components/status-line.js';
import type { ProjectContextStatus } from '../../src/application/tui/project-presentation.js';
import { renderComponent, settle } from './harness.js';

const baseProps: StatusLineProps = {
  scope: {
    coordinationScopeId: 'scope-1', revision: 3, mode: 'route_planning', controlState: 'active',
    planningCycleId: 'cycle-1', mapRevision: 1, authorization: null, executionLeaseHolderSessionId: null,
  },
  compaction: null,
  maintenance: null,
  blockerCount: 0,
  notice: null,
  sidebarDensity: 'full',
  availableWidth: 120,
  execution: null,
};

const lastRequest = (overrides: Partial<Extract<ProjectContextStatus, { status: 'last_request' }>> = {}): ProjectContextStatus => ({
  status: 'last_request', inputTokens: 12_000, outputTokens: 320, totalTokens: 12_320, capacity: 200_000,
  coordinatorSessionId: 'session-a', modelConfigurationRef: 'config-a', stepId: 'step-1', ...overrides,
});

test('last request usage is labelled as history and never shown as a current percentage of an unknown window', () => {
  expect(formatContextStatus(lastRequest(), 'used')).toContain('上次请求');
  expect(formatContextStatus(lastRequest(), 'used')).toContain('输出 320');
  expect(formatContextStatus(lastRequest({ capacity: null }), 'used')).toContain('窗口未知');
  expect(formatContextStatus(lastRequest({ capacity: null }), 'used')).toContain('输入 12000');
  expect(formatContextStatus({ status: 'unavailable' }, 'used')).toBe('上下文 不可用');
});

test('the status line shows the real turn state without dropping model, effort and context', async () => {
  const presentation = {
    identity: { repository: 'repo', fullBranchRef: 'refs/heads/main' },
    session: { id: 'session-a', model: 'model-a', provider: 'provider-a', effort: { status: 'configured' as const, value: 'high' } },
    ticket: null,
    activeWorkPackages: [],
    context: lastRequest(),
    acceptance: null,
    budgets: { workPackages: null, implementationAttempts: null, recovery: null },
  };
  const rendered = renderComponent(createElement(StatusLine, { ...baseProps, presentation }));
  try {
    await settle(2);
    expect(rendered.lastFrame()).toContain('model-a');
    expect(rendered.lastFrame()).toContain('上次请求');
    expect(rendered.lastFrame()).not.toContain('运行中');
  } finally {
    rendered.unmount();
  }

  const running = renderComponent(createElement(StatusLine, {
    ...baseProps, presentation, turn: { kind: 'running' },
  }));
  try {
    await settle(2);
    expect(running.lastFrame()).toContain('运行中');
  } finally {
    running.unmount();
  }

  const halted = renderComponent(createElement(StatusLine, {
    ...baseProps, presentation, turn: { kind: 'halted', failure: { code: 'stopped', message: '用户停止' } },
  }));
  try {
    await settle(2);
    expect(halted.lastFrame()).toContain('轮次 已停止');
  } finally {
    halted.unmount();
  }
});

test('窄屏时轮次标记仍然可见，代价是核心字段收缩', async () => {
  const presentation = {
    identity: { repository: 'repo', fullBranchRef: 'refs/heads/main' },
    session: { id: 'session-a', model: 'model-with-a-long-name', provider: 'provider-a', effort: { status: 'configured' as const, value: 'high' } },
    ticket: null,
    activeWorkPackages: [],
    context: lastRequest(),
    acceptance: null,
    budgets: { workPackages: null, implementationAttempts: null, recovery: null },
  };
  const narrow = renderComponent(createElement(StatusLine, {
    ...baseProps, availableWidth: 50, presentation, turn: { kind: 'running' },
  }));
  try {
    await settle(2);
    expect(narrow.lastFrame()).toContain('运行中');
  } finally {
    narrow.unmount();
  }
});
