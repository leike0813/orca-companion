/**
 * MOD-05：`orca-companion status` 命令（Owner: `m1-persist-coordination-state`）。
 *
 * 只读快照：只调用 store 的 query 通道，不续租、不对账、不推进状态、不派发 Worker。
 * 机器输出只写标准输出，诊断只写标准错误，不要求 TTY。
 *
 * 存储不可读或 schema 版本不符时以非零状态失败——一个「看起来正常但什么都没读到」的空快照
 * 会让使用者误判 Scope 状态，比直接失败危险得多。
 */

import type { ControlState, CoordinationMode } from '../../domain/coordination/mode.js';
import type { CoordinationScopeId } from '../../application/dto/identity.js';
import type { CoordinationStoreOpenResult } from '../../bootstrap/composition.js';
import type { BranchCoordinationStore } from '../../application/ports/branch-coordination-store.js';
import { projectControllerSnapshot } from '../../application/controller-service.js';
import {
  projectGraphPointerView,
  projectScopeView,
  projectSessionSummaryView,
  type SessionSummaryView,
} from '../../application/tui/view-model.js';
import type { CliIO } from './doctor-command.js';

export const STATUS_SCHEMA_VERSION = 1;

export type StatusSession = {
  readonly coordinatorSessionId: string;
  readonly coordinatorModelConfigurationRef: string;
  readonly lifecycleState: string;
};

export type StatusTicketClaim = {
  readonly ticketKind: string;
  readonly ticketId: string;
  readonly coordinatorSessionId: string;
  readonly state: string;
};

export type StatusLease = {
  readonly leaseKind: string;
  readonly coordinatorSessionId: string;
  readonly runtimeIncarnationId: string;
  readonly fencingGeneration: number;
  readonly expiresAt: number | null;
};

export type StatusSnapshot = {
  readonly schemaVersion: number;
  readonly snapshotRevision: number;
  readonly scope: {
    readonly coordinationScopeId: string;
    readonly mode: CoordinationMode;
    readonly controlState: ControlState;
    readonly planningCycleId: string | null;
    readonly authorization: { readonly id: string; readonly version: number } | null;
    readonly ticketClaims: readonly StatusTicketClaim[];
    readonly leases: readonly StatusLease[];
    readonly executionLeaseHolder: string | null;
    readonly pendingInteractions: readonly {
      readonly interactionId: string;
      readonly ownerCoordinatorSessionId: string;
      readonly expectedRevision: number;
    }[];
    readonly unresolvedIntentCount: number;
  };
  readonly sessions: readonly StatusSession[];
  readonly graph?: { readonly id: string; readonly version: number };
  /** machine DTO 的既有占位字段：本里程碑不填充 Worker 与 blocker。 */
  readonly workers: readonly [];
  readonly blockers: readonly [];
};

export type StatusSnapshotResult =
  | { readonly kind: 'snapshot'; readonly snapshot: StatusSnapshot }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * 把 store 快照投影成 machine DTO。
 *
 * 字段来自与 TUI 共用的 `ControllerSnapshot` 投影规则（IC-11/IC-12），只有 CLI 专有的
 * `ticketClaims`、`leases` 与 `unresolvedIntentCount` 直接从协调快照读取——它们不是展示投影的一部分。
 * 输出形状与 `StatusJson.schemaVersion` 1 保持一致：这里不新增、不改名任何字段。
 */
export function buildStatusSnapshot(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
): StatusSnapshotResult {
  const result = store.query({ kind: 'snapshot', coordinationScopeId });
  if (result.kind === 'rejected') {
    return { kind: 'failed', message: `${result.code}: ${result.message}` };
  }
  if (result.kind !== 'snapshot') {
    return { kind: 'failed', message: 'snapshot 查询返回了非预期结果' };
  }
  const { leases, ticketClaims, unresolvedIntents } = result.snapshot;
  const counters = store.query({ kind: 'budget-counters', coordinationScopeId });

  const projected = projectControllerSnapshot({
    snapshot: result.snapshot,
    budgets: counters.kind === 'budget-counters' ? counters.counters : [],
    graphGeneration: null,
    frontier: [],
    workers: [],
    extraBlockers: [],
    maintenance: null,
    selectedSessionId: null,
    graphVersions: [],
    authorizationGraphRef: null,
    compaction: null,
  });
  const scopeView = projectScopeView(projected);
  const graph = projectGraphPointerView(projected);

  return {
    kind: 'snapshot',
    snapshot: {
      schemaVersion: STATUS_SCHEMA_VERSION,
      snapshotRevision: scopeView.revision,
      scope: {
        coordinationScopeId: scopeView.coordinationScopeId,
        mode: scopeView.mode,
        controlState: scopeView.controlState,
        planningCycleId: scopeView.planningCycleId,
        authorization:
          scopeView.authorization === null
            ? null
            : { id: scopeView.authorization.authorizationId, version: scopeView.authorization.version },
        ticketClaims: ticketClaims
          .filter((claim) => claim.state === 'active')
          .map((claim) => ({
            ticketKind: claim.ticketRef.kind,
            ticketId: claim.ticketRef.id,
            coordinatorSessionId: claim.coordinatorSessionId,
            state: claim.state,
          })),
        leases: leases.map((lease) => ({
          leaseKind: lease.kind,
          coordinatorSessionId: lease.coordinatorSessionId,
          runtimeIncarnationId: lease.runtimeIncarnationId,
          fencingGeneration: lease.fencingGeneration,
          expiresAt: lease.expiresAt,
        })),
        executionLeaseHolder: scopeView.executionLeaseHolderSessionId,
        pendingInteractions: projected.interactions
          .filter((interaction) => interaction.state === 'open')
          .map((interaction) => ({
            interactionId: interaction.interactionId,
            ownerCoordinatorSessionId: interaction.ownerCoordinatorSessionId,
            expectedRevision: interaction.expectedRevision,
          })),
        unresolvedIntentCount: unresolvedIntents.length,
      },
      sessions: projected.sessions.map((session) =>
        toStatusSession(
          projectSessionSummaryView(session, { selectedSessionId: null, unreadSessionIds: [] }),
        ),
      ),
      ...(graph === null ? {} : { graph }),
      workers: [],
      blockers: [],
    },
  };
}

/** machine DTO 只输出三个已登记字段：展示态的未读与选中标记不属于 CLI 合同。 */
function toStatusSession(session: SessionSummaryView): StatusSession {
  return {
    coordinatorSessionId: session.coordinatorSessionId,
    coordinatorModelConfigurationRef: session.coordinatorModelConfigurationRef,
    lifecycleState: session.lifecycleState,
  };
}

type ScopeResolution =
  | { readonly kind: 'resolved'; readonly coordinationScopeId: CoordinationScopeId }
  | { readonly kind: 'failed'; readonly message: string };

function resolveScopeId(store: BranchCoordinationStore): ScopeResolution {
  const scopes = store.query({ kind: 'scopes' });
  if (scopes.kind === 'rejected') {
    return { kind: 'failed', message: `${scopes.code}: ${scopes.message}` };
  }
  if (scopes.kind !== 'scopes') {
    return { kind: 'failed', message: '无法读取 Coordination Scope 列表' };
  }
  if (scopes.scopes.length === 0) {
    return { kind: 'failed', message: 'Coordination Scope 尚未初始化' };
  }
  if (scopes.scopes.length > 1) {
    return { kind: 'failed', message: '存在多个 Coordination Scope，无法确定当前 Scope' };
  }
  const only = scopes.scopes[0];
  if (only === undefined) {
    return { kind: 'failed', message: 'Coordination Scope 尚未初始化' };
  }
  return { kind: 'resolved', coordinationScopeId: only.coordinationScopeId };
}

function renderText(snapshot: StatusSnapshot): string {
  const scope = snapshot.scope;
  return [
    `scope: ${scope.coordinationScopeId}`,
    `mode: ${scope.mode}`,
    `control: ${scope.controlState}`,
    `revision: ${snapshot.snapshotRevision}`,
    `sessions: ${snapshot.sessions.length}`,
    `leases: ${scope.leases.length}`,
    `execution-lease-holder: ${scope.executionLeaseHolder ?? 'none'}`,
    `ticket-claims: ${scope.ticketClaims.length}`,
    `pending-interactions: ${scope.pendingInteractions.length}`,
    `unresolved-intents: ${scope.unresolvedIntentCount}`,
  ].join('\n');
}

export type StatusOptions = {
  readonly openStore: () => Promise<CoordinationStoreOpenResult>;
  readonly json: boolean;
  readonly io: CliIO;
};

/** 返回进程退出码：成功 0，存储不可读、版本不符或 Scope 无法确定时为非零。 */
export async function runStatus(options: StatusOptions): Promise<number> {
  const opened = await options.openStore();
  if (opened.kind === 'failed') {
    options.io.writeStderr(`status: ${opened.code}: ${opened.message}\n`);
    return 1;
  }
  const store = opened.store;
  try {
    const scope = resolveScopeId(store);
    if (scope.kind === 'failed') {
      options.io.writeStderr(`status: ${scope.message}\n`);
      return 1;
    }
    const built = buildStatusSnapshot(store, scope.coordinationScopeId);
    if (built.kind === 'failed') {
      options.io.writeStderr(`status: ${built.message}\n`);
      return 1;
    }
    options.io.writeStdout(
      options.json ? `${JSON.stringify(built.snapshot, null, 2)}\n` : `${renderText(built.snapshot)}\n`,
    );
    return 0;
  } finally {
    opened.close();
  }
}
