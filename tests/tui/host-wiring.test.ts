import { COMMAND_IDS } from '../../src/interfaces/tui/commands.js';
import { chooseCommand } from './harness.js';
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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
  GraphGeneration,
  PlanningCycleId,
  RuntimeIncarnationId,
  WorkPackageId,
} from '../../src/application/dto/identity.js';
import type { DoctorProbe } from '../../src/bootstrap/doctor.js';
import type { TuiPorts } from '../../src/interfaces/tui/ports.js';
import { createForegroundPlanningHost } from '../../src/bootstrap/foreground-planning-runtime.js';
import { coordinationDatabasePath, resolveGitCommonDir } from '../../src/bootstrap/composition.js';
import { openCoordinationStore, type CoordinationStore } from '../../src/adapters/storage/coordination-store.js';
import { MIGRATIONS, SCHEMA_VERSION_KEY } from '../../src/adapters/storage/schema.js';
import { CapableChatModel } from '../support/fake-chat-model.js';
import { JsonCredentialStore } from '../../src/adapters/storage/credential-store.js';
import { DEFAULT_TUI_PREFERENCES } from '../../src/application/configuration/tui-preferences.js';
import { PROJECT_DETAILS_MAX_ITEMS, PROJECT_DETAILS_MAX_PAGE_BYTES } from '../../src/application/tui/project-presentation.js';
import { acquireRuntimeLease } from '../../src/application/coordination/lease-service.js';
import { loadProjectConfig } from '../../src/bootstrap/project-config.js';
import { graphIdFor } from '../../src/application/planning/graph-generation.js';
import { recordInitialGraph } from '../../src/application/planning/graph-history.js';
import { DEFAULT_EXECUTION_LIMITS, budgetFromLimits } from '../../src/domain/planning/budget-policy.js';
import type { ExecutionGraph } from '../../src/domain/planning/execution-graph.js';
import { executionManifest } from '../support/execution-harness.js';
import { dedupeRoleCandidates } from '../../src/interfaces/tui/components/model-picker.js';
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
  readonly summaryReads: { readonly kind: string; readonly id: string }[];
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
      schemaVersion: 2,
      coordinatorModels: [
        {
          configurationRef: 'planning-default',
          providerIntegration: '@fake/provider#CapableChatModel',
          model: 'fake-coordinator',
          modelOptions: {},
          // 注入的假模型不需要真实凭据：凭据引用必须对应已声明的 Provider Connection，否则启动拒绝。
          credentialRefs: [],
          nativeWindowOwnerRef: null,
        },
        {
          configurationRef: 'planning-spare',
          providerIntegration: '@fake/provider#CapableChatModel',
          model: 'fake-coordinator-spare',
          modelOptions: {},
          credentialRefs: [],
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

function fakeTracker(summaryReads: { readonly kind: string; readonly id: string }[] = []): IssueTrackerGateway {
  const issue: TrackerIssue = {
    ref: { kind: 'route-map', id: '7' },
    title: 'Route Map',
    body: ROUTE_MAP_BODY,
    state: 'open',
    assignees: [],
  };
  return {
    readIssue: (): Promise<TrackerReadOutcome> => Promise.resolve({ kind: 'read', issue }),
    readIssueSummary: ref => {
      summaryReads.push(ref);
      return Promise.resolve({ kind: 'read', issue: { ref, title: 'Route Map summary' } });
    },
    updateIssueBody: (): Promise<TrackerWriteOutcome> => Promise.resolve({ kind: 'accepted' }),
    assignIssue: (): Promise<TrackerWriteOutcome> => Promise.resolve({ kind: 'accepted' }),
  };
}

async function startHost(
  repository: string,
  requests: { generations: number } = { generations: 0 },
  directory = mkdtempSync(join(tmpdir(), 'orca-tui-wiring-')),
): Promise<Harness> {
  const summaryReads: { readonly kind: string; readonly id: string }[] = [];
  const host = await createForegroundPlanningHost({
    repositoryPath: repository,
    env: { ...process.env, XDG_CONFIG_HOME: join(directory, 'config') },
    clock,
    newId: (() => {
      let counter = 0;
      return () => `id-${String((counter += 1))}`;
    })(),
    heartbeatIntervalMs: 10,
    leaseTtlMs: 600_000,
    orcaProbe: fakeProbe(),
    trackerFactory: () => fakeTracker(summaryReads),
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
    summaryReads,
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
  coordinatorModelConfigurationRef = 'planning-default',
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
      coordinatorModelConfigurationRef,
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
  await chooseCommand(instance,COMMAND_IDS[index]!);
}
/**
 * 在已打开的覆盖层里向下移动到标记为选中的那一项，直到它包含 `needle`。
 *
 * 覆盖层用箭头标注当前焦点（行首是 Ink 边框字符），因此这里读的是界面自己的焦点标记，
 * 不用按下次数猜位置。
 */
const SELECTED_OPTION_LINE = /^[│┃|\s]*[>❯›]\s/u;

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
  await pressKey(instance, '\u0002');
  for (let step = 0; step < 3; step += 1) await pressKey(instance, '\u001b[B');
  await pressKey(instance, '\r');
  expect(frameText(instance)).toContain(proposal.coordinationScopeId);
});

test('host metadata读取注册Session的配置与精确Claim摘要，不读取票据正文', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-tui-project-metadata-'));
  const repository = initializeRepository(directory);
  const harness = await startHost(repository, { generations: 0 }, directory);
  const proposal = await harness.host.ports.scopeSetup.proposal();
  expect((await harness.host.ports.scopeSetup.initialize(proposal)).kind).toBe('accepted');
  const scopeId = proposal.coordinationScopeId as CoordinationScopeId;
  const sessionId = proposal.coordinatorSessionId as CoordinatorSessionId;
  const otherSession = 'session-spare-config' as CoordinatorSessionId;
  await registerSession(repository, scopeId, otherSession, 'planning-spare');

  const store = await openStore(repository);
  try {
    const scope = store.query({ kind: 'scope', coordinationScopeId: scopeId });
    if (scope.kind !== 'scope' || scope.scope === null) throw new Error('Scope 应可读');
    const lease = acquireRuntimeLease(store, {
      coordinationScopeId: scopeId,
      coordinatorSessionId: sessionId,
      runtimeIncarnationId: `${sessionId}#metadata-test` as RuntimeIncarnationId,
      fencingGeneration: 0,
    });
    if (lease.kind !== 'acquired') throw new Error(`Runtime Lease 未取得：${JSON.stringify(lease)}`);
    const writer = {
      coordinatorSessionId: sessionId,
      runtimeIncarnationId: `${sessionId}#metadata-test` as RuntimeIncarnationId,
      fencingGeneration: lease.lease.fencingGeneration,
    };
    const claimed = store.transact({
      kind: 'record-ticket-claim',
      coordinationScopeId: scopeId,
      expectedRevision: lease.revision,
      writer,
      ticketRef: { kind: 'decision-ticket', id: '42' },
    });
    if (claimed.kind !== 'committed') throw new Error(`Claim 未写入：${JSON.stringify(claimed)}`);
  } finally {
    store.close();
  }

  const selected = await harness.host.ports.snapshot(sessionId);
  expect(selected.kind === 'snapshot' ? selected.snapshot.projectPresentation : null).toMatchObject({
    session: { id: sessionId, model: 'fake-coordinator' },
    ticket: { ref: '42', title: 'Route Map summary' },
  });
  expect(harness.summaryReads).toEqual([{ kind: 'decision-ticket', id: '42' }]);

  const other = await harness.host.ports.snapshot(otherSession);
  expect(other.kind === 'snapshot' ? other.snapshot.projectPresentation?.session : null)
    .toMatchObject({ id: otherSession, model: 'fake-coordinator-spare' });
}, 30_000);

test('host projectDetails绑定Scope、Session和所见revision，并连续读取完整UTF-8详情与批准Manifest', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-tui-project-details-'));
  const repository = initializeRepository(directory);
  const harness = await startHost(repository, { generations: 0 }, directory);
  const proposal = await harness.host.ports.scopeSetup.proposal();
  expect((await harness.host.ports.scopeSetup.initialize(proposal)).kind).toBe('accepted');
  const scopeId = proposal.coordinationScopeId as CoordinationScopeId;
  const sessionId = proposal.coordinatorSessionId as CoordinatorSessionId;
  const otherSession = 'session-details-other' as CoordinatorSessionId;
  await registerSession(repository, scopeId, otherSession, 'planning-spare');
  const port = harness.host.ports.projectDetails;
  if (port === undefined) throw new Error('projectDetails 端口缺失');
  const detailsPort = port;

  const store = await openStore(repository);
  let detailsRevision = 0;
  const graphId = graphIdFor(scopeId, 1 as GraphGeneration);
  const generation = 1 as GraphGeneration;
  const packages = Array.from({ length: 12 }, (_, index) => ({
    workPackageId: `detail-wp-${String(index)}` as WorkPackageId,
    title: index === 0 ? '界🌊'.repeat(24_000) : `Work package ${String(index)}`,
    dependsOn: [],
    scopeEnvelope: { include: ['src'], exclude: [] },
    budget: budgetFromLimits(DEFAULT_EXECUTION_LIMITS),
  }));
  const graph: ExecutionGraph = { graphId, generation, concurrencyLimit: 1, workPackages: packages };
  try {
    const lease = acquireRuntimeLease(store, {
      coordinationScopeId: scopeId,
      coordinatorSessionId: sessionId,
      runtimeIncarnationId: `${sessionId}#details-test` as RuntimeIncarnationId,
      fencingGeneration: 0,
    });
    if (lease.kind !== 'acquired') throw new Error(`Runtime Lease 未取得：${JSON.stringify(lease)}`);
    const writer = {
      coordinatorSessionId: sessionId,
      runtimeIncarnationId: `${sessionId}#details-test` as RuntimeIncarnationId,
      fencingGeneration: lease.lease.fencingGeneration,
    };
    const recordedGraph = recordInitialGraph({
      store,
      coordinationScopeId: scopeId,
      writer,
      graph,
      mapRevision: 1,
      planRevision: 1,
      orcaRunId: 'project-details-run',
    });
    if (recordedGraph.kind !== 'recorded') throw new Error(`GraphVersion 未写入：${JSON.stringify(recordedGraph)}`);
    const currentScope = store.query({ kind: 'scope', coordinationScopeId: scopeId });
    if (currentScope.kind !== 'scope' || currentScope.scope === null) throw new Error('Scope 应可读');
    const approvedRisks = ['批准风险：甲🌊'.repeat(18_000)];
    const manifest = {
      ...executionManifest({
        graphId,
        generation,
        coordinationScopeId: scopeId,
        planningCycleId: proposal.planningCycleId as PlanningCycleId,
      }),
      acceptedRisks: approvedRisks,
    };
    const approved = store.transact({
      kind: 'record-authorization',
      coordinationScopeId: scopeId,
      expectedRevision: currentScope.scope.revision,
      writer,
      authorizationId: 'approved-project-details',
      authorizationVersion: 1,
      manifestVersion: 2,
      fingerprint: 'approved-project-details-fingerprint',
      approvalRef: 'approved-project-details-review',
      manifest,
    });
    expect(approved.kind).toBe('committed');
    const latestScope = store.query({ kind: 'scope', coordinationScopeId: scopeId });
    if (latestScope.kind !== 'scope' || latestScope.scope === null) throw new Error('Scope 应可读');
    detailsRevision = latestScope.scope.revision;
  } finally {
    store.close();
  }

  expect((await harness.host.ports.snapshot(otherSession)).kind).toBe('snapshot');
  const otherDetails = await detailsPort.read({ objectKey: 'work', coordinatorSessionId: otherSession, seenRevision: detailsRevision, after: null });
  expect(otherDetails, JSON.stringify(otherDetails)).toMatchObject({ kind: 'page', page: { objectKey: 'work', coordinatorSessionId: otherSession, revision: detailsRevision } });
  expect(await detailsPort.read({ objectKey: 'work', coordinatorSessionId: 'session-details-unknown', seenRevision: detailsRevision, after: null }))
    .toMatchObject({ kind: 'unavailable' });
  expect(await detailsPort.read({ objectKey: 'work', coordinatorSessionId: sessionId, seenRevision: detailsRevision - 1, after: null }))
    .toMatchObject({ kind: 'stale', currentRevision: detailsRevision });

  async function readAll(objectKey: string): Promise<readonly { readonly key: string; readonly value: string; readonly offset: number; readonly end: number; readonly byteLength: number }[]> {
    const items: { key: string; value: string; offset: number; end: number; byteLength: number }[] = [];
    let after: string | null = null;
    do {
      const result = await detailsPort.read({ objectKey, coordinatorSessionId: sessionId, seenRevision: detailsRevision, after });
      if (result.kind !== 'page') throw new Error(`详情页读取失败：${JSON.stringify(result)}`);
      expect(result.page).toMatchObject({ objectKey, coordinatorSessionId: sessionId, revision: detailsRevision });
      expect(result.page.items.length).toBeLessThanOrEqual(PROJECT_DETAILS_MAX_ITEMS);
      const encoder = new TextEncoder();
      const byteCount = result.page.items.reduce((sum, item) =>
        sum + encoder.encode(item.key).length + encoder.encode(item.label).length + encoder.encode(item.value).length, 0);
      expect(byteCount).toBeLessThanOrEqual(PROJECT_DETAILS_MAX_PAGE_BYTES);
      items.push(...result.page.items);
      after = result.page.nextCursor;
    } while (after !== null);
    return items;
  }

  const selectedSnapshot = await harness.host.ports.snapshot(sessionId);
  expect(selectedSnapshot.kind).toBe('snapshot');
  const workItems = await readAll('work');
  if (selectedSnapshot.kind !== 'snapshot') throw new Error('项目快照应可读');
  expect(workItems.find(item => item.key === 'finalizer.readOnlyProfile')?.value)
    .toBe(selectedSnapshot.snapshot.finalizer.readOnlyProfile);
  expect(workItems.find(item => item.key === 'finalizer.gate.ready')?.value)
    .toBe(String(selectedSnapshot.snapshot.finalizer.gate.ready));
  expect(workItems.length).toBeGreaterThan(PROJECT_DETAILS_MAX_ITEMS);
  const titleParts = workItems.filter(item => item.key === 'detail-wp-0.title');
  expect(titleParts.length).toBeGreaterThan(1);
  let expectedOffset = 0;
  for (const item of titleParts) {
    expect(item.offset).toBe(expectedOffset);
    expectedOffset = item.end;
  }
  expect(titleParts.map(item => item.value).join('')).toBe('界🌊'.repeat(24_000));

  const approvedKey = 'approved-authorization:approved-project-details@1';
  const manifestItems = await readAll(approvedKey);
  expect(manifestItems.find(item => item.key === 'approvedManifest.baselineHead')?.value).toBe('head-1');
  const riskParts = manifestItems.filter(item => item.key === 'approvedManifest.acceptedRisks.0');
  expect(riskParts.length).toBeGreaterThan(1);
  expect(riskParts.map(item => item.value).join('')).toBe('批准风险：甲🌊'.repeat(18_000));
  expect(await detailsPort.read({ objectKey: 'approved-authorization:candidate@1', coordinatorSessionId: sessionId,
    seenRevision: detailsRevision, after: null })).toMatchObject({ kind: 'unavailable' });
}, 30_000);

test('用户偏好load只读，显式分区save在同一临时XDG目录跨host重启恢复', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-tui-preferences-wiring-'));
  const repository = initializeRepository(directory);
  const configFile = join(directory, 'config', 'orca-companion', 'tui-preferences.json');
  const first = await startHost(repository, { generations: 0 }, directory);
  const preferences = first.host.ports.preferences;
  if (preferences === undefined) throw new Error('preferences 端口缺失');

  expect(await preferences.load()).toMatchObject({ kind: 'loaded', preferences: DEFAULT_TUI_PREFERENCES, writable: true });
  expect(existsSync(configFile)).toBe(false);
  expect(await preferences.save({ expectedRevision: 0, patch: { kind: 'icons', iconMode: 'ascii' } }))
    .toMatchObject({ kind: 'saved', preferences: { revision: 1, iconMode: 'ascii' } });
  expect(await preferences.save({ expectedRevision: 1, patch: { kind: 'statusline', statusline: {
    ...DEFAULT_TUI_PREFERENCES.statusline, fields: ['graph', 'ticket'],
  } } })).toMatchObject({ kind: 'saved', preferences: { revision: 2, iconMode: 'ascii', statusline: { fields: ['graph', 'ticket'] } } });
  first.dispose();

  const restarted = await startHost(repository, { generations: 0 }, directory);
  const restored = restarted.host.ports.preferences;
  if (restored === undefined) throw new Error('restarted preferences 端口缺失');
  expect(await restored.load()).toMatchObject({
    kind: 'loaded',
    writable: true,
    preferences: { revision: 2, iconMode: 'ascii', statusline: { fields: ['graph', 'ticket'] } },
  });
}, 30_000);

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
  await pressKey(instance, '\u0002');
  for (let step = 0; step < 3; step += 1) await pressKey(instance, '\u001b[B');
  await pressKey(instance, '\r');
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
        submissionId: globalThis.crypto.randomUUID(),
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
    reading: { ...harness.host.ports.reading, history: async (query) => {
      requestedSessions.push(query.coordinatorSessionId);
      return await harness.host.ports.reading.history(query);
    } },
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
  expect(frameText(instance)).toContain('选择交接收件方');
  for (let step = 0; step < targetIndex; step += 1) await pressKey(instance, '\u001b[B');
  await pressKey(instance, '\r');
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

test('同 provider/model 的新连接可应用，原连接与凭据引用保留', async () => {
  const harness = await startHost(initializeRepository(mkdtempSync(join(tmpdir(), 'orca-tui-model-connection-'))));
  const proposal = await harness.host.ports.scopeSetup.proposal();
  expect((await harness.host.ports.scopeSetup.initialize(proposal)).kind).toBe('accepted');
  const port = harness.host.ports.modelSettings;
  if (port === undefined) throw new Error('模型设置端口缺失');
  for (const secret of ['fixture-key-old', 'fixture-key-new']) {
    const config = loadProjectConfig({ worktreePath: harness.repository });
    if (config.kind !== 'loaded') throw new Error('配置不可读');
    expect(await port.save({
      expectedRevision: config.config.revision,
      role: 'planner',
      connection: {
        label: 'test provider', providerIntegration: '@fake/provider#CapableChatModel', modelOptions: {},
        credential: { kind: 'managed', credentialRef: null, optionPath: 'apiKey' },
        codex: { providerId: 'fixture', baseUrl: 'https://api.example/v1', wireApi: 'responses' },
      },
      model: 'same-model', effort: null, newSecret: secret,
    })).toMatchObject({ kind: 'saved' });
  }
  const before = loadProjectConfig({ worktreePath: harness.repository });
  if (before.kind !== 'loaded') throw new Error('配置不可读');
  const latestConnection = before.config.providerConnections.at(-1);
  const catalog = await harness.host.ports.modelCatalog.load(proposal.coordinatorSessionId);
  const planner = catalog.roles?.find((entry) => entry.role === 'planner');
  const choices = dedupeRoleCandidates(planner?.candidates ?? []);
  expect(choices).toHaveLength(1);
  expect(choices[0]?.connectionRef).toBe(latestConnection?.connectionRef);
  expect(await port.apply({ role: 'planner', modelRef: choices[0]!.candidateRef,
    effort: null, expectedRevision: before.config.revision })).toMatchObject({ kind: 'saved' });
  const after = loadProjectConfig({ worktreePath: harness.repository });
  if (after.kind !== 'loaded') throw new Error('配置不可读');
  const applied = after.config.execution.workerProfiles.find((entry) =>
    entry.profileRef === after.config.execution.workerProfileRefs.planner);
  expect(applied?.modelConfiguration.connection.credential).toEqual(latestConnection?.credential);
  expect(after.config.providerConnections.slice(0, before.config.providerConnections.length)).toEqual(before.config.providerConnections);
  const credentials = new JsonCredentialStore({ environment: { XDG_CONFIG_HOME: join(harness.directory, 'config') } });
  if (latestConnection?.credential.kind !== 'managed') throw new Error('测试凭据应为 managed');
  expect(credentials.read(latestConnection.credential.credentialRef)).toMatchObject({ kind: 'resolved', secret: 'fixture-key-new' });
});

test('会话维护与模型切换在 TUI 入口上落到真实记录，而不是占位拒绝', async () => {
  const harness = await startHost(initializeRepository(mkdtempSync(join(tmpdir(), 'orca-tui-wiring-maintenance-'))));
  const proposal = await harness.host.ports.scopeSetup.proposal();
  expect((await harness.host.ports.scopeSetup.initialize(proposal)).kind).toBe('accepted');
  const session = proposal.coordinatorSessionId;

  expect(
    (
      await harness.host.ports.execute({
        kind: 'send-session-message',
        submissionId: globalThis.crypto.randomUUID(),
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

  // paletteSelection 1 = Model Picker：先进入按角色分区的模型配置页。
  await runPaletteCommand(instance, 1);
  await settle(8);
  expect(frameText(instance)).toContain('Model Picker · 模型配置');
  expect(frameText(instance)).toContain('Coordinator');
  // Enter 进入该角色的候选菜单，候选只按 provider / model 展示。
  await pressKey(instance, '\r');
  await settle(8);
  expect(frameText(instance)).toContain('选择模型');
  expect(frameText(instance)).toContain('fake-coordinator-spare');
  // 候选行只显示 provider / model，configurationRef 不出现在界面上。
  await moveSelectionTo(instance, 'fake-coordinator-spare');
  // Tab 切到动作区，Right 明确选中「应用选择」，Enter 才提交。
  await pressKey(instance, '\t');
  await settle(4);
  await pressKey(instance, '\u001b[C');
  await settle(4);
  expect(frameText(instance)).toContain('当前区域：操作按钮 · 应用选择');
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
    // 应用只追加不可变记录：Session 绑定的是新引用，不是被选中的候选引用。
    expect(registration?.coordinatorModelConfigurationRef).toBeTruthy();
    expect(registration?.coordinatorModelConfigurationRef).not.toBe('planning-spare');
    // 绑定行为按解析后的配置断言：模型取自被选候选，effort 只来自可信能力来源。
    const projectConfig = JSON.parse(
      readFileSync(join(harness.repository, 'orca-companion.json'), 'utf8'),
    ) as {
      readonly coordinatorModels: readonly {
        readonly configurationRef: string;
        readonly model: string;
        readonly effort?: string | null;
        readonly effortCapability?: { readonly values: readonly string[] } | null;
      }[];
    };
    const bound = projectConfig.coordinatorModels.find(
      (configuration) => configuration.configurationRef === registration?.coordinatorModelConfigurationRef,
    );
    expect(bound?.model).toBe('fake-coordinator-spare');
    // 本项目没有声明 effort 能力来源，因此绑定不得凭空带上 effort。
    expect(bound?.effort ?? null).toBeNull();
  } finally {
    store.close();
  }
  // 该用例包含真实模型回合、压缩与配置切换；并行全量套件下 5s 上限会被吃掉。
}, 30_000);
