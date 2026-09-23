/**
 * IC-04 / D4：用户消息的持久提交与准入
 * （Owner: `m1-wire-foreground-planning-runtime`）。
 *
 * 用户消息不是「发一条请求」而是**持久事实**：它先以稳定提交身份写进目标 Session 的会话历史，
 * 再作为该 Session 的 Actionable Work 准入，最后才允许调用模型。顺序不可颠倒，理由是崩溃窗口：
 * 只剩「历史里有消息、却没有对应唤醒」这一个可判定中间态，重启时按原 `submissionId` 与
 * WakeBatchId 补齐即可，不需要去猜用户到底说过什么。
 *
 * 普通消息与 Pending Interaction 回答是两条不同的通道：这里不接受任何 interaction 身份，因此
 * 聊天在结构上不可能满足一个待答问题。
 */

import type { CoordinatorSessionState, WakeBatch } from '../../domain/coordinator/session-state.js';
import type { CoordinationScopeId, CoordinatorSessionId } from '../dto/identity.js';
import type { ControlState } from '../../domain/coordination/mode.js';
import type { BranchCoordinationStore } from '../ports/branch-coordination-store.js';
import type { WakeAdmissionOutcome, WakeCheckpointPort } from './wake-admission.js';
import { admitWakeBatch } from './wake-admission.js';
import type { UserMessageCommitPort } from './runtime-guard.js';
import { assertFencingGeneration, type CoordinatorIncarnation } from './runtime-guard.js';
import type { ProjectedActionableWorkItem } from './actionable-work.js';

/** 一条用户消息的字符上限。它只是输入边界，不是模型输入的预算；后者是项目配置的 context 预算。 */
export const MAX_USER_MESSAGE_CHARS = 20_000;

export const USER_MESSAGE_REJECTION_CODES = [
  'blank_content',
  'content_too_long',
  'invalid_submission',
  'control_state',
  'scope_not_found',
  'session_not_registered',
  'content_conflict',
  'fenced',
] as const;

export type UserMessageRejectionCode = (typeof USER_MESSAGE_REJECTION_CODES)[number];

/** 被拒绝或阻塞时都不产生任何写入；`blocked` 是「checkpoint 不可恢复」这类终态。 */
export type SubmitUserMessageResult =
  | {
      readonly kind: 'accepted';
      readonly submissionId: string;
      readonly wakeBatch: WakeBatch;
      /** 本次唤醒要交给模型处理的 Actionable Work：就是这条消息本身。 */
      readonly actionableWork: readonly ProjectedActionableWorkItem[];
      readonly admission: WakeAdmissionOutcome;
      readonly state: CoordinatorSessionState;
      /** 该消息是否需要（且被允许）立刻恢复模型；Pause 下为 `false`。 */
      readonly wakeModel: boolean;
    }
  | { readonly kind: 'rejected'; readonly code: UserMessageRejectionCode; readonly message: string }
  | { readonly kind: 'blocked'; readonly reason: string };

export type SubmitUserMessageInput = {
  readonly store: BranchCoordinationStore;
  readonly checkpoints: UserMessageCommitPort & WakeCheckpointPort;
  /** 只能来自 `acquireIncarnation` / `resumeIncarnation`；界面与模型不可填写。 */
  readonly incarnation: CoordinatorIncarnation;
  readonly coordinatorSessionId: CoordinatorSessionId;
  /** UI 在一次提交时生成，并在同一次重试中复用。 */
  readonly submissionId: string;
  readonly content: string;
  readonly clock?: () => number;
};

/** 消息在模型输入里作为 Actionable Work 出现时的摘要长度上限。 */
const WORK_SUMMARY_CHARS = 240;

type ScopeGate =
  | { readonly kind: 'open'; readonly controlState: ControlState }
  | { readonly kind: 'rejected'; readonly code: UserMessageRejectionCode; readonly message: string };

function readScopeGate(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
): ScopeGate {
  const scope = store.query({ kind: 'scope', coordinationScopeId });
  if (scope.kind === 'rejected' || scope.kind !== 'scope') {
    return { kind: 'rejected', code: 'scope_not_found', message: `无法读取 Coordination Scope ${coordinationScopeId}` };
  }
  if (scope.scope === null) {
    return { kind: 'rejected', code: 'scope_not_found', message: `Scope ${coordinationScopeId} 尚未创建` };
  }
  const controlState = scope.scope.controlState;
  if (controlState === 'cancelling' || controlState === 'cancelled') {
    return {
      kind: 'rejected',
      code: 'control_state',
      message: `Scope 处于 ${controlState}，不再接受新的用户消息`,
    };
  }
  // `paused` 允许落盘：消息是用户已经表达的意图，Resume 对账后按同一身份处理；`blocked` 与
  // `unverifiable` 同样保存，因为拒绝一条已经发出的用户消息不会让状态更清楚。
  return { kind: 'open', controlState };
}

function sessionRegistered(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
  coordinatorSessionId: CoordinatorSessionId,
): boolean {
  const sessions = store.query({ kind: 'sessions', coordinationScopeId });
  return (
    sessions.kind === 'sessions' &&
    sessions.sessions.some((session) => session.coordinatorSessionId === coordinatorSessionId)
  );
}

/**
 * 构造这条消息的 Wake Batch。
 *
 * 身份全部由 `submissionId` 派生：WakeBatchId、entry、step 与 source revision 因此是同一个稳定
 * 事实的不同视图，重放不会得到「看起来一样的新记录」。
 */
export function userMessageWakeBatch(input: {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly coordinatorSessionId: CoordinatorSessionId;
  readonly submissionId: string;
  readonly content: string;
}): WakeBatch {
  return {
    wakeBatchId: `wake:user:${input.submissionId}`,
    coordinationScopeId: input.coordinationScopeId,
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

/** 该消息对应的 Actionable Work 条目；崩溃补齐后重建它不需要重新读用户输入。 */
export function userMessageWorkItem(batch: WakeBatch): readonly ProjectedActionableWorkItem[] {
  const [source] = batch.sourceRevisions;
  const [work] = batch.actionableWork;
  if (source === undefined || work === undefined) {
    return [];
  }
  return [{ source, workKind: 'user_message', summary: work.summary }];
}

/**
 * 提交一条普通用户消息。
 *
 * 校验 → 落盘（消息 + Wake Batch 同一次写入）→ 记录 source admission。任一步失败都在调用模型
 * 之前结束，并把原因如实返回。
 */
export function submitUserMessage(input: SubmitUserMessageInput): SubmitUserMessageResult {
  const coordinationScopeId = input.incarnation.coordinationScopeId;
  if (input.submissionId.length === 0) {
    return { kind: 'rejected', code: 'invalid_submission', message: 'submissionId 必须是非空字符串' };
  }
  const content = input.content;
  if (content.trim().length === 0) {
    return { kind: 'rejected', code: 'blank_content', message: '消息内容不能为空' };
  }
  if (content.length > MAX_USER_MESSAGE_CHARS) {
    return {
      kind: 'rejected',
      code: 'content_too_long',
      message: `消息长度 ${String(content.length)} 超过上限 ${String(MAX_USER_MESSAGE_CHARS)}`,
    };
  }
  if (input.incarnation.coordinatorSessionId !== input.coordinatorSessionId) {
    return {
      kind: 'rejected',
      code: 'session_not_registered',
      message: '目标 Session 与当前 Runtime Incarnation 不一致',
    };
  }

  const gate = readScopeGate(input.store, coordinationScopeId);
  if (gate.kind === 'rejected') {
    return gate;
  }
  if (!sessionRegistered(input.store, coordinationScopeId, input.coordinatorSessionId)) {
    return {
      kind: 'rejected',
      code: 'session_not_registered',
      message: `Session ${input.coordinatorSessionId} 未注册到 Scope ${coordinationScopeId}`,
    };
  }

  // 写入是副作用：先确认本 incarnation 仍然有效。
  const fencing = assertFencingGeneration(input.store, input.incarnation, {
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });
  if (fencing.kind === 'fenced') {
    return { kind: 'rejected', code: 'fenced', message: `写入用户消息前已被 fencing 拒绝（${fencing.code}）` };
  }

  const wakeBatch = userMessageWakeBatch({
    coordinationScopeId,
    coordinatorSessionId: input.coordinatorSessionId,
    submissionId: input.submissionId,
    content,
  });

  const commit = input.checkpoints.commitUserMessage({
    coordinatorSessionId: input.coordinatorSessionId,
    submissionId: input.submissionId,
    content,
    wakeBatch,
  });
  if (commit.kind === 'unrecoverable') {
    return { kind: 'blocked', reason: commit.reason };
  }
  if (commit.kind === 'already-committed' && !commit.contentMatches) {
    return {
      kind: 'rejected',
      code: 'content_conflict',
      message: `submissionId ${input.submissionId} 已经提交过内容不同的消息`,
    };
  }

  const admission = admitWakeBatch(input.store, {
    wakeBatch,
    incarnation: input.incarnation,
    checkpoints: input.checkpoints,
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });
  if (admission.kind === 'blocked') {
    return { kind: 'blocked', reason: admission.reason };
  }
  if (admission.kind === 'rejected') {
    return { kind: 'rejected', code: 'fenced', message: admission.rejection.message };
  }
  if (admission.kind === 'already-admitted') {
    // 这条工作已经以某个 batch 准入过：历史与准入都已在，模型不需要因此再被唤醒一次。
    return {
      kind: 'accepted',
      submissionId: input.submissionId,
      wakeBatch,
      actionableWork: [],
      admission,
      state: commit.state,
      wakeModel: false,
    };
  }

  const state = admission.kind === 'admitted' || admission.kind === 'repaired' ? admission.state : commit.state;
  return {
    kind: 'accepted',
    submissionId: input.submissionId,
    wakeBatch,
    actionableWork: userMessageWorkItem(wakeBatch),
    admission,
    state,
    // Pause 下消息照常落盘，但模型等 Resume 对账后才处理。
    wakeModel: gate.controlState === 'active',
  };
}
