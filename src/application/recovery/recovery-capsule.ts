/**
 * IC-09 / IP-8：Recovery Capsule 的提取契约（Owner: `m1-recover-execution`）。
 *
 * Recovery Capsule 只由一个受限 Utility Worker 通过 Task Envelope 从**精确 transcript**提取产生；
 * 真实派发在 `src/adapters/agents/utility-worker.ts`，本模块只拥有结论契约与「同一 Recovery
 * Operation 内最多安全重派一次」的编排。
 *
 * 两点边界：
 * - Utility Worker MUST NOT 递归触发新的 Recovery：本模块不接触 store、不创建 Recovery、不消耗
 *   Recovery Budget，重派只发生在同一次提取调用内部；
 * - Recovery Capsule 与 Coordinator Context Capsule 是两种东西：前者压缩中断的 Worker Session
 *   Segment，后者服务 Coordinator 历史迁移，二者类型与消费者都不重叠。
 *
 * 结论闭集为 `complete | partial`：`partial` 必须列出精确可读范围、缺口、最后一个完整事件、
 * 未闭合动作、逐项来源与 unknowns；transcript 不可用时 Recovery 以 `transcript_unavailable`
 * 失败并阻塞，绝不猜测上下文。
 */

import type {
  CoordinationScopeId,
  SessionSegmentId,
  WorkerTaskId,
} from '../dto/identity.js';
import type { WorkerRole } from '../../domain/planning/execution-authorization.js';

export const RECOVERY_CAPSULE_COVERAGE = ['complete', 'partial'] as const;

export type RecoveryCapsuleCoverage = (typeof RECOVERY_CAPSULE_COVERAGE)[number];

/** 精确可读范围：两端都可能缺失，因此它是「能读到什么」的事实，不是保证。 */
export type TranscriptRange = {
  readonly transcriptRef: string;
  readonly fromEventRef: string | null;
  readonly toEventRef: string | null;
};

/** 一段读不到的区间；`toEventRef` 为 `null` 表示缺口一直延续到 transcript 末尾。 */
export type TranscriptGap = {
  readonly fromEventRef: string;
  readonly toEventRef: string | null;
  readonly reason: string;
};

/** 未闭合动作；`sourceRef` 是该结论的逐项来源。 */
export type OpenAction = {
  readonly actionRef: string;
  readonly description: string;
  readonly sourceRef: string;
};

/**
 * IC-09 的 `RecoveryCapsule`。
 *
 * 六个「结论字段」始终存在：`readableRange`、`gaps`、`lastCompleteEventRef`、`openActions`、
 * `sourceRefs`、`unknowns`。`partial` 时 `lastCompleteEventRef` 必须非空，因为替代 Session 需要
 * 一个确定的重放锚点。
 */
export type RecoveryCapsule = {
  readonly coverage: RecoveryCapsuleCoverage;
  readonly readableRange: TranscriptRange;
  readonly gaps: readonly TranscriptGap[];
  readonly lastCompleteEventRef: string | null;
  readonly openActions: readonly OpenAction[];
  readonly sourceRefs: readonly string[];
  readonly unknowns: readonly string[];
};

/** Adapter 对 transcript 实际可读边界的证明；Utility Worker 不能覆盖这些字段。 */
export type TranscriptCoverageEvidence = Pick<
  RecoveryCapsule,
  'coverage' | 'readableRange' | 'gaps' | 'lastCompleteEventRef'
>;

export type CapsuleValidation = { readonly ok: true } | { readonly ok: false; readonly reason: string };

function isNonEmpty(value: string | null): value is string {
  return value !== null && value.length > 0;
}

/**
 * 校验 Capsule 结论是否自足。
 *
 * `complete` 不允许声明缺口；`partial` 必须给出有界可读范围、非空缺口、最后完整事件与至少一条逐项
 * 来源。`complete` 与 `partial` 的字段集合相同，只有这些内容约束不同。
 */
export function validateRecoveryCapsule(capsule: RecoveryCapsule): CapsuleValidation {
  if (!isNonEmpty(capsule.readableRange.transcriptRef)) {
    return { ok: false, reason: 'readableRange.transcriptRef 缺失' };
  }
  if (!isNonEmpty(capsule.readableRange.fromEventRef) || !isNonEmpty(capsule.readableRange.toEventRef)) {
    return { ok: false, reason: '可读范围必须有明确起止事件' };
  }
  if (capsule.coverage === 'complete') {
    if (capsule.gaps.length > 0) {
      return { ok: false, reason: 'complete Capsule 不得声明缺口' };
    }
    return { ok: true };
  }
  if (capsule.gaps.length === 0) {
    return { ok: false, reason: 'partial Capsule 必须列出缺口' };
  }
  if (!isNonEmpty(capsule.lastCompleteEventRef)) {
    return { ok: false, reason: 'partial Capsule 必须给出最后一个完整事件' };
  }
  if (capsule.sourceRefs.length === 0) {
    return { ok: false, reason: 'partial Capsule 必须逐项给出结论来源' };
  }
  return { ok: true };
}

/** Utility Worker 报告的 coverage 必须逐项等于 Adapter 的读取事实。 */
export function validateTranscriptCoverage(
  capsule: RecoveryCapsule,
  evidence: TranscriptCoverageEvidence,
): CapsuleValidation {
  const matches =
    capsule.coverage === evidence.coverage &&
    capsule.readableRange.transcriptRef === evidence.readableRange.transcriptRef &&
    capsule.readableRange.fromEventRef === evidence.readableRange.fromEventRef &&
    capsule.readableRange.toEventRef === evidence.readableRange.toEventRef &&
    capsule.lastCompleteEventRef === evidence.lastCompleteEventRef &&
    capsule.gaps.length === evidence.gaps.length &&
    capsule.gaps.every((gap, index) => {
      const expected = evidence.gaps[index];
      return (
        expected !== undefined &&
        gap.fromEventRef === expected.fromEventRef &&
        gap.toEventRef === expected.toEventRef &&
        gap.reason === expected.reason
      );
    });
  return matches
    ? { ok: true }
    : { ok: false, reason: 'Utility Worker 报告的 coverage 与 Adapter 读取证据不一致' };
}

/** Capsule 正文不进 coordination store；记录里只保存这个稳定引用。 */
export function capsuleRefOf(recoveryId: string): string {
  return `recovery-capsule:${recoveryId}`;
}

export type CapsuleExtractionRequest = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly role: WorkerRole;
  readonly workPackageId: string;
  readonly workerTaskId: WorkerTaskId;
  readonly attemptId: string;
  readonly segmentId: SessionSegmentId;
  /** 中断 Segment 的精确 transcript 来源；不是「最近一次输出」。 */
  readonly transcriptRef: string;
};

export type CapsuleExtractionOutcome =
  | { readonly kind: 'extracted'; readonly capsule: RecoveryCapsule }
  | { readonly kind: 'transcript_unavailable'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string };

/** 受限 Utility Worker 的提取 seam；真实实现是 `src/adapters/agents/utility-worker.ts`。 */
export type RecoveryCapsuleExtractor = (
  request: CapsuleExtractionRequest,
) => Promise<CapsuleExtractionOutcome>;

/** 首次尝试 + 同一 Recovery Operation 内一次安全重派。 */
export const RECOVERY_CAPSULE_MAX_ATTEMPTS = 2;

export type RecoveryCapsuleOutcome =
  | { readonly kind: 'complete'; readonly capsule: RecoveryCapsule; readonly attempts: number }
  | { readonly kind: 'partial'; readonly capsule: RecoveryCapsule; readonly attempts: number }
  | { readonly kind: 'transcript_unavailable'; readonly attempts: number; readonly reason: string }
  | { readonly kind: 'failed'; readonly attempts: number; readonly reason: string };

/**
 * 提取 Capsule。
 *
 * `transcript_unavailable` 是确定性结论，立即返回而不重派（重派读的还是同一份 transcript）。
 * `failed` 或不可用的 Capsule 允许在同一 Recovery Operation 内再派一次；第二次仍失败即整体失败，
 * 这里不会、也不能启动第二个 Recovery。
 */
export async function extractRecoveryCapsule(input: {
  readonly extract: RecoveryCapsuleExtractor;
  readonly request: CapsuleExtractionRequest;
}): Promise<RecoveryCapsuleOutcome> {
  let attempts = 0;
  let lastReason = 'Utility Worker 未能给出可用 Capsule';
  while (attempts < RECOVERY_CAPSULE_MAX_ATTEMPTS) {
    attempts += 1;
    const outcome = await input.extract(input.request);
    if (outcome.kind === 'transcript_unavailable') {
      return { kind: 'transcript_unavailable', attempts, reason: outcome.reason };
    }
    if (outcome.kind === 'failed') {
      lastReason = outcome.reason;
      continue;
    }
    const validation = validateRecoveryCapsule(outcome.capsule);
    if (!validation.ok) {
      lastReason = `Recovery Capsule 结论不完整：${validation.reason}`;
      continue;
    }
    return { kind: outcome.capsule.coverage, capsule: outcome.capsule, attempts };
  }
  return { kind: 'failed', attempts, reason: lastReason };
}
