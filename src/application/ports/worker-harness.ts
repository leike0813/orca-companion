import { z } from 'zod';
import type { PreparedTerminalStrategy, PreparedTerminalLaunch } from '../worker-launch.js';
import type { TranscriptCoverageEvidence } from '../recovery/recovery-capsule.js';
import type { WorkerModelSelection, WorkerEffortCapability } from '../../domain/model-configuration.js';
import type { DispatchId, WorkerTaskId } from '../dto/identity.js';
import type { WorkerRole } from '../../domain/planning/execution-authorization.js';

export type HarnessSessionFacts = {
  readonly harness: string;
  readonly role: WorkerRole;
  readonly workerTaskId: WorkerTaskId;
  readonly dispatchId: DispatchId;
  readonly attemptId: string;
  readonly providerSessionId: string | null;
  readonly transcriptRef: string | null;
  readonly observedAt: string | null;
};

export type WorkerSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access' | 'read-only-local-control';
export type WorkerHarnessLaunchInput = {
  readonly launchId: string;
  readonly modelSelection: Readonly<WorkerModelSelection>;
  readonly sandboxMode: WorkerSandboxMode;
  readonly stateRoot?: string;
  readonly sessionStartReporterPath?: string;
};
export type PreparedHarnessTerminal = PreparedTerminalLaunch & { readonly stateRoot: string };
export type HarnessSessionReport = {
  readonly sessionId: string | null;
  readonly transcriptPath: string | null;
  readonly cwd: string | null;
  readonly observedAt: string | null;
  readonly codexHome?: string | null;
  readonly stateRoot?: string | null;
  readonly harness?: string;
  readonly runtimeRoots?: readonly string[];
};

const harnessSessionReportSchema = z.object({
  sessionId: z.string().nullable(),
  transcriptPath: z.string().nullable(),
  cwd: z.string().nullable(),
  observedAt: z.string().nullable(),
  codexHome: z.string().nullable().optional(),
  stateRoot: z.string().nullable().optional(),
  harness: z.string().optional(),
  runtimeRoots: z.array(z.string().min(1).max(4096)).max(16).optional(),
});

export function parseHarnessSessionReport(value: unknown): HarnessSessionReport | null {
  const parsed = harnessSessionReportSchema.safeParse(value);
  if (!parsed.success) return null;
  const { codexHome, stateRoot, harness, runtimeRoots, ...required } = parsed.data;
  return {
    ...required,
    ...(codexHome === undefined ? {} : { codexHome }),
    ...(stateRoot === undefined ? {} : { stateRoot }),
    ...(harness === undefined ? {} : { harness }),
    ...(runtimeRoots === undefined ? {} : { runtimeRoots }),
  };
}
export type HarnessTranscriptProof = {
  readonly providerSessionId: string;
  readonly transcriptRef: string;
  readonly observedAt: string;
};
export type HarnessTranscriptProofResult =
  | { readonly kind: 'proven'; readonly proof: HarnessTranscriptProof }
  | { readonly kind: 'transcript_unavailable'; readonly reason: string };
export type HarnessTranscriptCoverageResult =
  | { readonly kind: 'covered'; readonly evidence: TranscriptCoverageEvidence }
  | { readonly kind: 'transcript_unavailable'; readonly reason: string };
export type WorkerHarnessProbeResult = {
  readonly kind: 'available' | 'unavailable' | 'unknown';
  readonly stage: string;
  readonly profile: string;
  readonly diagnostics: readonly string[];
  readonly harnessVersion: string | null;
};
export type ProveHarnessSessionInput = {
  readonly report: HarnessSessionReport;
  readonly workspace: string;
  readonly expectedStateRoot: string;
  readonly dispatchStartedAt: string;
  readonly bindingDeadlineAt: string;
};

export type WorkerModelCatalogResult =
  | { readonly kind: 'available'; readonly source: string; readonly models: readonly {
    readonly model: string; readonly effortCapability: WorkerEffortCapability | null;
  }[] }
  | { readonly kind: 'unavailable'; readonly code: string; readonly message: string };
export type WorkerModelCatalogQuery = {
  readonly cwd: string; readonly signal?: AbortSignal;
  readonly env?: Readonly<Record<string, string>>;
};

export interface WorkerHarness {
  readonly id: string;
  prepareLaunch(input: WorkerHarnessLaunchInput): PreparedTerminalStrategy<PreparedHarnessTerminal>;
  prepareReadOnlyLaunch(input: WorkerHarnessLaunchInput): PreparedTerminalStrategy<PreparedHarnessTerminal>;
  probe(modelSelection?: Readonly<WorkerModelSelection>): Promise<WorkerHarnessProbeResult>;
  queryModels(input: WorkerModelCatalogQuery): Promise<WorkerModelCatalogResult>;
  prepareResume(input: WorkerHarnessLaunchInput & {
    readonly sessionId: string;
    readonly originalStateRoot: string;
    readonly transcriptRef: string;
  }): PreparedTerminalStrategy<PreparedHarnessTerminal>;
  sessionPaths(companionStateRoot: string, launchId: string): {
    readonly stateRoot: string;
    readonly reporterPath: string;
    readonly reportPath: string;
  };
  installReporter(paths: { readonly reporterPath: string; readonly reportPath: string }): void;
  proveSession(input: ProveHarnessSessionInput): Promise<HarnessTranscriptProofResult>;
  inspectTranscript(transcriptRef: string): Promise<HarnessTranscriptCoverageResult>;
}

export type WorkerHarnessRegistry = ReadonlyMap<string, WorkerHarness>;
export function resolveWorkerHarness(registry: WorkerHarnessRegistry, id: string):
  | { readonly kind: 'resolved'; readonly harness: WorkerHarness }
  | { readonly kind: 'rejected'; readonly code: 'worker_harness_unregistered'; readonly message: string } {
  const harness = registry.get(id);
  return harness === undefined
    ? { kind: 'rejected', code: 'worker_harness_unregistered', message: `Worker Harness 未注册：${id}` }
    : { kind: 'resolved', harness };
}
