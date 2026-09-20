/**
 * IC-08 / IP-B5：受控 Git 集成的授权边界与 canonical HEAD 归属判定
 * （Owner: `m1-execute-and-validate-work-packages`）。
 *
 * 集成操作只有三种形态：普通 commit、集成 canonical 分支、推送唯一获批的 remote/ref。force-push、
 * 历史改写、发布与部署不是「清单上的可选开关」——Manifest 里根本没有可以打开它们的字段
 * （`GitIntegrationPolicy.allowForcePush` 恒为 `false`），因此这里的判定只能拒绝，不能放宽。
 *
 * 纯函数：不读时钟、不执行 Git、不碰存储。真正的副作用由用例按固定顺序发起。
 */

import type { GitIntegrationPolicy, RoleAuthorities } from './planning/execution-authorization.js';

/** 集成请求的形态闭集；未登记的形态在边界 fail closed。 */
export const GIT_INTEGRATION_KINDS = [
  'commit',
  'integrate_canonical',
  'force_push',
  'history_rewrite',
  'publish',
  'deploy',
] as const;

export type GitIntegrationKind = (typeof GIT_INTEGRATION_KINDS)[number];

/** 需要单独授权、不可能被 Manifest 覆盖的形态。 */
export const RESERVED_INTEGRATION_KINDS = ['publish', 'deploy', 'history_rewrite'] as const;

export type GitIntegrationRequest = {
  readonly kind: GitIntegrationKind;
  /** 目标 remote；`null` 表示该形态不涉及远端（例如本地 commit）。 */
  readonly remote: string | null;
  /** 目标 ref；`null` 表示该形态不涉及 ref。 */
  readonly ref: string | null;
  /** 要集成的分支；必须与 Manifest 的 canonical branch 一致。 */
  readonly branch: string;
};

export type GitIntegrationDenialCode =
  | 'force_push_not_permitted'
  | 'reserved_operation'
  | 'unknown_integration_kind'
  | 'remote_not_approved'
  | 'ref_not_approved'
  | 'branch_not_canonical'
  | 'git_integration_not_authorized'
  | 'missing_remote'
  | 'missing_ref';

export type GitIntegrationDecision =
  | {
      readonly kind: 'authorized';
      readonly request: GitIntegrationRequest;
      readonly policy: GitIntegrationPolicy;
    }
  | {
      readonly kind: 'denied';
      readonly code: GitIntegrationDenialCode;
      /** 越界的具体部分：remote、ref 或形态名；用于报告而不是猜测。 */
      readonly outOfScope: readonly string[];
      readonly message: string;
    };

function denied(
  code: GitIntegrationDenialCode,
  outOfScope: readonly string[],
  message: string,
): GitIntegrationDecision {
  return { kind: 'denied', code, outOfScope, message };
}

/** 形态是否被登记；未知取值 fail closed，不按最接近的形态执行。 */
export function isGitIntegrationKind(raw: unknown): raw is GitIntegrationKind {
  return typeof raw === 'string' && (GIT_INTEGRATION_KINDS as readonly string[]).includes(raw);
}

export function isReservedIntegrationKind(kind: GitIntegrationKind): boolean {
  return (RESERVED_INTEGRATION_KINDS as readonly string[]).includes(kind);
}

/**
 * 判定一次集成请求是否落在 Execution Authorization 允许的范围内。
 *
 * 判定顺序固定：形态 → 保留操作 → force-push → 角色授权 → canonical 分支 → remote → ref。
 * 每一层失败都给出越界部分，绝不因为请求「大部分合规」而部分执行。
 */
export function evaluateGitIntegration(input: {
  readonly policy: GitIntegrationPolicy;
  readonly authority: RoleAuthorities;
  readonly request: GitIntegrationRequest;
}): GitIntegrationDecision {
  const { policy, authority, request } = input;

  if (request.kind === 'force_push') {
    return denied('force_push_not_permitted', ['force-push'], 'force-push 不在默认权限内，需要单独授权');
  }
  if (isReservedIntegrationKind(request.kind)) {
    return denied(
      'reserved_operation',
      [request.kind],
      `${request.kind} 永远需要单独授权，不能被 Execution Authorization 覆盖`,
    );
  }
  if (!authority.gitIntegration) {
    return denied('git_integration_not_authorized', ['git-integration'], 'Manifest 未授权受控 Git 集成');
  }
  if (request.branch !== policy.canonicalBranch) {
    return denied(
      'branch_not_canonical',
      [request.branch],
      `集成目标分支 ${request.branch} 不是获批的 canonical 分支 ${policy.canonicalBranch}`,
    );
  }

  const requiresRemote = request.kind === 'integrate_canonical';
  const requiresRef = request.kind === 'integrate_canonical';
  if (requiresRemote) {
    if (request.remote === null) {
      return denied('missing_remote', ['remote'], '集成 canonical 分支必须指定获批的 remote');
    }
    if (!policy.remotes.includes(request.remote)) {
      return denied('remote_not_approved', [request.remote], `remote ${request.remote} 未获批准`);
    }
  } else if (request.remote !== null && !policy.remotes.includes(request.remote)) {
    return denied('remote_not_approved', [request.remote], `remote ${request.remote} 未获批准`);
  }
  if (requiresRef) {
    if (request.ref === null) {
      return denied('missing_ref', ['ref'], '推送必须指定获批的 ref');
    }
    if (!policy.refs.includes(request.ref)) {
      return denied('ref_not_approved', [request.ref], `ref ${request.ref} 未获批准`);
    }
  } else if (request.ref !== null && !policy.refs.includes(request.ref)) {
    return denied('ref_not_approved', [request.ref], `ref ${request.ref} 未获批准`);
  }

  return { kind: 'authorized', request, policy };
}

/**
 * canonical HEAD 的归属判定（D9 的纯规则部分）。
 *
 * 只有两种情形是「已归属」：HEAD 与最近一条已完成 Integration Operation 记录的 expected HEAD 一致，
 * 或者根本没有可归属的集成记录且 HEAD 仍等于 Authorization baseline。其余一律是 Unattributed Drift，
 * 结论保守：暂停新派发，直到确定该变化是否仍在授权范围内。
 */
export type CanonicalHeadFacts = {
  readonly canonicalHead: string;
  readonly authorizedBaselineHead: string;
  /** canonical worktree 有未归属改动时，即使 HEAD 未变也必须暂停派发。 */
  readonly canonicalWorktreeDirty: boolean;
  /** 最近一条已完成 Integration Operation 的 expected HEAD；没有则为 `null`。 */
  readonly lastIntegrationExpectedHead: string | null;
};

export type CanonicalHeadVerdict =
  | { readonly kind: 'attributed'; readonly statement: string }
  | { readonly kind: 'unattributed_drift'; readonly reason: string; readonly pauseDispatch: true };

export function classifyCanonicalHead(facts: CanonicalHeadFacts): CanonicalHeadVerdict {
  if (facts.canonicalWorktreeDirty) {
    return {
      kind: 'unattributed_drift',
      reason: 'canonical worktree 存在未归属改动，无法对应到已记录的 Integration Operation',
      pauseDispatch: true,
    };
  }
  if (facts.lastIntegrationExpectedHead !== null) {
    return facts.canonicalHead === facts.lastIntegrationExpectedHead
      ? { kind: 'attributed', statement: 'canonical HEAD 与最近一条已完成的 Integration Operation 一致' }
      : {
          kind: 'unattributed_drift',
          reason: 'canonical HEAD 与最近一条已完成的 Integration Operation 不一致，无法归属到任何已记录 intent',
          pauseDispatch: true,
        };
  }
  if (facts.canonicalHead === facts.authorizedBaselineHead) {
    return { kind: 'attributed', statement: 'canonical HEAD 仍等于 Execution Authorization 的 baseline' };
  }
  return {
    kind: 'unattributed_drift',
    reason: 'canonical HEAD 已前进，但没有任何 Integration Operation 记录可以归属该变化',
    pauseDispatch: true,
  };
}
