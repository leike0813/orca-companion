/** Isolated synthetic fixtures; production SQLite queries, reader and App. No provider/Orca. */
import { existsSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { openCoordinationStore } from '../../dist/src/adapters/storage/coordination-store.js';
import { openCheckpointStore } from '../../dist/src/adapters/storage/checkpoint-store.js';
import { TranscriptReader } from '../../dist/src/interfaces/tui/render/transcript-reader.js';
import { userQuestionInteractionId } from '../../dist/src/application/coordination/pending-interaction.js';
import { createFakePorts, renderTui, settle } from '../../dist/tests/tui/harness.js';

const directory = mkdtempSync(join(tmpdir(), 'pending-interactions-bench-'));
const measurements = [], scope = 'scope-1', session = 'session-b';
const timed = async fn => { const start = performance.now(), value = await fn(); return { ms: performance.now() - start, value }; };
const distribution = values => { const sorted = values.toSorted((a, b) => a - b);
  return { samples: sorted.length, p50: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1) }; };
async function waitText(rendered, token) {
  const deadline = performance.now() + 5000;
  while (!(rendered.lastFrame() ?? '').includes(token)) { if (performance.now() > deadline) throw new Error('render timeout'); await delay(1); }
}
try {
  for (const scenario of [{ count: 1000 }, { count: 10000 }, { count: 100000 }, { count: 1000, mib: 1 }, { count: 1000, mib: 5 }]) {
    const branchPath = join(directory, 'branch-' + measurements.length + '.sqlite');
    const checkpointPath = join(directory, 'history-' + measurements.length + '.sqlite');
    const opened = openCoordinationStore({ databasePath: branchPath });
    const checkpoint = openCheckpointStore({ databasePath: checkpointPath });
    if (opened.kind !== 'opened' || checkpoint.kind !== 'opened') throw new Error('fixture stores unavailable');
    const branch = opened.store, history = checkpoint.store;
    const writer = { coordinatorSessionId: session, runtimeIncarnationId: 'benchmark', fencingGeneration: 0 };
    if (branch.transact({ kind: 'create-scope', coordinationScopeId: scope, expectedRevision: 0, writer, mode: 'route_planning',
      controlState: 'active', planningCycleId: 'cycle-1', fullBranchRef: 'refs/heads/main', canonicalWorktreePath: directory }).kind !== 'committed') throw new Error('scope fixture failed');
    branch.transact({ kind: 'register-session', coordinationScopeId: scope, expectedRevision: 1, writer,
      coordinatorSessionId: session, coordinatorModelConfigurationRef: 'fixture', lifecycleState: 'registered' });
    // Fixture loading only: bulk seed the newly-created database, never a user's store.
    const fixtureDb = new DatabaseSync(branchPath);
    const insert = fixtureDb.prepare(`INSERT INTO pending_interactions
      (coordination_scope_id,interaction_id,owner_coordinator_session_id,subject_kind,subject_id,expected_revision,state,
       answer_kind,answer_id,created_at,resolved_at,answer_text,question) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    fixtureDb.exec('BEGIN');
    for (let n = 0; n < scenario.count; n++) {
      const open = n < 25, id = userQuestionInteractionId('op-' + n);
      const answer = n === scenario.count - 1 && scenario.mib ? 'A'.repeat(scenario.mib * 1048576) : '回答中文🙂 ' + n;
      insert.run(scope, id, session, 'coordinator-session', session, 4, open ? 'open' : 'answered',
        open ? null : 'ui-submission', open ? null : 'answer-' + n, n, open ? null : n + 1, open ? null : answer,
        JSON.stringify({ text: '权威问题中文🙂 ' + n, options: [{ label: '继续' }, { label: '稍后' }] }));
    }
    fixtureDb.exec('COMMIT'); fixtureDb.close();
    const calls = [{ callId: 'ask', name: 'ask_user', operationId: 'op-' + (scenario.count - 1), mapOperationId: null, activityKind: 'action', args: {} }];
    const entries = Array.from({ length: scenario.count }, (_, n) => ({ entryId: 'entry-' + n, stepId: 'step-' + n,
      role: n % 2 ? 'assistant' : 'user', content: 'Distinct history ' + n + ' 中文🙂' }));
    entries.push({ entryId: 'ask-step', stepId: 'ask-step', role: 'assistant', content: '', toolCalls: calls },
      { entryId: 'ask-result', stepId: 'ask-step', role: 'tool', toolCallId: 'ask', toolName: 'ask_user', content: '{"kind":"ok"}' });
    const saved = history.saveCheckpoint({ schemaVersion: 2, coordinatorSessionId: session, graphPosition: 'suspend', committedMessages: entries,
      committedModelSteps: [{ entryId: 'ask-step', stepId: 'ask-step', committedAt: 1, messages: [{ role: 'assistant', content: '' }], toolCalls: calls, usage: null }],
      wakeBatches: [], lastCompactionOutcome: null });
    if (saved.kind !== 'saved') throw new Error(saved.message);
    while (!history.prepareHistoryInspection().ready) await delay(0);
    const query = request => { const result = branch.query({ ...request, coordinationScopeId: scope });
      if (result.kind === 'rejected') throw new Error(result.code + ': ' + result.message); return result; };
    let maxBodyBytes = 0, maxSummaries = 0;
    const reading = {
      history: async request => history.readHistoryPage(request),
      inspection: { snapshot: async id => history.readHistoryInspection(id), calls: async request => history.readHistoryCalls(request) },
      interactions: async (owner, ids) => { maxSummaries = Math.max(maxSummaries, ids.length);
        return query({ kind: 'interaction-summaries', coordinatorSessionId: owner, interactionIds: ids }).interactions; },
      body: async request => {
        if (request.source.kind === 'interaction') {
          const range = query({ kind: 'interaction-body', coordinatorSessionId: request.coordinatorSessionId,
            interactionId: request.source.interactionId, part: request.source.part, contentRevision: request.source.contentRevision,
            offset: request.offset, maxBytes: request.maxBytes }).body;
          if (range) maxBodyBytes = Math.max(maxBodyBytes, Buffer.byteLength(range.text));
          return range === null ? null : { source: request.source, ...range };
        }
        if (request.source.kind === 'arguments') return history.readHistoryArguments({ coordinatorSessionId: session,
          entryId: request.source.entryId, stepId: request.source.stepId, callId: request.source.callId, contentRevision: 1,
          offset: request.offset, maxBytes: request.maxBytes });
        const range = history.readHistoryBody({ coordinatorSessionId: session, entryId: request.source.entryId, contentRevision: 1,
          offset: request.offset, maxBytes: request.maxBytes });
        return range === null ? null : { source: request.source, ...range };
      }, previews: async () => [], pin: () => () => {}, subscribe: () => () => {},
    };
    const reader = new TranscriptReader(reading), fake = createFakePorts({ snapshot: { openInteractionCount: 25 } });
    let rendered;
    try {
      const presentation = query({ kind: 'presentation-snapshot', coordinatorSessionId: session }).snapshot;
      if (presentation.interactionOverview.openCount !== 25 || presentation.interactionOverview.items.length !== 20) throw new Error('bounded projection failed');
      const projections = [];
      for (let n = 0; n < 100; n++) projections.push((await timed(() => query({ kind: 'presentation-snapshot', coordinatorSessionId: session }))).ms);
      reader.setDetailed(Boolean(scenario.mib));
      const cold = await timed(() => reader.open(session, 76, 12, []));
      await reader.move('older'); await reader.move('newer');
      const navigation = [];
      for (let n = 0; n < 100; n++) navigation.push((await timed(() => reader.move(n % 2 ? 'newer' : 'older'))).ms);
      rendered = renderTui({ ...fake.ports, reading }); await settle();
      if (scenario.mib) { rendered.stdin.write('\u0014'); await settle(); }
      rendered.stdin.write('BENCH_'); await waitText(rendered, 'BENCH_');
      const inputs = [];
      for (let n = 0; n < 100; n++) {
        const character = String.fromCharCode(97 + n % 26);
        inputs.push((await timed(async () => { rendered.stdin.write(character); await waitText(rendered, 'BENCH_' + character); })).ms);
        rendered.stdin.write('\u007f'); await waitText(rendered, 'BENCH_'); await delay(20);
      }
      const measurement = { ...scenario, openCount: 25, pageItems: 20, coldMs: cold.ms, projection: distribution(projections),
        input: distribution(inputs), cachedNavigation: distribution(navigation), maxBodyBytes, maxSummaryIds: maxSummaries, cache: reader.stats() };
      measurements.push(measurement); process.stdout.write(JSON.stringify(measurement) + '\n');
      if (measurement.input.p95 > 100 || measurement.cachedNavigation.p95 > 100 || maxBodyBytes > 65536 || maxSummaries > 20 ||
        measurement.cache.bodyBytes > 8388608 || measurement.cache.layoutBytes > 8388608 || measurement.cache.bodyItems > 64 || measurement.cache.layoutItems > 64) throw new Error('response/cache budget exceeded');
    } finally { rendered?.unmount(); fake.closeInputStore(); reader.dispose(); history.close(); branch.close(); }
  }
  writeFileSync('artifacts/pending-interactions/measurements.json', JSON.stringify({ baseline: '69f0aa1781265bb7623cb4bbb3e8ae5722e72bce',
    node: process.version, platform: process.platform, scope: 'Synthetic isolated file-backed SQLite; production branch queries, reader and TuiApp. Controller/backend ports are fake. 1/5 MiB answers are oversized persisted-body stress fixtures, not current user-input limits. No live provider, Orca or IME.', measurements }, null, 2) + '\n');
} finally {
  for (let n = 0; n < 5; n++) for (const stem of ['branch-', 'history-']) for (const suffix of ['', '-wal', '-shm']) {
    const path = join(directory, stem + n + '.sqlite' + suffix);
    if (existsSync(path)) unlinkSync(path);
  }
  rmdirSync(directory);
}
