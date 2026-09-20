/**
 * `m1-plan-and-authorize-execution` 的行为测试：Execution Graph 的追加历史（IC-05）。
 *
 * 覆盖 `planning/execution-graph-compilation` 中「候选图属于一个 Graph Generation」所依赖的历史
 * 语义：初始 GraphVersion 可按同一 interface 读回、同一 GraphId 只能有一个 initial、历史追加不
 * 改写既有记录、Scope 上的「当前图」指针随追加一起推进，以及未记录的 GraphId 读取为 absent。
 *
 * 历史是本 change 唯一写 seam 的产物：调用方读到的图拓扑永远是某一条确切记录，而不是一个可以被
 * 就地覆盖的引用。
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
  PlanningCycleId,
  RuntimeIncarnationId,
  WorkPackageId,
} from '../../src/application/dto/identity.js';
import {
  loadCurrentGraph,
  loadScopeGraph,
  recordInitialGraph,
} from '../../src/application/planning/graph-history.js';
import { graphIdFor } from '../../src/application/planning/graph-generation.js';
import { initializeCoordinationScope } from '../../src/application/planning/initialize-scope.js';
import type { CoordinationWriter } from '../../src/application/ports/branch-coordination-store.js';
import type { ExecutionGraph, GraphVersionRecord } from '../../src/domain/planning/execution-graph.js';

const SCOPE = 'scope-1' as CoordinationScopeId;
const SESSION_A = 'session-a' as CoordinatorSessionId;
const CYCLE = 'cycle-1' as PlanningCycleId;

let directory = '';
let store: CoordinationStore;
let writer: CoordinationWriter;
let now = 1_000;

const clock = (): number => now;
const generation = (value: number): GraphGeneration => value as GraphGeneration;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-planning-history-'));
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

function record(
  graph: ExecutionGraph,
  revisions: { readonly mapRevision: number; readonly planRevision: number; readonly orcaRunId: string },
) {
  return recordInitialGraph({
    store,
    coordinationScopeId: SCOPE,
    writer,
    graph,
    mapRevision: revisions.mapRevision,
    planRevision: revisions.planRevision,
    orcaRunId: revisions.orcaRunId,
  });
}

function historyOf(graphId: GraphId): readonly GraphVersionRecord[] {
  const result = store.query({ kind: 'graph-versions', coordinationScopeId: SCOPE, graphId });
  if (result.kind !== 'graph-versions') {
    throw new Error('无法读取 GraphVersion 历史');
  }
  return result.versions;
}

test('初始 GraphVersion 可按同一 interface 读回，并成为 Scope 的当前图', () => {
  const graph = graphFor(graphIdFor(SCOPE, generation(1)), generation(1));

  const recorded = record(graph, { mapRevision: 2, planRevision: 3, orcaRunId: 'run-1' });
  expect(recorded.kind).toBe('recorded');
  if (recorded.kind !== 'recorded') {
    return;
  }
  expect(recorded.version.version).toBe(1);
  expect(recorded.version.recordKind).toBe('initial');
  expect(recorded.version.parentVersion).toBeNull();
  expect(recorded.version.graphId).toBe(graph.graphId);
  expect(recorded.version.generation).toBe(graph.generation);
  expect(recorded.version.mapRevision).toBe(2);
  expect(recorded.version.planRevision).toBe(3);
  expect(recorded.version.orcaRunId).toBe('run-1');
  expect(recorded.version.graph.workPackages).toHaveLength(1);

  const loaded = loadCurrentGraph({ store, coordinationScopeId: SCOPE, graphId: graph.graphId });
  expect(loaded.kind).toBe('loaded');
  if (loaded.kind !== 'loaded') {
    return;
  }
  expect(loaded.version).toEqual(recorded.version);

  // 「当前图」指针与追加在同一事务里推进，因此 Scope 级读取也指向同一条记录。
  const scopeGraph = loadScopeGraph(store, SCOPE);
  expect(scopeGraph.kind).toBe('loaded');
  if (scopeGraph.kind !== 'loaded') {
    return;
  }
  expect(scopeGraph.version).toEqual(recorded.version);
});

test('同一 GraphId 只能有一个 initial，重复追加被拒绝且历史长度不变', () => {
  const graph = graphFor(graphIdFor(SCOPE, generation(1)), generation(1));
  expect(record(graph, { mapRevision: 0, planRevision: 1, orcaRunId: 'run-1' }).kind).toBe('recorded');

  const second = record(graph, { mapRevision: 5, planRevision: 6, orcaRunId: 'run-2' });
  expect(second.kind).toBe('rejected');
  if (second.kind === 'rejected') {
    expect(second.failure.code).toBe('constraint');
  }
  expect(historyOf(graph.graphId)).toHaveLength(1);
});

test('未记录过的 GraphId 读回 absent', () => {
  const absent = loadCurrentGraph({
    store,
    coordinationScopeId: SCOPE,
    graphId: graphIdFor(SCOPE, generation(9)),
  });
  expect(absent.kind).toBe('absent');

  // 还没有编译过任何图时，Scope 级读取也是 absent 而不是错误。
  expect(loadScopeGraph(store, SCOPE).kind).toBe('absent');
});

test('追加新世代不改写既有历史，当前图指针推进到最新一条', () => {
  const firstGraph = graphFor(graphIdFor(SCOPE, generation(1)), generation(1));
  const first = record(firstGraph, { mapRevision: 0, planRevision: 1, orcaRunId: 'run-1' });
  expect(first.kind).toBe('recorded');

  const secondGraph = graphFor(graphIdFor(SCOPE, generation(2)), generation(2));
  const second = record(secondGraph, { mapRevision: 1, planRevision: 1, orcaRunId: 'run-2' });
  expect(second.kind).toBe('recorded');

  const firstHistory = historyOf(firstGraph.graphId);
  expect(firstHistory).toHaveLength(1);
  expect(firstHistory[0]?.version).toBe(1);
  expect(firstHistory[0]?.orcaRunId).toBe('run-1');

  const reloaded = loadCurrentGraph({ store, coordinationScopeId: SCOPE, graphId: firstGraph.graphId });
  expect(reloaded.kind).toBe('loaded');
  if (reloaded.kind === 'loaded') {
    expect(reloaded.version.orcaRunId).toBe('run-1');
    expect(reloaded.version.mapRevision).toBe(0);
  }

  const scopeGraph = loadScopeGraph(store, SCOPE);
  expect(scopeGraph.kind).toBe('loaded');
  if (scopeGraph.kind === 'loaded') {
    expect(scopeGraph.version.graphId).toBe(secondGraph.graphId);
  }
});

test('未知 Scope 上记录被拒绝，且不留下历史', () => {
  const unknownScope = 'scope-unknown' as CoordinationScopeId;
  const graph = graphFor(graphIdFor(unknownScope, generation(1)), generation(1));

  const rejected = recordInitialGraph({
    store,
    coordinationScopeId: unknownScope,
    writer,
    graph,
    mapRevision: 0,
    planRevision: 1,
    orcaRunId: 'run-1',
  });

  expect(rejected.kind).toBe('rejected');
  if (rejected.kind === 'rejected') {
    expect(rejected.failure.code.length).toBeGreaterThan(0);
  }
  const history = store.query({ kind: 'graph-versions', coordinationScopeId: unknownScope, graphId: graph.graphId });
  expect(history.kind).toBe('graph-versions');
  if (history.kind === 'graph-versions') {
    expect(history.versions).toEqual([]);
  }
});
