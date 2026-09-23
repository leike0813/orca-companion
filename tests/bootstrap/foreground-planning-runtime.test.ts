/**
 * `m1-wire-foreground-planning-runtime` D3 的行为测试：前台规划宿主。
 *
 * 这里用真实的临时 Git 仓库、真实的两个 SQLite store 与可控的 fake provider/tracker/Orca 探测，
 * 固定四类可观察事实：配置与身份不可用时是显式拒绝；Home 只按精确绑定恢复；只读查询与界面重绘不
 * 触发模型调用；Runtime Lease 会被续约，续约失败即停止本 Session 的模型调用与写入。
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'vitest';

import type { IssueTrackerGateway, TrackerIssue, TrackerReadOutcome, TrackerWriteOutcome } from '../../src/application/planning/route-map-service.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  RuntimeIncarnationId,
} from '../../src/application/dto/identity.js';
import type { CoordinationWriter } from '../../src/application/ports/branch-coordination-store.js';
import type { SemanticEvent } from '../../src/application/controller-service.js';
import type { DoctorProbe } from '../../src/bootstrap/doctor.js';
import { createForegroundPlanningHost } from '../../src/bootstrap/foreground-planning-runtime.js';
import { resolveGitCommonDir } from '../../src/bootstrap/composition.js';
import { openCoordinationStore } from '../../src/adapters/storage/coordination-store.js';
import { acquireRuntimeLease } from '../../src/application/coordination/lease-service.js';
import { answerPendingInteraction } from '../../src/application/coordination/pending-interaction.js';
import { openCheckpointStore } from '../../src/adapters/storage/checkpoint-store.js';
import { coordinationDatabasePath } from '../../src/bootstrap/composition.js';
import { checkpointDatabasePath } from '../../src/bootstrap/coordinator-runtime.js';
import { COORDINATOR_SESSION_STATE_SCHEMA_VERSION, toolOperationId } from '../../src/domain/coordinator/session-state.js';
import { CapableChatModel } from '../support/fake-chat-model.js';

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

type Harness = {
  readonly repository: string;
  readonly directory: string;
  readonly host: Awaited<ReturnType<typeof createForegroundPlanningHost>>;
  readonly events: readonly SemanticEvent[];
  readonly requests: { generations: number; inputs: string[] };
  readonly dispose: () => void;
};

const created: Harness[] = [];

afterEach(() => {
  for (const harness of created.splice(0)) {
    harness.dispose();
    rmSync(harness.directory, { recursive: true, force: true });
  }
});

let now = 1_000;
const clock = (): number => now;

function initializeRepository(root: string): string {
  const repository = join(root, 'repo');
  mkdirSync(repository);
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Verification');
  git('config', 'user.email', 'verification@example.invalid');
  writeFileSync(join(repository, 'README.md'), '# repo\n');
  git('add', '.');
  git('commit', '-qm', 'initial');
  return repository;
}

function writeProjectConfig(repository: string, options: { readonly maxInputTokens?: number } = {}): void {
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
      context: { maxInputTokens: options.maxInputTokens ?? 20_000 },
    }),
    'utf8',
  );
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

async function startHarness(
  overrides: {
    readonly withConfig?: boolean;
    readonly detachHead?: boolean;
    readonly heartbeatIntervalMs?: number;
    readonly repository?: string;
    readonly maxInputTokens?: number;
  } = {},
): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), 'orca-foreground-'));
  const repository = overrides.repository ?? initializeRepository(directory);
  if (overrides.withConfig !== false) {
    writeProjectConfig(repository, {
      ...(overrides.maxInputTokens === undefined ? {} : { maxInputTokens: overrides.maxInputTokens }),
    });
  }
  if (overrides.detachHead === true) {
    execFileSync('git', ['checkout', '-q', '--detach'], { cwd: repository });
  }
  const events: SemanticEvent[] = [];
  const requests = { generations: 0, inputs: [] as string[] };
  const host = await createForegroundPlanningHost({
    repositoryPath: repository,
    env: process.env as Record<string, string>,
    clock,
    newId: (() => {
      let counter = 0;
      return () => `id-${String((counter += 1))}`;
    })(),
    heartbeatIntervalMs: overrides.heartbeatIntervalMs ?? 10,
    leaseTtlMs: 60_000,
    orcaProbe: fakeProbe(),
    trackerFactory: fakeTracker,
    loadIntegration: () =>
      Promise.resolve({
        CapableChatModel: class extends CapableChatModel {
          override _generate(messages: never, options: never): never {
            requests.generations += 1;
            requests.inputs.push((messages as readonly { readonly content: unknown }[]).map((message) => String(message.content)).join('\n'));
            return super._generate(messages, options) as never;
          }
        },
      }),
  });
  host.ports.subscribe((event) => {
    events.push(event);
  });
  let disposed = false;
  const harness: Harness = {
    repository,
    directory,
    host,
    events,
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

/**
 * 已完成并发布的模型回合数。
 *
 * 事件在「节点已提交 checkpoint」之后才发布，因此等待它就等于等待历史已落盘，而不是等一个
 * 可能仍在写盘中途的调用计数。
 */
function modelRounds(harness: Harness): number {
  return harness.events.filter(
    (event) => event.kind === 'state-changed' && String(event.reason).startsWith('model:'),
  ).length;
}

/**
 * 等一个条件成立；`timeoutMs` 到点仍未成立即返回 `false`，不隐藏失败。
 *
 * 这里刻意用真实计时器：被测的是宿主的进程心跳（`setInterval` + 真实 lease 续约），把时间抽象注入
 * 宿主为了测试而改造生产路径不值得，因此保留一处有界真实等待。
 */
async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return true;
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 5);
    await promise;
  }
  return check();
}

test('配置缺失与 detached HEAD 都是可诊断拒绝，且不建立任何 Session', async () => {
  const withoutConfig = await startHarness({ withConfig: false });

  const home = await withoutConfig.host.ports.scopeSetup.resolveHome();

  expect(home).toMatchObject({ kind: 'failed', code: 'config_unavailable' });
  expect(withoutConfig.host.readiness().blocker?.code).toBe('config_unavailable');
  const snapshot = await withoutConfig.host.ports.snapshot(null);
  expect(snapshot).toMatchObject({ kind: 'failed', code: 'config_unavailable' });

  const detachedDirectory = mkdtempSync(join(tmpdir(), 'orca-foreground-detached-'));
  const detachedRepository = initializeRepository(detachedDirectory);
  const detached = await startHarness({ repository: detachedRepository, detachHead: true });
  rmSync(detachedDirectory, { recursive: true, force: true });

  expect(await detached.host.ports.scopeSetup.resolveHome()).toMatchObject({
    kind: 'failed',
    code: 'detached_head',
  });
});

test('向导创建 Scope 后 Home 按精确绑定恢复，且只读查询不产生模型调用或租约', async () => {
  const harness = await startHarness();

  expect(await harness.host.ports.scopeSetup.resolveHome()).toEqual({ kind: 'wizard' });

  const checks = await harness.host.ports.scopeSetup.verify();
  expect(checks.every((check) => check.ok)).toBe(true);
  const proposal = await harness.host.ports.scopeSetup.proposal();
  expect(proposal.coordinatorModelConfigurationRef).toBe('planning-default');

  const initialized = await harness.host.ports.execute({
    kind: 'send-session-message',
    coordinatorSessionId: proposal.coordinatorSessionId,
    content: '这条消息在 Scope 创建之前不该被接受',
  });
  expect(initialized.kind).toBe('rejected');

  const created = await harness.host.ports.scopeSetup.initialize(proposal);
  expect(created.kind).toBe('accepted');

  const home = await harness.host.ports.scopeSetup.resolveHome();
  expect(home).toEqual({ kind: 'restore', coordinationScopeId: proposal.coordinationScopeId });

  const snapshot = await harness.host.ports.snapshot(proposal.coordinatorSessionId);
  expect(snapshot.kind).toBe('snapshot');
  if (snapshot.kind !== 'snapshot') {
    return;
  }
  expect(snapshot.snapshot.sessions).toHaveLength(1);
  expect(snapshot.snapshot.sessions[0]?.holdsRuntimeLease).toBe(false);

  // 只读路径不取得 Runtime Lease，也不产生模型调用。
  const commonDir = await resolveGitCommonDir({ repositoryPath: harness.repository, env: process.env as Record<string, string> });
  if (commonDir.kind !== 'resolved') {
    throw new Error('无法解析 Git common dir');
  }
  const store = openCoordinationStore({ databasePath: coordinationDatabasePath(commonDir.path), clock, readOnly: true });
  if (store.kind !== 'opened') {
    throw new Error(store.message);
  }
  try {
    const leases = store.store.query({
      kind: 'leases',
      coordinationScopeId: proposal.coordinationScopeId as CoordinationScopeId,
    });
    expect(leases.kind === 'leases' ? leases.leases : []).toEqual([]);
  } finally {
    store.store.close();
  }
  expect(harness.requests.generations).toBe(0);
});

test('提交消息后取得租约并由模型处理一次，transcript 里有用户消息与响应', async () => {
  const harness = await startHarness();
  const proposal = await harness.host.ports.scopeSetup.proposal();
  await harness.host.ports.scopeSetup.initialize(proposal);

  const accepted = await harness.host.ports.execute({
    kind: 'send-session-message',
    coordinatorSessionId: proposal.coordinatorSessionId,
    content: '请读一下 Route Map',
  });
  expect(accepted.kind).toBe('accepted');

  expect(await waitFor(() => modelRounds(harness) >= 1)).toBe(true);

  const transcript = await harness.host.ports.transcript(proposal.coordinatorSessionId, null);
  expect(transcript.kind).toBe('transcript');
  if (transcript.kind !== 'transcript') {
    return;
  }
  const roles = transcript.transcript.messages.map((message) => message.role);
  expect(roles).toEqual(['user', 'assistant']);
  expect(transcript.transcript.messages[0]?.content).toBe('请读一下 Route Map');

  const snapshot = await harness.host.ports.snapshot(proposal.coordinatorSessionId);
  if (snapshot.kind !== 'snapshot') {
    throw new Error('snapshot 应可读');
  }
  expect(snapshot.snapshot.sessions[0]?.holdsRuntimeLease).toBe(true);
  expect(harness.events.some((event) => event.kind === 'state-changed')).toBe(true);
  // 事件带归属：会话级事件指向该 Session，而不是匿名的 Scope 事件。
  const sessionEvent = harness.events.find(
    (event) => event.kind === 'state-changed' && String(event.reason).startsWith('model:'),
  );
  expect(sessionEvent?.coordinatorSessionId).toBe(proposal.coordinatorSessionId);
  expect(sessionEvent?.eventId.length).toBeGreaterThan(0);
});

test('重启后继续未完成的工具回合，直到用户消息收到最终回答', async () => {
  const first = await startHarness();
  const proposal = await first.host.ports.scopeSetup.proposal();
  expect((await first.host.ports.scopeSetup.initialize(proposal)).kind).toBe('accepted');
  first.dispose();

  const commonDir = await resolveGitCommonDir({ repositoryPath: first.repository, env: process.env as Record<string, string> });
  if (commonDir.kind !== 'resolved') throw new Error('无法解析 Git common dir');
  const opened = openCheckpointStore({ databasePath: checkpointDatabasePath(commonDir.path), clock });
  if (opened.kind !== 'opened') throw new Error(opened.message);
  const call = {
    callId: 'call-before-crash',
    name: 'read_route_map',
    args: {},
    operationId: toolOperationId('step-before-crash', 'call-before-crash'),
    mapOperationId: null,
  };
  const assistant = {
    entryId: 'entry:assistant:step-before-crash',
    stepId: 'step-before-crash',
    role: 'assistant' as const,
    content: '',
    toolCalls: [call],
  };
  const saved = opened.store.saveCheckpoint({
    schemaVersion: COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
    coordinatorSessionId: proposal.coordinatorSessionId as CoordinatorSessionId,
    graphPosition: 'model',
    committedMessages: [
      { entryId: 'entry:user:before-crash', stepId: 'user:before-crash', role: 'user', content: '读取地图' },
      assistant,
    ],
    committedModelSteps: [
      { stepId: assistant.stepId, entryId: assistant.entryId, committedAt: clock(), messages: [assistant], toolCalls: [call], usage: null },
    ],
    wakeBatches: [],
    lastCompactionOutcome: null,
  });
  opened.store.close();
  expect(saved.kind).toBe('saved');

  const resumed = await startHarness({ repository: first.repository });
  expect(await resumed.host.ports.scopeSetup.resolveHome()).toEqual({
    kind: 'restore', coordinationScopeId: proposal.coordinationScopeId,
  });
  // 请求只用于按需打开 Session；恢复本身由宿主读取未完成的持久历史触发。
  await resumed.host.ports.execute({
    kind: 'compact-session', coordinatorSessionId: proposal.coordinatorSessionId, reason: '检查恢复',
  });
  expect(await waitFor(() => modelRounds(resumed) >= 1)).toBe(true);
  const transcript = await resumed.host.ports.transcript(proposal.coordinatorSessionId, null);
  expect(transcript.kind === 'transcript' ? transcript.transcript.messages.map((message) => message.role) : []).toEqual([
    'user', 'assistant', 'tool', 'assistant',
  ]);
});

test('回答写入 Branch 后即使进程退出，重启仍从权威正文恢复一次模型工作', async () => {
  const first = await startHarness();
  const proposal = await first.host.ports.scopeSetup.proposal();
  expect((await first.host.ports.scopeSetup.initialize(proposal)).kind).toBe('accepted');
  first.dispose();

  const commonDir = await resolveGitCommonDir({ repositoryPath: first.repository, env: process.env as Record<string, string> });
  if (commonDir.kind !== 'resolved') throw new Error('无法解析 Git common dir');
  const checkpoint = openCheckpointStore({ databasePath: checkpointDatabasePath(commonDir.path), clock });
  if (checkpoint.kind !== 'opened') throw new Error(checkpoint.message);
  const initial = checkpoint.store.saveCheckpoint({
    schemaVersion: COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
    coordinatorSessionId: proposal.coordinatorSessionId as CoordinatorSessionId,
    graphPosition: 'suspend',
    committedMessages: [],
    committedModelSteps: [],
    wakeBatches: [],
    lastCompactionOutcome: null,
  });
  checkpoint.store.close();
  expect(initial.kind).toBe('saved');
  const opened = openCoordinationStore({ databasePath: coordinationDatabasePath(commonDir.path), clock });
  if (opened.kind !== 'opened') throw new Error(opened.message);
  const scopeId = proposal.coordinationScopeId as CoordinationScopeId;
  const sessionId = proposal.coordinatorSessionId as CoordinatorSessionId;
  const lease = acquireRuntimeLease(opened.store, {
    coordinationScopeId: scopeId,
    coordinatorSessionId: sessionId,
    runtimeIncarnationId: 'answer-before-crash' as RuntimeIncarnationId,
    fencingGeneration: 0,
    ttlMs: 1_000,
  });
  if (lease.kind !== 'acquired') throw new Error('无法取得测试租约');
  const writer = {
    coordinatorSessionId: sessionId,
    runtimeIncarnationId: 'answer-before-crash' as RuntimeIncarnationId,
    fencingGeneration: lease.lease.fencingGeneration,
  };
  const scope = opened.store.query({ kind: 'scope', coordinationScopeId: scopeId });
  if (scope.kind !== 'scope' || scope.scope === null) throw new Error('无法读取 Scope');
  const recorded = opened.store.transact({
    kind: 'record-pending-interaction',
    coordinationScopeId: scopeId,
    expectedRevision: scope.scope.revision,
    writer,
    interactionId: 'interaction-before-crash' as never,
    ownerCoordinatorSessionId: sessionId,
    subjectRef: { kind: 'decision-ticket', id: 'ticket-1' },
  });
  if (recorded.kind !== 'committed') throw new Error(recorded.message);
  const snapshot = opened.store.query({ kind: 'snapshot', coordinationScopeId: scopeId });
  if (snapshot.kind !== 'snapshot') throw new Error('无法读取交互');
  const interaction = snapshot.snapshot.pendingInteractions.find((item) => item.interactionId === 'interaction-before-crash');
  if (interaction === undefined) throw new Error('交互未落盘');
  const answer = `${'解释背景。'.repeat(50)}最终选择方案 A。`;
  const answered = answerPendingInteraction({
    store: opened.store,
    coordinationScopeId: scopeId,
    writer,
    interactionId: interaction.interactionId,
    expectedRevision: interaction.expectedRevision,
    answer,
  });
  expect(answered.kind).toBe('answered');
  opened.store.close();
  now += 1_001;

  const resumed = await startHarness({ repository: first.repository });
  expect((await resumed.host.ports.scopeSetup.resolveHome()).kind).toBe('restore');
  const triggered = await resumed.host.ports.execute({
    kind: 'compact-session', coordinatorSessionId: sessionId, reason: '检查恢复',
  });
  expect(await waitFor(() => modelRounds(resumed) >= 1), JSON.stringify({ triggered, events: resumed.events })).toBe(true);
  expect(resumed.requests.inputs.some((input) => input.includes(answer))).toBe(true);
  const transcript = await resumed.host.ports.transcript(sessionId, null);
  expect(transcript.kind === 'transcript' ? transcript.transcript.messages.map((message) => message.role) : []).toEqual(['assistant']);
});

test('Runtime Lease 被续约；续约失败后停止模型调用与写入并发布 blocker', async () => {
  const harness = await startHarness();
  const proposal = await harness.host.ports.scopeSetup.proposal();
  await harness.host.ports.scopeSetup.initialize(proposal);
  await harness.host.ports.execute({
    kind: 'send-session-message',
    coordinatorSessionId: proposal.coordinatorSessionId,
    content: '开始规划',
  });
  expect(await waitFor(() => modelRounds(harness) >= 1)).toBe(true);

  const commonDir = await resolveGitCommonDir({ repositoryPath: harness.repository, env: process.env as Record<string, string> });
  if (commonDir.kind !== 'resolved') {
    throw new Error('无法解析 Git common dir');
  }
  const databasePath = coordinationDatabasePath(commonDir.path);

  const readLease = (): { readonly expiresAt: number | null } => {
    const opened = openCoordinationStore({ databasePath, clock, readOnly: true });
    if (opened.kind !== 'opened') {
      throw new Error(opened.message);
    }
    try {
      const leases = opened.store.query({
        kind: 'leases',
        coordinationScopeId: proposal.coordinationScopeId as CoordinationScopeId,
      });
      const lease = leases.kind === 'leases' ? leases.leases.find((entry) => entry.kind === 'runtime') : undefined;
      if (lease === undefined) {
        throw new Error('应当已有 Runtime Lease');
      }
      return { expiresAt: lease.expiresAt };
    } finally {
      opened.store.close();
    }
  };

  const before = readLease();
  expect(before.expiresAt).not.toBeNull();

  // 时钟前进到原 TTL 之内：心跳把到期时间往前推，因此会话仍然可用。
  now += 1_000;
  expect(
    await waitFor(() => {
      const current = readLease();
      return current.expiresAt !== null && current.expiresAt > (before.expiresAt ?? 0);
    }),
  ).toBe(true);

  const roundsBefore = modelRounds(harness);
  expect(
    await harness.host.ports.execute({
      kind: 'send-session-message',
      coordinatorSessionId: proposal.coordinatorSessionId,
      content: '继续',
    }),
  ).toMatchObject({ kind: 'accepted' });
  expect(await waitFor(() => modelRounds(harness) > roundsBefore)).toBe(true);

  // 时钟越过 TTL：续约必然失败，宿主必须立刻停止本 Session 的模型调用与写入。
  now += 120_000;

  expect(
    await waitFor(() =>
      harness.events.some((event) => event.kind === 'blocked' && event.code === 'fencing_lost'),
    ),
  ).toBe(true);

  const generationsAfterFence = harness.requests.generations;
  const rejected = await harness.host.ports.execute({
    kind: 'send-session-message',
    coordinatorSessionId: proposal.coordinatorSessionId,
    content: '续约失败后不该产生新的模型调用',
  });
  expect(rejected).toMatchObject({ kind: 'rejected', code: 'fencing_lost' });
  expect(harness.requests.generations).toBe(generationsAfterFence);

  const transcript = await harness.host.ports.transcript(proposal.coordinatorSessionId, null);
  if (transcript.kind !== 'transcript') {
    throw new Error('transcript 应可读');
  }
  // 被拒绝的消息没有落盘：历史停在续约失败之前。
  expect(transcript.transcript.messages.map((message) => message.role)).toEqual([
    'user',
    'assistant',
    'user',
    'assistant',
  ]);
  expect(transcript.transcript.messages.at(-1)?.content).toBe('pong');
});

test('未绑定的旧 Scope 在 Home 里作为候选出现，不按数量推断身份', async () => {
  const harness = await startHarness();
  const commonDir = await resolveGitCommonDir({ repositoryPath: harness.repository, env: process.env as Record<string, string> });
  if (commonDir.kind !== 'resolved') {
    throw new Error('无法解析 Git common dir');
  }
  const legacy = openCoordinationStore({ databasePath: coordinationDatabasePath(commonDir.path), clock });
  if (legacy.kind !== 'opened') {
    throw new Error(legacy.message);
  }
  try {
    const writer: CoordinationWriter = {
      coordinatorSessionId: 'session-legacy' as CoordinatorSessionId,
      runtimeIncarnationId: 'legacy#bootstrap' as RuntimeIncarnationId,
      fencingGeneration: 0,
    };
    const created = legacy.store.transact({
      kind: 'create-scope',
      coordinationScopeId: 'scope-legacy' as CoordinationScopeId,
      expectedRevision: 0,
      writer,
      mode: 'route_planning',
      controlState: 'active',
      planningCycleId: null,
      fullBranchRef: 'refs/heads/legacy',
      canonicalWorktreePath: '/tmp/orca-legacy',
    });
    expect(created.kind).toBe('committed');
  } finally {
    legacy.store.close();
  }

  const home = await harness.host.ports.scopeSetup.resolveHome();

  // 绑定到别的 branch 的 Scope 不会被误当成当前 Scope：当前仓库仍然是「没有匹配」。
  expect(home).toEqual({ kind: 'wizard' });
  expect(readFileSync(join(harness.repository, 'orca-companion.json'), 'utf8')).toContain('planning-default');
});

test('会话维护端口已接线：/compact 与模型切换都走既有用例并落到权威记录上', async () => {
  const harness = await startHarness();
  const proposal = await harness.host.ports.scopeSetup.proposal();
  await harness.host.ports.scopeSetup.initialize(proposal);
  await harness.host.ports.execute({
    kind: 'send-session-message',
    coordinatorSessionId: proposal.coordinatorSessionId,
    content: '先看一遍地图',
  });
  expect(await waitFor(() => modelRounds(harness) >= 1)).toBe(true);

  // 模型回合结束后停在 suspend：压缩与切换因此都满足准入前提。
  const compacted = await harness.host.ports.execute({
    kind: 'compact-session',
    coordinatorSessionId: proposal.coordinatorSessionId,
    reason: 'user-requested',
  });
  expect(compacted).toMatchObject({ kind: 'accepted', summary: '压缩结论：not_needed' });

  const afterCompaction = await harness.host.ports.snapshot(proposal.coordinatorSessionId);
  if (afterCompaction.kind !== 'snapshot') {
    throw new Error('snapshot 应可读');
  }
  expect(afterCompaction.snapshot.compaction).toMatchObject({ status: 'not_needed', path: 'none' });

  const catalog = await harness.host.ports.modelCatalog.load();
  expect(catalog.options.map((option) => option.configurationRef)).toEqual([
    'planning-default',
    'planning-spare',
  ]);
  expect(catalog.currentConfigurationRef).toBe('planning-default');
  expect(catalog.switchable).toBe(true);

  const switched = await harness.host.ports.execute({
    kind: 'switch-model-configuration',
    coordinatorSessionId: proposal.coordinatorSessionId,
    nextConfigurationRef: 'planning-spare',
  });
  expect(switched).toMatchObject({ kind: 'accepted' });

  // 绑定落在 IC-03 的 Session registry 上：重启后按它解析模型，而不是记在进程内。
  const commonDir = await resolveGitCommonDir({
    repositoryPath: harness.repository,
    env: process.env as Record<string, string>,
  });
  if (commonDir.kind !== 'resolved') {
    throw new Error('无法解析 Git common dir');
  }
  const store = openCoordinationStore({
    databasePath: coordinationDatabasePath(commonDir.path),
    clock,
    readOnly: true,
  });
  if (store.kind !== 'opened') {
    throw new Error(store.message);
  }
  try {
    const sessions = store.store.query({
      kind: 'sessions',
      coordinationScopeId: proposal.coordinationScopeId as CoordinationScopeId,
    });
    const registration =
      sessions.kind === 'sessions'
        ? sessions.sessions.find((entry) => entry.coordinatorSessionId === proposal.coordinatorSessionId)
        : undefined;
    expect(registration?.coordinatorModelConfigurationRef).toBe('planning-spare');
  } finally {
    store.store.close();
  }
});

test('上下文耗尽时不再发起超窗模型请求，并把耗尽原因投影进快照', async () => {
  // 预算刻意小到无法收敛：长消息会被机械 Shake 折成占位符，但固定开销仍然超窗。
  const harness = await startHarness({ maxInputTokens: 20 });
  const proposal = await harness.host.ports.scopeSetup.proposal();
  await harness.host.ports.scopeSetup.initialize(proposal);

  const accepted = await harness.host.ports.execute({
    kind: 'send-session-message',
    coordinatorSessionId: proposal.coordinatorSessionId,
    content: 'x'.repeat(3_000),
  });
  expect(accepted.kind).toBe('accepted');

  expect(
    await waitFor(() =>
      harness.events.some(
        (event) => event.kind === 'state-changed' && String(event.reason).startsWith('model:blocked'),
      ),
    ),
  ).toBe(true);

  const snapshot = await harness.host.ports.snapshot(proposal.coordinatorSessionId);
  if (snapshot.kind !== 'snapshot') {
    throw new Error('snapshot 应可读');
  }
  expect(snapshot.snapshot.compaction?.status).toBe('context_exhausted');

  // 耗尽期间普通消息照常落盘，但不再触发模型调用。
  const generationsBefore = harness.requests.generations;
  expect(
    await harness.host.ports.execute({
      kind: 'send-session-message',
      coordinatorSessionId: proposal.coordinatorSessionId,
      content: '耗尽之后仍然可以写下来的想法',
    }),
  ).toMatchObject({ kind: 'accepted' });
  expect(
    await waitFor(() =>
      harness.events.some((event) => event.kind === 'blocked' && event.code === 'context_exhausted'),
    ),
  ).toBe(true);
  // 会话启动时的能力核验会调用模型；这里断言的是耗尽之后没有任何**新的**调用。
  expect(harness.requests.generations).toBe(generationsBefore);

  const transcript = await harness.host.ports.transcript(proposal.coordinatorSessionId, null);
  if (transcript.kind !== 'transcript') {
    throw new Error('transcript 应可读');
  }
  expect(transcript.transcript.messages.map((message) => message.role)).toEqual(['user', 'user']);
});
