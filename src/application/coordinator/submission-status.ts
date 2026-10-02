/**
 * IC-11 的只读提交核验用例（Owner: `protect-tui-input`，design D8）。
 *
 * 它回答界面自己无法回答的问题：「上一次提交，权威事实是否已经受理？」核对的是**权威记录**
 * ——普通消息看 checkpoint 里由 `submissionId` 派生的已提交条目，回答看 Pending Interaction 上由
 * interaction ID 与 `submissionId` 共同派生的 `answerRef`——而不是界面自己保存的快照。
 *
 * 只读：不写 coordination store、不写 checkpoint、不调用 Orca、不唤醒模型。四个结果是封闭集合，
 * 判不出来时如实返回 `unverifiable`，绝不猜测成功或失败。
 */

import { z } from 'zod';

import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  InteractionId,
} from '../dto/identity.js';
import type { BranchCoordinationStore, PendingInteractionRecord } from '../ports/branch-coordination-store.js';
import type { CheckpointRecoveryPort } from './runtime-guard.js';
import { answerRefFor } from '../coordination/pending-interaction.js';
import { userEntryId, userStepId } from '../../domain/coordinator/session-state.js';

/**
 * 一条待核验提交的身份与正文。
 *
 * 普通消息按 `submissionId` 与正文核验；回答在此基础上多出 interaction ID 与 expected revision。
 * 界面只报告它自己提交过的事实，不携带 owner 或 scope——那些由宿主绑定。
 */
export type SubmissionQuery =
  | {
      readonly kind: 'message';
      readonly coordinatorSessionId: string;
      readonly submissionId: string;
      readonly content: string;
    }
  | {
      readonly kind: 'answer';
      readonly coordinatorSessionId: string;
      readonly submissionId: string;
      readonly content: string;
      readonly interactionId: string;
      readonly expectedRevision: number;
    };

/** 核验结论；`accepted` 附带对应权威引用，其余三种都不代表成功。 */
export type SubmissionStatus =
  | { readonly kind: 'accepted'; readonly ref: { readonly kind: string; readonly id: string } }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'conflict'; readonly code: string; readonly message: string }
  | { readonly kind: 'unverifiable'; readonly reason: string };

/**
 * 公共查询是边界输入：界面与宿主都可能传进缺字段或错类型的对象，因此这里做运行时校验。
 * 校验失败不是「未发现」，而是不可核验——判不出来时不能猜结果。
 */
const nonEmpty = z.string().min(1);

const submissionQuerySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('message'),
    coordinatorSessionId: nonEmpty,
    submissionId: nonEmpty,
    content: z.string(),
  }),
  z.strictObject({
    kind: z.literal('answer'),
    coordinatorSessionId: nonEmpty,
    submissionId: nonEmpty,
    content: z.string(),
    interactionId: nonEmpty,
    expectedRevision: z.number().int().nonnegative(),
  }),
]);

export type SubmissionStatusQueryInput = {
  readonly store: BranchCoordinationStore;
  readonly checkpoints: CheckpointRecoveryPort;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly input: SubmissionQuery;
};

function unverifiable(reason: string): SubmissionStatus {
  return { kind: 'unverifiable', reason };
}

/** 回答已受理：同一 interaction、同一 submissionId 且正文逐字一致。 */
function ownsAnswer(
  interaction: PendingInteractionRecord,
  ref: { readonly kind: string; readonly id: string },
  content: string,
): boolean {
  return (
    interaction.answerRef?.kind === ref.kind &&
    interaction.answerRef.id === ref.id &&
    interaction.answerText === content
  );
}

function verifyMessage(
  checkpoints: CheckpointRecoveryPort,
  query: Extract<SubmissionQuery, { kind: 'message' }>,
): SubmissionStatus {
  const sessionId = query.coordinatorSessionId as CoordinatorSessionId;
  let read;
  try {
    read = checkpoints.loadCheckpoint(sessionId);
  } catch (error) {
    return unverifiable(`无法读取会话历史：${error instanceof Error ? error.message : String(error)}`);
  }
  if (read.kind === 'unrecoverable') {
    return unverifiable(read.reason);
  }
  if (read.kind === 'absent') {
    // 该 Session 从未写过 checkpoint：这条消息不可能已经受理，但不是不可核验。
    return { kind: 'not-found' };
  }
  if (read.state.coordinatorSessionId !== sessionId) {
    return unverifiable(`checkpoint 属于 ${read.state.coordinatorSessionId}，与查询的 ${sessionId} 不一致`);
  }
  const entryId = userEntryId(query.submissionId);
  const stepId = userStepId(query.submissionId);
  // 只认「同 submissionId 派生的用户消息条目」：entryId、role 与 stepId 必须同时命中，
  // 否则一条形态相近的工具或助手条目会被误判成这次提交。
  const entry = read.state.committedMessages.find(
    (candidate) =>
      candidate.entryId === entryId && candidate.role === 'user' && candidate.stepId === stepId,
  );
  if (entry === undefined) {
    return { kind: 'not-found' };
  }
  if (entry.content !== query.content) {
    return {
      kind: 'conflict',
      code: 'content_conflict',
      message: `submissionId ${query.submissionId} 已提交过内容不同的消息`,
    };
  }
  return { kind: 'accepted', ref: { kind: 'user-message', id: entryId } };
}

function verifyAnswer(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
  query: Extract<SubmissionQuery, { kind: 'answer' }>,
): SubmissionStatus {
  const result = store.query({ kind: 'snapshot', coordinationScopeId });
  if (result.kind === 'rejected') {
    return unverifiable(result.message);
  }
  if (result.kind !== 'snapshot') {
    return unverifiable('snapshot 查询返回了非预期结果');
  }
  const interaction = result.snapshot.pendingInteractions.find(
    (candidate) => candidate.interactionId === query.interactionId,
  );
  if (interaction === undefined) {
    return { kind: 'not-found' };
  }
  if (interaction.ownerCoordinatorSessionId !== query.coordinatorSessionId) {
    return unverifiable(
      `Pending Interaction ${query.interactionId} 的 owner ${interaction.ownerCoordinatorSessionId} 与查询的 ${query.coordinatorSessionId} 不一致`,
    );
  }
  if (interaction.expectedRevision !== query.expectedRevision) {
    // 绑定 revision 不符就是过期回答：无论交互是否仍 open，都不能把别的 revision 的回答算成本次成功。
    return {
      kind: 'conflict',
      code: 'stale_revision',
      message: `回答绑定的 revision ${String(query.expectedRevision)} 与交互记录的 ${String(interaction.expectedRevision)} 不一致`,
    };
  }
  if (interaction.state === 'open') {
    // 还没有任何回答落盘：这次提交未被受理，但也没有被别人占用。
    return { kind: 'not-found' };
  }
  const ref = answerRefFor(query.interactionId as InteractionId, query.submissionId);
  if (interaction.state !== 'answered' || !ownsAnswer(interaction, ref, query.content)) {
    // 被别的 submissionId 或外部动作解决：绝不把它当成本次回答的成功。
    // closed/cancelled 即使残留同一个 answerRef 也不构成受理。
    return {
      kind: 'conflict',
      code: interaction.answerRef?.id === ref.id ? 'content_conflict' : 'answered_by_other',
      message:
        interaction.answerRef?.id === ref.id
          ? `submissionId ${query.submissionId} 的回答正文与记录不一致`
          : `Pending Interaction ${query.interactionId} 已被其他 submissionId 解决`,
    };
  }
  return { kind: 'accepted', ref: { kind: ref.kind, id: ref.id } };
}

/**
 * 核验一条提交。
 *
 * 先确认 Scope 与 Session 注册可读，再按查询类型读取对应权威记录；任一环不可读都返回
 * `unverifiable`，而不是把它当作未发现。
 */
export function querySubmission(input: SubmissionStatusQueryInput): SubmissionStatus {
  const parsed = submissionQuerySchema.safeParse(input.input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return unverifiable(`提交查询不合法：${issues}`);
  }
  const query = parsed.data as SubmissionQuery;
  const coordinationScopeId = input.coordinationScopeId;
  try {
    const scope = input.store.query({ kind: 'scope', coordinationScopeId });
    if (scope.kind === 'rejected') {
      return unverifiable(scope.message);
    }
    if (scope.kind !== 'scope') {
      return unverifiable('scope 查询返回了非预期结果');
    }
    if (scope.scope === null) {
      return unverifiable(`Coordination Scope ${coordinationScopeId} 尚未创建`);
    }
    const sessions = input.store.query({ kind: 'sessions', coordinationScopeId });
    if (sessions.kind === 'rejected') {
      return unverifiable(sessions.message);
    }
    if (sessions.kind !== 'sessions') {
      return unverifiable('sessions 查询返回了非预期结果');
    }
    if (
      !sessions.sessions.some((session) => session.coordinatorSessionId === query.coordinatorSessionId)
    ) {
      return unverifiable(
        `Session ${query.coordinatorSessionId} 未注册到 Scope ${coordinationScopeId}`,
      );
    }
    return query.kind === 'message'
      ? verifyMessage(input.checkpoints, query)
      : verifyAnswer(input.store, coordinationScopeId, query);
  } catch (error) {
    // store 或 checkpoint 抛出不是「未发现」：如实报告不可核验，绝不让异常冒泡成 Promise rejection。
    return unverifiable(
      `读取权威记录失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
