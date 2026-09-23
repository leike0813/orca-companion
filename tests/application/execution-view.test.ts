/**
 * `m2-deliver-execution-tui` 的行为测试：执行阶段的只读投影（IC-11 Extend / IP-01、IP-02、IP-07）。
 *
 * 覆盖 `tui/execution-monitoring`、`tui/recovery-observability`、`tui/delivery-finalization` 与
 * `tui/execution-control` 里由 `execution-view.ts` 单独承担的那部分语义：每个 Work Package 的阶段只能
 * 由持久事实推出（推不出就是 `unknown`，不猜）、Worker liveness 与生命周期是两个独立字段、没有列举
 * 执行主机时存活结论只能是 `unverifiable`、Finalizer 门禁不满足时只呈现 blocker、未决 intent 或无法
 * 核验的 Worker 让「重启先对账」的门保持打开。
 *
 * 这里只测纯派生函数：不建库、不渲染界面、不接触 Orca。
 */

import { describe, expect, test } from 'vitest';

import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  DispatchId,
  GraphId,
  GraphVersion,
  InteractionId,
  OperationId,
  PlanningCycleId,
  RecoveryId,
  RuntimeIncarnationId,
  SessionSegmentId,
  WorkerTaskId,
  WorkPackageId,
} from '../../src/application/dto/identity.js';
import type { IntentState, OperationIntent } from '../../src/application/dto/operation-intent.js';
import {
  controlHazards,
  deriveExecutionFacts,
  deriveWorkerEntries,
  noExecutionObservations,
  type DerivedExecutionFacts,
  type ExecutionNodeFacts,
  type ExecutionObservationFacts,
  type FinalizerObservationFacts,
  type WorkPackageExecutionEntry,
} from '../../src/application/execution/execution-view.js';
import type {
  BaselineAdoptionRecord,
  BaselineReconciliationRecord,
  CoordinationSnapshot,
  DeliverySettlementRecord,
  DeliveryVerdictRecord,
  MaterializationBindingRecord,
  PendingInteractionRecord,
  RecoveryRecord,
  RevisionHoldRecord,
  SessionSegmentRecord,
} from '../../src/application/ports/branch-coordination-store.js';
import type { RoleAuthorities, WorkerRole } from '../../src/domain/planning/execution-authorization.js';

const SCOPE = 'scope-1' as CoordinationScopeId;
const SESSION = 'session-1' as CoordinatorSessionId;
const INCARNATION = 'incarnation-1' as RuntimeIncarnationId;
const CYCLE = 'cycle-1' as PlanningCycleId;
const GRAPH = 'graph-1' as GraphId;

const WP_A = 'wp-a';
const WP_B = 'wp-b';
const WP_C = 'wp-c';
const WP_D = 'wp-d';

const ALL_AUTHORITIES: RoleAuthorities = {
  planner: true,
  implementation: true,
  validator: true,
  finalizer: true,
  gitIntegration: true,
  dependencyChanges: true,
};

/** 纯函数测试用的最小快照：只填被投影读到的字段，其余为空。 */
const EMPTY_SNAPSHOT: CoordinationSnapshot = {
  scope: {
    coordinationScopeId: SCOPE,
    fullBranchRef: 'refs/heads/main',
    canonicalWorktreePath: '/tmp/orca-canonical',
    mode: 'execution_coordination',
    controlState: 'active',
    planningCycleId: CYCLE,
    mapRevision: 1,
    graphId: GRAPH,
    graphVersion: 1 as GraphVersion,
    authorizationId: null,
    authorizationVersion: null,
    revision: 1,
  },
  sessions: [],
  leases: [],
  executionLease: null,
  ticketClaims: [],
  pendingInteractions: [],
  unresolvedIntents: [],
  planningHandoffs: [],
  planningResponsibility: null,
  sessionSegments: [],
  materializationBindings: [],
  deliverySettlements: [],
  deliveryVerdicts: [],
  recoveries: [],
  executionHandoffs: [],
  graphGenerations: [],
  revisionHolds: [],
  baselineReconciliations: [],
  workPackageLineages: [],
  baselineAdoptions: [],
  mutationLanes: [],
};

function snapshot(overrides: Partial<CoordinationSnapshot> = {}): CoordinationSnapshot {
  return { ...EMPTY_SNAPSHOT, ...overrides };
}

function makeRevisionHold(input: {
  readonly workPackageId: string;
  readonly sourceRef: string;
  readonly state?: 'pending' | 'released';
}): RevisionHoldRecord {
  return {
    coordinationScopeId: SCOPE,
    workPackageId: input.workPackageId as WorkPackageId,
    source: 'graph_patch',
    sourceRef: input.sourceRef,
    state: input.state ?? 'pending',
    createdAt: 10,
    releasedAt: input.state === 'released' ? 20 : null,
    releaseReason: null,
  };
}

function makeReconciliation(input: {
  readonly reconciliationId: string;
  readonly workPackageId: string;
  readonly state: 'required' | 'verified' | 'blocked';
  readonly requiredBaselineHead?: string;
  readonly observedHead?: string | null;
  readonly blockerRef?: string | null;
  readonly updatedAt?: number;
}): BaselineReconciliationRecord {
  return {
    coordinationScopeId: SCOPE,
    reconciliationId: input.reconciliationId,
    workPackageId: input.workPackageId as WorkPackageId,
    role: 'planner',
    requiredBaselineHead: input.requiredBaselineHead ?? 'head-required',
    orcaTaskId: null,
    dispatchId: null,
    observedHead: input.observedHead ?? null,
    ancestryVerified: false,
    targetHeadVerified: false,
    dirtyPathsReconciled: false,
    scopeReconciled: false,
    state: input.state,
    blockerRef: input.blockerRef ?? null,
    createdAt: 10,
    updatedAt: input.updatedAt ?? 10,
  };
}

function makeBinding(workPackageId: string, orcaTaskId: string): MaterializationBindingRecord {
  return {
    coordinationScopeId: SCOPE,
    workPackageId: workPackageId as WorkPackageId,
    orcaTaskId,
    creationOperationId: `op-materialize-${workPackageId}` as OperationId,
    createdAt: 10,
  };
}

function makeSettlement(input: {
  readonly workPackageId: string;
  readonly orcaTaskId: string;
  readonly role: WorkerRole;
  readonly dispatchId?: string;
  readonly attemptId?: string;
  readonly acceptedAt?: number;
}): DeliverySettlementRecord {
  const dispatchId = input.dispatchId ?? `dispatch-${input.workPackageId}-${input.role}`;
  return {
    coordinationScopeId: SCOPE,
    dedupeKey: `${dispatchId}:${input.role}`,
    deliveryId: `delivery-${dispatchId}`,
    runId: 'run-1',
    consumerGeneration: 1,
    workerTaskId: input.orcaTaskId as WorkerTaskId,
    dispatchId: dispatchId as DispatchId,
    attemptId: input.attemptId ?? `attempt-${dispatchId}`,
    role: input.role,
    contractRevision: 1,
    orcaResultRef: `orca-result-${dispatchId}`,
    acceptedAt: input.acceptedAt ?? 100,
  };
}

function makeSegment(input: {
  readonly workPackageId: string;
  readonly role: WorkerRole;
  readonly dispatchId: string;
  readonly workerTaskId?: string;
  readonly attemptId?: string;
  readonly recordedAt?: number;
}): SessionSegmentRecord {
  return {
    coordinationScopeId: SCOPE,
    segmentId: `segment-${input.dispatchId}` as SessionSegmentId,
    workPackageId: input.workPackageId as WorkPackageId,
    role: input.role,
    workerTaskId: (input.workerTaskId ?? `${input.workPackageId}-task`) as WorkerTaskId,
    dispatchId: input.dispatchId as DispatchId,
    attemptId: input.attemptId ?? `attempt-${input.dispatchId}`,
    sessionBindingId: `session-binding-${input.dispatchId}`,
    lastTranscriptRef: null,
    terminalReceiptRef: null,
    transcriptReferenceable: false,
    verifiable: false,
    recordedAt: input.recordedAt ?? 100,
  };
}

function makeRecovery(input: {
  readonly workPackageId: string;
  readonly role: WorkerRole;
  readonly status: 'pending' | 'recovering' | 'recovered' | 'blocked' | 'cancelled';
  readonly businessAttemptId?: string;
  readonly blockingReason?: string | null;
  readonly replacementDispatchId?: string | null;
  readonly workerTaskId?: string;
}): RecoveryRecord {
  const recoveryId = `recovery-${input.workPackageId}-${input.role}`;
  return {
    coordinationScopeId: SCOPE,
    recoveryId: recoveryId as RecoveryId,
    role: input.role,
    workPackageId: input.workPackageId as WorkPackageId,
    workerTaskId: (input.workerTaskId ?? `${input.workPackageId}-task`) as WorkerTaskId,
    businessAttemptId: input.businessAttemptId ?? `attempt-${input.workPackageId}`,
    sourceSegmentId: `segment-${input.workPackageId}` as SessionSegmentId,
    sourceDispatchId: `dispatch-${input.workPackageId}-source` as DispatchId,
    replacementDispatchId: input.replacementDispatchId ?? null,
    replacementSegmentId: null,
    replacementSessionBindingId: null,
    supersededSegmentId: null,
    status: input.status,
    consumedBudget: 1,
    capsuleRef: null,
    prewriteOperationId: null,
    terminalOutcome: null,
    blockingReason: input.blockingReason ?? null,
    createdAt: 10,
    updatedAt: 20,
  };
}

function makeAdoption(input: {
  readonly workPackageId: string;
  readonly integrationRef?: string | null;
  readonly state?: 'recorded' | 'blocked';
  readonly blockingReason?: string | null;
  readonly recordedAt?: number;
}): BaselineAdoptionRecord {
  return {
    coordinationScopeId: SCOPE,
    adoptionId: `adoption-${input.workPackageId}`,
    workPackageId: input.workPackageId as WorkPackageId,
    kind: 'baseline_adoption',
    adoptedResultRef: `accepted-result-${input.workPackageId}`,
    baselineHead: 'head-adopted',
    integrationRef: input.integrationRef ?? null,
    evidenceRefs: [],
    state: input.state ?? 'recorded',
    blockingReason: input.blockingReason ?? null,
    recordedAt: input.recordedAt ?? 50,
  };
}

function makeInteraction(interactionId: string, state: 'open' | 'answered' | 'cancelled'): PendingInteractionRecord {
  return {
    coordinationScopeId: SCOPE,
    interactionId: interactionId as InteractionId,
    ownerCoordinatorSessionId: SESSION,
    subjectRef: { kind: 'work_package', id: WP_A },
    expectedRevision: 1,
    state,
    answerRef: null,
    answerText: null,
    createdAt: 10,
    resolvedAt: state === 'open' ? null : 20,
  };
}

function makeIntent(operationId: string, state: IntentState = 'pending'): OperationIntent {
  return {
    coordinationScopeId: SCOPE,
    operationId: operationId as OperationId,
    target: { kind: 'work_package', id: WP_A },
    operationCategory: 'task-create',
    laneKey: '["work_package","wp-a","task-create"]',
    expectedRevision: 1,
    expectedHead: null,
    initiatedBy: { coordinatorSessionId: SESSION, runtimeIncarnationId: INCARNATION },
    state,
    outcomeClass: null,
    backendRequestId: null,
    blockingReason: null,
    createdAt: 10,
    settledAt: null,
  };
}

function makeVerdict(input: {
  readonly verdictId: string;
  readonly verdictSequence: number;
  readonly verdict: DeliveryVerdictRecord['verdict'];
  readonly recordedAt?: number;
}): DeliveryVerdictRecord {
  return {
    coordinationScopeId: SCOPE,
    verdictId: input.verdictId,
    verdictSequence: input.verdictSequence,
    verdict: input.verdict,
    finalizerRole: 'finalizer',
    sessionBindingRef: 'finalizer-session-binding',
    recordedAt: input.recordedAt ?? 500,
  };
}

function observations(overrides: Partial<ExecutionObservationFacts> = {}): ExecutionObservationFacts {
  return {
    workersEnumerated: false,
    workers: [],
    worktreePaths: new Map(),
    unavailableReasons: [],
    finalizer: null,
    ...overrides,
  };
}

function finalizerObservation(overrides: Partial<FinalizerObservationFacts> = {}): FinalizerObservationFacts {
  return {
    readOnlyProfile: 'unverified',
    integrationFrozen: 'unknown',
    worktreePath: null,
    workspace: null,
    evidenceRefs: [],
    ...overrides,
  };
}

function derive(input: {
  readonly snapshot: CoordinationSnapshot;
  readonly nodes?: readonly ExecutionNodeFacts[];
  readonly baselineHead?: string | null;
  readonly authority?: RoleAuthorities;
  readonly observations?: ExecutionObservationFacts;
}): DerivedExecutionFacts {
  return deriveExecutionFacts({
    snapshot: input.snapshot,
    nodes: input.nodes ?? [{ workPackageId: WP_A, dependsOn: [] }],
    baselineHead: input.baselineHead === undefined ? 'head-0001' : input.baselineHead,
    authority: input.authority ?? ALL_AUTHORITIES,
    observations: input.observations ?? observations(),
  });
}

function frontierEntry(facts: DerivedExecutionFacts, workPackageId: string): WorkPackageExecutionEntry {
  const entry = facts.frontier.find((candidate) => candidate.workPackageId === workPackageId);
  if (entry === undefined) {
    throw new Error(`Frontier 里没有 ${workPackageId}`);
  }
  return entry;
}

describe('deriveExecutionFacts：Frontier 阶段只由持久事实推出', () => {
  test('Scenario 并发上限为 1／单 active Work Package 串行推进：无执行事实时依赖已满足为 admitting，依赖未满足为 waiting，derivedFrom 为空', () => {
    const facts = derive({
      snapshot: snapshot(),
      nodes: [
        { workPackageId: WP_A, dependsOn: [] },
        { workPackageId: WP_B, dependsOn: [WP_A] },
      ],
      baselineHead: 'head-0001',
    });

    // Frontier 覆盖当前 GraphVersion 的每个节点，顺序即传入的稳定拓扑顺序。
    expect(facts.frontier.map((entry) => entry.workPackageId)).toEqual([WP_A, WP_B]);

    const admitting = frontierEntry(facts, WP_A);
    expect(admitting.state).toBe('admitting');
    expect(admitting.derivedFrom).toEqual([]);
    expect(admitting.blockerRefs).toEqual([]);
    expect(admitting.baselineHead).toBe('head-0001');
    // 没有 Worker 观察不是「已退出」：没有可核验的存活结论时 liveness 为空。
    expect(admitting.liveness).toBeNull();

    // 前驱还不是 accepted，后继不得被读成可派发。
    expect(frontierEntry(facts, WP_B).state).toBe('waiting');
  });

  test('pending 的 Revision Hold 让该节点停在 revision_pending；已释放的持有不改变阶段', () => {
    const facts = derive({
      snapshot: snapshot({
        revisionHolds: [
          makeRevisionHold({ workPackageId: WP_A, sourceRef: 'patch-1', state: 'pending' }),
          makeRevisionHold({ workPackageId: WP_B, sourceRef: 'patch-2', state: 'released' }),
        ],
      }),
      nodes: [
        { workPackageId: WP_A, dependsOn: [] },
        { workPackageId: WP_B, dependsOn: [] },
      ],
    });

    const held = frontierEntry(facts, WP_A);
    expect(held.state).toBe('revision_pending');
    expect(held.derivedFrom).toContain('revision-hold:patch-1');

    expect(frontierEntry(facts, WP_B).state).toBe('admitting');
    expect(frontierEntry(facts, WP_B).derivedFrom).toEqual([]);
  });

  test('Scenario 严重冲突升级为可区分状态：reconciliation 的 required/blocked/verified 分别投影为 reconciling、带 blockerRef 的 reconciling 与 canonical_advance', () => {
    const facts = derive({
      snapshot: snapshot({
        baselineReconciliations: [
          makeReconciliation({
            reconciliationId: 'reconciliation-a',
            workPackageId: WP_A,
            state: 'required',
            requiredBaselineHead: 'head-required',
          }),
          makeReconciliation({
            reconciliationId: 'reconciliation-b',
            workPackageId: WP_B,
            state: 'blocked',
            requiredBaselineHead: 'head-required',
            observedHead: 'head-observed',
            blockerRef: 'merge-conflict-beyond-authority',
          }),
          makeReconciliation({
            reconciliationId: 'reconciliation-c',
            workPackageId: WP_C,
            state: 'verified',
            requiredBaselineHead: 'head-old',
            observedHead: 'head-new',
          }),
        ],
      }),
      nodes: [
        { workPackageId: WP_A, dependsOn: [] },
        { workPackageId: WP_B, dependsOn: [] },
        { workPackageId: WP_C, dependsOn: [] },
      ],
    });

    // 轻微核验：状态是 reconciling，但没有 blocker。
    const required = frontierEntry(facts, WP_A);
    expect(required.state).toBe('reconciling');
    expect(required.role).toBe('planner');
    expect(required.blockerRefs).toEqual([]);

    // 严重冲突：同样是 reconciling，但 blockerRefs 非空，严重性单独表达。
    const blocked = frontierEntry(facts, WP_B);
    expect(blocked.state).toBe('reconciling');
    expect(blocked.blockerRefs).toEqual(['reconciliation:merge-conflict-beyond-authority']);

    // 已核验的基线只算 canonical 前进，不再让节点停在 reconciling。
    expect(frontierEntry(facts, WP_C).state).toBe('admitting');

    expect(severityOf(facts, WP_A)).toBe('reconciliation_required');
    expect(severityOf(facts, WP_B)).toBe('conflict_escalated');
    expect(severityOf(facts, WP_C)).toBe('canonical_advance');

    const blockedView = facts.reconciliations.find((view) => view.workPackageId === WP_B);
    expect(blockedView?.requiredBaselineHead).toBe('head-required');
    expect(blockedView?.observedHead).toBe('head-observed');
    expect(blockedView?.blockerRef).toBe('merge-conflict-beyond-authority');
  });

  test('Scenario 完成后排队进入集成／单包验证通过不等于可交付：已结算 validator Delivery 是 waiting_integration，有 integrationRef 的 adoption 才是 accepted', () => {
    const facts = derive({
      snapshot: snapshot({
        materializationBindings: [
          makeBinding(WP_A, 'orca-task-a'),
          makeBinding(WP_B, 'orca-task-b'),
          makeBinding(WP_C, 'orca-task-c'),
        ],
        deliverySettlements: [
          makeSettlement({
            workPackageId: WP_A,
            orcaTaskId: 'orca-task-a',
            role: 'validator',
            dispatchId: 'dispatch-a-validator',
            attemptId: 'attempt-a-validator',
          }),
          makeSettlement({
            workPackageId: WP_B,
            orcaTaskId: 'orca-task-b',
            role: 'validator',
            dispatchId: 'dispatch-b-validator',
            attemptId: 'attempt-b-validator',
          }),
          makeSettlement({
            workPackageId: WP_C,
            orcaTaskId: 'orca-task-c',
            role: 'implementation',
            dispatchId: 'dispatch-c-implementation',
            attemptId: 'attempt-c-implementation',
          }),
        ],
        baselineAdoptions: [makeAdoption({ workPackageId: WP_B, integrationRef: 'integration-b' })],
      }),
      nodes: [
        { workPackageId: WP_A, dependsOn: [] },
        { workPackageId: WP_B, dependsOn: [] },
        { workPackageId: WP_C, dependsOn: [] },
      ],
    });

    const waiting = frontierEntry(facts, WP_A);
    expect(waiting.state).toBe('waiting_integration');
    expect(waiting.role).toBe('validator');
    expect(waiting.attemptId).toBe('attempt-a-validator');
    expect(waiting.validation?.state).toBe('validated');
    expect(waiting.validation?.acceptedResultRef).toBe('orca-result-dispatch-a-validator');
    // 集成事实没有本地生产者：只表达「可以进入集成」，不声称集成正在进行。
    expect(waiting.integration).toEqual({ state: 'waiting', ref: null });
    expect(waiting.derivedFrom.length).toBeGreaterThan(0);

    const accepted = frontierEntry(facts, WP_B);
    expect(accepted.state).toBe('accepted');
    expect(accepted.integration).toEqual({ state: 'integrated', ref: 'integration-b' });
    expect(accepted.derivedFrom).toContain('adoption:adoption-wp-b');

    // 实现已接受、验证尚未给出结论：这是验证阶段本身，不是「验证已通过」。
    const validating = frontierEntry(facts, WP_C);
    expect(validating.state).toBe('validating');
    expect(validating.role).toBe('implementation');
    expect(validating.validation?.state).toBe('validating');
    expect(validating.integration).toBeNull();
  });

  test('Scenario 迟到结果只补历史／unknown 不呈现为失败：只有 Session Segment 时是 unknown 且 liveness 不可核验', () => {
    const facts = derive({
      snapshot: snapshot({
        sessionSegments: [
          makeSegment({
            workPackageId: WP_A,
            role: 'implementation',
            dispatchId: 'dispatch-segmented',
            attemptId: 'attempt-segmented',
          }),
        ],
      }),
    });

    const entry = frontierEntry(facts, WP_A);
    expect(entry.state).toBe('unknown');
    expect(entry.role).toBe('implementation');
    expect(entry.attemptId).toBe('attempt-segmented');
    expect(entry.derivedFrom).toContain('session-segment:segment-dispatch-segmented');
    // 中断已记录、后续不可核验：既不是失败，也不是已退出。
    expect(entry.liveness).toBe('unverifiable');
    expect(entry.blockerRefs).toEqual([]);
  });

  test('Scenario liveness 与生命周期分别显示：没有列举执行主机时已开始的 Work Package 只能是 unverifiable', () => {
    const facts = derive({
      snapshot: snapshot({ materializationBindings: [makeBinding(WP_A, 'orca-task-a')] }),
      observations: observations({ worktreePaths: new Map([[WP_A, '/tmp/orca-canonical/.worktrees/wp-a']]) }),
    });

    const entry = frontierEntry(facts, WP_A);
    // 已有角色级 Orca Task，但还没有任何已接受结果：规格阶段。
    expect(entry.state).toBe('specifying');
    expect(entry.derivedFrom).toContain('materialization:orca-task-a');
    // 已经从物化绑定开始执行，但执行主机没有列举：唯一诚实的存活结论是不可核验。
    expect(entry.liveness).toBe('unverifiable');
    expect(entry.worktreePath).toBe('/tmp/orca-canonical/.worktrees/wp-a');
  });

  test('列举执行主机后，运行中的 Worker 把阶段推进到它的角色', () => {
    const facts = derive({
      snapshot: snapshot({
        sessionSegments: [
          makeSegment({
            workPackageId: WP_A,
            role: 'validator',
            dispatchId: 'dispatch-live',
            attemptId: 'attempt-live',
          }),
        ],
      }),
      observations: observations({
        workersEnumerated: true,
        workers: [{ dispatchId: 'dispatch-live', taskId: 'orca-task-a', workerState: 'running', terminalState: null }],
      }),
    });

    const entry = frontierEntry(facts, WP_A);
    expect(entry.state).toBe('validating');
    expect(entry.role).toBe('validator');
    expect(entry.attemptId).toBe('attempt-live');
    expect(entry.liveness).toBe('live');
    expect(entry.derivedFrom).toContain('worker-live:attempt-live');
  });

  test('Scenario Recovery 失败投影为 blocker：blocked 的 Recovery 让节点停在 blocked 并带出 blockerRefs', () => {
    const facts = derive({
      snapshot: snapshot({
        recoveries: [
          makeRecovery({
            workPackageId: WP_A,
            role: 'implementation',
            status: 'blocked',
            businessAttemptId: 'attempt-blocked',
            blockingReason: 'transcript-unavailable',
          }),
          makeRecovery({ workPackageId: WP_B, role: 'planner', status: 'blocked' }),
        ],
      }),
      nodes: [
        { workPackageId: WP_A, dependsOn: [] },
        { workPackageId: WP_B, dependsOn: [] },
      ],
    });

    const blocked = frontierEntry(facts, WP_A);
    expect(blocked.state).toBe('blocked');
    expect(blocked.role).toBe('implementation');
    expect(blocked.attemptId).toBe('attempt-blocked');
    expect(blocked.blockerRefs).toEqual(['transcript-unavailable']);

    // 记录里没有原因时必须给出稳定引用，不能呈现为「没有 blocker」。
    expect(frontierEntry(facts, WP_B).blockerRefs).toEqual(['recovery:recovery-wp-b-planner']);
  });

  test('Scenario 单包验证通过不等于可交付：Finalizer 门禁只在全部通过验证且没有未决事实时才 ready', () => {
    const readySnapshot = snapshot({
      materializationBindings: [makeBinding(WP_A, 'orca-task-a')],
      deliverySettlements: [
        makeSettlement({ workPackageId: WP_A, orcaTaskId: 'orca-task-a', role: 'validator' }),
      ],
    });

    const ready = derive({ snapshot: readySnapshot });
    expect(ready.finalizer.gate.ready).toBe(true);
    expect(ready.finalizer.gate.blockers).toEqual([]);
    expect(ready.finalizer.coversWorkPackageIds).toEqual([WP_A]);
    // 没有 Finalizer 观察时不呈现只读核验结论与交付结论。
    expect(ready.finalizer.readOnlyProfile).toBe('unverified');
    expect(ready.finalizer.integrationFrozen).toBe('unknown');
    expect(ready.finalizer.workspace).toBeNull();
    expect(ready.finalizer.verdict).toBeNull();

    // 没有任何 Work Package。
    const empty = derive({ snapshot: snapshot(), nodes: [] });
    expect(empty.finalizer.gate.ready).toBe(false);
    expect(empty.finalizer.gate.blockers).toContain('no-work-packages');

    // 存在未决交互。
    const withInteraction = derive({
      snapshot: snapshot({ ...readySnapshot, pendingInteractions: [makeInteraction('interaction-1', 'open')] }),
    });
    expect(withInteraction.finalizer.gate.blockers).toContain('pending-interactions:1');
    expect(withInteraction.finalizer.gate.ready).toBe(false);

    // 存在未结算的 mutation。
    const withIntent = derive({
      snapshot: snapshot({ ...readySnapshot, unresolvedIntents: [makeIntent('operation-1')] }),
    });
    expect(withIntent.finalizer.gate.blockers).toContain('unsettled-mutations:1');
    expect(withIntent.finalizer.gate.ready).toBe(false);

    // 没有 Execution Authorization 时 finalizer 角色未授权。
    const unauthorized = deriveExecutionFacts({
      snapshot: readySnapshot,
      nodes: [{ workPackageId: WP_A, dependsOn: [] }],
      baselineHead: 'head-0001',
      authority: null,
      observations: observations(),
    });
    expect(unauthorized.finalizer.gate.blockers).toContain('finalizer-not-authorized');
    expect(unauthorized.finalizer.gate.ready).toBe(false);
  });

  test('Scenario 只读无法强制时阻塞／工作区在运行期间变化：Finalizer 观察只补 blocker，不产生交付结论', () => {
    const facts = derive({
      snapshot: snapshot({
        materializationBindings: [makeBinding(WP_A, 'orca-task-a')],
        deliverySettlements: [
          makeSettlement({ workPackageId: WP_A, orcaTaskId: 'orca-task-a', role: 'validator' }),
        ],
      }),
      observations: observations({
        finalizer: finalizerObservation({
          readOnlyProfile: 'unenforceable',
          integrationFrozen: 'frozen',
          worktreePath: '/tmp/orca-canonical',
          evidenceRefs: ['evidence-1'],
          workspace: {
            before: { head: 'head-before', indexRevision: 'index-1', dirtyPaths: ['a.ts'] },
            after: { head: 'head-after', indexRevision: 'index-1', dirtyPaths: ['a.ts'] },
          },
        }),
      }),
    });

    expect(facts.finalizer.gate.ready).toBe(false);
    expect(facts.finalizer.gate.blockers).toContain('finalizer-read-only-not-enforceable');
    expect(facts.finalizer.gate.blockers).toContain('finalizer-workspace-changed');
    expect(facts.finalizer.readOnlyProfile).toBe('unenforceable');
    expect(facts.finalizer.integrationFrozen).toBe('frozen');
    expect(facts.finalizer.worktreePath).toBe('/tmp/orca-canonical');
    expect(facts.finalizer.evidenceRefs).toEqual(['evidence-1']);
    // 运行前后事实如实呈现。
    expect(facts.finalizer.workspace?.before.head).toBe('head-before');
    expect(facts.finalizer.workspace?.after.head).toBe('head-after');
    // 门禁不满足时不呈现交付结论。
    expect(facts.finalizer.verdict).toBeNull();

    // 运行前后完全相同：不产生「工作区已变化」的 blocker。
    const stable = derive({
      snapshot: snapshot(),
      observations: observations({
        finalizer: finalizerObservation({
          workspace: {
            before: { head: 'head-same', indexRevision: 'index-1', dirtyPaths: ['b.ts', 'a.ts'] },
            after: { head: 'head-same', indexRevision: 'index-1', dirtyPaths: ['a.ts', 'b.ts'] },
          },
        }),
      }),
    });
    expect(stable.finalizer.gate.blockers).not.toContain('finalizer-workspace-changed');
  });

  test('Scenario blocker 结论明确呈现：被接受的 blocked verdict 作为 blocker 终态呈现', () => {
    const facts = derive({
      snapshot: snapshot({
        deliveryVerdicts: [
          makeVerdict({
            verdictId: 'verdict-1',
            verdictSequence: 1,
            verdict: { kind: 'deliverable', evidenceRefs: ['evidence-old'] },
          }),
          makeVerdict({
            verdictId: 'verdict-2',
            verdictSequence: 2,
            verdict: { kind: 'blocked', blockerRefs: ['unvalidated-work-package'] },
          }),
        ],
      }),
    });

    // 最新结论按 verdictSequence 决定。
    expect(facts.finalizer.verdict?.verdictId).toBe('verdict-2');
    expect(facts.finalizer.verdict?.kind).toBe('blocked');
    expect(facts.finalizer.verdict?.refs).toEqual(['unvalidated-work-package']);
  });

  test('Scenario 重启先对账：未决 intent 或无法核验的 Worker 让对账门保持打开', () => {
    const withIntent = derive({ snapshot: snapshot({ unresolvedIntents: [makeIntent('operation-1')] }) });
    expect(withIntent.executionReconciliation.pending).toBe(true);
    expect(withIntent.executionReconciliation.unresolvedIntentCount).toBe(1);
    expect(withIntent.executionReconciliation.reasons).toContain('unresolved-intents:1');

    // 已开始执行但没有列举执行主机：结论不可核验，因此同样不算已对账。
    const unverifiable = derive({
      snapshot: snapshot({ materializationBindings: [makeBinding(WP_A, 'orca-task-a')] }),
    });
    expect(unverifiable.executionReconciliation.pending).toBe(true);
    expect(unverifiable.executionReconciliation.activeWorkerCount).toBe(1);
    expect(unverifiable.executionReconciliation.reasons).toContain('active-workers:1');

    // 对账完成、没有未决事实时门是关的；无法取得的外部事实仍然如实列出。
    const clean = derive({
      snapshot: snapshot(),
      observations: noExecutionObservations('execution-host-unavailable'),
    });
    expect(clean.executionReconciliation.pending).toBe(false);
    expect(clean.executionReconciliation.unresolvedIntentCount).toBe(0);
    expect(clean.executionReconciliation.activeWorkerCount).toBe(0);
    expect(clean.executionReconciliation.reasons).toEqual(['execution-host-unavailable']);
  });
});

describe('deriveWorkerEntries：Worker 名单来自持久记录，存活结论只在能核验时确定', () => {
  test('没有列举执行主机时所有已派发 Worker 都是 unverifiable', () => {
    const snapshotWithWorkers = snapshot({
      sessionSegments: [
        makeSegment({
          workPackageId: WP_A,
          role: 'planner',
          dispatchId: 'dispatch-seg',
          workerTaskId: 'worker-task-seg',
        }),
      ],
      materializationBindings: [makeBinding(WP_B, 'orca-task-b')],
      deliverySettlements: [
        makeSettlement({
          workPackageId: WP_B,
          orcaTaskId: 'orca-task-b',
          role: 'validator',
          dispatchId: 'dispatch-settled',
        }),
      ],
      recoveries: [
        makeRecovery({
          workPackageId: WP_C,
          role: 'implementation',
          status: 'recovered',
          replacementDispatchId: 'dispatch-replacement',
          workerTaskId: 'worker-task-replacement',
        }),
      ],
    });

    const entries = deriveWorkerEntries({
      snapshot: snapshotWithWorkers,
      observations: observations(),
    });

    expect(entries.map((entry) => entry.dispatchId).sort()).toEqual([
      'dispatch-replacement',
      'dispatch-seg',
      'dispatch-settled',
    ]);
    for (const entry of entries) {
      expect(entry.liveness).toBe('unverifiable');
    }

    const settled = entries.find((entry) => entry.dispatchId === 'dispatch-settled');
    expect(settled?.workPackageId).toBe(WP_B);
    expect(settled?.role).toBe('validator');
    expect(settled?.workerTaskId).toBe('orca-task-b');

    // 未派发过的 Dispatch 不会因为「观察里有」就出现在名单里。
    const onlyObserved = deriveWorkerEntries({
      snapshot: snapshot(),
      observations: observations({
        workersEnumerated: true,
        workers: [{ dispatchId: 'dispatch-unknown', taskId: 't', workerState: 'running', terminalState: null }],
      }),
    });
    expect(onlyObserved).toEqual([]);
  });

  test('列举执行主机后按 workerState 映射 live／exited，未登记状态一律 unverifiable', () => {
    const snapshotWithWorkers = snapshot({
      sessionSegments: [
        makeSegment({ workPackageId: WP_A, role: 'planner', dispatchId: 'dispatch-running' }),
      ],
      materializationBindings: [makeBinding(WP_B, 'orca-task-b'), makeBinding(WP_D, 'orca-task-d')],
      deliverySettlements: [
        makeSettlement({
          workPackageId: WP_B,
          orcaTaskId: 'orca-task-b',
          role: 'validator',
          dispatchId: 'dispatch-succeeded',
        }),
        makeSettlement({
          workPackageId: WP_D,
          orcaTaskId: 'orca-task-d',
          role: 'implementation',
          dispatchId: 'dispatch-silent',
        }),
      ],
      recoveries: [
        makeRecovery({
          workPackageId: WP_C,
          role: 'implementation',
          status: 'recovered',
          replacementDispatchId: 'dispatch-strange-state',
        }),
      ],
    });

    const entries = deriveWorkerEntries({
      snapshot: snapshotWithWorkers,
      observations: observations({
        workersEnumerated: true,
        workers: [
          { dispatchId: 'dispatch-running', taskId: 'orca-task-a', workerState: 'running', terminalState: null },
          { dispatchId: 'dispatch-succeeded', taskId: 'orca-task-b', workerState: 'succeeded', terminalState: 'succeeded' },
          { dispatchId: 'dispatch-strange-state', taskId: 'orca-task-c', workerState: 'starting', terminalState: null },
          { dispatchId: 'dispatch-silent', taskId: 'orca-task-d', workerState: null, terminalState: null },
        ],
      }),
    });

    const livenessByDispatch = new Map(entries.map((entry) => [entry.dispatchId, entry.liveness]));
    expect(livenessByDispatch.get('dispatch-running')).toBe('live');
    expect(livenessByDispatch.get('dispatch-succeeded')).toBe('exited');
    // 未登记的状态与没有给出状态一律不可核验，不得读作已退出。
    expect(livenessByDispatch.get('dispatch-strange-state')).toBe('unverifiable');
    expect(livenessByDispatch.get('dispatch-silent')).toBe('unverifiable');
  });
});

describe('controlHazards：不可核验与运行中都计入 hazard', () => {
  test('Scenario Cancel 前要求确认：live 与 unverifiable 的 Worker 都让 hazard 为真，全空时为假', () => {
    const facts = derive({
      snapshot: snapshot({
        sessionSegments: [
          makeSegment({ workPackageId: WP_A, role: 'implementation', dispatchId: 'dispatch-live' }),
          makeSegment({ workPackageId: WP_B, role: 'planner', dispatchId: 'dispatch-quiet' }),
        ],
      }),
      nodes: [
        { workPackageId: WP_A, dependsOn: [] },
        { workPackageId: WP_B, dependsOn: [] },
        { workPackageId: WP_D, dependsOn: [] },
      ],
      observations: observations({
        workersEnumerated: true,
        workers: [{ dispatchId: 'dispatch-live', taskId: 'orca-task-a', workerState: 'running', terminalState: null }],
      }),
    });

    expect(frontierEntry(facts, WP_A).liveness).toBe('live');
    // 没被观察到的 Worker 不可核验，同样计入 hazard，不得读作已经停止。
    expect(frontierEntry(facts, WP_B).liveness).toBe('unverifiable');
    // 从未开始执行过的 Work Package 没有 liveness 结论。
    expect(frontierEntry(facts, WP_D).liveness).toBeNull();

    const hazards = controlHazards({
      frontier: facts.frontier,
      openInteractionCount: 0,
      unresolvedIntentCount: 0,
    });
    expect(hazards.activeWorkerCount).toBe(1);
    expect(hazards.unverifiedWorkerCount).toBe(1);
    expect(hazards.hazardous).toBe(true);

    // 没有开始执行的 Work Package 不产生活跃或不可核验的 Worker：不需要确认。
    const quiet = controlHazards({
      frontier: derive({ snapshot: snapshot() }).frontier,
      openInteractionCount: 0,
      unresolvedIntentCount: 0,
    });
    expect(quiet.hazardous).toBe(false);
    expect(quiet.activeWorkerCount).toBe(0);
    expect(quiet.unverifiedWorkerCount).toBe(0);

    // 单独的 Pending Interaction 或未决操作同样是危险态。
    const onlyInteraction = controlHazards({
      frontier: [],
      openInteractionCount: 1,
      unresolvedIntentCount: 0,
    });
    expect(onlyInteraction.hazardous).toBe(true);

    const onlyOperation = controlHazards({
      frontier: [],
      openInteractionCount: 0,
      unresolvedIntentCount: 2,
    });
    expect(onlyOperation.unresolvedOperationCount).toBe(2);
    expect(onlyOperation.hazardous).toBe(true);
  });
});

/** Reconciliation 投影的严重性；找不到即失败，避免把缺失读成通过。 */
function severityOf(facts: DerivedExecutionFacts, workPackageId: string): string {
  const view = facts.reconciliations.find((candidate) => candidate.workPackageId === workPackageId);
  if (view === undefined) {
    throw new Error(`没有 ${workPackageId} 的 reconciliation 投影`);
  }
  return view.severity;
}
