/**
 * IC-05：Coordination Scope 的创建与一次性身份绑定
 * （Owner: `m1-plan-and-authorize-execution`；`m1-wire-foreground-planning-runtime` 增加注册绑定）。
 *
 * 初始化只建立三件事：Scope、首个 Planning Cycle 与首个 Coordinator Session，外加「首个 Session
 * 是当前规划责任方」这一条共享事实。它刻意不写 Orca Run、Task、worktree、执行预算、角色权限或
 * accepted risks——那些属于 Execution Authorization Manifest，在创建阶段固化会把执行策略提前
 * 写进一个还没有规划成果的 Scope（D8）。
 *
 * 四者在同一事务里完成：不存在「有 Scope 但没有责任方」「有 Session 但没有 Scope」或「有 Scope
 * 但没有可核验身份」的中间态。创建时写入的完整 branch ref 与 canonical worktree 是**用户登记的
 * 身份**，不是 Git 当前状态的镜像：Git common dir 只是存储位置，恢复时仍以 Git 的实时身份重新核验。
 *
 * `bindScopeIdentity` 补齐的是前驱版本创建的旧记录：它只在当前绑定为空、且该 Scope 从未使用过
 * Runtime Lease 时被接受，因此不可能改写已有绑定，也不可能在运行时抢占一个正在使用的 Scope。
 */

import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  PlanningCycleId,
  RuntimeIncarnationId,
} from '../dto/identity.js';
import type {
  BranchCoordinationStore,
  CoordinationCommandRejection,
  CoordinationWriter,
} from '../ports/branch-coordination-store.js';
import type { ControlState, CoordinationMode } from '../../domain/coordination/mode.js';

/** 创建阶段还没有 Runtime Incarnation：bootstrap 写入者只用来说明「谁创建的」。 */
export const BOOTSTRAP_INCARNATION_SUFFIX = '#bootstrap';

/**
 * 初始化与一次性身份绑定共用的写入者前导。
 *
 * 两处都在「该 Scope 还没有任何 Runtime Lease」的窗口里执行，因此不存在可以派发它们的活跃
 * incarnation；用一个不冒充 lease holder 的 bootstrap 身份是唯一诚实的选择。
 */
export function bootstrapWriterFor(coordinatorSessionId: CoordinatorSessionId): CoordinationWriter {
  return {
    coordinatorSessionId,
    runtimeIncarnationId: `${coordinatorSessionId}${BOOTSTRAP_INCARNATION_SUFFIX}` as RuntimeIncarnationId,
    fencingGeneration: 0,
  };
}

export type InitializeCoordinationScopeInput = {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly coordinatorSessionId: CoordinatorSessionId;
  readonly coordinatorModelConfigurationRef: string;
  readonly planningCycleId: PlanningCycleId;
  /** 用户登记的完整 branch ref，例如 `refs/heads/main`。 */
  readonly fullBranchRef: string;
  /** 用户登记的 canonical worktree 绝对路径。 */
  readonly canonicalWorktreePath: string;
  /** 新 Scope 的模式；默认 `route_planning`，初始化不产生执行授权。 */
  readonly mode?: CoordinationMode;
  readonly controlState?: ControlState;
};

export type InitializeCoordinationScopeResult =
  | { readonly kind: 'initialized'; readonly revision: number }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string };

export type BindScopeIdentityInput = {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  /** 写入者身份（只用于说明谁执行了这次补齐）；读取到的 Scope revision 由调用方给出。 */
  readonly coordinatorSessionId: CoordinatorSessionId;
  readonly expectedRevision: number;
  readonly fullBranchRef: string;
  readonly canonicalWorktreePath: string;
};

export type BindScopeIdentityResult =
  | { readonly kind: 'bound'; readonly revision: number }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string };

function rejectionMessage(rejection: CoordinationCommandRejection): string {
  return rejection.message;
}

export function initializeCoordinationScope(
  input: InitializeCoordinationScopeInput,
): InitializeCoordinationScopeResult {
  const result = input.store.transact({
    kind: 'initialize-scope',
    coordinationScopeId: input.coordinationScopeId,
    expectedRevision: 0,
    writer: bootstrapWriterFor(input.coordinatorSessionId),
    mode: input.mode ?? 'route_planning',
    controlState: input.controlState ?? 'active',
    planningCycleId: input.planningCycleId,
    coordinatorSessionId: input.coordinatorSessionId,
    coordinatorModelConfigurationRef: input.coordinatorModelConfigurationRef,
    fullBranchRef: input.fullBranchRef,
    canonicalWorktreePath: input.canonicalWorktreePath,
  });
  return result.kind === 'rejected'
    ? { kind: 'rejected', code: result.code, message: rejectionMessage(result) }
    : { kind: 'initialized', revision: result.revision };
}

/**
 * 为缺少注册绑定的旧 Scope 补齐一次身份。
 *
 * 调用方必须是**用户显式确认**这一步的那一方：`expectedRevision` 是它读到的当前 Scope revision，
 * 与库内不一致即按 stale 拒绝，不做自动重试，也不从 cwd 猜一个值。
 */
export function bindScopeIdentity(input: BindScopeIdentityInput): BindScopeIdentityResult {
  const result = input.store.transact({
    kind: 'bind-scope-identity',
    coordinationScopeId: input.coordinationScopeId,
    expectedRevision: input.expectedRevision,
    writer: bootstrapWriterFor(input.coordinatorSessionId),
    fullBranchRef: input.fullBranchRef,
    canonicalWorktreePath: input.canonicalWorktreePath,
  });
  return result.kind === 'rejected'
    ? { kind: 'rejected', code: result.code, message: rejectionMessage(result) }
    : { kind: 'bound', revision: result.revision };
}
