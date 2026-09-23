/**
 * IP-5..IP-8 恢复测试的最小共享装置（change: `m1-recover-execution`）。
 *
 * 沿用 `tests/coordination-store.test.ts` 与 `tests/application/process-delivery.test.ts` 的既有风格：
 * 临时目录 + `openCoordinationStore`，走真实应用路径建立 Scope、Runtime/Execution Lease、候选图、
 * 已批准 Manifest、中断 Session Segment 与物化绑定。这里只提供装置，不放松任何合同。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openCoordinationStore, type CoordinationStore } from '../../src/adapters/storage/coordination-store.js';
import { acquireRuntimeLease } from '../../src/application/coordination/lease-service.js';
import { recordInitialGraph } from '../../src/application/planning/graph-history.js';
import { initializeCoordinationScope } from '../../src/application/planning/initialize-scope.js';
import { proposeManifest, recordApproval } from '../../src/application/planning/authorization-service.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  DispatchId,
  GraphGeneration,
  GraphId,
  OperationId,
  PlanningCycleId,
  RecoveryId,
  RuntimeIncarnationId,
  SessionSegmentId,
  WorkerTaskId,
  WorkPackageId,
} from '../../src/application/dto/identity.js';
import type { ExecutionQueryResult, OperationOutcome } from '../../src/application/dto/operation-outcome.js';
import type {
  CoordinationWriter,
  RecoveryRecord,
  SessionSegmentRecord,
} from '../../src/application/ports/branch-coordination-store.js';
import type {
  ExecutionBackend,
  ExecutionMutation,
  ExecutionQuery,
  ExecutionScope,
} from '../../src/application/ports/execution-backend.js';
import type { WorkerRole } from '../../src/domain/planning/execution-authorization.js';
import { WORKER_ROLES } from '../../src/domain/planning/execution-authorization.js';
import type { RoleGateFacts } from '../../src/domain/recovery/role-gate.js';
import type { ExecutionGraph } from '../../src/domain/planning/execution-graph.js';
import type {
  RecoverWorkerSessionInput,
  ReplacementSessionReceipt,
} from '../../src/application/recovery/worker-session-recovery-service.js';

export const RECOVERY_SCOPE = 'scope-recovery' as CoordinationScopeId;
export const RECOVERY_SESSION = 'session-recovery' as CoordinatorSessionId;
export const RECOVERY_CYCLE = 'cycle-recovery' as PlanningCycleId;
export const RECOVERY_GRAPH = 'graph-recovery' as GraphId;
export const RECOVERY_INCARNATION = 'inc-recovery' as RuntimeIncarnationId;
export const RECOVERY_WORK_PACKAGE = 'wp-recovery' as WorkPackageId;
export const RECOVERY_WORKER_TASK = 'task-recovery' as WorkerTaskId;
export const RECOVERY_AUTHORIZATION = 'auth-recovery';

/**
 * 四类角色通过角色门的缺省事实。
 *
 * 它只表达「该角色的替代 Session 可以安全接续」，不放松任何角色门判定：每个角色的字段仍是
 * `role-gate.ts` 要求的完整事实，测试要覆盖某条阻塞路径时仍需显式覆盖对应字段。
 */
export function roleGateFactsFor(role: WorkerRole): RoleGateFacts {
  switch (role) {
    case 'planner':
      return { role: 'planner', planner: { specificationUnitLanded: true, hiddenDecisions: [] } };
    case 'implementation':
      return {
        role: 'implementation',
        implementation: {
          workspaceReconciled: true,
          headReconciled: true,
          dirtyPathsReconciled: true,
          unknownExternalEffects: [],
        },
      };
    case 'validator':
      return {
        role: 'validator',
        validator: { identifiedGaps: [], invalidatedEvidenceIds: [], reverifiedEvidenceIds: [] },
      };
    case 'finalizer':
      return {
        role: 'finalizer',
        finalizer: { authoritativeInputs: ['graph:1', `authorization:${RECOVERY_AUTHORIZATION}`] },
      };
  }
}

export type BackendCall =
  | { readonly kind: 'mutate'; readonly operation: ExecutionMutation; readonly scope: ExecutionScope }
  | { readonly kind: 'query'; readonly operation: ExecutionQuery };

export type FakeRecoveryBackend = {
  readonly backend: ExecutionBackend;
  readonly calls: readonly BackendCall[];
  readonly mutations: () => readonly ExecutionMutation[];
};

/** 记录型 fake backend：默认接受替代派发，可按调用注入拒绝或 unknown。 */
export function fakeRecoveryBackend(script?: {
  readonly workerStart?: (
    call: number,
    mutation: Extract<ExecutionMutation, { readonly operation: 'worker-start' }>,
  ) => OperationOutcome<unknown>;
}): FakeRecoveryBackend {
  const calls: BackendCall[] = [];
  let workerStarts = 0;
  const backend: ExecutionBackend = {
    query: (input: ExecutionQuery): Promise<ExecutionQueryResult> => {
      calls.push({ kind: 'query', operation: input });
      if (input.operation === 'request-show') {
        return Promise.resolve({ kind: 'accepted', value: { requestId: input.requestId, state: 'pending' } });
      }
      return Promise.resolve({ kind: 'accepted', value: {} });
    },
    mutate: (input: ExecutionMutation, scope: ExecutionScope): Promise<OperationOutcome<unknown>> => {
      calls.push({ kind: 'mutate', operation: input, scope });
      if (input.operation === 'worker-start') {
        workerStarts += 1;
        const injected = script?.workerStart?.(workerStarts, input);
        if (injected !== undefined) {
          return Promise.resolve(injected);
        }
        return Promise.resolve({
          kind: 'accepted',
          operation: {
            operationId: scope.operationId,
            backendRequestId: `request-${scope.operationId}`,
            target: scope.target,
          },
          value: {
            dispatchId: 'dispatch-alternate-1',
            sessionBindingId: 'binding-alternate-1',
            transcriptRef: 'transcript:alternate-1',
          },
        });
      }
      return Promise.resolve({
        kind: 'accepted',
        operation: {
          operationId: scope.operationId,
          backendRequestId: `request-${scope.operationId}`,
          target: scope.target,
        },
        value: {},
      });
    },
  };
  return { backend, calls, mutations: () => calls.filter((call) => call.kind === 'mutate').map((call) => call.operation) };
}

/** 替代派发回执的解释器：只接受可核验的 Dispatch / Binding / transcript 三项身份。 */
export function readReplacementReceipt(
  outcome: Extract<OperationOutcome<unknown>, { readonly kind: 'accepted' }>,
): ReplacementSessionReceipt | { readonly failure: string } {
  const value = outcome.value as
    | { readonly dispatchId?: unknown; readonly sessionBindingId?: unknown; readonly transcriptRef?: unknown }
    | null;
  if (value === null) {
    return { failure: '替代派发回执不是对象' };
  }
  const { dispatchId, sessionBindingId, transcriptRef } = value;
  if (typeof dispatchId !== 'string' || dispatchId.length === 0) {
    return { failure: '替代派发回执缺少 dispatch id' };
  }
  if (typeof sessionBindingId !== 'string' || sessionBindingId.length === 0) {
    return { failure: '替代派发回执缺少 session binding' };
  }
  if (typeof transcriptRef !== 'string' || transcriptRef.length === 0) {
    return { failure: '替代派发回执缺少 transcript 引用' };
  }
  return { dispatchId, sessionBindingId, transcriptRef };
}

export type SourceSegmentInput = {
  readonly segmentId: string;
  readonly dispatchId: string;
  readonly attemptId: string;
  readonly sessionBindingId: string;
  readonly role?: WorkerRole;
  readonly workPackageId?: WorkPackageId;
  readonly workerTaskId?: WorkerTaskId;
  readonly lastTranscriptRef?: string | null;
  readonly transcriptReferenceable?: boolean;
  readonly verifiable?: boolean;
};

export type RecoveryHarness = {
  readonly directory: string;
  readonly store: CoordinationStore;
  readonly writer: CoordinationWriter;
  readonly backend: FakeRecoveryBackend;
  /** 关闭并重开同一数据库文件，模拟 Companion 重启。 */
  reopen: () => void;
  close: () => void;
  recordSourceSegment: (input: SourceSegmentInput) => SessionSegmentRecord;
  recordMaterializationBinding: (workPackageId: WorkPackageId, orcaTaskId: string) => void;
  /**
   * 显式释放 Runtime Lease，让后续 `startCoordinatorRuntime` 能取得新的 incarnation。
   *
   * 只用于「重启 / 换 Incarnation」类测试；释放后本装置的 `writer` 因 fencing 失效，不应再写入。
   */
  releaseRuntimeLease: () => void;
  segments: () => readonly SessionSegmentRecord[];
  recoveries: () => readonly RecoveryRecord[];
  recovery: (recoveryId: string) => RecoveryRecord | null;
  authorizationRef: () => { readonly authorizationId: string; readonly authorizationVersion: number };
  /** 组装默认合法的恢复输入；测试只覆盖与断言相关的字段。 */
  input: (
    overrides: Partial<RecoverWorkerSessionInput> &
      Pick<RecoverWorkerSessionInput, 'sourceSegmentId' | 'sourceDispatchId' | 'liveness' | 'observation'>,
  ) => RecoverWorkerSessionInput;
};

export type RecoveryHarnessOptions = {
  readonly maxRecoveriesPerWorkerAttempt?: number;
  readonly role?: WorkerRole;
};

export function createRecoveryHarness(options: RecoveryHarnessOptions = {}): RecoveryHarness {
  const directory = mkdtempSync(join(tmpdir(), 'orca-recovery-'));
  const databasePath = join(directory, 'coordination.sqlite');
  const clock = (): number => 5_000;

  let opened = openCoordinationStore({ databasePath, clock });
  if (opened.kind !== 'opened') {
    throw new Error(`无法打开测试 store: ${opened.message}`);
  }
  let store = opened.store;

  const initialized = initializeCoordinationScope({
    store,
    coordinationScopeId: RECOVERY_SCOPE,
    coordinatorSessionId: RECOVERY_SESSION,
    coordinatorModelConfigurationRef: 'model-config-recovery',
    planningCycleId: RECOVERY_CYCLE,
    fullBranchRef: `refs/heads/${RECOVERY_SCOPE}`,
    canonicalWorktreePath: '/tmp/orca-recovery-worktree',
  });
  if (initialized.kind !== 'initialized') {
    throw new Error(`无法初始化 Scope: ${initialized.message}`);
  }
  const leased = acquireRuntimeLease(store, {
    coordinationScopeId: RECOVERY_SCOPE,
    coordinatorSessionId: RECOVERY_SESSION,
    runtimeIncarnationId: RECOVERY_INCARNATION,
    fencingGeneration: 0,
  });
  if (leased.kind !== 'acquired') {
    throw new Error(`无法取得 Runtime Lease: ${leased.kind}`);
  }
  const writer: CoordinationWriter = {
    coordinatorSessionId: RECOVERY_SESSION,
    runtimeIncarnationId: RECOVERY_INCARNATION,
    fencingGeneration: leased.lease.fencingGeneration,
  };

  const revisionOf = (): number => {
    const scope = store.query({ kind: 'scope', coordinationScopeId: RECOVERY_SCOPE });
    if (scope.kind !== 'scope' || scope.scope === null) {
      throw new Error('Scope 不存在');
    }
    return scope.scope.revision;
  };
  const mapRevisionOf = (): number => {
    const scope = store.query({ kind: 'scope', coordinationScopeId: RECOVERY_SCOPE });
    if (scope.kind !== 'scope' || scope.scope === null) {
      throw new Error('Scope 不存在');
    }
    return scope.scope.mapRevision;
  };

  const graph: ExecutionGraph = {
    graphId: RECOVERY_GRAPH,
    generation: 1 as GraphGeneration,
    concurrencyLimit: 1,
    workPackages: [],
  };
  const candidate = recordInitialGraph({
    store,
    coordinationScopeId: RECOVERY_SCOPE,
    writer,
    graph,
    mapRevision: mapRevisionOf(),
    planRevision: 1,
    orcaRunId: 'run-recovery',
  });
  if (candidate.kind !== 'recorded') {
    throw new Error(`无法记录候选图: ${candidate.failure.message}`);
  }
  const proposed = proposeManifest({
    store,
    coordinationScopeId: RECOVERY_SCOPE,
    candidate: candidate.version,
    currentPlanRevision: candidate.version.planRevision,
    rawManifest: {
      coordinationScopeId: RECOVERY_SCOPE,
      planningCycleId: RECOVERY_CYCLE,
      destinationRef: { kind: 'destination', id: 'destination-recovery', version: 1 },
      routeMapRef: { kind: 'route-map', id: 'map-recovery', version: candidate.version.mapRevision },
      implementationPlanRef: {
        kind: 'implementation-plan',
        id: 'plan-recovery',
        version: candidate.version.planRevision,
      },
      graph: {
        graphId: candidate.version.graphId,
        generation: candidate.version.generation,
        version: candidate.version.version,
      },
      baselineHead: 'head-recovery',
      orcaRunId: 'run-recovery',
      workerProfiles: WORKER_ROLES.map((role) => ({
        profileRef: { kind: 'worker-profile', id: `profile-${role}` },
        role,
        harness: 'codex',
      })),
      permissions: {
        planner: true,
        implementation: true,
        validator: true,
        finalizer: true,
        gitIntegration: false,
        dependencyChanges: false,
      },
      // 恢复额度只能来自已批准 Manifest；0 不是合法上限，最小可用值为 1。
      limits: { maxRecoveriesPerWorkerAttempt: options.maxRecoveriesPerWorkerAttempt ?? 1 },
      workspacePolicy: { canonicalWorktree: '/tmp/recovery-worktree', worktreeIsolation: 'per_work_package' },
      gitPolicy: {
        canonicalBranch: 'main',
        remotes: ['origin'],
        refs: ['refs/heads/main'],
        allowForcePush: false,
      },
      dependencyPolicy: { allowDependencyChanges: false, registry: null },
      acceptedRisks: ['risk-recovery'],
    },
  });
  if (proposed.kind !== 'proposed') {
    throw new Error(`无法组装 Manifest: ${proposed.failure.message}`);
  }
  const approved = recordApproval({
    store,
    coordinationScopeId: RECOVERY_SCOPE,
    writer,
    authorizationId: RECOVERY_AUTHORIZATION,
    manifest: proposed.manifest,
    currentPlanRevision: candidate.version.planRevision,
    approvalRef: 'approval-recovery',
  });
  if (approved.kind !== 'recorded') {
    throw new Error(`无法记录授权: ${approved.failure.message}`);
  }

  const executionLease = store.transact({
    kind: 'acquire-execution-lease',
    coordinationScopeId: RECOVERY_SCOPE,
    expectedRevision: revisionOf(),
    writer,
  });
  if (executionLease.kind !== 'committed') {
    throw new Error(`无法取得 Execution Lease: ${executionLease.message}`);
  }
  const refs = store.transact({
    kind: 'update-scope-refs',
    coordinationScopeId: RECOVERY_SCOPE,
    expectedRevision: revisionOf(),
    writer,
    graphId: candidate.version.graphId,
    graphVersion: candidate.version.version,
    authorizationId: RECOVERY_AUTHORIZATION,
    authorizationVersion: approved.authorization.authorizationVersion,
  });
  if (refs.kind !== 'committed') {
    throw new Error(`无法更新 Scope 引用: ${refs.message}`);
  }

  const backend = fakeRecoveryBackend();

  const recordSourceSegment = (segment: SourceSegmentInput): SessionSegmentRecord => {
    const recorded = store.transact({
      kind: 'record-session-segment',
      coordinationScopeId: RECOVERY_SCOPE,
      expectedRevision: revisionOf(),
      writer,
      segmentId: segment.segmentId as SessionSegmentId,
      workPackageId: segment.workPackageId ?? RECOVERY_WORK_PACKAGE,
      role: segment.role ?? options.role ?? 'validator',
      workerTaskId: segment.workerTaskId ?? RECOVERY_WORKER_TASK,
      dispatchId: segment.dispatchId as DispatchId,
      attemptId: segment.attemptId,
      sessionBindingId: segment.sessionBindingId,
      lastTranscriptRef: segment.lastTranscriptRef === undefined ? 'transcript:source-1' : segment.lastTranscriptRef,
      terminalReceiptRef: null,
      transcriptReferenceable: segment.transcriptReferenceable ?? true,
      verifiable: segment.verifiable ?? true,
    });
    if (recorded.kind === 'rejected') {
      throw new Error(`无法记录 Session Segment: ${recorded.message}`);
    }
    const read = store.query({
      kind: 'session-segments',
      coordinationScopeId: RECOVERY_SCOPE,
      workPackageId: segment.workPackageId ?? RECOVERY_WORK_PACKAGE,
    });
    if (read.kind !== 'session-segments') {
      throw new Error('无法读取 Session Segment');
    }
    const found = read.segments.find((entry) => entry.segmentId === segment.segmentId);
    if (found === undefined) {
      throw new Error('Session Segment 写入后无法读回');
    }
    return found;
  };

  const recordMaterializationBinding = (workPackageId: WorkPackageId, orcaTaskId: string): void => {
    const recorded = store.transact({
      kind: 'record-materialization-binding',
      coordinationScopeId: RECOVERY_SCOPE,
      expectedRevision: revisionOf(),
      writer,
      workPackageId,
      orcaTaskId,
      creationOperationId: `op:${orcaTaskId}:create` as OperationId,
    });
    if (recorded.kind === 'rejected') {
      throw new Error(`无法记录物化绑定: ${recorded.message}`);
    }
  };

  const harness: RecoveryHarness = {
    directory,
    get store() {
      return store;
    },
    writer,
    backend,
    reopen: () => {
      store.close();
      opened = openCoordinationStore({ databasePath, clock });
      if (opened.kind !== 'opened') {
        throw new Error(`无法重开测试 store: ${opened.message}`);
      }
      store = opened.store;
    },
    close: () => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
    recordSourceSegment,
    recordMaterializationBinding,
    releaseRuntimeLease: () => {
      const released = store.transact({
        kind: 'release-runtime-lease',
        coordinationScopeId: RECOVERY_SCOPE,
        expectedRevision: revisionOf(),
        writer,
      });
      if (released.kind === 'rejected') {
        throw new Error(`无法释放 Runtime Lease: ${released.message}`);
      }
    },
    segments: () => {
      const read = store.query({ kind: 'session-segments', coordinationScopeId: RECOVERY_SCOPE });
      return read.kind === 'session-segments' ? read.segments : [];
    },
    recoveries: () => {
      const read = store.query({ kind: 'recoveries', coordinationScopeId: RECOVERY_SCOPE });
      return read.kind === 'recoveries' ? read.recoveries : [];
    },
    recovery: (recoveryId) => {
      const read = store.query({
        kind: 'recovery',
        coordinationScopeId: RECOVERY_SCOPE,
        recoveryId: recoveryId as RecoveryId,
      });
      return read.kind === 'recovery' ? read.recovery : null;
    },
    authorizationRef: () => ({
      authorizationId: RECOVERY_AUTHORIZATION,
      authorizationVersion: approved.authorization.authorizationVersion,
    }),
    input: (overrides) => ({
      store,
      backend: backend.backend,
      writer,
      coordinationScopeId: RECOVERY_SCOPE,
      subject: 'worker_session',
      role: options.role ?? 'validator',
      workPackageId: RECOVERY_WORK_PACKAGE,
      workerTaskId: RECOVERY_WORKER_TASK,
      businessAttemptId: 'attempt-1',
      resumeExact: () => Promise.resolve({ kind: 'unrecoverable', reason: '原会话不可恢复' }),
      workspace: { kind: 'reconciled', worktreeId: 'worktree-recovery-1', head: 'head-recovery' },
      sourceTerminal: { kind: 'not_reached' },
      roleGate: {
        role: 'validator',
        validator: { identifiedGaps: [], invalidatedEvidenceIds: [], reverifiedEvidenceIds: [] },
      },
      extractCapsule: () => Promise.resolve({ kind: 'failed', reason: '未注入 Capsule 提取器' }),
      execution: {
        backendIdentityRef: 'backend-identity-recovery',
        graphGeneration: 1,
        authorizationId: RECOVERY_AUTHORIZATION,
        runId: 'run-recovery',
        consumerGeneration: 1,
        timeoutMs: 60_000,
      },
      replacement: {
        profile: { kind: 'reuse', profileRef: 'profile-validator' },
        workerLaunch: { kind: 'orca_managed', agent: 'codex' },
        interpretReceipt: readReplacementReceipt,
      },
      ...overrides,
    }),
  };
  return harness;
}
