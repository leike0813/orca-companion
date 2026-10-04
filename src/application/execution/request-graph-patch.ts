/**
 * IC-10 / IP-1：一次图变化请求的端到端编排（Owner: `m1-evolve-execution-graph`）。
 *
 * 前驱模块各自只负责一段：`change-routing` 只分类、`graph-patch-planner` 只派发并接收来源证据、
 * `graph-patch-service` 只做 Admission 归一化与唯一提交、`baseline-reconciliation` 只判定与登记。
 * 本模块把这几段按固定顺序接起来，让调用方（Controller / 前台 runtime）只面对一次调用。
 *
 * 顺序不可交换，且每一步都先用**当前事实**复验一次，而不是信任调用方带来的快照：
 *
 * 1. 读 Scope，复验模式、控制状态、Execution Coordination Lease 归属与调用方 revision；
 * 2. 读当前 GraphVersion，复验补丁基线与请求目标仍在图中；
 * 3. 拒绝重复 `patchId` 与同一 Planner lane 上的未决意图——两者都表示这次请求可能已经发生过；
 * 4. 确定性分类；分类未要求派发时直接返回路由结论，**一次副作用都不产生**；
 * 5. 派发 Planner 取来源证据 → Admission 归一化 → 唯一提交点追加，并立即推进基线补救持久记录。
 *
 * 身份只来自入参：载荷里自称的 scope、graphId、operationId、patchId 在 Admission 处被丢弃，模型无法通过
 * 填写它们改变提交结果。`unknown` 一律以同一 `operationId` 返回、不做换 ID 重试，因为结果是否落地尚未
 * 被证明。
 */

import type {
  CoordinationScopeId,
  GraphVersion,
  OperationId,
  Revision,
  WorkPackageId,
} from '../dto/identity.js';
import type {
  BranchCoordinationStore,
  CoordinationWriter,
} from '../ports/branch-coordination-store.js';
import type { BudgetConsumption } from '../../domain/dispatch-candidate.js';
import type { ExecutionLimits } from '../../domain/planning/budget-policy.js';
import type { ExecutionAuthorizationRecord } from '../../domain/planning/execution-authorization.js';
import { authorizeOperation } from '../../domain/planning/execution-authorization.js';
import { graphVersionChain, type GraphVersionRecord } from '../../domain/planning/execution-graph.js';
import {
  MAX_GRAPH_CHANGE_INSTRUCTION_CODE_POINTS,
  isValidGraphChangeInstruction,
  routeGraphChange,
  type ChangeRoutingDecision,
  type GraphChangeRequest,
} from '../../domain/execution/change-routing.js';
import { unacceptedDescendants } from '../../domain/execution/graph-patch.js';
import {
  draftGraphPatch,
  type GraphPatchPlannerPort,
} from './graph-patch-planner.js';
import {
  admitGraphRevision,
  applyGraphRevisionWithBaseline,
  graphRevisionDraftFromEvidence,
  type AdmittedGraphRevision,
} from './graph-patch-service.js';
import type { GraphPatchCompilationError } from '../../domain/execution/graph-compiler.js';
import {
  type BaselineReconciliationDriver,
  type BaselineReconciliationProgress,
  type BaselineRelation,
} from './baseline-reconciliation.js';
import { loadCurrentGraph } from '../planning/graph-history.js';
import { readScope } from '../planning/scope-read.js';

/** 一个 Work Package 的基线观察；`null` 表示尚无 worktree（不是「基线达标」）。 */
export type GraphPatchBaselineObservation = {
  readonly requiredBaselineHead: string;
  readonly worktreeBaseHead: string;
  readonly relation: BaselineRelation;
};

/**
 * 按**已归一化的 revision** 取基线。
 *
 * 需要哪些 Work Package 只有 Admission 之后才知道（`revisedWorkPackageIds` 与
 * `specificationRevisionRequiredWorkPackageIds`），因此回调在提交之前才被调用；Git 读取由调用方注入，
 * 本模块不自己读 Git。
 *
 * 允许返回 Promise 是必要的：宿主必须在**这次**调用里现读 Git，因为 canonical/worktree HEAD 在派发
 * Planner 与提交之间有真实窗口，预读的结果可能已经过期。回调抛错（例如 Git 不可用）与缺 key 一样只会
 * 让整笔在提交前被拒绝为 `baseline_unverifiable`，不会带出未处理的异常。
 */
export type GraphPatchBaselinesPort = (
  revision: AdmittedGraphRevision,
) =>
  | ReadonlyMap<WorkPackageId, GraphPatchBaselineObservation | null>
  | Promise<ReadonlyMap<WorkPackageId, GraphPatchBaselineObservation | null>>;

export type RequestGraphPatchInput = {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  /** 本 Session 的协调身份；Execution Lease 归属按它复验。 */
  readonly writer: CoordinationWriter;
  /** Controller 签发的 OperationId；载荷里的同名字段一律被丢弃。 */
  readonly operationId: OperationId;
  /** 提交幂等键；已存在同 patchId 的 GraphVersion 时整笔拒绝。 */
  readonly patchId: string;
  readonly changeRequest: GraphChangeRequest;
  readonly planner: GraphPatchPlannerPort;
  readonly authorization: ExecutionAuthorizationRecord | null;
  readonly limits: ExecutionLimits;
  readonly acceptedWorkPackageIds: readonly WorkPackageId[];
  /** 当前已派发 Worker Task 的 Work Package；由调用方从 Orca 投影给出，本模块不猜。 */
  readonly dispatchedWorkPackageIds: readonly WorkPackageId[];
  readonly baselines: GraphPatchBaselinesPort;
  /** 已登记的基线补救推进 driver；由 Controller 注入。 */
  readonly baselineReconciliation: BaselineReconciliationDriver;
  /** 调用方读到的 Scope revision；给出时与当前值不符即拒绝。 */
  readonly expectedRevision?: Revision;
  /** 调用方读到的图 head；给出时与当前值不符即拒绝（补丁只能基于确切版本起草）。 */
  readonly expectedGraphVersion?: GraphVersion;
  /** 各 Work Package 已消耗的修订额度；缺计数按 0 处理，但不会被读成「不受限制」。 */
  readonly consumedRevisions?: readonly BudgetConsumption[];
};

export type RequestGraphPatchResult =
  | {
      readonly kind: 'applied';
      readonly operationId: OperationId;
      readonly patchId: string;
      readonly decision: ChangeRoutingDecision;
      readonly version: GraphVersionRecord;
      readonly revisionPendingWorkPackageIds: readonly string[];
      readonly specificationRevisionRequiredWorkPackageIds: readonly string[];
      readonly baselineProgress?: readonly {
        readonly reconciliationId: string;
        readonly progress: BaselineReconciliationProgress;
      }[];
    }
  /** 分类结论不需要 Graph Patch Planner；调用方按 `decision.route` 走既有路径，本模块未产生副作用。 */
  | {
      readonly kind: 'routed';
      readonly operationId: OperationId;
      readonly patchId: string;
      readonly decision: ChangeRoutingDecision;
    }
  | {
      readonly kind: 'rejected';
      readonly operationId: OperationId;
      readonly patchId: string;
      readonly code: string;
      readonly message: string;
      /** Admission 的编译错误；非 Admission 拒绝时缺省。 */
      readonly errors?: readonly GraphPatchCompilationError[];
    }
  | {
      readonly kind: 'unknown';
      readonly operationId: OperationId;
      readonly patchId: string;
      readonly reason: string;
    };

/**
 * Planner lane 的目标标识。
 *
 * 与 `bootstrap/graph-patch-worker.ts` 派发 Planner 时使用的一致（以 `patchId` 为目标）。未决意图据此
 * 判定「同一个补丁已经在途中」，而不是新起一次派发。
 */
function plannerLaneTargetsPatch(intentTargetId: string, patchId: string): boolean {
  return intentTargetId === patchId;
}

function reject(
  input: RequestGraphPatchInput,
  code: string,
  message: string,
  errors?: readonly GraphPatchCompilationError[],
): RequestGraphPatchResult {
  return {
    kind: 'rejected',
    operationId: input.operationId,
    patchId: input.patchId,
    code,
    message,
    ...(errors === undefined ? {} : { errors }),
  };
}

/** 请求直接针对的 Work Package；目标级/全局变化没有直接受影响节点。 */
function affectedWorkPackageIdsOf(request: GraphChangeRequest): readonly WorkPackageId[] {
  return request.workPackageId === null ? [] : [request.workPackageId];
}
/**
 * 当前 head 的追加祖先链（含 head 本身）。
 *
 * 沿记录里的 parentVersion 回溯而不是比较版本号大小：历史只追加，链上的每一条都是这张图真正经历过的
 * 版本，因此授权绑定的那个版本是否仍有效可以直接从链上读出。
 */
/**
 * 编排一次图变化请求。
 *
 * 任何前置条件不成立时都在产生副作用之前返回结构化拒绝；只有真正进入 `drafted` 之后才可能调用外部
 * Planner。`applied` 表示图版本已追加并读回确认，不表示 Worker 完成或项目可交付。
 */
export async function requestGraphPatch(input: RequestGraphPatchInput): Promise<RequestGraphPatchResult> {
  if (!isValidGraphChangeInstruction(input.changeRequest.changeInstruction)) {
    return reject(input, 'invalid_change_instruction',
      `变化说明必须为非空文本且不超过 ${MAX_GRAPH_CHANGE_INSTRUCTION_CODE_POINTS} 个 Unicode 码点`);
  }
  const scopeRead = readScope(input.store, input.coordinationScopeId);
  if (scopeRead.kind === 'rejected') {
    return reject(input, scopeRead.code, scopeRead.message);
  }
  const scope = scopeRead.scope;
  if (scope.mode !== 'execution_coordination') {
    return reject(input, 'invalid_mode', `Scope 当前模式为 ${scope.mode}，图补丁只在 Execution Coordination 下应用`);
  }
  if (scope.controlState !== 'active') {
    return reject(input, 'invalid_control_state', `Scope 控制状态为 ${scope.controlState}，不再接受新的图变化`);
  }
  if (input.expectedRevision !== undefined && scope.revision !== input.expectedRevision) {
    return reject(
      input,
      'stale_revision',
      `调用方基于 revision ${String(input.expectedRevision)} 行动，当前为 ${scope.revision}`,
    );
  }

  const snapshot = input.store.query({ kind: 'snapshot', coordinationScopeId: input.coordinationScopeId });
  if (snapshot.kind !== 'snapshot') {
    return reject(input, 'invalid_state', '无法读取协调快照');
  }
  const lease = snapshot.snapshot.executionLease;
  if (lease === null || lease.coordinatorSessionId !== input.writer.coordinatorSessionId) {
    return reject(input, 'not_lease_holder', 'Execution Coordination Lease 不在本 Session，图变更只能由持有者推进');
  }
  // 租约记录里的 incarnation 与 fencing generation 是「本进程仍是当前持有者」的证据；陈旧进程不能借
  // 同名 Session 继续推进。缺字段时按不匹配处理：无法证明时 fail closed。
  if (
    lease.runtimeIncarnationId !== input.writer.runtimeIncarnationId ||
    lease.fencingGeneration !== input.writer.fencingGeneration
  ) {
    return reject(
      input,
      'stale_lease_identity',
      `Execution Coordination Lease 属于 ${lease.runtimeIncarnationId}#${String(lease.fencingGeneration)}，与调用方身份不一致`,
    );
  }

  if (scope.graphId === null) {
    return reject(input, 'invalid_state', 'Scope 尚未绑定任何图，没有可修订的 GraphVersion');
  }
  const loaded = loadCurrentGraph({
    store: input.store,
    coordinationScopeId: input.coordinationScopeId,
    graphId: scope.graphId,
  });
  if (loaded.kind !== 'loaded') {
    return reject(
      input,
      loaded.kind === 'rejected' ? loaded.failure.code : 'invalid_state',
      loaded.kind === 'rejected' ? loaded.failure.message : '当前图无法读回',
    );
  }
  const current = loaded.version;
  if (input.expectedGraphVersion !== undefined && current.version !== input.expectedGraphVersion) {
    return reject(
      input,
      'base_version_mismatch',
      `调用方基于 GraphVersion ${String(input.expectedGraphVersion)} 行动，当前为 ${current.version}`,
    );
  }

  const history = input.store.query({
    kind: 'graph-versions',
    coordinationScopeId: input.coordinationScopeId,
    graphId: current.graphId,
  });
  if (history.kind !== 'graph-versions') {
    return reject(input, 'invalid_state', '无法读取 GraphVersion 历史');
  }

  // 同一补丁已提交过：这是重放，不是新变化。幂等键与唯一提交点使用同一个值，判定放在派发 Planner 之前。
  const existing = history.versions.find((version) => version.patchId === input.patchId);
  if (existing !== undefined) {
    return reject(input, 'patch_already_applied', `补丁 ${input.patchId} 已在 GraphVersion ${existing.version} 提交过`);
  }

  /**
   * 授权必须在**派发之前**复验，而不是等 Admission 才发现无效：否则 Planner 会被真实派发出去，而提交
   * 阶段才拒绝，白白消耗一次 Worker 与外部调用。
   *
   * 判定的三项：Scope 指针与记录版本一致、Manifest 与当前图属于同一代际（GraphId / Generation / Run，
   * 外加同代际内保持不变的 map 与 plan revision）、以及 Manifest 绑定的那个 GraphVersion 仍在当前图的
   * 追加链上。
   *
   * **不比较** `manifest.graph.version` 与当前版本：Manifest 绑定的是批准时刻的图，而图会随 accepted
   * revision 前进；要求两者相等会让第二次修订永远无法进行。代际与 map/plan revision 是稳定身份，版本
   * 只用来证明授权基线没有被换掉——它必须还是当前 head 的祖先。
   */
  if (
    input.authorization === null ||
    scope.authorizationId === null ||
    scope.authorizationVersion === null ||
    input.authorization.authorizationId !== scope.authorizationId ||
    input.authorization.authorizationVersion !== scope.authorizationVersion
  ) {
    return reject(input, 'not_authorized', '当前图变化没有可用的 Execution Authorization，或授权引用已过期');
  }
  // 授权在下面的判定里被反复使用；绑定成局部量，避免属性收窄在中间调用之后失效。
  const authorization = input.authorization;
  const manifest = authorization.manifest;
  const stableMismatches: string[] = [];
  if (manifest.graph.graphId !== current.graphId) stableMismatches.push('graphId');
  if (manifest.graph.generation !== current.generation) stableMismatches.push('graphGeneration');
  if (manifest.orcaRunId !== current.orcaRunId) stableMismatches.push('orcaRunId');
  // 地图与计划 revision 在同代际的 accepted revision 之间保持不变（提交路径把 current 的值原样带入新版本），
  // 因此它们是可以用来发现「授权期间地图或计划被换掉」的稳定事实。
  if (manifest.routeMapRef.version !== current.mapRevision) stableMismatches.push('routeMapRevision');
  if (manifest.implementationPlanRef.version !== current.planRevision) stableMismatches.push('implementationPlanRevision');
  if (stableMismatches.length > 0) {
    return reject(
      input,
      'authorization_graph_mismatch',
      `Execution Authorization 绑定的代际、Run、地图或计划与当前图不一致：${stableMismatches.join('、')}`,
    );
  }
  if (!graphVersionChain(history.versions, current).has(manifest.graph.version)) {
    return reject(
      input,
      'authorization_graph_mismatch',
      `Execution Authorization 绑定的 GraphVersion ${String(manifest.graph.version)} 不在当前图的追加链上`,
    );
  }
  const authorized = authorizeOperation({
    authorization,
    category: 'worker-dispatch',
    role: 'planner',
  });
  if (authorized.kind !== 'authorized') {
    return reject(
      input,
      'planner_not_authorized',
      authorized.kind === 'not_authorized' ? authorized.reason : '图补丁 Planner 属于需要单独授权的操作',
    );
  }

  const known = new Set(current.graph.workPackages.map((workPackage) => workPackage.workPackageId));
  for (const workPackageId of affectedWorkPackageIdsOf(input.changeRequest)) {
    if (!known.has(workPackageId)) {
      return reject(input, 'unknown_work_package', `变化请求针对的 ${workPackageId} 不在当前图中`);
    }
  }

  // 同一 Planner lane 上的未决意图表示上一次派发可能已经发生：先对账，不能据此再派一次。
  const pending = snapshot.snapshot.unresolvedIntents.find(
    (intent) => intent.state !== 'settled' && plannerLaneTargetsPatch(intent.target.id, input.patchId),
  );
  if (pending !== undefined) {
    return reject(
      input,
      'intent_pending',
      `补丁 ${input.patchId} 的 Planner lane 上已有未决意图 ${pending.operationId}，须先按原身份对账`,
    );
  }

  const decision = routeGraphChange({ request: input.changeRequest, baseGraphVersion: current.version });
  if (!decision.dispatchGraphPatchPlanner) {
    return { kind: 'routed', operationId: input.operationId, patchId: input.patchId, decision };
  }

  const affectedWorkPackageIds = affectedWorkPackageIdsOf(input.changeRequest);
  const drafted = await draftGraphPatch({
    routing: decision,
    planner: input.planner,
    coordinationScopeId: input.coordinationScopeId,
    graphId: current.graphId,
    patchId: input.patchId,
    operationId: input.operationId,
    changeRequest: input.changeRequest,
    currentGraph: current.graph,
    affectedWorkPackageIds,
    // 未接受后代由与编译器同一个纯函数推出，补丁的处置集合因此不会与编译校验错位。
    unacceptedDescendantIds: unacceptedDescendants({
      graph: current.graph,
      affected: affectedWorkPackageIds,
      accepted: input.acceptedWorkPackageIds,
    }),
  });
  if (drafted.kind === 'rejected') {
    return reject(input, drafted.code, drafted.message);
  }
  if (drafted.kind === 'unknown') {
    return { kind: 'unknown', operationId: input.operationId, patchId: input.patchId, reason: drafted.reason };
  }

  const admitted = admitGraphRevision({
    draft: graphRevisionDraftFromEvidence(drafted.evidence),
    current,
    limits: input.limits,
    authorization: input.authorization,
    acceptedWorkPackageIds: input.acceptedWorkPackageIds,
    dispatchedWorkPackageIds: input.dispatchedWorkPackageIds,
    ...(input.consumedRevisions === undefined ? {} : { consumedRevisions: input.consumedRevisions }),
  });
  if (admitted.kind === 'rejected') {
    return reject(input, 'admission_rejected', '补丁未通过 Admission 编译校验', admitted.errors);
  }

  /**
   * 基线在 Admission **之后**、提交之前现读。
   *
   * 调用方的 Git 观察必须发生在这一刻：派发 Planner 与提交之间存在真实时间窗口，canonical 与 worktree
   * 的 HEAD 可能已经移动，预先读到的基线会把整笔提交建立在一个已经过期的观察上。回调抛错（Git 不可用、
   * 路径不可读等）在这里被收成结构化拒绝：提交之前没有副作用，因此这不构成一次 unknown。
   */
  let baselines: ReadonlyMap<WorkPackageId, GraphPatchBaselineObservation | null>;
  try {
    baselines = await input.baselines(admitted.revision);
  } catch (error) {
    return reject(
      input,
      'baseline_unverifiable',
      `无法读取修订所需的基线观察：${error instanceof Error ? error.message : '基线回调异常'}`,
    );
  }

  const applied = await applyGraphRevisionWithBaseline({
    store: input.store,
    coordinationScopeId: input.coordinationScopeId,
    writer: input.writer,
    revision: admitted.revision,
    current,
    authorizationId: authorization.authorizationId,
    baselines,
    baselineReconciliation: input.baselineReconciliation,
  });
  if (applied.kind === 'rejected') {
    return reject(input, applied.failure.code, applied.failure.message);
  }
  return {
    kind: 'applied',
    operationId: input.operationId,
    patchId: input.patchId,
    decision,
    version: applied.version,
    revisionPendingWorkPackageIds: applied.revisionPendingWorkPackageIds,
    specificationRevisionRequiredWorkPackageIds: applied.specificationRevisionRequiredWorkPackageIds,
    ...(applied.baselineProgress === undefined ? {} : { baselineProgress: applied.baselineProgress }),
  };
}
