import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** Production read service + clearly isolated schema-17 historical fixture rows. */
export async function createGraphBasisPreviewPorts() {
  const { createExecutionScopeHarness } = await import('../../dist/tests/support/execution-harness.js');
  const { createGraphBasisService } = await import('../../dist/src/application/tui/graph-basis-service.js');
  const { createOpenSpecProvider } = await import('../../dist/src/adapters/specification/openspec/provider.js');
  const { openCoordinationStore } = await import('../../dist/src/adapters/storage/coordination-store.js');
  const harness = createExecutionScopeHarness();
  const databasePath = harness.databasePath;
  const scope = harness.scopeId;
  const sessionId = 'session-a';
  const graph1 = harness.currentGraph();
  const revisionBeforeSeed = harness.revision();
  const authorization = harness.authorization();
  const initial = harness.store.query({ kind: 'graph-basis-range', coordinationScopeId: scope,
    source: { kind: 'initial_plan', graphId: graph1.graphId, generation: graph1.generation, version: 1 }, offset: 0, maxBytes: 4 });
  const readDb = new DatabaseSync(databasePath, { readOnly: true });
  const planRow = readDb.prepare(
    'SELECT initial_plan_json FROM graph_versions WHERE coordination_scope_id = ? AND graph_id = ? AND graph_version = 1',
  ).get(scope, graph1.graphId);
  readDb.close();
  if (initial.kind !== 'graph-basis-range' || !initial.found || !planRow?.initial_plan_json) throw new Error('schema-17 initial plan fixture missing');
  const planJson = planRow.initial_plan_json;

  const specRoot = mkdtempSync(join(tmpdir(), 'graph-basis-openspec-'));
  const changeName = 'graph-basis-preview';
  const change = join(specRoot, 'openspec/changes', changeName);
  mkdirSync(change, { recursive: true });
  const nativeBody = '# 原生规格依据\n\n' + ('保留 Terminal 分页、历史来源版本和 resize 后的返回位置。\n').repeat(1800);
  writeFileSync(join(change, 'proposal.md'), '# 图历史依据预览\n\n本地隔离 OpenSpec 工件。\n');
  writeFileSync(join(change, 'design.md'), nativeBody);
  writeFileSync(join(change, 'tasks.md'), '## Tasks\n\n- [ ] 预览夹具\n');
  const locator = { worktreeId: 'preview-worktree', relativePath: `openspec/changes/${changeName}` };
  const provider = createOpenSpecProvider({ resolveWorktreeRoot: id => id === locator.worktreeId ? specRoot : null });
  const unit = await provider.readUnit(locator);
  if (unit.kind !== 'read') throw new Error(`OpenSpec fixture unit: ${unit.failure.message}`);

  // SQL below seeds only versioned graph history/generation metadata and a conspicuously named preview binding.
  // It does not exercise (or claim) an accepted Worker result, Orca Task execution, or business patch workflow.
  harness.store.close();
  const db = new DatabaseSync(databasePath);
  const now = Date.now();
  const originalGraph = graph1.graph;
  const retiredId = 'wp-d';
  const archivedGraphId = 'scope-1#g0';
  const archivedGraph = { ...originalGraph, graphId: archivedGraphId, generation: 0 };
  db.prepare(`INSERT INTO graph_generations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(scope, archivedGraphId, 0, 'fixture-cycle-0', 'fixture-run-0', null, 'fixture-head-0', 'frozen', now, now);
  db.prepare(`INSERT INTO graph_versions
    (coordination_scope_id,graph_id,graph_version,graph_generation,record_kind,parent_version,map_revision,plan_revision,orca_run_id,graph_json,recorded_at,patch_id,patch_json,initial_plan_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(scope, archivedGraphId, 1, 0, 'initial', null, 1, 1, 'fixture-run-0', JSON.stringify(archivedGraph), now - 100000, null, null, planJson);
  db.prepare(`INSERT INTO graph_generations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(scope, graph1.graphId, 1, 'cycle-1', 'run-1', archivedGraphId, 'head-1', 'active', now, now);
  const insertVersion = db.prepare(`INSERT INTO graph_versions
    (coordination_scope_id,graph_id,graph_version,graph_generation,record_kind,parent_version,map_revision,plan_revision,orca_run_id,graph_json,recorded_at,patch_id,patch_json,initial_plan_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let topology = originalGraph;
  for (let version = 2; version <= 24; version += 1) {
    if (version === 2) topology = { ...originalGraph, workPackages: originalGraph.workPackages.filter(item => item.workPackageId !== retiredId) };
    const patch = { patchId: `fixture-patch-${version}`, operationId: `fixture-op-${version}`, baseGraphVersion: version - 1,
      added: [], revised: [], retired: version === 2 ? [retiredId] : [], descendants: [], takesOver: [] };
    insertVersion.run(scope, graph1.graphId, version, 1, 'accepted_revision', version - 1, version + 1, version + 2,
      'run-1', JSON.stringify(topology), now + version, patch.patchId, JSON.stringify(patch), null);
  }
  db.prepare("UPDATE graph_generations SET status='frozen',updated_at=? WHERE coordination_scope_id=? AND graph_id=?")
    .run(now, scope, graph1.graphId);

  // Add generation 2 as current, with its own exact manifest and plan. Keep generation 1's patch lineage frozen.
  const graph2Id = 'scope-1#g2';
  const graph2 = { ...originalGraph, graphId: graph2Id, generation: 2, workPackages: topology.workPackages };
  const plan2 = { ...JSON.parse(planJson), planRevision: 26,
    workPackages: JSON.parse(planJson).workPackages.filter(item => item.key !== 'wp-4') };
  const manifest2 = { ...authorization.manifest, planningCycleId: 'cycle-2', orcaRunId: 'fixture-run-2',
    graph: { graphId: graph2Id, generation: 2, version: 1 } };
  db.prepare('INSERT INTO graph_generations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(scope, graph2Id, 2, 'cycle-2', 'fixture-run-2', graph1.graphId, 'fixture-head-2', 'active', now, now);
  insertVersion.run(scope, graph2Id, 1, 2, 'initial', null, 25, 26, 'fixture-run-2', JSON.stringify(graph2), now + 25,
    null, null, JSON.stringify(plan2));
  db.prepare(`INSERT INTO execution_authorizations
    (coordination_scope_id,authorization_id,authorization_version,manifest_version,fingerprint,approval_ref,manifest_json,approved_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(scope, 'fixture-auth-g2', 2, 2, 'fixture-fingerprint-g2', 'fixture-approval-g2', JSON.stringify(manifest2), now);
  db.prepare(`UPDATE scope SET planning_cycle_id='cycle-2',graph_id=?,graph_version=1,authorization_id='fixture-auth-g2',
    authorization_version=2,revision=revision+1,updated_at=? WHERE coordination_scope_id=?`).run(graph2Id, now, scope);

  const specBinding = { provider: unit.value.provider, relativePath: locator.relativePath, contentDigest: unit.value.contentDigest,
    providerVersion: unit.value.providerVersion, contractRevision: unit.value.contractRevision, trackingRevision: unit.value.trackingRevision };
  const bindingInsert = db.prepare(`INSERT INTO materialization_bindings
    (coordination_scope_id,work_package_id,creation_operation_id,role,worker_task_id,dispatch_id,attempt_id,worktree_id,
     spec_binding_json,specification_unit_path,orca_task_id,created_at,launch_id,authorization_id,authorization_version,worker_profile_ref,utility_role)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  bindingInsert.run(scope, retiredId, 'preview-fixture-operation', 'implementation', 'preview-fixture-worker-task',
    'preview-fixture-dispatch', 'preview-fixture-attempt', locator.worktreeId, JSON.stringify(specBinding), null,
    'preview-fixture-orca-task', now, 'preview-fixture-launch', 'auth-1', 1, 'profile-implementation', null);
  db.close();

  const opened = openCoordinationStore({ databasePath });
  if (opened.kind !== 'opened') throw new Error(`reopen schema-17 preview store: ${opened.message}`);
  const store = opened.store;
  const trackerBody = '目标：完成图历史与执行依据阅读。\n当前路线图修订：fixture-route-map-v2。\n批准范围：保留原始来源、关系选择和 resize 返回。\n' +
    ('路线图正文续页用于验证 tracker body 的 UTF-8 分页与来源版本固定。\n').repeat(1300);
  const tracker = { readIssueBody: async ref => ({ kind: 'read', value: {
    ref, title: '执行图资料 / Route Map', body: trackerBody, sourceVersion: 'preview-tracker-body-v2', updatedAt: '2026-10-04T00:00:00Z',
  } }) };
  const graphBasis = createGraphBasisService({ store, coordinationScopeId: scope, tracker, routeMapIssueRef: 'preview-route-map',
    specification: async () => provider });
  const topology2 = { graphId: graph2Id, graphVersion: 1, generation: 2,
    nodes: graph2.workPackages.map(item => ({ workPackageId: item.workPackageId, title: item.title,
      dependsOn: item.dependsOn, scopeEnvelope: item.scopeEnvelope })),
    readiness: { generationStatus: 'active', authorizationBound: true } };
  const snapshot = {
    coordinationScopeId: scope, revision: revisionBeforeSeed + 1, mode: 'execution_coordination', controlState: 'active',
    planningCycleId: 'cycle-2', mapRevision: 25, graph: { graphId: graph2Id, graphVersion: 1, generation: 2 },
    authorization: { authorizationId: 'fixture-auth-g2', version: 2 }, executionLeaseHolderSessionId: sessionId, selectedSessionId: sessionId,
    sessions: [{ coordinatorSessionId: sessionId, coordinatorModelConfigurationRef: 'model-config-1', lifecycleState: 'active',
      holdsRuntimeLease: true, holdsExecutionLease: true, planningResponsible: true, openInteractionCount: 0 }],
    budgets: [], frontier: [], workers: [], blockers: [], interactions: [], openInteractionCount: 0, handoffs: [], recoveries: [],
    executionReconciliation: { pending: false, unresolvedIntentCount: 0, activeWorkerCount: 0, reasons: [] },
    finalizer: { gate: { ready: false, blockers: ['preview_fixture'] }, coversWorkPackageIds: [], worktreePath: null,
      readOnlyProfile: 'preview', integrationFrozen: 'unknown', workspace: null, evidenceRefs: [], verdict: null },
    graphEvolution: { generations: [], revisionHolds: [], reconciliations: [], lineages: [], adoptions: [] }, maintenance: null,
    graphTopologies: [topology2], planningHandoffs: [], compaction: null,
  };
  const projectStatus = await (await import('../project-statusline/preview-ports.mjs')).createPreviewPorts(snapshot);
  const present = projectStatus.presentation;
  projectStatus.presentation = (current, selected) => ({ ...present(current, selected), acceptance: null,
    activeWorkPackage: { id: 'wp-a', title: '图历史与执行依据（fixture）' },
    session: selected ? { id: selected, model: selected === 'session-b' ? '示例模型 B' : '示例模型 A', provider: '示例 provider', effort: { status: 'configured', value: selected === 'session-b' ? 'medium' : 'high' } } : null });
  const projectDetails = projectStatus.ports.projectDetails;
  projectStatus.ports.projectDetails = { read: async query => query.objectKey === 'work-package:wp-a'
    ? ({ kind: 'page', page: { objectKey: query.objectKey, coordinatorSessionId: query.coordinatorSessionId, revision: query.seenRevision,
        items: [{ key: 'fixture-work', label: '工作包', value: 'wp-a · 图历史与执行依据（隔离 fixture）', offset: 0, end: 44, byteLength: 44 },
          { key: 'fixture-state', label: '状态', value: '示例状态；不是实时 Worker', offset: 0, end: 36, byteLength: 36 },
          { key: 'fixture-worktree', label: '工作区', value: '/tmp/orca-companion-preview/wp-a（临时 fixture）', offset: 0, end: 48, byteLength: 48 },
          { key: 'fixture-basis', label: '依据入口', value: 'Enter 打开 GraphBasis 来源目录', offset: 0, end: 33, byteLength: 33 }], nextCursor: null } })
    : projectDetails.read(query) };
  return { store, graphBasis, projectStatus, scope, sessionId, snapshot,
    close: () => { store.close(); rmSync(dirname(databasePath), { recursive: true, force: true }); rmSync(specRoot, { recursive: true, force: true }); } };
}
