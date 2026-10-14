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

/**
 * 应用端口只要求每次派发都存在的公共能力：显式身份、普通启动、原生模型查询与会话工件路径。
 * 精确原生 Session、只读角色、续接与历史恢复按可选能力组表达，调用方必须经能力组访问。
 */
export interface WorkerHarness {
  readonly id: string;
  prepareLaunch(input: WorkerHarnessLaunchInput): PreparedTerminalStrategy<PreparedHarnessTerminal>;
  queryModels(input: WorkerModelCatalogQuery): Promise<WorkerModelCatalogResult>;
  sessionPaths(companionStateRoot: string, launchId: string): {
    readonly stateRoot: string;
    readonly reporterPath: string;
    readonly reportPath: string;
  };
  installReporter(paths: { readonly reporterPath: string; readonly reportPath: string }): void;
  /** 能力组的唯一入口；某组缺失即该组操作不可用，调用方按结构化拒绝或 requireHarnessCapability 处理。 */
  readonly capabilities?: WorkerHarnessCapabilities;
}

/** adapter 的真实形状：公共能力之上提供全部四组可选能力。 */
export interface FullWorkerHarness extends WorkerHarness {
  prepareReadOnlyLaunch(input: WorkerHarnessLaunchInput): PreparedTerminalStrategy<PreparedHarnessTerminal>;
  probe(modelSelection?: Readonly<WorkerModelSelection>): Promise<WorkerHarnessProbeResult>;
  prepareResume(input: WorkerHarnessLaunchInput & {
    readonly sessionId: string;
    readonly originalStateRoot: string;
    readonly transcriptRef: string;
  }): PreparedTerminalStrategy<PreparedHarnessTerminal>;
  readTranscriptIdentity(input: { readonly transcriptRef: string; readonly workspace: string }): Promise<
    { readonly providerSessionId: string } | { readonly kind: 'transcript_unavailable'; readonly reason: string }
  >;
  recoveryInstructions(): readonly string[];
  proveSession(input: ProveHarnessSessionInput): Promise<HarnessTranscriptProofResult>;
  inspectTranscript(transcriptRef: string): Promise<HarnessTranscriptCoverageResult>;
}

/** 可选能力组；每组只在 adapter 真实提供该能力时出现。 */
export type WorkerHarnessCapabilities = {
  readonly nativeSession?: Pick<FullWorkerHarness, 'proveSession' | 'readTranscriptIdentity'>;
  readonly readOnly?: Pick<FullWorkerHarness, 'prepareReadOnlyLaunch' | 'probe'>;
  readonly resume?: Pick<FullWorkerHarness, 'prepareResume'>;
  readonly recovery?: Pick<FullWorkerHarness, 'inspectTranscript' | 'recoveryInstructions'>;
};

export type WorkerHarnessCapabilityGroup = keyof WorkerHarnessCapabilities;

export const WORKER_HARNESS_CAPABILITY_UNAVAILABLE = 'worker_harness_capability_unavailable';

/**
 * 把完整 adapter 表述成「公共能力 + 能力组」。
 *
 * 方法同时留在返回的具体类型上，既有 adapter 测试与 bootstrap 的同步包装器可以继续直接调用；
 * 端口调用方则经 capabilities 或 requireHarnessCapability 取用。
 */
export function createWorkerHarness(input: FullWorkerHarness): WorkerHarness & FullWorkerHarness {
  // adapter 的方法都是箭头函数属性，从不脱离对象调用；按组引用正是能力组的定义方式。
  /* eslint-disable @typescript-eslint/unbound-method */
  const capabilities: WorkerHarnessCapabilities = {
    nativeSession: { proveSession: input.proveSession, readTranscriptIdentity: input.readTranscriptIdentity },
    readOnly: { prepareReadOnlyLaunch: input.prepareReadOnlyLaunch, probe: input.probe },
    resume: { prepareResume: input.prepareResume },
    recovery: { inspectTranscript: input.inspectTranscript, recoveryInstructions: input.recoveryInstructions },
  };
  /* eslint-enable @typescript-eslint/unbound-method */
  return { ...input, capabilities };
}

/**
 * 取一组能力；缺失即抛出带 worker_harness_capability_unavailable 的结构化拒绝。
 * 返回类型收窄为真实存在的方法集合，调用方不需要再判空。
 */
export function requireHarnessCapability<K extends WorkerHarnessCapabilityGroup>(
  harness: WorkerHarness,
  group: K,
): NonNullable<WorkerHarnessCapabilities[K]> {
  const capability = harness.capabilities?.[group];
  if (capability === undefined) {
    throw Object.assign(
      new Error(`Worker Harness ${harness.id} 缺少能力组：${group}`),
      { code: WORKER_HARNESS_CAPABILITY_UNAVAILABLE },
    );
  }
  return capability;
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
