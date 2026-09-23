/**
 * TUI 端口 ⇄ 真实前台宿主的接线（IP-04、IP-11，`m2-deliver-planning-tui`）。
 *
 * 这里刻意**不用 fake ports**：临时 Git 仓库 + 真实两个 SQLite store + 可控 provider/tracker/Orca 探测，
 * 断言界面真正消费的端口接在既有用例上。
 *
 * 四类 Home 身份输入（当前 ref/canonical、其他分支 Scope、旧未绑定记录、链接 worktree）与规划 Handoff 的
 * Target 选择都走这里，因为它们只有在真实 store 与真实 Git 身份下才能被观察到；fake 端口可以把任何
 * 行为都装成通过。
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, test } from 'vitest';

import type {
  IssueTrackerGateway,
  TrackerIssue,
  TrackerReadOutcome,
  TrackerWriteOutcome,
} from '../../src/application/planning/route-map-service.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  RuntimeIncarnationId,
} from '../../src/application/dto/identity.js';
import type { DoctorProbe } from '../../src/bootstrap/doctor.js';
import type { TuiPorts } from '../../src/interfaces/tui/ports.js';
import { createForegroundPlanningHost } from '../../src/bootstrap/foreground-planning-runtime.js';
import { coordinationDatabasePath, resolveGitCommonDir } from '../../src/bootstrap/composition.js';
import { openCoordinationStore, type CoordinationStore } from '../../src/adapters/storage/coordination-store.js';
import { MIGRATIONS, SCHEMA_VERSION_KEY } from '../../src/adapters/storage/schema.js';
import { CapableChatModel } from '../support/fake-chat-model.js';
import { frameText, renderTui, settle, type RenderedTui } from './harness.js';

const ROUTE_MAP_BODY = [
  '## Destination',
  '把项目推进到目的地 A。',
  '## Resolved Decisions',
  '',
  '## Open Decision Tickets',
  '- ticket-1：先决定地图结构',
  '## Dependencies',
  '',
  '## Fog',
  '尚未厘清的部分。',
  '## Scope Boundaries',
  '',
].join('\n');

type Host = Awaited<ReturnType<typeof createForegroundPlanningHost>>;

type Harness = {
  readonly repository: string;
  readonly directory: string;
  readonly host: Host;
  readonly requests: { generations: number };
  readonly dispose: () => void;
};

const created: Harness[] = [];
const rendered: RenderedTui[] = [];

afterEach(() => {
  for (const instance of rendered.splice(0)) {
    instance.unmount();
  }
  for (const harness of created.splice(0)) {
    harness.dispose();
    rmSync(harness.directory, { recursive: true, force: true });
  }
});

const clock = (): number => 1_000;

function gitFor(repository: string): (...args: string[]) => string {
  return (...args: string[]): string =>
    execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
}

function initializeRepository(root: string): string {
  const repository = join(root, 'repo');
  mkdirSync(repository);
  const git = gitFor(repository);
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Verification');
  git('config', 'user.email', 'verification@example.invalid');
  writeFileSync(join(repository, 'README.md'), '# repo\n');
  writeFileSync(
    join(repository, 'orca-companion.json'),
    JSON.stringify({
      schemaVersion: 1,
      coordinatorModels: [
        {
          configurationRef: 'planning-default',
          providerIntegration: '@fake/provider#CapableChatModel',
          model: 'fake-coordinator',
          modelOptions: {},
          credentialRefs: ['fake'],
          nativeWindowOwnerRef: null,
        },
        {
          configurationRef: 'planning-spare',
          providerIntegration: '@fake/provider#CapableChatModel',
          model: 'fake-coordinator-spare',
          modelOptions: {},
          credentialRefs: ['fake'],
          nativeWindowOwnerRef: null,
        },
      ],
      defaultCoordinatorModelRef: 'planning-default',
      tracker: { kind: 'github', routeMapIssueNumber: 7 },
      planning: { maxMutations: 2 },
      context: { maxInputTokens: 20_000 },
    }),
    'utf8',
  );
  git('add', '.');
  git('commit', '-qm', 'initial');
  return repository;
}

function fakeProbe(): DoctorProbe {
  return {
    readOrcaVersion: () => Promise.resolve({ ok: true, value: '1.4.198' }),
    readRuntime: () =>
      Promise.resolve({ ok: true, value: { state: 'running', reachable: true, capabilities: [] } }),
    readHosts: () => Promise.resolve({ ok: true, value: [] }),
    readCoordinatorIdentity: () => Promise.resolve({ ok: true, value: 'coordinator@test' }),
    readPublicCommands: () => Promise.resolve({ ok: true, value: [] }),
  };
}

function fakeTracker(): IssueTrackerGateway {
  const issue: TrackerIssue = {
    ref: { kind: 'route-map', id: '7' },
    title: 'Route Map',
    body: ROUTE_MAP_BODY,
    state: 'open',
    assignees: [],
  };
  return {
    readIssue: (): Promise<TrackerReadOutcome> => Promise.resolve({ kind: 'read', issue }),
    updateIssueBody: (): Promise<TrackerWriteOutcome> => Promise.resolve({ kind: 'accepted' }),
    assignIssue: (): Promise<TrackerWriteOutcome> => Promise.resolve({ kind: 'accepted' }),
  };
}

async function startHost(
  repository: string,
  requests: { generations: number } = { generations: 0 },
  directory = mkdtempSync(join(tmpdir(), 'orca-tui-wiring-')),
): Promise<Harness> {
  const host = await createForegroundPlanningHost({
    repositoryPath: repository,
    env: process.env as Record<string, string>,
    clock,
    newId: (() => {
      let counter = 0;
      return () => `id-${String((counter += 1))}`;
    })(),
    heartbeatIntervalMs: 10,
    leaseTtlMs: 600_000,
    orcaProbe: fakeProbe(),
    trackerFactory: fakeTracker,
    loadIntegration: () =>
      Promise.resolve({
        CapableChatModel: class extends CapableChatModel {
          override _generate(messages: never, options: never): never {
            requests.generations += 1;
            return super._generate(messages, options) as never;
          }
        },
      }),
  });
  let disposed = false;
  const harness: Harness = {
    repository,
    directory,
    host,
    requests,
    dispose: () => {
      if (!disposed) {
        disposed = true;
        host.close();
      }
    },
  };
  created.push(harness);
  return harness;
}

async function openStore(repository: string): Promise<CoordinationStore> {
  const commonDir = await resolveGitCommonDir({
    repositoryPath: repository,
    env: process.env as Record<string, string>,
  });
  if (commonDir.kind !== 'resolved') {
    throw new Error(`无法解析 Git common dir：${commonDir.message}`);
  }
  const opened = openCoordinationStore({
    databasePath: coordinationDatabasePath(commonDir.path),
    clock,
  });
  if (opened.kind !== 'opened') {
    throw new Error(opened.message);
  }
  return opened.store;
}

/** 在真实 store 上注册第二个 Session（任何 Runtime Lease 出现之前）。 */
async function registerSession(
  repository: string,
  scopeId: CoordinationScopeId,
  coordinatorSessionId: CoordinatorSessionId,
): Promise<void> {
  const store = await openStore(repository);
  try {
    const scope = store.query({ kind: 'scope', coordinationScopeId: scopeId });
    const revision = scope.kind === 'scope' && scope.scope !== null ? scope.scope.revision : 0;
    const registered = store.transact({
      kind: 'register-session',
      coordinationScopeId: scopeId,
      expectedRevision: revision,
      writer: {
        coordinatorSessionId,
        runtimeIncarnationId: `${coordinatorSessionId}#bootstrap` as RuntimeIncarnationId,
        fencingGeneration: 0,
      },
      coordinatorSessionId,
      coordinatorModelConfigurationRef: 'planning-default',
      lifecycleState: 'registered',
    });
    if (registered.kind !== 'committed') {
      throw new Error(`无法注册 Session：${registered.message}`);
    }
  } finally {
    store.close();
  }
}

/** 在真实 store 上写一条绑定到别的分支的 Scope，用于验证「无匹配」不被误判。 */
async function createScopeOnOtherBranch(repository: string, scopeId: CoordinationScopeId): Promise<void> {
  const store = await openStore(repository);
  try {
    const created = store.transact({
      kind: 'create-scope',
      coordinationScopeId: scopeId,
      expectedRevision: 0,
      writer: {
        coordinatorSessionId: 'session-seed' as CoordinatorSessionId,
        runtimeIncarnationId: 'session-seed#bootstrap' as RuntimeIncarnationId,
        fencingGeneration: 0,
      },
      mode: 'route_planning',
      controlState: 'active',
      planningCycleId: null,
      fullBranchRef: 'refs/heads/legacy-planning',
      canonicalWorktreePath: '/tmp/orca-other-worktree',
    });
    if (created.kind !== 'committed') {
      throw new Error(`无法写入其他分支的 Scope：${created.message}`);
    }
  } finally {
    store.close();
  }
}

/**
 * 构造 schema 9 的旧库：逐条执行当时的 migration，再写入一条没有注册绑定的 Scope。
 *
 * 旧记录只可能来自真实升级路径，因此 fixture 也走真实旧 schema，不直接改当前 schema 的行。
 */
async function createLegacyDatabase(repository: string, scopeId: CoordinationScopeId): Promise<void> {
  const commonDir = await resolveGitCommonDir({
    repositoryPath: repository,
    env: process.env as Record<string, string>,
  });
  if (commonDir.kind !== 'resolved') {
    throw new Error(`无法解析 Git common dir：${commonDir.message}`);
  }
  const databasePath = coordinationDatabasePath(commonDir.path);
  mkdirSync(join(databasePath, '..'), { recursive: true });
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
  ).run(scopeId);
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(SCHEMA_VERSION_KEY, '9');
  db.close();
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return true;
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 5);
    await promise;
  }
  return await check();
}

async function pressKey(instance: RenderedTui, input: string): Promise<void> {
  instance.stdin.write(input);
  await settle(2);
}

/** 打开 Command Palette，下移到第 `index` 项后执行。 */
async function runPaletteCommand(instance: RenderedTui, index: number): Promise<void> {
  await pressKey(instance, '\u0010');
  for (let step = 0; step < index; step += 1) {
    await pressKey(instance, '\u001b[B');
  }
  await pressKey(instance, '\r');
}

/**
 * 在已打开的覆盖层里向下移动到标记为选中的那一项，直到它包含 `needle`。
 *
 * 覆盖层用 `>` 标注当前选项（行首是 Ink 边框字符），因此这里读的是界面自己的选中标记，
 * 不用按下次数猜位置。
 */
const SELECTED_OPTION_LINE = /^[│┃|\s]*>\s/u;

async function moveSelectionTo(instance: RenderedTui, needle: string): Promise<void> {
  for (let step = 0; step < 16; step += 1) {
    const marked = frameText(instance)
      .split('\n')
      .find((line) => SELECTED_OPTION_LINE.test(line));
    if (marked !== undefined && marked.includes(needle)) {
      return;
    }
    await pressKey(instance, '\u001b[B');
  }
  throw new Error(`覆盖层里未能选中 ${needle}：\n${frameText(instance)}`);
}

function render(host: Host): RenderedTui {
  const instance = renderTui(host.ports);
  rendered.push(instance);
  return instance;
}

test('其他分支的 Scope 不构成匹配：Home 进入向导而不是误判身份', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-tui-wiring-other-'));
  const repository = initializeRepository(directory);
  const harness = await startHost(repository, { generations: 0 }, directory);
  await createScopeOnOtherBranch(repository, 'scope-other' as CoordinationScopeId);

  const home = await harness.host.ports.scopeSetup.resolveHome();
  expect(home).toEqual({ kind: 'wizard' });

  const instance = render(harness.host);
  await settle(12);
  expect(frameText(instance)).toContain('初始化向导');
});

test('向导创建后按当前完整 ref 与 canonical worktree 恢复', async () => {
  const harness = await startHost(initializeRepository(mkdtempSync(join(tmpdir(), 'orca-tui-wiring-restore-'))));
  const proposal = await harness.host.ports.scopeSetup.proposal();
  expect((await harness.host.ports.scopeSetup.initialize(proposal)).kind).toBe('accepted');

  const home = await harness.host.ports.scopeSetup.resolveHome();
  expect(home).toEqual({ kind: 'restore', coordinationScopeId: proposal.coordinationScopeId });

  const instance = render(harness.host);
  await settle(16);
  expect(frameText(instance)).toContain(proposal.coordinationScopeId);
});

test('链接 worktree 被拒绝恢复，并把身份不匹配的原因显示出来', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-tui-wiring-linked-'));
  const repository = initializeRepository(directory);
  const harness = await startHost(repository, { generations: 0 }, directory);
  const proposal = await harness.host.ports.scopeSetup.proposal();
  expect((await harness.host.ports.scopeSetup.initialize(proposal)).kind).toBe('accepted');

  // Worker worktree 是另一个工作区：Scope 身份绑定在 canonical worktree 上。
  const linked = join(directory, 'worker');
  gitFor(repository)('worktree', 'add', '-q', '-b', 'worker', linked);
  const linkedHarness = await startHost(linked, { generations: 0 }, directory);

  expect(linkedHarness.host.readiness().blocker?.code).toBe('worktree_not_canonical');
  expect(await linkedHarness.host.ports.scopeSetup.resolveHome()).toMatchObject({
    kind: 'failed',
    code: 'worktree_not_canonical',
  });

  const instance = render(linkedHarness.host);
  await settle(12);
  const frame = frameText(instance);
  expect(frame).toContain('worktree_not_canonical');
  expect(frame).toContain(realpathSync(linked));
});

test('旧未绑定记录：确认前零写入，Review 确认后补齐绑定并恢复', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-tui-wiring-legacy-'));
  const repository = initializeRepository(directory);
  const scopeId = 'scope-legacy' as CoordinationScopeId;
  await createLegacyDatabase(repository, scopeId);

  const harness = await startHost(repository, { generations: 0 }, directory);
  // 旧 Scope 有自己的 Session registry 记录，绑定用的是它。
  await registerSession(repository, scopeId, 'session-legacy' as CoordinatorSessionId);

  const home = await harness.host.ports.scopeSetup.resolveHome();
  expect(home.kind).toBe('legacy');
  if (home.kind !== 'legacy') {
    return;
  }
  expect(home.candidates.map((candidate) => candidate.coordinationScopeId)).toEqual([scopeId]);
  expect(home.binding.fullBranchRef).toBe('refs/heads/main');
  expect(home.binding.canonicalWorktreePath).toBe(realpathSync(repository));

  const instance = render(harness.host);
  await settle(16);
  expect(frameText(instance)).toContain(scopeId);

  // 打开 Review：仍未写入任何绑定。
  await pressKey(instance, '\r');
  expect(frameText(instance)).toContain('迁移 Review');
  const before = await openStore(repository);
  try {
    const scope = before.query({ kind: 'scope', coordinationScopeId: scopeId });
    expect(scope.kind === 'scope' ? scope.scope?.fullBranchRef : 'unreadable').toBeNull();
  } finally {
    before.close();
  }

  // Review 内确认：一次性绑定落库，之后按常规身份解析恢复。
  await pressKey(instance, '\r');
  await settle(16);

  const after = await openStore(repository);
  try {
    const scope = after.query({ kind: 'scope', coordinationScopeId: scopeId });
    expect(scope.kind === 'scope' ? scope.scope?.fullBranchRef : null).toBe('refs/heads/main');
    expect(scope.kind === 'scope' ? scope.scope?.canonicalWorktreePath : null).toBe(realpathSync(repository));
  } finally {
    after.close();
  }
  expect(frameText(instance)).toContain(scopeId);
  // 该用例要构造真实 schema 9 库、跑完 migration 并走完整 Review 流程；并行全量套件下 5s 上限会被吃掉。
}, 30_000);

test('规划 Handoff 的 Target 来自用户在 Session Picker 里的选择', async () => {
  const harness = await startHost(initializeRepository(mkdtempSync(join(tmpdir(), 'orca-tui-wiring-handoff-'))));
  const proposal = await harness.host.ports.scopeSetup.proposal();
  expect((await harness.host.ports.scopeSetup.initialize(proposal)).kind).toBe('accepted');
  const scopeId = proposal.coordinationScopeId as CoordinationScopeId;
  const source = proposal.coordinatorSessionId as CoordinatorSessionId;
  const target = 'session-target' as CoordinatorSessionId;
  await registerSession(harness.repository, scopeId, target);

  // Source 需要已提交历史，Capsule 才可能被派生。
  expect(
    (
      await harness.host.ports.execute({
        kind: 'send-session-message',
        coordinatorSessionId: source,
        content: '先读一遍 Route Map',
      })
    ).kind,
  ).toBe('accepted');
  expect(
    await waitFor(async () => {
      const transcript = await harness.host.ports.transcript(source, null);
      return transcript.kind === 'transcript' &&
        transcript.transcript.messages.some((message) => message.role === 'assistant');
    }),
  ).toBe(true);

  // 观察界面真正消费的端口：transcript 请求的 Session 就是「当前选中 Session」。
  const requestedSessions: string[] = [];
  const ports: TuiPorts = {
    ...harness.host.ports,
    transcript: async (coordinatorSessionId, cursor) => {
      requestedSessions.push(coordinatorSessionId);
      return await harness.host.ports.transcript(coordinatorSessionId, cursor);
    },
  };
  const instance = renderTui(ports);
  rendered.push(instance);
  await settle(16);

  // Target 由用户在 Session Picker 里选定：先按快照里的 Session 顺序算出要移动的步数。
  const before = await harness.host.ports.snapshot(source);
  if (before.kind !== 'snapshot') {
    throw new Error('快照应可读');
  }
  const order = before.snapshot.sessions.map((entry) => entry.coordinatorSessionId);
  const sourceIndex = order.indexOf(source);
  const targetIndex = order.indexOf(target);
  expect(sourceIndex).toBeGreaterThanOrEqual(0);
  expect(targetIndex).toBeGreaterThanOrEqual(0);

  await runPaletteCommand(instance, 3);
  await settle(4);
  expect(frameText(instance)).toContain('Session Picker');
  for (let step = 0; step < Math.max(0, targetIndex - sourceIndex); step += 1) {
    await pressKey(instance, '\u001b[B');
  }
  await pressKey(instance, '\r');
  await settle(12);
  // 选择落到界面上：界面随后按 Target 读取快照。
  expect(requestedSessions.at(-1)).toBe(target);

  // 发起 Handoff（paletteSelection 2 = handoff）：提案必须落在用户选中的 Target 上。
  await runPaletteCommand(instance, 2);
  await settle(12);
  expect(frameText(instance)).toContain('Handoff Review');

  const store = await openStore(harness.repository);
  try {
    const handoffs = store.query({ kind: 'planning-handoffs', coordinationScopeId: scopeId });
    const handoff = handoffs.kind === 'planning-handoffs' ? handoffs.handoffs[0] : undefined;
    expect(handoff?.sourceCoordinatorSessionId).toBe(source);
    expect(handoff?.targetCoordinatorSessionId).toBe(target);
  } finally {
    store.close();
  }
  // 该用例包含真实模型回合与真实 store 写入；并行全量套件下 5s 上限会被吃掉。
}, 30_000);

test('会话维护与模型切换在 TUI 入口上落到真实记录，而不是占位拒绝', async () => {
  const harness = await startHost(initializeRepository(mkdtempSync(join(tmpdir(), 'orca-tui-wiring-maintenance-'))));
  const proposal = await harness.host.ports.scopeSetup.proposal();
  expect((await harness.host.ports.scopeSetup.initialize(proposal)).kind).toBe('accepted');
  const session = proposal.coordinatorSessionId;

  expect(
    (
      await harness.host.ports.execute({
        kind: 'send-session-message',
        coordinatorSessionId: session,
        content: '先读一遍 Route Map',
      })
    ).kind,
  ).toBe('accepted');
  expect(
    await waitFor(async () => {
      const transcript = await harness.host.ports.transcript(session, null);
      return transcript.kind === 'transcript' &&
        transcript.transcript.messages.some((message) => message.role === 'assistant');
    }),
  ).toBe(true);

  const instance = render(harness.host);
  await settle(16);

  // paletteSelection 0 = /compact：走既有压缩用例，结果落到 checkpoint 投影上。
  await runPaletteCommand(instance, 0);
  await settle(16);
  const snapshot = await harness.host.ports.snapshot(session);
  expect(snapshot.kind === 'snapshot' ? snapshot.snapshot.compaction?.status : null).toBe('not_needed');

  // paletteSelection 1 = Model Picker：会话挂起且无在途模型操作，因此准入成立并真切换。
  await runPaletteCommand(instance, 1);
  await settle(8);
  expect(frameText(instance)).toContain('planning-spare');
  await moveSelectionTo(instance, 'planning-spare');
  await pressKey(instance, '\r');
  await settle(16);

  const store = await openStore(harness.repository);
  try {
    const sessions = store.query({
      kind: 'sessions',
      coordinationScopeId: proposal.coordinationScopeId as CoordinationScopeId,
    });
    const registration =
      sessions.kind === 'sessions'
        ? sessions.sessions.find((entry) => entry.coordinatorSessionId === session)
        : undefined;
    expect(registration?.coordinatorModelConfigurationRef).toBe('planning-spare');
  } finally {
    store.close();
  }
  // 该用例包含真实模型回合、压缩与配置切换；并行全量套件下 5s 上限会被吃掉。
}, 30_000);
