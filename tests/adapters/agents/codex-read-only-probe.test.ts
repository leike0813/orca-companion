import { expect, test } from 'vitest';
import { probeReadOnlyWorker, readOnlyWorkerUnavailableReason } from '../../../src/adapters/agents/codex-read-only-probe.js';

test('Codex probe delegates to the shared wrapper and preserves unknown results', async () => {
  const result = await probeReadOnlyWorker({
    runner: () => Promise.resolve({ kind: 'unknown', reason: 'timeout', stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } }),
    modelSelection: { model: 'native-model', effort: null, effortCapability: null, catalogSource: null },
  });
  expect(result.kind).toBe('unknown');
  expect(result.profile).toBe('bwrap-read-only');
  expect(readOnlyWorkerUnavailableReason(result)).toContain('read_only_worker_unavailable');
  expect(readOnlyWorkerUnavailableReason({ ...result, kind: 'available' })).toBeNull();
});
