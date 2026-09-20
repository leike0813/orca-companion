/**
 * IC-04 的挂起用例
 * （Owner: `m1-run-coordinator-sessions`）。
 *
 * Coordinator Session Suspension 是「模型循环已经结束」这个可恢复条件，不是进程停止、不是睡眠、
 * 也不是工作流暂停（`CONTEXT.md`「Coordinator Session Suspension」）。因此这个模块只做一件事：
 * 在没有 Actionable Work 时给出一个可恢复的挂起状态。它不停止前台 Controller、不写控制状态、
 * 不释放任何所有权，也不把 Session 记为完成或取消——那些都不是挂起的语义。
 */

import type { CoordinationScopeId, CoordinatorSessionId } from '../dto/identity.js';
import type { ActionableWorkProjection, ProjectedActionableWorkItem } from './actionable-work.js';

/** 挂起的直接原因。挂起始终可被新的 Actionable Work 唤醒。 */
export const SUSPENSION_REASONS = ['no_actionable_work'] as const;

export type SuspensionReason = (typeof SUSPENSION_REASONS)[number];

/**
 * 可恢复挂起。
 *
 * `kind` 是给调用方与投影的判别标记：看到它就只能按「等待工作」处理，不能读作完成、取消或失败。
 */
export type SuspensionState = {
  readonly kind: 'suspended';
  readonly coordinationScopeId: CoordinationScopeId;
  readonly coordinatorSessionId: CoordinatorSessionId;
  readonly graphPosition: string;
  readonly suspendedAt: number;
  readonly reason: SuspensionReason;
  /** 本次挂起时已知被推迟的 Actionable Work 数量；不影响后续唤醒。 */
  readonly deferredActionableWork: number;
};

/** 挂起时 Session 停在图中挂起节点的位置标识。 */
export const SUSPENSION_GRAPH_POSITION = 'suspend';

export type SuspendSessionRequest = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly coordinatorSessionId: CoordinatorSessionId;
  readonly projection: ActionableWorkProjection;
  readonly clock?: () => number;
};

export type SuspendSessionResult =
  | { readonly kind: 'suspended'; readonly state: SuspensionState }
  /** 仍有 Actionable Work：不得挂起，模型应继续。 */
  | { readonly kind: 'actionable-work'; readonly items: readonly ProjectedActionableWorkItem[] };

/**
 * 结束本次模型循环并记录可恢复的挂起状态。
 *
 * 有 Actionable Work 时拒绝挂起：让「无工作时挂起」成为调用方无法绕过的不变式，而不是纪律。
 */
export function suspendSession(request: SuspendSessionRequest): SuspendSessionResult {
  if (request.projection.items.length > 0) {
    return { kind: 'actionable-work', items: request.projection.items };
  }
  const clock = request.clock ?? (() => Date.now());
  return {
    kind: 'suspended',
    state: {
      kind: 'suspended',
      coordinationScopeId: request.coordinationScopeId,
      coordinatorSessionId: request.coordinatorSessionId,
      graphPosition: SUSPENSION_GRAPH_POSITION,
      suspendedAt: clock(),
      reason: 'no_actionable_work',
      deferredActionableWork: request.projection.deferredCount,
    },
  };
}
