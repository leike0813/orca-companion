/**
 * IP-04 / D-04：无 Scope 的用户消息准入（Owner: 本 change 的 debug host）。
 *
 * 调试目录不是 Coordination Scope，因此这里没有 Scope 门、没有 Runtime Lease、也没有 Wake 准入
 * 记录：那些判据在调试里都不存在，凭空补一个只会让「同一个 Session 只能一个写者」这条真正的
 * 约束被绕过。持久提交本身没有变——消息与 Wake Batch 仍在同一个 checkpoint 事务里落盘，由
 * `submissionId` 派生的身份与协调路径完全一致，因此崩溃补齐与稳定重放沿用同一套规则。
 */
import type {
  CoordinatorSessionState,
  WakeBatch,
} from '../../domain/coordinator/session-state.js';
import type { CoordinatorSessionId } from '../dto/identity.js';
import type { UserMessageCommitPort } from './runtime-guard.js';
import { MAX_USER_MESSAGE_CHARS } from './user-message.js';

export const DEBUG_MESSAGE_REJECTION_CODES = [
  'blank_content',
  'content_too_long',
  'invalid_submission',
  'content_conflict',
] as const;

export type DebugMessageRejectionCode = (typeof DEBUG_MESSAGE_REJECTION_CODES)[number];

/** 消息在模型输入里作为 Actionable Work 出现时的摘要长度上限，与协调路径一致。 */
const WORK_SUMMARY_CHARS = 240;

export type SubmitDebugUserMessageResult =
  | {
      readonly kind: 'accepted';
      readonly submissionId: string;
      readonly wakeBatch: WakeBatch;
      readonly state: CoordinatorSessionState;
      /** `true` 表示同一 submissionId 早已落盘，本次只是稳定重放。 */
      readonly replayed: boolean;
    }
  | { readonly kind: 'rejected'; readonly code: DebugMessageRejectionCode; readonly message: string }
  /** 提交结果无法证明：只能沿原 submissionId 核验，不得重发。 */
  | { readonly kind: 'unknown'; readonly submissionId: string; readonly reason: string };

export type SubmitDebugUserMessageInput = {
  readonly checkpoints: UserMessageCommitPort;
  readonly debugDirectoryId: string;
  readonly coordinatorSessionId: CoordinatorSessionId;
  readonly submissionId: string;
  readonly content: string;
};

/**
 * 构造调试消息的 Wake Batch。
 *
 * 身份与协调路径同构：同一个 `submissionId` 得到同一个 batch ID、entry 与 step，因此重启补齐与
 * 界面草稿恢复都能按稳定身份读回，而不是靠时间或顺序猜。
 */
export function debugUserMessageWakeBatch(input: {
  readonly debugDirectoryId: string;
  readonly coordinatorSessionId: CoordinatorSessionId;
  readonly submissionId: string;
  readonly content: string;
}): WakeBatch {
  return {
    wakeBatchId: `wake:debug-user:${input.submissionId}`,
    debugDirectoryId: input.debugDirectoryId,
    coordinatorSessionId: input.coordinatorSessionId,
    sourceRevisions: [{ sourceKind: 'user-message', sourceId: input.submissionId, revision: 1 }],
    actionableWork: [
      {
        workKind: 'user_message',
        workId: input.submissionId,
        summary: input.content.slice(0, WORK_SUMMARY_CHARS),
      },
    ],
  };
}

/** 提交一条调试用户消息：校验 → 落盘（消息与 Wake 同事务）→ 如实报告三值。 */
export function submitDebugUserMessage(
  input: SubmitDebugUserMessageInput,
): SubmitDebugUserMessageResult {
  if (input.submissionId.length === 0) {
    return { kind: 'rejected', code: 'invalid_submission', message: 'submissionId 必须是非空字符串' };
  }
  if (input.content.trim().length === 0) {
    return { kind: 'rejected', code: 'blank_content', message: '消息内容不能为空' };
  }
  if (input.content.length > MAX_USER_MESSAGE_CHARS) {
    return {
      kind: 'rejected',
      code: 'content_too_long',
      message: `消息长度 ${String(input.content.length)} 超过上限 ${String(MAX_USER_MESSAGE_CHARS)}`,
    };
  }

  const wakeBatch = debugUserMessageWakeBatch({
    debugDirectoryId: input.debugDirectoryId,
    coordinatorSessionId: input.coordinatorSessionId,
    submissionId: input.submissionId,
    content: input.content,
  });
  const commit = input.checkpoints.commitUserMessage({
    coordinatorSessionId: input.coordinatorSessionId,
    submissionId: input.submissionId,
    content: input.content,
    wakeBatch,
  });
  if (commit.kind === 'unrecoverable') {
    return { kind: 'unknown', submissionId: input.submissionId, reason: commit.reason };
  }
  if (commit.kind === 'already-committed') {
    return commit.contentMatches
      ? { kind: 'accepted', submissionId: input.submissionId, wakeBatch, state: commit.state, replayed: true }
      : {
          kind: 'rejected',
          code: 'content_conflict',
          message: `submissionId ${input.submissionId} 已经提交过内容不同的消息`,
        };
  }
  return { kind: 'accepted', submissionId: input.submissionId, wakeBatch, state: commit.state, replayed: false };
}
