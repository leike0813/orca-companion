/**
 * IC-07 / IP-A5：Worker 存活三值、可核验终态与 Session Segment 前置事实
 * （Owner: `m1-admit-work-package-specifications`）。
 *
 * 这个模块只做判定与记录形状，不做任何恢复动作：它不重建 session、不生成 Capsule、不记录也不消耗
 * Recovery Budget、不创建替代 Segment。信息不足时唯一的诚实结论是 `unverifiable`，而这个结论本身
 * 就禁止把「不可达」读成「已退出」并触发重复派发。
 *
 * 纯函数：不读时钟、不碰 Git/Orca、不写存储。
 */

import type { DispatchId, WorkerTaskId } from '../application/dto/identity.js';
import type { WorkerRole } from './planning/execution-authorization.js';

export const WORKER_LIVENESS_VALUES = ['live', 'exited', 'unverifiable'] as const;

export type WorkerLiveness = (typeof WORKER_LIVENESS_VALUES)[number];

/**
 * 主机的终端观察结果。
 *
 * `enumerated: false` 表示执行主机没有被列举过——这不是「没有终端」，因此无法据此断定任何存活状态。
 */
export type ExecutionHostObservation =
  | { readonly kind: 'not-enumerated' }
  | { readonly kind: 'enumerated'; readonly terminalHandles: readonly string[] }
  | { readonly kind: 'unavailable'; readonly reason: string };

export type TerminalLivenessFacts = {
  readonly dispatchId: DispatchId;
  /** 该 Dispatch 的 worker 是否由宿主明确报告仍在运行。 */
  readonly workerRunning: boolean;
  readonly terminalHandle: string | null;
  readonly host: ExecutionHostObservation;
};

export type LivenessDecision = {
  readonly dispatchId: DispatchId;
  readonly liveness: WorkerLiveness;
  readonly reason: string;
};

/**
 * 三值存活判定。
 *
 * 只有两种情形可以给出确定结论：宿主明确报告该 worker 仍在运行（`live`），或宿主已被列举且明确
 * 不含该终端（`exited`）。其余情形——主机未列举、观察不可用、缺少终端句柄、以及「worker 不在运行
 * 但主机未列举」——一律是 `unverifiable`。
 */
export function decideLiveness(facts: TerminalLivenessFacts): LivenessDecision {
  if (facts.workerRunning) {
    return { dispatchId: facts.dispatchId, liveness: 'live', reason: '宿主报告该 worker 仍在运行' };
  }
  if (facts.host.kind === 'enumerated') {
    if (facts.terminalHandle === null) {
      return {
        dispatchId: facts.dispatchId,
        liveness: 'unverifiable',
        reason: '缺少终端句柄，无法确认该终端是否存在于已列举的主机',
      };
    }
    const present = facts.host.terminalHandles.includes(facts.terminalHandle);
    return present
      ? { dispatchId: facts.dispatchId, liveness: 'unverifiable', reason: '终端仍在已列举主机上存在' }
      : { dispatchId: facts.dispatchId, liveness: 'exited', reason: '执行主机已列举且不含该终端' };
  }
  if (facts.host.kind === 'unavailable') {
    return { dispatchId: facts.dispatchId, liveness: 'unverifiable', reason: facts.host.reason };
  }
  return {
    dispatchId: facts.dispatchId,
    liveness: 'unverifiable',
    reason: '执行主机未被列举，无法确认 worker 是否已退出',
  };
}

/** 结算前必须匹配的归属事实；任何一项对不上，终态都不能核验。 */
export type TerminalReceiptFacts = {
  readonly workerTaskId: WorkerTaskId;
  readonly dispatchId: DispatchId;
  /** 终态收据自报的归属。 */
  readonly receipt: {
    readonly workerTaskId: WorkerTaskId;
    readonly dispatchId: DispatchId;
    readonly attemptId: string;
    readonly role: WorkerRole;
    readonly sessionBindingId: string;
  };
  /** Controller 当前登记的归属。 */
  readonly expected: {
    readonly workerTaskId: WorkerTaskId;
    readonly dispatchId: DispatchId;
    readonly attemptId: string;
    readonly role: WorkerRole;
    readonly sessionBindingId: string | null;
  };
};

export type TerminalVerdict =
  | { readonly kind: 'settleable'; readonly workerTaskId: WorkerTaskId; readonly dispatchId: DispatchId }
  | { readonly kind: 'unverifiable'; readonly mismatch: readonly string[] };

const RECEIPT_FIELDS = ['workerTaskId', 'dispatchId', 'attemptId', 'role', 'sessionBindingId'] as const;
type ReceiptField = (typeof RECEIPT_FIELDS)[number];

/**
 * 核验终态收据的归属。
 *
 * 只有 Task、Dispatch、Attempt、角色与 Session Binding 逐项一致时才能进入结算；任何一项不匹配都返回
 * `unverifiable` 并列出不匹配字段，绝不按「最接近的那条」结算。
 */
export function verifyTerminalReceipt(facts: TerminalReceiptFacts): TerminalVerdict {
  const mismatch: string[] = [];
  for (const field of RECEIPT_FIELDS satisfies readonly ReceiptField[]) {
    if (facts.receipt[field] !== facts.expected[field]) {
      mismatch.push(field);
    }
  }
  if (facts.receipt.workerTaskId !== facts.workerTaskId) {
    mismatch.push('receiptWorkerTaskId');
  }
  if (facts.receipt.dispatchId !== facts.dispatchId) {
    mismatch.push('receiptDispatchId');
  }
  if (mismatch.length > 0) {
    return { kind: 'unverifiable', mismatch };
  }
  return { kind: 'settleable', workerTaskId: facts.workerTaskId, dispatchId: facts.dispatchId };
}

/** 会话中断时能记录下来的全部前置事实；不含 Recovery Budget 计数。 */
export type SessionSegmentDraft = {
  readonly role: WorkerRole;
  readonly workerTaskId: WorkerTaskId;
  readonly dispatchId: DispatchId;
  readonly attemptId: string;
  readonly sessionBindingId: string;
  /** 最后可引用的 transcript 位置；`null` 表示 transcript 已无法引用。 */
  readonly lastTranscriptRef: string | null;
  /** 中断时能核验到的终态收据引用；核验不了时为 `null`。 */
  readonly terminalReceiptRef: string | null;
  readonly transcriptReferenceable: boolean;
  readonly recordedAt: number;
};

export type SessionInterruptionFacts = {
  readonly role: WorkerRole;
  readonly workerTaskId: WorkerTaskId;
  readonly dispatchId: DispatchId;
  readonly attemptId: string;
  readonly sessionBindingId: string | null;
  readonly lastTranscriptRef: string | null;
  readonly terminalReceiptRef: string | null;
  /** 中断时的可核验终态判定；`unverifiable` 也要如实记录。 */
  readonly terminalVerdict: TerminalVerdict;
  readonly recordedAt: number;
};

export type SessionInterruptionResult =
  | { readonly kind: 'segment-recorded'; readonly segment: SessionSegmentDraft }
  | { readonly kind: 'blocked'; readonly reason: string; readonly segment: SessionSegmentDraft };

/**
 * 会话中断时形成 Session Segment 前置事实。
 *
 * 拿到 Session Binding 且能引用 transcript 时记一条完整 segment；缺少 Session Binding 或 transcript
 * 已不可引用时，仍然把能核验的事实落成 blocked 结论，但 segment 的 `transcriptReferenceable` 为
 * `false`，后继路径必须阻塞而不是假装原 session 继续。
 *
 * 这里不恢复 session、不生成 Capsule、不创建替代 segment、不记录 Recovery Budget。
 */
export function recordSessionSegment(facts: SessionInterruptionFacts): SessionInterruptionResult {
  if (facts.sessionBindingId === null || facts.sessionBindingId.length === 0) {
    return {
      kind: 'blocked',
      reason: '无法证明该 Dispatch 的 harness session 身份，中断事实只能阻塞',
      segment: {
        role: facts.role,
        workerTaskId: facts.workerTaskId,
        dispatchId: facts.dispatchId,
        attemptId: facts.attemptId,
        sessionBindingId: '',
        lastTranscriptRef: null,
        terminalReceiptRef: facts.terminalReceiptRef,
        transcriptReferenceable: false,
        recordedAt: facts.recordedAt,
      },
    };
  }
  const transcriptReferenceable = facts.lastTranscriptRef !== null;
  const segment: SessionSegmentDraft = {
    role: facts.role,
    workerTaskId: facts.workerTaskId,
    dispatchId: facts.dispatchId,
    attemptId: facts.attemptId,
    sessionBindingId: facts.sessionBindingId,
    lastTranscriptRef: facts.lastTranscriptRef,
    terminalReceiptRef: facts.terminalReceiptRef,
    transcriptReferenceable,
    recordedAt: facts.recordedAt,
  };
  if (!transcriptReferenceable) {
    return {
      kind: 'blocked',
      reason: '原 harness session 的 transcript 已无法引用，中断事实只能阻塞',
      segment,
    };
  }
  return { kind: 'segment-recorded', segment };
}

/** Session Segment 事实绝不携带 Recovery Budget 计数；用于断言与投影。 */
export function sessionSegmentCarriesRecoveryBudget(segment: SessionSegmentDraft): boolean {
  return Object.hasOwn(segment, 'recoveryBudget') || Object.hasOwn(segment, 'consumedBudget');
}
