/**
 * IC-11：Pending Interaction 的 CAS 回答用例
 * （Owner: `m1-recover-execution`，IP-9；`m1-wire-foreground-planning-runtime` 增加受控正文）。
 *
 * 回答必须同时绑定 interaction ID 与 expected revision：只有回答者读到的 revision 与交互记录里
 * 冻结的绑定 revision 精确相等，且交互仍为 `open` 时才写入。任何一项不成立都在**发出写入之前**
 * 拒绝，因此 revision 过期时零副作用，交互保持 open——普通 Session 消息不经过这里，也就不可能
 * 满足一个待答问题。
 *
 * 回答正文与解决状态在**同一条命令**里落盘：分开写会留下「已解决但没有正文」的中间态，那正是回答
 * 无法被恢复的形态。`answerRef` 由本层从 interaction ID 派生，不由界面填写——界面只表达正文。
 */

import type {
  CoordinationScopeId,
  EntityRef,
  InteractionId,
  Revision,
} from '../dto/identity.js';
import type {
  BranchCoordinationStore,
  CoordinationWriter,
  PendingInteractionRecord,
} from '../ports/branch-coordination-store.js';
import { MAX_USER_MESSAGE_CHARS } from '../coordinator/user-message.js';

export const ANSWER_PENDING_INTERACTION_REJECTIONS = [
  'not_found',
  'already_resolved',
  'stale_revision',
  'unreadable',
  'stale_scope',
  'blank_answer',
  'answer_too_long',
] as const;

export type AnswerPendingInteractionRejectionCode =
  (typeof ANSWER_PENDING_INTERACTION_REJECTIONS)[number];

export type AnswerPendingInteractionInput = {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly writer: CoordinationWriter;
  readonly interactionId: InteractionId;
  /** 回答者读到的绑定期望 revision；必须与该交互记录冻结的值精确相等。 */
  readonly expectedRevision: Revision;
  /** 受控回答正文；与解决状态一起持久化。 */
  readonly answer: string;
};

export type AnswerPendingInteractionResult =
  | {
      readonly kind: 'answered';
      readonly interactionId: InteractionId;
      /** 写入完成后的 Scope revision。 */
      readonly revision: Revision;
    }
  | {
      readonly kind: 'rejected';
      readonly code: AnswerPendingInteractionRejectionCode;
      readonly message: string;
    };

type InteractionRead =
  | {
      readonly kind: 'read';
      readonly interaction: PendingInteractionRecord;
      readonly scopeRevision: Revision;
    }
  | { readonly kind: 'rejected'; readonly code: AnswerPendingInteractionRejectionCode; readonly message: string };

function readInteraction(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
  interactionId: InteractionId,
): InteractionRead {
  const result = store.query({ kind: 'snapshot', coordinationScopeId });
  if (result.kind === 'rejected') {
    return { kind: 'rejected', code: 'unreadable', message: result.message };
  }
  if (result.kind !== 'snapshot') {
    return { kind: 'rejected', code: 'unreadable', message: 'snapshot 查询返回了非预期结果' };
  }
  const interaction = result.snapshot.pendingInteractions.find(
    (entry) => entry.interactionId === interactionId,
  );
  if (interaction === undefined) {
    return { kind: 'rejected', code: 'not_found', message: `Pending Interaction ${interactionId} 不存在` };
  }
  return { kind: 'read', interaction, scopeRevision: result.snapshot.scope.revision };
}

/** 回答正文的稳定引用：一个 interaction 只有一条已回答正文，因此身份由它自己派生。 */
export function answerRefFor(interactionId: InteractionId): EntityRef<string> {
  return { kind: 'interaction-answer', id: interactionId };
}

/**
 * 回答一个 Pending Interaction。
 *
 * 只写 `resolve-pending-interaction` 一条命令；Orca 与 Worker 都不在这里被调用，因此拒绝路径不存在
 * 任何外部 mutation。
 */
export function answerPendingInteraction(
  input: AnswerPendingInteractionInput,
): AnswerPendingInteractionResult {
  if (input.answer.trim().length === 0) {
    return { kind: 'rejected', code: 'blank_answer', message: '回答正文不能为空' };
  }
  if (input.answer.length > MAX_USER_MESSAGE_CHARS) {
    return {
      kind: 'rejected',
      code: 'answer_too_long',
      message: `回答长度 ${String(input.answer.length)} 超过上限 ${String(MAX_USER_MESSAGE_CHARS)}`,
    };
  }
  const read = readInteraction(input.store, input.coordinationScopeId, input.interactionId);
  if (read.kind === 'rejected') {
    return { kind: 'rejected', code: read.code, message: read.message };
  }
  if (read.interaction.state !== 'open') {
    return {
      kind: 'rejected',
      code: 'already_resolved',
      message: `Pending Interaction ${input.interactionId} 已处于 ${read.interaction.state}`,
    };
  }
  if (read.interaction.expectedRevision !== input.expectedRevision) {
    return {
      kind: 'rejected',
      code: 'stale_revision',
      message: `回答绑定的 revision ${input.expectedRevision} 与交互记录的 ${read.interaction.expectedRevision} 不一致`,
    };
  }

  const resolve = (expectedRevision: Revision): AnswerPendingInteractionResult => {
    const written = input.store.transact({
      kind: 'resolve-pending-interaction',
      coordinationScopeId: input.coordinationScopeId,
      expectedRevision,
      writer: input.writer,
      interactionId: input.interactionId,
      state: 'answered',
      answerRef: answerRefFor(input.interactionId),
      answerText: input.answer,
    });
    if (written.kind === 'committed') {
      return { kind: 'answered', interactionId: input.interactionId, revision: written.revision };
    }
    if (written.code === 'stale_revision' && written.currentRevision !== undefined) {
      return resolve(written.currentRevision);
    }
    return {
      kind: 'rejected',
      code: written.code === 'stale_revision' ? 'stale_scope' : 'unreadable',
      message: written.message,
    };
  };

  return resolve(read.scopeRevision);
}
