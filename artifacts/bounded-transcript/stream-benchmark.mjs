/**
 * 生产流式链路的成本事实（change: `render-bounded-transcript`，IP-06 证据）。
 *
 * 跑的是**真实生产接线**：构建产物里的 buildCoordinatorGraph、真实 checkpoint SQLite、真实临时
 * 预览存储，以及逐 chunk 产出的 ScriptedStreamingChatModel。最终响应只来自 SDK 的 handleLLMEnd
 * 聚合——脚本不重算、不复制，也不维护第二份聚合器。
 *
 * 四段耗时各自独立报，不混成一个数字：
 *   - streamConsumeMs       逐个 16KiB chunk 被消费（预算计量、fencing、预览落盘）
 *   - aggregateAfterChunkMs 最后一个 chunk 之后到提交之间：SDK 聚合 + 调用清单解析
 *   - appendModelStepMs     单独测量的权威接受时间（由 port 包装直接计时）
 *   - graphOverheadMs       提交之后的路由与图位置落盘
 * 另有预览字节/记录数与进程内存峰值抽样。
 *
 * 这些数字属于 SDK 聚合与接受成本，**不属于** 3B 的 100ms 输入/缓存导航门槛。
 *
 * 运行：pnpm build && node artifacts/bounded-transcript/stream-benchmark.mjs
 */

import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { clearInterval, setInterval } from 'node:timers';

import { AIMessage } from '@langchain/core/messages';

import { openCheckpointStore } from '../../dist/src/adapters/storage/checkpoint-store.js';
import { createTranscriptPreviewStore } from '../../dist/src/adapters/storage/transcript-preview-store.js';
import { projectActionableWork } from '../../dist/src/application/coordinator/actionable-work.js';
import { COORDINATOR_SESSION_STATE_SCHEMA_VERSION } from '../../dist/src/domain/coordinator/session-state.js';
import { buildCoordinatorGraph } from '../../dist/src/workflow/coordinator/graph.js';
import { COORDINATOR_INVOKE_DEFAULTS } from '../../dist/src/workflow/coordinator/state.js';
import { ScriptedStreamingChatModel } from '../../dist/tests/support/fake-chat-model.js';

const SESSION = 'session-stream-bench';
const CHUNK_BYTES = 16 * 1024;
const OUTPUT = join(dirname(fileURLToPath(import.meta.url)), 'stream-measurements.json');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** 权威记录里已提交的 assistant 条目数：流式期间它必须一直是 0。 */
function assistantCount(store) {
  const read = store.loadCheckpoint(SESSION);
  if (read.kind !== 'recovered') throw new Error('会话记录不可恢复：' + read.kind);
  return read.state.committedMessages.filter((entry) => entry.role === 'assistant').length;
}

/**
 * 内存峰值抽样：观察者每个 chunk 抽一次，定时器只作兜底。
 *
 * 定时器单独不够——一次 5MiB 流式响应几乎全在微任务里被消费完，事件循环未必回到定时器阶段，
 * 峰值就会被整段漏掉。
 */
function sampleMemory() {
  const peak = { rssBytes: 0, heapUsedBytes: 0, heapTotalBytes: 0, externalBytes: 0, samples: 0 };
  const sample = () => {
    const usage = process.memoryUsage();
    peak.samples += 1;
    peak.rssBytes = Math.max(peak.rssBytes, usage.rss);
    peak.heapUsedBytes = Math.max(peak.heapUsedBytes, usage.heapUsed);
    peak.heapTotalBytes = Math.max(peak.heapTotalBytes, usage.heapTotal);
    peak.externalBytes = Math.max(peak.externalBytes, usage.external);
  };
  sample();
  const timer = setInterval(sample, 2);
  timer.unref();
  return { peak, sample, stop: () => clearInterval(timer) };
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function measure(scenario) {
  const directory = mkdtempSync(join(tmpdir(), 'stream-bench-' + scenario.label + '-'));
  const opened = openCheckpointStore({ databasePath: join(directory, 'checkpoints.sqlite') });
  if (opened.kind !== 'opened') throw new Error(opened.message);
  const store = opened.store;

  // 与既有 workflow 测试同样的起点：空历史、图停在 start，再播一个有限 wake。
  const seeded = store.saveCheckpoint({
    schemaVersion: COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
    coordinatorSessionId: SESSION,
    committedMessages: [],
    graphPosition: 'start',
    committedModelSteps: [],
    wakeBatches: [],
    lastCompactionOutcome: null,
  });
  if (seeded.kind !== 'saved') throw new Error(seeded.message);
  const work = projectActionableWork({
    coordinatorSessionId: SESSION,
    controlState: 'active',
    observations: [{
      source: { sourceKind: 'delivery', sourceId: scenario.label + '-delivery', revision: 1 },
      classification: 'worker_question',
      summary: '问题 ' + scenario.label,
      ownerCoordinatorSessionId: SESSION,
    }],
    admitted: [],
  }).items;

  const prefix = '# ' + scenario.label + ' 报告' + '\n';
  const suffix = '\nend of response' + '\n';
  const fillerBytes = scenario.responseBytes - Buffer.byteLength(prefix, 'utf8') - Buffer.byteLength(suffix, 'utf8');
  const expected = prefix + 'x'.repeat(fillerBytes) + suffix;
  const model = new ScriptedStreamingChatModel([
    {
      kind: 'text',
      text: expected,
      chunkSize: CHUNK_BYTES,
      usage: [{ input_tokens: 4096, output_tokens: 8192, total_tokens: 12288 }],
    },
  ]);

  const previewStore = createTranscriptPreviewStore();
  const memory = sampleMemory();
  const timing = {
    entered: null, lastDelta: null, committedAt: null,
    deltaCount: 0, committedEvents: 0, interruptedEvents: 0,
  };
  let previewPeak = { bytes: 0, items: 0 };
  const authoritativeDuringStream = [];

  // 观察者只保留计数与时间戳：delta 文本一律丢弃，否则这个基准自己就把全部响应留在内存里。
  const streamObserver = (event) => {
    const now = performance.now();
    memory.sample();
    if (event.kind === 'started') {
      timing.entered = now;
    } else if (event.kind === 'delta') {
      timing.deltaCount += 1;
      timing.lastDelta = now;
      if (timing.deltaCount === 1 || timing.deltaCount % 64 === 0) {
        authoritativeDuringStream.push(assistantCount(store));
      }
      const stats = previewStore.stats();
      if (stats.bytes > previewPeak.bytes) previewPeak = { bytes: stats.bytes, items: stats.items };
    } else if (event.kind === 'committed') {
      timing.committedEvents += 1;
      timing.committedAt = now;
    } else if (event.kind === 'interrupted') {
      timing.interruptedEvents += 1;
    }
    previewStore.observe(event);
  };

  let appendCalls = 0;
  let appendModelStepMs = 0;
  const timedRecords = new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'appendModelStep') {
        return (input) => {
          const start = performance.now();
          const written = target.appendModelStep(input);
          appendModelStepMs += performance.now() - start;
          appendCalls += 1;
          return written;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const graph = buildCoordinatorGraph({
    model,
    checkpointer: store.checkpointer,
    sessionRecords: timedRecords,
    assertFencing: () => ({ kind: 'valid', lease: {} }),
    newStepId: () => 'step-1',
    sleep: async () => {},
    buildMessages: async () => ({ messages: [new AIMessage('请给出这次运行的完整报告')], note: '有界输入' }),
    streamObserver,
  });

  const start = performance.now();
  const result = await graph.invoke(
    { coordinatorSessionId: SESSION, remainingWork: work, deferredWork: 0, pendingToolCalls: 0 },
    { configurable: { thread_id: 'thread-' + scenario.label }, ...COORDINATOR_INVOKE_DEFAULTS },
  );
  const end = performance.now();
  memory.stop();

  const finalPreview = previewStore.stats();
  const previews = previewStore.list(SESSION);
  const read = store.loadCheckpoint(SESSION);
  if (read.kind !== 'recovered') throw new Error('会话记录不可恢复：' + read.kind);
  const steps = read.state.committedModelSteps;
  const entry = read.state.committedMessages.find((message) => message.role === 'assistant');

  // 断言是「事实」而不是实现细节：流式期间权威历史没有 assistant，结束时只有一条正式 entry。
  assert(result.status === 'suspended', scenario.label + ': 图未收敛到 suspended（' + result.status + '）');
  assert(timing.entered !== null, scenario.label + ': 没有观察到 started');
  assert(timing.committedAt !== null, scenario.label + ': 没有观察到 committed');
  assert(timing.committedEvents === 1, scenario.label + ': committed 事件出现 ' + timing.committedEvents + ' 次');
  assert(timing.interruptedEvents === 0, scenario.label + ': 出现 ' + timing.interruptedEvents + ' 次 interrupted');
  assert(
    authoritativeDuringStream.every((count) => count === 0),
    scenario.label + ': 流式期间权威历史出现了 assistant（' + JSON.stringify(authoritativeDuringStream) + '）',
  );
  assert(appendCalls === 1, scenario.label + ': appendModelStep 被调用 ' + appendCalls + ' 次');
  assert(steps.length === 1, scenario.label + ': 期望 1 个 Committed Model Step，实际 ' + steps.length);
  assert(entry !== undefined, scenario.label + ': 没有已提交的 assistant entry');
  assert(entry.content === expected, scenario.label + ': 提交正文与模型响应不一致');
  assert(
    timing.deltaCount === Math.ceil(expected.length / CHUNK_BYTES),
    scenario.label + ': delta 次数与 16KiB 分片不符（' + timing.deltaCount + '）',
  );

  const measurement = {
    label: scenario.label,
    responseBytes: scenario.responseBytes,
    responseChars: expected.length,
    chunkBytes: CHUNK_BYTES,
    chunkCount: timing.deltaCount,
    graphStatus: result.status,
    graphNote: result.note,
    timingMs: {
      totalGraphMs: round(end - start),
      modelCallMs: round(timing.committedAt - timing.entered),
      streamConsumeMs: round(timing.lastDelta - timing.entered),
      aggregateAfterChunkMs: round(timing.committedAt - timing.lastDelta),
      appendModelStepMs: round(appendModelStepMs),
      graphOverheadMs: round(end - timing.committedAt),
    },
    preview: {
      peakBytesDuringStream: previewPeak.bytes,
      peakRecordsDuringStream: previewPeak.items,
      bytesAfterFinish: finalPreview.bytes,
      recordsAfterFinish: finalPreview.items,
      previews: previews.map((preview) => ({
        previewId: preview.previewId, status: preview.status, byteLength: preview.byteLength,
      })),
    },
    memory: {
      ...memory.peak,
      rssMiB: round(memory.peak.rssBytes / 1048576, 2),
      heapUsedMiB: round(memory.peak.heapUsedBytes / 1048576, 2),
    },
    committedUsage: steps[0].usage,
  };

  const closed = previewStore.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
  return { ...measurement, previewClose: closed };
}

const measurements = [];
const runStart = performance.now();
for (const scenario of [
  { label: 'response-1mib', responseBytes: 1024 * 1024 },
  { label: 'response-5mib', responseBytes: 5 * 1024 * 1024 },
]) {
  measurements.push(await measure(scenario));
}

const report = {
  change: 'render-bounded-transcript',
  generatedBy: 'artifacts/bounded-transcript/stream-benchmark.mjs',
  runtime: { node: process.version, platform: process.platform + '-' + process.arch },
  note: 'SDK 聚合、权威接受与内存数字属于流式生成成本，不属于 3B 的 100ms 输入/缓存导航门槛。',
  totalElapsedMs: round(performance.now() - runStart),
  measurements,
};
mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, JSON.stringify(report, null, 2) + '\n', 'utf8');
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
