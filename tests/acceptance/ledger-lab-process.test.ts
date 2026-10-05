import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

type Check = { id: string; status: string; message: string };
type Report = { schemaVersion: number; kind: string; status: string; checks: Check[]; capture: { samples: number }; repositoryPath: string; coordinationScopeId: string; profile: string; limitations: string[] };
type Input = { samples: unknown[]; mapping: unknown; observations: unknown; profile?: string };
const processPath = '../../artifacts/ledger-lab/process-verifier.mjs';
const commonPath = '../../artifacts/ledger-lab/common.mjs';
const cliPath = '../../artifacts/ledger-lab/lab.mjs';
const reportPath = '../../artifacts/ledger-lab/report.mjs';
const { verifyProcess } = await import(processPath) as { verifyProcess: (input: Input) => Report };
const { assertExternal } = await import(commonPath) as { assertExternal: (path: string, root: string) => Promise<string> };
const { parseArguments } = await import(cliPath) as { parseArguments: (args: string[]) => { command: string; options: Record<string, unknown> } };
const { combineReports } = await import(reportPath) as { combineReports: (input: { processReport: unknown; resultReport: unknown; observations: unknown }) => { status: string; assessments: unknown[] } };

const scope = 'scope-lab';
const labels = ['S', 'A', 'B', 'C1', 'C2', 'J', 'D', 'R'];
const nodes = Object.fromEntries(labels.map((label) => [label, `wp-${label}`]));
const lanes = { 'wp-S': 'coordination', 'wp-A': 'statistics', 'wp-B': 'audit', 'wp-C1': 'export', 'wp-C2': 'export', 'wp-J': 'coordination', 'wp-D': 'coordination', 'wp-R': 'coordination', 'wp-F': 'statistics' };
const mapping = { schemaVersion: 1, coordinationScopeId: scope, graphs: [{ graphId: 'g1', nodes, lanes }] };
const observations = { schemaVersion: 1, coordinationScopeId: scope, entries: [] };
const deps: Record<string, string[]> = { S: [], A: ['S'], B: ['S'], C1: ['S'], C2: ['C1'], J: ['A', 'B'], D: ['J', 'C2'], R: ['J'] };
function fixture(id = 'one', milliseconds = 1000) {
  const snapshot: Record<string, unknown> = {
    scope: { coordinationScopeId: scope, graphId: 'g1', planningCycleId: 'cycle1', controlState: 'active' },
    generations: [{ graphId: 'g1', orcaRunId: 'run1', status: 'active' }],
    graphs: [{ graphId: 'g1', generation: 1, version: 1, recordKind: 'initial', graph: { workPackages: labels.map((label) => ({ workPackageId: nodes[label], dependsOn: deps[label]?.map((dep) => nodes[dep]) })) } }],
    bindings: [], segments: [], settlements: [], recoveries: [], holds: [], patches: [], intents: [], budgets: [], verdicts: [], authorizations: [], leases: [], lineages: [], adoptions: [], reconciliations: [], handoffs: [], planningHandoffs: [], interactions: [],
    status: { workers: [], execution: { workPackages: [] } },
  };
  return { schemaVersion: 1, kind: 'sample', sampleId: id, repositoryPath: '/tmp/ledger-project', coordinationScopeId: scope,
    startedAt: new Date(milliseconds).toISOString(), observedAt: new Date(milliseconds + 1).toISOString(),
    sources: { store: { status: 'available', consistent: true, errors: [] }, orca: { status: 'available', runs: [] as unknown[] } }, snapshot };
}
function workers(sample: ReturnType<typeof fixture>, packages: string[], options: { state?: string; complete?: boolean; run?: string } = {}) {
  sample.snapshot['bindings'] = packages.map((wp, i) => ({ workerTaskId: `wt-${i}`, orcaTaskId: `ot-${i}`, workPackageId: wp }));
  sample.snapshot['segments'] = packages.map((wp, i) => ({ workerTaskId: `wt-${i}`, dispatchId: `dispatch-${i}`, workPackageId: wp }));
  sample.sources.orca.runs = [{ runId: 'run1', complete: options.complete ?? true, result: { kind: 'accepted', value: { workers: packages.map((_, i) => ({ taskId: `ot-${i}`, dispatchId: `dispatch-${i}`, runId: options.run ?? 'run1', workerState: options.state ?? 'running' })) } } }];
}
function check(samples: unknown[], id: string, extras: Partial<Input> = {}) {
  return verifyProcess({ samples, mapping, observations, ...extras }).checks.find((c) => c.id === id);
}
const temporaries: string[] = [];
afterEach(async () => { for (const path of temporaries.splice(0)) await rm(path, { recursive: true, force: true }); });

describe('ledger-lab process evidence', () => {
  test('accepts equivalent transitive dependencies and rejects extra serialization', () => {
    const equivalent = fixture();
    const graphs = equivalent.snapshot['graphs'] as { graph: { workPackages: { workPackageId: string; dependsOn: string[] }[] } }[];
    graphs[0]?.graph.workPackages.find((p) => p.workPackageId === 'wp-D')?.dependsOn.push('wp-S');
    expect(check([equivalent], 'planning')?.status).toBe('PASS');
    graphs[0]?.graph.workPackages.find((p) => p.workPackageId === 'wp-B')?.dependsOn.push('wp-A');
    expect(check([equivalent], 'planning')?.status).toBe('FAIL');
  });
  test.each([
    { state: 'running', complete: true, expectedParallel: 'PASS', expectedLane: 'PASS' },
    { state: 'ready', complete: true, expectedParallel: 'NOT_COVERED', expectedLane: 'NOT_COVERED' },
    { state: 'running', complete: false, expectedParallel: 'PASS', expectedLane: 'INCONCLUSIVE' },
  ])('requires real simultaneous live observations: $state / $complete', ({ state, complete, expectedParallel, expectedLane }) => {
    const sample = fixture(); workers(sample, ['wp-A', 'wp-B'], { state, complete });
    expect(check([sample], 'parallel')?.status).toBe(expectedParallel);
    expect(check([sample], 'lane-capacity')?.status).toBe(expectedLane);
  });
  test('fails simultaneous live Workers in the same lane, including different roles', () => {
    const sample = fixture(); workers(sample, ['wp-C1', 'wp-C2']);
    expect(check([sample], 'lane-capacity')?.status).toBe('FAIL');
  });
  test('does not join workers from separate polling times or another Run', () => {
    const first = fixture('first'); workers(first, ['wp-A']);
    const second = fixture('second', 2000); workers(second, ['wp-B'], { run: 'other-run' });
    expect(check([first, second], 'parallel')?.status).toBe('NOT_COVERED');
  });
  test('attributes a normal live Worker by exact Orca Task binding before any interruption segment', () => {
    const sample = fixture(); workers(sample, ['wp-A', 'wp-B']);
    sample.snapshot['segments'] = [];
    expect(check([sample], 'parallel')?.status).toBe('PASS');
  });
  test('does not treat receipt, materialization or manual notes as worker liveness', () => {
    const sample = fixture(); sample.snapshot['bindings'] = [{ workPackageId: 'wp-A', createdAt: 500 }, { workPackageId: 'wp-B', createdAt: 500 }];
    const notes = { ...observations, entries: [{ scenarioId: 'parallel', kind: 'end', at: '2026-10-05T00:00:00Z', text: '我看到了并行' }] };
    expect(check([sample], 'parallel', { observations: notes })?.status).toBe('NOT_COVERED');
  });
  test('unavailable or torn snapshots cannot supply machine PASS', () => {
    const sample = fixture(); workers(sample, ['wp-A', 'wp-B']); sample.sources.store.consistent = false;
    expect(check([sample], 'parallel')?.status).toBe('INCONCLUSIVE');
  });
  test('deduplicates replays and rejects conflicting evidence identities', () => {
    const sample = fixture();
    const report = verifyProcess({ samples: [sample, structuredClone(sample)], mapping, observations });
    expect(report.capture.samples).toBe(1);
    const conflict = structuredClone(sample); conflict.snapshot['budgets'] = [{ consumed: 0 }];
    expect(check([sample, conflict], 'planning')?.status).toBe('INCONCLUSIVE');
  });
  test('rejects foreign scopes in top level or retained records', () => {
    const foreign = fixture(); foreign.coordinationScopeId = 'foreign';
    expect(() => verifyProcess({ samples: [foreign], mapping, observations })).toThrow();
    const retained = fixture(); retained.snapshot['bindings'] = [{ coordinationScopeId: 'foreign' }];
    expect(() => verifyProcess({ samples: [retained], mapping, observations })).toThrow();
  });
  test('recognizes local blocking only with progress across the same blocked interval', () => {
    const first = fixture('first'); const second = fixture('second', 2000);
    first.snapshot['status'] = { execution: { workPackages: [{ workPackageId: 'wp-C2', state: 'blocked', blockerRefs: ['sample-request'] }, { workPackageId: 'wp-A', state: 'implementing' }] } };
    second.snapshot['status'] = { execution: { workPackages: [{ workPackageId: 'wp-C2', state: 'blocked', blockerRefs: ['sample-request'] }, { workPackageId: 'wp-A', state: 'accepted' }] } };
    expect(check([first, second], 'local-block')?.status).toBe('PASS');
    expect(check([second], 'local-block')?.status).toBe('NOT_COVERED');
  });
  test('detects budget rollback across restart even when other scenarios were not covered', () => {
    const first = fixture('first'); const second = fixture('second', 2000);
    first.snapshot['budgets'] = [{ budgetKey: 'wp-A/implementationAttempts', approvedLimitRef: 'auth1', consumed: 1 }];
    second.snapshot['budgets'] = [{ budgetKey: 'wp-A/implementationAttempts', approvedLimitRef: 'auth1', consumed: 0 }];
    expect(check([first, second], 'budget')?.status).toBe('FAIL');
  });
  test('distinguishes standalone specification revision from graph revision', () => {
    const sample = fixture();
    sample.snapshot['holds'] = [{ source: 'graph_patch', state: 'released', workPackageId: 'wp-C1', priorContractRevision: 1, admittedContractRevision: 2 }];
    sample.snapshot['bindings'] = [1, 2].map((version) => ({ workPackageId: 'wp-C1', worktreeId: 'tree-C1', specBinding: { contractRevision: version } }));
    expect(check([sample], 'specification-revision')?.status).toBe('NOT_COVERED');
    (sample.snapshot['holds'] as { source: string }[])[0]!.source = 'specification_revision';
    expect(check([sample], 'specification-revision')?.status).toBe('PASS');
  });
  test('recovery changing a business Attempt fails instead of being counted as ordinary recovery', () => {
    const sample = fixture();
    sample.snapshot['recoveries'] = [{ recoveryId: 'rec', status: 'recovered', terminalOutcome: 'replaced', workPackageId: 'wp-B', role: 'validator', workerTaskId: 'wt', businessAttemptId: 'attempt-1', sourceSegmentId: 'source', replacementSegmentId: 'target', sourceDispatchId: 'd1', replacementDispatchId: 'd2', consumedBudget: 1, capsuleRef: 'capsule', supersededSegmentId: 'source' }];
    sample.snapshot['segments'] = ['source', 'target'].map((id, i) => ({ segmentId: id, workPackageId: 'wp-B', role: 'validator', workerTaskId: 'wt', dispatchId: `d${i + 1}`, attemptId: i === 0 ? 'attempt-1' : 'attempt-2' }));
    expect(check([sample], 'recovery')?.status).toBe('FAIL');
    (sample.snapshot['segments'] as { attemptId: string }[])[1]!.attemptId = 'attempt-1';
    expect(check([sample], 'recovery')?.status).toBe('PASS');
  });
  test('delivery verdict alone does not prove read-only finalization', () => {
    const sample = fixture(); sample.snapshot['verdicts'] = [{ verdictId: 'v1', finalizerRole: 'finalizer', sessionBindingRef: 'final-session', verdict: { kind: 'deliverable' } }];
    expect(check([sample], 'finalizer')?.status).toBe('INCONCLUSIVE');
    const workspace = { head: 'abc', indexRevision: 'def', dirtyPaths: [] };
    sample.snapshot['status'] = { execution: { finalizer: { verdict: { verdictId: 'v1' }, readOnlyProfile: 'enforced', integrationFrozen: 'frozen', workspace: { before: workspace, after: workspace } } } };
    expect(check([sample], 'finalizer')?.status).toBe('PASS');
  });
  test('cancel profile does not borrow main-run coverage', () => {
    const sample = fixture();
    expect(verifyProcess({ samples: [sample], mapping, observations, profile: 'cancel' }).status).toBe('INCONCLUSIVE');
  });
  test('proves both joins using acceptance samples before their materialization', () => {
    const first = fixture('first'); const second = fixture('second', 2000); const third = fixture('third', 3000);
    first.snapshot['status'] = { execution: { workPackages: ['wp-A', 'wp-B'].map((workPackageId) => ({ workPackageId, state: 'accepted' })) } };
    second.snapshot['status'] = { execution: { workPackages: ['wp-A', 'wp-B', 'wp-J', 'wp-C2'].map((workPackageId) => ({ workPackageId, state: 'accepted' })) } };
    second.snapshot['bindings'] = [{ workPackageId: 'wp-J', createdAt: 1500 }];
    third.snapshot['bindings'] = [{ workPackageId: 'wp-J', createdAt: 1500 }, { workPackageId: 'wp-D', createdAt: 2500 }];
    third.snapshot['status'] = second.snapshot['status'];
    expect(check([first, second, third], 'joins')?.status).toBe('PASS');
    expect(check([third], 'joins')?.status).toBe('INCONCLUSIVE');
  });
  test('rejects materialization during an observed pause and accepts a bounded pause/resume', () => {
    const first = fixture('before'); workers(first, ['wp-A']);
    const paused = fixture('paused', 2000); paused.snapshot['scope'] = { coordinationScopeId: scope, graphId: 'g1', controlState: 'paused' };
    const stillPaused = fixture('still-paused', 3000); stillPaused.snapshot['scope'] = paused.snapshot['scope'];
    const resumed = fixture('resumed', 4000);
    expect(check([first, paused, stillPaused, resumed], 'pause-resume')?.status).toBe('PASS');
    stillPaused.snapshot['bindings'] = [{ workPackageId: 'wp-B', createdAt: 2500 }];
    expect(check([first, paused, stillPaused, resumed], 'pause-resume')?.status).toBe('FAIL');
  });
  test('restart preserves the old Session identities but rejects a changed Run', () => {
    const first = fixture('before'); const second = fixture('after', 2000);
    first.snapshot['leases'] = [{ kind: 'runtime', coordinatorSessionId: 'session1', runtimeIncarnationId: 'rt1', fencingGeneration: 1 }];
    second.snapshot['leases'] = [{ kind: 'runtime', coordinatorSessionId: 'session1', runtimeIncarnationId: 'rt2', fencingGeneration: 2 }];
    expect(check([first, second], 'restart')?.status).toBe('PASS');
    second.snapshot['generations'] = [{ graphId: 'g1', orcaRunId: 'different', status: 'active' }];
    expect(check([first, second], 'restart')?.status).toBe('FAIL');
  });
  test('cancel requires a live before-state and rejects reactivation', () => {
    const first = fixture('before'); workers(first, ['wp-A']);
    const cancelling = fixture('cancelling', 2000); cancelling.snapshot['scope'] = { coordinationScopeId: scope, graphId: 'g1', controlState: 'cancelling' };
    const cancelled = fixture('cancelled', 3000); cancelled.snapshot['scope'] = { coordinationScopeId: scope, graphId: 'g1', controlState: 'cancelled' };
    expect(check([first, cancelling, cancelled], 'cancel', { profile: 'cancel' })?.status).toBe('PASS');
    expect(check([first, cancelling, cancelled, fixture('reactivated', 4000)], 'cancel', { profile: 'cancel' })?.status).toBe('FAIL');
    workers(cancelled, ['wp-A']);
    expect(check([first, cancelling, cancelled], 'cancel', { profile: 'cancel' })?.status).toBe('FAIL');
  });
  test('retry requires real different Dispatch records, not only a new materialization attempt', () => {
    const sample = fixture();
    sample.snapshot['bindings'] = ['a1', 'a2'].map((attemptId) => ({ workerTaskId: 'wt1', attemptId, worktreeId: 'tree1', specBinding: { contractRevision: 1 }, authorizationId: 'auth1', authorizationVersion: 1, workerProfileRef: { id: 'impl', kind: 'profile' } }));
    expect(check([sample], 'retry')?.status).toBe('INCONCLUSIVE');
    sample.snapshot['segments'] = ['a1', 'a2'].map((attemptId, i) => ({ workerTaskId: 'wt1', attemptId, dispatchId: `d${i}` }));
    expect(check([sample], 'retry')?.status).toBe('PASS');
  });
  test('an atomic patch must contain all three operations and the corresponding graph', () => {
    const sample = fixture();
    const patchedMapping = structuredClone(mapping); patchedMapping.graphs[0]!.nodes['F'] = 'wp-F';
    sample.snapshot['patches'] = [{ graphId: 'g1', graphVersion: 2, patchId: 'patch1', added: ['wp-F'], revised: ['wp-A'], retired: ['wp-R'] }];
    const workPackages = labels.filter((label) => label !== 'R').map((label) => ({ workPackageId: nodes[label], dependsOn: label === 'A' ? ['wp-S', 'wp-F'] : deps[label]?.map((dep) => nodes[dep]) }));
    workPackages.push({ workPackageId: 'wp-F', dependsOn: ['wp-S'] });
    sample.snapshot['graphs'] = [...sample.snapshot['graphs'] as unknown[], { graphId: 'g1', version: 2, patchId: 'patch1', graph: { workPackages } }];
    expect(check([sample], 'graph-patch', { mapping: patchedMapping })?.status).toBe('PASS');
    workPackages.find((p) => p.workPackageId === 'wp-A')!.dependsOn = ['wp-S'];
    expect(check([sample], 'graph-patch', { mapping: patchedMapping })?.status).toBe('FAIL');
  });
  test('a missing previously captured counter is a reset, not an empty budget', () => {
    const first = fixture('first'); const second = fixture('second', 2000);
    first.snapshot['budgets'] = [{ budgetKey: 'counter', approvedLimitRef: 'auth1', consumed: 1 }];
    expect(check([first, second], 'budget')?.status).toBe('FAIL');
  });
  test('replanning freezes the old graph and requires new graph, Run and WorkPackage identities', () => {
    const sample = fixture();
    sample.snapshot['scope'] = { coordinationScopeId: scope, graphId: 'g2', planningCycleId: 'cycle2', controlState: 'active' };
    sample.snapshot['generations'] = [{ graphId: 'g1', generation: 1, orcaRunId: 'run1', status: 'frozen', planningCycleId: 'cycle1' }, { graphId: 'g2', generation: 2, orcaRunId: 'run2', status: 'active', predecessorGraphId: 'g1', planningCycleId: 'cycle2' }];
    const next = { graphId: 'g2', version: 1, graph: { workPackages: [{ workPackageId: 'wp-new', dependsOn: [] }] } };
    sample.snapshot['graphs'] = [...sample.snapshot['graphs'] as unknown[], next];
    expect(check([sample], 'replanning')?.status).toBe('PASS');
    next.graph.workPackages[0]!.workPackageId = 'wp-A';
    expect(check([sample], 'replanning')?.status).toBe('FAIL');
  });
});

describe('ledger-lab external CLI and report boundaries', () => {
  test.each([
    ['collect', '--repo', '/tmp/x', '--scope', 's', '--out', '/tmp/out', '--watch', '--watch'],
    ['verify-result', '--repo', '/tmp/x', '--version', 'privacy', '--out', '/tmp/out', '--unknown', 'value'],
    ['report', '--process', '--result'],
  ])('rejects ambiguous or unknown command arguments: %s', (...args) => {
    expect(() => parseArguments(args)).toThrow();
  });
  test('resolves an existing output symlink before enforcing external paths', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'ledger-boundary-')); temporaries.push(temp);
    const root = join(temp, 'testrepo'); await mkdir(root);
    const alias = join(temp, 'external-link'); await symlink(root, alias);
    await expect(assertExternal(join(alias, 'new', 'report.json'), root)).rejects.toThrow();
    await expect(assertExternal(join(temp, 'legitimate', 'report.json'), root)).resolves.toBe(join(temp, 'legitimate', 'report.json'));
  });
  test('human assessments cannot raise an inconclusive process report to PASS', () => {
    const processReport = verifyProcess({ samples: [fixture()], mapping, observations });
    const notes = { ...observations, entries: [{ scenarioId: 'planning', kind: 'assessment', rating: 5, at: '2026-10-05T00:00:00Z', text: '体验良好' }] };
    const resultReport = { schemaVersion: 1, kind: 'result-report', repositoryPath: processReport.repositoryPath, status: 'PASS', checks: [{ id: 'result', status: 'PASS' }] };
    const combined = combineReports({ processReport, resultReport, observations: notes });
    expect(combined.status).toBe('INCONCLUSIVE'); expect(combined.assessments).toHaveLength(1);
    expect(() => combineReports({ processReport, resultReport: { ...resultReport, repositoryPath: '/other' }, observations: notes })).toThrow();
  });
  test('a cancel report may omit result verification without lowering cancellation coverage', () => {
    const before = fixture('before'); workers(before, ['wp-A']);
    const cancelling = fixture('cancelling', 2000); cancelling.snapshot['scope'] = { coordinationScopeId: scope, controlState: 'cancelling' };
    const done = fixture('done', 3000); done.snapshot['scope'] = { coordinationScopeId: scope, controlState: 'cancelled' };
    const processReport = verifyProcess({ samples: [before, cancelling, done], mapping, observations, profile: 'cancel' });
    expect(combineReports({ processReport, resultReport: null, observations }).status).toBe('PASS');
    expect(() => combineReports({ processReport: { ...processReport, profile: 'main' }, resultReport: null, observations })).toThrow();
  });
});
