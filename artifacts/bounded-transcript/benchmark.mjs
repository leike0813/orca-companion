import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { setTimeout } from 'node:timers';
import { openCheckpointStore } from '../../dist/src/adapters/storage/checkpoint-store.js';
import { TranscriptReader } from '../../dist/src/interfaces/tui/render/transcript-reader.js';
import { createFakePorts, renderTui, settle } from '../../dist/tests/tui/harness.js';

const output = 'artifacts/bounded-transcript'; mkdirSync(output, { recursive: true });
const directory = mkdtempSync(join(tmpdir(), 'bounded-transcript-bench-'));
const results = [];
const timed = async fn => { const start = performance.now(); const value = await fn(); return { ms: performance.now() - start, value }; };
const distribution = values => { const sorted = [...values].sort((a,b) => a-b); return { samples: sorted.length,
  p50: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1) }; };
function readingPort(store) {
  return {
    history: async query => store.readHistoryPage(query),
    body: async query => {
      const range = store.readHistoryBody({ coordinatorSessionId: query.coordinatorSessionId, entryId: query.source.entryId,
        contentRevision: 1, offset: query.offset, maxBytes: query.maxBytes });
      return range === null ? null : { source: query.source, offset: range.offset, end: range.end, byteLength: range.byteLength, text: range.text };
    }, previews: async () => [], pin: () => () => {}, subscribe: () => () => {},
  };
}
async function waitText(rendered, token) {
  const deadline = performance.now() + 3000;
  while (!(rendered.lastFrame() ?? '').includes(token)) {
    if (performance.now() > deadline) throw new Error('No rendered input: ' + token);
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}
try {
  for (const scenario of [{ count: 1000 }, { count: 10000 }, { count: 100000 },
    ...[1,5].flatMap(mib => ['assistant','tool'].map(role => ({ count: 1, mib, role })))]) {
    const databasePath = join(directory, String(results.length) + '.sqlite');
    const opened = openCheckpointStore({ databasePath });
    if (opened.kind !== 'opened') throw new Error(opened.message);
    const store = opened.store, id = 'session-b';
    const prefix = '# 中文🙂 Markdown\n', suffix = '\nfinish';
    const content = scenario.mib ? prefix + 'x'.repeat(scenario.mib * 1048576 - Buffer.byteLength(prefix + suffix)) + suffix : null;
    const messages = Array.from({ length: scenario.count }, (_, index) => ({ entryId: 'entry-' + index, stepId: 'step-' + index,
      role: scenario.role ?? (index % 2 ? 'assistant' : 'user'), content: content ?? `Distinct record ${index} · 中文🙂 **Markdown**`,
      ...(scenario.role === 'tool' ? { toolName: 'read', toolCallId: 'call-' + index } : {}) }));
    const saved = store.saveCheckpoint({ schemaVersion: 2, coordinatorSessionId: id, graphPosition: 'suspend', committedMessages: messages,
      committedModelSteps: [], wakeBatches: [], lastCompactionOutcome: null });
    if (saved.kind !== 'saved') throw new Error(saved.message);
    const reading = readingPort(store), reader = new TranscriptReader(reading);
    const expanded = scenario.role === 'tool' ? ['entry-0'] : [];
    const cold = await timed(() => reader.open(id, 76, 12, expanded));
    await reader.move('older'); await reader.move('newer');
    const navigation = [];
    for (let n=0;n<100;n++) navigation.push((await timed(() => reader.move(n % 2 ? 'newer' : 'older'))).ms);
    const resize = await timed(() => reader.resize(46, 12, expanded));
    const fake = createFakePorts();
    const rendered = renderTui({ ...fake.ports, reading });
    try {
      await settle();
      if (scenario.role === 'tool') { rendered.stdin.write('\u0014'); await settle(); }
      rendered.stdin.write('BENCH_IN_'); await waitText(rendered, 'BENCH_IN_');
      const input = [];
      for (let n=0;n<100;n++) {
        const token = String.fromCharCode(97 + n % 26);
        input.push((await timed(async () => { rendered.stdin.write(token); await waitText(rendered, 'BENCH_IN_' + token); })).ms);
        rendered.stdin.write('\u007f'); await waitText(rendered, 'BENCH_IN_'); await new Promise(resolve => setTimeout(resolve, 20));
      }
      const entry = { entryId: 'committed-response', stepId: 'committed-step', role: 'assistant', content: content ?? 'complete' };
      const commit = await timed(() => store.appendModelStep({ coordinatorSessionId: id, graphPosition: 'suspend', entry,
        step: { stepId: entry.stepId, entryId: entry.entryId, committedAt: Date.now(), messages: [entry], toolCalls: [], usage: null } }));
      if (commit.value.kind !== 'saved') throw new Error(commit.value.message);
      const finish = await timed(() => reader.read('latest'));
      const record = { ...scenario, payloadBytes: content === null ? null : Buffer.byteLength(content), coldMs: cold.ms,
        input: distribution(input), cachedNavigation: distribution(navigation), resizeMs: resize.ms, commitMs: commit.ms,
        finishMs: finish.ms, cache: reader.stats(), memory: process.memoryUsage() };
      results.push(record); process.stdout.write(JSON.stringify(record) + '\n');
      if (record.input.p95 > 100 || record.cachedNavigation.p95 > 100) throw new Error('p95 acceptance failed');
    } finally { rendered.unmount(); fake.closeInputStore(); reader.dispose(); store.close(); }
  }
  writeFileSync(output + '/measurements.json', JSON.stringify({ node: process.version, platform: process.platform,
    baseline: 'b15ff20d4fe7d42a218c7259fb0ebc793f24d2ae', measurements: results,
    scope: 'Real file-backed SQLite, production TranscriptReader, production TuiApp input-to-render; isolated query ports. Full SDK aggregation measured separately by workflow tests; process memory includes fixtures and SDK/framework allocations.' }, null, 2) + '\n');
} finally {
  for (let n=0;n<results.length+1;n++) for (const suffix of ['', '-wal', '-shm']) { try { unlinkSync(join(directory, n + '.sqlite' + suffix)); } catch (error) { if (error.code !== 'ENOENT') process.stderr.write(String(error)); } }
  try { rmdirSync(directory); } catch (error) { process.stderr.write(String(error)); }
}
