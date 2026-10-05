/**
 * IP-4 / D4：启动与崩溃恢复期的 Delivery 重放（Owner: `m1-recover-execution`）。
 *
 * 前驱 `src/application/delivery/process-delivery.ts` 的 `settleDelivery` 是正常 Delivery 结算的
 * **唯一**流水线（FLOW-03：read without ack → 身份/代际核验 → 去重 → Orca 记录并回读 → 本地引用
 * 落盘并回读 → 最后 ack）。本模块只做恢复期编排，绝不复制读取、去重、Accepted Worker Result 记录或
 * ack 顺序，也不新增 pipeline、去重类型或 Delivery 持久化字段：
 *
 * - 调用方（bootstrap）先用 `delivery-read` 读出尚未确认的 Delivery，并从 Orca/store 装配可信事实；
 * - 本用例逐条交给 `settleDelivery`（默认实现；测试可注入 spy 计数，确认没有第二套结算路径）；
 * - 流水线返回 `unknown` 时保持 Delivery 未确认，并确保对应 mutation lane 以**原 OperationId**
 *   持久化为阻塞；
 * - 来自旧 consumer generation、旧 Attempt 或已冻结代际的 Delivery 由流水线判为 `history_only`，
 *   这里不给它任何推进当前生命周期、重启模型或消耗共享预算的路径。
 *
 * 「原 OperationId」在这里是强保证而不是调用方口头约定：只要该 lane 上还存在未决 intent，就用它
 * 已持久化的 `operationId` 覆盖调用方传入的候选 ID，因此重放永远不会为同一 lane 造出第二个 ID。
 *
 * 启动顺序中的位置（由后续 IP-12 在 bootstrap 接线，本模块不自行接线）：
 * 1. 加载配置与 Scope、取得 Runtime Lease；
 * 2. `reconcileOperations` 先以原 OperationId 收尾全部未决 intent；
 * 3. 调用本用例重放未确认 Delivery；
 * 4. 投影 lane 阻塞，只有无阻塞影响所需 lane 时才允许派发与模型恢复。
 */

import { isUnresolvedIntentState } from '../../domain/recovery/operation-intent.js';
import { blockLane } from '../coordination/intent-service.js';
import {
  ackConsumedDelivery,
  acceptResultLaneKey,
  ackLaneKey,
  settleDelivery,
  type ConsumedDeliveryResult,
  type SettleDeliveryInput,
  type SettleDeliveryResult,
} from '../delivery/process-delivery.js';
import type { CoordinationScopeId, OperationId } from '../dto/identity.js';
import { type OperationIntent } from '../dto/operation-intent.js';
import type {
  BranchCoordinationStore,
  CoordinationWriter,
} from '../ports/branch-coordination-store.js';
import type { ExecutionBackend } from '../ports/execution-backend.js';
import {
  currentScopeRevision,
  readIntentRecord,
  writeWithRevisionRetry,
  type LaneWriteOutcome,
} from './lane-write.js';

/**
 * 一条待重放的未确认 Delivery。
 *
 * `operationIds` 只是「该 lane 此前从未登记过 intent」时的稳定候选；lane 上已有未决 intent 时以
 * store 中的原 ID 为准。
 */
export type PendingDelivery = {
  readonly delivery: SettleDeliveryInput['delivery'];
  readonly trusted: SettleDeliveryInput['trusted'];
  readonly orcaTaskId: string;
  readonly operationIds: SettleDeliveryInput['operationIds'];
};

export type ReplayDeliveriesInput = {
  readonly store: BranchCoordinationStore;
  readonly backend: ExecutionBackend;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly writer: CoordinationWriter;
  readonly backendIdentityRef: string;
  readonly graphGeneration: number;
  readonly authorizationId: string;
  readonly runId: string;
  readonly consumerGeneration: number;
  readonly timeoutMs: number;
  readonly pending: readonly PendingDelivery[];
  /** 前驱唯一 pipeline；默认 `settleDelivery`，注入只用于测试计数与故障注入。 */
  readonly settle?: (input: SettleDeliveryInput) => Promise<SettleDeliveryResult>;
};

export type ReplayDeliveryOutcome = {
  readonly deliveryId: string;
  readonly kind: SettleDeliveryResult['kind'];
  /** 流水线确认了该 Delivery（`settled` / `replayed` / `history_only`）。 */
  readonly confirmed: boolean;
  readonly laneKey: string | null;
  readonly operationId: OperationId | null;
  readonly blockingReason: string | null;
  /** 本用例自己写入 store（确保 lane 阻塞）时为 true；流水线内部的写入不在此列。 */
  readonly storeChanged: boolean;
};

export type ReplayDeliveriesResult =
  | {
      readonly kind: 'replayed';
      readonly outcomes: readonly ReplayDeliveryOutcome[];
      /** 仍未确认的 Delivery；不得对其做任何「已结算」推断。 */
      readonly unconfirmed: readonly string[];
      /** 仍然不可派发的 mutation lane（去重后）。 */
      readonly blockedLaneKeys: readonly string[];
    }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string };

/**
 * accept / ack 两条 lane 的键由 pipeline 自己给出（`process-delivery.ts` 导出的
 * `acceptResultLaneKey` / `ackLaneKey`）；本模块不重建 target 映射。
 */
function unresolvedIntentOnLane(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
  laneKey: string,
): OperationIntent | null {
  const result = store.query({ kind: 'intents', coordinationScopeId });
  if (result.kind !== 'intents') {
    return null;
  }
  return (
    result.intents.find(
      (intent) => intent.laneKey === laneKey && isUnresolvedIntentState(intent.state),
    ) ?? null
  );
}

/**
 * 解析本次重放应当使用的 OperationId。
 *
 * lane 键的构造者是 pipeline 自己（`acceptResultLaneKey` / `ackLaneKey`），这里只消费它，不重建
 * target 映射：lane 上只要还有未决 intent，就必须沿用它的 `operationId`，恢复重放不得为同一 lane
 * 换 ID。
 */
function originalOperationIds(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
  pending: PendingDelivery,
): SettleDeliveryInput['operationIds'] {
  const acceptLane = acceptResultLaneKey(pending.orcaTaskId);
  const ackLane = ackLaneKey(pending.delivery.deliveryId);
  return {
    acceptResult:
      unresolvedIntentOnLane(store, coordinationScopeId, acceptLane)?.operationId ??
      pending.operationIds.acceptResult,
    ack:
      unresolvedIntentOnLane(store, coordinationScopeId, ackLane)?.operationId ?? pending.operationIds.ack,
  };
}

type EnsureBlockedResult = {
  readonly laneKey: string | null;
  readonly blockingReason: string | null;
  readonly storeChanged: boolean;
};

/**
 * 确保某条 lane 以原 OperationId 持久化为阻塞。
 *
 * 流水线在 `unknown` 时已经写过 `blockLane`；这里只处理它尚未写的情况（例如注入的 pipeline），因此
 * 重复重放同一批结果是幂等的：已经阻塞的 intent 不再产生第二次写入。
 */
function ensureLaneBlocked(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
  writer: CoordinationWriter,
  operationId: OperationId,
  reason: string,
): EnsureBlockedResult {
  const intent = readIntentRecord(store, coordinationScopeId, operationId);
  if (intent === null || intent.state !== 'pending') {
    // 没有意图就无法在不臆造身份的前提下写阻塞；已经阻塞或已收尾的意图不再写第二次。
    return { laneKey: intent?.laneKey ?? null, blockingReason: intent?.blockingReason ?? null, storeChanged: false };
  }
  const base = currentScopeRevision(store, coordinationScopeId);
  if (base === null) {
    return { laneKey: intent.laneKey, blockingReason: null, storeChanged: false };
  }
  const persistedReason = `Delivery 重放未决：${reason}`;
  const written = writeWithRevisionRetry(store, coordinationScopeId, base, (expectedRevision): LaneWriteOutcome =>
    blockLane(store, {
      coordinationScopeId,
      operationId,
      writer,
      expectedRevision,
      reason: persistedReason,
    }),
  );
  const after = readIntentRecord(store, coordinationScopeId, operationId);
  return {
    laneKey: intent.laneKey,
    blockingReason: after?.blockingReason ?? persistedReason,
    storeChanged: written.outcome.kind !== 'rejected',
  };
}

/**
 * 重放启动时读到的全部未确认 Delivery。
 *
 * 不读时钟、不生成 OperationId、不新增结算路径：每条 Delivery 恰好一次进入前驱 pipeline。
 */
export async function replayDeliveries(input: ReplayDeliveriesInput): Promise<ReplayDeliveriesResult> {
  const settle = input.settle ?? settleDelivery;
  const outcomes: ReplayDeliveryOutcome[] = [];
  /**
   * 每个 deliveryId 一组：阶段 1 逐条 deferAck 结算并收集已核验消费；阶段 2 按 deliveryId 统一确认
   * 整批。ack 的批次守卫要求批次内每条结果都已持久消费，因此「最后一条结算完成后才整批 ack」，同批
   * 两条 stale 也不会互相等待——两条都在本轮的 consumed 里。
   */
  const batches = new Map<
    string,
    {
      readonly anchor: PendingDelivery;
      readonly consumed: ConsumedDeliveryResult[];
      readonly outcomeIndexes: number[];
    }
  >();

  for (const pending of input.pending) {
    const expectedRevision = currentScopeRevision(input.store, input.coordinationScopeId);
    if (expectedRevision === null) {
      return {
        kind: 'rejected',
        code: 'invalid_state',
        message: `Scope ${input.coordinationScopeId} 不存在或不可读，无法重放 Delivery`,
      };
    }
    const operationIds = originalOperationIds(input.store, input.coordinationScopeId, pending);
    const result = await settle({
      store: input.store,
      backend: input.backend,
      coordinationScopeId: input.coordinationScopeId,
      writer: input.writer,
      expectedRevision,
      backendIdentityRef: input.backendIdentityRef,
      graphGeneration: input.graphGeneration,
      authorizationId: input.authorizationId,
      runId: input.runId,
      consumerGeneration: input.consumerGeneration,
      timeoutMs: input.timeoutMs,
      orcaTaskId: pending.orcaTaskId,
      delivery: pending.delivery,
      trusted: pending.trusted,
      operationIds,
      deferAck: true,
    });

    if (result.kind === 'unknown') {
      const ensured = ensureLaneBlocked(
        input.store,
        input.coordinationScopeId,
        input.writer,
        result.operationId,
        result.reason,
      );
      outcomes.push({
        deliveryId: pending.delivery.deliveryId,
        kind: result.kind,
        confirmed: false,
        laneKey: ensured.laneKey,
        operationId: result.operationId,
        blockingReason: ensured.blockingReason,
        storeChanged: ensured.storeChanged,
      });
      continue;
    }

    if (result.kind === 'blocked') {
      outcomes.push({
        deliveryId: pending.delivery.deliveryId,
        kind: result.kind,
        confirmed: false,
        laneKey: result.laneKey,
        operationId: null,
        blockingReason: result.reason,
        storeChanged: false,
      });
      continue;
    }

    if (result.kind === 'settled' || result.kind === 'replayed' || result.kind === 'history_only') {
      const outcomeIndex = outcomes.length;
      outcomes.push({
        deliveryId: pending.delivery.deliveryId,
        kind: result.kind,
        // 阶段 1 不确认：确认是否成功由阶段 2 的整批 ack 决定。
        confirmed: false,
        laneKey: null,
        operationId: null,
        blockingReason: null,
        storeChanged: false,
      });
      const group = batches.get(pending.delivery.deliveryId) ?? {
        anchor: pending,
        consumed: [],
        outcomeIndexes: [],
      };
      group.consumed.push({
        orcaTaskId: pending.orcaTaskId,
        workerTaskId: pending.trusted.workerTaskId,
        attemptId: pending.trusted.attemptId,
        dispatchId: pending.trusted.dispatchId,
      });
      group.outcomeIndexes.push(outcomeIndex);
      batches.set(pending.delivery.deliveryId, group);
      continue;
    }

    outcomes.push({
      deliveryId: pending.delivery.deliveryId,
      kind: result.kind,
      confirmed: false,
      laneKey: null,
      operationId: null,
      blockingReason: result.failure.message,
      storeChanged: false,
    });
  }

  // 阶段 2：每个批次恰好确认一次，传入本轮已核验消费的结果；批次守卫要求其余消息都有持久证据。
  for (const [deliveryId, group] of batches) {
    const ackOperationId = originalOperationIds(input.store, input.coordinationScopeId, group.anchor).ack;
    const ack = await ackConsumedDelivery({
      store: input.store,
      backend: input.backend,
      writer: input.writer,
      coordinationScopeId: input.coordinationScopeId,
      backendIdentityRef: input.backendIdentityRef,
      graphGeneration: input.graphGeneration,
      authorizationId: input.authorizationId,
      runId: input.runId,
      consumerGeneration: input.consumerGeneration,
      timeoutMs: input.timeoutMs,
      deliveryId,
      deliveryRunId: input.runId,
      operationId: ackOperationId,
      consumed: group.consumed,
    });
    for (const outcomeIndex of group.outcomeIndexes) {
      const outcome = outcomes[outcomeIndex];
      if (outcome === undefined) {
        continue;
      }
      outcomes[outcomeIndex] =
        ack.kind === 'acked'
          ? { ...outcome, confirmed: true }
          : {
              ...outcome,
              confirmed: false,
              laneKey: ack.laneKey,
              blockingReason: `批次整批确认未完成：${ack.message}`,
            };
    }
  }

  return {
    kind: 'replayed',
    outcomes,
    unconfirmed: outcomes.filter((outcome) => !outcome.confirmed).map((outcome) => outcome.deliveryId),
    blockedLaneKeys: [
      ...new Set(
        outcomes.flatMap((outcome) =>
          outcome.confirmed || outcome.laneKey === null ? [] : [outcome.laneKey],
        ),
      ),
    ],
  };
}
