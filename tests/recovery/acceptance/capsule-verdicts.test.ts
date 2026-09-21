/**
 * 6.2 验收层：Recovery Capsule 的结论形态与角色门
 * （change: `m1-recover-execution`；spec `recovery/worker-sessions` 的
 * 「Recovery Capsule 必须由受限 Utility Worker 生成且按角色门判定」）。
 *
 * 这里补的是**结论形态 × 角色门**的组合，不是重复既有单测：
 *
 * - `partial` 缺口决定角色门：同一份 partial Capsule 在四个角色上分别按各自缺口事实放行或阻塞；
 *   四个角色共用同一 Capsule 合同，只在准入条件上分叉。
 * - `partial` 必须列全六项（精确可读范围、缺口、最后一个完整事件、未闭合动作、逐项来源、unknowns）：
 *   缺任何一项都在边界被拒绝，Recovery 阻塞且零副作用（限定审计标签
 *   `gate.partial-capsule-declares-gaps`）；`complete` 声明缺口同样必须被拒绝。
 * - 三种失败结论（transcript 不可用 / Capsule 失败 / 角色门阻塞）都发生在**预写派发 Intent 之前**：
 *   失败不会留下悬空意图，派发 lane 因此不会被永久阻塞。
 *
 * complete Capsule 的成功路径、transcript 不可用的单点断言、同一 Recovery Operation 内单次安全重派
 * 与 Finalizer 不需要 Capsule 已由 `tests/recovery/recovery-capsule.test.ts` 覆盖，这里不重复。
 */

import { afterEach, expect, test } from 'vitest';

import type { DispatchId, RecoveryId, SessionSegmentId } from '../../../src/application/dto/identity.js';
import {
  deriveRecoveryId,
  deriveReplacementOperationId,
  recoverWorkerSession,
  type RecoverWorkerSessionInput,
} from '../../../src/application/recovery/worker-session-recovery-service.js';
import {
  type CapsuleExtractionOutcome,
  type RecoveryCapsule,
  type TranscriptCoverageEvidence,
} from '../../../src/application/recovery/recovery-capsule.js';
import { parseRecoveryCapsuleReport } from '../../../src/adapters/agents/utility-worker.js';
import { WORKER_ROLES, type WorkerRole } from '../../../src/domain/planning/execution-authorization.js';
import type { RoleGateFacts } from '../../../src/domain/recovery/role-gate.js';
import { roleGateRequiresCapsule } from '../../../src/domain/recovery/role-gate.js';
import type { TerminalLivenessFacts } from '../../../src/domain/worker-liveness.js';
import {
  RECOVERY_SCOPE,
  RECOVERY_WORK_PACKAGE,
  createRecoveryHarness,
  roleGateFactsFor,
  type RecoveryHarness,
} from '../../support/recovery-harness.js';

const ORCA_TASK = 'orca-task-recovery';

const PARTIAL: RecoveryCapsule = {
  coverage: 'partial',
  readableRange: { transcriptRef: 'transcript:source-1', fromEventRef: 'ev:1', toEventRef: 'ev:5' },
  gaps: [{ fromEventRef: 'ev:6', toEventRef: 'ev:9', reason: 'transcript 被截断' }],
  lastCompleteEventRef: 'ev:5',
  openActions: [{ actionRef: 'action:1', description: '验证命令尚未收尾', sourceRef: 'ev:5' }],
  sourceRefs: ['ev:1', 'ev:5'],
  unknowns: ['ev:6 之后的改动是否落盘'],
};

const COMPLETE: RecoveryCapsule = {
  coverage: 'complete',
  readableRange: { transcriptRef: 'transcript:source-1', fromEventRef: 'ev:1', toEventRef: 'ev:9' },
  gaps: [],
  lastCompleteEventRef: 'ev:9',
  openActions: [],
  sourceRefs: ['ev:9'],
  unknowns: [],
};

const PARTIAL_EVIDENCE: TranscriptCoverageEvidence = {
  coverage: PARTIAL.coverage,
  readableRange: PARTIAL.readableRange,
  gaps: PARTIAL.gaps,
  lastCompleteEventRef: PARTIAL.lastCompleteEventRef,
};

const COMPLETE_EVIDENCE: TranscriptCoverageEvidence = {
  coverage: COMPLETE.coverage,
  readableRange: COMPLETE.readableRange,
  gaps: COMPLETE.gaps,
  lastCompleteEventRef: COMPLETE.lastCompleteEventRef,
};

/** 六项结论字段：partial 缺任一都必须在边界被拒绝。 */
const CAPSULE_CONCLUSION_FIELDS: readonly string[] = [
  'readableRange',
  'gaps',
  'lastCompleteEventRef',
  'openActions',
  'sourceRefs',
  'unknowns',
];

let harness: RecoveryHarness | null = null;

afterEach(() => {
  harness?.close();
  harness = null;
});

function exitedFacts(dispatchId: string): TerminalLivenessFacts {
  return {
    dispatchId: dispatchId as DispatchId,
    workerRunning: false,
    terminalHandle: 'terminal-1',
    host: { kind: 'enumerated', terminalHandles: [] },
  };
}

/** 各角色因「缺口」而阻塞的角色门事实：每个角色用自己那条不可回避的缺口。 */
function blockedByGap(role: WorkerRole): RoleGateFacts {
  switch (role) {
    case 'planner':
      return {
        role: 'planner',
        planner: { specificationUnitLanded: true, hiddenDecisions: ['缺口内尚未显式化的决定'] },
      };
    case 'implementation':
      return {
        role: 'implementation',
        implementation: {
          workspaceReconciled: true,
          headReconciled: true,
          dirtyPathsReconciled: true,
          unknownExternalEffects: ['缺口之后存在未对账的外部副作用'],
        },
      };
    case 'validator':
      return {
        role: 'validator',
        validator: {
          identifiedGaps: ['缺口内实现与规格不一致'],
          invalidatedEvidenceIds: ['evidence-1'],
          reverifiedEvidenceIds: [],
        },
      };
    case 'finalizer':
      return { role: 'finalizer', finalizer: { authoritativeInputs: [] } };
  }
}

type Setup = {
  readonly segmentId: string;
  readonly dispatchId: string;
  readonly binding: string;
};

function setup(created: RecoveryHarness, input: Setup, role?: WorkerRole): void {
  created.recordSourceSegment({
    segmentId: input.segmentId,
    dispatchId: input.dispatchId,
    attemptId: 'attempt-1',
    sessionBindingId: input.binding,
    ...(role === undefined ? {} : { role }),
  });
  created.recordMaterializationBinding(RECOVERY_WORK_PACKAGE, ORCA_TASK);
}

function inputFor(
  created: RecoveryHarness,
  input: Setup,
  overrides: Partial<Parameters<RecoveryHarness['input']>[0]> = {},
): RecoverWorkerSessionInput {
  return created.input({
    sourceSegmentId: input.segmentId as SessionSegmentId,
    sourceDispatchId: input.dispatchId as DispatchId,
    observation: {
      sessionBindingId: input.binding,
      providerSessionId: `provider:${input.segmentId}`,
      identityChanged: false,
    },
    liveness: exitedFacts(input.dispatchId),
    ...overrides,
  });
}

/** 把一份结构化报告当作受限 Utility Worker 的提取结果：解析失败时如实报告 `failed`。 */
function reportExtractor(
  report: unknown,
  evidence: TranscriptCoverageEvidence,
): () => Promise<CapsuleExtractionOutcome> {
  return () => {
    const parsed = parseRecoveryCapsuleReport(report, evidence);
    return Promise.resolve(
      parsed.ok
        ? { kind: 'extracted', capsule: parsed.capsule }
        : { kind: 'failed', reason: parsed.reason },
    );
  };
}

function capsuleOutcome(capsule: RecoveryCapsule): () => Promise<CapsuleExtractionOutcome> {
  return () => Promise.resolve({ kind: 'extracted', capsule });
}

function workerStarts(created: RecoveryHarness): number {
  return created.backend.mutations().filter((mutation) => mutation.operation === 'worker-start').length;
}

function hasPrewrittenDispatchIntent(created: RecoveryHarness, recoveryId: RecoveryId): boolean {
  const read = created.store.query({ kind: 'intents', coordinationScopeId: RECOVERY_SCOPE });
  if (read.kind !== 'intents') {
    throw new Error('无法读取 Operation Intent');
  }
  const operationId = deriveReplacementOperationId(recoveryId);
  return read.intents.some((intent) => intent.operationId === operationId);
}

test.each(WORKER_ROLES)(
  'partial Capsule 的缺口决定角色门：%s 仅在缺口满足该角色门时才继续',
  async (role) => {
    harness = createRecoveryHarness({ role });
    const blockedSegment: Setup = {
      segmentId: 'segment-gap-blocked-1',
      dispatchId: 'dispatch-gap-blocked-1',
      binding: 'binding-gap-blocked-1',
    };
    const admittedSegment: Setup = {
      segmentId: 'segment-gap-admitted-1',
      dispatchId: 'dispatch-gap-admitted-1',
      binding: 'binding-gap-admitted-1',
    };
    setup(harness, blockedSegment, role);
    setup(harness, admittedSegment, role);
    let capsuleCalls = 0;
    const extractWithCount = () => {
      capsuleCalls += 1;
      return Promise.resolve<CapsuleExtractionOutcome>({ kind: 'extracted', capsule: PARTIAL });
    };

    // 同一份 partial Capsule，角色门因缺口阻塞 => 不启动替代 Session。
    const blocked = await recoverWorkerSession(
      inputFor(harness, blockedSegment, {
        role,
        roleGate: blockedByGap(role),
        extractCapsule: extractWithCount,
      }),
    );
    expect(blocked.kind).toBe('blocked');
    if (blocked.kind === 'blocked') {
      expect(blocked.code).toBe('role_gate_blocked');
    }
    const blockedRow = harness.recovery(deriveRecoveryId(RECOVERY_SCOPE, blockedSegment.segmentId as SessionSegmentId));
    expect(blockedRow?.status).toBe('blocked');
    expect(blockedRow?.terminalOutcome).toBe('failed');
    expect(blockedRow?.replacementSegmentId).toBeNull();
    expect(blockedRow?.consumedBudget).toBe(0);
    expect(workerStarts(harness)).toBe(0);

    // 同一份 partial Capsule，缺口被该角色门接受 => 启动替代 Session。
    const admitted = await recoverWorkerSession(
      inputFor(harness, admittedSegment, {
        role,
        roleGate: roleGateFactsFor(role),
        extractCapsule: extractWithCount,
      }),
    );
    expect(admitted.kind).toBe('alternate_created');
    expect(workerStarts(harness)).toBe(1);
    // Capsule 只对需要它的角色发起；Finalizer 从权威输入重跑只读检查。
    expect(capsuleCalls).toBe(roleGateRequiresCapsule(role) ? 2 : 0);
    const admittedRow = harness.recovery(
      deriveRecoveryId(RECOVERY_SCOPE, admittedSegment.segmentId as SessionSegmentId),
    );
    expect(admittedRow?.consumedBudget).toBe(1);
  },
);

test.each(CAPSULE_CONCLUSION_FIELDS)(
  '[gate.partial-capsule-declares-gaps] partial Capsule 缺少 %s 时被边界拒绝，Recovery 阻塞且零副作用',
  async (field) => {
    harness = createRecoveryHarness();
    const segment: Setup = {
      segmentId: 'segment-partial-missing-field',
      dispatchId: 'dispatch-partial-missing-field',
      binding: 'binding-partial-missing-field',
    };
    setup(harness, segment);
    // 去掉一项结论字段：报告必须被边界拒绝，而不是降级成「字段缺失但可继续」。
    const report: Record<string, unknown> = { ...PARTIAL };
    delete report[field];
    expect(parseRecoveryCapsuleReport(report, PARTIAL_EVIDENCE).ok).toBe(false);

    let extractCalls = 0;
    const extract = reportExtractor(report, PARTIAL_EVIDENCE);
    const result = await recoverWorkerSession(
      inputFor(harness, segment, {
        extractCapsule: () => {
          extractCalls += 1;
          return extract();
        },
      }),
    );

    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.code).toBe('capsule_failed');
    }
    // 首次 + 同一 Recovery Operation 内一次安全重派；没有第三个 Recovery，也没有替代派发。
    expect(extractCalls).toBe(2);
    expect(workerStarts(harness)).toBe(0);
    expect(harness.recoveries()).toHaveLength(1);
    const row = harness.recoveries()[0];
    expect(row?.status).toBe('blocked');
    expect(row?.terminalOutcome).toBe('failed');
    expect(row?.consumedBudget).toBe(0);
    expect(harness.segments()).toHaveLength(1);
  },
);

test('complete Capsule 声明缺口时同样被拒绝：不得把不完整读取当成完整结论', async () => {
  harness = createRecoveryHarness();
  const segment: Setup = {
    segmentId: 'segment-complete-with-gaps',
    dispatchId: 'dispatch-complete-with-gaps',
    binding: 'binding-complete-with-gaps',
  };
  setup(harness, segment);
  const report: Record<string, unknown> = { ...PARTIAL, coverage: 'complete' };
  expect(parseRecoveryCapsuleReport(report, COMPLETE_EVIDENCE).ok).toBe(false);

  const result = await recoverWorkerSession(
    inputFor(harness, segment, { extractCapsule: reportExtractor(report, COMPLETE_EVIDENCE) }),
  );

  expect(result.kind).toBe('blocked');
  if (result.kind === 'blocked') {
    expect(result.code).toBe('capsule_failed');
  }
  expect(workerStarts(harness)).toBe(0);
  expect(harness.recoveries()[0]?.consumedBudget).toBe(0);
});

test('Utility Worker 不能自行声明 partial：Adapter 证据为 complete 时报告被拒绝，Recovery 阻塞且零派发', async () => {
  harness = createRecoveryHarness();
  const segment: Setup = {
    segmentId: 'segment-self-declared-partial',
    dispatchId: 'dispatch-self-declared-partial',
    binding: 'binding-self-declared-partial',
  };
  setup(harness, segment);

  // Adapter 的读取证据说这段 transcript 完整可读；Worker 却自报 partial 且带缺口。
  // 缺口必须由 Adapter 定位并声明，Worker 不能凭读到的正文自行把 Capsule 判成 partial。
  expect(parseRecoveryCapsuleReport(PARTIAL, COMPLETE_EVIDENCE).ok).toBe(false);

  const result = await recoverWorkerSession(
    inputFor(harness, segment, { extractCapsule: reportExtractor(PARTIAL, COMPLETE_EVIDENCE) }),
  );

  expect(result.kind).toBe('blocked');
  if (result.kind === 'blocked') {
    expect(result.code).toBe('capsule_failed');
  }
  expect(workerStarts(harness)).toBe(0);
  expect(harness.recoveries()).toHaveLength(1);
  expect(harness.recoveries()[0]?.consumedBudget).toBe(0);
  expect(harness.segments()).toHaveLength(1);
});

test('三种失败结论都发生在预写派发 Intent 之前：不留下悬空意图，派发 lane 不被永久阻塞', async () => {
  const transcriptMissing: Setup = {
    segmentId: 'segment-transcript-missing',
    dispatchId: 'dispatch-transcript-missing',
    binding: 'binding-transcript-missing',
  };
  const cases: readonly {
    readonly name: string;
    readonly segment: Setup;
    readonly expectedCode: string;
    readonly prepare: (created: RecoveryHarness, segment: Setup) => void;
    readonly input: Partial<Parameters<RecoveryHarness['input']>[0]>;
  }[] = [
    {
      name: 'transcript 不可用',
      segment: transcriptMissing,
      expectedCode: 'transcript_unavailable',
      prepare: (created, segment) => {
        created.recordSourceSegment({
          segmentId: segment.segmentId,
          dispatchId: segment.dispatchId,
          attemptId: 'attempt-1',
          sessionBindingId: segment.binding,
          lastTranscriptRef: null,
          transcriptReferenceable: false,
        });
        created.recordMaterializationBinding(RECOVERY_WORK_PACKAGE, ORCA_TASK);
      },
      input: { extractCapsule: capsuleOutcome(COMPLETE) },
    },
    {
      name: 'Capsule 提取失败',
      segment: {
        segmentId: 'segment-capsule-failed',
        dispatchId: 'dispatch-capsule-failed',
        binding: 'binding-capsule-failed',
      },
      expectedCode: 'capsule_failed',
      prepare: (created, segment) => setup(created, segment),
      input: {
        extractCapsule: () => Promise.resolve({ kind: 'failed' as const, reason: 'Utility Worker 不可用' }),
      },
    },
    {
      name: '角色门阻塞',
      segment: {
        segmentId: 'segment-gate-blocked',
        dispatchId: 'dispatch-gate-blocked',
        binding: 'binding-gate-blocked',
      },
      expectedCode: 'role_gate_blocked',
      prepare: (created, segment) => setup(created, segment),
      input: { extractCapsule: capsuleOutcome(PARTIAL), roleGate: blockedByGap('validator') },
    },
  ];

  for (const scenario of cases) {
    const created = createRecoveryHarness();
    harness = created;
    scenario.prepare(created, scenario.segment);
    const result = await recoverWorkerSession(inputFor(created, scenario.segment, scenario.input));

    expect(result.kind, scenario.name).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.code, scenario.name).toBe(scenario.expectedCode);
    }
    const recoveryId = deriveRecoveryId(RECOVERY_SCOPE, scenario.segment.segmentId as SessionSegmentId);
    // 关键断言：失败没有留下预写的派发 Intent，因此换一条中断仍可尝试恢复。
    expect(hasPrewrittenDispatchIntent(created, recoveryId), scenario.name).toBe(false);
    expect(workerStarts(created), scenario.name).toBe(0);
    expect(created.recovery(recoveryId)?.prewriteOperationId, scenario.name).toBeNull();
    created.close();
    harness = null;
  }
});
