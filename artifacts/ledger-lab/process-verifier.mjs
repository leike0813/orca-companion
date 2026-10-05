import { readFile, stat } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { isDeepStrictEqual } from 'node:util';
import { contract, summarize, overall } from './common.mjs';

const running = new Set(['running', 'active', 'working', 'in_progress']);
// Public workerState values checked against execution-view.ts; stop receipts are a different DTO.
const exited = new Set(['succeeded', 'failed', 'cancelled', 'canceled', 'exited', 'abandoned', 'completed', 'done', 'timed_out']);
const array = (value) => Array.isArray(value) ? value : [];
const present = (value) => typeof value === 'string' && value.length > 0;
const time = (value) => typeof value === 'number' ? value : Date.parse(value);
const eq = isDeepStrictEqual;
const setEqual = (a, b) => a.length === b.length && new Set(a).size === a.length && a.every((x) => b.includes(x));
const data = (sample, key) => array(sample.snapshot?.[key]);
const entries = (sample) => array(sample.snapshot?.status?.execution?.workPackages);
const state = (sample) => sample.snapshot?.scope?.controlState;
const graphMap = (mapping, id) => mapping.graphs.find((graph) => graph.graphId === id);
const accepted = (sample, id) => entries(sample).some((entry) => entry.workPackageId === id && entry.state === 'accepted');
const goodStore = (sample) => sample.sources?.store?.status === 'available' && sample.sources.store.consistent === true && Array.isArray(sample.sources.store.errors) && sample.sources.store.errors.length === 0;

export async function readEvidence(path) {
  // At most 128 MiB / 10,000 samples; a malformed final line is an incomplete capture, never dropped.
  if ((await stat(path)).size > 128 * 1024 * 1024) throw new Error('证据日志超过 128 MiB 上限');
  const body = await readFile(path, 'utf8');
  if (Buffer.byteLength(body) > 128 * 1024 * 1024) throw new Error('证据日志超过上限');
  const lines = body.split('\n').filter((line) => line.trim());
  if (lines.length > 10000) throw new Error('证据样本超过 10000 条上限');
  return lines.map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new Error(`证据第 ${index + 1} 行不是完整 JSON`); }
  });
}

function validateInputs(samples, mapping, observations, profile) {
  if (!['main', 'cancel'].includes(profile)) throw new Error('profile 必须为 main 或 cancel');
  if (mapping?.schemaVersion !== 1 || !present(mapping.coordinationScopeId) || !Array.isArray(mapping.graphs)) throw new Error('mapping schema 无效');
  const graphIds = new Set();
  for (const graph of mapping.graphs) {
    if (!present(graph.graphId) || graphIds.has(graph.graphId) || !graph.nodes || !graph.lanes) throw new Error('mapping 图身份或节点无效');
    graphIds.add(graph.graphId);
    const ids = Object.values(graph.nodes);
    if (!ids.every(present) || new Set(ids).size !== ids.length || ids.some((id) => !present(graph.lanes[id]))) throw new Error('mapping 节点不能重用且必须有 lane');
  }
  if (observations?.schemaVersion !== 1 || observations.coordinationScopeId !== mapping.coordinationScopeId || !Array.isArray(observations.entries)) throw new Error('observations 身份或 schema 无效');
  for (const note of observations.entries) {
    if (!contract.scenarios.some((s) => s.id === note.scenarioId) || !['note', 'start', 'end', 'blocked', 'missed', 'assessment'].includes(note.kind) || !Number.isFinite(time(note.at)) || typeof note.text !== 'string') throw new Error('观察记录字段无效');
    if (note.rating !== undefined && (!Number.isInteger(note.rating) || note.rating < 1 || note.rating > 5)) throw new Error('观察评分必须为 1–5');
  }
  for (const sample of samples) {
    if (sample?.schemaVersion !== 1 || sample.kind !== 'sample' || !present(sample.sampleId) || !present(sample.repositoryPath) || !Number.isFinite(time(sample.observedAt)) || !Number.isFinite(time(sample.startedAt)) || time(sample.startedAt) > time(sample.observedAt) || !sample.sources || !sample.snapshot) throw new Error('证据 sample schema 无效');
    if (sample.coordinationScopeId !== mapping.coordinationScopeId || (sample.snapshot.scope && sample.snapshot.scope.coordinationScopeId !== mapping.coordinationScopeId)) throw new Error('证据混入其他 Scope');
    for (const key of ['bindings', 'segments', 'settlements', 'recoveries', 'holds', 'intents', 'budgets', 'verdicts', 'authorizations', 'leases', 'patches', 'generations']) {
      for (const record of data(sample, key)) if (record.coordinationScopeId && record.coordinationScopeId !== mapping.coordinationScopeId) throw new Error('权威记录混入其他 Scope');
    }
  }
  if (new Set(samples.map((sample) => sample.repositoryPath)).size > 1) throw new Error('证据混入其他仓库');
}

function cohorts(sample, mapping) {
  const result = [];
  for (const run of array(sample.sources?.orca?.runs)) {
    const payload = run.result?.kind === 'accepted' ? run.result.value : null;
    if (!payload || !Array.isArray(payload.workers)) continue;
    const generation = data(sample, 'generations').find((g) => g.orcaRunId === run.runId);
    const graph = generation && graphMap(mapping, generation.graphId);
    const seen = new Set();
    let uncertain = !graph || run.complete !== true || payload.truncated === true || payload.nextCursor != null;
    const live = [];
    for (const worker of payload.workers) {
      if (!worker.dispatchId || worker.runId !== run.runId || seen.has(worker.dispatchId)) { uncertain = true; continue; }
      seen.add(worker.dispatchId);
      const bindings = data(sample, 'bindings').filter((b) => b.orcaTaskId === worker.taskId);
      const binding = bindings[0];
      // Lane attribution needs the exact Orca Task binding, which exists before a Segment.
      // The envelope's logical DispatchId is never compared with the real Orca DispatchId.
      const segment = data(sample, 'segments').find((s) => s.dispatchId === worker.dispatchId && s.workerTaskId === binding?.workerTaskId);
      const projection = array(sample.snapshot?.status?.workers).find((w) => w.dispatchId === worker.dispatchId && w.workerTaskId === binding?.workerTaskId);
      const wp = segment?.workPackageId ?? projection?.workPackageId ?? binding?.workPackageId;
      const lane = graph?.lanes?.[wp] ?? mapping.controlLanes?.[worker.taskId];
      if (running.has(worker.workerState)) {
        if (!binding || !present(lane) || (wp && bindings.some((b) => b.workPackageId !== wp))) uncertain = true;
        else live.push({ dispatchId: worker.dispatchId, workPackageId: wp, lane });
      } else if (!exited.has(worker.workerState)) uncertain = true;
    }
    result.push({ sampleId: sample.sampleId, runId: run.runId, live, uncertain });
  }
  return result;
}

function reaches(nodes, from, to, seen = new Set()) {
  if (from === to) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return array(nodes[from]?.dependsOn).some((id) => reaches(nodes, id, to, seen));
}
function structuralGraph(record, mapping) {
  const map = graphMap(mapping, record.graphId);
  if (!map) return null;
  const packages = array(record.graph?.workPackages);
  const labels = Object.keys(contract.referenceGraph);
  if (!setEqual(Object.keys(map.nodes).filter((label) => label !== 'F'), labels) || packages.length !== labels.length) return false;
  const nodes = Object.fromEntries(packages.map((p) => [p.workPackageId, p]));
  if (labels.some((label) => !nodes[map.nodes[label]] || map.lanes[map.nodes[label]] !== contract.referenceGraph[label].lane)) return false;
  // Compare reachability rather than incidental redundant transitive edges.
  return labels.every((from) => labels.every((to) => reaches(nodes, map.nodes[from], map.nodes[to]) === reaches(contract.referenceGraph, from, to)));
}

/** Evidence is observational. PASS always names its bounded claim; notes never supply runtime facts. */
export function verifyProcess({ samples, mapping, observations, profile = 'main' }) {
  validateInputs(samples, mapping, observations, profile);
  const identities = new Map();
  let conflict = false;
  for (const sample of samples) {
    if (identities.has(sample.sampleId) && !eq(identities.get(sample.sampleId), sample)) conflict = true;
    identities.set(sample.sampleId, sample);
  }
  const ordered = [...identities.values()].sort((a, b) => time(a.observedAt) - time(b.observedAt));
  const usable = ordered.filter(goodStore);
  const checks = contract.scenarios.map((scenario) => ({ ...scenario, status: 'NOT_COVERED', message: '未捕获此场景的确定性证据', evidence: [], assertions: [] }));
  const mark = (id, status, message, evidence = [], assertions = []) => Object.assign(checks.find((c) => c.id === id), { status, message, evidence: [...new Set(evidence)], assertions });
  const all = (key) => usable.flatMap((s) => data(s, key).map((record) => ({ sample: s, record })));
  const required = profile === 'main' ? 'core' : 'cancel';
  const report = () => {
    if (profile === 'cancel') for (const check of checks.filter((c) => c.group === 'core')) Object.assign(check, { status: 'NOT_COVERED', message: '取消档案不要求主运行场景', evidence: [], assertions: [] });
    return { schemaVersion: 1, kind: 'process-report', coordinationScopeId: mapping.coordinationScopeId,
    repositoryPath: ordered[0]?.repositoryPath ?? null, profile, status: checks.some((c) => c.group === 'conditional' && c.status === 'FAIL') ? 'FAIL' : overall(checks.filter((c) => c.group === required)), checks,
    summary: summarize(checks), coverage: { required: summarize(checks.filter((c) => c.group === required)), conditional: summarize(checks.filter((c) => c.group === 'conditional')) },
    capture: { samples: ordered.length, consistentStoreSamples: usable.length, first: ordered[0]?.observedAt ?? null, last: ordered.at(-1)?.observedAt ?? null, gitHead: ordered.at(-1)?.sources?.git?.status === 'available' ? ordered.at(-1).sources.git.head : null },
    limitations: ['轮询只证明所捕获时点和记录，不能证明采样间隙没有违规。', '业务 lane 由用户按实际图映射；机器核验不评价映射的业务合理性。', '人工观察与评分单列，不能替代机器证据。'], observations: observations.entries };
  };
  if (conflict || !usable.length) {
    for (const check of checks.filter((c) => c.group === required)) mark(check.id, 'INCONCLUSIVE', conflict ? '同一 sampleId 的证据冲突' : '没有完整且 Scope revision 一致的只读样本');
    return report();
  }
  const initial = all('graphs').filter(({ record }) => record.recordKind === 'initial' && graphMap(mapping, record.graphId));
  const firstInitial = initial.sort((a, b) => a.record.generation - b.record.generation)[0];
  if (firstInitial) {
    const matches = structuralGraph(firstInitial.record, mapping);
    mark('planning', matches ? 'PASS' : 'FAIL', matches ? '首代八节点依赖闭包及 lane 与业务基准一致' : '首代图引入额外串行依赖、缺少节点或 lane 映射不符', [firstInitial.sample.sampleId]);
  }
  const fleet = usable.flatMap((s) => cohorts(s, mapping));
  const parallel = fleet.find((c) => c.live.length >= 2 && new Set(c.live.map((w) => w.lane)).size >= 2);
  if (parallel) mark('parallel', 'PASS', '同一次 Run 名单捕获至少两条 lane 的真实 live Worker', [parallel.sampleId]);
  else if (firstInitial?.record.graph?.concurrencyLimit === 1) mark('parallel', 'BLOCKED', '实际授权图并发上限为 1，无法验证目标并行设计', [firstInitial.sample.sampleId]);
  const collision = fleet.find((c) => new Set(c.live.map((w) => w.lane)).size < c.live.length);
  if (collision) mark('lane-capacity', 'FAIL', '同一时点同一 lane 有多个 live Worker', [collision.sampleId]);
  else if (fleet.some((c) => c.live.length > 0)) mark('lane-capacity', fleet.some((c) => c.uncertain) ? 'INCONCLUSIVE' : 'PASS', fleet.some((c) => c.uncertain) ? '存在无法核验的 Worker、身份或名单覆盖范围' : '已捕获名单中的每 lane Worker 数均不超过 1', fleet.map((c) => c.sampleId));

  for (let i = 0; i < usable.length; i++) {
    const blockedSample = usable[i];
    const map = graphMap(mapping, blockedSample.snapshot.scope?.graphId);
    const blockedNode = entries(blockedSample).find((e) => e.workPackageId === map?.nodes.C2 && e.state === 'blocked' && e.blockerRefs?.length);
    if (!blockedNode) continue;
    const later = usable.slice(i + 1).find((s) => s.snapshot.scope?.graphId === map.graphId && entries(s).some((e) => e.workPackageId === map.nodes.C2 && e.state === 'blocked' && e.blockerRefs?.length) && ['A', 'B', 'J'].some((label) => !accepted(blockedSample, map.nodes[label]) && accepted(s, map.nodes[label])));
    if (later) { mark('local-block', 'PASS', 'C2 有明确局部 blocker 的两个采样点之间，无关 lane 的包取得接受结果', [blockedSample.sampleId, later.sampleId]); break; }
  }
  const joinProof = [];
  let joinFailure = false;
  let joinUnknown = false;
  const startedJoins = new Set();
  for (const sample of usable) {
    const map = graphMap(mapping, sample.snapshot.scope?.graphId);
    if (!map) continue;
    for (const [label, prerequisites] of [['J', ['A', 'B']], ['D', ['J', 'C2']]]) {
      const binding = data(sample, 'bindings').find((b) => b.workPackageId === map.nodes[label]);
      const key = `${map.graphId}/${label}`;
      if (!binding || startedJoins.has(key)) continue;
      startedJoins.add(key);
      const proof = usable.find((s) => s.snapshot.scope?.graphId === map.graphId && time(s.observedAt) <= binding.createdAt && prerequisites.every((dep) => accepted(s, map.nodes[dep])));
      if (proof) joinProof.push(proof.sampleId, sample.sampleId);
      else {
        // A snapshot acquired after materialization cannot tell which happened first.
        joinUnknown = true;
        const prior = usable.find((s) => s.snapshot.scope?.graphId === map.graphId && time(s.startedAt) > binding.createdAt && prerequisites.some((dep) => !accepted(s, map.nodes[dep])));
        if (prior) joinFailure = true;
      }
    }
  }
  if (joinFailure) mark('joins', 'FAIL', '汇合节点已物化时仍存在未接受前驱');
  else if (startedJoins.size) mark('joins', !joinUnknown && joinProof.length >= 4 ? 'PASS' : 'INCONCLUSIVE', !joinUnknown && joinProof.length >= 4 ? 'J 和 D 均在前驱接受之后物化' : '缺少两个汇合点物化前的接受快照', joinProof);

  const spec = all('holds').find(({ record }) => record.source === 'specification_revision' && record.state === 'released' && Number.isInteger(record.admittedContractRevision) && record.admittedContractRevision > record.priorContractRevision);
  if (spec) {
    const history = all('bindings').filter(({ record }) => record.workPackageId === spec.record.workPackageId).map(({ record }) => record);
    const trees = new Set(history.map((b) => b.worktreeId).filter(present));
    const before = history.find((b) => b.specBinding?.contractRevision === spec.record.priorContractRevision);
    const after = history.find((b) => b.specBinding?.contractRevision === spec.record.admittedContractRevision);
    mark('specification-revision', trees.size > 1 ? 'FAIL' : trees.size === 1 && before && after ? 'PASS' : 'INCONCLUSIVE', '独立 specification_revision hold 已释放；核验前后 contractRevision 与同包 worktree', [spec.sample.sampleId]);
  }
  const patch = all('patches').find(({ record }) => {
    const map = graphMap(mapping, record.graphId);
    return map && setEqual(array(record.added), [map.nodes.F]) && setEqual(array(record.revised), [map.nodes.A]) && setEqual(array(record.retired), [map.nodes.R]);
  });
  if (patch) {
    const map = graphMap(mapping, patch.record.graphId);
    const after = all('graphs').find(({ record }) => record.graphId === patch.record.graphId && record.version === patch.record.graphVersion && record.patchId === patch.record.patchId);
    const packages = array(after?.record.graph?.workPackages);
    const a = packages.find((p) => p.workPackageId === map.nodes.A);
    const f = packages.find((p) => p.workPackageId === map.nodes.F);
    const bindings = data(patch.sample, 'bindings');
    const aTrees = new Set(bindings.filter((b) => b.workPackageId === map.nodes.A).map((b) => b.worktreeId).filter(present));
    const fTrees = new Set(bindings.filter((b) => b.workPackageId === map.nodes.F).map((b) => b.worktreeId).filter(present));
    const sharesTree = bindings.some((b) => b.workPackageId !== map.nodes.F && fTrees.has(b.worktreeId));
    const okay = a && f && setEqual(a.dependsOn, contract.patch.revisedDependencies.map((label) => map.nodes[label])) && setEqual(f.dependsOn, contract.patch.dependsOn.map((label) => map.nodes[label])) && !packages.some((p) => p.workPackageId === map.nodes.R) && aTrees.size <= 1 && !sharesTree;
    mark('graph-patch', after ? (okay ? 'PASS' : 'FAIL') : 'INCONCLUSIVE', '核验同一 Accepted Graph Patch 的 add F、revise A、retire R 与追加拓扑', [patch.sample.sampleId, ...(after ? [after.sample.sampleId] : [])]);
  }
  const pausedIndex = usable.findIndex((s) => state(s) === 'paused');
  if (pausedIndex >= 0) {
    const paused = usable[pausedIndex];
    const resumed = usable.slice(pausedIndex + 1).find((s) => state(s) === 'active');
    const before = usable.slice(0, pausedIndex).at(-1);
    const pausedSamples = usable.slice(pausedIndex, resumed ? usable.indexOf(resumed) : undefined).filter((s) => state(s) === 'paused');
    const forbidden = pausedSamples.some((s) => data(s, 'bindings').some((b) => b.createdAt > time(paused.observedAt) && b.createdAt < time(s.startedAt)));
    if (forbidden) mark('pause-resume', 'FAIL', '已确认暂停区间产生新的角色 Task 物化');
    else if (resumed && before && cohorts(before, mapping).some((c) => c.live.length)) mark('pause-resume', 'PASS', '活跃 Worker 时暂停并恢复，捕获的暂停区间无新物化', [before.sampleId, ...pausedSamples.map((s) => s.sampleId), resumed.sampleId]);
    else mark('pause-resume', 'INCONCLUSIVE', '捕获暂停，但缺少活跃前态或恢复后态', pausedSamples.map((s) => s.sampleId));
  }
  for (let i = 1; i < usable.length; i++) {
    const before = usable[i - 1]; const after = usable[i];
    const changed = data(before, 'leases').find((lease) => lease.kind === 'runtime' && data(after, 'leases').some((l) => l.kind === 'runtime' && l.coordinatorSessionId === lease.coordinatorSessionId && l.runtimeIncarnationId !== lease.runtimeIncarnationId && l.fencingGeneration > lease.fencingGeneration));
    if (!changed) continue;
    const identity = before.snapshot.scope?.graphId === after.snapshot.scope?.graphId && before.snapshot.scope?.planningCycleId === after.snapshot.scope?.planningCycleId && eq(data(before, 'generations').map((g) => [g.graphId, g.orcaRunId]), data(after, 'generations').map((g) => [g.graphId, g.orcaRunId]));
    const retained = data(before, 'bindings').every((b) => data(after, 'bindings').some((a) => a.workerTaskId === b.workerTaskId && a.attemptId === b.attemptId && a.orcaTaskId === b.orcaTaskId && a.worktreeId === b.worktreeId));
    mark('restart', identity && retained ? 'PASS' : 'FAIL', '同一 Session 的 Runtime fencing 前进；核验原 Graph/Run/Task/worktree 保留', [before.sampleId, after.sampleId]); break;
  }
  const recovery = all('recoveries').find(({ record }) => record.status === 'recovered' && record.terminalOutcome === 'replaced');
  if (recovery) {
    const r = recovery.record;
    const segments = data(recovery.sample, 'segments');
    const source = segments.find((s) => s.segmentId === r.sourceSegmentId);
    const replacement = segments.find((s) => s.segmentId === r.replacementSegmentId);
    const okay = source && replacement && source.dispatchId === r.sourceDispatchId && replacement.dispatchId === r.replacementDispatchId && source.dispatchId !== replacement.dispatchId && source.workerTaskId === r.workerTaskId && replacement.workerTaskId === r.workerTaskId && source.attemptId === r.businessAttemptId && replacement.attemptId === r.businessAttemptId && source.workPackageId === r.workPackageId && replacement.workPackageId === r.workPackageId && source.role === r.role && replacement.role === r.role && Number.isSafeInteger(r.consumedBudget) && r.consumedBudget > 0 && r.consumedBudget <= contract.executionLimits.maxRecoveriesPerWorkerAttempt && present(r.capsuleRef) && r.supersededSegmentId === source.segmentId;
    mark('recovery', source && replacement ? (okay ? 'PASS' : 'FAIL') : 'INCONCLUSIVE', '核验恢复的 Task、business Attempt、Segment、Capsule 与独立预算', [recovery.sample.sampleId]);
  } else {
    const blocked = all('recoveries').find(({ record }) => record.status === 'blocked');
    if (blocked) mark('recovery', 'BLOCKED', blocked.record.blockingReason ?? '恢复被明确阻塞', [blocked.sample.sampleId]);
  }
  const cutover = usable.find((s) => data(s, 'generations').some((g) => g.status === 'active' && g.predecessorGraphId && data(s, 'generations').some((old) => old.graphId === g.predecessorGraphId && old.status === 'frozen')));
  if (cutover) {
    const next = data(cutover, 'generations').find((g) => g.status === 'active' && g.predecessorGraphId);
    const old = data(cutover, 'generations').find((g) => g.graphId === next.predecessorGraphId);
    const oldGraphs = data(cutover, 'graphs').filter((g) => g.graphId === old.graphId);
    const nextGraphs = data(cutover, 'graphs').filter((g) => g.graphId === next.graphId);
    const previous = oldGraphs.sort((a, b) => b.version - a.version)[0];
    const current = nextGraphs.sort((a, b) => b.version - a.version)[0];
    const ids = oldGraphs.flatMap((g) => array(g.graph?.workPackages).map((p) => p.workPackageId));
    const nextIds = nextGraphs.flatMap((g) => array(g.graph?.workPackages).map((p) => p.workPackageId));
    const oldTrees = new Set(data(cutover, 'bindings').filter((b) => ids.includes(b.workPackageId)).map((b) => b.worktreeId).filter(present));
    const reusedTree = data(cutover, 'bindings').some((b) => nextIds.includes(b.workPackageId) && oldTrees.has(b.worktreeId));
    const okay = present(next.orcaRunId) && present(old.orcaRunId) && next.orcaRunId !== old.orcaRunId && next.graphId !== old.graphId && next.planningCycleId !== old.planningCycleId && next.generation > old.generation && cutover.snapshot.scope.graphId === next.graphId && current && previous && nextIds.every((id) => !ids.includes(id)) && !reusedTree;
    mark('replanning', current && previous ? (okay ? 'PASS' : 'FAIL') : 'INCONCLUSIVE', '前代冻结，新代 Graph/Run/WorkPackage 身份分离；成果采用语义另由人工复核', [cutover.sampleId]);
  }
  const counterHistory = new Map(); let budgetFailure = false; let positive = false; let repeats = false;
  for (const sample of usable) {
    const counters = data(sample, 'budgets');
    const keys = new Set(counters.map((c) => JSON.stringify([c.approvedLimitRef, c.budgetKey])));
    if ([...counterHistory.keys()].some((key) => !keys.has(key))) budgetFailure = true;
    for (const counter of counters) {
      const key = JSON.stringify([counter.approvedLimitRef, counter.budgetKey]);
      if (!present(counter.approvedLimitRef) || !present(counter.budgetKey) || !Number.isSafeInteger(counter.consumed) || counter.consumed < 0) budgetFailure = true;
      if (counterHistory.has(key)) { repeats = true; if (counter.consumed < counterHistory.get(key)) budgetFailure = true; }
      if (counter.consumed > 0) positive = true;
      counterHistory.set(key, counter.consumed);
    }
  }
  const lineageFields = ['implementationAttempts', 'validatorRepairs', 'graphRevisions', 'specificationRevisions'];
  let lineageVerified = false;
  for (const { sample, record } of all('lineages')) {
    const inherited = array(record.inherited);
    if (!setEqual(inherited.map((entry) => entry.field), lineageFields)) { budgetFailure = true; continue; }
    let known = true;
    for (const entry of inherited) {
      if (!Number.isSafeInteger(entry.consumed) || entry.consumed < 0) { budgetFailure = true; continue; }
      const beforeSamples = usable.filter((s) => time(s.observedAt) <= record.recordedAt && data(s, 'graphs').some((g) => g.graphId === record.priorGraphId && array(g.graph?.workPackages).some((p) => p.workPackageId === record.priorWorkPackageId)));
      const before = beforeSamples.flatMap((s) => data(s, 'budgets')).filter((c) => c.budgetKey === `work-package:${record.priorWorkPackageId}:${entry.field}`);
      const after = data(sample, 'budgets').filter((c) => c.budgetKey === `work-package:${record.workPackageId}:${entry.field}`);
      // The product's complete budget query represents an absent counter as zero. Missing samples
      // differ from an absent counter in a complete sample and cannot establish inheritance.
      if (!beforeSamples.length || !data(sample, 'graphs').some((g) => array(g.graph?.workPackages).some((p) => p.workPackageId === record.workPackageId))) known = false;
      if (beforeSamples.length && entry.consumed < Math.max(0, ...before.map((c) => c.consumed))) budgetFailure = true;
      if (Math.max(0, ...after.map((c) => c.consumed)) < entry.consumed) budgetFailure = true;
    }
    if (known) lineageVerified = true;
  }
  if (counterHistory.size) mark('budget', budgetFailure ? 'FAIL' : positive && repeats && (!cutover || lineageVerified) ? 'PASS' : 'INCONCLUSIVE', budgetFailure ? '预算计数回退、丢失、非法或 lineage 少继承已消耗额度' : '核验捕获计数不回退；发生代际切换时还须有四项 lineage 继承的前后计数', usable.filter((s) => data(s, 'budgets').length).map((s) => s.sampleId));
  const final = all('verdicts').find(({ record }) => record.finalizerRole === 'finalizer' && record.verdict?.kind === 'deliverable');
  if (final) {
    const view = final.sample.snapshot.status?.execution?.finalizer;
    const checked = view?.verdict?.verdictId === final.record.verdictId && view.readOnlyProfile === 'enforced' && view.integrationFrozen === 'frozen' && view.workspace;
    const sessionReused = data(final.sample, 'segments').some((s) => s.role !== 'finalizer' && s.sessionBindingId === final.record.sessionBindingRef);
    const unchanged = checked && eq(view.workspace.before, view.workspace.after);
    mark('finalizer', sessionReused || (checked && !unchanged) ? 'FAIL' : checked && unchanged ? 'PASS' : 'INCONCLUSIVE', 'Delivery Verdict 已接受；核验独立只读 Finalizer 的冻结、前后工作区与 Session', [final.sample.sampleId]);
  }
  const cancellingIndex = usable.findIndex((s) => state(s) === 'cancelling');
  if (cancellingIndex >= 0) {
    const before = usable.slice(0, cancellingIndex).at(-1);
    const tail = usable.slice(cancellingIndex);
    const done = tail.find((s) => state(s) === 'cancelled');
    const bad = tail.some((s) => state(s) === 'active' || (state(s) === 'cancelled' && cohorts(s, mapping).some((c) => c.live.length)) || data(s, 'bindings').some((b) => b.createdAt > time(usable[cancellingIndex].observedAt) && b.createdAt < time(s.startedAt)));
    mark('cancel', bad ? 'FAIL' : done && before && cohorts(before, mapping).some((c) => c.live.length) ? 'PASS' : 'INCONCLUSIVE', '核验活跃 Worker 取消、取消区间无新物化及捕获后续无重新激活', tail.map((s) => s.sampleId));
  }
  const attempts = new Map();
  for (const { sample, record } of all('bindings')) {
    const key = `${record.workerTaskId}/${record.attemptId}`;
    if (!attempts.has(key)) attempts.set(key, { sample, record });
  }
  const retry = [...attempts.values()].find((a) => [...attempts.values()].some((b) => b.record.workerTaskId === a.record.workerTaskId && b.record.attemptId !== a.record.attemptId));
  if (retry) {
    const peers = [...attempts.values()].filter((a) => a.record.workerTaskId === retry.record.workerTaskId);
    const okay = peers.every(({ record }) => record.worktreeId === retry.record.worktreeId && eq(record.specBinding, retry.record.specBinding) && record.authorizationId === retry.record.authorizationId && record.authorizationVersion === retry.record.authorizationVersion && eq(record.workerProfileRef, retry.record.workerProfileRef));
    const dispatches = peers.map(({ record }) => [...new Set([...all('segments'), ...all('settlements')].filter((item) => item.record.workerTaskId === record.workerTaskId && item.record.attemptId === record.attemptId).map((item) => item.record.dispatchId).filter(present))]);
    const dispatched = dispatches.every((ids) => ids.length) && new Set(dispatches.flat()).size >= peers.length;
    mark('retry', !okay ? 'FAIL' : dispatched ? 'PASS' : 'INCONCLUSIVE', '同 WorkerTask 的新 Attempt 保留规格、worktree 与原授权绑定；还须实际不同 Dispatch 的记录', peers.map((a) => a.sample.sampleId));
  }
  const unknown = all('intents').find(({ record }) => record.state === 'blocked' && present(record.operationId));
  if (unknown) {
    const settled = all('intents').find(({ sample, record }) => time(sample.observedAt) > time(unknown.sample.observedAt) && record.operationId === unknown.record.operationId && record.state === 'settled');
    if (settled) mark('unknown', 'INCONCLUSIVE', '同 OperationId 阻塞后结算；需额外 receipt 证明原因为 unknown 及没有换 ID 重试', [unknown.sample.sampleId, settled.sample.sampleId]);
  }
  const handoff = all('handoffs').find(({ record }) => record.phase === 'cutover');
  if (handoff) mark('handoff', 'INCONCLUSIVE', '有持久 cutover 记录；需人工核对接收上下文及 lease 交接', [handoff.sample.sampleId]);
  for (const id of ['validator-repair', 'escalation', 'model-reauthorization']) {
    if (observations.entries.some((note) => note.scenarioId === id && note.kind === 'end')) mark(id, 'INCONCLUSIVE', '人工记录已发生，但当前只读事实不足以自动核验完整身份与因果');
  }
  return report();
}
