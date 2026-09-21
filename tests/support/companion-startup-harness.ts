/**
 * 启动验收层的最小共享装置（change: `m1-recover-execution`，任务 6.1–6.4）。
 *
 * 它把 `tests/support/recovery-harness.ts`（临时目录 + 真实 store + fake backend + 重启模拟）与
 * 真实 `startCompanionStartup` 组合起来，只补「同一个 Scope 连续启动多次」需要的那几件事：
 * 写一次会话 checkpoint、释放上一个 Runtime Lease、按给定 incarnation 产出启动请求。
 *
 * 它不伪造 Orca 身份、不预建 Recovery、不替调用方决定环境事实：未确认 Delivery 与 Recovery 事实
 * 都由调用方以 provider 覆盖注入，缺省值只表达「没有未确认 Delivery、原会话可精确恢复」。
 *
 * 这是**组合**装置，不是第二套平行装置：store 装配、fake backend、重启模拟全部仍归
 * `recovery-harness.ts`。
 */

import { openCheckpointStore } from '../../src/adapters/storage/checkpoint-store.js';
import { checkpointDatabasePath } from '../../src/bootstrap/coordinator-runtime.js';
import {
  startCompanionStartup,
  type CompanionStartupRequest,
  type CompanionStartupResult,
  type StartupDeliveryFacts,
  type StartupRecoveryFacts,
  type StartupStep,
} from '../../src/bootstrap/startup.js';
import type { RuntimeIncarnationId } from '../../src/application/dto/identity.js';
import { COORDINATOR_SESSION_STATE_SCHEMA_VERSION, type WakeBatch } from '../../src/domain/coordinator/session-state.js';
import type { WorkerRole } from '../../src/domain/planning/execution-authorization.js';
import type { BranchCoordinationStore, CoordinationWriter } from '../../src/application/ports/branch-coordination-store.js';
import type { ActiveWorkerListResult, WorkerStopPort } from '../../src/application/coordination/scope-control-service.js';
import { CapableChatModel } from './fake-chat-model.js';
import {
  RECOVERY_AUTHORIZATION,
  RECOVERY_SCOPE,
  RECOVERY_SESSION,
  createRecoveryHarness,
  readReplacementReceipt,
  roleGateFactsFor,
  type RecoveryHarness,
} from './recovery-harness.js';

const CLOCK_MS = 5_000;
const clock = (): number => CLOCK_MS;

/** 没有任何活跃 Worker 的 Worker 控制 seam：启动不派发也不停止 Worker。 */
export function idleWorkers(): WorkerStopPort {
  const listed: ActiveWorkerListResult = { kind: 'listed', dispatchIds: [] };
  return {
    listActiveDispatches: () => Promise.resolve(listed),
    requestStop: () => Promise.resolve('stopped'),
  };
}

export type CompanionStartupFixture = {
  readonly harness: RecoveryHarness;
  /** 每次启动到达的步骤，按到达顺序累积。 */
  readonly steps: StartupStep[];
  /** 读取会话 checkpoint 的当前状态；用于断言启动没有重复注入 Wake Batch。 */
  readonly sessionState: () => LoadedSessionState;
  /** 释放当前 Runtime Lease 并启动一次；返回结果同时暴露给调用方断言。 */
  readonly start: (incarnation: RuntimeIncarnationId) => Promise<CompanionStartupResult>;
  readonly close: () => void;
};

export type LoadedSessionState = {
  readonly wakeBatchIds: readonly string[];
};

export type CompanionStartupFixtureOptions = {
  readonly maxRecoveriesPerWorkerAttempt?: number;
  readonly role?: WorkerRole;
  /** 第一次启动前写入会话 checkpoint 的 Wake Batch；缺省为空历史。 */
  readonly wakeBatches?: readonly WakeBatch[];
  /** 覆盖 Recovery 事实 provider（未覆盖项沿用「原会话可精确恢复」缺省）。 */
  readonly recovery?: Partial<StartupRecoveryFacts>;
  readonly deliveries?: Partial<StartupDeliveryFacts>;
};

function scopeRevision(store: BranchCoordinationStore): number {
  const read = store.query({ kind: 'scope', coordinationScopeId: RECOVERY_SCOPE });
  if (read.kind !== 'scope' || read.scope === null) {
    throw new Error('Scope 不存在');
  }
  return read.scope.revision;
}

function releaseRuntimeLease(store: BranchCoordinationStore, writer: CoordinationWriter): void {
  const released = store.transact({
    kind: 'release-runtime-lease',
    coordinationScopeId: RECOVERY_SCOPE,
    expectedRevision: scopeRevision(store),
    writer,
  });
  if (released.kind === 'rejected') {
    throw new Error(`无法释放 Runtime Lease: ${released.message}`);
  }
}

function loadWakeBatchIds(directory: string): readonly string[] {
  const opened = openCheckpointStore({ databasePath: checkpointDatabasePath(directory), clock });
  if (opened.kind !== 'opened') {
    throw new Error(`无法打开 checkpoint store: ${opened.message}`);
  }
  const read = opened.store.loadCheckpoint(RECOVERY_SESSION);
  opened.store.close();
  if (read.kind !== 'recovered') {
    throw new Error(`无法读回 checkpoint: ${read.kind}`);
  }
  return read.state.wakeBatches.map((batch) => batch.wakeBatchId);
}

/**
 * 组装一个可重复启动的验收装置。
 *
 * `start()` 的固定顺序是：写一次 checkpoint（只写一次，之后的 incarnation 读同一份历史）→ 释放
 * 上一次持有的 Runtime Lease → 以给定 incarnation 调用真实 `startCompanionStartup`。
 */
export function createCompanionStartupFixture(
  options: CompanionStartupFixtureOptions = {},
): CompanionStartupFixture {
  const harness = createRecoveryHarness({
    ...(options.maxRecoveriesPerWorkerAttempt === undefined
      ? {}
      : { maxRecoveriesPerWorkerAttempt: options.maxRecoveriesPerWorkerAttempt }),
    ...(options.role === undefined ? {} : { role: options.role }),
  });
  const steps: StartupStep[] = [];
  let checkpointWritten = false;
  let lastWriter: CoordinationWriter | null = null;

  const writeCheckpointOnce = (): void => {
    if (checkpointWritten) {
      return;
    }
    const opened = openCheckpointStore({ databasePath: checkpointDatabasePath(harness.directory), clock });
    if (opened.kind !== 'opened') {
      throw new Error(`无法打开 checkpoint store: ${opened.message}`);
    }
    const saved = opened.store.saveCheckpoint({
      schemaVersion: COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
      coordinatorSessionId: RECOVERY_SESSION,
      committedMessages: [],
      graphPosition: 'suspend',
      committedModelSteps: [],
      wakeBatches: [...(options.wakeBatches ?? [])],
    });
    opened.store.close();
    if (saved.kind !== 'saved') {
      throw new Error('无法写入启动前 checkpoint');
    }
    checkpointWritten = true;
  };

  const defaultRecovery: StartupRecoveryFacts = {
    observationFor: () => ({
      sessionBindingId: 'binding-source-1',
      providerSessionId: 'provider-session-1',
      identityChanged: false,
    }),
    // 宿主报告 worker 仍在运行：先尝试精确恢复，不进入替代路径，也不重复派发。
    livenessFor: (recovery) => ({
      dispatchId: recovery.sourceDispatchId,
      workerRunning: true,
      terminalHandle: 'terminal-1',
      host: { kind: 'enumerated', terminalHandles: ['terminal-1'] },
    }),
    resumeExact: (request) =>
      Promise.resolve({ kind: 'resumed', sessionBindingId: request.sessionBindingId }),
    workspaceFor: () => ({ kind: 'reconciled', worktreeId: 'worktree-recovery-1', head: 'head-recovery' }),
    sourceTerminalFor: () => ({ kind: 'not_reached' }),
    roleGateFor: () => roleGateFactsFor(options.role ?? 'validator'),
    extractCapsule: () => Promise.resolve({ kind: 'transcript_unavailable', reason: '测试不生成 Capsule' }),
    execution: {
      backendIdentityRef: 'backend-identity-recovery',
      graphGeneration: 1,
      authorizationId: RECOVERY_AUTHORIZATION,
      runId: 'run-recovery',
      consumerGeneration: 1,
      timeoutMs: 60_000,
    },
    replacementFor: () => ({
      profile: { kind: 'reuse', profileRef: `profile-${options.role ?? 'validator'}` },
      workerLaunch: { kind: 'orca_managed', agent: 'codex' },
      interpretReceipt: readReplacementReceipt,
    }),
  };

  const defaultDeliveries: StartupDeliveryFacts = {
    backendIdentityRef: 'backend-identity-recovery',
    graphGeneration: 1,
    authorizationId: RECOVERY_AUTHORIZATION,
    runId: 'run-recovery',
    consumerGeneration: 1,
    timeoutMs: 60_000,
    readPending: () => Promise.resolve({ kind: 'read', pending: [] }),
  };

  const fixture: CompanionStartupFixture = {
    harness,
    steps,
    sessionState: () => ({ wakeBatchIds: loadWakeBatchIds(harness.directory) }),
    start: async (incarnation) => {
      writeCheckpointOnce();
      releaseRuntimeLease(harness.store, lastWriter ?? harness.writer);
      const request: CompanionStartupRequest = {
        runtime: {
          coordinationScopeId: RECOVERY_SCOPE,
          coordinatorSessionId: RECOVERY_SESSION,
          runtimeIncarnationId: incarnation,
          configuration: {
            configurationRef: 'model-config-recovery',
            providerIntegration: '@langchain/openai#ChatOpenAI',
            model: 'MiniMax-M3',
            modelOptions: {},
            credentialRefs: [],
            nativeWindowOwnerRef: null,
          },
          resolveModel: () => Promise.resolve({ kind: 'resolved', model: new CapableChatModel() }),
          gitCommonDir: harness.directory,
          coordinationStore: harness.store,
          ttlMs: 30_000,
          clock,
          probeTimeoutMs: 2_000,
        },
        backend: harness.backend.backend,
        clock,
        deliveries: { ...defaultDeliveries, ...options.deliveries },
        recovery: { ...defaultRecovery, ...options.recovery },
        workers: idleWorkers(),
        observer: { onStep: (step) => steps.push(step) },
      };
      const result = await startCompanionStartup(request);
      if (result.kind === 'started') {
        lastWriter = result.writer;
      }
      return result;
    },
    close: () => {
      harness.close();
    },
  };
  return fixture;
}
