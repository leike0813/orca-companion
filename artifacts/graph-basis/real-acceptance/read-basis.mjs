import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { openRepositoryCoordinationStore } from '../../../dist/src/bootstrap/composition.js';
import { createOrcaExecutionBackend } from '../../../dist/src/adapters/orca-cli/orca-backend.js';
import { createOpenSpecProvider } from '../../../dist/src/adapters/specification/openspec/provider.js';
import { createGraphBasisService } from '../../../dist/src/application/tui/graph-basis-service.js';

// Explicit fixture identity; all reads use the production application seam and public backend.
const identityPath = resolve(process.argv[2] ?? '');
const outputPath = resolve(process.argv[3] ?? '');
assert(process.argv.length === 4, 'usage: read-basis.mjs <fixture-identity.json> <new-report.json>');
const fixture = JSON.parse(readFileSync(identityPath, 'utf8'));
const scopeId = fixture.coordinationScopeId;
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^ORCA_(?:TERMINAL|WORKER|TASK|RUN)(?:_|$)/u.test(key)) delete env[key];
}
const opened = await openRepositoryCoordinationStore({ repositoryPath: fixture.fixture, readOnly: true });
assert.equal(opened.kind, 'opened');
const store = opened.store;
const backend = createOrcaExecutionBackend({ cwd: fixture.fixture, env });
const providers = new Map();
const resolvedWorktrees = new Map();
const service = createGraphBasisService({
  store, coordinationScopeId: scopeId, tracker: null, routeMapIssueRef: null,
  specification: async binding => {
    if (binding.worktreeId === null || binding.specBinding === null) return null;
    const listed = await backend.query({ operation: 'worktree-list', repo: 'path:' + fixture.fixture, limit: 1000 });
    if (listed.kind !== 'accepted') return null;
    const matches = listed.value.worktrees.filter(entry => entry.worktreeId === binding.worktreeId);
    if (matches.length !== 1) return null;
    const root = matches[0].path;
    resolvedWorktrees.set(binding.worktreeId, root);
    const key = JSON.stringify([binding.worktreeId, root]);
    if (!providers.has(key)) providers.set(key, createOpenSpecProvider({
      resolveWorktreeRoot: worktreeId => worktreeId === binding.worktreeId ? root : null,
    }));
    return providers.get(key);
  },
});
const report = { observedAt: new Date().toISOString(), fixture: fixture.fixture,
  identity: fixture.identity, coordinationScopeId: scopeId, acceptanceModel: fixture.acceptanceModel,
  purpose: 'read-only production GraphBasisPort on retained real execution facts',
  versions: [], sources: [], worktrees: [] };

async function directory(method, request) {
  const items = [], cursors = new Set();
  let after = null;
  do {
    const result = await method({ ...request, after });
    assert.equal(result.kind, 'read', JSON.stringify(result));
    assert(result.value.items.length <= 20);
    items.push(...result.value.items);
    after = result.value.nextCursor;
    if (after !== null) { assert(!cursors.has(after), 'cursor must progress'); cursors.add(after); }
  } while (after !== null);
  return items;
}

async function body(session, source, graph) {
  const record = { graph, label: source.label, ref: source.ref,
    unavailable: source.unavailable, ranges: 0, byteLength: null, sourceVersion: null };
  report.sources.push(record);
  if (source.ref === null) return;
  let offset = 0, sourceVersion = source.sourceVersion;
  do {
    const read = await service.readSource({ coordinatorSessionId: session, source: source.ref,
      sourceVersion, offset, maxBytes: 1024 });
    if (read.kind !== 'read') { record.outcome = read; return; }
    const value = read.value;
    assert.equal(value.offset, offset);
    assert.equal(Buffer.byteLength(value.text), value.end - offset);
    assert(value.end - offset <= 1024);
    assert(value.end > offset || offset === value.byteLength);
    if (sourceVersion !== null) assert.equal(value.sourceVersion, sourceVersion);
    if (record.byteLength !== null) assert.equal(value.byteLength, record.byteLength);
    sourceVersion = value.sourceVersion;
    record.sourceVersion = sourceVersion;
    record.byteLength = value.byteLength;
    record.ranges++;
    offset = value.end;
  } while (offset < record.byteLength);
  record.outcome = { kind: 'read', end: offset, complete: true };
}

try {
  const before = store.query({ kind: 'scope', coordinationScopeId: scopeId });
  assert.equal(before.kind, 'scope');
  assert(before.scope !== null);
  report.scopeRevisionBefore = before.scope.revision;
  const sessions = store.query({ kind: 'sessions', coordinationScopeId: scopeId });
  assert.equal(sessions.kind, 'sessions');
  assert(sessions.sessions.length > 0);
  const session = sessions.sessions[0].coordinatorSessionId;
  report.coordinatorSessionId = session;
  const versions = await directory(service.listVersions, { coordinatorSessionId: session });
  assert(versions.length > 0);
  for (const summary of versions) {
    const graph = { graphId: summary.graphId, generation: summary.generation, version: summary.version };
    const selected = await service.readVersion({ coordinatorSessionId: session, graph });
    assert.equal(selected.kind, 'read');
    assert.equal(selected.value.graph.frontier.length, 0);
    assert(selected.value.graph.nodes.every(node => node.state === 'unknown' && !node.active && node.role === null && node.validation === null));
    const packages = [...new Set([...selected.value.graph.nodes.map(node => node.workPackageId),
      ...selected.value.retiredWorkPackageIds])];
    report.versions.push({ ...summary, packages, retiredWorkPackageIds: selected.value.retiredWorkPackageIds,
      historicalRuntimeOverlay: false });
    for (const workPackageId of packages.length === 0 ? [null] : packages) {
      const sources = await directory(service.listSources, { coordinatorSessionId: session, graph, workPackageId });
      for (const source of sources) {
        if (source.ref?.kind === 'specification' && source.ref.path === '') {
          const files = await directory(service.listSources, { coordinatorSessionId: session, graph,
            workPackageId, orcaTaskId: source.ref.orcaTaskId });
          for (const file of files) await body(session, file, graph);
        } else await body(session, source, graph);
      }
    }
  }
  const after = store.query({ kind: 'scope', coordinationScopeId: scopeId });
  report.scopeRevisionAfter = after.scope.revision;
  report.scopeRevisionUnchanged = report.scopeRevisionBefore === report.scopeRevisionAfter;
  report.worktrees = [...resolvedWorktrees].map(([worktreeId, path]) => ({ worktreeId, path }));
  assert(report.sources.some(source => source.ref?.kind === 'initial_plan' && source.outcome?.complete));
  writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(JSON.stringify({ outputPath, versions: report.versions.length,
    completeBodies: report.sources.filter(source => source.outcome?.complete).length,
    scopeRevisionUnchanged: report.scopeRevisionUnchanged }) + '\n');
} finally { opened.close(); }
