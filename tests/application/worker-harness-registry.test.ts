import { expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkerHarness } from '../../src/application/ports/worker-harness.js';
import { readLatestHarnessSessionReport, workerHarnessRegistry } from '../../src/bootstrap/worker-harness.js';
import { parseHarnessSessionReport } from '../../src/application/ports/worker-harness.js';

test.each(['codex', 'claude', 'opencode', 'pi', 'omp'])('按显式身份解析 %s', (id) => {
  const result = resolveWorkerHarness(workerHarnessRegistry, id);
  expect(result.kind).toBe('resolved');
  if (result.kind === 'resolved') expect(result.harness.id).toBe(id);
});
test('未注册的 harness 在派发前拒绝', () => {
  expect(resolveWorkerHarness(workerHarnessRegistry, 'unknown')).toMatchObject({ kind: 'rejected', code: 'worker_harness_unregistered' });
});

test.each([null, {}, { sessionId: 1, transcriptPath: 'path', cwd: '/work', observedAt: 'time' }])(
  '格式错误的会话报告无法进入身份绑定', (report) => {
    expect(parseHarnessSessionReport(report)).toBeNull();
  },
);

test('报告读取拒绝冲突身份、损坏尾行与超限输入', () => {
  const root = mkdtempSync(join(tmpdir(), 'companion-session-report-'));
  const path = join(root, 'report.jsonl');
  const report = { sessionId: 'session-a', transcriptPath: '/session-a', cwd: '/work', observedAt: '2026-10-06T00:00:00Z' };
  try {
    writeFileSync(path, JSON.stringify(report) + '\n' + JSON.stringify(report) + '\n');
    expect(readLatestHarnessSessionReport(path)?.sessionId).toBe('session-a');
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
