/**
 * IC-04 的 Wake Batch 恢复准入用例
 * （Owner: `m1-run-coordinator-sessions`）。
 *
 * 恢复模型的顺序是固定的：取得 Runtime Lease → 收集有界 Actionable Work → 以稳定 WakeBatchId
 * 同步写入 checkpoint → 再按 source revision 记录准入 → 才调用模型循环。checkpoint store 与
 * Branch Coordination Store 之间没有跨库事务，所以本模块不伪造原子性：它把「已写 checkpoint、
 * 未记 admission」和「同一批 source revision 换了 batch ID 再来一次」都当作可判定的中间态，
 * 用稳定 batch ID 与 source revision 补齐，而不是重复注入。
 *
 * 任一写入失败都在调用模型循环之前结束本次尝试。
 */

import type { CoordinatorSessionState, SourceRevisionRef, WakeBatch } from '../../domain/coordinator/session-state.js';
import type { CoordinationScopeId, CoordinatorSessionId } from '../dto/identity.js';
import {
  assertFencingGeneration,
  writerFor,
  type CoordinatorIncarnation,
} from './runtime-guard.js';
import type {
  BranchCoordinationStore,
  CoordinationCommandRejection,
  WakeAdmissionRecord,
} from '../ports/branch-coordination-store.js';

/**
 * checkpoint 侧的 Wake Batch 写入 seam。
 *
 * 契约有三条：写入是同步且耐久的；同一 WakeBatchId 不会被写入两次；已包含该 batch 时以
 * `already-committed` 报告，让调用方走补齐路径而不是重新注入。
 */
export type WakeCheckpointPort = {
  readonly commitWakeBatch: (batch: WakeBatch) => WakeCheckpointCommit;
};

export type WakeCheckpointCommit =
  | { readonly kind: 'committed'; readonly state: CoordinatorSessionState }
  | { readonly kind: 'already-committed'; readonly state: CoordinatorSessionState }
  | { readonly kind: 'unrecoverable'; readonly reason: string };

export type WakeAdmissionRequest = {
  readonly wakeBatch: WakeBatch;
  /** 只能来自 `acquireIncarnation` / `resumeIncarnation`；模型与 Worker 不可填写。 */
  readonly incarnation: CoordinatorIncarnation;
  readonly checkpoints: WakeCheckpointPort;
  readonly clock?: () => number;
};

export type WakeAdmissionOutcome =
  | { readonly kind: 'admitted'; readonly record: WakeAdmissionRecord; readonly state: CoordinatorSessionState }
  /** 崩溃补齐：checkpoint 里已有该 batch，本次只补记准入。 */
  | { readonly kind: 'repaired'; readonly record: WakeAdmissionRecord; readonly state: CoordinatorSessionState }
  /** 该工作已经以其它 batch 准入过，或本 batch 已准入：模型循环不得再次注入。 */
  | { readonly kind: 'already-admitted'; readonly record: WakeAdmissionRecord }
  /** checkpoint 不可恢复：fail closed，不记准入、不调用模型。 */
  | { readonly kind: 'blocked'; readonly reason: string }
  | { readonly kind: 'rejected'; readonly rejection: CoordinationCommandRejection };

/**
 * 一条 source revision 的稳定准入身份。
 *
 * 用 NUL 分隔而不是冒号：source kind 与 id 都可能自带分隔符，拼接出的字符串必须无歧义，
 * 否则两条不同的 revision 会被误判成同一条。
 */
export function admissionKeyFor(source: SourceRevisionRef): string {
  return `${source.sourceKind}\u0000${source.sourceId}\u0000${source.revision}`;
}

function readAdmissions(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
  coordinatorSessionId: CoordinatorSessionId,
): readonly WakeAdmissionRecord[] {
  const result = store.query({ kind: 'wake-admissions', coordinationScopeId, coordinatorSessionId });
  return result.kind === 'wake-admissions' ? result.admissions : [];
}

function readAdmission(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
  coordinatorSessionId: CoordinatorSessionId,
  wakeBatchId: string,
): WakeAdmissionRecord | null {
  return (
    readAdmissions(store, coordinationScopeId, coordinatorSessionId).find(
      (record) => record.wakeBatchId === wakeBatchId,
    ) ?? null
  );
}

function readScopeRevision(store: BranchCoordinationStore, coordinationScopeId: CoordinationScopeId): number {
  const result = store.query({ kind: 'scope', coordinationScopeId });
  return result.kind === 'scope' && result.scope !== null ? result.scope.revision : 0;
}

/**
 * 把一份 Wake Batch 准入到 Session 历史。
 *
 * 返回 `already-admitted` 时调用方不得再调用模型循环；返回 `blocked` 或 `rejected` 时本次恢复
 * 尝试结束，Session 保持原状等待处理。
 */
export function admitWakeBatch(
  store: BranchCoordinationStore,
  request: WakeAdmissionRequest,
): WakeAdmissionOutcome {
  const { wakeBatch, incarnation } = request;
  const coordinationScopeId = incarnation.coordinationScopeId;
  const coordinatorSessionId = incarnation.coordinatorSessionId;

  if (wakeBatch.coordinationScopeId !== coordinationScopeId) {
    return {
      kind: 'rejected',
      rejection: {
        kind: 'rejected',
        code: 'invalid_state',
        message: 'Wake Batch 的 Coordination Scope 与当前 incarnation 不一致',
      },
    };
  }
  if (wakeBatch.coordinatorSessionId !== coordinatorSessionId) {
    return {
      kind: 'rejected',
      rejection: {
        kind: 'rejected',
        code: 'invalid_state',
        message: 'Wake Batch 的目标 Session 与当前 incarnation 不一致',
      },
    };
  }

  const existing = readAdmission(store, coordinationScopeId, coordinatorSessionId, wakeBatch.wakeBatchId);
  if (existing !== null) {
    return { kind: 'already-admitted', record: existing };
  }

  // source revision 已经在别的 batch 里准入过：这是补齐路径，不是新的工作。
  if (wakeBatch.sourceRevisions.length > 0) {
    const admittedKeys = new Set(
      readAdmissions(store, coordinationScopeId, coordinatorSessionId).flatMap((record) =>
        record.sourceRevisions.map((source) => admissionKeyFor(source)),
      ),
    );
    const fresh = wakeBatch.sourceRevisions.filter((source) => !admittedKeys.has(admissionKeyFor(source)));
    if (fresh.length === 0) {
      const prior = readAdmissions(store, coordinationScopeId, coordinatorSessionId).find((record) =>
        record.sourceRevisions.some((source) => admittedKeys.has(admissionKeyFor(source))),
      );
      if (prior !== undefined) {
        return { kind: 'already-admitted', record: prior };
      }
    }
  }

  // 写入 checkpoint 是副作用；先确认本 incarnation 仍然有效。
  const fencing = assertFencingGeneration(store, incarnation, {
    ...(request.clock === undefined ? {} : { clock: request.clock }),
  });
  if (fencing.kind === 'fenced') {
    return {
      kind: 'rejected',
      rejection: {
        kind: 'rejected',
        code: 'fenced',
        message: `写入 Wake Batch 前已被 fencing 拒绝（${fencing.code}）`,
      },
    };
  }

  const commit = request.checkpoints.commitWakeBatch(wakeBatch);
  if (commit.kind === 'unrecoverable') {
    return { kind: 'blocked', reason: commit.reason };
  }

  const admissionState = commit.kind === 'already-committed' ? 'repaired' : 'admitted';
  const written = store.transact({
    kind: 'record-wake-admission',
    coordinationScopeId,
    expectedRevision: readScopeRevision(store, coordinationScopeId),
    writer: writerFor(incarnation),
    wakeBatchId: wakeBatch.wakeBatchId,
    admissionState,
    sourceRevisions: wakeBatch.sourceRevisions,
  });
  if (written.kind === 'rejected') {
    // 并发或重放落在同一 batch 上：以只读查询还原事实，不换 ID 重试。
    const raced = readAdmission(store, coordinationScopeId, coordinatorSessionId, wakeBatch.wakeBatchId);
    if (raced !== null) {
      return { kind: 'already-admitted', record: raced };
    }
    return { kind: 'rejected', rejection: written };
  }

  const record = readAdmission(store, coordinationScopeId, coordinatorSessionId, wakeBatch.wakeBatchId);
  if (record === null) {
    return {
      kind: 'rejected',
      rejection: { kind: 'rejected', code: 'invalid_state', message: '准入写入后无法读回记录' },
    };
  }
  return admissionState === 'repaired'
    ? { kind: 'repaired', record, state: commit.state }
    : { kind: 'admitted', record, state: commit.state };
}
