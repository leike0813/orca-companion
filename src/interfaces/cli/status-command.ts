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
  readonly workers: readonly [];
  readonly blockers: readonly [];
};

export type StatusSnapshotResult =
  | { readonly kind: 'snapshot'; readonly snapshot: StatusSnapshot }
  | { readonly kind: 'failed'; readonly message: string };

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
  const { scope, sessions, leases, executionLease, ticketClaims, pendingInteractions, unresolvedIntents } =
    result.snapshot;
  return {
    kind: 'snapshot',
    snapshot: {
      schemaVersion: STATUS_SCHEMA_VERSION,
      snapshotRevision: scope.revision,
      scope: {
        coordinationScopeId: scope.coordinationScopeId,
        mode: scope.mode,
        controlState: scope.controlState,
        planningCycleId: scope.planningCycleId,
        authorization:
          scope.authorizationId === null || scope.authorizationVersion === null
            ? null
            : { id: scope.authorizationId, version: scope.authorizationVersion },
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
        executionLeaseHolder: executionLease === null ? null : executionLease.coordinatorSessionId,
        pendingInteractions: pendingInteractions
          .filter((interaction) => interaction.state === 'open')
          .map((interaction) => ({
            interactionId: interaction.interactionId,
            ownerCoordinatorSessionId: interaction.ownerCoordinatorSessionId,
            expectedRevision: interaction.expectedRevision,
          })),
        unresolvedIntentCount: unresolvedIntents.length,
      },
      sessions: sessions.map((session) => ({
        coordinatorSessionId: session.coordinatorSessionId,
        coordinatorModelConfigurationRef: session.coordinatorModelConfigurationRef,
        lifecycleState: session.lifecycleState,
      })),
      ...(scope.graphId === null || scope.graphVersion === null
        ? {}
        : { graph: { id: scope.graphId, version: scope.graphVersion } }),
      workers: [],
      blockers: [],
    },
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
