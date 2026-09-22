/**
 * IC-10 / IP-4：Specification Revision 的判定（Owner: `m1-evolve-execution-graph`，D6、D7）。
 *
 * 三类修订必须互不冒充，这里是它们的判别点：
 *
 * - **Specification Revision** 只替换尚未接受的同一 Work Package 的 contract 内容，保留 WorkPackageId、
 *   依赖与 Scope Envelope，替换后必须重新经过 Specification Admission，并从 Specification Planner 起
 *   重跑完整角色链；
 * - **Graph Revision** 是改变依赖、Scope Envelope 或 objective 的那一类，因此需要改变这些字段的请求在
 *   这里被明确拒绝并指向 Graph Revision；
 * - **Retry Attempt** 保持 WorkerTask、contract 与 revision 不变，只创建新的 Dispatch 与 Attempt，
 *   因此本模块的产物里没有任何重试字段，重试路径也不产生本模块的产物。
 *
 * 纯判定：不读存储、不派发、不消耗额度。
 */

import type { WorkPackageId } from '../../application/dto/identity.js';
import { roleIsAuthorized } from '../task-contract.js';
import type { RoleAuthorities, WorkerRole } from '../planning/execution-authorization.js';
import type { WorkPackage } from '../planning/execution-graph.js';

/** 一次修订请求声明的契约变化面。 */
export type SpecificationRevisionScope = {
  /** 修订后的契约内容 revision；必须严格大于原值。 */
  readonly contractRevision: number;
  readonly changesRequirements: boolean;
  readonly changesDesign: boolean;
  readonly changesAcceptance: boolean;
  readonly changesDependencies: boolean;
  readonly changesScopeEnvelope: boolean;
  readonly changesObjective: boolean;
};

export const SPECIFICATION_REVISION_REJECTIONS = [
  'already_accepted',
  'no_contract_change',
  'invalid_contract_revision',
  'role_not_authorized',
] as const;

export type SpecificationRevisionRejectionCode = (typeof SPECIFICATION_REVISION_REJECTIONS)[number];

/** 修订计划：它描述「在什么前提下重跑哪一段角色链」，不包含任何 Dispatch 或 Attempt 身份。 */
export type SpecificationRevisionPlan = {
  readonly workPackageId: WorkPackageId;
  readonly contractRevision: number;
  readonly holdSource: 'specification_revision';
  readonly preserveWorkPackageId: true;
  readonly preserveDependencies: true;
  readonly preserveScopeEnvelope: true;
  readonly reAdmissionRequired: true;
  /** 重跑起点固定是 Specification Planner；从 Implementation 起重跑会跳过规格准入。 */
  readonly rerunFromRole: Extract<WorkerRole, 'planner'>;
  readonly reuseWorktree: true;
};

export type SpecificationRevisionDecision =
  | { readonly kind: 'planned'; readonly plan: SpecificationRevisionPlan }
  | { readonly kind: 'requires_graph_revision'; readonly reason: string }
  | {
      readonly kind: 'rejected';
      readonly code: SpecificationRevisionRejectionCode;
      readonly message: string;
    };

export type PlanSpecificationRevisionInput = {
  readonly request: SpecificationRevisionScope;
  readonly workPackage: WorkPackage;
  /** 该 Work Package 是否已被接受；已接受节点不能被修订。 */
  readonly accepted: boolean;
  /** 当前契约内容 revision。 */
  readonly currentContractRevision: number;
  readonly authority: RoleAuthorities;
};

/**
 * 判定一次修订请求是否可以走 Specification Revision。
 *
 * 越界判定先于内容判定：需要改变依赖或 Scope Envelope 的请求必须成为 Graph Revision，而不是被当成
 * 一次「内容修订」偷偷改图。
 */
export function planSpecificationRevision(
  input: PlanSpecificationRevisionInput,
): SpecificationRevisionDecision {
  if (input.request.changesDependencies || input.request.changesScopeEnvelope || input.request.changesObjective) {
    return {
      kind: 'requires_graph_revision',
      reason: '请求改变了依赖、Scope Envelope 或 objective，必须作为 Graph Revision 处理',
    };
  }
  if (input.accepted) {
    return {
      kind: 'rejected',
      code: 'already_accepted',
      message: `Work Package ${input.workPackage.workPackageId} 已被接受，不能被修订`,
    };
  }
  if (!roleIsAuthorized(input.authority, 'planner')) {
    return {
      kind: 'rejected',
      code: 'role_not_authorized',
      message: 'Execution Authorization 不允许 Specification Planner 角色工作',
    };
  }
  if (
    !input.request.changesRequirements &&
    !input.request.changesDesign &&
    !input.request.changesAcceptance
  ) {
    return {
      kind: 'rejected',
      code: 'no_contract_change',
      message: '修订请求没有改变 requirements、design 或验收条件中的任何一项',
    };
  }
  if (
    !Number.isSafeInteger(input.request.contractRevision) ||
    input.request.contractRevision <= input.currentContractRevision
  ) {
    return {
      kind: 'rejected',
      code: 'invalid_contract_revision',
      message: `契约内容 revision ${input.request.contractRevision} 必须大于当前值 ${input.currentContractRevision}`,
    };
  }
  return {
    kind: 'planned',
    plan: {
      workPackageId: input.workPackage.workPackageId,
      contractRevision: input.request.contractRevision,
      holdSource: 'specification_revision',
      preserveWorkPackageId: true,
      preserveDependencies: true,
      preserveScopeEnvelope: true,
      reAdmissionRequired: true,
      rerunFromRole: 'planner',
      reuseWorktree: true,
    },
  };
}

/**
 * 契约替换后必须重跑的角色链。
 *
 * 角色顺序固定：Specification Planner → Implementation → Validator。返回的角色集合从 Planner 开始，
 * 因此「从 Implementation 起重跑」在类型上不可能被表达成一次规格修订。
 */
export function specificationRevisionRoleChain(): readonly WorkerRole[] {
  return ['planner', 'implementation', 'validator'];
}

/** 修订计划是否保持了身份与依赖：这是 `gate.revision-not-retry` 的可断言形式之一。 */
export function planPreservesIdentity(plan: SpecificationRevisionPlan): boolean {
  return plan.preserveWorkPackageId && plan.preserveDependencies && plan.preserveScopeEnvelope && plan.reuseWorktree;
}
