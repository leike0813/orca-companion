/**
 * IP-9b：Scope 级 Pause / Resume / Cancel / Exit 用例
 * （Owner: `m1-recover-execution`）。
 *
 * 这一层是控制动作的**唯一**落盘入口：领域判决在 `src/domain/coordination/scope-control.ts`，
 * 行级 CAS、fencing 与唯一约束由既有 Branch Coordination Store 承担。它不复制 store 规则，也不
 * 直接构造 Orca 命令——Worker 名单与停止请求通过窄 port 注入。
 *
 * 固定顺序（D9、`AGENTS.md` 第 9 节）：
 * - Pause：先写 `paused`，只停止新的派发与模型恢复；已运行 Worker、事件落盘与对账不受影响；
 * - Resume：**先跑对账用例**，对账成功后写 `active`；任何一步失败都保持 `paused`；
 * - Cancel：先写 `cancelling`（取消意图），再请求 Worker 停止；结果未确认时保持 `cancelling` 或
 *   `unverifiable`，绝不报告为已停止；
 * - Exit：不写控制状态、不请求 Worker 停止，只结束进程。
 *
 * 对账是注入的用例（IP-1 的 `reconcileOperations`），不是本模块实现的逻辑：Resume 只负责「先对账
 * 再恢复调度」这个顺序。退出后重入的策略同样在领域层声明（不假设 Worker 已停止）。
 */

import type { ControlState } from '../../domain/coordination/mode.js';
import {
  controlStateAfterCancel,
  evaluateScopeControl,
  type ScopeControlAction,
  type ScopeControlVerdict,
  type WorkerStopOutcome,
} from '../../domain/coordination/scope-control.js';
import type { CoordinationScopeId, Revision } from '../dto/identity.js';
import type { BranchCoordinationStore, CoordinationWriter } from '../ports/branch-coordination-store.js';
import { readScope } from '../planning/scope-read.js';

/** IP-1 对账用例的窄接口；本模块只消费它的结论，不复制三值归类。 */
export type ReconciliationRunSummary = {
  readonly revision: Revision;
  /** 对账后仍未决的 lane；这些 lane 依旧不可派发。 */
  readonly unresolvedLaneKeys: readonly string[];
};

export type ReconciliationRunResult =
  | { readonly kind: 'reconciled'; readonly summary: ReconciliationRunSummary }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string };

export type ScopeReconciliationRunner = (input: {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly writer: CoordinationWriter;
  readonly expectedRevision: Revision;
}) => Promise<ReconciliationRunResult>;

/** 活跃 Worker 名单的只读投影；`unavailable` 表示无法枚举，不能读作「没有 Worker」。 */
export type ActiveWorkerListResult =
  | { readonly kind: 'listed'; readonly dispatchIds: readonly string[] }
  | { readonly kind: 'unavailable'; readonly reason: string };

export type WorkerStopPort = {
  readonly listActiveDispatches: (input: {
    readonly coordinationScopeId: CoordinationScopeId;
  }) => Promise<ActiveWorkerListResult>;
  readonly requestStop: (input: {
    readonly coordinationScopeId: CoordinationScopeId;
    readonly writer: CoordinationWriter;
    readonly dispatchId: string;
  }) => Promise<WorkerStopOutcome>;
};

export type ScopeControlDependencies = {
  readonly store: BranchCoordinationStore;
  readonly reconciliation: ScopeReconciliationRunner;
  readonly workers: WorkerStopPort;
};

export type ScopeControlRequest = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly writer: CoordinationWriter;
};

export type WorkerStopRecord = {
  readonly dispatchId: string;
  readonly outcome: WorkerStopOutcome;
};

export type ScopeControlResult =
  | {
      readonly kind: 'applied';
      readonly action: ScopeControlAction;
      readonly verdict: ScopeControlVerdict;
      readonly controlState: ControlState;
      /** Resume 前置对账的结论；其它动作没有。 */
      readonly reconciliation: ReconciliationRunSummary | null;
      /** Cancel 请求的停止结果；其它动作没有。 */
      readonly workerStops: readonly WorkerStopRecord[];
    }
  | {
      readonly kind: 'unchanged';
      readonly action: ScopeControlAction;
      readonly controlState: ControlState;
      readonly reason: string;
    }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string };

/** Exit 的结果：只表达「结束进程」，不含任何控制状态写入。 */
export type ScopeExitResult = {
  readonly kind: 'exited';
  readonly verdict: ScopeControlVerdict;
  readonly controlStateWritten: null;
};

export interface ScopeControlService {
  pause(input: ScopeControlRequest): ScopeControlResult;
  resume(input: ScopeControlRequest): Promise<ScopeControlResult>;
  cancel(input: ScopeControlRequest): Promise<ScopeControlResult>;
  exit(): ScopeExitResult;
}

type ControlStateRead =
  | { readonly kind: 'read'; readonly controlState: ControlState; readonly revision: Revision }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string };

function readControlState(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
): ControlStateRead {
  const scope = readScope(store, coordinationScopeId);
  return scope.kind === 'rejected'
    ? { kind: 'rejected', code: scope.code, message: scope.message }
    : { kind: 'read', controlState: scope.scope.controlState, revision: scope.scope.revision };
}

type WriteOutcome =
  | { readonly kind: 'written'; readonly revision: Revision }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string };

/**
 * 写控制状态；遇到 `stale_revision` 时重读一次再试。
 *
 * 控制状态是 Scope 级单行事实，并发写入只可能来自同一 Scope 的其它用例；重读一次足以收敛，且不会
 * 触碰任何其它记录（预算、claim、lease、graph revision 都不经过这里）。
 */
function writeControlState(
  store: BranchCoordinationStore,
  input: {
    readonly coordinationScopeId: CoordinationScopeId;
    readonly writer: CoordinationWriter;
    readonly controlState: ControlState;
    readonly expectedRevision: Revision;
  },
): WriteOutcome {
  const attempt = (expectedRevision: Revision): WriteOutcome => {
    const result = store.transact({
      kind: 'record-control-state',
      coordinationScopeId: input.coordinationScopeId,
      expectedRevision,
      writer: input.writer,
      controlState: input.controlState,
    });
    if (result.kind === 'committed') {
      return { kind: 'written', revision: result.revision };
    }
    if (result.code === 'stale_revision' && result.currentRevision !== undefined) {
      const retried = store.transact({
        kind: 'record-control-state',
        coordinationScopeId: input.coordinationScopeId,
        expectedRevision: result.currentRevision,
        writer: input.writer,
        controlState: input.controlState,
      });
      return retried.kind === 'committed'
        ? { kind: 'written', revision: retried.revision }
        : { kind: 'rejected', code: retried.code, message: retried.message };
    }
    return { kind: 'rejected', code: result.code, message: result.message };
  };
  return attempt(input.expectedRevision);
}

function stopOutcomesFor(
  list: ActiveWorkerListResult,
  stops: readonly WorkerStopRecord[],
): readonly WorkerStopOutcome[] {
  if (list.kind === 'unavailable') {
    return ['unverifiable'];
  }
  return stops.map((record) => record.outcome);
}

export function createScopeControlService(dependencies: ScopeControlDependencies): ScopeControlService {
  const { store, reconciliation, workers } = dependencies;

  const pause = (input: ScopeControlRequest): ScopeControlResult => {
    const verdict = evaluateScopeControl('pause');
    const read = readControlState(store, input.coordinationScopeId);
    if (read.kind === 'rejected') {
      return { kind: 'rejected', code: read.code, message: read.message };
    }
    if (read.controlState === 'paused') {
      return {
        kind: 'unchanged',
        action: 'pause',
        controlState: read.controlState,
        reason: 'Scope 已处于 paused',
      };
    }
    if (read.controlState === 'cancelling' || read.controlState === 'cancelled') {
      return {
        kind: 'unchanged',
        action: 'pause',
        controlState: read.controlState,
        reason: '取消流程已开始，Pause 不改变控制状态',
      };
    }
    const written = writeControlState(store, {
      coordinationScopeId: input.coordinationScopeId,
      writer: input.writer,
      controlState: 'paused',
      expectedRevision: read.revision,
    });
    if (written.kind === 'rejected') {
      return { kind: 'rejected', code: written.code, message: written.message };
    }
    return {
      kind: 'applied',
      action: 'pause',
      verdict,
      controlState: 'paused',
      reconciliation: null,
      workerStops: [],
    };
  };

  const resume = async (input: ScopeControlRequest): Promise<ScopeControlResult> => {
    const verdict = evaluateScopeControl('resume');
    const read = readControlState(store, input.coordinationScopeId);
    if (read.kind === 'rejected') {
      return { kind: 'rejected', code: read.code, message: read.message };
    }
    if (read.controlState === 'cancelling' || read.controlState === 'cancelled') {
      return {
        kind: 'rejected',
        code: 'invalid_state',
        message: '取消流程已开始，不能恢复调度',
      };
    }

    // 先对账，再恢复调度：对账失败时控制状态保持原样，不进入 active。
    const reconciled = await reconciliation({
      coordinationScopeId: input.coordinationScopeId,
      writer: input.writer,
      expectedRevision: read.revision,
    });
    if (reconciled.kind === 'rejected') {
      return {
        kind: 'rejected',
        code: reconciled.code,
        message: `恢复前对账失败：${reconciled.message}`,
      };
    }

    const written = writeControlState(store, {
      coordinationScopeId: input.coordinationScopeId,
      writer: input.writer,
      controlState: 'active',
      expectedRevision: reconciled.summary.revision,
    });
    if (written.kind === 'rejected') {
      return { kind: 'rejected', code: written.code, message: written.message };
    }
    return {
      kind: 'applied',
      action: 'resume',
      verdict,
      controlState: 'active',
      reconciliation: reconciled.summary,
      workerStops: [],
    };
  };

  const cancel = async (input: ScopeControlRequest): Promise<ScopeControlResult> => {
    const verdict = evaluateScopeControl('cancel');
    const read = readControlState(store, input.coordinationScopeId);
    if (read.kind === 'rejected') {
      return { kind: 'rejected', code: read.code, message: read.message };
    }
    if (read.controlState === 'cancelled') {
      return {
        kind: 'unchanged',
        action: 'cancel',
        controlState: read.controlState,
        reason: 'Scope 已处于 cancelled',
      };
    }

    // 1. 先持久化取消意图：这一步成功之前不发出任何停止请求。
    const intent = writeControlState(store, {
      coordinationScopeId: input.coordinationScopeId,
      writer: input.writer,
      controlState: 'cancelling',
      expectedRevision: read.revision,
    });
    if (intent.kind === 'rejected') {
      return { kind: 'rejected', code: intent.code, message: intent.message };
    }

    // 2. 再请求 Worker 停止；逐个记录三值结果，未确认的不当作已停止。
    const list = await workers.listActiveDispatches({ coordinationScopeId: input.coordinationScopeId });
    const workerStops: WorkerStopRecord[] = [];
    if (list.kind === 'listed') {
      for (const dispatchId of list.dispatchIds) {
        const outcome = await workers.requestStop({
          coordinationScopeId: input.coordinationScopeId,
          writer: input.writer,
          dispatchId,
        });
        workerStops.push({ dispatchId, outcome });
      }
    }

    // 3. 按停止结果写最终控制状态；写不进去就保持 cancelling。
    const desired = controlStateAfterCancel(stopOutcomesFor(list, workerStops));
    if (desired === 'cancelling') {
      return {
        kind: 'applied',
        action: 'cancel',
        verdict,
        controlState: 'cancelling',
        reconciliation: null,
        workerStops,
      };
    }
    const current = readControlState(store, input.coordinationScopeId);
    if (current.kind === 'rejected') {
      return {
        kind: 'applied',
        action: 'cancel',
        verdict,
        controlState: 'cancelling',
        reconciliation: null,
        workerStops,
      };
    }
    const written = writeControlState(store, {
      coordinationScopeId: input.coordinationScopeId,
      writer: input.writer,
      controlState: desired,
      expectedRevision: current.revision,
    });
    return {
      kind: 'applied',
      action: 'cancel',
      verdict,
      controlState: written.kind === 'written' ? desired : 'cancelling',
      reconciliation: null,
      workerStops,
    };
  };

  const exit = (): ScopeExitResult => ({
    kind: 'exited',
    verdict: evaluateScopeControl('exit'),
    controlStateWritten: null,
  });

  return { pause, resume, cancel, exit };
}
