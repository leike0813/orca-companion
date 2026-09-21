/**
 * IP-8 行为测试：Recovery Capsule 必须由受限 Utility Worker 生成且按角色门判定
 * （change: `m1-recover-execution`）。
 *
 * 覆盖 Requirement「Recovery Capsule 必须由受限 Utility Worker 生成且按角色门判定」的五个
 * Scenario：complete Capsule；partial Capsule 列全六个字段；transcript 不可用时
 * `transcript_unavailable` 失败并阻塞；同一 Recovery Operation 内单次安全重派仍失败即失败；
 * Finalizer 不需要 Capsule。另覆盖 Utility Worker 报告的边界解析。
 */

import { afterEach, expect, test } from 'vitest';

import {
  RECOVERY_WORKER_TASK,
  RECOVERY_WORK_PACKAGE,
  createRecoveryHarness,
  type RecoveryHarness,
} from '../support/recovery-harness.js';
import type { DispatchId, SessionSegmentId } from '../../src/application/dto/identity.js';
import type { TerminalLivenessFacts } from '../../src/domain/worker-liveness.js';
import { evaluateRoleGate, roleGateRequiresCapsule } from '../../src/domain/recovery/role-gate.js';
import {
  capsuleRefOf,
  extractRecoveryCapsule,
  validateRecoveryCapsule,
  type CapsuleExtractionOutcome,
  type RecoveryCapsule,
} from '../../src/application/recovery/recovery-capsule.js';
import { recoverWorkerSession } from '../../src/application/recovery/worker-session-recovery-service.js';
import {
  buildUtilityWorkerEnvelope,
  parseRecoveryCapsuleReport,
} from '../../src/adapters/agents/utility-worker.js';

const ORCA_TASK = 'orca-task-recovery';
const SOURCE_DISPATCH = 'dispatch-source-1' as DispatchId;
const SOURCE_SEGMENT = 'segment-source-1' as SessionSegmentId;
const SOURCE_BINDING = 'binding-source-1';

const COMPLETE: RecoveryCapsule = {
  coverage: 'complete',
  readableRange: { transcriptRef: 'transcript:source-1', fromEventRef: 'ev:1', toEventRef: 'ev:9' },
  gaps: [],
  lastCompleteEventRef: 'ev:9',
  openActions: [],
  sourceRefs: ['ev:9'],
  unknowns: [],
};

const PARTIAL: RecoveryCapsule = {
  coverage: 'partial',
  readableRange: { transcriptRef: 'transcript:source-1', fromEventRef: 'ev:1', toEventRef: 'ev:5' },
  gaps: [{ fromEventRef: 'ev:6', toEventRef: 'ev:9', reason: 'transcript 被截断' }],
  lastCompleteEventRef: 'ev:5',
  openActions: [{ actionRef: 'action:1', description: '验证命令尚未收尾', sourceRef: 'ev:5' }],
  sourceRefs: ['ev:1', 'ev:5'],
  unknowns: ['ev:6 之后的改动是否落盘'],
};

const COMPLETE_EVIDENCE = {
  coverage: COMPLETE.coverage,
  readableRange: COMPLETE.readableRange,
  gaps: COMPLETE.gaps,
  lastCompleteEventRef: COMPLETE.lastCompleteEventRef,
} as const;

const PARTIAL_EVIDENCE = {
  coverage: PARTIAL.coverage,
  readableRange: PARTIAL.readableRange,
  gaps: PARTIAL.gaps,
  lastCompleteEventRef: PARTIAL.lastCompleteEventRef,
} as const;

let harness: RecoveryHarness | null = null;

afterEach(() => {
  harness?.close();
  harness = null;
});

function exitedFacts(dispatchId: DispatchId): TerminalLivenessFacts {
  return {
    dispatchId,
    workerRunning: false,
    terminalHandle: 'terminal-1',
    host: { kind: 'enumerated', terminalHandles: [] },
  };
}

function segment(overrides: { readonly transcriptReferenceable?: boolean; readonly lastTranscriptRef?: string | null } = {}) {
  return {
    segmentId: SOURCE_SEGMENT,
    dispatchId: SOURCE_DISPATCH,
    attemptId: 'attempt-1',
    sessionBindingId: SOURCE_BINDING,
    ...(overrides.lastTranscriptRef === undefined ? {} : { lastTranscriptRef: overrides.lastTranscriptRef }),
    ...(overrides.transcriptReferenceable === undefined
      ? {}
      : { transcriptReferenceable: overrides.transcriptReferenceable }),
  };
}

function inputFor(
  h: RecoveryHarness,
  overrides: Partial<Parameters<RecoveryHarness['input']>[0]> = {},
): ReturnType<RecoveryHarness['input']> {
  return h.input({
    sourceSegmentId: SOURCE_SEGMENT,
    sourceDispatchId: SOURCE_DISPATCH,
    observation: {
      sessionBindingId: SOURCE_BINDING,
      providerSessionId: 'provider-session-1',
      identityChanged: false,
    },
    liveness: exitedFacts(SOURCE_DISPATCH),
    ...overrides,
  });
}

function setup(h: RecoveryHarness, overrides: { readonly transcriptReferenceable?: boolean; readonly lastTranscriptRef?: string | null } = {}): void {
  h.recordSourceSegment(segment(overrides));
  h.recordMaterializationBinding(RECOVERY_WORK_PACKAGE, ORCA_TASK);
}

test('完整读取 transcript 时生成 complete Capsule，并在替代派发前写入 Capsule 引用', async () => {
  harness = createRecoveryHarness();
  setup(harness);
  const requests: string[] = [];

  const result = await recoverWorkerSession(
    inputFor(harness, {
      extractCapsule: (request): Promise<CapsuleExtractionOutcome> => {
        requests.push(request.transcriptRef);
        return Promise.resolve({ kind: 'extracted', capsule: COMPLETE });
      },
    }),
  );

  expect(result.kind).toBe('alternate_created');
  expect(requests).toEqual(['transcript:source-1']);
  if (result.kind === 'alternate_created') {
    expect(harness.recovery(result.recoveryId)?.capsuleRef).toBe(capsuleRefOf(result.recoveryId));
  }
});

test('partial Capsule 必须列出六个结论字段，并据此继续仅当角色门通过', async () => {
  harness = createRecoveryHarness();
  setup(harness);

  const result = await recoverWorkerSession(
    inputFor(harness, {
      extractCapsule: () => Promise.resolve({ kind: 'extracted', capsule: PARTIAL }),
    }),
  );

  expect(result.kind).toBe('alternate_created');
  // 六个结论字段都在。
  expect(Object.keys(PARTIAL)).toEqual(
    expect.arrayContaining([
      'readableRange',
      'gaps',
      'lastCompleteEventRef',
      'openActions',
      'sourceRefs',
      'unknowns',
    ]),
  );
  expect(PARTIAL.gaps.length).toBeGreaterThan(0);
  expect(validateRecoveryCapsule(PARTIAL).ok).toBe(true);
  if (result.kind === 'alternate_created') {
    expect(harness.recovery(result.recoveryId)?.capsuleRef).toBe(capsuleRefOf(result.recoveryId));
  }
});

test('transcript 不可用时以 transcript_unavailable 失败并阻塞，不猜测上下文', async () => {
  harness = createRecoveryHarness();
  setup(harness, { transcriptReferenceable: false, lastTranscriptRef: null });
  let extractCalls = 0;

  const result = await recoverWorkerSession(
    inputFor(harness, {
      extractCapsule: () => {
        extractCalls += 1;
        return Promise.resolve({ kind: 'extracted', capsule: COMPLETE });
      },
    }),
  );

  expect(result.kind).toBe('blocked');
  if (result.kind === 'blocked') {
    expect(result.code).toBe('transcript_unavailable');
  }
  // transcript 已不可引用：不派发 Utility Worker，也不替代派发。
  expect(extractCalls).toBe(0);
  expect(harness.backend.mutations()).toEqual([]);
  const row = harness.recoveries()[0];
  expect(row?.status).toBe('blocked');
  expect(row?.terminalOutcome).toBe('failed');
  expect(row?.capsuleRef).toBeNull();
});

test('同一个 Recovery Operation 内最多安全重派一次，再次失败则该 Recovery 失败且不递归', async () => {
  harness = createRecoveryHarness();
  setup(harness);
  let extractCalls = 0;

  const result = await recoverWorkerSession(
    inputFor(harness, {
      extractCapsule: () => {
        extractCalls += 1;
        return Promise.resolve({ kind: 'failed', reason: 'Utility Worker 无法读取 transcript' });
      },
    }),
  );

  expect(result.kind).toBe('blocked');
  if (result.kind === 'blocked') {
    expect(result.code).toBe('capsule_failed');
  }
  // 首次 + 一次安全重派，共两次；没有第三个 Recovery，也没有第二次替代派发。
  expect(extractCalls).toBe(2);
  expect(harness.recoveries()).toHaveLength(1);
  expect(harness.backend.mutations()).toEqual([]);
});

test('extractRecoveryCapsule 对 transcript 不可用立即返回，不重派', async () => {
  let calls = 0;
  const outcome = await extractRecoveryCapsule({
    extract: () => {
      calls += 1;
      return Promise.resolve({ kind: 'transcript_unavailable', reason: 'segment 没有 transcript' });
    },
    request: {
      coordinationScopeId: 'scope' as never,
      role: 'validator',
      workPackageId: 'wp-1',
      workerTaskId: RECOVERY_WORKER_TASK,
      attemptId: 'attempt-1',
      segmentId: SOURCE_SEGMENT,
      transcriptRef: 'transcript:source-1',
    },
  });
  expect(outcome.kind).toBe('transcript_unavailable');
  expect(calls).toBe(1);
});

test('Finalizer 的恢复不需要 Capsule，从权威输入重跑只读检查', async () => {
  harness = createRecoveryHarness({ role: 'finalizer' });
  harness.recordSourceSegment({
    segmentId: SOURCE_SEGMENT,
    dispatchId: SOURCE_DISPATCH,
    attemptId: 'attempt-1',
    sessionBindingId: SOURCE_BINDING,
  });
  harness.recordMaterializationBinding(RECOVERY_WORK_PACKAGE, ORCA_TASK);
  let extractCalls = 0;

  const result = await recoverWorkerSession(
    inputFor(harness, {
      role: 'finalizer',
      roleGate: { role: 'finalizer', finalizer: { authoritativeInputs: ['graph:1', 'authorization:auth-recovery'] } },
      extractCapsule: () => {
        extractCalls += 1;
        return Promise.resolve({ kind: 'failed', reason: 'Finalizer 不应请求 Capsule' });
      },
    }),
  );

  expect(result.kind).toBe('alternate_created');
  expect(extractCalls).toBe(0);
  expect(roleGateRequiresCapsule('finalizer')).toBe(false);
  expect(roleGateRequiresCapsule('validator')).toBe(true);
  if (result.kind === 'alternate_created') {
    expect(harness.recovery(result.recoveryId)?.capsuleRef).toBeNull();
  }
});

test('角色门按各自事实分叉：隐藏决定与未重新验证的证据都会阻塞', () => {
  expect(
    evaluateRoleGate({ role: 'planner', planner: { specificationUnitLanded: true, hiddenDecisions: ['选了方案 B'] } })
      .kind,
  ).toBe('blocked');
  expect(
    evaluateRoleGate({
      role: 'implementation',
      implementation: {
        workspaceReconciled: true,
        headReconciled: true,
        dirtyPathsReconciled: true,
        unknownExternalEffects: ['未对账的 push'],
      },
    }).kind,
  ).toBe('blocked');
  const validatorBlocked = evaluateRoleGate({
    role: 'validator',
    validator: {
      identifiedGaps: ['实现与规格不一致'],
      invalidatedEvidenceIds: ['evidence-1'],
      reverifiedEvidenceIds: [],
    },
  });
  expect(validatorBlocked.kind).toBe('blocked');
  expect(
    evaluateRoleGate({
      role: 'validator',
      validator: {
        identifiedGaps: ['实现与规格不一致'],
        invalidatedEvidenceIds: ['evidence-1'],
        reverifiedEvidenceIds: ['evidence-1'],
      },
    }).kind,
  ).toBe('admitted');
  expect(
    evaluateRoleGate({ role: 'finalizer', finalizer: { authoritativeInputs: ['graph:1'] } }).kind,
  ).toBe('admitted');
});

test('Utility Worker 报告在边界被严格解析，partial 缺缺口即拒绝', () => {
  const envelope = buildUtilityWorkerEnvelope({
    workPackageId: RECOVERY_WORK_PACKAGE,
    sourceWorkerTaskId: RECOVERY_WORKER_TASK,
    sourceSegmentId: SOURCE_SEGMENT,
    transcriptRef: 'transcript:source-1',
  });
  expect(envelope.authority).toEqual({ write: false, dispatch: false, git: false });

  const complete = parseRecoveryCapsuleReport(COMPLETE, COMPLETE_EVIDENCE);
  expect(complete.ok).toBe(true);
  const partial = parseRecoveryCapsuleReport(PARTIAL, PARTIAL_EVIDENCE);
  expect(partial.ok).toBe(true);
  if (partial.ok) {
    expect(partial.capsule.unknowns).toEqual(PARTIAL.unknowns);
  }
  expect(parseRecoveryCapsuleReport({ ...PARTIAL, gaps: [] }, PARTIAL_EVIDENCE).ok).toBe(false);
  expect(parseRecoveryCapsuleReport({ ...PARTIAL, coverage: 'unknown' }, PARTIAL_EVIDENCE).ok).toBe(false);
  expect(parseRecoveryCapsuleReport(PARTIAL, COMPLETE_EVIDENCE).ok).toBe(false);
});
