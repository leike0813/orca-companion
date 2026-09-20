/**
 * IC-05：模式切换与 Execution Coordination Lease 的同批接手
 * （Owner: `m1-plan-and-authorize-execution`）。
 *
 * 切换必须原子：模式、候选图与世代、Execution Authorization、预算引用与 Execution Coordination
 * Lease 一起生效，任一项失败就整体不生效并保持 `route_planning`（D16）。因此这里不逐步调用前驱的
 * lease 用例，而是走一条把同一批事实写在同一个事务里的 store 命令；单写者不变式仍由 store 的唯一
 * 索引承担，本模块不导出第二个 `acquireExecutionLease`。
 *
 * 门禁在这里由 Controller 判定：调用方传入已经读好的事实，本模块先判定再写入，绝不因为「即将切换」
 * 而放宽任何一条条件。
 */

import type { ExecutionAuthorizationRecord } from '../../domain/planning/execution-authorization.js';
import type { CoordinationScopeId, PlanningCycleId } from '../dto/identity.js';
import type { BranchCoordinationStore, CoordinationWriter } from '../ports/branch-coordination-store.js';
import { readScope } from './scope-read.js';
import {
  evaluateHandoffGate,
  type HandoffBlocker,
  type HandoffGateFacts,
} from './handoff-gate.js';

export type TransitionToExecutionInput = {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly planningCycleId: PlanningCycleId | null;
  readonly writer: CoordinationWriter;
  readonly gateFacts: HandoffGateFacts;
};

export type TransitionToExecutionResult =
  | { readonly kind: 'transitioned'; readonly revision: number; readonly authorization: ExecutionAuthorizationRecord }
  | { readonly kind: 'blocked'; readonly blockers: readonly HandoffBlocker[] }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string };

/**
 * 把 Scope 从 `route_planning` 推进到 `execution_coordination`。
 *
 * 已经在执行模式时返回显式拒绝，而不是幂等成功：重复切换意味着调用方对当前状态的判断已经错了，
 * 静默通过会让后续的 Worker 派发建立在错误前提上。
 */
export function transitionToExecution(input: TransitionToExecutionInput): TransitionToExecutionResult {
  const gate = evaluateHandoffGate(input.gateFacts);
  if (gate.kind === 'blocked') {
    return { kind: 'blocked', blockers: gate.blockers };
  }
  const candidate = input.gateFacts.candidate;
  const authorization = input.gateFacts.authorization;
  if (candidate === null || authorization === null) {
    // 门禁已经排除了这两种情况；这里的断言只是让类型收敛，不让缺失值流进事务。
    return { kind: 'rejected', code: 'invalid_state', message: '门禁通过但候选图或授权缺失' };
  }

  const scope = readScope(input.store, input.coordinationScopeId);
  if (scope.kind === 'rejected') {
    return { kind: 'rejected', code: scope.code, message: scope.message };
  }
  if (scope.scope.mode !== 'route_planning') {
    return {
      kind: 'rejected',
      code: 'invalid_state',
      message: `Scope 当前模式为 ${scope.scope.mode}，不能再次切换`,
    };
  }

  const transitioned = input.store.transact({
    kind: 'transition-to-execution',
    coordinationScopeId: input.coordinationScopeId,
    expectedRevision: scope.scope.revision,
    writer: input.writer,
    planningCycleId: input.planningCycleId,
    graphId: candidate.graphId,
    graphVersion: candidate.version,
    authorizationId: authorization.authorizationId,
    authorizationVersion: authorization.authorizationVersion,
  });
  if (transitioned.kind === 'rejected') {
    return { kind: 'rejected', code: transitioned.code, message: transitioned.message };
  }

  const after = readScope(input.store, input.coordinationScopeId);
  if (after.kind !== 'read' || after.scope.mode !== 'execution_coordination') {
    return { kind: 'rejected', code: 'invalid_state', message: '切换写入后无法读回 execution_coordination 模式' };
  }
  return { kind: 'transitioned', revision: transitioned.revision, authorization };
}
