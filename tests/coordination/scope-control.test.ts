/**
 * IP-9：Scope 控制的行为测试
 * （Requirement「Scope 控制动作必须正交且不隐式改变其他控制状态」）。
 *
 * 覆盖五个 Scenario 的可观察语义：
 * - 暂停期间活跃 Worker 继续运行，事件落盘与对账不受影响；
 * - 恢复先对账再恢复调度，且不重置已消耗的预算、claim、lease 与 graph revision；
 * - 停止结果未确认时保持 `cancelling` / `unverifiable`，绝不报告为已停止；
 * - 取消后的迟到事件不重新激活当前代际；
 * - Exit 不写控制状态、不请求 Worker 停止；退出后重入不假设 Worker 已停止。
 *
 * 测试只断言责任归属、CAS 与零副作用这些稳定语义，不锁定日志或内部调用顺序（取消意图必须先落盘的
 * 顺序例外——那是合同本身）。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { openCoordinationStore, type CoordinationStore } from '../../src/adapters/storage/coordination-store.js';
import { acquireExecutionLease, acquireRuntimeLease } from '../../src/application/coordination/lease-service.js';
import {
  createScopeControlService,
  type ActiveWorkerListResult,
  type ScopeControlResult,
  type ScopeReconciliationRunner,
  type WorkerStopPort,
} from '../../src/application/coordination/scope-control-service.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  GraphGeneration,
  GraphId,
  PlanningCycleId,
  RuntimeIncarnationId,
} from '../../src/application/dto/identity.js';
import { recordInitialGraph } from '../../src/application/planning/graph-history.js';
import { initializeCoordinationScope } from '../../src/application/planning/initialize-scope.js';
import type {
  BranchCoordinationStore,
  CoordinationCommand,
  CoordinationWriter,
} from '../../src/application/ports/branch-coordination-store.js';
import type { ControlState } from '../../src/domain/coordination/mode.js';
import {
  controlStateAfterCancel,
  evaluateScopeControl,
  lateEventDisposition,
  mayDispatch,
  mayRedispatchWorker,
  mayResumeModel,
  reentryPolicy,
  scopeControlGate,
} from '../../src/domain/coordination/scope-control.js';

const SCOPE = 'scope-control' as CoordinationScopeId;
const SESSION_A = 'session-a' as CoordinatorSessionId;
const INC_A = 'inc-a' as RuntimeIncarnationId;
const CYCLE = 'cycle-1' as PlanningCycleId;
const GRAPH_ID = 'graph-1' as GraphId;

let directory = '';
let store: CoordinationStore;
let writer: CoordinationWriter;
let now = 1_000;

const clock = (): number => now;

function scopeRevision(): number {
  const scope = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
  if (scope.kind !== 'scope' || scope.scope === null) {
    throw new Error('Scope 不存在');
  }
  return scope.scope.revision;
}

function controlState(): ControlState {
  const scope = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
  if (scope.kind !== 'scope' || scope.scope === null) {
    throw new Error('Scope 不存在');
  }
  return scope.scope.controlState;
}

function mapRevision(): number {
  const scope = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
  if (scope.kind !== 'scope' || scope.scope === null) {
    throw new Error('Scope 不存在');
  }
  return scope.scope.mapRevision;
}

type ObservingStore = {
  readonly store: BranchCoordinationStore;
  readonly commands: CoordinationCommand[];
  transactCount(): number;
};

/** 记录经过 store 的每条命令：用于断言「取消意图先于停止请求」与「Exit 零写入」。 */
function observingStore(inner: BranchCoordinationStore): ObservingStore {
  const commands: CoordinationCommand[] = [];
  let transactions = 0;
  return {
    store: {
      query: (input) => inner.query(input),
      transact: (input) => {
        commands.push(input);
        transactions += 1;
        return inner.transact(input);
      },
    },
    commands,
    transactCount: () => transactions,
  };
}

function fakeWorkers(
  list: ActiveWorkerListResult,
  outcomes: Readonly<Record<string, 'stopped' | 'unconfirmed' | 'unverifiable'>>,
): { readonly port: WorkerStopPort; readonly listed: number; readonly stops: readonly string[] } {
  const counter = { listed: 0 };
  const stops: string[] = [];
  const port: WorkerStopPort = {
    listActiveDispatches: () => {
      counter.listed += 1;
      return Promise.resolve(list);
    },
    requestStop: ({ dispatchId }) => {
      stops.push(dispatchId);
      return Promise.resolve(outcomes[dispatchId] ?? 'unconfirmed');
    },
  };
  return {
    port,
    get listed() {
      return counter.listed;
    },
    stops,
  };
}

type ReconciliationProbe = {
  readonly runner: ScopeReconciliationRunner;
  readonly calls: { readonly expectedRevision: number; readonly controlStateAtCall: ControlState }[];
};

function reconciliationProbe(
  outcome: { readonly kind: 'reconciled' } | { readonly kind: 'rejected'; readonly code: string; readonly message: string } = {
    kind: 'reconciled',
  },
): ReconciliationProbe {
  const calls: { expectedRevision: number; controlStateAtCall: ControlState }[] = [];
  const runner: ScopeReconciliationRunner = (input) => {
    calls.push({ expectedRevision: input.expectedRevision, controlStateAtCall: controlState() });
    return Promise.resolve(
      outcome.kind === 'reconciled'
        ? { kind: 'reconciled', summary: { revision: scopeRevision(), unresolvedLaneKeys: [] } }
        : outcome,
    );
  };
  return { runner, calls };
}

function service(input: {
  readonly workers: WorkerStopPort;
  readonly reconciliation: ScopeReconciliationRunner;
  readonly store?: BranchCoordinationStore;
}) {
  return createScopeControlService({
    store: input.store ?? store,
    reconciliation: input.reconciliation,
    workers: input.workers,
  });
}

function applied(result: ScopeControlResult): Extract<ScopeControlResult, { kind: 'applied' }> {
  if (result.kind !== 'applied') {
    throw new Error(`期望 applied，实际为 ${result.kind}`);
  }
  return result;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-scope-control-'));
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
    fullBranchRef: 'refs/heads/main',
    canonicalWorktreePath: '/tmp/orca-test-worktree',
  });
  if (initialized.kind !== 'initialized') {
    throw new Error('无法创建测试 Scope');
  }
  const acquired = acquireRuntimeLease(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_A,
    runtimeIncarnationId: INC_A,
    fencingGeneration: 0,
  });
  if (acquired.kind !== 'acquired') {
    throw new Error('无法取得 Runtime Lease');
  }
  writer = {
    coordinatorSessionId: SESSION_A,
    runtimeIncarnationId: INC_A,
    fencingGeneration: acquired.lease.fencingGeneration,
  };
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test('暂停：存在活跃 Worker 时停止新派发与模型恢复，但不停止已运行 Worker 与对账', () => {
  const workers = fakeWorkers({ kind: 'listed', dispatchIds: ['dispatch-1', 'dispatch-2'] }, {});
  const reconciliation = reconciliationProbe();
  const control = service({ workers: workers.port, reconciliation: reconciliation.runner });

  const result = applied(control.pause({ coordinationScopeId: SCOPE, writer }));

  expect(result.controlState).toBe('paused');
  expect(controlState()).toBe('paused');
  // 已运行 Worker 不被停止：既不枚举，也不请求停止。
  expect(workers.listed).toBe(0);
  expect(workers.stops).toEqual([]);
  // 控制动作不停止事件落盘与对账。
  expect(result.verdict.stopsRunningWorkers).toBe(false);
  expect(result.verdict.stopsEventPersistence).toBe(false);
  expect(result.verdict.stopsReconciliation).toBe(false);
  // 暂停期间不恢复模型，也不产生对账。
  expect(reconciliation.calls).toEqual([]);
  expect(mayDispatch('paused')).toBe(false);
  expect(mayResumeModel('paused')).toBe(false);
  expect(scopeControlGate('paused').requiresReconciliation).toBe(true);
});

test('恢复：先对账再恢复调度，且不重置已消耗的预算、claim、lease 与 graph revision', async () => {
  const executionLease = acquireExecutionLease(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_A,
    runtimeIncarnationId: INC_A,
    fencingGeneration: writer.fencingGeneration,
  });
  expect(executionLease.kind).toBe('acquired');
  const consumed = store.transact({
    kind: 'consume-budget',
    coordinationScopeId: SCOPE,
    expectedRevision: scopeRevision(),
    writer,
    budgetKey: 'coordinator_model_calls',
    approvedLimitRef: 'limit-1',
    amount: 3,
  });
  expect(consumed.kind).toBe('committed');
  const claimed = store.transact({
    kind: 'record-ticket-claim',
    coordinationScopeId: SCOPE,
    expectedRevision: scopeRevision(),
    writer,
    ticketRef: { kind: 'decision-ticket', id: 'ticket-1' },
  });
  expect(claimed.kind).toBe('committed');
  const graph = recordInitialGraph({
    store,
    coordinationScopeId: SCOPE,
    writer,
    graph: { graphId: GRAPH_ID, generation: 1 as GraphGeneration, concurrencyLimit: 1, workPackages: [] },
    mapRevision: mapRevision(),
    planRevision: 1,
    orcaRunId: 'run-1',
  });
  if (graph.kind !== 'recorded') {
    throw new Error(`无法记录图：${graph.failure.message}`);
  }
  const graphVersionBefore = graph.version.version;

  const workers = fakeWorkers({ kind: 'listed', dispatchIds: ['dispatch-1'] }, {});
  const reconciliation = reconciliationProbe();
  const control = service({ workers: workers.port, reconciliation: reconciliation.runner });

  applied(control.pause({ coordinationScopeId: SCOPE, writer }));
  const revisionsWhilePaused = [scopeRevision()];
  const resumed = applied(await control.resume({ coordinationScopeId: SCOPE, writer }));

  // 先对账：对账被调用时控制状态仍为 paused，且用的是恢复前读到的 revision。
  expect(reconciliation.calls).toHaveLength(1);
  expect(reconciliation.calls[0]?.controlStateAtCall).toBe('paused');
  expect(reconciliation.calls[0]?.expectedRevision).toBe(revisionsWhilePaused[0]);
  expect(resumed.reconciliation).not.toBeNull();
  expect(resumed.controlState).toBe('active');
  expect(controlState()).toBe('active');
  expect(mayDispatch('active')).toBe(true);

  // 不重置已消耗资源。
  const counters = store.query({ kind: 'budget-counters', coordinationScopeId: SCOPE });
  expect(counters.kind === 'budget-counters' ? counters.counters[0]?.consumed : null).toBe(3);
  const claims = store.query({ kind: 'snapshot', coordinationScopeId: SCOPE });
  if (claims.kind !== 'snapshot') {
    throw new Error('无法读取 snapshot');
  }
  expect(claims.snapshot.ticketClaims.filter((claim) => claim.state === 'active')).toHaveLength(1);
  expect(claims.snapshot.executionLease?.coordinatorSessionId).toBe(SESSION_A);
  const graphAfter = store.query({ kind: 'graph-versions', coordinationScopeId: SCOPE, graphId: GRAPH_ID });
  expect(graphAfter.kind === 'graph-versions' ? graphAfter.versions.at(-1)?.version : null).toBe(
    graphVersionBefore,
  );
  // 对账运行在恢复之前，但不请求任何 Worker 停止。
  expect(workers.stops).toEqual([]);
});

test('恢复：对账失败时保持 paused，不进入 active', async () => {
  const workers = fakeWorkers({ kind: 'listed', dispatchIds: [] }, {});
  const reconciliation = reconciliationProbe({
    kind: 'rejected',
    code: 'unavailable',
    message: '对账后端不可达',
  });
  const control = service({ workers: workers.port, reconciliation: reconciliation.runner });

  applied(control.pause({ coordinationScopeId: SCOPE, writer }));
  const resumed = await control.resume({ coordinationScopeId: SCOPE, writer });

  expect(resumed.kind).toBe('rejected');
  expect(controlState()).toBe('paused');
});

test('取消：先落盘取消意图，未确认时保持 cancelling，无法核验时保持 unverifiable', async () => {
  const cases = [
    {
      name: '未确认',
      list: { kind: 'listed', dispatchIds: ['dispatch-1'] } satisfies ActiveWorkerListResult,
      outcomes: { 'dispatch-1': 'unconfirmed' } as const,
      expected: 'cancelling' as ControlState,
    },
    {
      name: '无法核验',
      list: { kind: 'listed', dispatchIds: ['dispatch-1'] } satisfies ActiveWorkerListResult,
      outcomes: { 'dispatch-1': 'unverifiable' } as const,
      expected: 'unverifiable' as ControlState,
    },
    {
      name: '名单不可枚举',
      list: { kind: 'unavailable', reason: '或不可达' } satisfies ActiveWorkerListResult,
      outcomes: {},
      expected: 'unverifiable' as ControlState,
    },
    {
      name: '没有活跃 Worker',
      list: { kind: 'listed', dispatchIds: [] } satisfies ActiveWorkerListResult,
      outcomes: {},
      expected: 'cancelled' as ControlState,
    },
  ];

  for (const scenario of cases) {
    const observed = observingStore(store);
    const workers = fakeWorkers(scenario.list, scenario.outcomes);
    const reconciliation = reconciliationProbe();
    const control = service({
      store: observed.store,
      workers: workers.port,
      reconciliation: reconciliation.runner,
    });

    const before = observed.transactCount();
    const result = applied(await control.cancel({ coordinationScopeId: SCOPE, writer }));
    const issued = observed.commands.slice(before);

    expect(result.controlState).toBe(scenario.expected);
    expect(controlState()).toBe(scenario.expected);
    // 取消意图先落盘：第一条命令必须是 cancelling。
    expect(issued[0]?.kind).toBe('record-control-state');
    expect(issued[0]?.kind === 'record-control-state' ? issued[0].controlState : null).toBe('cancelling');
    // 未被确认的停止一律不报告为已停止。
    if (scenario.expected !== 'cancelled') {
      expect(result.workerStops.every((stop) => stop.outcome !== 'stopped')).toBe(true);
    }
    // 取消期间不恢复模型、不派发。
    expect(mayDispatch(scenario.expected)).toBe(false);
    expect(mayResumeModel(scenario.expected)).toBe(false);

    // 复位到 active，继续下一组。
    store.transact({
      kind: 'record-control-state',
      coordinationScopeId: SCOPE,
      expectedRevision: scopeRevision(),
      writer,
      controlState: 'active',
    });
  }
});

test('取消后的迟到事件不重新激活当前代际', () => {
  expect(controlStateAfterCancel(['stopped'])).toBe('cancelled');
  expect(lateEventDisposition('cancelling')).toBe('historical');
  expect(lateEventDisposition('cancelled')).toBe('historical');
  expect(lateEventDisposition('active')).toBe('current_generation');
  expect(mayResumeModel('cancelling')).toBe(false);
  expect(mayResumeModel('cancelled')).toBe(false);
  expect(scopeControlGate('cancelling').mayDispatch).toBe(false);
});

test('退出：不写控制状态、不请求 Worker 停止，也不隐式 Pause 或 Cancel', () => {
  const observed = observingStore(store);
  const workers = fakeWorkers({ kind: 'listed', dispatchIds: ['dispatch-1'] }, { 'dispatch-1': 'stopped' });
  const reconciliation = reconciliationProbe();
  const control = service({
    store: observed.store,
    workers: workers.port,
    reconciliation: reconciliation.runner,
  });

  const before = observed.transactCount();
  const result = control.exit();

  expect(result.kind).toBe('exited');
  expect(result.controlStateWritten).toBeNull();
  expect(result.verdict.controlState).toBeNull();
  expect(result.verdict.endsProcess).toBe(true);
  expect(result.verdict.stopsRunningWorkers).toBe(false);
  expect(observed.transactCount()).toBe(before);
  expect(controlState()).toBe('active');
  expect(workers.stops).toEqual([]);
  expect(reconciliation.calls).toEqual([]);
});

test('退出后重入：不假设 Worker 已停止，先对账且不重复派发同一 Worker Task', async () => {
  const workers = fakeWorkers({ kind: 'listed', dispatchIds: ['dispatch-1'] }, { 'dispatch-1': 'stopped' });
  const reconciliation = reconciliationProbe();
  const control = service({ workers: workers.port, reconciliation: reconciliation.runner });

  control.exit();
  const policy = reentryPolicy();
  expect(policy.assumesWorkersStopped).toBe(false);
  expect(policy.requiresReconciliationBeforeDispatch).toBe(true);
  // 已观察到 live / unverifiable 的 Worker 不得重复派发；只有 exited 才能重新派发。
  expect(mayRedispatchWorker('live')).toBe(false);
  expect(mayRedispatchWorker('unverifiable')).toBe(false);
  expect(mayRedispatchWorker('exited')).toBe(true);

  const resumed = applied(await control.resume({ coordinationScopeId: SCOPE, writer }));
  expect(reconciliation.calls).toHaveLength(1);
  expect(resumed.controlState).toBe('active');
  // 重入不请求停止、也不重新派发任何 Worker Task。
  expect(workers.stops).toEqual([]);
});

test('控制动作判决与模式正交：Exit 与 Resume 都不改变 CoordinationMode', () => {
  expect(evaluateScopeControl('exit').controlState).toBeNull();
  expect(evaluateScopeControl('cancel').persistBeforeSideEffect).toBe(true);
  expect(evaluateScopeControl('resume').reconcileBeforeScheduling).toBe(true);
  expect(evaluateScopeControl('pause').resetsConsumedResources).toBe(false);
  const scope = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
  if (scope.kind !== 'scope' || scope.scope === null) {
    throw new Error('Scope 不存在');
  }
  expect(scope.scope.mode).toBe('route_planning');
});
