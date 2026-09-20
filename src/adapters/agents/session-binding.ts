/**
 * IC-07 / IP-A5：Codex Session Binding（Owner: `m1-admit-work-package-specifications`）。
 *
 * Session Binding 只接受可证明的 harness 事实：确切的角色、session 身份与可引用的 transcript 来源。
 * 当 harness 没有报告 session 身份（例如当前安装版本的 Codex 返回 `session_not_reported`），或拿不到
 * transcript 引用时，adapter 返回不可用结论并阻塞该 Dispatch——它不会退回工作目录、mtime、终端 handle
 * 或「最近一次输出」去猜一个 session。
 *
 * 本模块不启动 Worker、不恢复 session、不生成 Capsule；它只回答「这次 Dispatch 与哪个 session 绑定」。
 */

import type {
  DispatchId,
  WorkerTaskId,
} from '../../application/dto/identity.js';
import type { WorkerRole } from '../../domain/planning/execution-authorization.js';
import type { SessionBinding } from '../../domain/task-contract.js';

/** Codex Worker Harness 的稳定标识；M1 只有这一个实现。 */
export const CODEX_HARNESS_ID = 'codex';

/** harness 报告的原始事实；字段缺失是常态，缺失即不可用。 */
export type HarnessSessionFacts = {
  readonly harness: string;
  readonly role: WorkerRole;
  readonly workerTaskId: WorkerTaskId;
  readonly dispatchId: DispatchId;
  readonly attemptId: string;
  /** provider 报告的 session 身份；未报告时为 `null`（不是空字符串）。 */
  readonly providerSessionId: string | null;
  /** 可引用的 transcript 来源；未报告时为 `null`。 */
  readonly transcriptRef: string | null;
  /** 观察时间窗；由 harness 或 Controller 提供，不由本模块取时钟。 */
  readonly observedAt: string | null;
};

export type SessionBindingFailureCode =
  | 'harness_mismatch'
  | 'session_not_reported'
  | 'transcript_not_reported'
  | 'worker_identity_changed'
  | 'observation_window_missing';

export type SessionBindingResult =
  | { readonly kind: 'bound'; readonly binding: SessionBinding }
  | {
      readonly kind: 'unavailable';
      readonly code: SessionBindingFailureCode;
      readonly message: string;
      /** 不可用时该 Dispatch 必须阻塞；这个字段是结论的一部分，不是提示。 */
      readonly blocksDispatch: true;
    };

function unavailable(code: SessionBindingFailureCode, message: string): SessionBindingResult {
  return { kind: 'unavailable', code, message, blocksDispatch: true };
}

/**
 * 构造并核验一次 Session Binding。
 *
 * `identityChanged` 来自 Orca 的 `worker_identity_changed`：身份换过就说明当前观察不再属于原 Dispatch，
 * 因此直接判不可用，而不是把新身份当成原来的 session 继续。
 */
export function bindCodexSession(
  facts: HarnessSessionFacts,
  options: { readonly identityChanged?: boolean } = {},
): SessionBindingResult {
  if (facts.harness !== CODEX_HARNESS_ID) {
    return unavailable('harness_mismatch', `期望 harness ${CODEX_HARNESS_ID}，实际为 ${facts.harness}`);
  }
  if (options.identityChanged === true) {
    return unavailable('worker_identity_changed', 'Orca 报告 worker 身份已变更，原观察不再属于该 Dispatch');
  }
  if (facts.providerSessionId === null || facts.providerSessionId.length === 0) {
    return unavailable(
      'session_not_reported',
      'harness 未报告 session 身份，无法证明该 Dispatch 的 harness session',
    );
  }
  if (facts.transcriptRef === null || facts.transcriptRef.length === 0) {
    return unavailable('transcript_not_reported', 'harness 未给出可引用的 transcript 来源');
  }
  if (facts.observedAt === null || facts.observedAt.length === 0) {
    return unavailable('observation_window_missing', '缺少观察时间窗，无法核验绑定的事实来源');
  }
  return {
    kind: 'bound',
    binding: {
      harness: CODEX_HARNESS_ID,
      role: facts.role,
      workerTaskId: facts.workerTaskId,
      dispatchId: facts.dispatchId,
      attemptId: facts.attemptId,
      providerSessionId: facts.providerSessionId,
      transcriptRef: facts.transcriptRef,
      observedAt: facts.observedAt,
    },
  };
}

/** 四个主要角色都要求精确绑定；这里只表达「哪些角色必须绑定」，不复制角色的其他语义。 */
export const SESSION_BOUND_ROLES = ['planner', 'implementation', 'validator', 'finalizer'] as const;

export function roleRequiresSessionBinding(role: WorkerRole): boolean {
  return (SESSION_BOUND_ROLES as readonly string[]).includes(role);
}
