/**
 * IC-04 的 best-effort 维护 lane
 * （Owner: `m1-run-coordinator-sessions`）。
 *
 * 挂起期间可以维持 provider 缓存与连接，但这条 lane 永远不是工作推进通道（D6）。因此它对
 * checkpoint store、Branch Coordination Store 与 transcript 都没有访问能力——不是「承诺不写」，
 * 而是结构上写不了：它只拿到 fencing 判定、控制状态、Actionable Work 投影和一个保活动作。
 *
 * 维护有三个边界：只在 Runtime Lease 与当前 fencing generation 有效时执行；受有限 cycle 上限
 * 约束；出现 Actionable Work 立即让位，Scope 进入非 active 控制状态时立即停止且不再发起保活。
 * lease 丢失或 generation 落后时静默停止，绝不尝试重新获取。
 */

import type { ControlState } from '../../domain/coordination/mode.js';
import type { FencingAssertion } from './runtime-guard.js';
import type { ActionableWorkProjection } from './actionable-work.js';

/** 默认的有限维护 cycle 上限；可按项目配置收紧或放宽，但必须有限。 */
export const MAINTENANCE_CYCLE_LIMIT = 8;

export const MAINTENANCE_STOP_REASONS = [
  'cycle_limit_reached',
  'actionable_work',
  'control_state',
  'fencing_lost',
  'keepalive_unavailable',
  'already_stopped',
] as const;

export type MaintenanceStopReason = (typeof MAINTENANCE_STOP_REASONS)[number];

/** 维护 lane 的当前状态；`cyclesRun` 是已消耗的保活次数，不因 fencing 或控制状态而重置。 */
export type MaintenanceLaneState = {
  readonly cyclesRun: number;
  readonly stopped: boolean;
  readonly stopReason: MaintenanceStopReason | null;
};

export const INITIAL_MAINTENANCE_STATE: MaintenanceLaneState = {
  cyclesRun: 0,
  stopped: false,
  stopReason: null,
};

export type MaintenancePlan =
  | { readonly kind: 'run'; readonly cycle: number; readonly note: string }
  | { readonly kind: 'stop'; readonly reason: MaintenanceStopReason };

export type MaintenancePlanningInput = {
  readonly state: MaintenanceLaneState;
  readonly fencing: FencingAssertion;
  readonly controlState: ControlState;
  readonly projection: ActionableWorkProjection;
  readonly cycleLimit?: number;
};

/**
 * 判定是否还能执行一次保活。
 *
 * 判定顺序即优先级：已停止 → fencing → 控制状态 → Actionable Work → cycle 上限。
 * Actionable Work 排在 cycle 上限之前，因为「有真实工作」优先于「还能不能保活」。
 */
export function planMaintenance(input: MaintenancePlanningInput): MaintenancePlan {
  if (input.state.stopped) {
    return { kind: 'stop', reason: input.state.stopReason ?? 'already_stopped' };
  }
  if (input.fencing.kind === 'fenced') {
    return { kind: 'stop', reason: 'fencing_lost' };
  }
  if (input.controlState !== 'active') {
    return { kind: 'stop', reason: 'control_state' };
  }
  if (input.projection.items.length > 0) {
    return { kind: 'stop', reason: 'actionable_work' };
  }
  const cycleLimit = input.cycleLimit ?? MAINTENANCE_CYCLE_LIMIT;
  if (input.state.cyclesRun >= cycleLimit) {
    return { kind: 'stop', reason: 'cycle_limit_reached' };
  }
  return {
    kind: 'run',
    cycle: input.state.cyclesRun + 1,
    note: `维持连接与缓存（第 ${String(input.state.cyclesRun + 1)}/${String(cycleLimit)} 次）`,
  };
}

/** 保活结果。`unavailable` 是 best-effort 语义下的正常结束，不是错误。 */
export type KeepaliveOutcome =
  | { readonly kind: 'kept-warm'; readonly detail: string }
  | { readonly kind: 'unavailable'; readonly reason: string };

export type MaintenanceCycleInput = MaintenancePlanningInput & {
  readonly keepalive: () => Promise<KeepaliveOutcome>;
};

export type MaintenanceCycleResult =
  | { readonly kind: 'performed'; readonly state: MaintenanceLaneState; readonly note: string }
  | { readonly kind: 'stopped'; readonly state: MaintenanceLaneState; readonly reason: MaintenanceStopReason };

function stopped(state: MaintenanceLaneState, reason: MaintenanceStopReason): MaintenanceCycleResult {
  return { kind: 'stopped', state: stopMaintenance(state, reason), reason };
}

/**
 * 执行至多一次保活。
 *
 * 计划判定在动作之前完成，动作之后只推进 cycle 计数；保活失败只停止这条 lane，不产生业务状态。
 */
export async function runMaintenanceCycle(input: MaintenanceCycleInput): Promise<MaintenanceCycleResult> {
  const plan = planMaintenance(input);
  if (plan.kind === 'stop') {
    return stopped(input.state, plan.reason);
  }

  const outcome = await input.keepalive();
  if (outcome.kind === 'unavailable') {
    return stopped(input.state, 'keepalive_unavailable');
  }
  return {
    kind: 'performed',
    state: { cyclesRun: input.state.cyclesRun + 1, stopped: false, stopReason: null },
    note: outcome.detail,
  };
}

/**
 * Actionable Work 抢占维护。
 *
 * 让位与「停止」不同：真实工作出现意味着连接与缓存刚刚被用过，所以保活预算重新开始计算，
 * 而不是把一个已经无意义的消耗计数带进下一个挂起周期。因此这里不需要读取之前的计数。
 */
export function yieldForActionableWork(): MaintenanceLaneState {
  return { cyclesRun: 0, stopped: true, stopReason: 'actionable_work' };
}

/** 因控制状态或 fencing 停止维护：保留已消耗的 cycle 计数，方便诊断无限心跳。 */
export function stopMaintenance(
  state: MaintenanceLaneState,
  reason: MaintenanceStopReason,
): MaintenanceLaneState {
  return { cyclesRun: state.cyclesRun, stopped: true, stopReason: reason };
}
