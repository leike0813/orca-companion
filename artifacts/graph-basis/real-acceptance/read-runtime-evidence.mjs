import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { openRepositoryCoordinationStore } from '../../../dist/src/bootstrap/composition.js';
import { createOrcaExecutionBackend } from '../../../dist/src/adapters/orca-cli/orca-backend.js';

// Retained fixture facts only; no controller, model, mutation, or Orca database access.
assert.equal(process.argv.length, 4, 'usage: read-runtime-evidence.mjs <fixture.json> <new-report.json>');
const fixture = JSON.parse(readFileSync(resolve(process.argv[2]), 'utf8'));
const opened = await openRepositoryCoordinationStore({ repositoryPath: fixture.fixture, readOnly: true });
assert.equal(opened.kind, 'opened');
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^ORCA_(?:TERMINAL|WORKER|TASK|RUN)(?:_|$)/u.test(key)) delete env[key];
}
const backend = createOrcaExecutionBackend({ cwd: fixture.fixture, env });
const scopeId = fixture.coordinationScopeId;
const query = (kind, field, extra = {}) => {
  const result = opened.store.query({ kind, coordinationScopeId: scopeId, ...extra });
  assert.equal(result.kind, kind);
  return result[field];
};
try {
  const scope = query('scope', 'scope');
  assert(scope);
  const bindings = query('materialization-bindings', 'bindings');
  const segments = query('session-segments', 'segments');
  const settlements = query('delivery-settlements', 'settlements');
  const recoveries = query('recoveries', 'recoveries');
  const authorizations = query('authorizations', 'authorizations');
  const authorization = authorizations.find(entry => entry.authorizationId === scope.authorizationId);
  assert(authorization);
  const versions = query('graph-versions', 'versions', { graphId: scope.graphId });
  const dispatchIds = [...new Set(segments.map(segment => segment.dispatchId))];
  const workers = [];
  for (const dispatchId of dispatchIds) {
    const result = await backend.query({ operation: 'worker-show', dispatchId });
    workers.push({ dispatchId, result });
  }
  const report = {
    observedAt: new Date().toISOString(), fixture: fixture.fixture, identity: fixture.identity,
    coordinationScopeId: scopeId, acceptanceModel: fixture.acceptanceModel,
    readOnly: true, scopeRevisionBefore: scope.revision,
    graphGenerations: query('graph-generations', 'generations'),
    graphPatches: versions.filter(version => version.patchId !== null).map(version =>
      query('graph-patch-record', 'record', { graphId: scope.graphId, graphVersion: version.version })),
    deliveryVerdicts: query('delivery-verdicts', 'verdicts'),
    revisionHolds: query('revision-holds', 'holds'),
    baselineReconciliations: query('baseline-reconciliations', 'reconciliations'),
    budgetCounters: query('budget-counters', 'counters'),
    bindings: bindings.map(({ identity, role, recoveryUtilityRole, workPackageId, workerTaskId,
      attemptId, orcaTaskId, dispatchId, authorizationId, authorizationVersion, workerProfileRef }) =>
      ({ identity, role, recoveryUtilityRole, workPackageId, workerTaskId, attemptId, orcaTaskId,
        dispatchId, authorizationId, authorizationVersion, workerProfileRef })),
    segments, settlements, workers,
    recoveries: recoveries.map(recovery => ({
      ...recovery,
      sourceSegment: segments.find(segment => segment.segmentId === recovery.sourceSegmentId) ?? null,
      replacementSegment: segments.find(segment => segment.segmentId === recovery.replacementSegmentId) ?? null,
      acceptedReplacementResults: settlements.filter(settlement =>
        settlement.workerTaskId === recovery.workerTaskId &&
        settlement.attemptId === recovery.businessAttemptId &&
        settlement.dispatchId === recovery.replacementDispatchId),
      totalAttemptRecoveryConsumption: recoveries.filter(entry =>
        entry.businessAttemptId === recovery.businessAttemptId).reduce((sum, entry) => sum + entry.consumedBudget, 0),
      approvedAttemptRecoveryLimit: authorization.manifest.limits.maxRecoveriesPerWorkerAttempt,
    })),
  };
  report.scopeRevisionAfter = query('scope', 'scope').revision;
  report.scopeRevisionUnchanged = report.scopeRevisionAfter === report.scopeRevisionBefore;
  writeFileSync(resolve(process.argv[3]), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(JSON.stringify({ scopeId, recoveries: report.recoveries.length,
    settlements: settlements.length, scopeRevisionUnchanged: report.scopeRevisionUnchanged }) + '\n');
} finally { opened.close(); }
