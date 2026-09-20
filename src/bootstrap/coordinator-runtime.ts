/**
 * MOD-07：Coordinator Runtime 的启动装配
 * （Owner: `m1-run-coordinator-sessions`）。
 *
 * 启动顺序是固定的（implementation-plan 第 4 节）：读取 Coordinator Model Configuration →
 * 解析 provider 集成并构造 chat model → 执行能力核验 → 打开 checkpoint store → 取 Runtime Lease
 * 与 fencing generation → 注册或解析 Session → 读回未决 Operation Intent → 进入模型循环。
 *
 * 「核验先于 Session 建立」是这里最重要的性质：能力核验失败时不会留下任何半可用 Session、不会
 * 打开会话库、也不会取得 Runtime Lease。本模块不创建业务权威，也不在启动时改动 Git。
 */

import { join } from 'node:path';

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';

import { verifyModelCapabilities } from '../adapters/agents/capability-probe.js';
import {
  openCheckpointStore,
  type CheckpointStore,
  type CheckpointStoreOpenFailureCode,
} from '../adapters/storage/checkpoint-store.js';
import {
  resumeIncarnation,
  type CoordinatorIncarnation,
} from '../application/coordinator/runtime-guard.js';
import type { CoordinatorModelConfiguration } from '../application/coordinator/model-config-switch.js';
import type { OperationIntent } from '../application/dto/operation-intent.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  RuntimeIncarnationId,
} from '../application/dto/identity.js';
import type {
  BranchCoordinationStore,
  CoordinationCommandRejection,
} from '../application/ports/branch-coordination-store.js';
import type { CoordinatorSessionState } from '../domain/coordinator/session-state.js';
import { COMPANION_STATE_DIRECTORY } from './composition.js';

/** checkpoint store 与 coordination store 在同一私有目录、不同文件。 */
export const CHECKPOINT_STORE_FILENAME = 'checkpoints.sqlite';

export function checkpointDatabasePath(gitCommonDir: string): string {
  return join(gitCommonDir, COMPANION_STATE_DIRECTORY, CHECKPOINT_STORE_FILENAME);
}

export const COORDINATOR_RUNTIME_FAILURE_CODES = [
  'model_resolution_failed',
  'capability_missing',
  'checkpoint_store_failed',
  'incarnation_rejected',
] as const;

export type CoordinatorRuntimeFailureCode = (typeof COORDINATOR_RUNTIME_FAILURE_CODES)[number];

export type StartCoordinatorRuntimeOptions = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly coordinatorSessionId: CoordinatorSessionId;
  readonly runtimeIncarnationId: RuntimeIncarnationId;
  readonly configuration: CoordinatorModelConfiguration;
  /** 解析 provider 集成并构造实例；由 Bootstrap 注入，Runtime 不持有 provider 清单。 */
  readonly resolveModel: () => Promise<
    | { readonly kind: 'resolved'; readonly model: BaseChatModel }
    | { readonly kind: 'failed'; readonly message: string }
  >;
  readonly gitCommonDir: string;
  readonly coordinationStore: BranchCoordinationStore;
  readonly ttlMs?: number;
  readonly clock?: () => number;
  readonly probeTimeoutMs?: number;
};

export type StartedCoordinatorRuntime = {
  readonly kind: 'started';
  readonly model: BaseChatModel;
  readonly incarnation: CoordinatorIncarnation;
  readonly checkpoints: CheckpointStore;
  readonly checkpointer: BaseCheckpointSaver;
  /** 该 Session 是否已有可恢复的会话记录；`false` 表示首次启动。 */
  readonly recovered: boolean;
  readonly sessionState: CoordinatorSessionState | null;
  readonly unresolvedIntents: readonly OperationIntent[];
  readonly close: () => void;
};

export type CoordinatorRuntimeStartResult =
  | StartedCoordinatorRuntime
  | {
      readonly kind: 'rejected';
      readonly code: CoordinatorRuntimeFailureCode | CheckpointStoreOpenFailureCode;
      readonly message: string;
      readonly rejection?: CoordinationCommandRejection;
    };

/**
 * 装配一个可运行的 Coordinator Runtime。
 *
 * 失败一律是显式结果；到 `started` 为止才可能打开会话库或取得 Runtime Lease，因此核验失败的
 * 调用不会留下任何需要清理的半成品。
 */
export async function startCoordinatorRuntime(
  options: StartCoordinatorRuntimeOptions,
): Promise<CoordinatorRuntimeStartResult> {
  // 1. 解析 provider 集成并构造 chat model；失败即拒绝启动。
  const resolved = await options.resolveModel();
  if (resolved.kind === 'failed') {
    return { kind: 'rejected', code: 'model_resolution_failed', message: resolved.message };
  }

  // 2. 能力核验；核验通过之前不建立 Session、不打开会话库。
  const verification = await verifyModelCapabilities(resolved.model, {
    modelRef: options.configuration.configurationRef,
    ...(options.probeTimeoutMs === undefined ? {} : { timeoutMs: options.probeTimeoutMs }),
  });
  if (verification.kind === 'rejected') {
    return { kind: 'rejected', code: 'capability_missing', message: verification.message };
  }

  // 3. 打开 checkpoint store。
  const opened = openCheckpointStore({
    databasePath: checkpointDatabasePath(options.gitCommonDir),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  if (opened.kind === 'failed') {
    return { kind: 'rejected', code: opened.code, message: opened.message };
  }
  const checkpoints = opened.store;

  // 4. 取 Runtime Lease 与 fencing generation。
  const resumed = resumeIncarnation(options.coordinationStore, {
    coordinationScopeId: options.coordinationScopeId,
    coordinatorSessionId: options.coordinatorSessionId,
    runtimeIncarnationId: options.runtimeIncarnationId,
    checkpoints,
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
  });
  if (resumed.kind !== 'resumed') {
    checkpoints.close();
    if (resumed.kind === 'blocked') {
      return { kind: 'rejected', code: 'checkpoint_store_failed', message: resumed.reason };
    }
    return resumed.kind === 'held'
      ? {
          kind: 'rejected',
          code: 'incarnation_rejected',
          message: `Runtime Lease 仍由存活 incarnation ${resumed.lease.runtimeIncarnationId} 持有`,
        }
      : {
          kind: 'rejected',
          code: 'incarnation_rejected',
          message: resumed.rejection.message,
          rejection: resumed.rejection,
        };
  }

  return {
    kind: 'started',
    model: resolved.model,
    incarnation: resumed.incarnation,
    checkpoints,
    checkpointer: checkpoints.checkpointer,
    recovered: resumed.recovered,
    sessionState: resumed.sessionState,
    unresolvedIntents: resumed.unresolvedIntents,
    close: () => {
      checkpoints.close();
    },
  };
}
