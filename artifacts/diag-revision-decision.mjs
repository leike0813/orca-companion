/* global console, process */
/**
 * 离线判定脚本：用**真实夹具**的持久事实 + 真实 Orca 观察，复现宿主在修订节点上的判定。
 *
 * 用途：真实 PTY 运行停住时，不必再盲跑一轮——直接对某个夹具回答三个问题：
 *   1. 受限修订 Planner 的许可到底给没给（`permits` / `denials`）；
 *   2. 当前 Frontier 每个节点的 `state` / `role` / `liveness`；
 *   3. 若没给许可，缺的是哪一条具体事实（例如 `dispatch-unsettled:<worker-task>`）。
 *
 * 用法：
 *   export PATH="$HOME/.cache/orca-acceptance/acceptance-bin:$PATH"   # Orca 包装器（只读命令需要）
 *   node artifacts/diag-revision-decision.mjs <fixture-path> <identity-term-handle>
 *
 * 例：
 *   node artifacts/diag-revision-decision.mjs \
 *     /home/joshua/Workspace/Artifact/orca-companion-e2e52 term_2abe2d1d-fd43-4ea3-9712-0eeb62e8922d
 *
 * 只读：store 以 readOnly 打开，Orca 只调 `worker-list`。入口与身份都从参数取，不猜当前进程环境。
 */
import { createOrcaExecutionBackend } from '../dist/src/adapters/orca-cli/orca-backend.js';
import { openCoordinationStore } from '../dist/src/adapters/storage/coordination-store.js';
import {
  deriveExecutionFacts,
  workerStateLiveness,
} from '../dist/src/application/execution/execution-view.js';
import {
  revisionPlannerFacts,
  nextAdvanceRoleOf,
  plannerDeliveryAfterHold,
} from '../dist/src/application/execution/advance-execution.js';

const FIXTURE = process.argv[2];
const IDENTITY = process.argv[3];
const SCOPE = process.argv[4] ?? 'e2e-loop-scope';

if (FIXTURE === undefined || IDENTITY === undefined) {
  console.error('用法: node artifacts/diag-revision-decision.mjs <fixture-path> <identity-term-handle> [scope-id]');
  process.exit(2);
}

const opened = openCoordinationStore({
  databasePath: `${FIXTURE}/.git/orca-companion/coordination.sqlite`,
  readOnly: true,
});
if (opened.kind !== 'opened') {
  console.error('无法打开 coordination store:', JSON.stringify(opened));
  process.exit(1);
}
const store = opened.store;

const scope = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
const snapshot = store.query({ kind: 'snapshot', coordinationScopeId: SCOPE });
if (scope.kind !== 'scope' || snapshot.kind !== 'snapshot' || scope.scope === null) {
  console.error('无法读取 Scope 或快照');
  process.exit(1);
}
const scopeRecord = scope.scope;
const graphRecord = store.query({
  kind: 'graph-version',
  coordinationScopeId: SCOPE,
  graphId: scopeRecord.graphId,
  graphVersion: scopeRecord.graphVersion,
});
const graph = graphRecord.version.graph;

console.log(
  'scope:',
  JSON.stringify({
    mode: scopeRecord.mode,
    control: scopeRecord.controlState,
    graphId: scopeRecord.graphId,
    version: scopeRecord.graphVersion,
    auth: scopeRecord.authorizationId,
  }),
);
console.log(
  'holds:',
  JSON.stringify(
    snapshot.snapshot.revisionHolds.map((hold) => ({
      wp: hold.workPackageId,
      state: hold.state,
      source: hold.source,
      prior: hold.priorContractRevision,
      admitted: hold.admittedContractRevision,
      createdAt: hold.createdAt,
    })),
  ),
);

const backend = createOrcaExecutionBackend({ cwd: FIXTURE, env: process.env });
const generation = snapshot.snapshot.graphGenerations.find((entry) => entry.graphId === scopeRecord.graphId);
const workerList = await backend.query({ operation: 'worker-list', runId: generation.orcaRunId });
if (workerList.kind !== 'accepted') {
  console.log('worker-list 不可读：', JSON.stringify(workerList));
}
const workers =
  workerList.kind === 'accepted'
    ? workerList.value.workers.map((worker) => ({
        dispatchId: worker.dispatchId ?? '',
        taskId: worker.taskId,
        workerState: worker.workerState,
        terminalState: worker.terminalState,
      }))
    : [];
console.log('worker-list:', workerList.kind, `workers=${workers.length}`);
console.log(
  'workers:',
  workers.map((worker) => `${worker.taskId}:${worker.workerState}->${workerStateLiveness(worker.workerState)}`).join(' '),
);

const observations = {
  workersEnumerated: workerList.kind === 'accepted',
  workers,
  worktreePaths: new Map(),
  unavailableReasons: [],
  finalizer: {
    readOnlyProfile: 'unverified',
    integrationFrozen: 'unknown',
    worktreePath: FIXTURE,
    workspace: null,
    evidenceRefs: [],
  },
};
const nodes = graph.workPackages.map((workPackage) => ({
  workPackageId: workPackage.workPackageId,
  dependsOn: [...workPackage.dependsOn],
}));
const derived = deriveExecutionFacts({
  snapshot: snapshot.snapshot,
  nodes,
  baselineHead: null,
  authority: null,
  observations,
});
console.log('frontier:');
for (const entry of derived.frontier) {
  console.log(
    `  ${entry.workPackageId} state=${entry.state} role=${String(entry.role)} liveness=${String(entry.liveness)}`,
  );
}

const permits = revisionPlannerFacts({
  graph,
  snapshot: snapshot.snapshot,
  observations,
  consumptionOf: (workPackageId) => {
    const counters = store.query({ kind: 'budget-counters', coordinationScopeId: SCOPE });
    if (counters.kind !== 'budget-counters') {
      return null;
    }
    return [
      'implementationAttempts',
      'validatorRepairs',
      'graphRevisions',
      'specificationRevisions',
      'maxRecoveriesPerWorkerAttempt',
    ].map((field) => ({
      workPackageId,
      field,
      consumed: counters.counters.find((counter) => counter.budgetKey === `work-package:${workPackageId}:${field}`)?.consumed ?? 0,
    }));
  },
});
console.log('permits:', JSON.stringify(permits.permits));
console.log('denials:', JSON.stringify(permits.denials));
for (const entry of derived.frontier) {
  const permit = permits.permits.find((candidate) => candidate.workPackageId === entry.workPackageId) ?? null;
  console.log(
    `nextRole(${entry.workPackageId}) =`,
    String(nextAdvanceRoleOf({ state: entry.state, role: entry.role, revisionPlanner: permit })),
  );
}

// 持有结算条件：pending 持有 + 持有登记之后签发并已结算的 Planner 交付 ⇒ 宿主会释放持有。
for (const hold of snapshot.snapshot.revisionHolds.filter((entry) => entry.state === 'pending')) {
  const admitted = plannerDeliveryAfterHold(snapshot.snapshot, hold);
  console.log(
    `hold(${hold.workPackageId}) settle=${admitted === null ? 'blocked' : 'ready'}`,
    admitted === null
      ? '（还没有「持有登记之后签发并已结算」的 Planner 交付）'
      : `（接纳版本 ${String(admitted.contractRevision)}，被替换版本 ${String(hold.priorContractRevision)}）`,
  );
}
