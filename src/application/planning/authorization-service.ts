/**
 * IC-05：Execution Authorization 的组装、批准与读取
 * （Owner: `m1-plan-and-authorize-execution`）。
 *
 * 批准是对某一份确切 Manifest 的一次用户决定，因此这里做两件事：提交批准之前校验完整性，以及
 * 把批准记录成带版本与内容指纹的持久事实。任何字段缺失、引用不一致或候选图已经变化都让批准在
 * 产生授权之前失败，绝不产生部分授权（D7/D9）。
 *
 * 发布与部署不在授权范围内（D10）：`authorizeOperation` 把它们判为需要单独授权，而不是由调用方
 * 自觉遵守。
 */

import {
  authorizeOperation,
  manifestCandidateMismatches,
  manifestFingerprint,
  parseManifest,
  assembleManifest,
  type AuthorizationDecision,
  type ExecutionAuthorizationManifest,
  type ExecutionAuthorizationRecord,
} from '../../domain/planning/execution-authorization.js';
import type { GraphVersionRecord } from '../../domain/planning/execution-graph.js';
import type { CoordinationScopeId } from '../dto/identity.js';
import type {
  BranchCoordinationStore,
  CoordinationCommandRejection,
  CoordinationWriter,
} from '../ports/branch-coordination-store.js';
import { readScope } from './scope-read.js';

export type AuthorizationFailure = {
  readonly code: string;
  readonly message: string;
};

function rejectionMessage(rejection: CoordinationCommandRejection): string {
  return rejection.message;
}

export type ScopeAuthorizationRead =
  | { readonly kind: 'read'; readonly authorization: ExecutionAuthorizationRecord | null }
  | { readonly kind: 'rejected'; readonly failure: AuthorizationFailure };

/** 读取 Scope 当前生效的授权；指针为空表示还没有任何批准。 */
export function activeAuthorization(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
): ScopeAuthorizationRead {
  const scope = readScope(store, coordinationScopeId);
  if (scope.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: scope.code, message: scope.message } };
  }
  if (scope.scope.authorizationId === null) {
    return { kind: 'read', authorization: null };
  }
  const record = store.query({
    kind: 'authorization',
    coordinationScopeId,
    authorizationId: scope.scope.authorizationId,
  });
  if (record.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: record.code, message: record.message } };
  }
  if (record.kind !== 'authorization') {
    return { kind: 'rejected', failure: { code: 'invalid_state', message: '无法读取 Execution Authorization' } };
  }
  return { kind: 'read', authorization: record.authorization };
}

export type ProposeManifestInput = {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  /** 用户/Coordinator 提供的原始字段；缺失项由组装阶段补默认值，其余仍走严格解析。 */
  readonly rawManifest: unknown;
  /** 本次批准要绑定的候选图 head。 */
  readonly candidate: GraphVersionRecord;
  /** 当前计划 revision；与候选图记录里的 planRevision 不一致即说明计划已经变化。 */
  readonly currentPlanRevision: number;
};

export type ProposeManifestResult =
  | {
      readonly kind: 'proposed';
      readonly manifest: ExecutionAuthorizationManifest;
      readonly fingerprint: string;
    }
  | { readonly kind: 'rejected'; readonly failure: AuthorizationFailure };

/**
 * 组装并校验一份待批准 Manifest。
 *
 * 校验的是「这份 Manifest 描述的就是这份候选图」：Scope、GraphId、世代、GraphVersion、地图
 * revision 与计划 revision 必须逐项对应；不一致时在提交批准之前失败，并且不写任何记录。
 */
export function proposeManifest(input: ProposeManifestInput): ProposeManifestResult {
  const assembled = assembleManifest(input.rawManifest);
  if (!assembled.ok) {
    return { kind: 'rejected', failure: { code: assembled.field, message: assembled.message } };
  }
  const manifest = assembled.value;
  const scope = readScope(input.store, input.coordinationScopeId);
  if (scope.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: scope.code, message: scope.message } };
  }
  if (manifest.coordinationScopeId !== input.coordinationScopeId) {
    return {
      kind: 'rejected',
      failure: { code: 'scope_mismatch', message: 'Manifest 的 Coordination Scope 与目标 Scope 不一致' },
    };
  }
  const mismatches = [...manifestCandidateMismatches(manifest, input.candidate)];
  if (manifest.implementationPlanRef.version !== input.currentPlanRevision) {
    mismatches.push('currentImplementationPlanRevision');
  }
  if (manifest.planningCycleId !== scope.scope.planningCycleId) {
    mismatches.push('planningCycleId');
  }
  if (manifest.routeMapRef.version !== scope.scope.mapRevision) {
    mismatches.push('currentRouteMapRevision');
  }
  if (mismatches.length > 0) {
    return {
      kind: 'rejected',
      failure: {
        code: 'candidate_mismatch',
        message: `Manifest 与候选图不一致：${mismatches.join('、')}`,
      },
    };
  }
  return { kind: 'proposed', manifest, fingerprint: manifestFingerprint(manifest) };
}

export type RecordApprovalInput = {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly writer: CoordinationWriter;
  readonly authorizationId: string;
  readonly manifest: ExecutionAuthorizationManifest;
  readonly currentPlanRevision: number;
  /** 用户批准的可引用来源（例如一次确认交互的 ID）。 */
  readonly approvalRef: string;
};

export type RecordApprovalResult =
  | { readonly kind: 'recorded'; readonly authorization: ExecutionAuthorizationRecord }
  | { readonly kind: 'rejected'; readonly failure: AuthorizationFailure };

/**
 * 记录一次用户批准。
 *
 * 授权版本由 store 按 Scope 单调分配，指纹由 Manifest 内容计算；两者都落盘，因此「同一内容重复
 * 批准」与「内容变化后重新批准」在记录上可区分。
 */
export function recordApproval(input: RecordApprovalInput): RecordApprovalResult {
  const scope = readScope(input.store, input.coordinationScopeId);
  if (scope.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: scope.code, message: scope.message } };
  }
  if (scope.scope.graphId === null || scope.scope.graphVersion === null) {
    return {
      kind: 'rejected',
      failure: { code: 'candidate_missing', message: '该 Scope 尚无候选图，不能批准 Manifest' },
    };
  }
  const parsedManifest = parseManifest(input.manifest);
  if (!parsedManifest.ok) {
    return { kind: 'rejected', failure: { code: parsedManifest.field, message: parsedManifest.message } };
  }
  const manifest = parsedManifest.value;
  const candidate = input.store.query({
    kind: 'graph-version',
    coordinationScopeId: input.coordinationScopeId,
    graphId: scope.scope.graphId,
    graphVersion: scope.scope.graphVersion,
  });
  if (candidate.kind !== 'graph-version' || candidate.version === null) {
    return {
      kind: 'rejected',
      failure: { code: candidate.kind === 'rejected' ? candidate.code : 'candidate_missing', message: candidate.kind === 'rejected' ? candidate.message : '当前候选图无法读回' },
    };
  }
  const mismatches = [...manifestCandidateMismatches(manifest, candidate.version)];
  if (manifest.coordinationScopeId !== input.coordinationScopeId) mismatches.push('coordinationScopeId');
  if (manifest.planningCycleId !== scope.scope.planningCycleId) mismatches.push('planningCycleId');
  if (manifest.routeMapRef.version !== scope.scope.mapRevision) mismatches.push('currentRouteMapRevision');
  if (manifest.implementationPlanRef.version !== input.currentPlanRevision) {
    mismatches.push('currentImplementationPlanRevision');
  }
  if (mismatches.length > 0) {
    return {
      kind: 'rejected',
      failure: { code: 'candidate_mismatch', message: `Manifest 与当前候选图不一致：${mismatches.join('、')}` },
    };
  }

  const existing = input.store.query({
    kind: 'authorizations',
    coordinationScopeId: input.coordinationScopeId,
  });
  if (existing.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: existing.code, message: existing.message } };
  }
  if (existing.kind !== 'authorizations') {
    return { kind: 'rejected', failure: { code: 'invalid_state', message: '无法读取既有授权记录' } };
  }
  const authorizationVersion = (existing.authorizations.at(-1)?.authorizationVersion ?? 0) + 1;

  const recorded = input.store.transact({
    kind: 'record-authorization',
    coordinationScopeId: input.coordinationScopeId,
    expectedRevision: scope.scope.revision,
    writer: input.writer,
    authorizationId: input.authorizationId,
    authorizationVersion,
    manifestVersion: manifest.manifestVersion,
    fingerprint: manifestFingerprint(manifest),
    approvalRef: input.approvalRef,
    manifest,
  });
  if (recorded.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: recorded.code, message: rejectionMessage(recorded) } };
  }

  const read = activeAuthorization(input.store, input.coordinationScopeId);
  if (read.kind === 'rejected') {
    return { kind: 'rejected', failure: read.failure };
  }
  if (read.authorization === null) {
    return {
      kind: 'rejected',
      failure: { code: 'invalid_state', message: '授权记录写入后无法读回' },
    };
  }
  return { kind: 'recorded', authorization: read.authorization };
}

/** 判定一次操作是否落在已批准 Manifest 的策略内；发布与部署永远需要单独授权。 */
export function assertAuthorized(input: {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly category: string;
  readonly role?: ExecutionAuthorizationManifest['workerProfiles'][number]['role'];
}):
  | { readonly kind: 'read'; readonly decision: AuthorizationDecision }
  | { readonly kind: 'rejected'; readonly failure: AuthorizationFailure } {
  const read = activeAuthorization(input.store, input.coordinationScopeId);
  if (read.kind === 'rejected') {
    return { kind: 'rejected', failure: read.failure };
  }
  return {
    kind: 'read',
    decision: authorizeOperation({
      authorization: read.authorization,
      category: input.category,
      ...(input.role === undefined ? {} : { role: input.role }),
    }),
  };
}

/** Manifest 绑定的单次 Worker Attempt 恢复上限；没有授权时返回 `null`，不猜默认值。 */
export function maxRecoveriesFor(
  authorization: ExecutionAuthorizationRecord | null,
): number | null {
  return authorization === null ? null : authorization.manifest.limits.maxRecoveriesPerWorkerAttempt;
}

export type RecoveryAllowance =
  | { readonly kind: 'available'; readonly remaining: number }
  | { readonly kind: 'exhausted'; readonly limit: number }
  | { readonly kind: 'not_authorized'; readonly reason: string };

/**
 * 单个 Worker Attempt 还能恢复几次。
 *
 * 上限只来自已批准的 Manifest：耗尽即停止并升级，执行阶段没有放宽它的路径；需要更多恢复次数时
 * 必须产生新版本 Manifest 并重新取得用户批准。
 */
export function recoveryAllowance(input: {
  readonly authorization: ExecutionAuthorizationRecord | null;
  readonly usedRecoveries: number;
}): RecoveryAllowance {
  const limit = maxRecoveriesFor(input.authorization);
  if (limit === null) {
    return { kind: 'not_authorized', reason: '尚不存在有效的 Execution Authorization' };
  }
  if (!Number.isSafeInteger(input.usedRecoveries) || input.usedRecoveries < 0) {
    return { kind: 'not_authorized', reason: 'usedRecoveries 必须是非负整数' };
  }
  const remaining = limit - input.usedRecoveries;
  return remaining > 0 ? { kind: 'available', remaining } : { kind: 'exhausted', limit };
}

/**
 * 初始化路径的守卫：Scope 创建阶段不得出现任何 Execution Authorization。
 *
 * 这是只读断言，供初始化用例在写入后自检：新 Scope 没有任何批准记录，也没有预算计数——预算、
 * 权限与 accepted risks 只能随 Execution Authorization Manifest 一起出现。
 *
 * Scope 缺失或读不回来时返回 `false`：这时无法证明「不存在执行策略」，fail closed 比乐观断言安全。
 */
export function executionPolicyIsAbsent(input: {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
}): boolean {
  const scope = readScope(input.store, input.coordinationScopeId);
  if (scope.kind === 'rejected') {
    return false;
  }
  const counters = input.store.query({
    kind: 'budget-counters',
    coordinationScopeId: input.coordinationScopeId,
  });
  const countersEmpty = counters.kind === 'budget-counters' && counters.counters.length === 0;
  return scope.scope.authorizationId === null && scope.scope.authorizationVersion === null && countersEmpty;
}
