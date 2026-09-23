import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { beginIntent } from '../src/application/coordination/intent-service.js';
import { acquireExecutionLease, acquireRuntimeLease } from '../src/application/coordination/lease-service.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  InteractionId,
  OperationId,
  PlanningCycleId,
  RuntimeIncarnationId,
} from '../src/application/dto/identity.js';
import type { CoordinationWriter } from '../src/application/ports/branch-coordination-store.js';
import {
  coordinationDatabasePath,
  type CoordinationStoreOpenResult,
} from '../src/bootstrap/composition.js';
import {
  openCoordinationStore,
  type CoordinationStore,
  type OpenCoordinationStoreResult,
} from '../src/adapters/storage/coordination-store.js';
import { runStatus, type StatusSnapshot } from '../src/interfaces/cli/status-command.js';
import { main } from '../src/interfaces/cli/main.js';

const SCOPE = 'scope-1' as CoordinationScopeId;
const SCOPE_2 = 'scope-2' as CoordinationScopeId;
const SESSION = 'session-a' as CoordinatorSessionId;
const INCARNATION = 'inc-1' as RuntimeIncarnationId;

let directory = '';
let databasePath = '';
let store: CoordinationStore;
let writer: CoordinationWriter;
let now = 1_000;

const clock = (): number => now;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-status-'));
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
      fullBranchRef: 'refs/heads/main',
      canonicalWorktreePath: '/tmp/orca-test-worktree',
    }).kind,
  ).toBe('committed');
  expect(
    store.transact({
      kind: 'register-session',
      coordinationScopeId: SCOPE,
      expectedRevision: revisionOf(),
      writer,
      coordinatorSessionId: SESSION,
      coordinatorModelConfigurationRef: 'profile-a',
      lifecycleState: 'registered',
    }).kind,
  ).toBe('committed');
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

test('status --json 输出模式、控制状态、Session、claim、lease 与交互字段', async () => {
  const capture = captureIO();
  const code = await runStatus({ openStore: () => Promise.resolve(openReadOnly()), json: true, io: capture.io });

  expect(code).toBe(0);
  expect(capture.stderr).toEqual([]);
  const snapshot = JSON.parse(capture.stdout.join('')) as StatusSnapshot;

  expect(snapshot.snapshotRevision).toBe(revisionOf());
  expect(snapshot.scope.coordinationScopeId).toBe(SCOPE);
  expect(snapshot.scope.mode).toBe('route_planning');
  expect(snapshot.scope.controlState).toBe('active');
  expect(snapshot.scope.planningCycleId).toBe('cycle-1');
  expect(snapshot.sessions.map((session) => session.coordinatorSessionId)).toEqual([SESSION]);
  expect(snapshot.scope.ticketClaims.map((claim) => claim.ticketId)).toEqual(['ticket-1']);
  expect(snapshot.scope.leases.map((lease) => lease.leaseKind).sort()).toEqual([
    'execution_coordination',
    'runtime',
  ]);
  expect(snapshot.scope.executionLeaseHolder).toBe(SESSION);
  expect(snapshot.scope.pendingInteractions.map((interaction) => interaction.interactionId)).toEqual([
    'interaction-1',
  ]);
  expect(snapshot.scope.unresolvedIntentCount).toBe(0);
  expect(snapshot.workers).toEqual([]);
  expect(snapshot.blockers).toEqual([]);
});

test('存在未决意图时快照如实反映，且只读查询不改变状态', async () => {
  const unfinished = beginIntent(store, {
    coordinationScopeId: SCOPE,
    operationId: 'op-unknown' as OperationId,
    target: { kind: 'orca_run', id: 'run-1' },
    operationCategory: 'run-create',
    writer,
    expectedRevision: revisionOf(),
  });
  expect(unfinished.kind).toBe('registered');

  const revisionBefore = revisionOf();
  const scopeBefore = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
  const capture = captureIO();
  const code = await runStatus({ openStore: () => Promise.resolve(openReadOnly()), json: true, io: capture.io });

  expect(code).toBe(0);
  const snapshot = JSON.parse(capture.stdout.join('')) as StatusSnapshot;
  expect(snapshot.scope.unresolvedIntentCount).toBe(1);
  expect(snapshot.snapshotRevision).toBe(revisionBefore);

  const scopeAfter = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
  expect(revisionOf()).toBe(revisionBefore);
  if (scopeBefore.kind === 'scope' && scopeAfter.kind === 'scope') {
    expect(scopeAfter.scope).toEqual(scopeBefore.scope);
  }
  const intents = store.query({ kind: 'intents', coordinationScopeId: SCOPE });
  if (intents.kind === 'intents') {
    expect(intents.intents.map((intent) => intent.state)).toEqual(['pending']);
  }
});

test('status 只投影仍然 open 的 Pending Interaction', async () => {
  expect(
    store.transact({
      kind: 'resolve-pending-interaction',
      coordinationScopeId: SCOPE,
      expectedRevision: revisionOf(),
      writer,
      interactionId: 'interaction-1' as InteractionId,
      state: 'answered',
      answerRef: { kind: 'answer', id: 'answer-1' },
      answerText: '已确认',
    }).kind,
  ).toBe('committed');

  const capture = captureIO();
  expect(await runStatus({ openStore: () => Promise.resolve(openReadOnly()), json: true, io: capture.io })).toBe(0);
  const snapshot = JSON.parse(capture.stdout.join('')) as StatusSnapshot;
  expect(snapshot.scope.pendingInteractions).toEqual([]);
});

test('无 TTY 的管道调用把机器输出写到标准输出，诊断写到标准错误', async () => {
  const capture = captureIO();
  const code = await main(['status', '--json'], { cwd: process.cwd(), env: {} }, capture.io, {
    openCoordinationStore: () => Promise.resolve(openReadOnly()),
  });

  expect(code).toBe(0);
  expect(capture.stderr).toEqual([]);
  expect((JSON.parse(capture.stdout.join('')) as StatusSnapshot).scope.coordinationScopeId).toBe(SCOPE);
});

test('不带 --json 时也输出可读快照', async () => {
  const capture = captureIO();
  const code = await runStatus({ openStore: () => Promise.resolve(openReadOnly()), json: false, io: capture.io });

  expect(code).toBe(0);
  expect(capture.stdout.join('')).toContain(`scope: ${SCOPE}`);
  expect(capture.stderr).toEqual([]);
});

test('存储缺失或损坏时以非零状态失败且不输出空快照', async () => {
  const missing = openCoordinationStore({
    databasePath: join(directory, 'absent.sqlite'),
    clock,
    readOnly: true,
  });
  expect(missing.kind).toBe('failed');
  if (missing.kind === 'failed') {
    expect(missing.code).toBe('missing');
  }

  writeFileSync(join(directory, 'broken.sqlite'), 'not a sqlite database');
  const broken = openCoordinationStore({
    databasePath: join(directory, 'broken.sqlite'),
    clock,
    readOnly: true,
  });
  expect(broken.kind).toBe('failed');
  if (broken.kind === 'failed') {
    expect(broken.code).toBe('unreadable');
  }

  for (const failed of [missing, broken].map(forStatus)) {
    const capture = captureIO();
    const code = await runStatus({ openStore: () => Promise.resolve(failed), json: true, io: capture.io });
    expect(code).toBe(1);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr.join('').length).toBeGreaterThan(0);
  }
});

test('schema 版本不符时以非零状态失败', async () => {
  const raw = new DatabaseSync(databasePath);
  raw.prepare("UPDATE meta SET value = '999' WHERE key = 'schema_version'").run();
  raw.close();

  const mismatched = openReadOnly();
  expect(mismatched.kind).toBe('failed');
  if (mismatched.kind === 'failed') {
    expect(mismatched.code).toBe('schema_version_unsupported');
  }

  const capture = captureIO();
  const code = await runStatus({ openStore: () => Promise.resolve(mismatched), json: true, io: capture.io });
  expect(code).toBe(1);
  expect(capture.stdout).toEqual([]);
  expect(capture.stderr.join('')).toContain('schema_version_unsupported');
});

test('存在多个 Scope 时明确失败，不提供未登记的选择参数', async () => {
  expect(
    store.transact({
      kind: 'create-scope',
      coordinationScopeId: SCOPE_2,
      expectedRevision: 0,
      writer: {
        coordinatorSessionId: 'session-b' as CoordinatorSessionId,
        runtimeIncarnationId: 'b-inc-1' as RuntimeIncarnationId,
        fencingGeneration: 0,
      },
      mode: 'route_planning',
      controlState: 'active',
      planningCycleId: null,
      fullBranchRef: 'refs/heads/second',
      canonicalWorktreePath: '/tmp/orca-test-worktree-second',
    }).kind,
  ).toBe('committed');

  const ambiguous = captureIO();
  const ambiguousCode = await runStatus({
    openStore: () => Promise.resolve(openReadOnly()),
    json: true,
    io: ambiguous.io,
  });
  expect(ambiguousCode).toBe(1);
  expect(ambiguous.stdout).toEqual([]);
  expect(ambiguous.stderr.join('')).toContain('无法确定当前 Scope');

  const unsupported = captureIO();
  expect(
    await main(['status', '--scope', 'scope-2'], { cwd: process.cwd(), env: {} }, unsupported.io, {
      openCoordinationStore: () => Promise.resolve(openReadOnly()),
    }),
  ).toBe(2);
  expect(unsupported.stderr.join('')).toContain('status 不支持参数: --scope');
});

test('status 拒绝未知参数并以用法错误退出', async () => {
  const capture = captureIO();
  const code = await main(['status', '--verbose'], { cwd: process.cwd(), env: {} }, capture.io, {
    openCoordinationStore: () => Promise.resolve(openReadOnly()),
  });

  expect(code).toBe(2);
  expect(capture.stdout).toEqual([]);
  expect(capture.stderr.join('')).toContain('status 不支持参数');
});

test('未注入依赖时 status 从仓库的 Git common dir 只读读取快照', async () => {
  const repository = mkdtempSync(join(tmpdir(), 'orca-repo-'));
  try {
    const initialized = spawnSync('git', ['init', '--quiet'], { cwd: repository, encoding: 'utf8' });
    expect(initialized.status).toBe(0);
    const reported = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: repository, encoding: 'utf8' });
    expect(reported.status).toBe(0);
    const gitCommonDir = resolve(repository, reported.stdout.trim());

    // 模拟 Companion 启动过一次：先以读写打开建立 store 与 Scope。
    const seeded = openCoordinationStore({ databasePath: coordinationDatabasePath(gitCommonDir), clock });
    if (seeded.kind !== 'opened') {
      throw new Error(seeded.message);
    }
    expect(
      seeded.store.transact({
        kind: 'create-scope',
        coordinationScopeId: SCOPE,
        expectedRevision: 0,
        writer,
        mode: 'route_planning',
        controlState: 'paused',
        planningCycleId: 'cycle-1' as PlanningCycleId,
        fullBranchRef: 'refs/heads/paused',
        canonicalWorktreePath: '/tmp/orca-test-worktree-paused',
      }).kind,
    ).toBe('committed');
    seeded.store.close();

    const capture = captureIO();
    const code = await main(
      ['status', '--json'],
      { cwd: repository, env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' } },
      capture.io,
    );

    expect(code).toBe(0);
    expect(capture.stderr).toEqual([]);
    const snapshot = JSON.parse(capture.stdout.join('')) as StatusSnapshot;
    expect(snapshot.scope.coordinationScopeId).toBe(SCOPE);
    expect(snapshot.scope.controlState).toBe('paused');
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
