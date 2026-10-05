/**
 * FLOW-01 / IC-03：受控的 Worker question/message 答复（Owner: `m2-wire-execution-runtime`）。
 *
 * 答复是一条外部 mutation：它必须走「意图先落盘 → 一次稳定身份的 mutate → 收尾/对账」三步，
 * Validator 步骤许可与 Coordinator 的普通 question 答复共用同一条路径，不各自复制。
 *
 * 硬约束：
 * - 目标只接受精确 message 身份（`worker-message:<id>`）与调用方签发的 Run/generation/auth scope；
 * - 同一 OperationId 重放：已 settled 的意图直接返回既有结论，不重复副作用；
 * - `unknown` 用原 `OperationRef` 做一次 `request-show` 对账，仍不确定就阻塞该 lane，绝不换 ID 重试；
 * - 只有 `rejected` 才表示可证明未生效；Orca accepted 里的确定失败按 rejected 报告。
 */

import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  EntityRef,
  OperationId,
  Revision,
  RuntimeIncarnationId,
} from '../dto/identity.js';
import type { OperationRef } from '../dto/operation-outcome.js';
import { beginIntent, blockLane, resolveLane, settleIntent } from './intent-service.js';
import {
  buildExecutionScope,
  reconcileOperation,
  parseReplyReceipt,
  type ReplyReceipt,
  type ExecutionAuthority,
  type ExecutionBackend,
} from '../ports/execution-backend.js';
import type {
  BranchCoordinationStore,
  CoordinationWriter,
} from '../ports/branch-coordination-store.js';

/** 答复目标类别：与 target.id 一起构成 mutation lane 的粒度。 */
export const WORKER_REPLY_TARGET_KIND = 'worker-message';
export const WORKER_REPLY_OPERATION_CATEGORY = 'worker-reply';

/** 答复正文上限；超过即拒绝，避免把不确定的大载荷写进 mailbox。 */
export const MAX_REPLY_BODY_BYTES = 64 * 1024;

/** 答复某条消息的稳定 OperationId；同一消息同一动作重放派生同一个值。 */
export function replyOperationIdOf(messageId: string, discriminator = 'reply'): OperationId {
  return `worker-reply:${encodeURIComponent(messageId)}:${encodeURIComponent(discriminator)}` as OperationId;
}

export type ControlledReplyResult =
  | { readonly kind: 'accepted'; readonly receipt: ReplyReceipt | null; readonly replayed: boolean }
  /** 可证明未生效：本地拒绝、lane 竞争或 Orca 记录的确定失败。 */
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string }
  /** 结果不确定：lane 已按原身份阻塞；调用方须按 operation 对账，禁止换 ID 重试。 */
  | { readonly kind: 'unknown'; readonly operation: OperationRef; readonly reason: string }
  /** lane 上有未决/阻塞意图或状态不可读：不发起 mutation。 */
  | { readonly kind: 'blocked'; readonly reason: string };

export type ControlledReplyInput = {
  readonly store: BranchCoordinationStore;
  readonly backend: ExecutionBackend;
  readonly writer: CoordinationWriter;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly coordinatorSessionId: CoordinatorSessionId;
  readonly runtimeIncarnationId: RuntimeIncarnationId;
  readonly fencingGeneration: number;
  readonly authority: ExecutionAuthority;
  readonly backendIdentityRef: string;
  readonly timeoutMs: number;
  /** 目标 message 身份；reply 必须用原 message id。 */
  readonly messageId: string;
  readonly body: string;
  readonly runId?: string;
  /** 稳定 OperationId；同一目标+动作重放必须传同一个值。 */
  readonly operationId: OperationId;
  readonly expectedRevision: Revision;
  /** Validator 修复许可前核验的干净 worktree HEAD；恢复沿用原许可的固定基线。 */
  readonly expectedHead?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Orca `accepted` 载荷的分类：真正写入的 receipt、确定失败（Orca 记录了结果但答复没生效），
 * 或无法识别的形状。确定失败必须与成功分开，否则重放会把失败意图误读成 accepted。
 */
type AcceptedClassification =
  | { readonly kind: 'receipt'; readonly receipt: ReplyReceipt }
  | { readonly kind: 'definite_failure'; readonly code: string; readonly message: string }
  | { readonly kind: 'unrecognized' };

function classifyAccepted(value: unknown): AcceptedClassification {
  if (isRecord(value) && value['ok'] === false) {
    return {
      kind: 'definite_failure',
      code: typeof value['code'] === 'string' ? value['code'] : 'orca_definite_failure',
      message: typeof value['message'] === 'string' ? value['message'] : 'Orca 记录了确定失败，答复未生效',
    };
  }
  // adapter 的 parseResult 已把 ok 载荷归一化成 ReplyReceipt；这里只做结构确认。
  if (!isRecord(value) || typeof value['messageId'] !== 'string') {
    return { kind: 'unrecognized' };
  }
  return { kind: 'receipt', receipt: value as unknown as ReplyReceipt };
}

/**
 * 受控答复。Validator 步骤许可与普通 Coordinator 答复共用；调用方提供稳定 OperationId。
 */
export async function replyWorkerQuestion(input: ControlledReplyInput): Promise<ControlledReplyResult> {
  // 入口门禁：精确目标、有界正文与可信 Run/授权匹配都在这里判定，不进入外部 mutation。
  if (input.messageId.length === 0) {
    return { kind: 'rejected', code: 'invalid_input', message: '答复缺少目标 message 身份' };
  }
  if (Buffer.byteLength(input.body, 'utf8') > MAX_REPLY_BODY_BYTES) {
    return { kind: 'rejected', code: 'body_too_large', message: `答复正文超过 ${String(MAX_REPLY_BODY_BYTES)} 字节上限` };
  }
  if (input.authority.kind === 'execution_coordination') {
    if (input.runId !== undefined && input.authority.runId !== input.runId) {
      return { kind: 'rejected', code: 'run_mismatch', message: '答复 Run 与执行授权绑定的 Run 不一致' };
    }
  } else if (input.runId !== undefined) {
    return { kind: 'rejected', code: 'run_without_execution_authority', message: 'route_planning 授权下不能指定答复 Run' };
  }

  const target: EntityRef<string> = { kind: WORKER_REPLY_TARGET_KIND, id: input.messageId };

  /** 每次写入前重读当前 revision；读不回来时退回调用方给出的 revision。 */
  const currentRevision = (fallback: Revision): Revision => {
    const read = input.store.query({ kind: 'scope', coordinationScopeId: input.coordinationScopeId });
    return read.kind === 'scope' && read.scope !== null ? read.scope.revision : fallback;
  };

  const begun = beginIntent(input.store, {
    coordinationScopeId: input.coordinationScopeId,
    operationId: input.operationId,
    target,
    operationCategory: WORKER_REPLY_OPERATION_CATEGORY,
    writer: input.writer,
    expectedRevision: input.expectedRevision,
    ...(input.expectedHead === undefined ? {} : { expectedHead: input.expectedHead }),
  });
  if (begun.kind === 'rejected') {
    return { kind: 'rejected', code: begun.rejection.code, message: begun.rejection.message };
  }
  if (begun.kind === 'lane_blocked' || begun.kind === 'lane_busy') {
    return { kind: 'blocked', reason: `lane ${begun.laneKey} 上已有未决/阻塞意图，不发起答复` };
  }
  if (begun.kind === 'existing') {
    const intent = begun.intent;
    if (intent.state === 'settled') {
      // 已收尾的重放不再触碰外部系统：accepted 视为答复已生效，rejected 返回既有拒绝。
      return intent.outcomeClass === 'accepted'
        ? { kind: 'accepted', receipt: null, replayed: true }
        : { kind: 'rejected', code: 'already_rejected', message: '原答复已被拒绝（重放同一 OperationId）' };
    }
    if (intent.state === 'blocked') {
      const reconciled = await reconcileBlockedReply(input, intent, currentRevision);
      return reconciled;
    }
    // pending：先按原身份阻塞，再用原 backend request 引用对账；settled 才解除阻塞并返回成功。
    if (intent.backendRequestId === null) {
      return { kind: 'blocked', reason: '原答复意图未决且没有可核验的 backend request 引用' };
    }
    blockLane(input.store, {
      coordinationScopeId: input.coordinationScopeId,
      operationId: input.operationId,
      writer: input.writer,
      expectedRevision: currentRevision(input.expectedRevision),
      reason: 'worker-reply 结果未知，等待 request-show 对账',
    });
    const blocked = input.store.query({ kind: 'intent', coordinationScopeId: input.coordinationScopeId, operationId: input.operationId });
    if (blocked.kind === 'intent' && blocked.intent !== null) {
      return reconcileBlockedReply(input, blocked.intent, currentRevision);
    }
    return { kind: 'blocked', reason: '原答复意图阻塞后无法读回' };
  }

  const scope = buildExecutionScope({
    coordinationScopeId: input.coordinationScopeId,
    coordinatorSessionId: input.coordinatorSessionId,
    runtimeIncarnationId: input.runtimeIncarnationId,
    fencingGeneration: input.fencingGeneration,
    backendIdentityRef: input.backendIdentityRef,
    operationId: input.operationId,
    target,
    expectedRevision: input.expectedRevision,
    timeoutMs: input.timeoutMs,
    authority: input.authority,
  });
  const mutation =
    input.runId === undefined
      ? { operation: 'reply' as const, messageId: input.messageId, body: input.body }
      : { operation: 'reply' as const, messageId: input.messageId, body: input.body, runId: input.runId };
  const outcome = await input.backend.mutate(mutation, scope);

  if (outcome.kind === 'unknown') {
    const retained = settleIntent(input.store, {
      coordinationScopeId: input.coordinationScopeId,
      operationId: input.operationId,
      writer: input.writer,
      expectedRevision: currentRevision(input.expectedRevision),
      outcome,
    });
    if (retained.kind === 'rejected') {
      return { kind: 'unknown', operation: outcome.operation, reason: retained.rejection.message };
    }
    // 未决意图先按原身份阻塞，再用同一 OperationRef 对账一次；settled 才解除阻塞。
    blockLane(input.store, {
      coordinationScopeId: input.coordinationScopeId,
      operationId: input.operationId,
      writer: input.writer,
      expectedRevision: currentRevision(input.expectedRevision),
      reason: `worker-reply 结果未知（${outcome.reason}），等待 request-show 对账`,
    });
    const read = input.store.query({ kind: 'intent', coordinationScopeId: input.coordinationScopeId, operationId: input.operationId });
    return read.kind === 'intent' && read.intent !== null
      ? reconcileBlockedReply(input, read.intent, currentRevision)
      : { kind: 'unknown', operation: outcome.operation, reason: '答复意图无法读回' };
  }

  // 可证明未生效的本地/后端拒绝：以 rejected 意图收尾后返回。
  if (outcome.kind === 'rejected') {
    const settledReject = settleIntent(input.store, {
      coordinationScopeId: input.coordinationScopeId,
      operationId: input.operationId,
      writer: input.writer,
      expectedRevision: currentRevision(input.expectedRevision),
      outcome,
    });
    if (settledReject.kind === 'rejected') {
      return {
        kind: 'unknown',
        operation: { operationId: input.operationId, target },
        reason: `答复被拒绝但意图收尾失败：${settledReject.rejection.message}`,
      };
    }
    return { kind: 'rejected', code: outcome.code, message: outcome.message };
  }

  let classification = classifyAccepted(outcome.value);
  if (classification.kind === 'receipt' &&
      (classification.receipt.questionMessageId !== input.messageId || classification.receipt.questionStatus !== 'answered')) {
    classification = { kind: 'unrecognized' };
  }
  // Orca 记录的确定失败：以 rejected 意图收尾，重放才不会误读成 accepted。
  if (classification.kind === 'definite_failure') {
    const settledFailure = settleIntent(input.store, {
      coordinationScopeId: input.coordinationScopeId,
      operationId: input.operationId,
      writer: input.writer,
      expectedRevision: currentRevision(input.expectedRevision),
      outcome: { kind: 'rejected', code: classification.code, message: classification.message },
    });
    if (settledFailure.kind === 'rejected') {
      return {
        kind: 'unknown',
        operation: outcome.operation,
        reason: `答复确定失败但意图收尾失败：${settledFailure.rejection.message}`,
      };
    }
    return { kind: 'rejected', code: classification.code, message: classification.message };
  }
  // accepted 但回执形状无法识别：不能证明答复已生效，保持阻塞并按原身份对账。
  if (classification.kind === 'unrecognized') {
    const retained = settleIntent(input.store, {
      coordinationScopeId: input.coordinationScopeId,
      operationId: input.operationId,
      writer: input.writer,
      expectedRevision: currentRevision(input.expectedRevision),
      outcome: { kind: 'unknown', operation: outcome.operation, reason: 'unrecognized_reply_receipt' },
    });
    if (retained.kind === 'rejected') {
      return { kind: 'unknown', operation: outcome.operation, reason: retained.rejection.message };
    }
    blockLane(input.store, {
      coordinationScopeId: input.coordinationScopeId,
      operationId: input.operationId,
      writer: input.writer,
      expectedRevision: currentRevision(input.expectedRevision),
      reason: 'worker-reply 回执无法识别，等待 request-show 对账',
    });
    return { kind: 'unknown', operation: outcome.operation, reason: 'unrecognized_reply_receipt' };
  }

  const settled = settleIntent(input.store, {
    coordinationScopeId: input.coordinationScopeId,
    operationId: input.operationId,
    writer: input.writer,
    expectedRevision: currentRevision(input.expectedRevision),
    outcome,
  });
  if (settled.kind === 'rejected') {
    // 没有持久消费证明就不能报告成功：保留原 OperationRef 交调用方对账。
    return {
      kind: 'unknown',
      operation: outcome.operation,
      reason: `意图收尾失败：${settled.rejection.message}`,
    };
  }
  // 到此 classification 一定是 receipt（accepted 成功载荷）。
  return classification.kind === 'receipt'
    ? { kind: 'accepted', receipt: classification.receipt, replayed: false }
    : { kind: 'unknown', operation: outcome.operation, reason: 'unrecognized_reply_receipt' };
}

/**
 * 对一条已阻塞的答复意图做一次 `request-show` 对账。只有 Orca 明确 `completed` 才用 `resolveLane`
 * 就地收尾为 accepted；否则保持阻塞，绝不返回成功。
 */
async function reconcileBlockedReply(
  input: ControlledReplyInput,
  intent: { readonly operationId: OperationId; readonly target: EntityRef<string>; readonly backendRequestId: string | null; readonly blockingReason: string | null },
  currentRevision: (fallback: Revision) => Revision,
): Promise<ControlledReplyResult> {
  if (intent.backendRequestId === null) {
    return { kind: 'blocked', reason: intent.blockingReason ?? '答复意图已阻塞且没有可核验的 backend request 引用' };
  }
  const operation: OperationRef = {
    operationId: intent.operationId,
    backendRequestId: intent.backendRequestId,
    target: intent.target,
  };
  const reconciled = await reconcileOperation(input.backend, operation);
  if (reconciled.kind !== 'settled') {
    return { kind: 'blocked', reason: `答复意图对账未决：${reconciled.reason}` };
  }
  const classification = classifyAccepted(reconciled.receipt);
  const parsed = parseReplyReceipt(reconciled.receipt);
  const successful = parsed.ok && parsed.value.questionMessageId === input.messageId && parsed.value.questionStatus === 'answered';
  if (classification.kind !== 'definite_failure' && !successful) {
    return { kind: 'unknown', operation, reason: '请求已完成，但缺少原问题答复生效的回执' };
  }
  const resolved = resolveLane(input.store, {
    coordinationScopeId: input.coordinationScopeId,
    operationId: intent.operationId,
    writer: input.writer,
    expectedRevision: currentRevision(input.expectedRevision),
    outcomeClass: classification.kind === 'definite_failure' ? 'rejected' : 'accepted',
    backendRequestId: intent.backendRequestId,
  });
  if (resolved.kind !== 'settled') return { kind: 'unknown', operation, reason: '对账已 settled，但意图收尾失败' };
  return classification.kind === 'definite_failure'
    ? { kind: 'rejected', code: classification.code, message: classification.message }
    : { kind: 'accepted', receipt: parsed.ok ? parsed.value : null, replayed: true };
}
