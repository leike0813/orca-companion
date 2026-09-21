/**
 * IP-1 / D2：启动与崩溃恢复期的 Operation Intent 对账（Owner: `m1-recover-execution`）。
 *
 * 这个用例回答一个固定问题：Scope 里还有哪些副作用意图没有确定结论，以及每个意图现在应当被收尾
 * 还是保持阻塞。它只做编排，不定义三值语义——三值归类在 `src/domain/recovery/operation-intent.ts`，
 * 意图生命周期在既有 `intent-service.ts`。
 *
 * 固定规则：
 * - 逐个以**原 OperationId 与原 OperationRef** 调用前驱既有 `reconcileOperation`，绝不更换 OperationId
 *   重试；intent 没有 `backendRequestId` 时由 `reconcileOperation` 直接判为 `no_backend_request_id`；
 * - `settled` → `accepted`，用既有 lane 服务按确定结果收尾（`blocked` 用 `resolveLane`，`pending` 用
 *   `settleIntent`：store 的状态机只允许前者收尾阻塞意图、后者收尾未决意图）；
 * - 其余 → `unknown`，把阻塞原因**持久化**到该 intent（`blockLane`），使阻塞可观测而不是静默挂起；
 * - `rejected` 只来自调用方显式提供的已证实事实，自动对账路径不会产出它；
 * - 重复执行同一批对账结果稳定：已经收尾或已经阻塞的意图不再产生第二次写入。
 *
 * 启动顺序中的位置（由后续 IP-12 在 bootstrap 接线）：本用例在取得 Runtime Lease 之后、重放未确认
 * Delivery 与允许派发之前调用。返回值里 `unresolvedLaneKeys` 就是「哪些 lane 仍不可派发」的答案。
 */

import {
  concludeFromProvenNoSideEffect,
  concludeReconciliation,
  UNRESOLVED_INTENT_STATES,
  type ProvenNoSideEffect,
  type ReconciliationConclusion,
} from '../../domain/recovery/operation-intent.js';
import { blockLane, resolveLane, settleIntent } from '../coordination/intent-service.js';
import type { CoordinationScopeId, OperationId, Revision } from '../dto/identity.js';
import type { OperationIntent } from '../dto/operation-intent.js';
import type { OperationOutcome, OperationRef } from '../dto/operation-outcome.js';
import type {
  BranchCoordinationStore,
  CoordinationCommandRejection,
  CoordinationQueryResult,
  CoordinationWriter,
} from '../ports/branch-coordination-store.js';
import { reconcileOperation, type ExecutionBackend } from '../ports/execution-backend.js';
import { readScope } from '../planning/scope-read.js';
import { readIntentRecord, writeWithRevisionRetry, type LaneWriteOutcome } from './lane-write.js';

export type ReconcileOperationsInput = {
  readonly store: BranchCoordinationStore;
  readonly backend: ExecutionBackend;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly writer: CoordinationWriter;
  /** 调用方读到 Scope 时的 revision；作为第一次 CAS 写入的基准，冲突时重读后只重试一次。 */
  readonly expectedRevision: Revision;
  readonly clock: () => number;
  /** 调用方已证实的「未产生副作用」事实，只覆盖列出的 OperationId。 */
  readonly provenNoSideEffect?: readonly ProvenNoSideEffect[];
};

/** 单个意图的对账结果；`intent` 是写入后回读的持久事实。 */
export type ReconciledOperation = {
  readonly operationId: OperationId;
  readonly laneKey: string;
  readonly previousState: OperationIntent['state'];
  readonly conclusion: ReconciliationConclusion;
  readonly storeChanged: boolean;
  readonly rejection: CoordinationCommandRejection | null;
  readonly intent: OperationIntent | null;
};

export type ReconcileOperationsResult =
  | {
      readonly kind: 'reconciled';
      readonly observedAt: number;
      readonly revision: Revision;
      readonly operations: readonly ReconciledOperation[];
      /** 对账后仍为 pending / blocked 的意图：这些 lane 依旧不可派发。 */
      readonly unresolved: readonly OperationIntent[];
      readonly unresolvedLaneKeys: readonly string[];
    }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string };

type IntentsRead =
  | { readonly kind: 'read'; readonly intents: readonly OperationIntent[] }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string };

function compareIntents(left: OperationIntent, right: OperationIntent): number {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt - right.createdAt;
  }
  return left.operationId < right.operationId ? -1 : left.operationId > right.operationId ? 1 : 0;
}

/** 按状态读取全部未决意图并稳定排序；重复 OperationId 只保留一条（store 主键本应保证唯一）。 */
function readUnresolvedIntents(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
): IntentsRead {
  const collected = new Map<string, OperationIntent>();
  for (const state of UNRESOLVED_INTENT_STATES) {
    const result: CoordinationQueryResult = store.query({
      kind: 'intents',
      coordinationScopeId,
      intentState: state,
    });
    if (result.kind === 'rejected') {
      return { kind: 'rejected', code: result.code, message: result.message };
    }
    if (result.kind !== 'intents') {
      return { kind: 'rejected', code: 'invalid_state', message: 'intents 查询返回了错误的结果种类' };
    }
    for (const intent of result.intents) {
      if (!collected.has(intent.operationId)) {
        collected.set(intent.operationId, intent);
      }
    }
  }
  return { kind: 'read', intents: [...collected.values()].sort(compareIntents) };
}

/**
 * 对账引用的唯一构造点。
 *
 * 没有 `backendRequestId` 时不臆造凭据：`reconcileOperation` 会把这种情况直接判为
 * `no_backend_request_id`，从而既不发请求也不改变 OperationId。
 */
function operationRefOf(intent: OperationIntent): OperationRef {
  return {
    operationId: intent.operationId,
    ...(intent.backendRequestId === null ? {} : { backendRequestId: intent.backendRequestId }),
    target: intent.target,
  };
}

function acceptedOutcome(intent: OperationIntent, statement: string): OperationOutcome<unknown> {
  return { kind: 'accepted', operation: operationRefOf(intent), value: { statement } };
}

function blockingReason(conclusion: Extract<ReconciliationConclusion, { kind: 'unknown' }>): string {
  return `对账未决(${conclusion.reason})：OperationId ${conclusion.operationId} 的副作用是否发生无法证明`;
}

type ApplyResult = {
  readonly storeChanged: boolean;
  readonly rejection: CoordinationCommandRejection | null;
  readonly revision: Revision;
};

/**
 * 把结论落到 store。
 *
 * 只写「状态还没到位」的情况：未决意图拿到确定结论要收尾，未决意图仍不能判定要阻塞；已经收尾或已经
 * 阻塞的意图不再写第二次，因此重复对账不会推进 revision 之外的状态。
 */
function applyConclusion(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
  writer: CoordinationWriter,
  intent: OperationIntent,
  conclusion: ReconciliationConclusion,
  baseRevision: Revision,
): ApplyResult {
  const needsWrite =
    conclusion.kind === 'unknown' ? intent.state === 'pending' : true;
  if (!needsWrite) {
    return { storeChanged: false, rejection: null, revision: baseRevision };
  }

  const call = (expectedRevision: Revision): LaneWriteOutcome => {
    if (conclusion.kind === 'unknown') {
      return blockLane(store, {
        coordinationScopeId,
        operationId: intent.operationId,
        writer,
        expectedRevision,
        reason: blockingReason(conclusion),
      });
    }
    if (intent.state === 'blocked') {
      return resolveLane(store, {
        coordinationScopeId,
        operationId: intent.operationId,
        writer,
        expectedRevision,
        outcomeClass: conclusion.kind,
        ...(conclusion.kind === 'accepted' && intent.backendRequestId !== null
          ? { backendRequestId: intent.backendRequestId }
          : {}),
      });
    }
    return settleIntent(store, {
      coordinationScopeId,
      operationId: intent.operationId,
      writer,
      expectedRevision,
      outcome:
        conclusion.kind === 'accepted'
          ? acceptedOutcome(intent, conclusion.statement)
          : { kind: 'rejected', code: conclusion.code, message: conclusion.message },
    });
  };

  const written = writeWithRevisionRetry(store, coordinationScopeId, baseRevision, call);
  if (written.outcome.kind === 'rejected') {
    return { storeChanged: false, rejection: written.outcome.rejection, revision: baseRevision };
  }
  return { storeChanged: true, rejection: null, revision: written.revision };
}

/**
 * 对账一个 Scope 的全部未决 Operation Intent。
 *
 * 调用方提供 Scope、writer、初始 revision 与时钟；用例自身不生成 OperationId、不读时钟以外的环境、
 * 不发起任何 mutation。返回结构让 bootstrap 能直接判断「是否允许派发」。
 */
export async function reconcileOperations(
  input: ReconcileOperationsInput,
): Promise<ReconcileOperationsResult> {
  const initial = readUnresolvedIntents(input.store, input.coordinationScopeId);
  if (initial.kind === 'rejected') {
    return { kind: 'rejected', code: initial.code, message: initial.message };
  }
  const provenFacts = input.provenNoSideEffect ?? [];
  const operations: ReconciledOperation[] = [];
  let revision = input.expectedRevision;

  for (const intent of initial.intents) {
    const proven = provenFacts.find((fact) => fact.operationId === intent.operationId);
    let conclusion: ReconciliationConclusion;
    if (proven === undefined) {
      const reconciled = await reconcileOperation(input.backend, operationRefOf(intent));
      conclusion = concludeReconciliation(intent, reconciled);
    } else {
      // 用户补充的已证实事实优先于只读对账：不再为已经可判定的 lane 发无意义的查询。
      conclusion = concludeFromProvenNoSideEffect(intent, proven);
    }

    const applied = applyConclusion(
      input.store,
      input.coordinationScopeId,
      input.writer,
      intent,
      conclusion,
      revision,
    );
    revision = applied.revision;
    operations.push({
      operationId: intent.operationId,
      laneKey: intent.laneKey,
      previousState: intent.state,
      conclusion,
      storeChanged: applied.storeChanged,
      rejection: applied.rejection,
      intent: readIntentRecord(input.store, input.coordinationScopeId, intent.operationId),
    });
  }

  const remaining = readUnresolvedIntents(input.store, input.coordinationScopeId);
  if (remaining.kind === 'rejected') {
    return { kind: 'rejected', code: remaining.code, message: remaining.message };
  }
  const current = readScope(input.store, input.coordinationScopeId);
  const finalRevision = current.kind === 'rejected' ? revision : current.scope.revision;
  return {
    kind: 'reconciled',
    observedAt: input.clock(),
    revision: finalRevision,
    operations,
    unresolved: remaining.intents,
    unresolvedLaneKeys: [...new Set(remaining.intents.map((intent) => intent.laneKey))],
  };
}
