/**
 * IC-04 / D7：Session 的手动上下文压缩
 * （Owner: `m1-wire-foreground-planning-runtime`）。
 *
 * `/compact` 不是「再跑一次自动维护」，而是用户对**已经挂起**的 Session 发起的一次显式请求：它复用
 * 与自动维护完全相同的有界输入与压缩规则，把最近一次结论与可用产物写回该 Session 的 checkpoint，
 * 因此重启后仍能读到「上次到底压到了什么、是不是已经耗尽」。
 *
 * 两条准入是不可绕过的：只在挂起（或已经因 `context_exhausted` 阻塞）时接受请求，且没有任何在途
 * 模型操作。前者保证不会在模型循环中间改写它的输入，后者保证不会产生半压缩状态。
 *
 * 压缩本身由宿主注入（`compact`）：上下文组装需要当前配置的 instructions、tool schema 与最新权威
 * 事实，那些只有宿主拿得到；本层只做准入、持久化与结论归一化，不自己组装请求。
 */

import type {
  CompactionOutcome,
  CoordinatorSessionState,
  NativeCompactedWindowOwner,
  PortableContextCapsule,
} from '../../domain/coordinator/session-state.js';
import type { CoordinatorSessionId } from '../dto/identity.js';
import type { BranchCoordinationStore } from '../ports/branch-coordination-store.js';
import {
  assertFencingGeneration,
  type CheckpointWriteResult,
  type CoordinatorIncarnation,
  type CoordinatorSessionRecordPort,
} from './runtime-guard.js';
import { SUSPENSION_GRAPH_POSITION } from './suspension.js';

export const SESSION_COMPACTION_REJECTION_CODES = [
  'no_session',
  'not_suspended',
  'operations_in_flight',
  'fenced',
  'reason_required',
] as const;

export type SessionCompactionRejectionCode = (typeof SESSION_COMPACTION_REJECTION_CODES)[number];

/** 一次压缩的产物：结论与两类可持久化产物分开表达，任一方缺失都不损坏另一方。 */
export type SessionCompactionArtifacts = {
  readonly outcome: CompactionOutcome;
  readonly capsule: PortableContextCapsule | null;
  readonly nativeWindowOwner: NativeCompactedWindowOwner | null;
};

/** 压缩产物的写入 seam；由 checkpoint store 实现，与核心会话记录分开落表。 */
export type CompactionArtifactPort = {
  readonly savePortableCapsule: (
    coordinatorSessionId: CoordinatorSessionId,
    capsule: PortableContextCapsule,
  ) => CheckpointWriteResult;
  readonly saveNativeWindowOwner: (
    coordinatorSessionId: CoordinatorSessionId,
    owner: NativeCompactedWindowOwner,
  ) => CheckpointWriteResult;
};

export type RequestSessionCompactionInput = {
  readonly store: BranchCoordinationStore;
  readonly checkpoints: CoordinatorSessionRecordPort & CompactionArtifactPort;
  readonly incarnation: CoordinatorIncarnation;
  readonly coordinatorSessionId: CoordinatorSessionId;
  readonly reason: string;
  /** 当前在途的模型相关操作数；大于 0 即拒绝，避免压缩与模型调用互相改写输入。 */
  readonly inFlightModelOperations: number;
  /** 组装并执行一次压缩；抛错按阻塞处理，并保留原记录。 */
  readonly compact: (state: CoordinatorSessionState) => SessionCompactionArtifacts;
  /** 可注入时钟：lease 有效期判定不读隐藏的真实时间。 */
  readonly clock?: () => number;
};

export type RequestSessionCompactionResult =
  | { readonly kind: 'compacted'; readonly outcome: CompactionOutcome; readonly capsuleRef: string | null }
  | { readonly kind: 'rejected'; readonly code: SessionCompactionRejectionCode; readonly message: string }
  | { readonly kind: 'blocked'; readonly reason: string };

function rejection(
  code: SessionCompactionRejectionCode,
  message: string,
): RequestSessionCompactionResult {
  return { kind: 'rejected', code, message };
}

/**
 * 请求一次手动压缩。
 *
 * 顺序固定：准入（挂起状态、在途操作、fencing）→ 执行压缩 → 先写结论与核心记录 → 再写产物。
 * 产物写入失败不回滚已提交的结论，而是如实返回阻塞：结论本身说明了这次维护的结果，把它丢掉只会
 * 让下次启动重新猜一遍。
 */
export function requestSessionCompaction(
  input: RequestSessionCompactionInput,
): RequestSessionCompactionResult {
  if (input.reason.trim().length === 0) {
    return rejection('reason_required', '压缩请求必须给出原因');
  }
  const read = input.checkpoints.loadCheckpoint(input.coordinatorSessionId);
  if (read.kind === 'absent') {
    return rejection('no_session', `Session ${input.coordinatorSessionId} 还没有可压缩的会话记录`);
  }
  if (read.kind === 'unrecoverable') {
    return { kind: 'blocked', reason: read.reason };
  }
  const state = read.state;
  const exhausted = state.lastCompactionOutcome?.kind === 'context_exhausted';
  if (state.graphPosition !== SUSPENSION_GRAPH_POSITION && !exhausted) {
    return rejection(
      'not_suspended',
      `Session 当前停在 ${state.graphPosition}；只有挂起或因上下文耗尽阻塞的 Session 才能手动压缩`,
    );
  }
  if (input.inFlightModelOperations > 0) {
    return rejection(
      'operations_in_flight',
      `仍有 ${String(input.inFlightModelOperations)} 个模型相关操作在途`,
    );
  }
  const fencing = assertFencingGeneration(input.store, input.incarnation, {
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });
  if (fencing.kind === 'fenced') {
    return rejection('fenced', `压缩前已被 fencing 拒绝（${fencing.code}）`);
  }

  let artifacts: SessionCompactionArtifacts;
  try {
    artifacts = input.compact(state);
  } catch (error) {
    return { kind: 'blocked', reason: error instanceof Error ? error.message : String(error) };
  }

  const written = input.checkpoints.saveCheckpoint({
    ...state,
    lastCompactionOutcome: artifacts.outcome,
  });
  if (written.kind === 'failed') {
    return { kind: 'blocked', reason: `无法持久化压缩结论：${written.message}` };
  }

  if (artifacts.capsule !== null) {
    const saved = input.checkpoints.savePortableCapsule(input.coordinatorSessionId, artifacts.capsule);
    if (saved.kind === 'failed') {
      return { kind: 'blocked', reason: `无法持久化 Context Capsule：${saved.message}` };
    }
  }
  if (artifacts.nativeWindowOwner !== null) {
    const saved = input.checkpoints.saveNativeWindowOwner(
      input.coordinatorSessionId,
      artifacts.nativeWindowOwner,
    );
    if (saved.kind === 'failed') {
      return { kind: 'blocked', reason: `无法持久化原生压缩窗口：${saved.message}` };
    }
  }

  return {
    kind: 'compacted',
    outcome: artifacts.outcome,
    capsuleRef: artifacts.capsule === null ? null : artifacts.capsule.capsuleId,
  };
}
