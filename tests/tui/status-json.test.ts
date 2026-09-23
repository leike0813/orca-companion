/**
 * `status --json` 与 TUI 共用投影的回归测试（IP-03 前置，Owner: `m2-deliver-planning-tui`）。
 *
 * `buildStatusSnapshot` 现在从与 TUI 共享的 `ControllerSnapshot` 投影派生字段。这里用**真实 store**
 * 造数据、走真实 `runStatus` 的 stdout，断言机器 DTO 的字段语义未因换投影实现而漂移；不断言整段 JSON
 * 文本，也不依赖字段顺序。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { acquireExecutionLease, acquireRuntimeLease } from '../../src/application/coordination/lease-service.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  GraphId,
  GraphVersion,
  InteractionId,
  PlanningCycleId,
  RuntimeIncarnationId,
} from '../../src/application/dto/identity.js';
import type { CoordinationWriter } from '../../src/application/ports/branch-coordination-store.js';
import type { CoordinationStoreOpenResult } from '../../src/bootstrap/composition.js';
import {
  openCoordinationStore,
  type CoordinationStore,
  type OpenCoordinationStoreResult,
} from '../../src/adapters/storage/coordination-store.js';
import { runStatus, type StatusSnapshot } from '../../src/interfaces/cli/status-command.js';

const SCOPE = 'scope-1' as CoordinationScopeId;
const SESSION = 'session-a' as CoordinatorSessionId;
const INCARNATION = 'inc-1' as RuntimeIncarnationId;

let directory = '';
let databasePath = '';
let store: CoordinationStore;
let writer: CoordinationWriter;
let now = 1_000;

const clock = (): number => now;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-tui-status-'));
  databasePath = join(directory, 'coordination.sqlite');
  now = 1_000;
  const opened = openCoordinationStore({ databasePath, clock });
  if (opened.kind !== 'opened') {
    throw new Error(opened.message);
  }
  store = opened.store;
  writer = { coordinatorSessionId: SESSION, runtimeIncarnationId: INCARNATION, fencingGeneration: 0 };

  expect(
    store.transact({
      kind: 'create-scope',
      coordinationScopeId: SCOPE,
      expectedRevision: 0,
      writer,
      mode: 'route_planning',
      controlState: 'active',
      planningCycleId: 'cycle-1' as PlanningCycleId,
    }).kind,
  ).toBe('committed');
  expect(
    store.transact({
      kind: 'register-session',
      coordinationScopeId: SCOPE,
      expectedRevision: revisionOf(),
      writer,
      coordinatorSessionId: SESSION,
      coordinatorModelConfigurationRef: 'config-a',
      lifecycleState: 'registered',
    }).kind,
  ).toBe('committed');
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

function revisionOf(): number {
  const result = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
  if (result.kind !== 'scope' || result.scope === null) {
    throw new Error('Scope 不存在');
  }
  return result.scope.revision;
}

/** 取得 Execution Coordination Lease：`update-scope-refs` 等执行期引用写入要求写入者是 holder。 */
function becomeExecutionHolder(): void {
  const lease = acquireRuntimeLease(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION,
    runtimeIncarnationId: INCARNATION,
    fencingGeneration: 0,
  });
  if (lease.kind !== 'acquired') {
    throw new Error('无法取得 Runtime Lease');
  }
  writer = { ...writer, fencingGeneration: lease.lease.fencingGeneration };
  expect(
    acquireExecutionLease(store, {
      coordinationScopeId: SCOPE,
      coordinatorSessionId: SESSION,
      runtimeIncarnationId: INCARNATION,
      fencingGeneration: writer.fencingGeneration,
    }).kind,
  ).toBe('acquired');
}

function captureIO(): {
  readonly stdout: string[];
  readonly stderr: string[];
  readonly io: { writeStdout: (text: string) => void; writeStderr: (text: string) => void };
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      writeStdout: (text: string) => stdout.push(text),
      writeStderr: (text: string) => stderr.push(text),
    },
  };
}

function openReadOnly(): CoordinationStoreOpenResult {
  return forStatus(openCoordinationStore({ databasePath, clock, readOnly: true }));
}

function forStatus(opened: OpenCoordinationStoreResult): CoordinationStoreOpenResult {
  return opened.kind === 'failed'
    ? opened
    : { kind: 'opened', store: opened.store, close: opened.store.close };
}

async function readJsonSnapshot(): Promise<{ readonly code: number; readonly stderr: string[]; readonly raw: string }> {
  const capture = captureIO();
  const code = await runStatus({ openStore: () => Promise.resolve(openReadOnly()), json: true, io: capture.io });
  return { code, stderr: capture.stderr, raw: capture.stdout.join('') };
}

describe('快照 DTO 与 CLI 复用（IP-03 前置）', () => {
  test('stdout 可解析且 Scope/Session 字段语义未变', async () => {
    becomeExecutionHolder();
    expect(
      store.transact({
        kind: 'record-ticket-claim',
        coordinationScopeId: SCOPE,
        expectedRevision: revisionOf(),
        writer,
        ticketRef: { kind: 'decision_ticket', id: 'ticket-1' },
      }).kind,
    ).toBe('committed');
    expect(
      store.transact({
        kind: 'record-pending-interaction',
        coordinationScopeId: SCOPE,
        expectedRevision: revisionOf(),
        writer,
        interactionId: 'interaction-1' as InteractionId,
        ownerCoordinatorSessionId: SESSION,
        subjectRef: { kind: 'decision_ticket', id: 'ticket-1' },
      }).kind,
    ).toBe('committed');
    expect(
      store.transact({
        kind: 'update-scope-refs',
        coordinationScopeId: SCOPE,
        expectedRevision: revisionOf(),
        writer,
        graphId: 'graph-1' as GraphId,
        graphVersion: 2 as GraphVersion,
        authorizationId: 'auth-1',
        authorizationVersion: 3,
      }).kind,
    ).toBe('committed');

    const revision = revisionOf();
    const { code, stderr, raw } = await readJsonSnapshot();

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    const snapshot = JSON.parse(raw) as StatusSnapshot;

    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.snapshotRevision).toBe(revision);
    expect(snapshot.scope.coordinationScopeId).toBe(SCOPE);
    expect(snapshot.scope.mode).toBe('route_planning');
    expect(snapshot.scope.controlState).toBe('active');
    expect(snapshot.scope.planningCycleId).toBe('cycle-1');
    expect(snapshot.scope.authorization).toEqual({ id: 'auth-1', version: 3 });
    expect(snapshot.scope.executionLeaseHolder).toBe(SESSION);
    expect(snapshot.scope.ticketClaims.map((claim) => claim.ticketId)).toEqual(['ticket-1']);
    expect([...snapshot.scope.leases.map((lease) => lease.leaseKind)].sort()).toEqual([
      'execution_coordination',
      'runtime',
    ]);
    expect(snapshot.scope.pendingInteractions.map((interaction) => interaction.interactionId)).toEqual([
      'interaction-1',
    ]);
    expect(snapshot.scope.unresolvedIntentCount).toBe(0);

    // sessions 只输出已登记的三个字段：展示态的未读/选中标记不属于 CLI 合同。
    const [session] = snapshot.sessions;
    expect(session?.coordinatorSessionId).toBe(SESSION);
    expect(session?.coordinatorModelConfigurationRef).toBe('config-a');
    expect(Object.keys(session ?? {}).sort()).toEqual([
      'coordinatorModelConfigurationRef',
      'coordinatorSessionId',
      'lifecycleState',
    ]);

    expect(snapshot.graph).toEqual({ id: 'graph-1', version: 2 });
    expect(snapshot.workers).toEqual([]);
    expect(snapshot.blockers).toEqual([]);
  });

  test('Scope 没有图指针时 JSON 不出现 graph 键', async () => {
    const { code, stderr, raw } = await readJsonSnapshot();
    expect(code).toBe(0);
    expect(stderr).toEqual([]);

    const snapshot = JSON.parse(raw) as Record<string, unknown>;
    expect(snapshot['schemaVersion']).toBe(1);
    expect('graph' in snapshot).toBe(false);
    expect(snapshot['workers']).toEqual([]);
    expect(snapshot['blockers']).toEqual([]);
    const scope = snapshot['scope'] as { readonly authorization: unknown; readonly planningCycleId: unknown };
    expect(scope.authorization).toBeNull();
    expect(scope.planningCycleId).toBe('cycle-1');
  });

  test('snapshotRevision 与控制状态跟随 store，且只读查询不写回', async () => {
    // 任何共享写入都必须来自活跃 Runtime Lease 的 incarnation。
    becomeExecutionHolder();
    const before = revisionOf();
    expect(
      store.transact({
        kind: 'record-control-state',
        coordinationScopeId: SCOPE,
        expectedRevision: before,
        writer,
        controlState: 'paused',
      }).kind,
    ).toBe('committed');
    const paused = revisionOf();
    expect(paused).toBeGreaterThan(before);

    const { code, raw } = await readJsonSnapshot();
    expect(code).toBe(0);
    const snapshot = JSON.parse(raw) as StatusSnapshot;
    expect(snapshot.scope.controlState).toBe('paused');
    expect(snapshot.snapshotRevision).toBe(paused);
    expect(revisionOf()).toBe(paused);
  });
});
