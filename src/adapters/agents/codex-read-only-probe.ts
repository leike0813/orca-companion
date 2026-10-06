import type { WorkerModelSelection } from '../../domain/model-configuration.js';
import type { ProcessRunner } from '../orca-cli/process-runner.js';
import { probeHarnessReadOnlyWorker } from './read-only-execution-wrapper.js';

export type ReadOnlyWorkerProbeStage = 'codex-version' | 'host-sentinel' | 'sandbox-read' | 'sandbox-write' | 'host-verify';
export type ReadOnlyWorkerProbeResult = {
  readonly kind: 'available' | 'unavailable' | 'unknown';
  readonly stage: ReadOnlyWorkerProbeStage;
  readonly codexVersion: string | null;
  readonly profile: string;
  readonly diagnostics: readonly string[];
};
export type ReadOnlyWorkerProbeInput = {
  readonly env?: Readonly<Record<string, string>>;
  readonly executable?: string;
  readonly runner?: ProcessRunner;
  readonly timeoutMs?: number;
  readonly tempParent?: string;
  readonly modelSelection?: Readonly<WorkerModelSelection>;
};
export async function probeReadOnlyWorker(input: ReadOnlyWorkerProbeInput = {}): Promise<ReadOnlyWorkerProbeResult> {
  return await probeHarnessReadOnlyWorker('codex', input.modelSelection, {
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.executable === undefined ? {} : { harnessExecutable: input.executable }),
    ...(input.runner === undefined ? {} : { runner: input.runner }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.tempParent === undefined ? {} : { tempParent: input.tempParent }),
  });
}
export type ReadOnlyWorkerProbe = (
  harness: string, modelSelection?: Readonly<WorkerModelSelection>,
) => Promise<ReadOnlyWorkerProbeResult>;
export function describeReadOnlyWorkerCapability(result: ReadOnlyWorkerProbeResult): string {
  if (result.kind === 'available') return '可用（profile ' + result.profile + '）';
  const detail = result.diagnostics.length === 0 ? '' : '：' + result.diagnostics.join('；');
  return (result.kind === 'unknown' ? '未知' : '不可用') + '（阶段 ' + result.stage + '，profile ' + result.profile + '）' + detail;
}
export function readOnlyWorkerUnavailableReason(result: ReadOnlyWorkerProbeResult): string | null {
  return result.kind === 'available' ? null : 'read_only_worker_unavailable: ' + describeReadOnlyWorkerCapability(result);
}
