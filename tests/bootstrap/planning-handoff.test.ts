/**
 * `m1-wire-foreground-planning-runtime` D8 的行为测试：规划交接的宿主组装。
 *
 * 这里固定四件可观察事实：Target 必须由调用方显式选择；成功时走完整三阶段并转移规划责任；源 Session
 * 无法生成可移植 Capsule 时 prepare 被拒绝且责任留在 Source；提案引用的事实过期时 cutover 被拒绝。
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { CapableChatModel } from '../support/fake-chat-model.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  RuntimeIncarnationId,
} from '../../src/application/dto/identity.js';
import type { CoordinationWriter } from '../../src/application/ports/branch-coordination-store.js';
import type { IssueTrackerGateway, TrackerIssue, TrackerReadOutcome, TrackerWriteOutcome } from '../../src/application/planning/route-map-service.js';
import type { DoctorProbe } from '../../src/bootstrap/doctor.js';
import { createForegroundPlanningHost } from '../../src/bootstrap/foreground-planning-runtime.js';
import {
  coordinationDatabasePath,
  resolveGitCommonDir,
} from '../../src/bootstrap/composition.js';
import { openCoordinationStore, type CoordinationStore } from '../../src/adapters/storage/coordination-store.js';

/** 地图正文：开放票据章节为空表示没有未决决策，交接门禁因此可以放行。 */
const EMPTY_TICKET_MAP = [
  '## Destination',
  '把项目推进到目的地 A。',
  '## Resolved Decisions',
  '',
  '## Open Decision Tickets',
  '',
  '## Dependencies',
  '',
  '## Fog',
  '',
  '## Scope Boundaries',
  '',
].join('\n');

const directories: string[] = [];
const hosts: { close: () => void }[] = [];

afterEach(() => {
  for (const host of hosts.splice(0)) {
    host.close();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const now = 1_000;
const clock = (): number => now;

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

function fakeTracker(body: string): IssueTrackerGateway {
  const issue: TrackerIssue = {
    ref: { kind: 'route-map', id: '7' },
    title: 'Route Map',
    body,
    state: 'open',
    assignees: [],
  };
  return {
    readIssue: (): Promise<TrackerReadOutcome> => Promise.resolve({ kind: 'read', issue }),
    updateIssueBody: (): Promise<TrackerWriteOutcome> => Promise.resolve({ kind: 'accepted' }),
    assignIssue: (): Promise<TrackerWriteOutcome> => Promise.resolve({ kind: 'accepted' }),
  };
}

type Harness = {
  readonly host: Awaited<ReturnType<typeof createForegroundPlanningHost>>;
  readonly directory: string;
  readonly source: CoordinatorSessionId;
  readonly target: CoordinatorSessionId;
  readonly scopeId: CoordinationScopeId;
  readonly store: () => CoordinationStore;
};

async function startHandoffHarness(options: { readonly withSourceHistory: boolean }): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), 'orca-handoff-'));
  directories.push(directory);
  const repository = join(directory, 'repo');
  mkdirSync(repository);
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
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
    trackerFactory: () => fakeTracker(EMPTY_TICKET_MAP),
    loadIntegration: () => Promise.resolve({ CapableChatModel: class extends CapableChatModel {} }),
  });
  hosts.push(host);

  const proposal = await host.ports.scopeSetup.proposal();
  const initialized = await host.ports.scopeSetup.initialize(proposal);
  if (initialized.kind !== 'accepted') {
    throw new Error(`无法初始化测试 Scope：${initialized.message}`);
  }
  const scopeId = proposal.coordinationScopeId as CoordinationScopeId;
  const source = proposal.coordinatorSessionId as CoordinatorSessionId;
  const target = 'session-handoff-target' as CoordinatorSessionId;

  const commonDir = await resolveGitCommonDir({
    repositoryPath: repository,
    env: process.env as Record<string, string>,
  });
  if (commonDir.kind !== 'resolved') {
    throw new Error('无法解析 Git common dir');
  }
  const databasePath = coordinationDatabasePath(commonDir.path);
  const store = (): CoordinationStore => {
    const opened = openCoordinationStore({ databasePath, clock });
    if (opened.kind !== 'opened') {
      throw new Error(opened.message);
    }
    return opened.store;
  };

  // 第二个 Session 在任何 Runtime Lease 出现之前注册：bootstrap 窗口只覆盖创建阶段。
  const bootstrap = store();
  try {
    const registered = bootstrap.transact({
      kind: 'register-session',
      coordinationScopeId: scopeId,
      expectedRevision: revisionOf(bootstrap, scopeId),
      writer: {
        coordinatorSessionId: target,
        runtimeIncarnationId: `${target}#bootstrap` as RuntimeIncarnationId,
        fencingGeneration: 0,
      },
      coordinatorSessionId: target,
      coordinatorModelConfigurationRef: 'planning-default',
      lifecycleState: 'registered',
    });
    if (registered.kind !== 'committed') {
      throw new Error(`无法注册 Target Session：${registered.message}`);
    }
  } finally {
    bootstrap.close();
  }

  if (options.withSourceHistory) {
    // Source 产生真实已提交历史：这是 Capsule 能被派生出来的前提。
    await host.ports.execute({
      kind: 'send-session-message',
      coordinatorSessionId: source,
      content: '先读一遍 Route Map',
    });
    const history = await waitForHistory(host, source);
    if (history === 0) {
      throw new Error('Source 应当产生至少一个已提交 model step');
    }
  }

  return { host, directory, source, target, scopeId, store };
}

function revisionOf(store: CoordinationStore, scopeId: CoordinationScopeId): number {
  const scope = store.query({ kind: 'scope', coordinationScopeId: scopeId });
  return scope.kind === 'scope' && scope.scope !== null ? scope.scope.revision : 0;
}

/** 直接读 checkpoint 里的已提交 step 数：Capsule 派生依赖它。 */
async function waitForHistory(
  host: Awaited<ReturnType<typeof createForegroundPlanningHost>>,
  session: CoordinatorSessionId,
): Promise<number> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const transcript = await host.ports.transcript(session, null);
    if (transcript.kind === 'transcript') {
      const assistants = transcript.transcript.messages.filter((message) => message.role === 'assistant');
      if (assistants.length > 0) {
        return assistants.length;
      }
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 5);
    await promise;
  }
  return 0;
}

function responsibilityOf(store: CoordinationStore, scopeId: CoordinationScopeId): string | null {
  const read = store.query({ kind: 'planning-responsibility', coordinationScopeId: scopeId });
  return read.kind === 'planning-responsibility'
    ? (read.responsibility?.coordinatorSessionId ?? null)
    : null;
}

function proposalsOf(store: CoordinationStore, scopeId: CoordinationScopeId) {
  const read = store.query({ kind: 'planning-handoffs', coordinationScopeId: scopeId });
  return read.kind === 'planning-handoffs' ? read.handoffs : [];
}

test('Target 显式选择：把交接发起给自己会被拒绝，且责任不变', async () => {
  const harness = await startHandoffHarness({ withSourceHistory: true });

  const rejected = await harness.host.ports.handoff.prepareProposal(harness.source);

  expect(rejected).toMatchObject({ kind: 'rejected', code: 'invalid_argument' });
  const store = harness.store();
  try {
    expect(proposalsOf(store, harness.scopeId)).toEqual([]);
    expect(responsibilityOf(store, harness.scopeId)).toBe(harness.source);
  } finally {
    store.close();
  }
});

test('成功走三阶段：派生 Capsule、复核并 cutover，规划责任转移到 Target', async () => {
  const harness = await startHandoffHarness({ withSourceHistory: true });

  const prepared = await harness.host.ports.handoff.prepareProposal(harness.target);
  expect(prepared.kind).toBe('accepted');

  const store = harness.store();
  try {
    const preparedProposal = proposalsOf(store, harness.scopeId).at(-1);
    expect(preparedProposal?.phase).toBe('prepared');
    expect(preparedProposal?.targetCoordinatorSessionId).toBe(harness.target);
    expect(preparedProposal?.capsuleRef).toMatch(/^capsule:.+\.\..+/u);
    // prepare 阶段责任仍在 Source。
    expect(responsibilityOf(store, harness.scopeId)).toBe(harness.source);

    const cutover = await harness.host.ports.handoff.cutover(preparedProposal?.proposalId ?? '');
    expect(cutover.kind).toBe('accepted');

    expect(proposalsOf(store, harness.scopeId).at(-1)?.phase).toBe('cutover');
    expect(responsibilityOf(store, harness.scopeId)).toBe(harness.target);
  } finally {
    store.close();
  }
});

test('源 Session 无法生成可移植 Capsule 时拒绝 prepare，责任留在 Source', async () => {
  const harness = await startHandoffHarness({ withSourceHistory: false });

  const prepared = await harness.host.ports.handoff.prepareProposal(harness.target);

  expect(prepared).toMatchObject({ kind: 'rejected', code: 'capsule_unavailable' });
  const store = harness.store();
  try {
    expect(proposalsOf(store, harness.scopeId)).toEqual([]);
    expect(responsibilityOf(store, harness.scopeId)).toBe(harness.source);
  } finally {
    store.close();
  }
});

test('提案引用的事实过期时 cutover 被拒绝，不转移责任', async () => {
  const harness = await startHandoffHarness({ withSourceHistory: true });
  const prepared = await harness.host.ports.handoff.prepareProposal(harness.target);
  expect(prepared.kind).toBe('accepted');

  const store = harness.store();
  try {
    const proposal = proposalsOf(store, harness.scopeId).at(-1);
    const leases = store.query({ kind: 'leases', coordinationScopeId: harness.scopeId });
    const lease = leases.kind === 'leases' ? leases.leases.find((entry) => entry.kind === 'runtime') : undefined;
    if (lease === undefined) {
      throw new Error('Source 应当持有 Runtime Lease');
    }
    const writer: CoordinationWriter = {
      coordinatorSessionId: lease.coordinatorSessionId,
      runtimeIncarnationId: lease.runtimeIncarnationId,
      fencingGeneration: lease.fencingGeneration,
    };
    const advanced = store.transact({
      kind: 'advance-map-revision',
      coordinationScopeId: harness.scopeId,
      expectedRevision: revisionOf(store, harness.scopeId),
      writer,
      mapRevision: 1,
    });
    expect(advanced.kind).toBe('committed');

    const cutover = await harness.host.ports.handoff.cutover(proposal?.proposalId ?? '');

    // 复核阶段就会拒绝：接收方读到的事实与提案引用不一致，因此不会走到 cutover。
    expect(cutover).toMatchObject({ kind: 'rejected', code: 'review_failed' });
    expect(responsibilityOf(store, harness.scopeId)).toBe(harness.source);
    expect(proposalsOf(store, harness.scopeId).at(-1)?.phase).toBe('prepared');
  } finally {
    store.close();
  }
});
