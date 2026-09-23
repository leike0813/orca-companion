/**
 * IC-04 的运行时准入与恢复身份用例
 * （Owner: `m1-run-coordinator-sessions`）。
 *
 * 这一层不自建互斥机制：单写者由直接前驱的 Runtime Lease 与递增 fencing generation 承担，
 * 这里只做调用方。它的职责是把前驱的行级事实翻译成模型循环能用的准入判断——一个
 * Coordinator Session 同时最多一个存活 incarnation，被 fence 的写入者不能提交 checkpoint，
 * 恢复必须沿用原身份。
 *
 * 失败一律是显式结果，不抛异常、不降级：checkpoint 不可恢复时同一 Session 进入阻塞，
 * 绝不创建替代 Session、绝不以空历史继续、绝不转移 Ticket Claim 或 Execution Coordination Lease。
 */

import {
  findFenceViolation,
  type FenceViolationCode,
  type LeaseRecord,
} from '../../domain/coordination/leases.js';
import type { CoordinatorSessionState, WakeBatch } from '../../domain/coordinator/session-state.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  RuntimeIncarnationId,
} from '../dto/identity.js';
import type { OperationIntent } from '../dto/operation-intent.js';
import {
  acquireRuntimeLease,
  DEFAULT_RUNTIME_LEASE_TTL_MS,
} from '../coordination/lease-service.js';
import type {
  BranchCoordinationStore,
  CoordinationCommandRejection,
  CoordinationWriter,
} from '../ports/branch-coordination-store.js';

/** 一个存活 Runtime Incarnation 的可信身份；模型与 Worker 不可填写这些字段。 */
export type CoordinatorIncarnation = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly coordinatorSessionId: CoordinatorSessionId;
  readonly runtimeIncarnationId: RuntimeIncarnationId;
  readonly fencingGeneration: number;
};

export type IncarnationRequest = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly coordinatorSessionId: CoordinatorSessionId;
  readonly runtimeIncarnationId: RuntimeIncarnationId;
  readonly ttlMs?: number;
};

export type AcquireIncarnationResult =
  | {
      readonly kind: 'acquired';
      readonly incarnation: CoordinatorIncarnation;
      readonly lease: LeaseRecord;
      /** `null` 表示这是该 Session 首次取得 Runtime Lease。 */
      readonly previousGeneration: number | null;
    }
  /** 租约仍由存活 incarnation 持有：第二个进程到此为止，不写 checkpoint、不消费 Delivery。 */
  | { readonly kind: 'held'; readonly lease: LeaseRecord }
  | { readonly kind: 'rejected'; readonly rejection: CoordinationCommandRejection };

export type FencingAssertion =
  | { readonly kind: 'valid'; readonly lease: LeaseRecord }
  | { readonly kind: 'fenced'; readonly code: FenceViolationCode };

/**
 * 读回同一 Session 会话状态的 port。
 *
 * `absent` 与 `unrecoverable` 必须分开：前者是「这个 Session 还从未写过 checkpoint」，
 * 后者是「曾经写过但读不回来了」。两者混为一谈会让损坏的会话被当成全新会话静默接管。
 */
export type CheckpointRecoveryRead =
  | { readonly kind: 'recovered'; readonly state: CoordinatorSessionState }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unrecoverable'; readonly reason: string };

export type CheckpointRecoveryPort = {
  readonly loadCheckpoint: (coordinatorSessionId: CoordinatorSessionId) => CheckpointRecoveryRead;
};

export type CheckpointWriteResult =
  | { readonly kind: 'saved' }
  | { readonly kind: 'failed'; readonly message: string };

/** 一次普通用户消息的持久提交（IC-04 的 checkpoint 侧 seam）。 */
export type UserMessageCommitInput = {
  readonly coordinatorSessionId: CoordinatorSessionId;
  readonly submissionId: string;
  readonly content: string;
  /** 与消息同事务写入的 Wake Batch：内容与准入身份因此不可能是两条独立事实。 */
  readonly wakeBatch: WakeBatch;
};

/**
 * 用户消息的提交结果。
 *
 * `already-committed` 覆盖稳定重放：同 `submissionId` 再提交一次不会产生第二条消息，`contentMatches`
 * 说明这次提交的内容是否与原内容逐字相同；内容不同必须由调用方按拒绝处理，而不是静默改写历史。
 */
export type UserMessageCommitResult =
  | { readonly kind: 'committed'; readonly state: CoordinatorSessionState }
  | {
      readonly kind: 'already-committed';
      readonly state: CoordinatorSessionState;
      readonly contentMatches: boolean;
    }
  | { readonly kind: 'unrecoverable'; readonly reason: string };

export type UserMessageCommitPort = {
  readonly commitUserMessage: (input: UserMessageCommitInput) => UserMessageCommitResult;
};

/**
 * 图节点需要的会话记录读写 seam。
 *
 * 声明在 Application 层，让 Workflow 只依赖这个 port 而不依赖具体 storage adapter；storage
 * adapter 以结构相容的方式实现它，两边都不需要互相 import。
 */
export type CoordinatorSessionRecordPort = CheckpointRecoveryPort &
  UserMessageCommitPort & {
    readonly saveCheckpoint: (state: CoordinatorSessionState) => CheckpointWriteResult;
    /** 读回底层完整已提交消息条目；Capsule 是派生视图，不覆盖它们。 */
    readonly readCommittedMessages: (coordinatorSessionId: CoordinatorSessionId) => readonly unknown[];
  };

export type ResumeIncarnationRequest = IncarnationRequest & {
  readonly checkpoints: CheckpointRecoveryPort;
};

export type ResumeIncarnationResult =
  | {
      readonly kind: 'resumed';
      readonly incarnation: CoordinatorIncarnation;
      readonly lease: LeaseRecord;
      readonly previousGeneration: number | null;
      /** `false` 表示该 Session 首次启动，此时 `sessionState` 为 `null`。 */
      readonly recovered: boolean;
      readonly sessionState: CoordinatorSessionState | null;
      readonly unresolvedIntents: readonly OperationIntent[];
    }
  | { readonly kind: 'held'; readonly lease: LeaseRecord }
  | {
      readonly kind: 'blocked';
      readonly coordinatorSessionId: CoordinatorSessionId;
      readonly reason: string;
      readonly error: CheckpointUnrecoverableError;
    }
  | { readonly kind: 'rejected'; readonly rejection: CoordinationCommandRejection };

/**
 * 现有 Session 的 checkpoint 不可恢复。
 *
 * 这是一个终态阻塞信号，不是可重试错误：调用方必须停下并报告，而不是换一个身份继续。
 */
export class CheckpointUnrecoverableError extends Error {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly coordinatorSessionId: CoordinatorSessionId;
  readonly reason: string;

  constructor(input: {
    readonly coordinationScopeId: CoordinationScopeId;
    readonly coordinatorSessionId: CoordinatorSessionId;
    readonly reason: string;
  }) {
    super(
      `Coordinator Session ${input.coordinatorSessionId} 的 checkpoint 不可恢复：${input.reason}`,
    );
    this.name = 'CheckpointUnrecoverableError';
    this.coordinationScopeId = input.coordinationScopeId;
    this.coordinatorSessionId = input.coordinatorSessionId;
    this.reason = input.reason;
  }
}

function incarnationOf(
  request: IncarnationRequest,
  fencingGeneration: number,
): CoordinatorIncarnation {
  return {
    coordinationScopeId: request.coordinationScopeId,
    coordinatorSessionId: request.coordinatorSessionId,
    runtimeIncarnationId: request.runtimeIncarnationId,
    fencingGeneration,
  };
}

/** 把 incarnation 翻译成 store 的写入者前导；generation 始终取自当前 lease，不缓存。 */
export function writerFor(incarnation: CoordinatorIncarnation): CoordinationWriter {
  return {
    coordinatorSessionId: incarnation.coordinatorSessionId,
    runtimeIncarnationId: incarnation.runtimeIncarnationId,
    fencingGeneration: incarnation.fencingGeneration,
  };
}

/**
 * 取得一个 Session 的 Runtime Lease。
 *
 * `held` 是「同一 Session 已有存活 incarnation」的显式拒绝，调用方不得继续执行任何写操作。
 */
export function acquireIncarnation(
  store: BranchCoordinationStore,
  request: IncarnationRequest,
): AcquireIncarnationResult {
  const result = acquireRuntimeLease(store, {
    coordinationScopeId: request.coordinationScopeId,
    coordinatorSessionId: request.coordinatorSessionId,
    runtimeIncarnationId: request.runtimeIncarnationId,
    fencingGeneration: 0,
    ttlMs: request.ttlMs ?? DEFAULT_RUNTIME_LEASE_TTL_MS,
  });
  if (result.kind === 'held') {
    return { kind: 'held', lease: result.lease };
  }
  if (result.kind === 'rejected') {
    return { kind: 'rejected', rejection: result.rejection };
  }
  return {
    kind: 'acquired',
    incarnation: incarnationOf(request, result.lease.fencingGeneration),
    lease: result.lease,
    previousGeneration: result.previousGeneration,
  };
}

/**
 * 写 checkpoint、执行维护动作或发起任何副作用之前的唯一准入判据。
 *
 * 每次都回读 lease：generation 与 incarnation 身份都只以 store 的当前行为准，
 * 任何本地缓存都会让被 fence 的进程以为自己仍然有效。
 */
export function assertFencingGeneration(
  store: BranchCoordinationStore,
  incarnation: CoordinatorIncarnation,
  options: { readonly clock?: () => number } = {},
): FencingAssertion {
  const clock = options.clock ?? (() => Date.now());
  const leases = store.query({
    kind: 'leases',
    coordinationScopeId: incarnation.coordinationScopeId,
  });
  if (leases.kind !== 'leases') {
    // 读不到租约事实就不能证明自己仍有权写入；按已被取代处理，不猜测。
    return { kind: 'fenced', code: 'other_incarnation' };
  }
  const lease =
    leases.leases.find(
      (candidate) =>
        candidate.kind === 'runtime' &&
        candidate.coordinatorSessionId === incarnation.coordinatorSessionId,
    ) ?? null;
  if (lease === null) {
    return { kind: 'fenced', code: 'released_lease' };
  }
  const violation = findFenceViolation(
    lease,
    {
      runtimeIncarnationId: incarnation.runtimeIncarnationId,
      fencingGeneration: incarnation.fencingGeneration,
    },
    clock(),
  );
  return violation === undefined ? { kind: 'valid', lease } : { kind: 'fenced', code: violation.code };
}

function readUnresolvedIntents(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
): readonly OperationIntent[] {
  const pending = store.query({ kind: 'intents', coordinationScopeId, intentState: 'pending' });
  const blocked = store.query({ kind: 'intents', coordinationScopeId, intentState: 'blocked' });
  const intents: OperationIntent[] = [];
  if (pending.kind === 'intents') {
    intents.push(...pending.intents);
  }
  if (blocked.kind === 'intents') {
    intents.push(...blocked.intents);
  }
  return intents;
}

/**
 * 以同一身份恢复一个 Session 的 Runtime Incarnation。
 *
 * 顺序固定：取得 Runtime Lease（被 fence 或已被占用即拒绝）→ 读回 checkpoint（不可恢复即阻塞）
 * → 读回未决 Operation Intent 供上层投影 Actionable Work。全程不写协调状态、不转移任何所有权。
 */
export function resumeIncarnation(
  store: BranchCoordinationStore,
  request: ResumeIncarnationRequest,
): ResumeIncarnationResult {
  const acquired = acquireIncarnation(store, request);
  if (acquired.kind === 'held') {
    return { kind: 'held', lease: acquired.lease };
  }
  if (acquired.kind === 'rejected') {
    return { kind: 'rejected', rejection: acquired.rejection };
  }

  const read = request.checkpoints.loadCheckpoint(request.coordinatorSessionId);
  const block = (reason: string): ResumeIncarnationResult => ({
    kind: 'blocked',
    coordinatorSessionId: request.coordinatorSessionId,
    reason,
    error: new CheckpointUnrecoverableError({
      coordinationScopeId: request.coordinationScopeId,
      coordinatorSessionId: request.coordinatorSessionId,
      reason,
    }),
  });

  if (read.kind === 'unrecoverable') {
    return block(read.reason);
  }

  if (read.kind === 'absent') {
    // 该 Session 已经取过 Runtime Lease 却读不到 checkpoint：曾经运行过，但没有可恢复的历史。
    if (acquired.previousGeneration !== null) {
      return block('该 Session 曾经运行过，但 checkpoint 无法读回');
    }
    return {
      kind: 'resumed',
      incarnation: acquired.incarnation,
      lease: acquired.lease,
      previousGeneration: acquired.previousGeneration,
      recovered: false,
      sessionState: null,
      unresolvedIntents: readUnresolvedIntents(store, request.coordinationScopeId),
    };
  }

  if (read.state.coordinatorSessionId !== request.coordinatorSessionId) {
    return block(
      `checkpoint 属于 ${read.state.coordinatorSessionId}，与请求的 ${request.coordinatorSessionId} 不一致`,
    );
  }

  return {
    kind: 'resumed',
    incarnation: acquired.incarnation,
    lease: acquired.lease,
    previousGeneration: acquired.previousGeneration,
    recovered: true,
    sessionState: read.state,
    unresolvedIntents: readUnresolvedIntents(store, request.coordinationScopeId),
  };
}
