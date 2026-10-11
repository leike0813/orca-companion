import { createHash } from 'node:crypto';
import { openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { WorkerHarness, WorkerHarnessLaunchInput, WorkerHarnessRegistry, ProveHarnessSessionInput, HarnessSessionReport } from '../application/ports/worker-harness.js';
import { resolveWorkerHarness } from '../application/ports/worker-harness.js';
import { parseHarnessSessionReport } from '../application/ports/worker-harness.js';
import { codexHarness } from '../adapters/agents/codex-harness.js';
import { opencodeHarness } from '../adapters/agents/opencode-harness.js';
import { commandCodeHarness } from '../adapters/agents/command-code-harness.js';
import { qwenHarness } from '../adapters/agents/qwen-harness.js';
import { createNativeWorkerLaunch, installNativeSessionStartReporter, proveNativeTranscript, inspectNativeTranscript, nativeTranscriptIdentity, nativeRecoveryInstructions, type NativeHarness } from '../adapters/agents/native-worker.js';
import { probeHarnessReadOnlyWorker, assertReadOnlyExecutionWrapperAvailable } from '../adapters/agents/read-only-execution-wrapper.js';
import { bindHarnessSession, type HarnessSessionFacts, type SessionBindingResult } from '../adapters/agents/session-binding.js';
import { workerModelQuery } from '../adapters/agents/worker-model-catalog.js';

/** 只证明最后一条报告；冲突身份、损坏尾行或超限文件不能沿用历史绑定。 */
export function readLatestHarnessSessionReport(path: string): HarnessSessionReport | null {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'r');
    const size = fstatSync(descriptor).size;
    if (size > 256 * 1024) return null;
    const bytes = Buffer.alloc(size);
    if (readSync(descriptor, bytes, 0, size, 0) !== size) return null;
    const candidates = new Set<string>();
    let latest: HarnessSessionReport | null = null;
    for (const line of bytes.toString('utf8').split('\n').filter((entry) => entry.trim().length > 0)) {
      const decoded: unknown = JSON.parse(line);
      latest = parseHarnessSessionReport(decoded);
      if (latest === null) return null;
      if (latest.sessionId !== null) candidates.add(latest.sessionId);
    }
    return candidates.size > 1 ? null : latest;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function nativeHarness(id: NativeHarness): WorkerHarness {
  return {
    id,
    prepareLaunch: (input) => createNativeWorkerLaunch(id, { ...input, assertReadOnlyWrapperAvailable: assertReadOnlyExecutionWrapperAvailable, ...(input.sessionStartReporterPath === undefined ? {} : { reporterPath: input.sessionStartReporterPath }) }),
    prepareReadOnlyLaunch: (input) => createNativeWorkerLaunch(id, { ...input, sandboxMode: 'read-only-local-control', assertReadOnlyWrapperAvailable: assertReadOnlyExecutionWrapperAvailable, ...(input.sessionStartReporterPath === undefined ? {} : { reporterPath: input.sessionStartReporterPath }) }),
    probe: (selection) => probeHarnessReadOnlyWorker(id, selection),
    queryModels: workerModelQuery(id),
    prepareResume: (input) => createNativeWorkerLaunch(id, { ...input, resume: {
      sessionId: input.sessionId, stateRoot: input.originalStateRoot, transcriptRef: input.transcriptRef,
    }, assertReadOnlyWrapperAvailable: assertReadOnlyExecutionWrapperAvailable, ...(input.sessionStartReporterPath === undefined ? {} : { reporterPath: input.sessionStartReporterPath }) }),
    readTranscriptIdentity: (input) => Promise.resolve(nativeTranscriptIdentity(id, input)),
    recoveryInstructions: () => nativeRecoveryInstructions(id),
    sessionPaths: (root, launchId) => {
      const stateRoot = join(root, id);
      const digest = createHash('sha256').update(launchId).digest('hex').slice(0, 20);
      return { stateRoot, reporterPath: join(stateRoot, digest, 'session-start.mjs'), reportPath: join(stateRoot, digest, 'session-start.jsonl') };
    },
    installReporter: (paths) => installNativeSessionStartReporter(id, { ...paths, stateRoot: dirname(paths.reporterPath) }),
    proveSession: (input) => Promise.resolve(proveNativeTranscript(id, input)),
    inspectTranscript: (ref) => inspectNativeTranscript(id, ref),
  };
}

export const workerHarnessRegistry: WorkerHarnessRegistry = new Map([
  ['codex', codexHarness],
  ['opencode', opencodeHarness],
  ['command-code', commandCodeHarness],
  ['qwen-code', qwenHarness],
  ...(['claude', 'pi', 'omp'] as const).map((id) => [id, nativeHarness(id)] as const),
]);

export function requireWorkerHarness(id: string): WorkerHarness {
  const result = resolveWorkerHarness(workerHarnessRegistry, id);
  if (result.kind === 'rejected') throw Object.assign(new Error(result.message), { code: result.code });
  return result.harness;
}
export function workerSessionPathsUnder(id: string, root: string, launchId: string) {
  return requireWorkerHarness(id).sessionPaths(root, launchId);
}
export function resumeSessionPathsUnder(id: string, root: string, launchId: string, originalStateRoot: string) {
  if (!originalStateRoot) throw new Error('恢复缺少原生状态根');
  return workerSessionPathsUnder(id, root, launchId);
}
export function installHarnessSessionReporter(id: string, paths: { readonly reporterPath: string; readonly reportPath: string }): void {
  requireWorkerHarness(id).installReporter(paths);
}
export function prepareHarnessWorkerLaunch(id: string, input: WorkerHarnessLaunchInput) {
  return requireWorkerHarness(id).prepareLaunch(input);
}
export function prepareHarnessResumeLaunch(id: string, input: WorkerHarnessLaunchInput & {
  readonly sessionId: string; readonly codexHome: string; readonly transcriptRef: string;
}) {
  return requireWorkerHarness(id).prepareResume({ ...input, originalStateRoot: input.codexHome });
}
export async function bindHarnessSessionFromStartReport(input: Omit<ProveHarnessSessionInput, 'expectedStateRoot'> & {
  readonly expectedCodexHome: string;
  readonly facts: Omit<HarnessSessionFacts, 'providerSessionId' | 'transcriptRef' | 'observedAt'>;
  readonly report: HarnessSessionReport;
  readonly identityChanged?: boolean;
}): Promise<SessionBindingResult> {
  const harness = workerHarnessRegistry.get(input.facts.harness);
  if (harness === undefined) return { kind: 'unavailable', code: 'harness_mismatch', message: 'Worker Harness 未注册', blocksDispatch: true };
  const report = parseHarnessSessionReport(input.report);
  if (report === null) return { kind: 'unavailable', code: 'transcript_unavailable', message: 'Session 报告字段不可核验', blocksDispatch: true };
  if (report.harness !== undefined && report.harness !== harness.id) return { kind: 'unavailable', code: 'harness_mismatch', message: 'Session 报告与获批 Harness 不一致', blocksDispatch: true };
  const result = await harness.proveSession({ ...input, report, expectedStateRoot: input.expectedCodexHome });
  if (result.kind !== 'proven') return { kind: 'unavailable', code: 'transcript_unavailable', message: result.reason, blocksDispatch: true };
  return bindHarnessSession(input.facts.harness, { ...input.facts, ...result.proof }, input);
}
export function readHarnessTranscriptIdentity(input: { readonly harness: string; readonly transcriptRef: string; readonly workspace: string }) {
  return workerHarnessRegistry.get(input.harness)?.readTranscriptIdentity(input)
    ?? Promise.resolve({ kind: 'transcript_unavailable' as const, reason: 'Harness transcript 无法重新核验' });
}
