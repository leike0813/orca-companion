/**
 * `m1-plan-and-authorize-execution` 的行为测试：Graph Generation 的分配与过期判定（IC-05）。
 *
 * 覆盖 `planning/execution-graph-compilation` 的 Requirement「Candidate graph binds to one Graph
 * Generation」：Scenario「新规划产生新世代」要求新 GraphId、新空 Orca Run，且不复用前一代标识；
 * Scenario「地图变更使候选图过期」要求地图 revision、计划 revision 或世代任一变化都让候选图过期。
 *
 * 创建空 Orca Run 是外部副作用，因此这里同时固定它的三值纪律与 mutation lane 语义：allocator 明确
 * 拒绝时意图收尾为 rejected；结果不明时意图保持 pending，同一 `orca-run` lane 不能换 OperationId
 * 再建一个 Run。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { openCoordinationStore, type CoordinationStore } from '../../src/adapters/storage/coordination-store.js';
import { acquireRuntimeLease } from '../../src/application/coordination/lease-service.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  GraphGeneration,
  GraphId,
  OperationId,
  PlanningCycleId,
  RuntimeIncarnationId,
  WorkPackageId,
} from '../../src/application/dto/identity.js';
import type { OperationIntent } from '../../src/application/dto/operation-intent.js';
import {
  graphIdFor,
  isCandidateStale,
  startGraphGeneration,
  type EmptyRunAllocation,
  type EmptyRunAllocator,
} from '../../src/application/planning/graph-generation.js';
import { recordInitialGraph } from '../../src/application/planning/graph-history.js';
import { initializeCoordinationScope } from '../../src/application/planning/initialize-scope.js';
import type { CoordinationWriter } from '../../src/application/ports/branch-coordination-store.js';
import type { ExecutionGraph } from '../../src/domain/planning/execution-graph.js';

const SCOPE = 'scope-1' as CoordinationScopeId;
const SESSION_A = 'session-a' as CoordinatorSessionId;
const CYCLE = 'cycle-1' as PlanningCycleId;

const OP_RUN_1 = 'op-run-1' as OperationId;
const OP_RUN_2 = 'op-run-2' as OperationId;

let directory = '';
let store: CoordinationStore;
let writer: CoordinationWriter;
let now = 1_000;

const clock = (): number => now;
const generation = (value: number): GraphGeneration => value as GraphGeneration;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-planning-gen-'));
  now = 1_000;
  const opened = openCoordinationStore({ databasePath: join(directory, 'coordination.sqlite'), clock });
  if (opened.kind !== 'opened') {
    throw new Error(opened.message);
  }
  store = opened.store;

  const initialized = initializeCoordinationScope({
    store,
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_A,
    coordinatorModelConfigurationRef: 'model-config-1',
    planningCycleId: CYCLE,
  });
  if (initialized.kind !== 'initialized') {
    throw new Error('无法创建测试 Scope');
  }
  const acquired = acquireRuntimeLease(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_A,
    runtimeIncarnationId: 'inc-a' as RuntimeIncarnationId,
    fencingGeneration: 0,
  });
  if (acquired.kind !== 'acquired') {
    throw new Error('无法取得 Runtime Lease');
  }
  writer = {
    coordinatorSessionId: SESSION_A,
    runtimeIncarnationId: 'inc-a' as RuntimeIncarnationId,
    fencingGeneration: acquired.lease.fencingGeneration,
  };
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

function intentOf(operationId: OperationId): OperationIntent | null {
  const result = store.query({ kind: 'intent', coordinationScopeId: SCOPE, operationId });
  if (result.kind !== 'intent') {
    throw new Error('无法读取 Operation Intent');
  }
  return result.intent;
}

function graphFor(graphId: GraphId, graphGeneration: GraphGeneration): ExecutionGraph {
  return {
    graphId,
    generation: graphGeneration,
    concurrencyLimit: 1,
    workPackages: [
      {
        workPackageId: 'wp-1' as WorkPackageId,
        title: '首个工作包',
        dependsOn: [],
        scopeEnvelope: { include: ['src'], exclude: [] },
        budget: {
          implementationAttempts: 2,
          validatorRepairs: 2,
          graphRevisions: 2,
          specificationRevisions: 2,
          maxRecoveriesPerWorkerAttempt: 1,
        },
      },
    ],
  };
}

/** 记录 allocator 每次收到的请求，方便断言身份与目标透传。 */
function recordingAllocator(
  decide: (request: Parameters<EmptyRunAllocator>[0]) => EmptyRunAllocation,
): { readonly requests: Parameters<EmptyRunAllocator>[0][]; readonly allocate: EmptyRunAllocator } {
  const requests: Parameters<EmptyRunAllocator>[0][] = [];
  const allocate: EmptyRunAllocator = (request) => {
    requests.push(request);
    return Promise.resolve(decide(request));
  };
  return { requests, allocate };
}

function start(operationId: OperationId, allocateRun: EmptyRunAllocator, objective = '一个目标') {
  return startGraphGeneration({
    store,
    coordinationScopeId: SCOPE,
    planningCycleId: CYCLE,
    writer,
    operationId,
    objective,
    allocateRun,
  });
}

test('新规划产生新世代：新 GraphId、新空 Run，且不复用前一代标识', async () => {
  const first = recordingAllocator(() => ({ kind: 'allocated', orcaRunId: 'run-1' }));

  const started = await start(OP_RUN_1, first.allocate, '把登录页做完');
  expect(started.kind).toBe('started');
  if (started.kind !== 'started') {
    return;
  }
  expect(started.generation.generation).toBe(1);
  expect(started.generation.graphId).toBe(graphIdFor(SCOPE, generation(1)));

  // allocator 收到的身份与目标与请求一致。
  expect(first.requests).toHaveLength(1);
  expect(first.requests[0]?.objective).toBe('把登录页做完');
  expect(first.requests[0]?.coordinationScopeId).toBe(SCOPE);
  expect(first.requests[0]?.planningCycleId).toBe(CYCLE);
  expect(first.requests[0]?.graphId).toBe(started.generation.graphId);
  expect(first.requests[0]?.generation).toBe(1);

  const recorded = recordInitialGraph({
    store,
    coordinationScopeId: SCOPE,
    writer,
    graph: graphFor(started.generation.graphId, started.generation.generation),
    mapRevision: 0,
    planRevision: 1,
    orcaRunId: started.generation.orcaRunId,
  });
  expect(recorded.kind).toBe('recorded');

  const second = recordingAllocator(() => ({ kind: 'allocated', orcaRunId: 'run-2' }));
  const restarted = await start(OP_RUN_2, second.allocate, '第二轮规划');
  expect(restarted.kind).toBe('started');
  if (restarted.kind !== 'started') {
    return;
  }
  expect(restarted.generation.generation).toBe(2);
  expect(restarted.generation.graphId).toBe(graphIdFor(SCOPE, generation(2)));
  expect(restarted.generation.graphId).not.toBe(started.generation.graphId);
  expect(restarted.generation.orcaRunId).not.toBe(started.generation.orcaRunId);
  expect(second.requests[0]?.graphId).toBe(graphIdFor(SCOPE, generation(2)));
  expect(second.requests[0]?.generation).toBe(2);
});

test('地图 revision、计划 revision 或世代任一变化都让候选图过期', () => {
  const bound = {
    boundMapRevision: 0,
    boundPlanRevision: 1,
    boundGeneration: generation(1),
  };

  expect(
    isCandidateStale({ ...bound, currentMapRevision: 1, currentPlanRevision: 1, currentGeneration: generation(1) }),
  ).toBe(true);
  expect(
    isCandidateStale({ ...bound, currentMapRevision: 0, currentPlanRevision: 2, currentGeneration: generation(1) }),
  ).toBe(true);
  expect(
    isCandidateStale({ ...bound, currentMapRevision: 0, currentPlanRevision: 1, currentGeneration: generation(2) }),
  ).toBe(true);
  expect(
    isCandidateStale({ ...bound, currentMapRevision: 0, currentPlanRevision: 1, currentGeneration: generation(1) }),
  ).toBe(false);
});

test('allocator 明确拒绝时返回 rejected，且意图收尾为 rejected', async () => {
  const rejected = recordingAllocator(() => ({
    kind: 'rejected',
    code: 'run_quota_exceeded',
    message: '配额已满',
  }));

  const result = await start(OP_RUN_1, rejected.allocate);
  expect(result.kind).toBe('rejected');
  if (result.kind === 'rejected') {
    expect(result.code).toBe('run_quota_exceeded');
  }
  const intent = intentOf(OP_RUN_1);
  expect(intent?.state).toBe('settled');
  expect(intent?.outcomeClass).toBe('rejected');
});

test('allocator 结果不明时意图保持未决，同一 orca-run lane 不能换 OperationId 重建', async () => {
  let allocations = 0;
  const unknown: EmptyRunAllocator = () => {
    allocations += 1;
    return Promise.resolve({ kind: 'unknown', reason: '连接中断' });
  };

  const first = await start(OP_RUN_1, unknown);
  expect(first.kind).toBe('unknown');
  expect(intentOf(OP_RUN_1)?.state).toBe('pending');

  const retry: EmptyRunAllocator = () => {
    allocations += 1;
    return Promise.resolve({ kind: 'allocated', orcaRunId: 'run-x' });
  };

  const second = await start(OP_RUN_2, retry);
  expect(second.kind).toBe('rejected');
  expect(intentOf(OP_RUN_2)).toBeNull();
  // 第二次调用没有触达 allocator：未决的 lane 在 store 边界就被拒绝。
  expect(allocations).toBe(1);
});
