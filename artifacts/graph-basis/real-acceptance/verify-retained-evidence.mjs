import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { openRepositoryCoordinationStore } from '../../../dist/src/bootstrap/composition.js';

assert.equal(process.argv.length, 8,
  'usage: verify-retained-evidence.mjs <fixture.json> <runtime.json> <basis.json> <details.json> <retire|revise> <new-report.json>');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const [fixture, runtime, basis, details] = process.argv.slice(2, 6).map(read);
const shape = process.argv[6];
assert(['retire', 'revise'].includes(shape));
for (const report of [runtime, basis, details]) assert.equal(report.fixture, fixture.fixture);
assert.equal(runtime.acceptanceModel, 'minimax-cn/MiniMax-M3.1-Flash-Preview');
assert.equal(basis.scopeRevisionUnchanged, true);
assert.equal(basis.versions.length, 2);
assert(basis.sources.some(source => source.ref?.kind === 'initial_plan' && source.outcome?.complete));
assert(basis.sources.some(source => source.ref?.kind === 'graph_patch' && source.outcome?.complete));
assert.equal(runtime.graphPatches.length, 1);
const patch = runtime.graphPatches[0];
assert.equal((shape === 'retire' ? patch.retired : patch.revised).length, 1);
assert.equal((shape === 'retire' ? patch.revised : patch.retired).length, 0);
assert(runtime.revisionHolds.every(hold => hold.state === 'released'));
const target = (shape === 'retire' ? patch.retired : patch.revised)[0];
if (shape === 'retire') {
  assert(basis.versions.find(version => version.version === 2).retiredWorkPackageIds.includes(target));
} else {
  assert(runtime.baselineReconciliations.some(record => record.workPackageId === target &&
    record.state === 'verified' && record.observedHead === record.requiredBaselineHead));
}
assert.equal(runtime.deliveryVerdicts.length, 1);
const verdict = runtime.deliveryVerdicts[0];
assert.equal(verdict.finalizerRole, 'finalizer');
assert.equal(verdict.verdict.kind, 'deliverable');
const text = details.pages.map(page => page.text.replace(/[\s│┃|─╭╮╰╯]/gu, '')).join('\n');
assert(text.includes('finalizer.verdict.kind:deliverable'));
assert(text.includes(`finalizer.verdict.verdictId:${verdict.verdictId}`));
if (shape === 'revise') {
  assert.equal(runtime.recoveries.length, 1);
  const recovery = runtime.recoveries[0];
  assert.equal(recovery.status, 'recovered');
  assert.equal(recovery.totalAttemptRecoveryConsumption, 1);
  assert.equal(recovery.approvedAttemptRecoveryLimit, 1);
  assert.notEqual(recovery.sourceDispatchId, recovery.replacementDispatchId);
  for (const segment of [recovery.sourceSegment, recovery.replacementSegment]) {
    assert.equal(segment.workerTaskId, recovery.workerTaskId);
    assert.equal(segment.attemptId, recovery.businessAttemptId);
  }
  assert.equal(recovery.replacementSegment.dispatchId, recovery.replacementDispatchId);
  assert.equal(recovery.acceptedReplacementResults.length, 1);
  assert(text.includes('recoveries.0.status:recovered'));
}
const opened = await openRepositoryCoordinationStore({ repositoryPath: fixture.fixture, readOnly: true });
assert.equal(opened.kind, 'opened');
try {
  const query = kind => opened.store.query({ kind, coordinationScopeId: fixture.coordinationScopeId });
  assert.equal(query('scope').scope.controlState, 'paused');
  assert.deepEqual(query('budget-counters').counters, runtime.budgetCounters);
  assert.deepEqual(query('session-segments').segments, runtime.segments);
  assert.deepEqual(query('delivery-settlements').settlements, runtime.settlements);
  assert.deepEqual(query('delivery-verdicts').verdicts, runtime.deliveryVerdicts);
  const identity = binding => JSON.stringify([binding.workerTaskId, binding.attemptId, binding.orcaTaskId, binding.dispatchId]);
  assert.deepEqual(query('materialization-bindings').bindings.map(identity).sort(), runtime.bindings.map(identity).sort());
  const report = { observedAt: new Date().toISOString(), fixture: fixture.fixture, scopeId: fixture.coordinationScopeId,
    patchShape: shape, graphVersions: basis.versions.length,
    completeBodies: basis.sources.filter(source => source.outcome?.complete).length,
    finalizerVerdict: verdict.verdict.kind, finalizerSessionBindingRef: verdict.sessionBindingRef,
    exactFinalizerIdentityVisible: true, recoveries: runtime.recoveries.length,
    retainedTaskDispatchAttemptBindingsUnchanged: true, segmentsUnchanged: true, settlementsUnchanged: true,
    budgetsUnchanged: true, verdictUnchanged: true, scopePaused: true,
    operatorAssisted: true, originalDriverExit: 1,
    originalDriverFailures: ['obsolete reconciliation location', 'side-by-side transcript interleaved into long verdict ID'],
    replay: 'production project detail pages; production current-node Inspector separately for revise; readonly authority ports' };
  writeFileSync(process.argv[7], JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(JSON.stringify(report) + '\n');
} finally { opened.close(); }
