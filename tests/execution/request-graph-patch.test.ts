/**
 * IC-10 / IP-1 的行为测试：一次图变化请求的端到端编排。
 *
 * 生产路径（真实 store、真实分类器、真实 Admission 与唯一提交点）覆盖四件事：语义含糊的请求被派发给
 * Graph Patch Planner 并最终追加为 accepted revision、明确请求完全不派 Planner、过期或越界的请求零
 * 副作用、Planner 结果不可判定时不以猜测收尾。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { openCoordinationStore, type CoordinationStore } from '../../src/adapters/storage/coordination-store.js';
import { acquireRuntimeLease } from '../../src/application/coordination/lease-service.js';
import type { CoordinationScopeId, CoordinatorSessionId, PlanningCycleId, RuntimeIncarnationId } from '../../src/application/dto/identity.js';
import type { CoordinationWriter } from '../../src/application/ports/branch-coordination-store.js';
import { initializeCoordinationScope } from '../../src/application/planning/initialize-scope.js';
import type { GraphChangeRequest } from '../../src/domain/execution/change-routing.js';
import type { WorkPackageId } from '../../src/application/dto/identity.js';
import type {
  GraphPatchPlannerOutcome,
  GraphPatchPlannerRequest,
} from '../../src/application/execution/graph-patch-planner.js';
import {
  requestGraphPatch,
  type GraphPatchBaselineObservation,
  type RequestGraphPatchInput,
  type RequestGraphPatchResult,
} from '../../src/application/execution/request-graph-patch.js';
import {
  createExecutionScopeHarness,
  type ExecutionScopeHarness,
} from '../support/execution-harness.js';

const WP_B = 'wp-b' as WorkPackageId;
const WP_C = 'wp-c' as WorkPackageId;

let harness: ExecutionScopeHarness;

beforeEach(() => {
  harness = createExecutionScopeHarness();
});

afterEach(() => {
  harness.close();
});

/** 默认全部声明为已核验不成立；只有调用方显式覆盖的字段参与分类。 */
function claims(overrides: Partial<GraphChangeRequest> = {}): GraphChangeRequest {
  return {
    workPackageId: WP_B,
    infrastructureFailure: 'no',
    changesDependencies: 'no',
    changesScopeEnvelope: 'no',
    changesObjective: 'no',
    contractContentOnly: 'no',
    goalOrGlobalConstraintChanged: 'no',
    userRequestedReplanning: 'no',
    requiresUserChoice: 'no',
    ...overrides,
  };
}

/** 修订 wp-b、逐一处置未接受后代 wp-c 的载荷；形状与 Planner 指令要求的骨架一致。 */
function draftPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    baseGraphVersion: harness.currentGraph().version,
    patchId: 'patch-1',
    operationId: 'op-from-payload',
    add: [],
    revise: [
      {
        workPackageId: WP_B,
        title: 'B 修订',
        dependsOn: [{ kind: 'existing', workPackageId: 'wp-a' }],
        scopeEnvelope: { include: ['src'], exclude: [] },
      },
    ],
    retire: [],
    descendants: [{ workPackageId: WP_C, disposition: 'unchanged' }],
    takesOver: [],
    ...overrides,
  };
}

type PlannerStub = {
  readonly port: (request: GraphPatchPlannerRequest) => Promise<GraphPatchPlannerOutcome>;
  readonly requests: GraphPatchPlannerRequest[];
};

function plannerReturning(outcome: GraphPatchPlannerOutcome): PlannerStub {
  const requests: GraphPatchPlannerRequest[] = [];
  return {
    requests,
    port: (request) => {
      requests.push(request);
      return Promise.resolve(outcome);
    },
  };
}

function acceptedPlanner(payload: unknown, draftRef = 'result-1'): PlannerStub {
  return plannerReturning({ kind: 'accepted', draftRef, payload });
}

/** 默认基线观察：修订节点视为尚无 worktree，因此不触发独立补救。 */
function baselinesWithoutWorktree() {
  const seen: string[][] = [];
  return {
    seen,
    port: (revision: Parameters<RequestGraphPatchInput['baselines']>[0]) => {
      const ids = [...revision.revisedWorkPackageIds, ...revision.specificationRevisionRequiredWorkPackageIds];
      seen.push([...ids]);
      return new Map<WorkPackageId, GraphPatchBaselineObservation | null>(ids.map((id) => [id, null]));
    },
  };
}

function dispatchInput(overrides: Partial<RequestGraphPatchInput> = {}): RequestGraphPatchInput {
  const planner = acceptedPlanner(draftPayload());
  return {
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    operationId: 'op-trusted' as RequestGraphPatchInput['operationId'],
    patchId: 'patch-1',
    changeRequest: claims({ changesObjective: 'unknown' }),
    planner: planner.port,
    authorization: harness.authorization(),
    limits: harness.limits,
    acceptedWorkPackageIds: ['wp-a' as WorkPackageId],
    dispatchedWorkPackageIds: [],
    baselines: baselinesWithoutWorktree().port,
    baselineReconciliation: () => Promise.resolve({ kind: 'dispatched' as const }),
    ...overrides,
  };
}

function applied(result: RequestGraphPatchResult): Extract<RequestGraphPatchResult, { kind: 'applied' }> {
  if (result.kind !== 'applied') {
    throw new Error(`测试前置失败：期望 applied，实际 ${JSON.stringify(result)}`);
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* 含糊请求 → Planner → accepted revision                                      */
/* -------------------------------------------------------------------------- */

test('语义含糊的请求派发 Planner，证据经 Admission 归一化后追加为 accepted revision', async () => {
  const planner = acceptedPlanner(draftPayload());
  const baselines = baselinesWithoutWorktree();
  const baseGraphVersion = harness.currentGraph().version;
  const result = await requestGraphPatch(
    dispatchInput({ planner: planner.port, baselines: baselines.port }),
  );

  // 声明事实不足以判定：一定要问 Planner，而不是由 Controller 猜成某一类。
  expect(planner.requests).toHaveLength(1);
  expect(planner.requests[0]?.baseGraphVersion).toBe(baseGraphVersion);
  expect(planner.requests[0]?.patchId).toBe('patch-1');
  expect(planner.requests[0]?.unacceptedDescendantIds).toEqual([WP_C]);

  const appliedResult = applied(result);
  expect(appliedResult.decision.route).toBe('graph_patch');
  expect(appliedResult.version.version).toBe(2);
  expect(appliedResult.version.recordKind).toBe('accepted_revision');
  expect(appliedResult.version.parentVersion).toBe(1);
  expect(harness.versionCount()).toBe(2);

  // 基线回调按 Admission 之后的 revision 收到需要观察的节点。
  expect(baselines.seen).toEqual([[WP_B]]);
  // 修订节点尚无 worktree，因此没有登记任何补救：driver 一次都没被推进。
  expect(appliedResult.baselineProgress).toEqual([]);

  // 载荷自称的 patchId/operationId 没有进入提交：记录里是 Controller 签发的那一对。
  const record = harness.store.query({
    kind: 'graph-patch-record',
    coordinationScopeId: harness.scopeId,
    graphId: harness.graphId,
    graphVersion: 2 as never,
  });
  expect(record.kind === 'graph-patch-record' ? record.record?.operationId : null).toBe('op-trusted');
  expect(record.kind === 'graph-patch-record' ? record.record?.patchId : null).toBe('patch-1');
});

test('基线落后的修订节点在提交后立即登记独立补救并推进 driver', async () => {
  const planner = acceptedPlanner(draftPayload());
  const driven: string[] = [];
  const result = await requestGraphPatch(
    dispatchInput({
      planner: planner.port,
      baselines: (revision) =>
        new Map(
          [...revision.revisedWorkPackageIds, ...revision.specificationRevisionRequiredWorkPackageIds].map(
            (workPackageId) => [
              workPackageId,
              { requiredBaselineHead: 'head-2', worktreeBaseHead: 'head-1', relation: 'behind' as const },
            ],
          ),
        ),
      baselineReconciliation: (plan) => {
        driven.push(plan.reconciliationId);
        return Promise.resolve({ kind: 'dispatched' });
      },
    }),
  );

  const appliedResult = applied(result);
  expect(appliedResult.revisionPendingWorkPackageIds).toEqual([WP_B]);
  expect(driven).toEqual(['baseline-reconciliation:wp-b:head-2']);
  expect(appliedResult.baselineProgress).toEqual([
    { reconciliationId: 'baseline-reconciliation:wp-b:head-2', progress: { kind: 'dispatched' } },
  ]);
  const records = harness.store.query({
    kind: 'baseline-reconciliations',
    coordinationScopeId: harness.scopeId,
    workPackageId: WP_B,
  });
  expect(records.kind === 'baseline-reconciliations' ? records.reconciliations.map((entry) => entry.state) : null).toEqual([
    'required',
  ]);
});

/* -------------------------------------------------------------------------- */
/* 明确请求不派 Planner                                                        */
/* -------------------------------------------------------------------------- */

test.each([
  ['图级结构变化', { changesDependencies: 'yes' }, 'graph_patch'],
  ['既定工作重试', { infrastructureFailure: 'yes' }, 'retry_attempt'],
  ['只替换 contract 内容', { contractContentOnly: 'yes' }, 'specification_revision'],
  ['目标或全局约束变化', { goalOrGlobalConstraintChanged: 'yes' }, 'replanning_transition'],
  ['需要用户裁决', { requiresUserChoice: 'yes' }, 'user_decision_required'],
] as const)('%s 直接返回路由结论，不派 Planner 也不写图', async (_name, overrides, route) => {
  const planner = acceptedPlanner(draftPayload());
  const result = await requestGraphPatch(
    dispatchInput({ planner: planner.port, changeRequest: claims(overrides) }),
  );

  expect(result.kind).toBe('routed');
  if (result.kind !== 'routed') {
    return;
  }
  expect(result.decision.route).toBe(route);
  expect(planner.requests).toEqual([]);
  expect(harness.versionCount()).toBe(1);
});

/* -------------------------------------------------------------------------- */
/* 过期与越界请求零副作用                                                      */
/* -------------------------------------------------------------------------- */

test('调用方版本过期时拒绝，且不派 Planner、不写图', async () => {
  const planner = acceptedPlanner(draftPayload());
  const staleGraph = await requestGraphPatch(
    dispatchInput({ planner: planner.port, expectedGraphVersion: (harness.currentGraph().version + 1) as never }),
  );
  expect(staleGraph.kind === 'rejected' ? staleGraph.code : null).toBe('base_version_mismatch');

  const staleRevision = await requestGraphPatch(
    dispatchInput({ planner: planner.port, expectedRevision: harness.revision() + 1 }),
  );
  expect(staleRevision.kind === 'rejected' ? staleRevision.code : null).toBe('stale_revision');

  expect(planner.requests).toEqual([]);
  expect(harness.versionCount()).toBe(1);
});

test('请求目标不在当前图中时拒绝，且不派 Planner、不写图', async () => {
  const planner = acceptedPlanner(draftPayload());
  const result = await requestGraphPatch(
    dispatchInput({
      planner: planner.port,
      changeRequest: claims({ changesDependencies: 'unknown', workPackageId: 'wp-其他' as WorkPackageId }),
    }),
  );
  expect(result.kind === 'rejected' ? result.code : null).toBe('unknown_work_package');
  expect(planner.requests).toEqual([]);
  expect(harness.versionCount()).toBe(1);
});

test('未处于 Execution Coordination 的 Scope 拒绝，且不派 Planner', async () => {
  const planning = createPlanningScope();
  try {
    const planner = acceptedPlanner(draftPayload());
    const result = await requestGraphPatch({
      ...dispatchInput({ planner: planner.port }),
      store: planning.store,
      coordinationScopeId: planning.scopeId,
      writer: planning.writer,
    });
    expect(result.kind === 'rejected' ? result.code : null).toBe('invalid_mode');
    expect(planner.requests).toEqual([]);
    expect(planning.versionCount()).toBe(0);
  } finally {
    planning.close();
  }
});

test('同一 patchId 已提交过时拒绝重放，不追加第二份图', async () => {
  const first = await requestGraphPatch(dispatchInput({ planner: acceptedPlanner(draftPayload()).port }));
  expect(first.kind).toBe('applied');
  const replayed = await requestGraphPatch(dispatchInput({ planner: acceptedPlanner(draftPayload()).port }));
  expect(replayed.kind === 'rejected' ? replayed.code : null).toBe('patch_already_applied');
  expect(harness.versionCount()).toBe(2);
});

/* -------------------------------------------------------------------------- */
/* Planner 结果不可判定                                                        */
/* -------------------------------------------------------------------------- */

test('Planner 结果不可判定时保持 unknown，不猜测分类也不提交图', async () => {
  const planner = plannerReturning({ kind: 'unknown', reason: 'orca 未确认 Planner 结果' });
  const result = await requestGraphPatch(dispatchInput({ planner: planner.port }));

  expect(result.kind).toBe('unknown');
  if (result.kind !== 'unknown') {
    return;
  }
  expect(result.operationId).toBe('op-trusted');
  expect(result.reason).toContain('orca 未确认');
  expect(harness.versionCount()).toBe(1);
});

test('Admission 未通过时拒绝并交出编译错误，不写图', async () => {
  // 补丁声明了与当前图不符的基线：Admission 必须在提交之前拦住整笔。
  const planner = acceptedPlanner(draftPayload({ baseGraphVersion: harness.currentGraph().version + 1 }));
  const result = await requestGraphPatch(dispatchInput({ planner: planner.port }));

  expect(result.kind === 'rejected' ? result.code : null).toBe('admission_rejected');
  if (result.kind === 'rejected') {
    expect(result.errors?.map((entry) => entry.code)).toContain('base_version_mismatch');
  }
  expect(harness.versionCount()).toBe(1);
});

/**
 * 只用于「模式不匹配」这一条的对照 Scope：它是真实初始化出来的 planning Scope（无 Execution Lease、
 * 无图），因此拒绝原因来自模式而不是 fixture 的构造方式。
 */
function createPlanningScope(): {
  readonly store: CoordinationStore;
  readonly writer: CoordinationWriter;
  readonly scopeId: CoordinationScopeId;
  readonly versionCount: () => number;
  readonly close: () => void;
} {
  const directory = mkdtempSync(join(tmpdir(), 'orca-request-patch-planning-'));
  const opened = openCoordinationStore({ databasePath: join(directory, 'coordination.sqlite') });
  if (opened.kind !== 'opened') {
    throw new Error(opened.message);
  }
  const scopeId = 'scope-planning' as CoordinationScopeId;
  const sessionId = 'session-planning' as CoordinatorSessionId;
  const initialized = initializeCoordinationScope({
    store: opened.store,
    coordinationScopeId: scopeId,
    coordinatorSessionId: sessionId,
    coordinatorModelConfigurationRef: 'model-config-1',
    planningCycleId: 'cycle-planning' as PlanningCycleId,
    fullBranchRef: 'refs/heads/main',
    canonicalWorktreePath: '/tmp/orca-planning-worktree',
  });
  if (initialized.kind !== 'initialized') {
    throw new Error('无法创建规划态 Scope');
  }
  const acquired = acquireRuntimeLease(opened.store, {
    coordinationScopeId: scopeId,
    coordinatorSessionId: sessionId,
    runtimeIncarnationId: 'inc-planning' as RuntimeIncarnationId,
    fencingGeneration: 0,
  });
  if (acquired.kind !== 'acquired') {
    throw new Error('无法取得 Runtime Lease');
  }
  return {
    store: opened.store,
    writer: {
      coordinatorSessionId: sessionId,
      runtimeIncarnationId: 'inc-planning' as RuntimeIncarnationId,
      fencingGeneration: acquired.lease.fencingGeneration,
    },
    scopeId,
    versionCount: () => {
      const versions = opened.store.query({ kind: 'graph-versions', coordinationScopeId: scopeId, graphId: 'none' as never });
      return versions.kind === 'graph-versions' ? versions.versions.length : -1;
    },
    close: () => {
      opened.store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/**
 * 授权绑定的是批准时刻的 GraphVersion，而图会随 accepted revision 前进；因此第二次修订必须仍然被接受，
 * 只要授权基线还在当前 head 的追加链上。这条用例锁住「不要拿 Manifest 版本与当前版本做相等比较」。
 */
test('图前进之后第二次修订仍被接受，授权基线按追加链核对', async () => {
  const first = await requestGraphPatch(
    dispatchInput({ patchId: 'patch-1', planner: acceptedPlanner(draftPayload()).port }),
  );
  expect(first.kind).toBe('applied');
  expect(harness.currentGraph().version).toBe(2);

  const secondPayload = draftPayload({
    baseGraphVersion: 2,
    patchId: 'patch-2',
    revise: [
      {
        workPackageId: WP_B,
        title: 'B 再修订',
        dependsOn: [{ kind: 'existing', workPackageId: 'wp-a' }],
        scopeEnvelope: { include: ['src'], exclude: [] },
      },
    ],
  });
  const second = await requestGraphPatch(
    dispatchInput({ patchId: 'patch-2', planner: acceptedPlanner(secondPayload).port }),
  );

  expect(second.kind, JSON.stringify(second)).toBe('applied');
  expect(harness.versionCount()).toBe(3);
  const appliedResult = applied(second);
  expect(appliedResult.version.parentVersion).toBe(2);
  expect(appliedResult.version.patchId).toBe('patch-2');
});
