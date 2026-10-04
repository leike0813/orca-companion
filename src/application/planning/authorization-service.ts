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
  type RecoveryUtilityProfile,
  type WorkerProfileRef,
} from '../../domain/planning/execution-authorization.js';
import type { GraphVersionRecord } from '../../domain/planning/execution-graph.js';
import { UNRESOLVED_INTENT_STATES } from '../../domain/recovery/operation-intent.js';
import type { CoordinationScopeId, GraphVersion, Revision } from '../dto/identity.js';
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

/**
 * 按内容指纹回读一份已经受理的授权。
 *
 * 宿主只拿到用户在审阅里看到的指纹与 revision：重放同一次批准时，按当前配置重新组装的 Manifest 可能已经
 * 变了内容，因此「按指纹回读原记录」是唯一既能幂等、又不改写载荷的路径。查历史而不是当前指针，
 * 这样指针被后续授权替换后，旧审阅仍然回到它自己的记录，既不产生写入也不移动指针。
 */
export function readAcceptedAuthorizationByFingerprint(input: {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly fingerprint: string;
}): ExecutionAuthorizationRecord | null {
  const history = input.store.query({
    kind: 'authorizations',
    coordinationScopeId: input.coordinationScopeId,
  });
  if (history.kind !== 'authorizations') {
    return null;
  }
  return history.authorizations.find((record) => record.fingerprint === input.fingerprint) ?? null;
}

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

/** 模型限定的重新授权所接受的输入；除模型绑定与 Graph head 外没有任何可改字段。 */
export type ModelReauthorizationInput = {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly writer: CoordinationWriter;
  /** 审阅时读到的 Scope revision；落盘前不一致即说明这份审阅已经过期。 */
  readonly expectedScopeRevision: Revision;
  readonly workerProfiles: readonly WorkerProfileRef[];
  readonly recoveryUtilityProfile: RecoveryUtilityProfile;
  /** 实际 Graph head version；授权必须绑定它，而不是沿用批准时的旧版本。 */
  readonly graphVersion: GraphVersion;
  /** 调用方按完整指纹派生的授权 ID；相同内容因此得到相同 ID，不同内容不会碰撞。 */
  readonly authorizationId: string;
  readonly approvalRef: string;
};

/**
 * 以当前授权为基底拼出模型限定的新 Manifest。
 *
 * 只有三个字段可变：角色 profiles、Recovery Utility profile 与 Graph head version。权限、上限、
 * 政策、accepted risks、baseline HEAD、Run 与三个版本化引用原样继承——因此这次批准不重置任何预算，
 * 也不构成 Graph Revision。
 */
export function modelReauthorizationManifest(input: {
  readonly base: ExecutionAuthorizationManifest;
  readonly workerProfiles: readonly WorkerProfileRef[];
  readonly recoveryUtilityProfile: RecoveryUtilityProfile;
  readonly graphVersion: GraphVersion;
}): ProposeManifestResult {
  const parsed = parseManifest({
    ...input.base,
    graph: { ...input.base.graph, version: input.graphVersion },
    workerProfiles: input.workerProfiles,
    recoveryUtilityProfile: input.recoveryUtilityProfile,
  });
  if (!parsed.ok) {
    return { kind: 'rejected', failure: { code: parsed.field, message: parsed.message } };
  }
  return { kind: 'proposed', manifest: parsed.value, fingerprint: manifestFingerprint(parsed.value) };
}

/**
 * 重新授权的准入条件：必须处在可执行协调态，且没有任何未决的副作用。
 *
 * `cancelling` / `cancelled` / `unverifiable` 期间模型切换会与停止流程竞态，`replanning_transition`
 * 期间代际正在交接，此时的新授权没有稳定的 Graph head 与 scope 语义，两者都直接拒绝。
 */
const REJECTED_CONTROL_STATES = ['cancelling', 'cancelled', 'unverifiable', 'replanning_transition'] as const;

/**
 * 这次重新授权是否已经被受理过。
 *
 * 受理过的授权 ID 由完整指纹派生，所以命中历史记录之后还要按同一载荷重算指纹：ID 相同不构成证据，
 * 异载荷重放必须被拒绝而不是被当成已受理。返回既有记录本身，不写任何东西、不推进 Scope 指针。
 */
function readAcceptedReauthorization(input: ModelReauthorizationInput): RecordApprovalResult | null {
  const history = input.store.query({ kind: 'authorizations', coordinationScopeId: input.coordinationScopeId });
  if (history.kind === 'rejected' || history.kind !== 'authorizations') {
    return null;
  }
  const accepted = history.authorizations.find((record) => record.authorizationId === input.authorizationId);
  if (accepted === undefined) {
    return null;
  }
  const rebuilt = modelReauthorizationManifest({
    base: accepted.manifest,
    workerProfiles: input.workerProfiles,
    recoveryUtilityProfile: input.recoveryUtilityProfile,
    graphVersion: input.graphVersion,
  });
  if (rebuilt.kind !== 'proposed' || rebuilt.fingerprint !== accepted.fingerprint) {
    return {
      kind: 'rejected',
      failure: {
        code: 'authorization_payload_mismatch',
        message: `授权 ${input.authorizationId} 已受理另一份内容：不能以异载荷重放`,
      },
    };
  }
  return { kind: 'recorded', authorization: accepted };
}

/**
 * 记录一次模型限定的重新授权。
 *
 * 复用既有授权事务：Scope revision CAS、单调授权版本与完整内容指纹都在 `record-authorization`
 * 内完成，因此重新授权与首次授权在持久事实里是同一类记录，读取方无需区分路径。
 */
export function recordModelReauthorization(input: ModelReauthorizationInput): RecordApprovalResult {
  const scope = readScope(input.store, input.coordinationScopeId);
  if (scope.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: scope.code, message: scope.message } };
  }
  // 重放先于一切门禁：同一份已受理的决定必须总能回读到它的记录，哪怕 Scope 之后进入 cancelling、
  // 出现未决 mutation，或当前指针已经指向更新的授权。分支只做只读查询，既不写记录也不动指针。
  const replayed = readAcceptedReauthorization(input);
  if (replayed !== null) {
    return replayed;
  }
  if (scope.scope.mode !== 'execution_coordination') {
    return {
      kind: 'rejected',
      failure: { code: 'invalid_mode', message: '模型重新授权只在 Execution Coordination 下成立' },
    };
  }
  if ((REJECTED_CONTROL_STATES as readonly string[]).includes(scope.scope.controlState)) {
    return {
      kind: 'rejected',
      failure: {
        code: scope.scope.controlState === 'replanning_transition' ? 'replanning' : 'scope_not_executable',
        message: `控制状态 ${scope.scope.controlState} 下不接受模型重新授权`,
      },
    };
  }
  const unresolved = UNRESOLVED_INTENT_STATES.map((intentState) => input.store.query({
    kind: 'intents',
    coordinationScopeId: input.coordinationScopeId,
    intentState,
  }));
  for (const intents of unresolved) {
    if (intents.kind === 'rejected') {
      return { kind: 'rejected', failure: { code: intents.code, message: intents.message } };
    }
    if (intents.kind !== 'intents') {
      return { kind: 'rejected', failure: { code: 'invalid_state', message: '无法读取未决 Operation Intent' } };
    }
    if (intents.intents.length > 0) {
      return {
        kind: 'rejected',
        failure: {
          code: 'pending_mutation',
          message: `仍有 ${intents.intents.length} 个未决 Operation Intent：先结清再重新授权`,
        },
      };
    }
  }

  const current = activeAuthorization(input.store, input.coordinationScopeId);
  if (current.kind === 'rejected') {
    return { kind: 'rejected', failure: current.failure };
  }
  if (current.authorization === null) {
    return { kind: 'rejected', failure: { code: 'not_authorized', message: '尚不存在可重新授权的 Execution Authorization' } };
  }
  if (scope.scope.revision !== input.expectedScopeRevision) {
    return {
      kind: 'rejected',
      failure: {
        code: 'stale_review',
        message: `审阅后的 Scope 已变化（${input.expectedScopeRevision} → ${scope.scope.revision}）：请重新审阅`,
      },
    };
  }
  const rebuilt = modelReauthorizationManifest({
    base: current.authorization.manifest,
    workerProfiles: input.workerProfiles,
    recoveryUtilityProfile: input.recoveryUtilityProfile,
    graphVersion: input.graphVersion,
  });
  if (rebuilt.kind === 'rejected') {
    return rebuilt;
  }
  return recordApproval({
    store: input.store,
    coordinationScopeId: input.coordinationScopeId,
    writer: input.writer,
    authorizationId: input.authorizationId,
    manifest: rebuilt.manifest,
    // 计划 revision 属于不可改字段：沿用基底里的值，让 recordApproval 仍能对当前计划做核对。
    currentPlanRevision: current.authorization.manifest.implementationPlanRef.version,
    approvalRef: input.approvalRef,
  });
}

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
  const parsedManifest = parseManifest(input.manifest);
  if (!parsedManifest.ok) {
    return { kind: 'rejected', failure: { code: parsedManifest.field, message: parsedManifest.message } };
  }
  const manifest = parsedManifest.value;
  if (scope.scope.graphId !== null && manifest.graph.graphId !== scope.scope.graphId) {
    const generation = input.store.query({
      kind: 'graph-generation',
      coordinationScopeId: input.coordinationScopeId,
      graphId: manifest.graph.graphId,
    });
    if (
      generation.kind !== 'graph-generation' ||
      generation.generation?.status !== 'candidate' ||
      generation.generation.planningCycleId !== scope.scope.planningCycleId
    ) {
      return { kind: 'rejected', failure: { code: 'candidate_mismatch', message: 'Manifest 未绑定当前 Planning Cycle 的候选代际' } };
    }
  }
  const candidate = input.store.query({
    kind: 'graph-versions',
    coordinationScopeId: input.coordinationScopeId,
    graphId: manifest.graph.graphId,
  });
  const head = candidate.kind === 'graph-versions' ? candidate.versions.at(-1) : undefined;
  if (head === undefined || head.version !== manifest.graph.version) {
    return {
      kind: 'rejected',
      failure: { code: candidate.kind === 'rejected' ? candidate.code : 'candidate_missing', message: candidate.kind === 'rejected' ? candidate.message : '当前候选图无法读回' },
    };
  }
  const mismatches = [...manifestCandidateMismatches(manifest, head)];
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

  const read = input.store.query({
    kind: 'authorization',
    coordinationScopeId: input.coordinationScopeId,
    authorizationId: input.authorizationId,
  });
  if (read.kind !== 'authorization' || read.authorization === null) {
    return {
      kind: 'rejected',
      failure: { code: read.kind === 'rejected' ? read.code : 'invalid_state', message: read.kind === 'rejected' ? read.message : '授权记录写入后无法读回' },
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
