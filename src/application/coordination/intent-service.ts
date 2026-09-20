/**
 * IC-03 与 FLOW-01 的意图用例（Owner: `m1-persist-coordination-state`）。
 *
 * 这个模块只做一件事：把「副作用意图」的生命周期映射到 store 的闭合写入通道。
 * 它不生成 stub 结果、不把 `unknown` 当作失败、不换 OperationId 重试，也不实现任何对账策略——
 * 对账由具体用例决定，这里只保证未决意图保留在原地并阻塞相关 mutation lane。
 */

import { laneKeyOf, type OperationIntent, type IntentOutcomeClass } from '../dto/operation-intent.js';
import type { OperationOutcome } from '../dto/operation-outcome.js';
import type {
  CoordinationScopeId,
  EntityRef,
  OperationId,
  Revision,
} from '../dto/identity.js';
import type {
  BranchCoordinationStore,
  CoordinationCommandRejection,
  CoordinationWriter,
} from '../ports/branch-coordination-store.js';

export type BeginIntentRequest = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly operationId: OperationId;
  readonly target: EntityRef<string>;
  readonly operationCategory: string;
  readonly expectedHead?: string;
  readonly writer: CoordinationWriter;
  readonly expectedRevision: Revision;
};

export type BeginIntentResult =
  | { readonly kind: 'registered'; readonly intent: OperationIntent; readonly revision: number }
  | { readonly kind: 'existing'; readonly intent: OperationIntent }
  | { readonly kind: 'lane_blocked'; readonly laneKey: string; readonly blockingIntent: OperationIntent }
  | { readonly kind: 'lane_busy'; readonly laneKey: string; readonly activeIntent: OperationIntent }
  | { readonly kind: 'rejected'; readonly rejection: CoordinationCommandRejection };

export type SettleIntentRequest = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly operationId: OperationId;
  readonly writer: CoordinationWriter;
  readonly expectedRevision: Revision;
  readonly outcome: OperationOutcome<unknown>;
};

export type SettleIntentResult =
  | {
      readonly kind: 'settled';
      readonly outcomeClass: IntentOutcomeClass;
      readonly intent: OperationIntent;
      readonly revision: number;
    }
  | { readonly kind: 'retained'; readonly intent: OperationIntent; readonly revision: number }
  | { readonly kind: 'rejected'; readonly rejection: CoordinationCommandRejection };

export type BlockIntentRequest = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly operationId: OperationId;
  readonly writer: CoordinationWriter;
  readonly expectedRevision: Revision;
  readonly reason: string;
};

export type ResolveIntentRequest = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly operationId: OperationId;
  readonly writer: CoordinationWriter;
  readonly expectedRevision: Revision;
  readonly outcomeClass: IntentOutcomeClass;
  readonly backendRequestId?: string;
};

export type LaneResult =
  | { readonly kind: 'settled'; readonly intent: OperationIntent; readonly revision: number }
  | { readonly kind: 'rejected'; readonly rejection: CoordinationCommandRejection };

function readIntent(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
  operationId: OperationId,
): OperationIntent | null {
  const result = store.query({ kind: 'intent', coordinationScopeId, operationId });
  if (result.kind !== 'intent' || result.intent === null) {
    return null;
  }
  return result.intent;
}

function laneState(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
  laneKey: string,
): BeginIntentResult | null {
  for (const state of ['blocked', 'pending'] as const) {
    const result = store.query({ kind: 'intents', coordinationScopeId, intentState: state });
    if (result.kind !== 'intents') {
      continue;
    }
    const found = result.intents.find((intent) => intent.laneKey === laneKey);
    if (found === undefined) {
      continue;
    }
    return state === 'blocked'
      ? { kind: 'lane_blocked', laneKey, blockingIntent: found }
      : { kind: 'lane_busy', laneKey, activeIntent: found };
  }
  return null;
}

/**
 * 外部 mutation 之前登记意图。
 *
 * 重复 OperationId 是恢复重放，返回既有记录而不是创建第二条；lane 上已有未决或阻塞意图时
 * 拒绝该 lane 上的新变更，但其它 lane 不受影响。
 */
export function beginIntent(store: BranchCoordinationStore, request: BeginIntentRequest): BeginIntentResult {
  const existing = readIntent(store, request.coordinationScopeId, request.operationId);
  if (existing !== null) {
    if (
      existing.target.kind !== request.target.kind ||
      existing.target.id !== request.target.id ||
      existing.operationCategory !== request.operationCategory ||
      (request.expectedHead !== undefined && existing.expectedHead !== request.expectedHead)
    ) {
      return {
        kind: 'rejected',
        rejection: {
          kind: 'rejected',
          code: 'invalid_state',
          message: `OperationId ${request.operationId} 已绑定到不同的目标或前置条件`,
        },
      };
    }
    return { kind: 'existing', intent: existing };
  }
  const laneKey = laneKeyOf(request.target, request.operationCategory);

  const result = store.transact({
    kind: 'begin-intent',
    coordinationScopeId: request.coordinationScopeId,
    expectedRevision: request.expectedRevision,
    writer: request.writer,
    operationId: request.operationId,
    target: request.target,
    operationCategory: request.operationCategory,
    ...(request.expectedHead === undefined ? {} : { expectedHead: request.expectedHead }),
  });
  if (result.kind === 'rejected') {
    // 并发落在同一 lane 或同一 OperationId 上：以只读查询还原事实，不改用新 ID。
    const raced = readIntent(store, request.coordinationScopeId, request.operationId);
    if (raced !== null) {
      return { kind: 'existing', intent: raced };
    }
    const racedLane = laneState(store, request.coordinationScopeId, laneKey);
    if (racedLane !== null) {
      return racedLane;
    }
    return { kind: 'rejected', rejection: result };
  }

  const intent = readIntent(store, request.coordinationScopeId, request.operationId);
  if (intent === null) {
    return {
      kind: 'rejected',
      rejection: { kind: 'rejected', code: 'invalid_state', message: '意图写入后无法读回' },
    };
  }
  return { kind: 'registered', intent, revision: result.revision };
}

function backendRequestIdOf(outcome: OperationOutcome<unknown>): string | undefined {
  return outcome.kind === 'rejected' ? undefined : outcome.operation.backendRequestId;
}

/**
 * 按 IC-02 的三值结果收尾意图：`accepted` 与 `rejected` 收尾并记录分类，`unknown` 保留未决。
 * `rejected` 只在能证明未产生副作用时成立，因此不携带 backend request 引用。
 */
export function settleIntent(store: BranchCoordinationStore, request: SettleIntentRequest): SettleIntentResult {
  const current = readIntent(store, request.coordinationScopeId, request.operationId);
  if (current === null) {
    return {
      kind: 'rejected',
      rejection: { kind: 'rejected', code: 'invalid_state', message: '未找到待收尾的 Operation Intent' },
    };
  }
  if (
    request.outcome.kind !== 'rejected' &&
    (request.outcome.operation.operationId !== current.operationId ||
      request.outcome.operation.target.kind !== current.target.kind ||
      request.outcome.operation.target.id !== current.target.id)
  ) {
    return {
      kind: 'rejected',
      rejection: { kind: 'rejected', code: 'invalid_state', message: 'OperationOutcome 与待收尾 intent 不匹配' },
    };
  }
  const outcomeClass =
    request.outcome.kind === 'unknown' ? 'unknown' : request.outcome.kind === 'accepted' ? 'accepted' : 'rejected';
  const backendRequestId = backendRequestIdOf(request.outcome);
  const result = store.transact({
    kind: 'settle-intent',
    coordinationScopeId: request.coordinationScopeId,
    expectedRevision: request.expectedRevision,
    writer: request.writer,
    operationId: request.operationId,
    outcomeClass,
    ...(backendRequestId === undefined ? {} : { backendRequestId }),
  });
  if (result.kind === 'rejected') {
    return { kind: 'rejected', rejection: result };
  }
  const intent = readIntent(store, request.coordinationScopeId, request.operationId);
  if (intent === null) {
    return {
      kind: 'rejected',
      rejection: { kind: 'rejected', code: 'invalid_state', message: '意图收尾后无法读回' },
    };
  }
  if (outcomeClass === 'unknown') {
    return { kind: 'retained', intent, revision: result.revision };
  }
  return { kind: 'settled', outcomeClass, intent, revision: result.revision };
}

/**
 * 对账后仍无法判定副作用是否发生：把该意图标记为阻塞，lane 上的新变更随之中止。
 * 这里不做第二次对账，也不消耗任何预算。
 */
export function blockLane(store: BranchCoordinationStore, request: BlockIntentRequest): LaneResult {
  const result = store.transact({
    kind: 'block-intent',
    coordinationScopeId: request.coordinationScopeId,
    expectedRevision: request.expectedRevision,
    writer: request.writer,
    operationId: request.operationId,
    reason: request.reason,
  });
  return finishLane(store, request.coordinationScopeId, request.operationId, result);
}

/** 把阻塞的意图按对账结论收尾，从而解除该 lane 的阻塞。 */
export function resolveLane(store: BranchCoordinationStore, request: ResolveIntentRequest): LaneResult {
  const result = store.transact({
    kind: 'resolve-intent',
    coordinationScopeId: request.coordinationScopeId,
    expectedRevision: request.expectedRevision,
    writer: request.writer,
    operationId: request.operationId,
    outcomeClass: request.outcomeClass,
    ...(request.backendRequestId === undefined ? {} : { backendRequestId: request.backendRequestId }),
  });
  return finishLane(store, request.coordinationScopeId, request.operationId, result);
}

function finishLane(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
  operationId: OperationId,
  result: { readonly kind: 'committed'; readonly revision: number } | CoordinationCommandRejection,
): LaneResult {
  if (result.kind === 'rejected') {
    return { kind: 'rejected', rejection: result };
  }
  const intent = readIntent(store, coordinationScopeId, operationId);
  if (intent === null) {
    return {
      kind: 'rejected',
      rejection: { kind: 'rejected', code: 'invalid_state', message: 'lane 变更后无法读回意图' },
    };
  }
  return { kind: 'settled', intent, revision: result.revision };
}
