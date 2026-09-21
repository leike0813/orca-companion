/**
 * 6.1 验收层：四类角色的 Worker Session Recovery 走同一生命周期
 * （change: `m1-recover-execution`；spec `recovery/worker-sessions` 的
 * 「Worker Session Recovery 先尝试精确恢复且不得凭不完整信息推断退出」与 D5/D12）。
 *
 * 这里补的是**跨角色一致性**，不是把既有单测抄一遍：
 *
 * - Specification Planner、Implementation、Validator、Finalizer 四个角色必须命中同一个入口、同一套
 *   派生身份（RecoveryId / 替代 SegmentId）、同一段状态迁移与同一份预算计数，而不是四套分支；
 *   四个角色只在「是否要求 Recovery Capsule」与准入事实上分叉，持久化结论形状必须逐项一致。
 * - 证据不足（存活不可判定）时四个角色都必须保持未决：不推断退出、不派发、不消耗额度，重启后仍是
 *   同一条 Recovery（限定审计标签 `gate.recovery-not-inferred-from-incomplete-evidence`）。
 *
 * 单角色的深层断言（替代派发回执不可核验、Coordinator Session 不进该生命周期、内部迁移表）已在
 * `tests/recovery/worker-session-recovery.test.ts` 与 `tests/recovery/alternate-session.test.ts`
 * 覆盖，这里不重复。
 */

import { afterEach, expect, test } from 'vitest';

import type { DispatchId, SessionSegmentId } from '../../../src/application/dto/identity.js';
import type { CapsuleExtractionOutcome } from '../../../src/application/recovery/recovery-capsule.js';
import {
  deriveRecoveryId,
  deriveReplacementSegmentId,
  recoverWorkerSession,
} from '../../../src/application/recovery/worker-session-recovery-service.js';
import { WORKER_ROLES, type WorkerRole } from '../../../src/domain/planning/execution-authorization.js';
import { roleGateRequiresCapsule } from '../../../src/domain/recovery/role-gate.js';
import type { TerminalLivenessFacts } from '../../../src/domain/worker-liveness.js';
import {
  RECOVERY_SCOPE,
  RECOVERY_WORKER_TASK,
  RECOVERY_WORK_PACKAGE,
  createRecoveryHarness,
  roleGateFactsFor,
  type RecoveryHarness,
} from '../../support/recovery-harness.js';

const ORCA_TASK = 'orca-task-recovery';

type RoleCase = {
  readonly role: WorkerRole;
  readonly segmentId: string;
  readonly dispatchId: string;
  readonly attemptId: string;
  readonly binding: string;
};

const CASES: readonly RoleCase[] = WORKER_ROLES.map((role) => ({
  role,
  segmentId: `segment-${role}-1`,
  dispatchId: `dispatch-${role}-1`,
  attemptId: `attempt-${role}`,
  binding: `binding-${role}`,
}));

/**
 * 四类角色在替代路径上的**共享**持久化结论形状。
 *
 * 断言每个角色都等于这一份常量，就是在断言「不是四套分支」：任何角色偷偷走了不同的状态迁移、
 * 不同的预算计数或复用原 Dispatch/Segment，都会在这里露出来。
 */
const SHARED_LIFECYCLE_OUTCOME = {
  status: 'recovered',
  terminalOutcome: 'replaced',
  consumedBudget: 1,
  replacementDispatchCreated: true,
  replacementSegmentCreated: true,
  replacementBindingCreated: true,
  supersededSegmentId: null,
};

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

function liveFacts(dispatchId: string): TerminalLivenessFacts {
  return {
    dispatchId: dispatchId as DispatchId,
    workerRunning: true,
    terminalHandle: 'terminal-1',
    host: { kind: 'enumerated', terminalHandles: ['terminal-1'] },
  };
}

/** 宿主无法枚举 terminal：存活既不能证明也不能否证。 */
function holdingFacts(dispatchId: string): TerminalLivenessFacts {
  return {
    dispatchId: dispatchId as DispatchId,
    workerRunning: false,
    terminalHandle: 'terminal-1',
    host: { kind: 'not-enumerated' },
  };
}

function completeCapsule(): CapsuleExtractionOutcome {
  return {
    kind: 'extracted',
    capsule: {
      coverage: 'complete',
      readableRange: { transcriptRef: 'transcript:source-1', fromEventRef: 'ev:1', toEventRef: 'ev:9' },
      gaps: [],
      lastCompleteEventRef: 'ev:9',
      openActions: [],
      sourceRefs: ['ev:9'],
      unknowns: [],
    },
  };
}

function setup(created: RecoveryHarness, c: RoleCase): void {
  created.recordSourceSegment({
    segmentId: c.segmentId,
    dispatchId: c.dispatchId,
    attemptId: c.attemptId,
    sessionBindingId: c.binding,
    role: c.role,
  });
  created.recordMaterializationBinding(RECOVERY_WORK_PACKAGE, ORCA_TASK);
}

function inputFor(
  created: RecoveryHarness,
  c: RoleCase,
  overrides: Partial<Parameters<RecoveryHarness['input']>[0]> = {},
): ReturnType<RecoveryHarness['input']> {
  return created.input({
    role: c.role,
    sourceSegmentId: c.segmentId as SessionSegmentId,
    sourceDispatchId: c.dispatchId as DispatchId,
    businessAttemptId: c.attemptId,
    observation: {
      sessionBindingId: c.binding,
      providerSessionId: `provider:${c.role}`,
      identityChanged: false,
    },
    liveness: holdingFacts(c.dispatchId),
    roleGate: roleGateFactsFor(c.role),
    ...overrides,
  });
}

test.each(CASES)(
  '四类角色走同一 Recovery 生命周期：$role 的替代 Session 保留业务身份，只新建 Dispatch / Segment / Binding',
  async (c) => {
    harness = createRecoveryHarness({ role: c.role });
    setup(harness, c);
    let capsuleCalls = 0;

    const result = await recoverWorkerSession(
      inputFor(harness, c, {
        liveness: exitedFacts(c.dispatchId),
        extractCapsule: () => {
          capsuleCalls += 1;
          return Promise.resolve(completeCapsule());
        },
      }),
    );

    expect(result.kind).toBe('alternate_created');
    const recoveryId = deriveRecoveryId(RECOVERY_SCOPE, c.segmentId as SessionSegmentId);
    const row = harness.recovery(recoveryId);

    // 业务身份逐字保留：Worker Task、Work Package、业务 Attempt、中断来源都走同一条 Recovery。
    expect(row?.role).toBe(c.role);
    expect(row?.workerTaskId).toBe(RECOVERY_WORKER_TASK);
    expect(row?.workPackageId).toBe(RECOVERY_WORK_PACKAGE);
    expect(row?.businessAttemptId).toBe(c.attemptId);
    expect(row?.sourceSegmentId).toBe(c.segmentId);
    expect(row?.sourceDispatchId).toBe(c.dispatchId);

    // 替代身份是派生的、稳定的、且与原身份不同——与角色无关。
    expect(row?.recoveryId).toBe(recoveryId);
    expect(row?.replacementSegmentId).toBe(deriveReplacementSegmentId(recoveryId));
    expect(row?.replacementSegmentId).not.toBe(c.segmentId);
    expect(row?.replacementDispatchId).not.toBe(c.dispatchId);
    expect(row?.replacementSessionBindingId).not.toBe(c.binding);

    // 四个角色的持久化结论形状逐项一致：同一生命周期，不是四条分支。
    expect({
      status: row?.status,
      terminalOutcome: row?.terminalOutcome,
      consumedBudget: row?.consumedBudget,
      replacementDispatchCreated: row?.replacementDispatchId !== null,
      replacementSegmentCreated: row?.replacementSegmentId !== null,
      replacementBindingCreated: row?.replacementSessionBindingId !== null,
      supersededSegmentId: row?.supersededSegmentId,
    }).toEqual(SHARED_LIFECYCLE_OUTCOME);

    // 角色只决定「是否需要 Capsule」，不改变生命周期本身。
    expect(capsuleCalls).toBe(roleGateRequiresCapsule(c.role) ? 1 : 0);
    expect(harness.backend.mutations().filter((mutation) => mutation.operation === 'worker-start')).toHaveLength(1);
  },
);

test.each(CASES)('四类角色都先尝试精确恢复原会话：$role 不创建替代 Session、不消耗 Recovery Budget', async (c) => {
  harness = createRecoveryHarness({ role: c.role });
  setup(harness, c);
  const resumedBindings: string[] = [];

  const result = await recoverWorkerSession(
    inputFor(harness, c, {
      liveness: liveFacts(c.dispatchId),
      resumeExact: (request) => {
        resumedBindings.push(request.sessionBindingId);
        return Promise.resolve({ kind: 'resumed', sessionBindingId: request.sessionBindingId });
      },
    }),
  );

  expect(result.kind).toBe('exact_recovery');
  // 第一次尝试就是精确恢复：先核验绑定，再恢复原会话。
  expect(resumedBindings).toEqual([c.binding]);
  const row = harness.recovery(deriveRecoveryId(RECOVERY_SCOPE, c.segmentId as SessionSegmentId));
  expect(row?.status).toBe('pending');
  expect(row?.consumedBudget).toBe(0);
  expect(row?.replacementDispatchId).toBeNull();
  expect(row?.capsuleRef).toBeNull();
  // 没有替代 Session、没有 Capsule、没有任何外部派发，也没有新增 Segment。
  expect(harness.segments()).toHaveLength(1);
  expect(harness.backend.mutations()).toEqual([]);
});

test.each(CASES)(
  '[gate.recovery-not-inferred-from-incomplete-evidence] $role 的存活证据不足时保持未决，绝不推断退出或重复派发',
  async (c) => {
    harness = createRecoveryHarness({ role: c.role });
    setup(harness, c);
    let resumeCalls = 0;

    const first = await recoverWorkerSession(
      inputFor(harness, c, {
        liveness: holdingFacts(c.dispatchId),
        resumeExact: () => {
          resumeCalls += 1;
          return Promise.resolve({ kind: 'resumed', sessionBindingId: c.binding });
        },
      }),
    );

    expect(first.kind).toBe('unverifiable_hold');
    // 证据不足时连精确恢复都不尝试：那已经不是能证明归属的事实。
    expect(resumeCalls).toBe(0);
    const recoveryId = deriveRecoveryId(RECOVERY_SCOPE, c.segmentId as SessionSegmentId);
    const held = harness.recovery(recoveryId);
    expect(held?.status).toBe('pending');
    expect(held?.terminalOutcome).toBeNull();
    expect(held?.replacementDispatchId).toBeNull();
    expect(held?.consumedBudget).toBe(0);
    // 不推断退出 => 没有任何替代派发，也没有消耗额度。
    expect(harness.backend.mutations()).toEqual([]);

    // 重启后仍以同一 RecoveryId 续办，仍然不派发：未决不是「已失败」，也不是「可以重建」。
    harness.reopen();
    const second = await recoverWorkerSession(inputFor(harness, c, { liveness: holdingFacts(c.dispatchId) }));
    expect(second.kind).toBe('unverifiable_hold');
    if (second.kind === 'unverifiable_hold') {
      expect(second.recoveryId).toBe(recoveryId);
    }
    expect(harness.recoveries()).toHaveLength(1);
    expect(harness.recovery(recoveryId)?.consumedBudget).toBe(0);
    expect(harness.backend.mutations()).toEqual([]);
  },
);
