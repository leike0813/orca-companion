/**
 * `m1-wire-foreground-planning-runtime` D2 的行为测试：Scope 注册绑定与 schema 10。
 *
 * 固定四件可观察事实：schema 9 的旧库升级后旧 Scope 保留未绑定状态（迁移不猜旧值）；新 Scope 必须
 * 带完整 branch ref 与 canonical worktree；同一个 common dir 内一个 branch ref 至多属于一个 Scope；
 * 一次性绑定只在绑定为空且该 Scope 从未使用过 Runtime Lease 时成立。
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { openCoordinationStore, type CoordinationStore } from '../../src/adapters/storage/coordination-store.js';
import { MIGRATIONS, SCHEMA_VERSION, SCHEMA_VERSION_KEY } from '../../src/adapters/storage/schema.js';
import { resolveGitScopeIdentity } from '../../src/bootstrap/composition.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  PlanningCycleId,
  RuntimeIncarnationId,
} from '../../src/application/dto/identity.js';
import {
  bindScopeIdentity,
  initializeCoordinationScope,
} from '../../src/application/planning/initialize-scope.js';
import type {
  CoordinationCommandResult,
  CoordinationWriter,
} from '../../src/application/ports/branch-coordination-store.js';

const SCOPE = 'scope-1' as CoordinationScopeId;
const OTHER_SCOPE = 'scope-2' as CoordinationScopeId;
const SESSION = 'session-a' as CoordinatorSessionId;
const SESSION_B = 'session-b' as CoordinatorSessionId;
const CYCLE = 'cycle-1' as PlanningCycleId;

let directory = '';
let store: CoordinationStore;
let now = 1_000;

const clock = (): number => now;

const writerOf = (sessionId: CoordinatorSessionId): CoordinationWriter => ({
  coordinatorSessionId: sessionId,
  runtimeIncarnationId: `${sessionId}#bootstrap` as RuntimeIncarnationId,
  fencingGeneration: 0,
});

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-scope-binding-'));
  now = 1_000;
  store = openAt(join(directory, 'coordination.sqlite'));
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

function openAt(databasePath: string): CoordinationStore {
  const opened = openCoordinationStore({ databasePath, clock });
  if (opened.kind !== 'opened') {
    throw new Error(opened.message);
  }
  return opened.store;
}

/**
 * 构造一个 schema 9 的旧库：逐条执行当时已发布的 migration，再写入一条没有绑定的 Scope。
 *
 * 用真实的旧 schema 而不是伪造形状，因为要验证的正是「升级不猜旧值」。
 */
function createLegacyDatabase(databasePath: string): void {
  const db = new DatabaseSync(databasePath);
  for (const migration of MIGRATIONS) {
    if (migration.version > 9) {
      continue;
    }
    for (const statement of migration.statements) {
      db.exec(statement);
    }
  }
  db.prepare(
    `INSERT INTO scope (
       coordination_scope_id, mode, control_state, planning_cycle_id,
       graph_id, graph_version, authorization_id, authorization_version, revision, updated_at
     ) VALUES (?, 'route_planning', 'active', 'cycle-legacy', NULL, NULL, NULL, NULL, 1, 1)`,
  ).run(SCOPE);
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(SCHEMA_VERSION_KEY, '9');
  db.close();
}

function createScope(scopeId: CoordinationScopeId, ref: string): CoordinationCommandResult {
  return store.transact({
    kind: 'create-scope',
    coordinationScopeId: scopeId,
    expectedRevision: 0,
    writer: writerOf(SESSION),
    mode: 'route_planning',
    controlState: 'active',
    planningCycleId: CYCLE,
    fullBranchRef: ref,
    canonicalWorktreePath: `/tmp/${scopeId}`,
  });
}

test('schema 9 的旧库升级到 10，旧 Scope 保留未绑定状态', () => {
  store.close();
  const databasePath = join(directory, 'legacy.sqlite');
  createLegacyDatabase(databasePath);

  store = openAt(databasePath);

  expect(SCHEMA_VERSION).toBe(10);
  const scope = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
  expect(scope.kind).toBe('scope');
  if (scope.kind !== 'scope' || scope.scope === null) {
    return;
  }
  expect(scope.scope.fullBranchRef).toBeNull();
  expect(scope.scope.canonicalWorktreePath).toBeNull();
  expect(scope.scope.planningCycleId).toBe('cycle-legacy');

  // 升级后的库可以按新形状写入。
  expect(createScope(OTHER_SCOPE, 'refs/heads/other').kind).toBe('committed');
  // 该用例要构造真实 schema 9 库并跑完 10 段 migration；并行全量套件下 5s 默认上限会被机器负载吃掉。
}, 30_000);

test('新 Scope 必须带完整 branch ref 与 canonical worktree', () => {
  const missing = store.transact({
    kind: 'create-scope',
    coordinationScopeId: SCOPE,
    expectedRevision: 0,
    writer: writerOf(SESSION),
    mode: 'route_planning',
    controlState: 'active',
    planningCycleId: CYCLE,
  } as never);

  expect(missing.kind).toBe('rejected');

  const created = createScope(SCOPE, 'refs/heads/main');
  expect(created.kind).toBe('committed');
  const scope = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
  if (scope.kind !== 'scope' || scope.scope === null) {
    throw new Error('Scope 应该存在');
  }
  expect(scope.scope.fullBranchRef).toBe('refs/heads/main');
  expect(scope.scope.canonicalWorktreePath).toBe(`/tmp/${SCOPE}`);
});

test('同一个 common dir 内一个 branch ref 至多属于一个 Scope', () => {
  expect(createScope(SCOPE, 'refs/heads/main').kind).toBe('committed');
  const conflict = createScope(OTHER_SCOPE, 'refs/heads/main');

  expect(conflict).toMatchObject({ kind: 'rejected', code: 'constraint' });
});

test('一次性绑定只在未绑定且没有 Runtime Lease 时成立', () => {
  store.close();
  const databasePath = join(directory, 'legacy-bind.sqlite');
  createLegacyDatabase(databasePath);
  store = openAt(databasePath);

  const bound = bindScopeIdentity({
    store,
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION,
    expectedRevision: 1,
    fullBranchRef: 'refs/heads/main',
    canonicalWorktreePath: '/tmp/orca-worktree',
  });
  expect(bound.kind).toBe('bound');

  const scope = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
  if (scope.kind !== 'scope' || scope.scope === null) {
    throw new Error('Scope 应该存在');
  }
  expect(scope.scope.fullBranchRef).toBe('refs/heads/main');

  // 绑定不可原地改写：再次绑定被拒绝，且不推进 revision。
  const again = bindScopeIdentity({
    store,
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION,
    expectedRevision: bound.kind === 'bound' ? bound.revision : 0,
    fullBranchRef: 'refs/heads/other',
    canonicalWorktreePath: '/tmp/orca-other',
  });
  expect(again).toMatchObject({ kind: 'rejected', code: 'constraint' });

  // stale revision 零写入。
  const stale = bindScopeIdentity({
    store,
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION,
    expectedRevision: 0,
    fullBranchRef: 'refs/heads/third',
    canonicalWorktreePath: '/tmp/orca-third',
  });
  expect(stale).toMatchObject({ kind: 'rejected', code: 'stale_revision' });
  // 该用例同样要构造 schema 9 旧库并跑完全部 migration，见上一个用例的说明。
}, 30_000);

test('已经使用过 Runtime Lease 的 Scope 不能被补齐身份绑定', () => {
  store.close();
  const databasePath = join(directory, 'legacy-leased.sqlite');
  createLegacyDatabase(databasePath);
  store = openAt(databasePath);

  const registered = store.transact({
    kind: 'register-session',
    coordinationScopeId: SCOPE,
    expectedRevision: 1,
    writer: writerOf(SESSION),
    coordinatorSessionId: SESSION,
    coordinatorModelConfigurationRef: 'model-config-1',
    lifecycleState: 'registered',
  });
  expect(registered.kind).toBe('committed');
  const acquired = store.transact({
    kind: 'acquire-runtime-lease',
    coordinationScopeId: SCOPE,
    expectedRevision: registered.kind === 'committed' ? registered.revision : 0,
    writer: writerOf(SESSION),
    ttlMs: 30_000,
  });
  expect(acquired.kind).toBe('committed');

  const bound = bindScopeIdentity({
    store,
    coordinationScopeId: SCOPE,
    // 另一个 Session 也补不齐：绑定前提是「该 Scope 从未使用过 Runtime Lease」，与谁提交无关。
    coordinatorSessionId: SESSION_B,
    expectedRevision: acquired.kind === 'committed' ? acquired.revision : 0,
    fullBranchRef: 'refs/heads/main',
    canonicalWorktreePath: '/tmp/orca-worktree',
  });

  expect(bound).toMatchObject({ kind: 'rejected', code: 'constraint' });
  const scope = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
  if (scope.kind !== 'scope' || scope.scope === null) {
    throw new Error('Scope 应该存在');
  }
  expect(scope.scope.fullBranchRef).toBeNull();
  // 该用例要构造 schema 9 旧库、注册 Session 并取租约；并行全量套件下 5s 上限会被机器负载吃掉。
}, 30_000);

test('初始化用例原子写入用户登记的身份绑定', () => {
  const initialized = initializeCoordinationScope({
    store,
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION,
    coordinatorModelConfigurationRef: 'model-config-1',
    planningCycleId: CYCLE,
    fullBranchRef: 'refs/heads/main',
    canonicalWorktreePath: '/tmp/orca-worktree',
  });

  expect(initialized.kind).toBe('initialized');
  const scope = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
  if (scope.kind !== 'scope' || scope.scope === null) {
    throw new Error('Scope 应该存在');
  }
  expect(scope.scope.fullBranchRef).toBe('refs/heads/main');
  expect(scope.scope.canonicalWorktreePath).toBe('/tmp/orca-worktree');
});

test('当前 Git 身份从现场读取：完整 ref 与 canonical worktree，detached HEAD 单独表达', async () => {
  const repository = join(directory, 'repo');
  mkdirSync(repository);
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Verification');
  git('config', 'user.email', 'verification@example.invalid');
  writeFileSync(join(repository, 'README.md'), '# repo\n');
  git('add', '.');
  git('commit', '-qm', 'initial');

  const resolved = await resolveGitScopeIdentity({
    repositoryPath: repository,
    env: process.env as Record<string, string>,
  });
  expect(resolved).toEqual({
    kind: 'resolved',
    fullBranchRef: 'refs/heads/main',
    canonicalWorktreePath: realpathSync(repository),
  });

  git('checkout', '-q', '--detach');

  const detached = await resolveGitScopeIdentity({
    repositoryPath: repository,
    env: process.env as Record<string, string>,
  });
  expect(detached).toEqual({ kind: 'detached' });
  // 该用例要真实 git init + commit + detach；并行全量套件下 5s 上限会被机器负载吃掉。
}, 30_000);
