import { expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkerHarness } from '../../src/application/ports/worker-harness.js';
import { readHarnessTranscriptIdentity, readLatestHarnessSessionReport, workerHarnessRegistry } from '../../src/bootstrap/worker-harness.js';
import { nativeRecoveryInstructions } from '../../src/adapters/agents/native-worker.js';
import { recoveryCapsuleInstructions } from '../../src/adapters/agents/utility-worker.js';
import { parseHarnessSessionReport } from '../../src/application/ports/worker-harness.js';

test.each(['codex', 'claude', 'opencode', 'pi', 'omp', 'command-code', 'qwen-code', 'antigravity'])('按显式身份解析 %s', (id) => {
  const result = resolveWorkerHarness(workerHarnessRegistry, id);
  expect(result.kind).toBe('resolved');
  if (result.kind === 'resolved') expect(result.harness.id).toBe(id);
});
test('未注册的 harness 在派发前拒绝', () => {
  expect(resolveWorkerHarness(workerHarnessRegistry, 'unknown')).toMatchObject({ kind: 'rejected', code: 'worker_harness_unregistered' });
});

test.each(['codex', 'claude', 'opencode', 'pi', 'omp', 'command-code', 'qwen-code', 'antigravity'])('%s 注册项提供 transcript 身份与 recovery 配方', (id) => {
  const result = resolveWorkerHarness(workerHarnessRegistry, id);
  expect(result.kind).toBe('resolved');
  if (result.kind === 'resolved') {
    expect(typeof result.harness.readTranscriptIdentity).toBe('function');
    expect(result.harness.recoveryInstructions().length).toBeGreaterThan(0);
  }
});

test('native 配方沿用 adapter 语义，Codex 配方保持通用 builder 默认值', () => {
  for (const id of ['claude', 'pi', 'omp'] as const) {
    expect(workerHarnessRegistry.get(id)?.recoveryInstructions()).toEqual(nativeRecoveryInstructions(id));
  }
  const evidence = {
    coverage: 'complete' as const,
    readableRange: { transcriptRef: '/worker/transcript', fromEventRef: 'event:1', toEventRef: 'event:1' },
    gaps: [],
    lastCompleteEventRef: 'event:1',
  };
  expect(workerHarnessRegistry.get('codex')?.recoveryInstructions()).toEqual(
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
