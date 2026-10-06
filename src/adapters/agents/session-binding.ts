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

import type { HarnessSessionFacts } from '../../application/ports/worker-harness.js';
export type { HarnessSessionFacts } from '../../application/ports/worker-harness.js';
import type { WorkerRole } from '../../domain/planning/execution-authorization.js';
import type { SessionBinding } from '../../domain/task-contract.js';
import {
  proveCodexTranscript,
  type CodexSessionStartReport,
} from './codex-transcript.js';

/** Codex Worker Harness 的稳定标识；M1 只有这一个实现。 */
export const CODEX_HARNESS_ID = 'codex';

/**
 * Session Binding 的稳定标识：由「哪个 Dispatch」与「provider 报告的 session 身份」确定性派生。
 *
 * 它是可重放的身份函数而不是随机 ID，因此重启、恢复重放与重新观察同一条会话都会得到同一个值；
 * 装配方不得用 mtime、terminal 输出或「最近一次汇报」替代它的输入。
 */
export function sessionBindingIdOf(dispatchId: string, providerSessionId: string): string {
  return `session-binding:${encodeURIComponent(dispatchId)}:${encodeURIComponent(providerSessionId)}`;
}

export type SessionBindingFailureCode =
  | 'harness_mismatch'
  | 'session_not_reported'
  | 'transcript_not_reported'
  | 'transcript_unavailable'
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
  return bindHarnessSession(CODEX_HARNESS_ID, facts, options);
}

export function bindHarnessSession(
  harness: string,
  facts: HarnessSessionFacts,
  options: { readonly identityChanged?: boolean } = {},
): SessionBindingResult {
  if (facts.harness !== harness) {
    return unavailable('harness_mismatch', `期望 harness ${harness}，实际为 ${facts.harness}`);
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
      harness,
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

/** 由 Codex SessionStart 报告证明 transcript 后，复用同一个 Session Binding 校验入口。 */
export function bindCodexSessionFromStartReport(input: {
  readonly facts: Omit<HarnessSessionFacts, 'providerSessionId' | 'transcriptRef' | 'observedAt'>;
  readonly report: CodexSessionStartReport;
  readonly workspace: string;
  readonly expectedCodexHome: string;
  readonly dispatchStartedAt: string;
  readonly bindingDeadlineAt: string;
  readonly identityChanged?: boolean;
}): SessionBindingResult {
  const result = proveCodexTranscript(input);
  if (result.kind === 'transcript_unavailable') {
    return unavailable('transcript_unavailable', result.reason);
  }
  return bindCodexSession(
    {
      ...input.facts,
      providerSessionId: result.proof.providerSessionId,
      transcriptRef: result.proof.transcriptRef,
      observedAt: result.proof.observedAt,
    },
    input.identityChanged === undefined ? {} : { identityChanged: input.identityChanged },
  );
}

/** 四个主要角色都要求精确绑定；这里只表达「哪些角色必须绑定」，不复制角色的其他语义。 */
export const SESSION_BOUND_ROLES = ['planner', 'implementation', 'validator', 'finalizer'] as const;

export function roleRequiresSessionBinding(role: WorkerRole): boolean {
  return (SESSION_BOUND_ROLES as readonly string[]).includes(role);
}
