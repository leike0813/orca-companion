/**
 * IC-05：Coordination Scope 的创建（Owner: `m1-plan-and-authorize-execution`）。
 *
 * 初始化只建立三件事：Scope、首个 Planning Cycle 与首个 Coordinator Session，外加「首个 Session
 * 是当前规划责任方」这一条共享事实。它刻意不写 Orca Run、Task、worktree、执行预算、角色权限或
 * accepted risks——那些属于 Execution Authorization Manifest，在创建阶段固化会把执行策略提前
 * 写进一个还没有规划成果的 Scope（D8）。
 *
 * 三者在同一事务里完成：不存在「有 Scope 但没有责任方」或「有 Session 但没有 Scope」的中间态。
 */

import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  PlanningCycleId,
  RuntimeIncarnationId,
} from '../dto/identity.js';
import type { BranchCoordinationStore, CoordinationCommandRejection } from '../ports/branch-coordination-store.js';
import type { ControlState, CoordinationMode } from '../../domain/coordination/mode.js';

/** 创建阶段还没有 Runtime Incarnation：bootstrap 写入者只用来说明「谁创建的」。 */
export const BOOTSTRAP_INCARNATION_SUFFIX = '#bootstrap';

export type InitializeCoordinationScopeInput = {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly coordinatorSessionId: CoordinatorSessionId;
  readonly coordinatorModelConfigurationRef: string;
  readonly planningCycleId: PlanningCycleId;
  /** 新 Scope 的模式；默认 `route_planning`，初始化不产生执行授权。 */
  readonly mode?: CoordinationMode;
  readonly controlState?: ControlState;
};

export type InitializeCoordinationScopeResult =
  | { readonly kind: 'initialized'; readonly revision: number }
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
    writer: {
      coordinatorSessionId: input.coordinatorSessionId,
      runtimeIncarnationId: `${input.coordinatorSessionId}${BOOTSTRAP_INCARNATION_SUFFIX}` as RuntimeIncarnationId,
      fencingGeneration: 0,
    },
    mode: input.mode ?? 'route_planning',
    controlState: input.controlState ?? 'active',
    planningCycleId: input.planningCycleId,
    coordinatorSessionId: input.coordinatorSessionId,
    coordinatorModelConfigurationRef: input.coordinatorModelConfigurationRef,
  });
  return result.kind === 'rejected'
    ? { kind: 'rejected', code: result.code, message: rejectionMessage(result) }
    : { kind: 'initialized', revision: result.revision };
}
