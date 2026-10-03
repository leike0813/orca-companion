/**
 * IP-06 生产宿主长历史基准（change: `inspect-and-search-coordinator-history`）。
 *
 * 复用 `artifacts/bounded-transcript/benchmark.mjs` 的 productionApp/store 基线：真实文件型 SQLite、
 * 生产 `TranscriptReader`、生产 `TuiApp` 输入到重绘，controller 端口仍是刻意的 fake backend。搜索读取
 * 的是真实 store：参数与结果正文只有一份，工具调用按可信 `query` 分类记录，assistant 与实际 tool result
 * 都来自 `appendModelStep` / `appendToolResult`。
 *
 * 每个场景：
 *   1. 写入 1k/10k/100k 条互不相同的已提交记录；1/5 MiB 场景额外写入一个可信 query 调用，参数与
 *      结果正文都恰好 1 或 5 MiB。
 *   2. 用 `prepareHistoryInspection()` 有界步补齐派生索引（等价 Bootstrap 初始化），就绪后才测量。
 *   3. 启动一条后台有界字面搜索（`scanHistory` 按游标推进，可取消），让它与输入/导航测量并发进行。
 *   4. 采集 ≥100 次输入与 ≥100 次已缓存导航样本，p95 ≤ 100ms。
 *   5. 取消后台采样搜索，另跑一次完整有界扫描，记录总成本并核对全部预期命中。
 *
 * 搜索的实际读回字节、批次、耗时、命中数单独报告；工作区只保留一批结果，不累积全部命中。取消后扫描
 * 立即停止，断言没有全部命中被保留。fixtures 是合成的本地记录，不代表真实模型或真实 Orca 运行。
 *
 * 运行：pnpm build && node artifacts/history-inspection/benchmark.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { setTimeout, setImmediate } from 'node:timers';

import { openCheckpointStore } from '../../dist/src/adapters/storage/checkpoint-store.js';
import { TranscriptReader } from '../../dist/src/interfaces/tui/render/transcript-reader.js';
import { scanHistory } from '../../dist/src/application/coordinator/history-search.js';
import { createFakePorts, renderTui, settle } from '../../dist/tests/tui/harness.js';

const output = 'artifacts/history-inspection';
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(join(tmpdir(), 'history-inspection-bench-'));
const results = [];
const timed = async (fn) => { const start = performance.now(); const value = await fn(); return { ms: performance.now() - start, value }; };
const distribution = (values) => { const sorted = [...values].sort((a, b) => a - b); return { samples: sorted.length,
  p50: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1) }; };
const round = (value, digits = 3) => { const factor = 10 ** digits; return Math.round(value * factor) / factor; };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const LITERAL = 'BENCHNEEDLE';
const needle = (index) => `Distinct record ${index} · ${LITERAL}${index} · 中文🙂 **Markdown**`;

/** 真实 store 读取端口：派生索引 + 键集元数据 + UTF-8 正文/参数范围，预览走真实 preview 语义（此处为空）。 */
function readingPort(store) {
  const port = {
    inspection: {
      snapshot: async (sessionId) => store.readHistoryInspection(sessionId),
      calls: async (query) => store.readHistoryCalls(query),
      users: async (query) => store.readUserHistoryPage(query),
    },
    history: async (query) => store.readHistoryPage(query),
    body: async (query) => {
      if (query.source.kind === 'arguments') return store.readHistoryArguments({ coordinatorSessionId: query.coordinatorSessionId,
        entryId: query.source.entryId, stepId: query.source.stepId, callId: query.source.callId, contentRevision: 1,
        offset: query.offset, maxBytes: query.maxBytes });
      const range = store.readHistoryBody({ coordinatorSessionId: query.coordinatorSessionId, entryId: query.source.entryId,
        contentRevision: 1, offset: query.offset, maxBytes: query.maxBytes });
      return range === null ? null : { source: query.source, offset: range.offset, end: range.end, byteLength: range.byteLength, text: range.text };
    },
    previews: async () => [], pin: () => () => {}, subscribe: () => () => {},
  };
  port.inspection.search = (query, signal) => scanHistory(port, query, signal);
  return port;
}

async function waitText(rendered, token) {
  const deadline = performance.now() + 5000;
  while (!(rendered.lastFrame() ?? '').includes(token)) {
    if (performance.now() > deadline) throw new Error('No rendered input: ' + token);
    await sleep(1);
  }
}

/** 把派生索引补到就绪，等价生产 Bootstrap 的有界初始化步；返回步数与最后一次的实际读回量。 */
async function prepareIndex(store) {
  let steps = 0, last;
  do { last = store.prepareHistoryInspection(); steps += 1; if (!last.ready) await new Promise((resolve) => setImmediate(resolve)); } while (!last.ready);
  return { steps, scannedBytes: last.scannedBytes, scannedItems: last.scannedItems, ready: last.ready };
}

/**
 * 后台有界字面搜索：按游标一批批推进，循环跑完整扫描轮次直到 abort，使搜索在全部输入/导航采样期间保持活跃。
 *
 * 只保留一批 `hits` 用于统计与上界断言，绝不累积全部命中；每轮都是一次完整有界扫描，因此 `firstFullScanMs`
 * 是一次完整扫描的真实耗时，`fullScanCount` 是采样期间完成的轮数。`abort()` 取消后立即停止。
 */
function startBackgroundSearch(port, sessionId, upperSequence, controller) {
  const signal = controller.signal;
  const state = { batches: 0, scannedBytes: 0, scannedItems: 0, hits: 0, maxBatchHits: 0, maxBatchBytes: 0,
    maxBatchItems: 0, maxCursorBytes: 0, fullScanCount: 0, firstFullScanMs: null, complete: false, aborted: false, error: null, elapsedMs: 0 };
  const start = performance.now();
  const task = (async () => {
    for (;;) {
      if (signal.aborted) { state.aborted = true; return; }
      const cycleStart = performance.now();
      let cursor = null;
      for (;;) {
        if (signal.aborted) { state.aborted = true; return; }
        let page;
        try {
          page = await scanHistory(port, { coordinatorSessionId: sessionId, target: 'transcript', literal: LITERAL, upperSequence, cursor }, signal);
        } catch (error) {
          if (signal.aborted) { state.aborted = true; return; }
          state.error = String(error);
          return;
        }
        state.batches += 1;
        state.scannedBytes += page.scannedBytes;
        state.scannedItems += page.scannedItems;
        state.hits += page.hits.length;
        state.maxBatchHits = Math.max(state.maxBatchHits, page.hits.length);
        state.maxBatchBytes = Math.max(state.maxBatchBytes, page.scannedBytes);
        state.maxBatchItems = Math.max(state.maxBatchItems, page.scannedItems);
        if (page.cursor !== null) state.maxCursorBytes = Math.max(state.maxCursorBytes, globalThis.Buffer.byteLength(page.cursor));
        if (page.complete) { state.complete = true; break; }
        cursor = page.cursor;
      }
      state.fullScanCount += 1;
      if (state.firstFullScanMs === null) state.firstFullScanMs = performance.now() - cycleStart;
    }
  })();
  return { state, task, stop: () => { controller.abort(); return task.then(() => { state.elapsedMs = performance.now() - start; }); } };
}

/** 完整扫描独立计时；仅累积标量，结果页处理完即释放。 */
async function measureCompleteScan(port, sessionId, upperSequence, expectedHits) {
  const start = performance.now();
  const result = { complete: false, batches: 0, hits: 0, scannedBytes: 0, scannedItems: 0,
    maxBatchHits: 0, maxBatchBytes: 0, maxBatchItems: 0, maxResponseBytes: 0, maxCursorBytes: 0, elapsedMs: 0 };
  let cursor = null;
  for (;;) {
    const page = await scanHistory(port, { coordinatorSessionId: sessionId, target: 'transcript', literal: LITERAL, upperSequence, cursor });
    result.batches += 1; result.hits += page.hits.length;
    result.scannedBytes += page.scannedBytes; result.scannedItems += page.scannedItems;
    result.maxBatchHits = Math.max(result.maxBatchHits, page.hits.length);
    result.maxBatchBytes = Math.max(result.maxBatchBytes, page.scannedBytes);
    result.maxBatchItems = Math.max(result.maxBatchItems, page.scannedItems);
    result.maxResponseBytes = Math.max(result.maxResponseBytes, globalThis.Buffer.byteLength(JSON.stringify(page)));
    result.maxCursorBytes = Math.max(result.maxCursorBytes, page.cursor === null ? 0 : globalThis.Buffer.byteLength(page.cursor));
    if (page.scannedItems > 100 || page.hits.length > 50 || page.scannedBytes > 65536 || result.maxResponseBytes > 65536 || result.maxCursorBytes > 4096)
      throw new Error('complete search workspace bound exceeded');
    if (page.complete) { result.complete = true; break; }
    if (page.cursor === null || page.cursor === cursor) throw new Error('complete search made no progress');
    cursor = page.cursor;
  }
  result.elapsedMs = round(performance.now() - start);
  if (result.hits !== expectedHits) throw new Error(`complete search returned ${result.hits} hits, expected ${expectedHits}`);
  return result;
}

/**
 * 一个恰好 N MiB 的 query 调用：assistant 记录调用、tool 记录实际结果，正文各恰好 N MiB。
 *
 * result 的 stepId 必须是产生该调用的 model step；提交走真实 append 路径（appendModelStep /
 * appendToolResult），这样调用配对与活动计数由生产逻辑按正确顺序建立，而不是靠 saveCheckpoint 批量写入。
 */
function largeScenarioMessages(mib, id) {
  const target = mib * 1048576;
  const callId = `${id}-call`;
  // 字段顺序必须与 `parseToolCall` 的规范化输出一致：`insertStep` 按 JSON 逐字节比较 step.toolCalls 与权威 entry。
  const argsOf = (payload) => ({ scope: 'workspace', query: LITERAL, payload });
  // 先用空 payload 量出固定结构开销（UTF-8 字节），再让 ASCII payload 恰好补满目标 MiB。
  const argsOverhead = globalThis.Buffer.byteLength(JSON.stringify(argsOf('')));
  const args = argsOf('a'.repeat(target - argsOverhead));
  const call = { callId, name: 'read_history', args, operationId: `op-${callId}`, mapOperationId: null, activityKind: 'query' };
  const assistant = { entryId: `${id}-assistant`, stepId: `${id}-assistant`, role: 'assistant', content: '', toolCalls: [call] };
  const step = { stepId: assistant.stepId, entryId: assistant.entryId, committedAt: 1,
    messages: [{ role: 'assistant', content: '' }], toolCalls: [call], usage: null };
  const resultRoot = (value) => ({ kind: 'ok', value });
  const resultOverhead = globalThis.Buffer.byteLength(JSON.stringify(resultRoot(LITERAL)));
  const resultContent = JSON.stringify(resultRoot(LITERAL + 'b'.repeat(target - resultOverhead)));
  const result = { entryId: `${id}-result`, stepId: assistant.stepId, role: 'tool', toolCallId: callId, toolName: call.name,
    content: resultContent };
  // 报告并断言实际字节，而不是目标值：参数 JSON 与结果正文各自恰好 target 字节。
  const argsBytes = globalThis.Buffer.byteLength(JSON.stringify(args));
  const resultBytes = globalThis.Buffer.byteLength(resultContent);
  if (argsBytes !== target) throw new Error(`args payload is ${argsBytes} bytes, expected exactly ${target}`);
  if (resultBytes !== target) throw new Error(`result payload is ${resultBytes} bytes, expected exactly ${target}`);
  return { assistant, step, result, call, target, argsBytes, resultBytes };
}

try {
  for (const scenario of [{ count: 1000 }, { count: 10000 }, { count: 100000 }, { count: 1, mib: 1 }, { count: 1, mib: 5 }]) {
    const databasePath = join(directory, String(results.length) + '.sqlite');
    const opened = openCheckpointStore({ databasePath });
    if (opened.kind !== 'opened') throw new Error(opened.message);
    const store = opened.store, id = 'session-b';
    store.saveCheckpoint({ schemaVersion: 2, coordinatorSessionId: id, graphPosition: 'suspend', committedMessages: [], committedModelSteps: [], wakeBatches: [], lastCompactionOutcome: null });

    // 1k/10k/100k 互不相同的已提交记录。
    const messages = Array.from({ length: scenario.count }, (_, index) => ({ entryId: `entry-${index}`, stepId: `step-${index}`,
      role: index % 2 ? 'assistant' : 'user', content: needle(index) }));
    const saved = store.saveCheckpoint({ schemaVersion: 2, coordinatorSessionId: id, graphPosition: 'suspend', committedMessages: messages,
      committedModelSteps: [], wakeBatches: [], lastCompactionOutcome: null });
    if (saved.kind !== 'saved') throw new Error(saved.message);

    // 1/5 MiB：一个可信 query 调用 + assistant + 实际 tool result，经真实 append 路径记录并正确配对。
    let large = null;
    if (scenario.mib) {
      large = largeScenarioMessages(scenario.mib, id);
      const stepWritten = store.appendModelStep({ coordinatorSessionId: id, graphPosition: 'suspend', entry: large.assistant, step: large.step });
      if (stepWritten.kind !== 'saved') throw new Error(stepWritten.message);
      const resultWritten = store.appendToolResult({ coordinatorSessionId: id, graphPosition: 'suspend', entry: large.result });
      if (resultWritten.kind !== 'saved') throw new Error(resultWritten.message);
    }

    const index = await prepareIndex(store);
    const reading = readingPort(store);
    const reader = new TranscriptReader(reading);
    const snapshot = store.readHistoryInspection(id);
    if (!snapshot.ready) throw new Error('inspection index not ready after prepare');
    // 展开真实 activityId，让 reader 在测量时确实读到巨大的参数/结果正文。
    const expanded = large ? [store.readHistoryCalls({ coordinatorSessionId: id, entryId: large.assistant.entryId }).calls[0].activityId] : [];

    // 后台有界字面搜索与输入/导航测量并发。
    const controller = new globalThis.AbortController();
    const background = startBackgroundSearch(reading, id, snapshot.upperSequence, controller);

    const cold = await timed(() => reader.open(id, 76, 12, expanded));
    await reader.move('older'); await reader.move('newer');
    const navigation = [];
    for (let n = 0; n < 100; n++) navigation.push((await timed(() => reader.move(n % 2 ? 'newer' : 'older'))).ms);
    const resize = await timed(() => reader.resize(46, 12, expanded));

    const fake = createFakePorts();
    const rendered = renderTui({ ...fake.ports, reading });
    try {
      await settle();
      if (large) { rendered.stdin.write('\u0014'); await settle(); }
      rendered.stdin.write('BENCH_IN_'); await waitText(rendered, 'BENCH_IN_');
      const input = [];
      for (let n = 0; n < 100; n++) {
        const token = String.fromCharCode(97 + n % 26);
        input.push((await timed(async () => { rendered.stdin.write(token); await waitText(rendered, 'BENCH_IN_' + token); })).ms);
        rendered.stdin.write('\u007f'); await waitText(rendered, 'BENCH_IN_'); await sleep(20);
      }

      const entry = { entryId: 'committed-response', stepId: 'committed-step', role: 'assistant', content: needle(results.length) };
      const commit = await timed(() => store.appendModelStep({ coordinatorSessionId: id, graphPosition: 'suspend', entry,
        step: { stepId: entry.stepId, entryId: entry.entryId, committedAt: Date.now(), messages: [{ role: 'assistant', content: entry.content }], toolCalls: [], usage: null } }));
      if (commit.value.kind !== 'saved') throw new Error(commit.value.message);
      const finish = await timed(() => reader.read('latest'));

      // 停止后台搜索：取消后不得再保留命中，工作区仍只有一批。
      await background.stop();
      const scan = background.state;
      if (scan.error !== null) throw new Error('background search failed: ' + scan.error);
      const fullScan = await measureCompleteScan(reading, id, snapshot.upperSequence, scenario.count + (large ? 2 : 0));

      // 报告实际字节（args/result 各恰好 payloadBytes），而不是目标值。
      const record = { ...scenario, payloadBytes: large ? large.argsBytes : null,
        argsBytes: large ? large.argsBytes : null, resultBytes: large ? large.resultBytes : null, index,
        coldMs: round(cold.ms), input: distribution(input.map(round)), cachedNavigation: distribution(navigation.map(round)),
        resizeMs: round(resize.ms), commitMs: round(commit.ms), finishMs: round(finish.ms),
        scan: { batches: scan.batches, scannedBytes: scan.scannedBytes, scannedItems: scan.scannedItems, hits: scan.hits,
          maxBatchHits: scan.maxBatchHits, maxBatchBytes: scan.maxBatchBytes, maxBatchItems: scan.maxBatchItems,
          maxCursorBytes: scan.maxCursorBytes, fullScanCount: scan.fullScanCount,
          firstFullScanMs: scan.firstFullScanMs === null ? null : round(scan.firstFullScanMs),
          complete: scan.complete, aborted: scan.aborted, elapsedMs: round(scan.elapsedMs) },
        fullScan, cache: reader.stats(), memory: process.memoryUsage() };
      results.push(record);
      process.stdout.write(JSON.stringify(record) + '\n');
      if (record.input.p95 > 100 || record.cachedNavigation.p95 > 100) throw new Error('p95 acceptance failed');
      // 搜索工作区上界：每批只准入一页 ≤100 行的 metadata/history-calls、≤50 命中、≤64KiB 正文，
      // 不透明游标 ≤4096 字节；工作区只保留一批命中，不累积全部命中。
      if (scan.maxBatchItems > 100 || scan.maxBatchHits > 50 || scan.maxBatchBytes > 64 * 1024 || scan.maxCursorBytes > 4096) throw new Error('search workspace bound exceeded');
    } finally {
      // 失败路径也要停掉后台搜索，避免它继续读一个即将关闭的 store。
      controller.abort();
      rendered.unmount(); fake.closeInputStore(); reader.dispose(); store.close();
    }
  }
  writeFileSync(output + '/measurements.json', JSON.stringify({ node: process.version, platform: process.platform,
    baseline: '20f02996471adb3efca524faced20ef9ffa0136d', measurements: results,
    scope: 'Real file-backed SQLite, production TranscriptReader, production TuiApp input-to-render, and production scanHistory reading the same store. Controller/backend ports are intentionally fake. History is synthetic local fixture data, not a real model or real Orca run; no fixtures are presented as real provider output. Background literal search is bounded and cancellable; the search workspace retains only one page of hits (≤50 hits, ≤64 KiB body, ≤100 items) and never accumulates all matches. process memory includes fixtures and framework allocations.' }, null, 2) + '\n');
} finally {
  for (let n = 0; n < results.length + 1; n++) for (const suffix of ['', '-wal', '-shm']) { try { unlinkSync(join(directory, n + '.sqlite' + suffix)); } catch (error) { if (error.code !== 'ENOENT') process.stderr.write(String(error)); } }
  try { rmdirSync(directory); } catch (error) { process.stderr.write(String(error)); }
}
