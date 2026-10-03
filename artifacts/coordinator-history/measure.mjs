import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { openCheckpointStore } from '../../dist/src/adapters/storage/checkpoint-store.js';
import { readTranscriptPage } from '../../dist/src/application/coordinator/history.js';

const directory = mkdtempSync(join(tmpdir(), 'companion-history-measure-'));
const samples = [];
try {
  for (const count of [1000, 10000, 100000]) {
    const path = join(directory, count + '.sqlite');
    const opened = openCheckpointStore({ databasePath: path });
    if (opened.kind !== 'opened') throw new Error(opened.message);
    const store = opened.store, id = 'measurement';
    try {
      const saved = store.saveCheckpoint({ schemaVersion: 2, coordinatorSessionId: id, graphPosition: 'suspend',
        committedMessages: Array.from({ length: count }, (_, index) => ({ entryId: 'seed-' + index,
          stepId: 'seed', role: 'assistant', content: '旧原文 中文abc🙂' })),
        committedModelSteps: [], wakeBatches: [], lastCompactionOutcome: null });
      if (saved.kind !== 'saved') throw new Error(saved.message);
      const compacted = store.savePortableCapsule(id, { kind: 'derived_context_capsule', capsuleId: 'measured-capsule',
        replacedFromStepId: 'seed', replacedToStepId: 'seed', text: '旧历史摘要' });
      if (compacted.kind !== 'saved') throw new Error(compacted.message);
      const start = performance.now();
      const entry = { entryId: 'new-response', stepId: 'new-step', role: 'assistant', content: '新回复' };
      const appended = store.appendModelStep({ coordinatorSessionId: id, graphPosition: 'suspend', entry,
        step: { stepId: entry.stepId, entryId: entry.entryId, committedAt: Date.now(),
          messages: [entry], toolCalls: [], usage: null } });
      if (appended.kind !== 'saved') throw new Error(appended.message);
      const appendMs = performance.now() - start;
      const contextStart = performance.now(), context = store.loadCheckpoint(id, 'context');
      if (context.kind !== 'recovered' || context.state.committedMessages.length !== 1) throw new Error('Effective context not bounded');
      const contextMs = performance.now() - contextStart;
      const pageStart = performance.now(), metadata = store.readHistoryPage({ coordinatorSessionId: id });
      const pageMs = performance.now() - pageStart;
      const oldest = readTranscriptPage(store, id, 'oldest');
      if (oldest.messages[0]?.entryId !== 'seed-0') throw new Error('Oldest direct access failed');
      const raw = new DatabaseSync(path);
      const total = raw.prepare('SELECT count(*) AS entries FROM conversation_entries').get();
      const canonical = raw.prepare('SELECT count(*) AS blocks,sum(length(data)) AS bytes FROM conversation_bodies WHERE entry_id=?').get(entry.entryId);
      const plans = raw.prepare("EXPLAIN QUERY PLAN SELECT seq FROM conversation_entries WHERE coordinator_session_id=? AND role!='system' AND seq<? ORDER BY seq DESC LIMIT 101").all(id, Number.MAX_SAFE_INTEGER);
      raw.close();
      samples.push({ count, appendMs, contextMs, pageMs, contextEntries: context.state.committedMessages.length,
        metadataItems: metadata.entries.length, metadataBytes: Buffer.byteLength(JSON.stringify(metadata.entries)),
        total, canonical, queryPlan: plans.map(row => row.detail) });
      process.stdout.write('measured ' + count + '\n');
    } finally { store.close(); }
  }
  writeFileSync('artifacts/coordinator-history/storage-measurements.json', JSON.stringify({
    platform: process.platform, node: process.version, measurements: samples,
    scope: 'Actual file-backed SQLite and production history reader; fixture entries have no model steps. These timings do not establish the 3B UI/cached-navigation p95 target.' }, null, 2) + '\n');
} finally { rmSync(directory, { recursive: true, force: true }); }
