/**
 * IC-10 / IP-1：图变化的确定性分类路由（Owner: `m1-evolve-execution-graph`，D2）。
 *
 * 每个图变化请求先在这里被路由到七值之一。分类只使用**可判定**的声明事实，不读文本、不猜语义、不碰
 * 存储也不派发任何东西：因此「为什么这次没有派 Planner」永远可以在不产生副作用的前提下复算。
 *
 * 三条边界写进了返回值而不是调用方的自觉：
 * - `dispatchGraphPatchPlanner` 只在声明事实不足以判定时成立；明确的结构变化不会被送去做语义判断；
 * - 分类结论一定携带 `baseGraphVersion`：补丁只能基于某个确切版本起草，不存在「基于未声明版本」的路径；
 * - 同一请求同时声明基础设施重试与语义变化时路由为 `blocked`，因为 Retry Attempt 保持 WorkerTask、
 *   contract 与 revision 不变，这两类依据不可能同时成立。
 *
 * 本模块不判断请求本身是否合理（那是 Coordinator 与用户的事），也不决定补丁内容。
 */

import type { GraphVersion, WorkPackageId } from '../../application/dto/identity.js';

export const GRAPH_CHANGE_ROUTES = [
  'retry_attempt',
  'specification_revision',
  'graph_patch',
  'replanning_transition',
  'no_change',
  'user_decision_required',
  'blocked',
] as const;

export type GraphChangeRoute = (typeof GRAPH_CHANGE_ROUTES)[number];

/**
 * 单条声明事实的三值。
 *
 * `unknown` 与 `no` 不同：`no` 是「已核验不成立」，`unknown` 是「还无法核验」。分类器只在后者派发
 * Graph Patch Planner，因此「没查过」不会被读成「没有变化」。
 */
export const CHANGE_CLAIMS = ['yes', 'no', 'unknown'] as const;

export type ChangeClaim = (typeof CHANGE_CLAIMS)[number];

/**
 * 一次图变化请求的结构化声明。
 *
 * 字段是声明而不是结论：Controller 只负责把它们带进来，不替调用方推断。
 */
export type GraphChangeRequest = {
  /** 请求针对的 Work Package；目标级或全局变化为 `null`。 */
  readonly workPackageId: WorkPackageId | null;
  /** 同一 Worker Task 的既定工作因基础设施原因需要重新执行。 */
  readonly infrastructureFailure: ChangeClaim;
  readonly changesDependencies: ChangeClaim;
  readonly changesScopeEnvelope: ChangeClaim;
  readonly changesObjective: ChangeClaim;
  /** 只调整 requirements、design 或验收条件等 contract 内容。 */
  readonly contractContentOnly: ChangeClaim;
  /** 目标或全局约束发生变化。 */
  readonly goalOrGlobalConstraintChanged: ChangeClaim;
  readonly userRequestedReplanning: ChangeClaim;
  /** 请求本身需要用户在若干合法处置之间选择。 */
  readonly requiresUserChoice: ChangeClaim;
};

export type ChangeRoutingDecision = {
  readonly route: GraphChangeRoute;
  /** 是否必须派发 Graph Patch Planner 产出结构化补丁草案。 */
  readonly dispatchGraphPatchPlanner: boolean;
  /** 补丁与 Base 版本校验使用的 exact 版本；非补丁路径也带上它，避免调用方另找一次。 */
  readonly baseGraphVersion: GraphVersion;
  readonly reason: string;
};

export type ChangeRoutingInput = {
  readonly request: GraphChangeRequest;
  readonly baseGraphVersion: GraphVersion;
};

/** 结构性变化的声明字段：任一项为 `yes` 就不再是 contract 内容级修订。 */
const STRUCTURAL_CLAIMS = ['changesDependencies', 'changesScopeEnvelope', 'changesObjective'] as const;

/** 除 replanning 之外的语义声明；用于区分「无变化」与「确有变化」。 */
const SEMANTIC_CLAIMS = [
  'infrastructureFailure',
  ...STRUCTURAL_CLAIMS,
  'contractContentOnly',
] as const;

/** 判定实际使用的是哪一类依据；命中多个字段即为矛盾声明。 */
const CHANGE_BASES = [...SEMANTIC_CLAIMS, 'goalOrGlobalConstraintChanged', 'userRequestedReplanning'] as const;

type ChangeBasis = (typeof CHANGE_BASES)[number];

function affirmations(request: GraphChangeRequest, bases: readonly ChangeBasis[]): readonly ChangeBasis[] {
  return bases.filter((basis) => request[basis] === 'yes');
}

function decision(input: ChangeRoutingInput, route: GraphChangeRoute, dispatch: boolean, reason: string): ChangeRoutingDecision {
  return {
    route,
    dispatchGraphPatchPlanner: dispatch,
    baseGraphVersion: input.baseGraphVersion,
    reason,
  };
}

/**
 * 把一次图变化请求路由到七值之一。
 *
 * 判定顺序是固定的安全顺序：先看是否需要用户裁决（它排除自动分类），再看重规划（它排除图补丁），
 * 再看矛盾声明，然后才是「无变化」与三类确定修订，最后才把无法判定的请求交给 Graph Patch Planner。
 */
export function routeGraphChange(input: ChangeRoutingInput): ChangeRoutingDecision {
  const { request } = input;

  if (request.requiresUserChoice === 'yes') {
    return decision(
      input,
      'user_decision_required',
      false,
      '请求需要在若干合法处置之间由用户选择，自动分类只会替用户做决定',
    );
  }

  if (request.userRequestedReplanning === 'yes' || request.goalOrGlobalConstraintChanged === 'yes') {
    return decision(
      input,
      'replanning_transition',
      false,
      '目标、全局约束或用户明确要求触发重规划；图补丁无法表达代际级变化',
    );
  }

  const affirmedSemantics = affirmations(request, SEMANTIC_CLAIMS);
  if (request.infrastructureFailure === 'yes' && affirmedSemantics.length > 1) {
    return decision(
      input,
      'blocked',
      false,
      '同一请求同时声明基础设施重试与语义变化；Retry Attempt 保持 WorkerTask、contract 与 revision 不变，两类依据不能同时成立',
    );
  }

  if (CHANGE_BASES.every((basis) => request[basis] === 'no')) {
    return decision(input, 'no_change', false, '全部声明事实均已核验为不成立，没有需要应用的变化');
  }

  if (affirmations(request, STRUCTURAL_CLAIMS).length > 0) {
    return decision(
      input,
      'graph_patch',
      false,
      '请求改变了依赖、Scope Envelope 或 objective，属于图级变化',
    );
  }

  if (request.contractContentOnly === 'yes' && request.infrastructureFailure === 'no') {
    return decision(
      input,
      'specification_revision',
      false,
      '请求只替换 contract 内容，保持 WorkPackageId、依赖与 Scope Envelope',
    );
  }

  if (request.infrastructureFailure === 'yes' && request.contractContentOnly === 'no') {
    return decision(input, 'retry_attempt', false, '既定工作因基础设施原因需要重新执行，WorkerTask 与 contract 不变');
  }

  return decision(
    input,
    'graph_patch',
    true,
    '声明事实不足以判定变化类别，派发 Graph Patch Planner 产出结构化补丁草案',
  );
}
