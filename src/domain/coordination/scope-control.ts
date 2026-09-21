/**
 * MOD-01 / IP-9a：Coordination Scope 级控制动作的纯规则
 * （Owner: `m1-recover-execution`）。
 *
 * Pause、Resume、Cancel、Exit 与 `CoordinationMode` **正交**：它们只改变控制状态，绝不新增模式，
 * 也不改变 `route_planning` / `execution_coordination` 的既有含义（D9、`AGENTS.md` 第 7、9 节）。
 *
 * 这里只做判定，不读时钟、不碰存储、不发起请求。三个不可退让的边界写进了类型与返回结构：
 * - Pause **不停止**已运行 Worker、事件落盘与确定性对账；
 * - Resume **不重置**已消耗的预算、claim、lease 或 graph revision；
 * - Cancel 必须先持久化取消意图（`cancelling`），停止结果未被确认时保持 `cancelling` 或
 *   `unverifiable`，绝不报告为已停止；
 * - Exit 不写任何控制状态，也不隐式 Pause/Cancel。
 */

import type { ControlState } from './mode.js';
import { type WorkerLiveness } from '../worker-liveness.js';

export const SCOPE_CONTROL_ACTIONS = ['pause', 'resume', 'cancel', 'exit'] as const;

export type ScopeControlAction = (typeof SCOPE_CONTROL_ACTIONS)[number];

/**
 * 一个控制动作的判决。
 *
 * `controlState` 为 `null` 只对 Exit 成立：退出不写控制状态。其余「不停止」字段是动作语义的一部分，
 * 调用方必须按它们约束副作用，而不是把它们当作参考信息。
 */
export type ScopeControlVerdict = {
  readonly action: ScopeControlAction;
  /** 该动作要落盘的控制状态；`null` 表示不写控制状态（Exit）。 */
  readonly controlState: ControlState | null;
  /** 产生任何外部副作用之前是否必须先落盘控制状态（Cancel 的取消意图）。 */
  readonly persistBeforeSideEffect: boolean;
  /** 是否停止新的 Worker 派发。 */
  readonly stopsNewDispatch: boolean;
  /** 是否停止新的模型恢复。 */
  readonly stopsModelRecovery: boolean;
  /** 恒为 `false`：Pause/Cancel 都不停止已运行的 Worker。 */
  readonly stopsRunningWorkers: false;
  /** 恒为 `false`：控制动作不停止事件落盘。 */
  readonly stopsEventPersistence: false;
  /** 恒为 `false`：控制动作不停止确定性对账。 */
  readonly stopsReconciliation: false;
  /** 是否请求 Worker 停止（只有 Cancel）。 */
  readonly requestsWorkerStop: boolean;
  /** 恢复调度之前是否必须先跑对账（Resume）。 */
  readonly reconcileBeforeScheduling: boolean;
  /** 是否结束前台进程（只有 Exit）。 */
  readonly endsProcess: boolean;
  /** 恒为 `false`：控制动作不重置已消耗资源。 */
  readonly resetsConsumedResources: false;
};

function verdict(
  action: ScopeControlAction,
  fields: Pick<
    ScopeControlVerdict,
    | 'controlState'
    | 'persistBeforeSideEffect'
    | 'stopsNewDispatch'
    | 'stopsModelRecovery'
    | 'requestsWorkerStop'
    | 'reconcileBeforeScheduling'
    | 'endsProcess'
  >,
): ScopeControlVerdict {
  return {
    action,
    ...fields,
    stopsRunningWorkers: false,
    stopsEventPersistence: false,
    stopsReconciliation: false,
    resetsConsumedResources: false,
  };
}

/**
 * 把控制动作翻译成「写什么状态、停什么、不停什么」。
 *
 * Resume 的 `reconcileBeforeScheduling` 是固定值：先对账再恢复调度，不能由调用方按需跳过。
 */
export function evaluateScopeControl(action: ScopeControlAction): ScopeControlVerdict {
  switch (action) {
    case 'pause':
      return verdict('pause', {
        controlState: 'paused',
        persistBeforeSideEffect: false,
        stopsNewDispatch: true,
        stopsModelRecovery: true,
        requestsWorkerStop: false,
        reconcileBeforeScheduling: false,
        endsProcess: false,
      });
    case 'resume':
      return verdict('resume', {
        controlState: 'active',
        persistBeforeSideEffect: false,
        stopsNewDispatch: false,
        stopsModelRecovery: false,
        requestsWorkerStop: false,
        reconcileBeforeScheduling: true,
        endsProcess: false,
      });
    case 'cancel':
      return verdict('cancel', {
        controlState: 'cancelling',
        persistBeforeSideEffect: true,
        stopsNewDispatch: true,
        stopsModelRecovery: true,
        requestsWorkerStop: true,
        reconcileBeforeScheduling: false,
        endsProcess: false,
      });
    case 'exit':
      return verdict('exit', {
        controlState: null,
        persistBeforeSideEffect: false,
        stopsNewDispatch: false,
        stopsModelRecovery: false,
        requestsWorkerStop: false,
        reconcileBeforeScheduling: false,
        endsProcess: true,
      });
  }
}

/** 当前控制状态下是否允许派发 / 是否允许模型恢复；供 IP-12 与 ControllerService 复用。 */
export type ScopeControlGate = {
  readonly mayDispatch: boolean;
  readonly mayResumeModel: boolean;
  /** 继续推进之前是否必须先完成对账并取得确定结论。 */
  readonly requiresReconciliation: boolean;
};

/**
 * 控制状态门。
 *
 * 只有 `active` 允许派发与模型恢复。`paused` 是显式暂停；`cancelling` / `cancelled` 已放弃推进；
 * `unverifiable` / `blocked` / `replanning_transition` 都必须先对账或解除阻塞。这个判决是 Scope
 * 控制层的最终门：`actionable-work` 的唤醒投影不替代它。
 */
export function scopeControlGate(controlState: ControlState): ScopeControlGate {
  if (controlState === 'active') {
    return { mayDispatch: true, mayResumeModel: true, requiresReconciliation: false };
  }
  return { mayDispatch: false, mayResumeModel: false, requiresReconciliation: true };
}

export function mayDispatch(controlState: ControlState): boolean {
  return scopeControlGate(controlState).mayDispatch;
}

export function mayResumeModel(controlState: ControlState): boolean {
  return scopeControlGate(controlState).mayResumeModel;
}

/**
 * Worker 停止请求的三值结果。
 *
 * `stopped` 表示停止已被确认；`unconfirmed` 表示请求已发出但结果还没被确认；`unverifiable` 表示
 * 连「请求是否产生效果」都无法核验。后两者都不得读作已停止。
 */
export const WORKER_STOP_OUTCOMES = ['stopped', 'unconfirmed', 'unverifiable'] as const;

export type WorkerStopOutcome = (typeof WORKER_STOP_OUTCOMES)[number];

export function isWorkerStopConfirmed(outcome: WorkerStopOutcome): boolean {
  return outcome === 'stopped';
}

/**
 * 取消请求之后应当保持的控制状态。
 *
 * - 没有被停止的 Worker（空名单）：`cancelled`，没有未确认的停止请求；
 * - 全部确认已停止：`cancelled`；
 * - 存在无法核验的结果：`unverifiable`；
 * - 只有未确认的结果：保持 `cancelling`，由后续对账继续确认。
 */
export function controlStateAfterCancel(outcomes: readonly WorkerStopOutcome[]): ControlState {
  if (outcomes.length === 0) {
    return 'cancelled';
  }
  if (outcomes.every(isWorkerStopConfirmed)) {
    return 'cancelled';
  }
  if (outcomes.includes('unverifiable')) {
    return 'unverifiable';
  }
  return 'cancelling';
}

/** 迟到事件的处置：取消路径上的事件只作为历史，不重新激活当前代际或恢复调度。 */
export const LATE_EVENT_DISPOSITIONS = ['current_generation', 'historical'] as const;

export type LateEventDisposition = (typeof LATE_EVENT_DISPOSITIONS)[number];

/**
 * 取消请求之后到达的来自旧 Worker 的事件如何处置。
 *
 * `cancelling` 与 `cancelled` 期间一律按 `historical` 处理：事件继续落盘与对账，但不得把它读成
 * 「当前代际又有工作了」而恢复调度或唤醒模型。
 */
export function lateEventDisposition(controlState: ControlState): LateEventDisposition {
  return controlState === 'cancelling' || controlState === 'cancelled' ? 'historical' : 'current_generation';
}

/**
 * 退出后重入的固定策略。
 *
 * Exit 只结束进程：活跃 Worker 可能仍在运行，因此重入**不假设** Worker 已停止，必须在派发之前
 * 完成启动对账；已经观察到 `live` 或 `unverifiable` 的 Worker 一律不得重复派发同一 Worker Task。
 */
export type ReentryPolicy = {
  readonly assumesWorkersStopped: false;
  readonly requiresReconciliationBeforeDispatch: true;
};

export function reentryPolicy(): ReentryPolicy {
  return { assumesWorkersStopped: false, requiresReconciliationBeforeDispatch: true };
}

/** 已有存活判定下能否重新派发；`live` 与 `unverifiable` 都禁止重复派发。 */
export function mayRedispatchWorker(liveness: WorkerLiveness): boolean {
  return liveness === 'exited';
}
