/** Throwaway cost probe: fake history only; no production schema or runtime. */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { wrapByDisplayWidth } = await import(pathToFileURL(join(root, 'src/interfaces/tui/render/width.ts')));
const markedPackage = readdirSync(join(root, 'node_modules/.pnpm')).find(name => /^marked@/.test(name));
assert(markedPackage, 'The probe uses the already installed transitive Marked package.');
const markedPath = join(root, 'node_modules/.pnpm', markedPackage, 'node_modules/marked');
const { marked } = await import(pathToFileURL(join(markedPath, 'lib/marked.esm.js')));
const markedVersion = JSON.parse(readFileSync(join(markedPath, 'package.json'), 'utf8')).version;
const scratch = mkdtempSync(join(tmpdir(), 'orca-transcript-cost-probe-'));
const db = new DatabaseSync(join(scratch, 'PROTOTYPE-fixture.sqlite'));
db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=FULL;
  CREATE TABLE blob_history (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
  CREATE TABLE entries (seq INTEGER PRIMARY KEY, entry_id TEXT UNIQUE NOT NULL, body TEXT NOT NULL);
  CREATE TABLE content_parts (part INTEGER PRIMARY KEY, body BLOB NOT NULL);
`);
const insertEntry = db.prepare('INSERT INTO entries VALUES (?, ?, ?)');
const storeBlob = db.prepare('INSERT OR REPLACE INTO blob_history VALUES (1, ?)');
const readBlob = db.prepare('SELECT body FROM blob_history WHERE id = 1');
const readPage = db.prepare('SELECT seq, entry_id, body FROM entries WHERE seq <= ? ORDER BY seq DESC LIMIT ?');
const readMetadata = db.prepare('SELECT seq, entry_id FROM entries WHERE seq <= ? ORDER BY seq DESC LIMIT ?');
const readPart = db.prepare('SELECT body FROM content_parts WHERE part = ?');
const insertPart = db.prepare('INSERT INTO content_parts VALUES (?, ?)');
const widths = [120, 80, 50];
const viewportRows = 20;
const samples = 5;
const results = [];
const fixtureText = '中文混排 source offset preserves reading position，工具输出与正文分别记录。'.repeat(8) + '\n';
let sink;

function measure(run, count = samples) {
  sink = run(); // Warm caches once; these are steady-state primitive costs.
  const times = [];
  for (let i = 0; i < count; i += 1) {
    const start = performance.now();
    sink = run();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return { medianMs: times[Math.floor(times.length / 2)], maxMs: times.at(-1), samples: count };
}

function renderTail(entries, width) {
  return entries.flatMap(entry => wrapByDisplayWidth(entry.body, width)).slice(-viewportRows);
}

function renderLocalTail(entries, width) {
  let lines = [];
  let visited = 0;
  for (const entry of entries) { // SQL already returns newest first.
    lines = [...wrapByDisplayWidth(entry.body, width), ...lines];
    visited += 1;
    if (lines.length >= viewportRows) break;
  }
  return { lines: lines.slice(-viewportRows), visited };
}

for (const size of [1_000, 10_000, 100_000]) {
  db.exec('DELETE FROM entries; BEGIN');
  const history = [];
  for (let seq = 1; seq <= size; seq += 1) {
    const entry = { seq, entry_id: `entry-${seq}`, body: `${seq}: ${fixtureText}` };
    history.push(entry);
    insertEntry.run(seq, entry.entry_id, entry.body);
  }
  db.exec('COMMIT');
  const serialized = JSON.stringify(history);
  storeBlob.run(serialized);
  const tail = readPage.all(size, 100);
  assert.equal(tail[0].seq, size);
  assert.equal(tail.at(-1).seq, size - 99);
  assert.deepEqual(readPage.all(size - 100, 100).map(row => row.seq),
    history.slice(size - 200, size - 100).reverse().map(row => row.seq));
  const row = { kind: 'history', entries: size, serializedBytes: Buffer.byteLength(serialized) };
  row.blobTailRead = measure(() => JSON.parse(readBlob.get().body).slice(-200));
  row.indexedTailRead = measure(() => readPage.all(size, 100));
  row.indexedBeginningRead = measure(() => readPage.all(100, 100));
  row.indexedActiveContextRead = measure(() => readPage.all(size, 500));
  row.metadataRead = measure(() => readMetadata.all(size, 100));
  row.pageBytes = tail.reduce((sum, entry) => sum + Buffer.byteLength(entry.body), 0);
  row.layout = widths.map(width => {
    const baseline = history.slice(-200);
    const local = renderLocalTail(tail, width);
    assert.deepEqual(local.lines, renderTail(baseline, width));
    return {
      width, visitedEntries: local.visited,
      baseline: measure(() => renderTail(baseline, width)),
      local: measure(() => renderLocalTail(tail, width)),
    };
  });
  row.blobAppend = measure(() => {
    const all = JSON.parse(readBlob.get().body);
    const seq = all.at(-1).seq + 1;
    all.push({ seq, entry_id: `entry-${seq}`, body: fixtureText });
    storeBlob.run(JSON.stringify(all));
  });
  let next = size;
  row.indexedAppend = measure(() => {
    next += 1;
    db.exec('BEGIN');
    insertEntry.run(next, `entry-${next}`, fixtureText);
    db.exec('COMMIT');
  });
  assert.equal(readPage.all(size, 100)[0].seq, size); // Append cannot move the old page boundary.
  results.push(row);
  process.stdout.write(JSON.stringify(row) + '\n');
}

for (const targetBytes of [1 * 1024 * 1024, 5 * 1024 * 1024]) {
  const unit = '中文长代码行 const value = 123; // stable source\n';
  const source = '```typescript\n' + unit.repeat(Math.ceil(targetBytes / Buffer.byteLength(unit))) + '```\n';
  const bytes = Buffer.from(source);
  const partLimit = 16 * 1024;
  db.exec('DELETE FROM content_parts; BEGIN');
  let count = 0;
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(start + partLimit, bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
    insertPart.run(count++, bytes.subarray(start, end));
    start = end;
  }
  db.exec('COMMIT');
  const restored = Buffer.concat(db.prepare('SELECT body FROM content_parts ORDER BY part').all()
    .map(row => Buffer.from(row.body))).toString('utf8');
  assert.equal(restored, source);
  const anchorPart = Math.floor(count / 2);
  const localSource = Buffer.from(readPart.get(anchorPart).body).toString('utf8');
  const row = {
    kind: 'long-code', bytes: bytes.length, parts: count,
    rangeBytes: Buffer.byteLength(localSource),
    wholeMarkdownLex: measure(() => marked.lexer(source)),
    rangeRead: measure(() => readPart.get(anchorPart)),
    layout: widths.map(width => ({
      width,
      whole: measure(() => wrapByDisplayWidth(source, width).slice(-viewportRows)),
      range: measure(() => wrapByDisplayWidth(localSource, width).slice(0, viewportRows)),
    })),
  };
  results.push(row);
  process.stdout.write(JSON.stringify(row) + '\n');
}

const output = {
  scope: 'Scratch SQLite primitives and source-text layout only; not a product implementation or PTY verdict.',
  node: process.version, marked: markedVersion, widths, viewportRows,
  sqliteSynchronous: 'FULL', sqliteJournal: 'WAL',
  pageEntries: 100, rangeBytes: 16 * 1024,
  peakProcessRssMiB: process.resourceUsage().maxRSS / 1024,
  results,
};
db.close();
const outputPath = process.argv[2] ?? join(scratch, 'results.json');
writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n');
process.stdout.write(`Saved ${outputPath}\n`);
assert(sink !== undefined);
