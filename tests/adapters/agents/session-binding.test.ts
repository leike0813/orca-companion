/**
 * Codex Session Binding 测试
 * （change: `m1-admit-work-package-specifications`，Owner: IP-A5）。
 *
 * 覆盖 Requirement「Dispatch 与真实 harness session 精确绑定」的全部 Scenario：
 * - 四个主要角色各自记录角色、session 身份与 transcript 引用；
 * - 缺 session 身份、缺 transcript 引用、身份变更或观察时间窗缺失时判为不可用并阻塞；
 * - 绑定不按 worktree、mtime 或终端输出推断。
 */

import { expect, test } from 'vitest';

import type { DispatchId, WorkerTaskId } from '../../../src/application/dto/identity.js';
import {
  CODEX_HARNESS_ID,
  SESSION_BOUND_ROLES,
  bindCodexSession,
  roleRequiresSessionBinding,
  type HarnessSessionFacts,
} from '../../../src/adapters/agents/session-binding.js';
import { WORKER_ROLES, type WorkerRole } from '../../../src/domain/planning/execution-authorization.js';

function facts(overrides: Partial<HarnessSessionFacts> = {}): HarnessSessionFacts {
  return {
    harness: CODEX_HARNESS_ID,
    role: 'implementation',
    workerTaskId: 'task-1' as WorkerTaskId,
    dispatchId: 'dispatch-1' as DispatchId,
    attemptId: 'attempt-1',
    providerSessionId: 'session-abc',
    transcriptRef: 'transcript:session-abc',
    observedAt: '2026-09-21T00:00:00Z',
    ...overrides,
  };
}

test('四个主要角色都要求精确绑定', () => {
  expect([...SESSION_BOUND_ROLES].sort()).toEqual([...WORKER_ROLES].sort());
  for (const role of WORKER_ROLES) {
    expect(roleRequiresSessionBinding(role)).toBe(true);
  }
});

test('四个主要角色各自记录角色、session 与 transcript 引用', () => {
  for (const role of WORKER_ROLES) {
    const result = bindCodexSession(
      facts({ role, transcriptRef: `transcript:${role}`, providerSessionId: `session-${role}` }),
    );
    expect(result.kind).toBe('bound');
    if (result.kind !== 'bound') {
      continue;
    }
    expect(result.binding.role).toBe(role);
    expect(result.binding.harness).toBe(CODEX_HARNESS_ID);
    expect(result.binding.providerSessionId).toBe(`session-${role}`);
    expect(result.binding.transcriptRef).toBe(`transcript:${role}`);
    expect(result.binding.workerTaskId).toBe('task-1');
    expect(result.binding.dispatchId).toBe('dispatch-1');
    expect(result.binding.attemptId).toBe('attempt-1');
    expect(result.binding.observedAt).toBe('2026-09-21T00:00:00Z');
  }
});

test('缺 session 身份或 transcript 引用时判为不可用并阻塞', () => {
  const noSession = bindCodexSession(facts({ providerSessionId: null }));
  const emptySession = bindCodexSession(facts({ providerSessionId: '' }));
  const noTranscript = bindCodexSession(facts({ transcriptRef: null }));
  const noWindow = bindCodexSession(facts({ observedAt: null }));
  const wrongHarness = bindCodexSession(facts({ harness: 'other-harness' }));

  expect(noSession.kind).toBe('unavailable');
  expect(emptySession.kind).toBe('unavailable');
  expect(noTranscript.kind).toBe('unavailable');
  expect(noWindow.kind).toBe('unavailable');
  expect(wrongHarness.kind).toBe('unavailable');
  for (const result of [noSession, emptySession, noTranscript, noWindow, wrongHarness]) {
    if (result.kind === 'unavailable') {
      expect(result.blocksDispatch).toBe(true);
    }
  }
  if (noSession.kind === 'unavailable') {
    expect(noSession.code).toBe('session_not_reported');
  }
  if (noTranscript.kind === 'unavailable') {
    expect(noTranscript.code).toBe('transcript_not_reported');
  }
});

test('worker 身份变更时判为不可用，不把新身份当作原 session 继续', () => {
  const result = bindCodexSession(facts(), { identityChanged: true });

  expect(result.kind).toBe('unavailable');
  if (result.kind === 'unavailable') {
    expect(result.code).toBe('worker_identity_changed');
    expect(result.blocksDispatch).toBe(true);
  }
});

test('绑定只接受 harness 报告的事实，不携带推断来源', () => {
  const result = bindCodexSession(facts());

  expect(result.kind).toBe('bound');
  if (result.kind !== 'bound') {
    return;
  }
  const keys = Object.keys(result.binding);
  expect(keys).not.toContain('cwd');
  expect(keys).not.toContain('worktreePath');
  expect(keys).not.toContain('mtime');
  expect(keys).not.toContain('terminalHandle');
  expect(keys).not.toContain('lastTranscript');
});

test('每个角色都需要自己的绑定，绑定不跨角色复用', () => {
  const planner = bindCodexSession(facts({ role: 'planner' as WorkerRole }));
  const implementation = bindCodexSession(facts({ role: 'implementation' as WorkerRole }));

  expect(planner.kind).toBe('bound');
  expect(implementation.kind).toBe('bound');
  if (planner.kind === 'bound' && implementation.kind === 'bound') {
    expect(planner.binding.role).not.toBe(implementation.binding.role);
  }
});
