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
 * 无法被恢复的形态。`answerRef` 由本层从 interaction ID 与稳定 `submissionId` 共同派生，不由界面
 * 填写——界面只表达正文与它自己的提交身份。
 *
 * `submissionId` 让同一提交在崩溃补齐与重放时指同一条持久事实：同身份、同绑定 revision、同正文的
 * 重复回答是幂等成功；同身份但正文不同则明确冲突；被别的身份解决的交互不构成本次成功。
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
  'stale_scope',
  'unreadable',
  'invalid_submission',
  'content_conflict',
  'blank_answer',
  'answer_too_long',
] as const;

export type AnswerPendingInteractionRejectionCode =
  (typeof ANSWER_PENDING_INTERACTION_REJECTIONS)[number];

export type AnswerPendingInteractionInput = {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly writer: CoordinationWriter;
  /** 界面生成的稳定提交身份；同一次重试复用，空值即拒绝。 */
  readonly submissionId: string;
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

/**
 * 回答正文的稳定引用：由 interaction ID 与 submissionId 共同派生。
 *
 * 同一个 interaction 只会有一条已回答正文，但派生里带上 `submissionId` 之后，「被别的身份解决」与
 * 「本次提交已受理」在引用层面就能区分，核验不必再猜是谁写的。
 */
export function answerRefFor(interactionId: InteractionId, submissionId: string): EntityRef<string> {
  return { kind: 'interaction-answer', id: JSON.stringify([interactionId, submissionId]) };
}

/**
 * 乐观并发的重读上限。
 *
 * 读与提交之间夹进任意一次共享写入都会让 CAS 以 `stale_revision` 落空；那是良性竞争，重读再试即可，
 * 但必须有界——无限重试会把一次过期回答挂在写入路径上。
 */
const MAX_ANSWER_CAS_ATTEMPTS = 5;

function sameOwnAnswer(
  interaction: PendingInteractionRecord,
  ref: EntityRef<string>,
  answer: string,
  expectedRevision: Revision,
): boolean {
  return (
    interaction.state === 'answered' &&
    interaction.answerRef?.kind === ref.kind &&
    interaction.answerRef?.id === ref.id &&
    interaction.answerText === answer &&
    interaction.expectedRevision === expectedRevision
  );
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
  if (typeof input.submissionId !== 'string' || input.submissionId.length === 0) {
    return { kind: 'rejected', code: 'invalid_submission', message: 'submissionId 必须是非空字符串' };
  }
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
  const ref = answerRefFor(input.interactionId, input.submissionId);
  const read = readInteraction(input.store, input.coordinationScopeId, input.interactionId);
  if (read.kind === 'rejected') {
    return { kind: 'rejected', code: read.code, message: read.message };
  }

  /** 已经结清的交互：只有「同身份、同绑定 revision、同正文」才是本次提交的幂等成功。 */
  const settled = (interaction: PendingInteractionRecord, revision: Revision): AnswerPendingInteractionResult | null => {
    if (interaction.state === 'open') {
      return null;
    }
    if (sameOwnAnswer(interaction, ref, input.answer, input.expectedRevision)) {
      return { kind: 'answered', interactionId: input.interactionId, revision };
    }
    // 只有真正 answered 且残留同一 answerRef 才是「同身份内容不同」；closed/cancelled 不算本次受理。
    if (interaction.state === 'answered' && interaction.answerRef?.id === ref.id) {
      return {
        kind: 'rejected',
        code: 'content_conflict',
        message: `submissionId ${input.submissionId} 已为 ${input.interactionId} 提交过内容不同的回答`,
      };
    }
    return {
      kind: 'rejected',
      code: 'already_resolved',
      message: `Pending Interaction ${input.interactionId} 已处于 ${interaction.state}`,
    };
  };

  const settledNow = settled(read.interaction, read.scopeRevision);
  if (settledNow !== null) {
    return settledNow;
  }
  if (read.interaction.expectedRevision !== input.expectedRevision) {
    return {
      kind: 'rejected',
      code: 'stale_revision',
      message: `回答绑定的 revision ${input.expectedRevision} 与交互记录的 ${read.interaction.expectedRevision} 不一致`,
    };
  }

  let expectedRevision = read.scopeRevision;
  for (let attempt = 0; attempt < MAX_ANSWER_CAS_ATTEMPTS; attempt += 1) {
    const written = input.store.transact({
      kind: 'resolve-pending-interaction',
      coordinationScopeId: input.coordinationScopeId,
      expectedRevision,
      writer: input.writer,
      interactionId: input.interactionId,
      state: 'answered',
      answerRef: ref,
      answerText: input.answer,
    });
    if (written.kind === 'committed') {
      return { kind: 'answered', interactionId: input.interactionId, revision: written.revision };
    }
    if (written.code === 'stale_revision' && written.currentRevision !== undefined) {
      // 竞争落空：重读权威记录，确认是不是自己的回答已经落盘，或已被别人解决。
      const reread = readInteraction(input.store, input.coordinationScopeId, input.interactionId);
      if (reread.kind === 'rejected') {
        return { kind: 'rejected', code: reread.code, message: reread.message };
      }
      const settledAfterRace = settled(reread.interaction, reread.scopeRevision);
      if (settledAfterRace !== null) {
        return settledAfterRace;
      }
      // 竞争期间绑定 revision 变了：不能拿旧绑定继续回答。
      if (reread.interaction.expectedRevision !== input.expectedRevision) {
        return {
          kind: 'rejected',
          code: 'stale_revision',
          message: `回答绑定的 revision ${input.expectedRevision} 与交互记录当前冻结的 ${reread.interaction.expectedRevision} 不一致`,
        };
      }
      expectedRevision = written.currentRevision;
      continue;
    }
    return {
      kind: 'rejected',
      code: 'unreadable',
      message: written.message,
    };
  }
  return {
    kind: 'rejected',
    code: 'stale_scope',
    message: `回答 ${input.interactionId} 时 scope revision 持续变化，超过 ${String(MAX_ANSWER_CAS_ATTEMPTS)} 次重读`,
  };
}
