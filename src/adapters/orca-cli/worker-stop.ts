/**
 * IP-07：Orca `worker-stop` 的 exact stop verdict → Companion `WorkerStopPort` 的生产实现。
 *
 * 这个 adapter 只做三件事：枚举当前 Run 的活跃 Dispatch、按「意图先落盘、再发一次稳定身份的外部
 * mutation」的顺序请求停止、把 Orca 回执映射成三值停止结论。控制状态由 IP-9b 的 Scope control 用例
 * 决定，这里不写；结果不确定时也不换 OperationId 重试，而是把原身份留在这里等宿主对账。
 *
 * state 词表的依据（只读 `references/orca` 的代码事实，不复制它的状态机）：
 * - `src/main/runtime/rpc/methods/orchestration/worker/worker-stop.ts` 的 `orchestration.workerStop`
 *   回执形状是 `{ dispatchId, state, alreadySettled, processAction, lastError?, warning? }`；成功路径的
 *   `state` 取 worker 行状态，未知路径取 `markWorkerStopUnknown` 写下的 `stop_unknown`。
 * - `src/main/runtime/orchestration/db/worker-dispatch/worker-dispatch-stop.ts`：
 *   `settleWorkerStop` / `reconcileFederatedWorkerStop` 只把 worker 迁到 `stopped`；`beginWorkerStop` 把
 *   `succeeded|failed|stopped|abandoned` 视为已终态（`already_settled`）；`resumeFederatedWorkerForTerminalRelay`
 *   把联邦 Relay 的 Dispatch 迁回 `ready`。
 * - `src/main/runtime/orchestration/context-only-dispatch-release.ts`：abandon 的语义是「进程未被证明停止、
 *   未受监督的终端被保留」，因此 `abandoned` 不能算作已停止。
 * - `src/cli/handlers/orchestration/worker-terminal-handlers.ts`：CLI 只把 `stop_unknown` 当失败回执
 *   （退出码 1），其余 state 原样打印，所以「是否已核验停止」必须由 Companion 自己按词表判定。
 */

import { beginIntent, blockLane, settleIntent } from '../../application/coordination/intent-service.js';
import type {
  ActiveWorkerListResult,
  WorkerStopPort,
} from '../../application/coordination/scope-control-service.js';
import type { CoordinationScopeId, EntityRef, OperationId } from '../../application/dto/identity.js';
import type { OperationOutcome } from '../../application/dto/operation-outcome.js';
import type {
  BranchCoordinationStore,
  CoordinationWriter,
} from '../../application/ports/branch-coordination-store.js';
import type { ExecutionAuthority, ExecutionBackend } from '../../application/ports/execution-backend.js';
import { buildExecutionScope, reconcileOperation } from '../../application/ports/execution-backend.js';
import { readScope } from '../../application/planning/scope-read.js';
import type { WorkerStopOutcome } from '../../domain/coordination/scope-control.js';

/** Orca worker-stop 回执的本地 contract mirror；字段语义对齐 orchestration.worker-stop。 */
export type WorkerStopReceipt = {
  readonly dispatchId: string;
  readonly state: string;
  readonly alreadySettled: boolean;
  readonly processAction: string | null;
};

export function parseWorkerStopReceipt(
  raw: unknown,
): { readonly ok: true; readonly value: WorkerStopReceipt } | { readonly ok: false; readonly message: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, message: 'worker stop: 回执不是对象' };
  }
  const record = raw as Record<string, unknown>;
  const dispatchId = record['dispatchId'];
  const state = record['state'];
  const alreadySettled = record['alreadySettled'];
  if (typeof dispatchId !== 'string' || dispatchId.length === 0) {
    return { ok: false, message: 'worker stop: 缺少 dispatchId' };
  }
  if (typeof state !== 'string' || state.length === 0) {
    return { ok: false, message: 'worker stop: 缺少 state' };
  }
  if (typeof alreadySettled !== 'boolean') {
    return { ok: false, message: 'worker stop: 缺少 alreadySettled' };
  }
  const processAction = record['processAction'];
  if (processAction !== undefined && processAction !== null && typeof processAction !== 'string') {
    return { ok: false, message: 'worker stop: processAction 类型不符' };
  }
  return {
    ok: true,
    value: { dispatchId, state, alreadySettled, processAction: processAction ?? null },
  };
}

/** 进程停止已被证明的唯一状态：`settleWorkerStop` 与 `reconcileFederatedWorkerStop` 只写这一个。 */
const STOPPED_STATE = 'stopped';

/** 已终态的 Worker 状态：`beginWorkerStop` 的 `already_settled` 集合去掉上一条与 `abandoned`。 */
const SETTLED_WITHOUT_PROCESS_STATES: Readonly<Record<string, true>> = { succeeded: true, failed: true };

/** 「请求已受理、尚无结论」的状态：`stopping` 是停止在途，`ready` 是联邦 Relay 尚未回报的复归。 */
const UNRESOLVED_PENDING_STATES: Readonly<Record<string, true>> = { stopping: true, ready: true };

/** 回执 → 三值停止结论的唯一映射点；未登记的 state fail closed 为 `unverifiable`。 */
export function workerStopOutcomeOf(receipt: WorkerStopReceipt): WorkerStopOutcome {
  if (receipt.state === STOPPED_STATE) {
    return 'stopped';
  }
  if (SETTLED_WITHOUT_PROCESS_STATES[receipt.state] === true) {
    // `alreadySettled` 是这条结论的唯一凭据：它来自 `already_settled` 分支，表示停止请求到达时该
    // Dispatch 已经是终态、没有仍存活的 Worker 进程。缺了它就只剩一个状态字符串，不足以下结论。
    return receipt.alreadySettled ? 'stopped' : 'unverifiable';
  }
  if (UNRESOLVED_PENDING_STATES[receipt.state] === true) {
    return 'unconfirmed';
  }
  // `stop_unknown`、`abandoned`（进程未证明停止）、context-only 的 DispatchStatus 与任何未登记取值。
  return 'unverifiable';
}

export type OrcaWorkerStopPortDependencies = {
  readonly backend: ExecutionBackend;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly backendIdentityRef: string;
  readonly timeoutMs: number;
  /** 当前可枚举的 Orca Run；`null` 表示无当前 Run（此时名单按 unavailable 报告）。 */
  readonly activeRunId: () => string | null;
  /** 当前执行授权事实；无法装配时返回 `null`，该次停止按 `unverifiable` 报告。 */
  readonly authority: () => ExecutionAuthority | null;
  /** Operation Intent 的落盘入口；宿主注入 store 与当前 revision 读取。 */
  readonly store: BranchCoordinationStore;
  readonly clock?: () => number;
};

/**
 * 校验 `worker-list` 的已解析载荷：只取非空 `dispatchId`。
 * `dispatchId` 为 `null` 的条目是 Orca 报出的无 Dispatch 记录，不是「一个可停止的 Worker」；
 * 结构本身不符（不是对象、没有 workers 数组、字段类型错）则返回 `null`，由调用方按 unavailable 报告。
 */
function readActiveDispatchIds(value: unknown): readonly string[] | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const workers = (value as { readonly workers?: unknown }).workers;
  if (!Array.isArray(workers)) {
    return null;
  }
  const dispatchIds: string[] = [];
  for (const worker of workers) {
    if (typeof worker !== 'object' || worker === null) {
      return null;
    }
    const dispatchId = (worker as { readonly dispatchId?: unknown }).dispatchId;
    if (dispatchId === null || dispatchId === undefined) {
      continue;
    }
    if (typeof dispatchId !== 'string' || dispatchId.length === 0) {
      return null;
    }
    dispatchIds.push(dispatchId);
  }
  return dispatchIds;
}

export function createOrcaWorkerStopPort(dependencies: OrcaWorkerStopPortDependencies): WorkerStopPort {
  const { backend, coordinationScopeId, backendIdentityRef, timeoutMs, store } = dependencies;

  /** 每次写入前重读当前 revision；读不回来时退回意图登记时的 revision。 */
  const currentRevision = (fallback: number): number => {
    const read = readScope(store, coordinationScopeId);
    return read.kind === 'read' ? read.scope.revision : fallback;
  };

  const settle = (
    operationId: OperationId,
    writer: CoordinationWriter,
    fallbackRevision: number,
    outcome: OperationOutcome<unknown>,
  ): void => {
    settleIntent(store, {
      coordinationScopeId,
      operationId,
      writer,
      expectedRevision: currentRevision(fallbackRevision),
      outcome,
    });
  };

  /**
   * 无法核验的结论按 lane 记下来：意图阻塞保留在原身份上，宿主的对账与用户处置都还能读到原因。
   * 这里不写「已停止」，也不写「副作用未发生」——那是两种它不能证明的结论。
   */
  const blockUnverified = (
    operationId: OperationId,
    writer: CoordinationWriter,
    fallbackRevision: number,
    reason: string,
  ): void => {
    blockLane(store, {
      coordinationScopeId,
      operationId,
      writer,
      expectedRevision: currentRevision(fallbackRevision),
      reason,
    });
  };

  return {
    listActiveDispatches: async (): Promise<ActiveWorkerListResult> => {
      const runId = dependencies.activeRunId();
      if (runId === null) {
        return { kind: 'unavailable', reason: 'no-active-run' };
      }
      // active 语义由 Orca 的 `--terminal-state` 过滤给出：本地不做「哪些状态算活跃」的推断。
      const result = await backend.query({ operation: 'worker-list', runId, terminalState: 'active' });
      if (result.kind !== 'accepted') {
        return { kind: 'unavailable', reason: `${result.code}: ${result.message}` };
      }
      const dispatchIds = readActiveDispatchIds(result.value);
      if (dispatchIds === null) {
        return { kind: 'unavailable', reason: 'invalid_response: worker-list 载荷不是结构完整的名单' };
      }
      return { kind: 'listed', dispatchIds };
    },

    requestStop: async ({ writer, dispatchId }): Promise<WorkerStopOutcome> => {
      const operationId = `worker-stop:${coordinationScopeId}:${dispatchId}` as OperationId;
      const target: EntityRef<string> = { kind: 'worker-dispatch', id: dispatchId };

      // a. 先读当前 revision：读不到就没有可信的 CAS 前置事实，不发 mutation。
      const read = readScope(store, coordinationScopeId);
      if (read.kind !== 'read') {
        return 'unverifiable';
      }
      const expectedRevision = read.scope.revision;

      // b. 意图先落盘；同一 Dispatch 的重试派生同一个 OperationId，因此重放读到的是同一条记录。
      const begun = beginIntent(store, {
        coordinationScopeId,
        operationId,
        target,
        operationCategory: 'worker-stop',
        writer,
        expectedRevision,
      });
      if (begun.kind === 'lane_blocked' || begun.kind === 'lane_busy') {
        return 'unconfirmed';
      }
      if (begun.kind === 'rejected') {
        return 'unverifiable';
      }
      if (begun.kind === 'existing') {
        if (begun.intent.state === 'settled') {
          return begun.intent.outcomeClass === 'accepted' ? 'stopped' : 'unverifiable';
        }
        return 'unconfirmed';
      }

      // c. 没有可信的执行授权就不发 mutation；意图保留未决，由宿主对账，不从端口里编造收尾。
      const authority = dependencies.authority();
      if (authority === null) {
        return 'unverifiable';
      }

      // d. 一次稳定身份的 mutation。任何分支都不换 ID 重试。
      const outcome = await backend.mutate(
        { operation: 'worker-stop', dispatchId },
        buildExecutionScope({
          coordinationScopeId,
          coordinatorSessionId: writer.coordinatorSessionId,
          runtimeIncarnationId: writer.runtimeIncarnationId,
          fencingGeneration: writer.fencingGeneration,
          backendIdentityRef,
          operationId,
          target,
          expectedRevision,
          timeoutMs,
          authority,
        }),
      );

      if (outcome.kind === 'rejected') {
        // 可证明未产生副作用：按确定的拒绝收尾，结论仍是无法核验停止。
        settle(operationId, writer, expectedRevision, outcome);
        return 'unverifiable';
      }
      if (outcome.kind === 'unknown') {
        // unknown 先按原身份记下 backend request 引用（意图保持未决），再对账；对账仍不确定则由
        // 宿主的对账或用户处置解阻塞，这里不发明结论、也不换 ID 重试。
        settle(operationId, writer, expectedRevision, outcome);
        const reconciled = await reconcileOperation(backend, outcome.operation);
        blockUnverified(
          operationId,
          writer,
          expectedRevision,
          `worker-stop 结果未知（对账结论 ${reconciled.kind}），缺少停否的证明`,
        );
        return 'unverifiable';
      }

      const parsed = parseWorkerStopReceipt(outcome.value);
      if (!parsed.ok) {
        // 回执不可解析：既不读成已停止，也不宣称没有副作用。
        blockUnverified(operationId, writer, expectedRevision, `worker-stop 回执无法解析：${parsed.message}`);
        return 'unverifiable';
      }
      const verdict = workerStopOutcomeOf(parsed.value);
      if (verdict === 'stopped') {
        settle(operationId, writer, expectedRevision, outcome);
        return 'stopped';
      }
      if (verdict === 'unconfirmed') {
        // 请求已受理、回执还没有结论：意图留在未决，重放仍按同一 ID 得到 unconfirmed。
        return 'unconfirmed';
      }
      blockUnverified(
        operationId,
        writer,
        expectedRevision,
        `Orca 回执 state=${parsed.value.state} 不是可核验的停止结论`,
      );
      return 'unverifiable';
    },
  };
}
