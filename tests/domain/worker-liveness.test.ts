/**
 * Worker 存活、终态核验与 Session Segment 前置事实测试
 * （change: `m1-admit-work-package-specifications`，Owner: IP-A5）。
 *
 * 覆盖 Requirement「Worker 存活与终态必须可核验」与「会话中断只形成 Session Segment 前置事实」：
 * - 主机未列举、明确退出、存活、终态身份不匹配四种事实；
 * - unverifiable 不触发重复派发；
 * - 中断只记录 Segment 边界，不生成 Capsule、不创建替代 segment、不记录 Recovery Budget。
 */

import { expect, test } from 'vitest';

import type { DispatchId, WorkerTaskId } from '../../src/application/dto/identity.js';
import {
  decideLiveness,
  recordSessionSegment,
  sessionSegmentCarriesRecoveryBudget,
  verifyTerminalReceipt,
} from '../../src/domain/worker-liveness.js';

const TASK = 'task-1' as WorkerTaskId;
const DISPATCH = 'dispatch-1' as DispatchId;

test('信息不完整时判为 unverifiable，且不触发重新派发', () => {
  const notEnumerated = decideLiveness({
    dispatchId: DISPATCH,
    workerRunning: false,
    terminalHandle: 'term-1',
    host: { kind: 'not-enumerated' },
  });
  const unavailable = decideLiveness({
    dispatchId: DISPATCH,
    workerRunning: false,
    terminalHandle: 'term-1',
    host: { kind: 'unavailable', reason: 'host list 暂时不可达' },
  });
  const missingHandle = decideLiveness({
    dispatchId: DISPATCH,
    workerRunning: false,
    terminalHandle: null,
    host: { kind: 'enumerated', terminalHandles: ['term-1'] },
  });

  expect(notEnumerated.liveness).toBe('unverifiable');
  expect(unavailable.liveness).toBe('unverifiable');
  expect(missingHandle.liveness).toBe('unverifiable');
});

test('宿主报告存活时为 live，主机已列举且不含该终端时为 exited', () => {
  const live = decideLiveness({
    dispatchId: DISPATCH,
    workerRunning: true,
    terminalHandle: 'term-1',
    host: { kind: 'not-enumerated' },
  });
  const exited = decideLiveness({
    dispatchId: DISPATCH,
    workerRunning: false,
    terminalHandle: 'term-1',
    host: { kind: 'enumerated', terminalHandles: ['term-2'] },
  });
  const stillPresent = decideLiveness({
    dispatchId: DISPATCH,
    workerRunning: false,
    terminalHandle: 'term-1',
    host: { kind: 'enumerated', terminalHandles: ['term-1'] },
  });

  expect(live.liveness).toBe('live');
  expect(exited.liveness).toBe('exited');
  // 终端还在不等于 worker 还在运行，也不等于已退出：只能是 unverifiable。
  expect(stillPresent.liveness).toBe('unverifiable');
});

function receipt(overrides: Record<string, string> = {}) {
  return {
    workerTaskId: TASK,
    dispatchId: DISPATCH,
    attemptId: 'attempt-1',
    role: 'implementation' as const,
    sessionBindingId: 'binding-1',
    ...overrides,
  };
}

function expected(overrides: Record<string, string | null> = {}) {
  return {
    workerTaskId: TASK,
    dispatchId: DISPATCH,
    attemptId: 'attempt-1',
    role: 'implementation' as const,
    sessionBindingId: 'binding-1' as string | null,
    ...overrides,
  };
}

test('终态收据的归属逐项匹配才可结算', () => {
  const matched = verifyTerminalReceipt({
    workerTaskId: TASK,
    dispatchId: DISPATCH,
    receipt: receipt(),
    expected: expected(),
  });
  expect(matched.kind).toBe('settleable');

  const wrongAttempt = verifyTerminalReceipt({
    workerTaskId: TASK,
    dispatchId: DISPATCH,
    receipt: receipt({ attemptId: 'attempt-2' }),
    expected: expected(),
  });
  const wrongRole = verifyTerminalReceipt({
    workerTaskId: TASK,
    dispatchId: DISPATCH,
    receipt: receipt({ role: 'validator' }),
    expected: expected(),
  });
  const noBinding = verifyTerminalReceipt({
    workerTaskId: TASK,
    dispatchId: DISPATCH,
    receipt: receipt(),
    expected: expected({ sessionBindingId: null }),
  });

  expect(wrongAttempt.kind).toBe('unverifiable');
  expect(wrongRole.kind).toBe('unverifiable');
  expect(noBinding.kind).toBe('unverifiable');
  if (wrongAttempt.kind === 'unverifiable') {
    expect(wrongAttempt.mismatch).toContain('attemptId');
  }
  if (wrongRole.kind === 'unverifiable') {
    expect(wrongRole.mismatch).toContain('role');
  }
});

test('会话中断只记录 Segment 边界，不触发任何恢复动作', () => {
  const result = recordSessionSegment({
    role: 'implementation',
    workerTaskId: TASK,
    dispatchId: DISPATCH,
    attemptId: 'attempt-1',
    sessionBindingId: 'binding-1',
    lastTranscriptRef: 'transcript:12',
    terminalReceiptRef: 'receipt:1',
    terminalVerdict: { kind: 'settleable', workerTaskId: TASK, dispatchId: DISPATCH },
    recordedAt: 1_000,
  });

  expect(result.kind).toBe('segment-recorded');
  if (result.kind !== 'segment-recorded') {
    return;
  }
  expect(result.segment.role).toBe('implementation');
  expect(result.segment.workerTaskId).toBe(TASK);
  expect(result.segment.dispatchId).toBe(DISPATCH);
  expect(result.segment.attemptId).toBe('attempt-1');
  expect(result.segment.sessionBindingId).toBe('binding-1');
  expect(result.segment.lastTranscriptRef).toBe('transcript:12');
  expect(result.segment.transcriptReferenceable).toBe(true);
  expect(sessionSegmentCarriesRecoveryBudget(result.segment)).toBe(false);
  // 不生成 Capsule、不创建替代 segment：Segment 里没有这些字段。
  expect(Object.hasOwn(result.segment, 'capsuleRef')).toBe(false);
  expect(Object.hasOwn(result.segment, 'replacementSegmentId')).toBe(false);
});

test('会话身份或 transcript 不可引用时只形成 blocker，不伪装继续原 session', () => {
  const noBinding = recordSessionSegment({
    role: 'validator',
    workerTaskId: TASK,
    dispatchId: DISPATCH,
    attemptId: 'attempt-1',
    sessionBindingId: null,
    lastTranscriptRef: 'transcript:12',
    terminalReceiptRef: null,
    terminalVerdict: { kind: 'unverifiable', mismatch: ['sessionBindingId'] },
    recordedAt: 1_000,
  });
  const noTranscript = recordSessionSegment({
    role: 'validator',
    workerTaskId: TASK,
    dispatchId: DISPATCH,
    attemptId: 'attempt-1',
    sessionBindingId: 'binding-1',
    lastTranscriptRef: null,
    terminalReceiptRef: 'receipt:1',
    terminalVerdict: { kind: 'settleable', workerTaskId: TASK, dispatchId: DISPATCH },
    recordedAt: 1_000,
  });

  expect(noBinding.kind).toBe('blocked');
  expect(noTranscript.kind).toBe('blocked');
  if (noBinding.kind === 'blocked') {
    expect(noBinding.segment.transcriptReferenceable).toBe(false);
    expect(noBinding.segment.sessionBindingId).toBe('');
  }
  if (noTranscript.kind === 'blocked') {
    expect(noTranscript.segment.transcriptReferenceable).toBe(false);
    expect(noTranscript.segment.sessionBindingId).toBe('binding-1');
    expect(sessionSegmentCarriesRecoveryBudget(noTranscript.segment)).toBe(false);
  }
});
