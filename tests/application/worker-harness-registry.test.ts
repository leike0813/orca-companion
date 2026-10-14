import { expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkerHarness, requireHarnessCapability, resolveWorkerHarness } from '../../src/application/ports/worker-harness.js';
import type { WorkerHarness } from '../../src/application/ports/worker-harness.js';
import { readHarnessTranscriptIdentity, readLatestHarnessSessionReport, requireWorkerHarness, workerHarnessRegistry } from '../../src/bootstrap/worker-harness.js';
import { nativeRecoveryInstructions } from '../../src/adapters/agents/native-worker.js';
import { codexHarness } from '../../src/adapters/agents/codex-harness.js';
import { recoveryCapsuleInstructions } from '../../src/adapters/agents/utility-worker.js';
import { deriveWorkerSupportLevel } from '../../src/domain/worker-harness-support.js';
import { parseHarnessSessionReport } from '../../src/application/ports/worker-harness.js';

/** 已登记身份；登记只表达 adapter 存在，支持等级仍由 harness-support 的证据判定。 */
const REGISTERED_HARNESS_IDS = [
  'codex', 'claude', 'opencode', 'pi', 'omp', 'command-code', 'qwen-code', 'antigravity',
  'kilo', 'kimi', 'hermes', 'cline', 'muse', 'cursor',
] as const;

test.each(REGISTERED_HARNESS_IDS)('按显式身份解析 %s', (id) => {
  const result = resolveWorkerHarness(workerHarnessRegistry, id);
  expect(result.kind).toBe('resolved');
  if (result.kind === 'resolved') expect(result.harness.id).toBe(id);
});
test('未注册的 harness 在派发前拒绝', () => {
  expect(resolveWorkerHarness(workerHarnessRegistry, 'unknown')).toMatchObject({ kind: 'rejected', code: 'worker_harness_unregistered' });
});

test.each(REGISTERED_HARNESS_IDS)('%s 登记不等于准入：无证据即 unavailable', (id) => {
  // 登记只表达 adapter 身份；同一身份在 harness-support 里仍需真实证据才取得等级。
  expect(resolveWorkerHarness(workerHarnessRegistry, id).kind).toBe('resolved');
  expect(deriveWorkerSupportLevel({ harness: id, evidenceRef: 'registered-identity-only', facts: [] })).toBe('unavailable');
});

test.each(REGISTERED_HARNESS_IDS)('%s 注册项按能力组提供 transcript 身份与 recovery 配方', (id) => {
  const result = resolveWorkerHarness(workerHarnessRegistry, id);
  expect(result.kind).toBe('resolved');
  if (result.kind !== 'resolved') return;
  expect(typeof requireHarnessCapability(result.harness, 'nativeSession').readTranscriptIdentity).toBe('function');
  expect(requireHarnessCapability(result.harness, 'recovery').recoveryInstructions().length).toBeGreaterThan(0);
});

test('具体 adapter 保留顶层方法，能力组暴露同一批方法', () => {
  const capabilities = codexHarness.capabilities;
  expect(typeof capabilities?.nativeSession?.proveSession).toBe('function');
  expect(typeof capabilities?.nativeSession?.readTranscriptIdentity).toBe('function');
  expect(typeof capabilities?.readOnly?.prepareReadOnlyLaunch).toBe('function');
  expect(typeof capabilities?.readOnly?.probe).toBe('function');
  expect(typeof capabilities?.resume?.prepareResume).toBe('function');
  expect(typeof capabilities?.recovery?.inspectTranscript).toBe('function');
  // 顶层方法与能力组来自同一次组装：组内调用与直接调用结果一致。
  expect(capabilities?.recovery?.recoveryInstructions()).toEqual(codexHarness.recoveryInstructions());
});

test('缺少能力组时 requireHarnessCapability 结构化拒绝，能力组可单独取用', () => {
  const bare: WorkerHarness = {
    id: 'bare',
    prepareLaunch: () => { throw new Error('unused'); },
    queryModels: () => Promise.reject(new Error('unused')),
    sessionPaths: () => ({ stateRoot: '/s', reporterPath: '/s/reporter', reportPath: '/s/report' }),
    installReporter: () => {},
  };
  let failure: unknown = null;
  try { requireHarnessCapability(bare, 'recovery'); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: 'worker_harness_capability_unavailable' });
  expect(typeof requireHarnessCapability(createWorkerHarness(codexHarness), 'resume').prepareResume).toBe('function');
});

test('native 配方沿用 adapter 语义，Codex 配方保持通用 builder 默认值', () => {
  for (const id of ['claude', 'pi', 'omp'] as const) {
    expect(requireHarnessCapability(requireWorkerHarness(id), 'recovery').recoveryInstructions()).toEqual(nativeRecoveryInstructions(id));
  }
  const evidence = {
    coverage: 'complete' as const,
    readableRange: { transcriptRef: '/worker/transcript', fromEventRef: 'event:1', toEventRef: 'event:1' },
    gaps: [],
    lastCompleteEventRef: 'event:1',
  };
  expect(requireHarnessCapability(requireWorkerHarness('codex'), 'recovery').recoveryInstructions()).toEqual(
    recoveryCapsuleInstructions('/worker/transcript', evidence).slice(4, 6),
  );
});

test('未知 harness 的 transcript 复核保留结构化不可用结果', async () => {
  await expect(readHarnessTranscriptIdentity({ harness: 'unknown', transcriptRef: '/missing', workspace: '/work' }))
    .resolves.toEqual({ kind: 'transcript_unavailable', reason: 'Harness transcript 无法重新核验' });
});

test.each([null, {}, { sessionId: 1, transcriptPath: 'path', cwd: '/work', observedAt: 'time' }])(
  '格式错误的会话报告无法进入身份绑定', (report) => {
    expect(parseHarnessSessionReport(report)).toBeNull();
  },
);

test('报告读取拒绝冲突身份、损坏尾行与超限输入', () => {
  const root = mkdtempSync(join(tmpdir(), 'companion-session-report-'));
  const path = join(root, 'report.jsonl');
  const report = {
    sessionId: 'session-a', transcriptPath: '/session-a', cwd: '/work', observedAt: '2026-10-06T00:00:00Z',
    stateRoot: '/native', runtimeRoots: ['/native', '/native/sessions'],
  };
  try {
    writeFileSync(path, JSON.stringify(report) + '\n' + JSON.stringify(report) + '\n');
    expect(readLatestHarnessSessionReport(path)).toMatchObject({ sessionId: 'session-a', stateRoot: '/native', runtimeRoots: ['/native', '/native/sessions'] });
    for (const tail of [JSON.stringify({ ...report, sessionId: 'session-b' }), '{', '{}']) {
      writeFileSync(path, JSON.stringify(report) + '\n' + tail);
      expect(readLatestHarnessSessionReport(path)).toBeNull();
    }
    writeFileSync(path, ' '.repeat(256 * 1024 + 1));
    expect(readLatestHarnessSessionReport(path)).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
