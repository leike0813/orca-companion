/**
 * IP-03：单步 Execution Frontier / 角色物化驱动测试
 * （change: `m2-wire-execution-runtime`，Owner: IP-03）。
 *
 * 覆盖受批准并行额度约束的角色调度，以及驱动的边界：
 * - 独立包可并行；单次推进只物化一个角色，同包已有活跃或无法核验的 Worker 时保持等待；
 * - 角色结论被接受后为同一 Work Package 派发下一个角色，且不建立第二个 Task；
 * - 派发结果未知时按原 OperationId 返回，lane 保持阻塞且不重发；
 * - 未授权、暂停、预算耗尽与陈旧 revision 只得到 `idle` / `blocked` 结论，绝不物化。
 *
 * 全部在真实 store（CAS、Operation Intent、预算计数）上加 fake `ExecutionBackend` 上验证：这些路径
 * 本就是故障与拒绝路径，不需要真实 Orca，也不需要真实 Worker。
 */

import { afterEach, expect, test } from 'vitest';
import { openCoordinationStore } from '../../src/adapters/storage/coordination-store.js';
import { branchIntegrationReconciliationStore } from '../../src/application/integration-reconciliation.js';

import { laneKeyOf, type OperationIntent } from '../../src/application/dto/operation-intent.js';
import type {
  CoordinationScopeId,
  DispatchId,
  OperationId,
  WorkerTaskId,
  WorkPackageId,
} from '../../src/application/dto/identity.js';
import type { ExecutionQueryResult, OperationOutcome } from '../../src/application/dto/operation-outcome.js';
import {
  advanceExecution,
  consumedBudgetForWorkPackage,
  materializeOperationIdsFor,
  revisionPlannerFacts,
  type AdvanceExecutionInput,
  type AdvanceRoleDispatch,
} from '../../src/application/execution/advance-execution.js';
import { noExecutionObservations, type ExecutionObservationFacts } from '../../src/application/execution/execution-view.js';
import { workPackageComment, worktreeNameFor } from '../../src/application/materialize-work-package.js';
import type {
  ExecutionBackend,
  ExecutionMutation,
  ExecutionOperation,
  ExecutionScope,
  WorktreeSummary,
} from '../../src/application/ports/execution-backend.js';
import { workPackageBudgetKey } from '../../src/domain/dispatch-candidate.js';
import type { CanonicalHeadFacts } from '../../src/domain/git-integration-policy.js';
import { DEFAULT_EXECUTION_LIMITS, budgetFromLimits } from '../../src/domain/planning/budget-policy.js';
import type { ExecutionGraph } from '../../src/domain/planning/execution-graph.js';
import type { ExecutionAuthorizationManifest } from '../../src/domain/planning/execution-authorization.js';
import { modelReauthorizationManifest } from '../../src/application/planning/authorization-service.js';
import type { TaskEnvelope } from '../../src/domain/task-contract.js';
import {
  EXECUTION_AUTHORIZATION_ID,
  EXECUTION_RUN_ID,
  createExecutionScopeHarness,
  executionManifest,
  executionWorkPackage,
  type ExecutionScopeHarness,
} from '../support/execution-harness.js';

const WP = 'wp-a' as WorkPackageId;
const BASELINE_HEAD = 'head-1';
/** Authorization Manifest 里的 canonical 分支名（`executionManifest()`）。 */
const CANONICAL_BRANCH = 'main';
const AUTHORITIES: ExecutionAuthorizationManifest['permissions'] = {
  planner: true,
  implementation: true,
  validator: true,
  finalizer: true,
  gitIntegration: false,
  dependencyChanges: false,
};

/** 归属成立时的 canonical HEAD 事实：HEAD 仍等于授权 baseline。 */
const ATTRIBUTED_HEAD: CanonicalHeadFacts = {
  canonicalHead: BASELINE_HEAD,
  authorizedBaselineHead: BASELINE_HEAD,
  canonicalWorktreeDirty: false,
  lastIntegrationExpectedHead: null,
};

const harnesses: ExecutionScopeHarness[] = [];

type WorkPackageNode = ExecutionGraph['workPackages'][number];

function scenario(options?: {
  readonly workPackages?: readonly WorkPackageNode[];
  readonly limits?: ExecutionAuthorizationManifest['limits'];
}): ExecutionScopeHarness {
  const harness = createExecutionScopeHarness(options);
  harnesses.push(harness);
  return harness;
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.close();
  }
});

/* -------------------------------------------------------------------------- */
/* fake ExecutionBackend                                                       */
/* -------------------------------------------------------------------------- */

type Call =
  | { readonly kind: 'query'; readonly operation: ExecutionOperation }
  | { readonly kind: 'mutate'; readonly operation: ExecutionMutation; readonly scope: ExecutionScope };

/** 记录型 fake backend：默认成功，可按调用序号注入拒绝或 unknown；建立出的 worktree 绑定 baseline。 */
function fakeBackend(script: {
  readonly worktrees?: readonly WorktreeSummary[];
  /**
   * canonical 分支当前的尖端。
   *
   * Orca 的 `--base-branch` 接受 ref 或 commit：传分支名时新 worktree 落在该分支尖端，传 commit 时
   * 落在那个 commit。fake 照这个语义推导 head，因此「拿 canonical 分支当 base」在集成前移之后必然
   * 核验失败，而按授权 baseline 建立则始终通过。
   */
  readonly canonicalBranchHead?: string;
  readonly mutating?: (call: number, mutation: ExecutionMutation) => OperationOutcome<unknown> | undefined;
  readonly queryResult?: (call: number, query: unknown) => ExecutionQueryResult | undefined;
}): { readonly backend: ExecutionBackend; readonly calls: readonly Call[] } {
  const calls: Call[] = [];
  let worktrees = [...(script.worktrees ?? [])];
  let mutations = 0;
  let taskCreates = 0;
  let worktreeCreates = 0;

  const backend: ExecutionBackend = {
    query: (input) => {
      calls.push({ kind: 'query', operation: input });
      const injected = script.queryResult?.(calls.length, input);
      if (injected !== undefined) {
        return Promise.resolve(injected);
      }
      if (input.operation === 'worktree-list') {
        return Promise.resolve({
          kind: 'accepted',
          value: {
            worktrees,
            totalCount: worktrees.length,
            truncated: false,
            hostScope: { hostIds: ['local'], omittedHostIds: [] },
          },
        });
      }
      return Promise.resolve({ kind: 'rejected', code: 'unregistered_fake_query', message: 'fake 未登记该查询' });
    },
    mutate: (input, scope) => {
      calls.push({ kind: 'mutate', operation: input, scope });
      mutations += 1;
      const injected = script.mutating?.(mutations, input);
      if (injected !== undefined) {
        return Promise.resolve(injected);
      }
      if (input.operation === 'worktree-create') {
        worktreeCreates += 1;
        const workPackageId = input.comment?.slice('workPackageId='.length) ?? 'wp-a';
        const worktreeId = `wt-created-${String(worktreeCreates)}`;
        worktrees = [
          ...worktrees,
          {
            worktreeId,
            path: `/tmp/worktrees/${workPackageId}`,
            branch: `refs/heads/${workPackageId}`,
            head: (input.baseBranch ?? 'main') === CANONICAL_BRANCH
              ? (script.canonicalBranchHead ?? BASELINE_HEAD)
              : input.baseBranch ?? BASELINE_HEAD,
            displayName: input.name ?? worktreeNameFor(workPackageId as WorkPackageId),
            comment: input.comment ?? null,
            isMainWorktree: false,
          },
        ];
        return Promise.resolve({
          kind: 'accepted',
          operation: { operationId: scope.operationId, target: scope.target },
          value: { worktreeId },
        });
      }
      if (input.operation === 'task-create') {
        taskCreates += 1;
        return Promise.resolve({
          kind: 'accepted',
          operation: { operationId: scope.operationId, target: scope.target },
          value: { id: `orca-task-${String(taskCreates)}`, spec: input.spec },
        });
      }
      if (input.operation === 'worker-start') {
        return Promise.resolve({
          kind: 'accepted',
          operation: { operationId: scope.operationId, target: scope.target },
          value: { taskId: input.taskId, dispatchId: `dispatch-${String(taskCreates)}`, state: 'ready' },
        });
      }
      return Promise.resolve({
        kind: 'accepted',
        operation: { operationId: scope.operationId, target: scope.target },
        value: null,
      });
    },
  };
  return { backend, calls };
}

function mutationsOf(calls: readonly Call[]): readonly ExecutionMutation[] {
  return calls.filter((call): call is Extract<Call, { kind: 'mutate' }> => call.kind === 'mutate').map((call) => call.operation);
}

function mutationScopesOf(calls: readonly Call[]): readonly ExecutionScope[] {
  return calls.filter((call): call is Extract<Call, { kind: 'mutate' }> => call.kind === 'mutate').map((call) => call.scope);
}

/* -------------------------------------------------------------------------- */
/* 派发装配                                                                    */
/* -------------------------------------------------------------------------- */

function roleDispatch(input: {
  readonly role: TaskEnvelope['role'];
  readonly workPackageId?: WorkPackageId;
  readonly attemptId: string;
  readonly workerTaskId?: string;
  readonly requiredBudgetField?: AdvanceRoleDispatch['requiredBudgetField'];
}): AdvanceRoleDispatch {
  const workPackageId = input.workPackageId ?? WP;
  return {
    launchId: `worker-launch-${input.attemptId}`,
    authorizationId: EXECUTION_AUTHORIZATION_ID,
    authorizationVersion: 1,
    workerProfileRef: `profile-${input.role}`,
    taskEnvelope: {
      schemaVersion: 1,
      workerTaskId: (input.workerTaskId ?? 'orca-task-1') as WorkerTaskId,
      dispatchId: `dispatch-candidate-${input.attemptId}` as DispatchId,
      attemptId: input.attemptId,
      role: input.role,
      taskContract: {
        schemaVersion: 1,
        workPackageId,
        graphGeneration: 1,
        dependencies: [],
        scopeEnvelope: { include: ['src'], exclude: [] },
        baselineHead: BASELINE_HEAD,
        authority: AUTHORITIES,
        budget: budgetFromLimits(DEFAULT_EXECUTION_LIMITS),
        acceptanceEvidence: [{ evidenceKind: 'command', coveredPaths: ['src'] }],
        resultSchemaVersion: 1,
      },
      instructions: [],
      specBinding: input.role === 'planner' ? null : {
        provider: 'openspec',
        relativePath: `openspec/changes/${workPackageId}`,
        contentDigest: 'digest-1',
        providerVersion: '1',
        contractRevision: 1,
        trackingRevision: 1,
      },
      ...(input.role === 'planner' ? { specificationUnitPath: `openspec/changes/${workPackageId}` } : {}),
      workspace: { worktreeId: 'unbound', canonicalWorktree: '/work', relativePath: '.' },
      authority: AUTHORITIES,
      budget: { implementationAttempts: 2, validatorRepairs: 2, recoveries: 1 },
      expectedEvidence: [{ evidenceKind: 'command', coveredPaths: ['src'] }],
    },
    workerLaunch: { kind: 'orca_managed', agent: 'codex', model: 'minimax-cn/MiniMax-M3' },
    consumerGeneration: 1,
    backendIdentityRef: 'identity-ref',
    timeoutMs: 5_000,
    requiredBudgetField: input.requiredBudgetField ?? null,
  };
}

function advanceInput(
  harness: ExecutionScopeHarness,
  extra: {
    readonly roles: Partial<Record<TaskEnvelope['role'], AdvanceRoleDispatch>>;
    readonly observations?: ExecutionObservationFacts;
    readonly expectedRevision?: number;
    readonly canonicalHead?: CanonicalHeadFacts;
    readonly writer?: AdvanceExecutionInput['writer'];
  },
): Omit<AdvanceExecutionInput, 'backend'> {
  return {
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: extra.writer ?? harness.writer,
    expectedRevision: extra.expectedRevision ?? harness.revision(),
    canonicalHead: extra.canonicalHead ?? ATTRIBUTED_HEAD,
    observations: extra.observations ?? { ...noExecutionObservations('test-no-observation'), workersEnumerated: true, unavailableReasons: [] },
    roles: extra.roles,
  };
}

/** 已提交的角色结论：一行 Delivery 结算，`role` 决定 Frontier 走到哪一步。 */
function settle(harness: ExecutionScopeHarness, input: {
  readonly role: TaskEnvelope['role'];
  readonly workerTaskId: string;
  readonly dispatchId: string;
  readonly attemptId: string;
  readonly contractRevision: number;
}): void {
  const recorded = harness.store.transact({
    kind: 'record-delivery-settlement',
    coordinationScopeId: harness.scopeId,
    expectedRevision: harness.revision(),
    writer: harness.writer,
    dedupeKey: `${input.role}:${input.dispatchId}`,
    deliveryId: `delivery:${input.dispatchId}`,
    runId: EXECUTION_RUN_ID,
    consumerGeneration: 1,
    workerTaskId: input.workerTaskId as WorkerTaskId,
    dispatchId: input.dispatchId as DispatchId,
    attemptId: input.attemptId,
    role: input.role,
    contractRevision: input.contractRevision,
    orcaResultRef: `${input.workerTaskId}#accepted`,
    // 角色结论默认是成功：严格 outcome 由 execution-view 的专项用例覆盖。
    outcome: 'succeeded',
    ...(input.role === 'validator' ? { validationVerdict: 'passed' as const } : {}),
  });
  if (recorded.kind === 'rejected') {
    throw new Error(`无法记录结算：${recorded.message}`);
  }
}

function acceptPlannerResult(
  harness: ExecutionScopeHarness,
  suffix = '',
  contractRevision = 0,
): void {
  settle(harness, {
    role: 'planner',
    workerTaskId: `orca-task-1${suffix}`,
    // Orca 分配的物理 Dispatch 与物化时信封里的逻辑候选身份不同。
    dispatchId: `dispatch-1${suffix}`,
    attemptId: 'attempt-1',
    contractRevision,
  });
}

/** Planner 结果已被接受时的真实观察：那条 Dispatch 已经退出。 */
function plannerExited(dispatchId = 'dispatch-planner'): ExecutionObservationFacts {
  return {
    workersEnumerated: true,
    workers: [{ dispatchId, taskId: 'orca-task-1', workerState: 'succeeded', terminalState: null }],
    worktreePaths: new Map(),
    unavailableReasons: [],
    finalizer: null,
  };
}

function derivePlannerIds(harness: ExecutionScopeHarness, workPackageId: WorkPackageId = WP) {
  return materializeOperationIdsFor({
    coordinationScopeId: harness.scopeId,
    graphId: harness.graphId,
    graphGeneration: harness.generation,
    workPackageId,
    role: 'planner',
    contractRevision: 0,
    attemptId: 'attempt-1',
    workerTaskId: 'orca-task-1',
  });
}

/* -------------------------------------------------------------------------- */
/* 首个候选                                                                    */
/* -------------------------------------------------------------------------- */

test('Task 已建立但启动明确拒绝时，续办复用 Task；启动受理后不重复派发', async () => {
  const harness = scenario();
  let refused = false;
  const execution = fakeBackend({ mutating: (_call, mutation) => {
    if (mutation.operation !== 'worker-start' || refused) return undefined;
    refused = true;
    return { kind: 'rejected', code: 'terminal_not_ready', message: 'terminal not ready' };
  } });
  const input = () => ({ ...advanceInput(harness, {
    roles: { planner: roleDispatch({ role: 'planner', attemptId: 'attempt-1' }) },
  }), backend: execution.backend });
  expect((await advanceExecution(input())).kind).toBe('idle');
  expect((await advanceExecution(input())).kind).toBe('progressed');
  const mutations = mutationsOf(execution.calls);
  expect(mutations.filter(item => item.operation === 'task-create')).toHaveLength(1);
  expect(mutations.filter(item => item.operation === 'worker-start').map(item =>
    item.operation === 'worker-start' ? item.taskId : null)).toEqual(['orca-task-1', 'orca-task-1']);
  expect((await advanceExecution(input())).kind).toBe('idle');
  expect(mutationsOf(execution.calls)).toHaveLength(mutations.length);
});

test.each([1, 2, 3, 5])('独立工作包按批准额度 %i 并行，未观察的派发仍占位', async (limit) => {
  const nodes = Array.from({ length: limit + 1 }, (_, index) => executionWorkPackage(`wp-${String(index)}`));
  const harness = scenario({ workPackages: nodes,
    limits: { ...DEFAULT_EXECUTION_LIMITS, maxActiveWorkPackages: limit } });
  const execution = fakeBackend({});
  for (let index = 0; index < limit; index += 1) {
    const candidate = nodes[index]!;
    const result = await advanceExecution({
      ...advanceInput(harness, { roles: { planner: roleDispatch({
        role: 'planner', workPackageId: candidate.workPackageId, attemptId: `attempt-${String(index)}`,
        workerTaskId: `orca-task-${String(index + 1)}`,
      }) } }),
      backend: execution.backend,
    });
    expect(result).toMatchObject({ kind: 'progressed', workPackageId: candidate.workPackageId });
  }
  const extra = nodes[limit]!;
  const blocked = await advanceExecution({
    ...advanceInput(harness, { roles: { planner: roleDispatch({
      role: 'planner', workPackageId: extra.workPackageId, attemptId: 'extra',
      workerTaskId: `orca-task-${String(limit + 1)}`,
    }) } }),
    backend: execution.backend,
  });
  expect(blocked.kind).toBe('idle');
  expect(mutationsOf(execution.calls).filter(mutation => mutation.operation === 'worker-start')).toHaveLength(limit);
  const lanes = harness.store.query({ kind: 'work-package-lanes', coordinationScopeId: harness.scopeId });
  expect(lanes.kind === 'work-package-lanes' ? lanes.reservations : []).toHaveLength(limit);
}, 15_000);

test('包占位在 CAS 竞争、重启与降低额度后不超额或丢失', () => {
  const harness = scenario({ workPackages: ['wp-a', 'wp-b', 'wp-c'].map(id => executionWorkPackage(id)),
    limits: { ...DEFAULT_EXECUTION_LIMITS, maxActiveWorkPackages: 2 } });
  const reserve = (id: string, revision: number) => harness.store.transact({
    kind: 'reserve-work-package-lane', coordinationScopeId: harness.scopeId, expectedRevision: revision,
    writer: harness.writer, graphId: harness.graphId, generation: harness.generation,
    workPackageId: id as WorkPackageId, operationId: `lane:${id}` as OperationId,
    authorizationId: EXECUTION_AUTHORIZATION_ID, authorizationVersion: 1, baselineHead: BASELINE_HEAD,
  });
  const revision = harness.revision();
  expect(reserve('wp-a', revision).kind).toBe('committed');
  expect(reserve('wp-b', revision).kind).toBe('rejected');
  expect(reserve('wp-b', harness.revision()).kind).toBe('committed');
  expect(reserve('wp-c', harness.revision()).kind).toBe('rejected');
  const reopened = openCoordinationStore({ databasePath: harness.databasePath });
  expect(reopened.kind).toBe('opened');
  if (reopened.kind !== 'opened') return;
  try {
    const lanes = reopened.store.query({ kind: 'work-package-lanes', coordinationScopeId: harness.scopeId });
    expect(lanes.kind === 'work-package-lanes' ? lanes.reservations : []).toHaveLength(2);
  } finally { reopened.store.close(); }
  const lowered = harness.store.transact({ kind: 'record-authorization', coordinationScopeId: harness.scopeId,
    expectedRevision: harness.revision(), writer: harness.writer, authorizationId: 'auth-lower',
    authorizationVersion: 2, manifestVersion: 4, fingerprint: 'lower-limit', approvalRef: 'lower-approval',
    manifest: { ...harness.authorization().manifest,
      limits: { ...harness.limits, maxActiveWorkPackages: 1 } },
  });
  expect(lowered.kind).toBe('committed');
  expect(reserve('wp-a', harness.revision()).kind).toBe('committed');
  const lanes = harness.store.query({ kind: 'work-package-lanes', coordinationScopeId: harness.scopeId });
  expect(lanes.kind === 'work-package-lanes' ? lanes.reservations : []).toHaveLength(2);
  expect(harness.store.transact({ kind: 'release-work-package-lane', coordinationScopeId: harness.scopeId,
    expectedRevision: harness.revision(), writer: harness.writer, graphId: harness.graphId, generation: harness.generation,
    workPackageId: WP, proofOperationId: 'no-proof' as OperationId }).kind).toBe('rejected');
});

test('已有活跃 Worker 的 Work Package 让本轮不再物化', async () => {
  const harness = scenario({ workPackages: [executionWorkPackage('wp-a')] });
  // 一条已登记的中断 Segment 加一条仍在运行的 Worker 观察：它是「活跃」而不是「不可核验」。
  const segment = harness.store.transact({
    kind: 'record-session-segment',
    coordinationScopeId: harness.scopeId,
    expectedRevision: harness.revision(),
    writer: harness.writer,
    segmentId: 'segment-1' as never,
    workPackageId: WP,
    role: 'planner',
    workerTaskId: 'orca-task-1' as WorkerTaskId,
    dispatchId: 'dispatch-live' as DispatchId,
    attemptId: 'attempt-1',
    sessionBindingId: 'binding-1',
    lastTranscriptRef: 'transcript:1',
    terminalReceiptRef: null,
    transcriptReferenceable: true,
    verifiable: true,
  });
  expect(segment.kind).toBe('committed');

  const execution = fakeBackend({});
  const result = await advanceExecution({
    ...advanceInput(harness, {
    roles: { planner: { ...roleDispatch({ role: 'planner', attemptId: 'attempt-1' }), authorizationId: 'auth-2', authorizationVersion: 2 } },
      observations: {
        workersEnumerated: true,
        workers: [{ dispatchId: 'dispatch-live', taskId: 'orca-task-1', workerState: 'running', terminalState: null }],
        worktreePaths: new Map(),
        unavailableReasons: [],
        finalizer: null,
      },
    }),
    backend: execution.backend,
  });

  expect(result.kind).toBe('idle');
  if (result.kind === 'idle') {
    expect(result.blockers.some(entry => entry.includes('wp-a'))).toBe(true);
  }
  expect(execution.calls).toHaveLength(0);
});

test('依赖未满足时不派发，Frontier 现状如实成为 blocker', async () => {
  const harness = scenario({ workPackages: [executionWorkPackage('wp-a', ['wp-b'])] });
  const execution = fakeBackend({});
  const result = await advanceExecution({
    // 派发候选必须声明当前授权：过期的授权身份先被模型绑定门禁挡住，根本走不到角色权限判定。
    ...advanceInput(harness, {
      roles: {
        planner: {
          ...roleDispatch({ role: 'planner', attemptId: 'attempt-1' }),
          authorizationId: 'auth-2',
          authorizationVersion: 2,
        },
      },
    }),
    backend: execution.backend,
  });

  expect(result.kind).toBe('idle');
  if (result.kind === 'idle') {
    expect(result.blockers).toEqual(['frontier:wp-a:waiting']);
  }
  expect(execution.calls).toHaveLength(0);
});

/* -------------------------------------------------------------------------- */
/* 后继角色                                                                    */
/* -------------------------------------------------------------------------- */

test('角色结论被接受后为同一 Work Package 派发新的角色 Task', async () => {
  const harness = scenario({ workPackages: [executionWorkPackage('wp-a')] });
  const execution = fakeBackend({});

  const first = await advanceExecution({
    ...advanceInput(harness, { roles: { planner: roleDispatch({ role: 'planner', attemptId: 'attempt-1' }) } }),
    backend: execution.backend,
  });
  expect(first.kind).toBe('progressed');
  acceptPlannerResult(harness);
  const beforeSecond = mutationsOf(execution.calls).length;

  const second = await advanceExecution({
    ...advanceInput(harness, {
      roles: {
        planner: roleDispatch({ role: 'planner', attemptId: 'attempt-1' }),
        implementation: roleDispatch({
          role: 'implementation',
          attemptId: 'attempt-2',
          workerTaskId: 'orca-task-2',
          requiredBudgetField: 'implementationAttempts',
        }),
      },
      observations: plannerExited(),
    }),
    backend: execution.backend,
  });

  expect(second.kind).toBe('progressed');
  if (second.kind !== 'progressed') {
    return;
  }
  expect(second.workPackageId).toBe('wp-a');
  expect(second.role).toBe('implementation');

  const after = mutationsOf(execution.calls).slice(beforeSecond);
  expect(after.map((mutation) => mutation.operation)).toEqual(['task-create', 'worker-start']);
  expect(mutationsOf(execution.calls).filter((mutation) => mutation.operation === 'task-create')).toHaveLength(2);
  const starts = mutationsOf(execution.calls).filter((mutation) => mutation.operation === 'worker-start');
  expect(starts).toHaveLength(2);
  expect(starts.map((start) => start.operation === 'worker-start' ? start.taskId : null)).toEqual(['orca-task-1', 'orca-task-2']);

  // 后继角色是新的 Attempt，因此有独立身份：两个角色的 worker-start 不共用 OperationId。
  const scopes = mutationScopesOf(execution.calls).filter((scope) => scope.target.kind === 'worker-task');
  const secondStartId = materializeOperationIdsFor({
    coordinationScopeId: harness.scopeId,
    graphId: harness.graphId,
    graphGeneration: harness.generation,
    workPackageId: WP,
    role: 'implementation',
    contractRevision: 1,
    attemptId: 'attempt-2',
    workerTaskId: 'orca-task-2',
  }).workerStart;
  expect(scopes.at(-1)?.operationId).toBe(secondStartId);
  // 派发身份绑定当前授权：后代角色用的仍是同一份 Authorization 与 Run。
  const authority = scopes.at(-1)?.authority;
  expect(authority?.kind === 'execution_coordination' ? authority : null).toMatchObject({
    graphGeneration: harness.generation,
    authorizationId: EXECUTION_AUTHORIZATION_ID,
    runId: EXECUTION_RUN_ID,
  });
});

/* -------------------------------------------------------------------------- */
/* 结果未知                                                                    */
/* -------------------------------------------------------------------------- */

test('派发结果未知时返回原 OperationId，lane 保持阻塞且不重发同一个副作用', async () => {
  const harness = scenario({ workPackages: [executionWorkPackage('wp-a')] });
  // task-create 丢失回执；对账只能证明请求存在（pending），不构成「副作用未发生」。
  const execution = fakeBackend({
    mutating: (call, mutation) =>
      call === 2 && mutation.operation === 'task-create'
        ? {
            kind: 'unknown',
            operation: {
              operationId: 'irrelevant-backend-id',
              backendRequestId: 'req-lost',
              target: { kind: 'task', id: WP },
            },
            reason: 'response_lost',
          }
        : undefined,
    queryResult: (_call, query) => {
      const operation = (query as ExecutionOperation).operation;
      return operation === 'request-show'
        ? { kind: 'accepted', value: { requestId: 'req-lost', state: 'pending' } }
        : undefined;
    },
  });

  const roles = { planner: roleDispatch({ role: 'planner', attemptId: 'attempt-1' }) };
  const first = await advanceExecution({ ...advanceInput(harness, { roles }), backend: execution.backend });

  const derived = derivePlannerIds(harness);
  expect(first.kind).toBe('unknown');
  if (first.kind === 'unknown') {
    expect(first.operationId).toBe(derived.task);
  }
  expect(mutationsOf(execution.calls).map((mutation) => mutation.operation)).toEqual([
    'worktree-create',
    'task-create',
  ]);

  // 已落盘的阻塞意图就是原 OperationId，lane 粒度与物化用例一致。
  const intents = harness.store.query({ kind: 'intents', coordinationScopeId: harness.scopeId });
  expect(intents.kind).toBe('intents');
  const blocked = intents.kind === 'intents' ? intents.intents.filter((intent) => intent.state === 'blocked') : [];
  expect(blocked).toHaveLength(1);
  expect(blocked[0]?.operationId).toBe(derived.task);
  expect(blocked[0]?.laneKey).toBe(laneKeyOf({ kind: 'task', id: WP }, 'materialize-task'));

  // 重启后同一候选的同一 lane 仍派生同一个 ID：未决意图的 ID 优先复用。
  const reused = materializeOperationIdsFor({
    coordinationScopeId: harness.scopeId,
    graphId: harness.graphId,
    graphGeneration: harness.generation,
    workPackageId: WP,
    role: 'planner',
    contractRevision: 0,
    attemptId: 'attempt-1',
    unresolvedIntents: blocked,
    workerTaskId: 'orca-task-1',
  });
  expect(reused).toEqual(derived);

  const before = mutationsOf(execution.calls).length;
  const second = await advanceExecution({ ...advanceInput(harness, { roles }), backend: execution.backend });
  expect(second.kind).toBe('idle');
  if (second.kind === 'idle') expect(second.blockers.some(entry => entry.includes('wp-a'))).toBe(true);
  // 没有第二次 mutation：lane 保持阻塞，重启后只按原身份对账。
  expect(mutationsOf(execution.calls).length).toBe(before);
});

test('Worker 列举不可用时不创建第二个角色资源', async () => {
  const harness = scenario({ workPackages: [executionWorkPackage('wp-a')] });
  const execution = fakeBackend({});
  const result = await advanceExecution({
    ...advanceInput(harness, {
      roles: { planner: roleDispatch({ role: 'planner', attemptId: 'attempt-1' }) },
      observations: noExecutionObservations('worker-list-unavailable'),
    }),
    backend: execution.backend,
  });
  expect(result.kind).toBe('idle');
  if (result.kind === 'idle') expect(result.blockers).toContain('worker-list:unverifiable');
  expect(mutationsOf(execution.calls)).toHaveLength(0);
});

/* -------------------------------------------------------------------------- */
/* worktree base                                                               */
/* -------------------------------------------------------------------------- */

test('canonical 经已归属集成推进后，新包直接以当前 HEAD 为基线', async () => {
  const harness = scenario({ workPackages: [executionWorkPackage('wp-a')] });
  const execution = fakeBackend({ canonicalBranchHead: 'head-2' });
  const dispatch = roleDispatch({ role: 'planner', attemptId: 'attempt-1' });
  const result = await advanceExecution({
    ...advanceInput(harness, {
      roles: { planner: { ...dispatch, taskEnvelope: { ...dispatch.taskEnvelope,
        taskContract: { ...dispatch.taskEnvelope.taskContract, baselineHead: 'head-2' },
      } } },
      canonicalHead: {
        canonicalHead: 'head-2', authorizedBaselineHead: BASELINE_HEAD,
        canonicalWorktreeDirty: false, lastIntegrationExpectedHead: 'head-2',
      },
    }),
    backend: execution.backend,
  });
  expect(result.kind).toBe('progressed');
  const creates = mutationsOf(execution.calls).filter(mutation => mutation.operation === 'worktree-create');
  expect(creates[0]?.operation === 'worktree-create' ? creates[0].baseBranch : null).toBe('head-2');
  expect(mutationsOf(execution.calls).filter(mutation => mutation.operation === 'task-create')).toHaveLength(1);
  const reconciliations = harness.store.query({ kind: 'baseline-reconciliations', coordinationScopeId: harness.scopeId });
  expect(reconciliations.kind === 'baseline-reconciliations' ? reconciliations.reconciliations : []).toEqual([]);
});

test('canonical 仍等于授权 baseline 时不登记基线补救，角色 Task 照常派发', async () => {
  const harness = scenario({ workPackages: [executionWorkPackage('wp-a')] });
  const execution = fakeBackend({});
  const result = await advanceExecution({
    ...advanceInput(harness, {
      roles: { planner: roleDispatch({ role: 'planner', attemptId: 'attempt-1' }) },
    }),
    backend: execution.backend,
  });

  expect(result.kind).toBe('progressed');
  const reconciliations = harness.store.query({
    kind: 'baseline-reconciliations',
    coordinationScopeId: harness.scopeId,
  });
  expect(
    reconciliations.kind === 'baseline-reconciliations' ? reconciliations.reconciliations : [],
  ).toEqual([]);
  expect(mutationsOf(execution.calls).filter((mutation) => mutation.operation === 'task-create')).toHaveLength(1);
});

/* -------------------------------------------------------------------------- */
/* 拒绝路径                                                                    */
/* -------------------------------------------------------------------------- */

test('未授权角色时不物化，结论只说明是哪一条准入规则拒绝了它', async () => {
  const harness = scenario({ workPackages: [executionWorkPackage('wp-a')] });
  // 新版本授权把 planner 收回：Scope 指针随记录推进，因此这是一份「有效但不允许该角色」的授权。
  const recorded = harness.store.transact({
    kind: 'record-authorization',
    coordinationScopeId: harness.scopeId,
    expectedRevision: harness.revision(),
    writer: harness.writer,
    authorizationId: 'auth-2',
    authorizationVersion: 2,
    manifestVersion: 4,
    fingerprint: 'fingerprint-2',
    approvalRef: 'approval-2',
    manifest: {
      ...executionManifest({ graphId: harness.graphId, generation: harness.generation }),
      permissions: { ...AUTHORITIES, planner: false },
    },
  });
  expect(recorded.kind).toBe('committed');

  const execution = fakeBackend({});
  const result = await advanceExecution({
    // Scope 指针已随第二份授权推进，候选必须声明这一份：过期的授权身份会先被模型绑定门禁挡住，
    // 根本走不到「角色未获授权」这条准入判定。断言不变，门禁也不放宽。
    ...advanceInput(harness, {
      roles: {
        planner: {
          ...roleDispatch({ role: 'planner', attemptId: 'attempt-1' }),
          authorizationId: 'auth-2',
          authorizationVersion: 2,
        },
      },
    }),
    backend: execution.backend,
  });

  expect(result.kind).toBe('idle');
  if (result.kind === 'idle') {
    expect(result.blockers).toContain('rejection:role_not_authorized');
  }
  expect(execution.calls).toHaveLength(0);
});

test('授权绑定的图与当前 Graph Version 不一致时不派发', async () => {
  const harness = scenario({ workPackages: [executionWorkPackage('wp-a')] });
  const recorded = harness.store.transact({
    kind: 'record-authorization',
    coordinationScopeId: harness.scopeId,
    expectedRevision: harness.revision(),
    writer: harness.writer,
    authorizationId: 'auth-2',
    authorizationVersion: 2,
    manifestVersion: 4,
    fingerprint: 'fingerprint-2',
    approvalRef: 'approval-2',
    // 批准绑定的是下一个 Graph Version：规划引用一旦前进，旧批准就不再适用。
    manifest: executionManifest({ graphId: harness.graphId, generation: harness.generation, graphVersion: 2 }),
  });
  expect(recorded.kind).toBe('committed');

  const execution = fakeBackend({});
  const result = await advanceExecution({
    ...advanceInput(harness, { roles: { planner: roleDispatch({ role: 'planner', attemptId: 'attempt-1' }) } }),
    backend: execution.backend,
  });

  expect(result.kind).toBe('idle');
  if (result.kind === 'idle') {
    expect(result.blockers).toEqual(['authorization:invalid']);
  }
  expect(execution.calls).toHaveLength(0);
});

test('控制状态非 active 时不物化', async () => {
  const harness = scenario({ workPackages: [executionWorkPackage('wp-a')] });
  const paused = harness.store.transact({
    kind: 'record-control-state',
    coordinationScopeId: harness.scopeId,
    expectedRevision: harness.revision(),
    writer: harness.writer,
    controlState: 'paused',
  });
  expect(paused.kind).toBe('committed');

  const execution = fakeBackend({});
  const result = await advanceExecution({
    ...advanceInput(harness, { roles: { planner: roleDispatch({ role: 'planner', attemptId: 'attempt-1' }) } }),
    backend: execution.backend,
  });

  expect(result.kind).toBe('idle');
  if (result.kind === 'idle') {
    expect(result.blockers).toContain('rejection:control_state_not_active');
  }
  expect(execution.calls).toHaveLength(0);
});

test('预算耗尽时不物化', async () => {
  const harness = scenario({ workPackages: [executionWorkPackage('wp-a')] });
  const execution = fakeBackend({});
  const roles = {
    planner: roleDispatch({ role: 'planner', attemptId: 'attempt-1' }),
    implementation: roleDispatch({
      role: 'implementation',
      attemptId: 'attempt-2',
      requiredBudgetField: 'implementationAttempts',
    }),
  };

  const first = await advanceExecution({ ...advanceInput(harness, { roles }), backend: execution.backend });
  expect(first.kind).toBe('progressed');
  acceptPlannerResult(harness);

  // 实现候选的额度已经用完：判定发生在任何副作用之前。
  const consumed = harness.store.transact({
    kind: 'consume-budget',
    coordinationScopeId: harness.scopeId,
    expectedRevision: harness.revision(),
    writer: harness.writer,
    budgetKey: workPackageBudgetKey(WP, 'implementationAttempts'),
    approvedLimitRef: 'limit-1',
    amount: DEFAULT_EXECUTION_LIMITS.implementationAttempts,
  });
  expect(consumed.kind).toBe('committed');

  const before = mutationsOf(execution.calls).length;
  const result = await advanceExecution({
    ...advanceInput(harness, { roles, observations: plannerExited() }),
    backend: execution.backend,
  });

  expect(result.kind).toBe('idle');
  if (result.kind === 'idle') {
    expect(result.blockers.some(entry => entry.includes(workPackageBudgetKey(WP, 'implementationAttempts')))).toBe(true);
  }
  expect(mutationsOf(execution.calls).length).toBe(before);
});

test('调用方的 revision 已过期时停在 blocker，且不触碰 Orca', async () => {
  const harness = scenario({ workPackages: [executionWorkPackage('wp-a')] });
  const execution = fakeBackend({});
  const result = await advanceExecution({
    ...advanceInput(harness, {
      roles: { planner: roleDispatch({ role: 'planner', attemptId: 'attempt-1' }) },
      expectedRevision: harness.revision() + 1,
    }),
    backend: execution.backend,
  });

  expect(result.kind).toBe('blocked');
  if (result.kind === 'blocked') {
    expect(result.code).toBe('stale_revision');
    expect(result.laneKey).toBe('scope-1' as CoordinationScopeId);
  }
  expect(execution.calls).toHaveLength(0);
});

test('非 Execution Coordination Lease 持有者不推进，也不触碰 Orca', async () => {
  const harness = scenario({ workPackages: [executionWorkPackage('wp-a')] });
  const execution = fakeBackend({});
  const result = await advanceExecution({
    ...advanceInput(harness, {
      roles: { planner: roleDispatch({ role: 'planner', attemptId: 'attempt-1' }) },
      writer: { ...harness.writer, coordinatorSessionId: 'session-b' as never },
    }),
    backend: execution.backend,
  });

  expect(result.kind).toBe('idle');
  if (result.kind === 'idle') {
    expect(result.blockers).toEqual(['execution-lease:not-holder']);
  }
  expect(execution.calls).toHaveLength(0);
});

/* -------------------------------------------------------------------------- */
/* 稳定身份                                                                    */
/* -------------------------------------------------------------------------- */

test('五个分步骤的 OperationId 由候选事实稳定派生，且未决 lane 的 ID 优先复用', () => {
  const base = {
    coordinationScopeId: 'scope-1' as CoordinationScopeId,
    graphId: 'graph-1' as never,
    graphGeneration: 1,
    workPackageId: WP,
    role: 'implementation' as const,
    contractRevision: 1,
    attemptId: 'attempt-2',
  };

  const first = materializeOperationIdsFor(base);
  expect(materializeOperationIdsFor(base)).toEqual(first);
  expect(new Set(Object.values(first)).size).toBe(5);
  for (const id of Object.values(first)) {
    expect(id).toContain('scope-1');
  }
  expect(first.workerStart).toContain('attempt-2');

  // 只要有一个组成事实不同，就必须是一组新身份——身份不是「第几次调用」，也不是时钟。
  const otherAttempt = materializeOperationIdsFor({ ...base, attemptId: 'attempt-3' });
  expect(otherAttempt.workerStart).not.toBe(first.workerStart);
  expect(otherAttempt.task).toBe(first.task);
  expect(otherAttempt.worktree).toBe(first.worktree);
  expect(otherAttempt.workerPrepare).not.toBe(first.workerPrepare);
  expect(materializeOperationIdsFor({ ...base, contractRevision: 2 }).worktree).not.toBe(first.worktree);

  // 同一 lane 上的未决意图优先复用其 OperationId：对账只能按原身份进行。
  const pending: OperationIntent = {
    coordinationScopeId: base.coordinationScopeId,
    operationId: 'op-pending-worker-start' as OperationId,
    target: { kind: 'worker-task', id: WP },
    operationCategory: 'materialize-worker-start',
    laneKey: laneKeyOf({ kind: 'worker-task', id: WP }, 'materialize-worker-start'),
    expectedRevision: 1,
    expectedHead: null,
    initiatedBy: { coordinatorSessionId: 'session-a' as never, runtimeIncarnationId: 'inc-a' as never },
    state: 'pending',
    outcomeClass: null,
    backendRequestId: null,
    terminalHandle: null,
    blockingReason: null,
    createdAt: 1,
    settledAt: null,
  };
  const reused = materializeOperationIdsFor({ ...base, unresolvedIntents: [pending] });
  expect(reused.workerStart).toBe('op-pending-worker-start');
  expect(reused.worktree).toBe(first.worktree);
  expect(reused.task).toBe(first.task);
  // 已结算的意图不是「可能已经发生」的证据，不参与复用。
  const settled = materializeOperationIdsFor({
    ...base,
    unresolvedIntents: [{ ...pending, state: 'settled' }],
  });
  expect(settled).toEqual(first);

  const rejected = { ...pending, operationId: first.worktree, state: 'settled' as const, outcomeClass: 'rejected' as const };
  const retry = materializeOperationIdsFor({ ...base, settledRejectedIntents: [rejected] });
  expect(retry.worktree).toBe(`${first.worktree}:retry:1`);
  expect(retry.task).toBe(first.task);
  expect(materializeOperationIdsFor({ ...base, unresolvedIntents: [pending], settledRejectedIntents: [rejected] }).workerStart).toBe(pending.operationId);
});

/* -------------------------------------------------------------------------- */
/* 在途 Graph Patch 修订：持有不因旧 Worker 结算而释放，满足条件后才重跑 Planner   */
/* -------------------------------------------------------------------------- */

/** 一条与图版本同事务写下的补丁持有，再加上被替换的内容版本（准备阶段的事实）。 */
function holdRevision(harness: ExecutionScopeHarness, priorContractRevision: number): void {
  const recorded = harness.store.transact({
    kind: 'record-revision-hold',
    coordinationScopeId: harness.scopeId,
    expectedRevision: harness.revision(),
    writer: harness.writer,
    workPackageId: WP,
    source: 'graph_patch',
    sourceRef: 'patch-1',
  });
  expect(recorded.kind).toBe('committed');
  const prepared = harness.store.transact({
    kind: 'prepare-revision-hold',
    coordinationScopeId: harness.scopeId,
    expectedRevision: harness.revision(),
    writer: harness.writer,
    workPackageId: WP,
    sourceRef: 'patch-1',
    priorContractRevision,
  });
  expect(prepared.kind).toBe('committed');
}

/** 一条已签发的 Planner 派发：物化绑定加它的 Orca Task 身份。 */
function issuePlannerDispatch(
  harness: ExecutionScopeHarness,
  attemptId = 'attempt-1',
  suffix = '',
): void {
  const recorded = harness.store.transact({
    kind: 'record-materialization-binding',
    coordinationScopeId: harness.scopeId,
    expectedRevision: harness.revision(),
    writer: harness.writer,
    workPackageId: WP,
    role: 'planner',
    workerTaskId: `orca-task-1${suffix}` as WorkerTaskId,
    authorizationId: EXECUTION_AUTHORIZATION_ID,
    authorizationVersion: 1,
    workerProfileRef: 'profile-planner',
    dispatchId: `dispatch-planner${suffix}` as DispatchId,
    attemptId,
    worktreeId: 'worktree-1',
    // Planner 首次创建规格：绑定不带 Spec Binding，只记固定目标路径。
    specBinding: null,
    specificationUnitPath: 'openspec/changes/wp-a',
    orcaTaskId: `orca-task-1${suffix}`,
    launchId: `worker-launch-1${suffix}`,
    creationOperationId: `op-task-1${suffix}` as OperationId,
  });
  expect(recorded.kind).toBe('committed');
}

function deniedRevisionPlanner(blockers: readonly string[]): string | null {
  return blockers.find((blocker) => blocker.startsWith('revision-planner:wp-a:')) ?? null;
}

test('模型重新授权后，既有 Task 沿原绑定继续派发，无绑定的授权声明被拒绝', async () => {
  const harness = scenario({ workPackages: [executionWorkPackage('wp-a')] });
  // 已物化的 Planner Task 固定在第一次授权下。
  issuePlannerDispatch(harness);
  const original = harness.authorization();
  const rebuilt = modelReauthorizationManifest({
    base: original.manifest,
    workerProfiles: original.manifest.workerProfiles,
    recoveryUtilityProfile: original.manifest.recoveryUtilityProfile,
    graphVersion: original.manifest.graph.version,
  });
  expect(rebuilt.kind).toBe('proposed');
  if (rebuilt.kind !== 'proposed') return;
  // 与基座同样的写法：授权指针换到第二份授权，内容只改模型绑定。
  const approved = harness.store.transact({
    kind: 'record-authorization',
    coordinationScopeId: harness.scopeId,
    expectedRevision: harness.revision(),
    writer: harness.writer,
    authorizationId: 'auth-2',
    authorizationVersion: 2,
    manifestVersion: rebuilt.manifest.manifestVersion,
    fingerprint: rebuilt.fingerprint,
    manifest: rebuilt.manifest,
    approvalRef: 'approval-auth-2',
  });
  expect(approved.kind).toBe('committed');

  // 原 Task 仍按创建时的授权与 profile 推进：新授权不追溯改变在途运行依据。
  const inherited = await advanceExecution({
    ...advanceInput(harness, {
      roles: {
        planner: {
          ...roleDispatch({ role: 'planner', attemptId: 'attempt-1', workerTaskId: 'orca-task-1' }),
          authorizationId: EXECUTION_AUTHORIZATION_ID,
          authorizationVersion: 1,
        },
      },
    }),
    backend: fakeBackend({}).backend,
  });
  expect(inherited.kind).not.toBe('blocked');

  // 没有任何绑定或授权记录支持的授权声明必须 fail closed。
  const unverifiable = await advanceExecution({
    ...advanceInput(scenario(), {
      roles: {
        planner: {
          ...roleDispatch({ role: 'planner', attemptId: 'attempt-9', workerTaskId: 'orca-task-9' }),
          authorizationId: 'auth-unknown',
          authorizationVersion: 9,
          workerProfileRef: 'profile-unknown',
        },
      },
    }),
    backend: fakeBackend({}).backend,
  });
  expect(unverifiable.kind).toBe('blocked');
  if (unverifiable.kind === 'blocked') {
    expect(unverifiable.code).toBe('model_binding_unverifiable');
  }
});

test('在途修订的旧派发尚未结算时不重跑 Planner，也不触碰 Orca', async () => {
  const harness = scenario({ workPackages: [executionWorkPackage('wp-a')] });
  issuePlannerDispatch(harness);
  holdRevision(harness, 1);
  const execution = fakeBackend({});

  const result = await advanceExecution({
    ...advanceInput(harness, { roles: { planner: roleDispatch({ role: 'planner', attemptId: 'attempt-2' }) } }),
    backend: execution.backend,
  });

  expect(result.kind).toBe('idle');
  if (result.kind === 'idle') {
    expect(result.blockers).toContain('revision-planner:wp-a:dispatch-unsettled:orca-task-1');
  }
  expect(execution.calls).toHaveLength(0);
});

test('旧派发有可核验结算后，在途修订节点重跑一次 Specification Planner', async () => {
  const harness = scenario({ workPackages: [executionWorkPackage('wp-a')] });
  // 真实顺序：先有被替换版本的 Planner 派发，补丁随后登记持有；结算是之后才到的。
  issuePlannerDispatch(harness);
  holdRevision(harness, 1);
  acceptPlannerResult(harness);
  // 修订复用原 Work Package 的隔离 worktree：它已经存在，因此不应再建立第二个。
  const execution = fakeBackend({
    worktrees: [
      {
        worktreeId: 'worktree-1',
        path: '/tmp/worktrees/wp-a',
        branch: 'refs/heads/wp-a',
        head: BASELINE_HEAD,
        displayName: worktreeNameFor(WP),
        comment: workPackageComment(WP),
        isMainWorktree: false,
      },
    ],
  });

  const result = await advanceExecution({
    ...advanceInput(harness, {
      roles: { planner: roleDispatch({ role: 'planner', attemptId: 'attempt-2', workerTaskId: 'revision-task-2' }) },
      observations: plannerExited(),
    }),
    backend: execution.backend,
  });

  expect(result.kind).toBe('progressed');
  if (result.kind === 'progressed') {
    expect(result.role).toBe('planner');
  }
  const mutations = mutationsOf(execution.calls).map((mutation) => mutation.operation);
  expect(mutations).toContain('task-create');
  // 修订 Planner 复用原 Work Package：worktree 已经存在时不重建。
  expect(mutations).not.toContain('worktree-create');
});

test('修订 Planner 已经交付后不再派发第二次：缺的是持有结算，不是再派一个 Planner', async () => {
  const harness = scenario({ workPackages: [executionWorkPackage('wp-a')] });
  // 被替换版本的 Planner 派发与它的结算：都发生在持有登记之前。
  issuePlannerDispatch(harness);
  holdRevision(harness, 1);
  acceptPlannerResult(harness);
  // 修订 Planner：持有登记之后的派发，并且已经交付。
  issuePlannerDispatch(harness, 'attempt-2', '-revision');
  acceptPlannerResult(harness, '-revision', 2);
  const execution = fakeBackend({});

  const result = await advanceExecution({
    ...advanceInput(harness, {
      roles: { planner: roleDispatch({ role: 'planner', attemptId: 'attempt-3' }) },
      observations: {
        workersEnumerated: true,
        workers: [
          { dispatchId: 'dispatch-planner', taskId: 'orca-task-1', workerState: 'succeeded', terminalState: null },
          {
            dispatchId: 'dispatch-planner-revision',
            taskId: 'orca-task-1-revision',
            workerState: 'succeeded',
            terminalState: null,
          },
        ],
        worktreePaths: new Map(),
        unavailableReasons: [],
        finalizer: null,
      },
    }),
    backend: execution.backend,
  });

  expect(result.kind).toBe('idle');
  if (result.kind === 'idle') {
    expect(deniedRevisionPlanner(result.blockers)).toBe('revision-planner:wp-a:revision-already-delivered');
  }
  // 再派一次会让持有结算与旧派发结算判定互相锁死（真实运行 `orca-companion-e2e56`），因此这里必须不碰 Orca。
  expect(execution.calls).toHaveLength(0);
});

test('旧 Worker 存活不可核验时不重跑 Planner：读取不到确定退出就不算结清', async () => {
  const harness = scenario({ workPackages: [executionWorkPackage('wp-a')] });
  issuePlannerDispatch(harness);
  holdRevision(harness, 1);
  acceptPlannerResult(harness);
  const execution = fakeBackend({});

  const result = await advanceExecution({
    ...advanceInput(harness, {
      roles: { planner: roleDispatch({ role: 'planner', attemptId: 'attempt-2' }) },
      observations: {
        workersEnumerated: true,
        workers: [{ dispatchId: 'dispatch-planner', taskId: 'orca-task-1', workerState: 'unknown-state', terminalState: null }],
        worktreePaths: new Map(),
        unavailableReasons: [],
        finalizer: null,
      },
    }),
    backend: execution.backend,
  });

  expect(result.kind).toBe('idle');
  if (result.kind === 'idle') {
    expect(deniedRevisionPlanner(result.blockers)).toBe('revision-planner:wp-a:worker-not-exited:dispatch-planner');
  }
  expect(execution.calls).toHaveLength(0);
});

/**
 * 真实地消耗一次修订额度：置入持有 → 准备旧版本 → 按重新准入结算。
 *
 * 额度只能由「接受并计一次修订」的那一个事务推进，因此这里不发明计数命令——测试走的就是产品路径。
 */
function consumeRevisionBudget(harness: ExecutionScopeHarness, times: number): void {
  for (let index = 0; index < times; index += 1) {
    const registered = harness.store.transact({
      kind: 'record-revision-hold',
      coordinationScopeId: harness.scopeId,
      expectedRevision: harness.revision(),
      writer: harness.writer,
      workPackageId: WP,
      source: 'graph_patch',
      sourceRef: 'patch-1',
    });
    expect(registered.kind).toBe('committed');
    const prepared = harness.store.transact({
      kind: 'prepare-revision-hold',
      coordinationScopeId: harness.scopeId,
      expectedRevision: harness.revision(),
      writer: harness.writer,
      workPackageId: WP,
      sourceRef: 'patch-1',
      priorContractRevision: 0,
    });
    expect(prepared.kind).toBe('committed');
    const released = harness.store.transact({
      kind: 'release-revision-hold',
      coordinationScopeId: harness.scopeId,
      expectedRevision: harness.revision(),
      writer: harness.writer,
      workPackageId: WP,
      reason: '消耗一次修订额度',
      expectedSourceRef: 'patch-1',
      admittedContractRevision: 1,
      budgetConsumption: [
        {
          budgetKey: 'work-package:wp-a:specificationRevisions',
          approvedLimitRef: EXECUTION_AUTHORIZATION_ID,
          amount: 1,
        },
      ],
      approvedLimit: 2,
    });
    expect(released.kind).toBe('committed');
  }
}

test('修订额度耗尽时不重跑 Planner，拒绝原因带确切计数键', async () => {
  const harness = scenario({ workPackages: [executionWorkPackage('wp-a')] });
  consumeRevisionBudget(harness, 2);
  issuePlannerDispatch(harness);
  holdRevision(harness, 1);
  acceptPlannerResult(harness);
  const execution = fakeBackend({});

  const result = await advanceExecution({
    ...advanceInput(harness, {
      roles: { planner: roleDispatch({ role: 'planner', attemptId: 'attempt-2' }) },
      observations: plannerExited(),
    }),
    backend: execution.backend,
  });

  expect(result.kind).toBe('idle');
  if (result.kind === 'idle') {
    expect(deniedRevisionPlanner(result.blockers)).toBe(
      'revision-planner:wp-a:budget-exhausted:work-package:wp-a:specificationRevisions',
    );
  }
  expect(execution.calls).toHaveLength(0);
});

test('修订 Planner 许可携带持有已记录的旧内容版本，且只对当前图内的补丁持有成立', () => {
  const harness = scenario({ workPackages: [executionWorkPackage('wp-a')] });
  // 真实顺序：被替换版本的 Planner 派发先于补丁，因此也先于持有登记。
  issuePlannerDispatch(harness);
  acceptPlannerResult(harness);
  const registered = harness.store.transact({
    kind: 'record-revision-hold',
    coordinationScopeId: harness.scopeId,
    expectedRevision: harness.revision(),
    writer: harness.writer,
    workPackageId: WP,
    source: 'graph_patch',
    sourceRef: 'patch-1',
  });
  expect(registered.kind).toBe('committed');
  const permitFacts = () => {
    const snapshot = harness.store.query({ kind: 'snapshot', coordinationScopeId: harness.scopeId });
    if (snapshot.kind !== 'snapshot') {
      throw new Error('无法读取快照');
    }
    return revisionPlannerFacts({
      graph: harness.currentGraph().graph,
      snapshot: snapshot.snapshot,
      observations: plannerExited(),
      consumptionOf: (workPackageId) =>
        consumedBudgetForWorkPackage(harness.store, harness.scopeId, workPackageId),
    });
  };

  // 准备之前：许可已经成立（旧派发已结清），但持有还没有记下被替换的内容版本。
  expect(permitFacts().permits).toEqual([
    expect.objectContaining({ workPackageId: WP, sourceRef: 'patch-1', priorContractRevision: null }),
  ]);

  holdRevision(harness, 3);
  expect(permitFacts().permits).toEqual([
    expect.objectContaining({ workPackageId: WP, sourceRef: 'patch-1', priorContractRevision: 3 }),
  ]);
  // 来源不是图补丁的持有不产生许可：它不属于这条续办路径。
  const specificationHold = harness.store.transact({
    kind: 'record-revision-hold',
    coordinationScopeId: harness.scopeId,
    expectedRevision: harness.revision(),
    writer: harness.writer,
    workPackageId: WP,
    source: 'specification_revision',
    sourceRef: 'revision-9',
  });
  expect(specificationHold.kind).toBe('committed');
  expect(permitFacts().permits).toEqual([]);
});

test('接受图修订后，审批时刻的 GraphVersion 仍在追加链上，角色派发继续', async () => {
  const harness = scenario({ workPackages: [executionWorkPackage('wp-a')] });
  // 与真实链路一致：一份 accepted revision 把当前图推到 v2，而 Execution Authorization 仍绑定 v1
  // （批准的是批准时刻的图）。绑定时刻的版本还在追加链上，因此派发必须继续，而不是要求重新审批。
  const revised = harness.store.transact({
    kind: 'record-graph-version',
    coordinationScopeId: harness.scopeId,
    expectedRevision: harness.revision(),
    writer: harness.writer,
    graphId: harness.graphId,
    generation: harness.generation,
    graphVersion: 2 as never,
    recordKind: 'accepted_revision',
    parentVersion: 1 as never,
    mapRevision: 2,
    planRevision: 3,
    orcaRunId: 'run-1',
    graph: harness.currentGraph().graph,
    patch: {
      patchId: 'patch-1',
      operationId: 'op-patch-1' as OperationId,
      baseGraphVersion: 1 as never,
      added: [],
      revised: [],
      retired: [],
      descendants: [],
      takesOver: [],
      revisionPendingWorkPackageIds: [],
    },
    initialPlan: null,
  });
  expect(revised.kind).toBe('committed');
  const scope = harness.store.query({ kind: 'scope', coordinationScopeId: harness.scopeId });
  expect(scope.kind === 'scope' ? (scope.scope?.graphVersion ?? null) : null).toBe(2);

  const execution = fakeBackend({});
  const result = await advanceExecution({
    ...advanceInput(harness, { roles: { planner: roleDispatch({ role: 'planner', attemptId: 'attempt-1' }) } }),
    backend: execution.backend,
  });

  expect(result.kind).toBe('progressed');
  if (result.kind === 'progressed') {
    expect(result.role).toBe('planner');
  }
  expect(mutationsOf(execution.calls)).toContainEqual(
    expect.objectContaining({ operation: 'task-create' }),
  );
});

test('集成复验登记与预算原子消费，续接身份和通过树跨读取保持不可变', () => {
  const harness = scenario({ workPackages: [executionWorkPackage(WP)] });
  const binding = harness.store.transact({
    kind: 'record-materialization-binding', coordinationScopeId: harness.scopeId,
    expectedRevision: harness.revision(), writer: harness.writer, workPackageId: WP, role: 'validator',
    workerTaskId: 'validator-task' as WorkerTaskId, dispatchId: 'validator-candidate' as DispatchId,
    attemptId: 'validation-1', worktreeId: 'wt-1',
    specBinding: roleDispatch({ role: 'validator', attemptId: 'validation-1' }).taskEnvelope.specBinding,
    specificationUnitPath: null,
    authorizationId: EXECUTION_AUTHORIZATION_ID, authorizationVersion: 1, workerProfileRef: 'profile-validator',
    orcaTaskId: 'validator-task', launchId: 'validator-launch', creationOperationId: 'validator-create' as OperationId,
  });
  expect(binding.kind, binding.kind === 'rejected' ? binding.message : undefined).toBe('committed');
  settle(harness, { role: 'validator', workerTaskId: 'validator-task', dispatchId: 'validator-dispatch',
    attemptId: 'validation-1', contractRevision: 1 });
  const rounds = branchIntegrationReconciliationStore(harness.store);
  const register = (round: number, targetHead = 'head-2') => rounds.register({
    coordinationScopeId: harness.scopeId, expectedRevision: harness.revision(), writer: harness.writer,
    workPackageId: WP, reconciliationId: `round-${round}`, round, validationAttemptId: 'validation-1',
    sourceAcceptedResultRef: 'validator-task#accepted', targetHead,
    budgetKey: workPackageBudgetKey(WP, 'integrationReconciliations'), approvedLimitRef: EXECUTION_AUTHORIZATION_ID,
  });
  expect(register(1).kind).toBe('registered');
  expect(register(1).kind).toBe('existing');
  expect(register(1, 'different-head').kind).toBe('rejected');
  expect(register(2).kind).toBe('rejected');
  const bind = (dispatchId: string | null) => rounds.bindContinuation({
    coordinationScopeId: harness.scopeId, expectedRevision: harness.revision(), writer: harness.writer,
    workPackageId: WP, reconciliationId: 'round-1', orcaTaskId: 'continuation-task',
    dispatchId: dispatchId as DispatchId | null,
  });
  expect(bind(null).kind).toBe('bound');
  expect(bind('continuation-dispatch').kind).toBe('bound');
  expect(bind('other-dispatch').kind).toBe('rejected');
  const reopened = openCoordinationStore({ databasePath: harness.databasePath });
  expect(reopened.kind).toBe('opened');
  if (reopened.kind === 'opened') {
    try {
      const read = branchIntegrationReconciliationStore(reopened.store).list(harness.scopeId, WP);
      expect(read.kind === 'records' ? read.records : []).toEqual([
        expect.objectContaining({ state: 'pending', orcaTaskId: 'continuation-task', dispatchId: 'continuation-dispatch' }),
      ]);
    } finally { reopened.store.close(); }
  }
  const finish = (round: number, tree: string) => rounds.settle({
    coordinationScopeId: harness.scopeId, expectedRevision: harness.revision(), writer: harness.writer,
    workPackageId: WP, reconciliationId: `round-${round}`, state: 'validated', mergedTreeRef: tree,
  });
  expect(finish(1, 'tree-1').kind).toBe('settled');
  expect(finish(1, 'different-tree').kind).toBe('rejected');
  expect(register(2).kind).toBe('registered');
  expect(finish(2, 'tree-2').kind).toBe('settled');
  expect(register(3).kind).toBe('rejected');
  const budget = harness.store.query({ kind: 'budget-counters', coordinationScopeId: harness.scopeId });
  expect(budget.kind === 'budget-counters' ? budget.counters : []).toContainEqual(
    expect.objectContaining({ budgetKey: workPackageBudgetKey(WP, 'integrationReconciliations'), consumed: 2 }),
  );
});
