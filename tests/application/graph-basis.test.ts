import { afterEach, expect, test } from 'vitest';

import { createGraphBasisService } from '../../src/application/tui/graph-basis-service.js';
import type { BasisReadResult, BasisSourceRef, GraphVersionRef } from '../../src/application/tui/graph-basis.js';
import type { DispatchId, GraphGeneration, GraphVersion, OperationId, WorkPackageId, WorkerTaskId } from '../../src/application/dto/identity.js';
import type { CoordinationCommand, MaterializationBindingRecord } from '../../src/application/ports/branch-coordination-store.js';
import type { IssueTrackerGateway, TrackerBodyOutcome } from '../../src/application/planning/route-map-service.js';
import type { SpecificationProvider } from '../../src/application/ports/specification-provider.js';
import { appendAcceptedRevision, recordInitialGraph } from '../../src/application/planning/graph-history.js';
import { graphIdFor } from '../../src/application/planning/graph-generation.js';
import { implementationPlanFor } from '../support/graph-plan-fixture.js';
import { createFakeGraphBasis } from '../support/graph-basis.js';
import { createExecutionScopeHarness, executionWorkPackage } from '../support/execution-harness.js';
import type { WorkPackage } from '../../src/domain/planning/execution-graph.js';

const harnesses: ReturnType<typeof createExecutionScopeHarness>[] = [];
const makeHarness = (workPackages?: readonly WorkPackage[]) => {
  const harness = createExecutionScopeHarness(workPackages === undefined ? undefined : { workPackages });
  harnesses.push(harness);
  return harness;
};

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close();
});

const session = 'session-a';
const graphRef = (harness: ReturnType<typeof createExecutionScopeHarness>, generation = harness.generation, version = 1): GraphVersionRef => ({
  graphId: harness.graphId, generation, version,
});

function service(harness: ReturnType<typeof createExecutionScopeHarness>, options: {
  tracker?: IssueTrackerGateway | null;
  specification?: (binding: MaterializationBindingRecord) => Promise<SpecificationProvider | null>;
  routeMapIssueRef?: string | null;
} = {}) {
  return createGraphBasisService({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    tracker: options.tracker ?? null,
    routeMapIssueRef: options.routeMapIssueRef ?? null,
    specification: options.specification ?? (() => Promise.resolve(null)),
  });
}

function trackerWithBody(readBody: () => TrackerBodyOutcome): IssueTrackerGateway {
  return {
    readIssue: () => Promise.resolve({ kind: 'not_found' }),
    readIssueBody: () => Promise.resolve(readBody()),
    updateIssueBody: () => Promise.resolve({ kind: 'accepted' }),
    assignIssue: () => Promise.resolve({ kind: 'accepted' }),
  };
}

function read<T>(result: BasisReadResult<T>): T {
  expect(result.kind).toBe('read');
  if (result.kind !== 'read') throw new Error(`expected readable result, got ${result.kind}`);
  return result.value;
}

function recordBinding(harness: ReturnType<typeof createExecutionScopeHarness>, input: {
  workPackageId: string; orcaTaskId: string; specBinding?: MaterializationBindingRecord['specBinding'];
}): void {
  const result = harness.store.query({ kind: 'scope', coordinationScopeId: harness.scopeId });
  if (result.kind !== 'scope' || result.scope === null) throw new Error('scope missing');
  const command: CoordinationCommand = {
    kind: 'record-materialization-binding', coordinationScopeId: harness.scopeId, expectedRevision: result.scope.revision,
    writer: harness.writer, workPackageId: input.workPackageId as WorkPackageId, role: 'implementation',
    workerTaskId: `worker-${input.orcaTaskId}` as WorkerTaskId, dispatchId: `dispatch-${input.orcaTaskId}` as DispatchId,
    attemptId: `attempt-${input.orcaTaskId}`, worktreeId: 'worktree-a', specBinding: input.specBinding ?? {
      provider: 'openspec', relativePath: 'openspec/changes/unit-a', contentDigest: 'digest-a',
      providerVersion: '1', contractRevision: 7, trackingRevision: 9,
    },
    specificationUnitPath: null, authorizationId: 'auth-1', authorizationVersion: 1,
    workerProfileRef: 'profile-implementation', orcaTaskId: input.orcaTaskId, launchId: `launch-${input.orcaTaskId}`,
    creationOperationId: `operation-${input.orcaTaskId}` as OperationId,
  };
  const written = harness.store.transact(command);
  if (written.kind !== 'committed') throw new Error(`binding fixture rejected: ${written.code} ${written.message}`);
}

async function readAll(port: ReturnType<typeof service>, source: BasisSourceRef, sourceVersion: string | null = null) {
  let offset = 0;
  let observed = sourceVersion;
  let body = '';
  for (;;) {
    const range = read(await port.readSource({ coordinatorSessionId: session, source, sourceVersion: observed, offset, maxBytes: 128 }));
    observed ??= range.sourceVersion;
    body += range.text;
    const end = range.end;
    if (end === offset) break;
    offset = end;
    if (offset >= range.byteLength) break;
  }
  return { body, sourceVersion: observed };
}

test('真实 schema17 store 按 Scope 与注册 Session 列出全代际 metadata，并连续读取原计划、patch 和批准 Manifest', async () => {
  const harness = makeHarness([
    executionWorkPackage('包甲'), executionWorkPackage('包乙'),
  ]);
  const initial = harness.currentGraph();
  const nextGeneration = 2 as GraphGeneration;
  const nextGraphId = graphIdFor(harness.scopeId, nextGeneration);
  const nextGraph = { ...initial.graph, graphId: nextGraphId, generation: nextGeneration };
  const candidate = recordInitialGraph({
    store: harness.store, coordinationScopeId: harness.scopeId, writer: harness.writer, graph: nextGraph,
    initialPlan: implementationPlanFor(nextGraph, 4), mapRevision: 3, planRevision: 4, orcaRunId: 'run-next',
  });
  expect(candidate.kind).toBe('recorded');
  const appended = appendAcceptedRevision({
    store: harness.store, coordinationScopeId: harness.scopeId, writer: harness.writer,
    graphId: harness.graphId, expectedVersion: 1 as GraphVersion, generation: harness.generation,
    mapRevision: 2, planRevision: 3, orcaRunId: 'run-1', graph: {
      ...initial.graph, workPackages: [initial.graph.workPackages[0]!, executionWorkPackage('wp-e')],
    }, patch: {
    patchId: 'patch-1', operationId: 'patch-operation' as OperationId, baseGraphVersion: 1 as GraphVersion,
      added: ['wp-e' as WorkPackageId], revised: [], retired: [initial.graph.workPackages[1]!.workPackageId], descendants: [], takesOver: [], revisionPendingWorkPackageIds: [],
    },
  });
  expect(appended.kind).toBe('appended');

  const port = service(harness, { routeMapIssueRef: '42' });
  const retiredId = initial.graph.workPackages[1]!.workPackageId;
  const revisedRef = graphRef(harness, harness.generation, 2);
  expect(read(await port.readVersion({ coordinatorSessionId: session, graph: revisedRef })).retiredWorkPackageIds).toEqual([retiredId]);
  expect((await port.listSources({ coordinatorSessionId: session, graph: revisedRef, workPackageId: retiredId, after: null })).kind).toBe('read');
  const listed = read(await port.listVersions({ coordinatorSessionId: session, after: null }));
  expect(listed.items.map(item => [item.generation, item.version, item.recordKind])).toEqual([
    [2, 1, 'initial'], [1, 2, 'accepted_revision'], [1, 1, 'initial'],
  ]);
  expect(listed.items.every(item => !('graph' in item))).toBe(true);
  expect((await port.listVersions({ coordinatorSessionId: 'other-session', after: null })).kind).toBe('unavailable');

  const plan = read(await port.listSources({ coordinatorSessionId: session, graph: graphRef(harness), workPackageId: null, after: null }));
  const planSource = plan.items.find(item => item.id === 'initial-plan')?.ref;
  if (planSource?.kind !== 'initial_plan') throw new Error('initial plan source missing');
  const planRead = await readAll(port, planSource);
  expect(planRead.body).toContain('包甲');
  const patchPage = read(await port.listSources({ coordinatorSessionId: session, graph: graphRef(harness, harness.generation, 2), workPackageId: null, after: null }));
  const patchSource = patchPage.items.find(item => item.id === 'graph-patch')?.ref;
  if (patchSource?.kind !== 'graph_patch') throw new Error('graph patch source missing');
  expect((await readAll(port, patchSource)).body).toContain('patch-1');
  const workPackageId = initial.graph.workPackages[0]?.workPackageId;
  if (workPackageId === undefined) throw new Error('graph has no work package');
  const directoryFirst = read(await port.listSources({ coordinatorSessionId: session, graph: graphRef(harness), workPackageId, after: null }));
  if (directoryFirst.nextCursor === null) throw new Error('approval directory phase missing');
  const approvalPage = read(await port.listSources({ coordinatorSessionId: session, graph: graphRef(harness), workPackageId, after: directoryFirst.nextCursor }));
  expect(approvalPage.items).toHaveLength(1);
  const authorizationSource = approvalPage.items[0]?.ref;
  if (authorizationSource?.kind !== 'authorization') throw new Error('approved authorization source missing');
  const authRead = await readAll(port, authorizationSource);
  expect(JSON.parse(authRead.body)).toEqual(harness.authorization().manifest);
  expect((await port.readSource({ coordinatorSessionId: session, source: planSource, sourceVersion: authRead.sourceVersion, offset: 0, maxBytes: 32 })).kind).toBe('stale');

  const scopeRevision = harness.revision();
  const resumed = await port.readSource({ coordinatorSessionId: session, source: planSource, sourceVersion: planRead.sourceVersion, offset: 0, maxBytes: 32 });
  expect(resumed.kind).toBe('read');
  expect(harness.revision()).toBe(scopeRevision);
});

test('依据目录在固定前缀与保留绑定间分段分页；游标拒绝跨 Session、图或对象复用', async () => {
  const harness = makeHarness([executionWorkPackage('wp-a')]);
  for (let index = 0; index < 11; index++) recordBinding(harness, { workPackageId: 'wp-a', orcaTaskId: `task-${String(index).padStart(2, '0')}` });
  const initial = harness.currentGraph();
  const appended = appendAcceptedRevision({
    store: harness.store, coordinationScopeId: harness.scopeId, writer: harness.writer,
    graphId: harness.graphId, expectedVersion: 1 as GraphVersion, generation: harness.generation,
    mapRevision: 2, planRevision: 3, orcaRunId: 'run-1', graph: initial.graph,
    patch: {
      patchId: 'cursor-patch', operationId: 'cursor-operation' as OperationId, baseGraphVersion: 1 as GraphVersion,
      added: [], revised: [], retired: [], descendants: [], takesOver: [], revisionPendingWorkPackageIds: [],
    },
  });
  expect(appended.kind).toBe('appended');
  const port = service(harness, { routeMapIssueRef: '42' });
  const graph = graphRef(harness);
  const first = read(await port.listSources({ coordinatorSessionId: session, graph, workPackageId: 'wp-a', after: null }));
  expect(first.items).toHaveLength(4);
  expect(first.nextCursor).not.toBeNull();
  const otherPackage = await port.listSources({ coordinatorSessionId: session, graph, workPackageId: 'wp-b', after: first.nextCursor });
  expect(otherPackage.kind).toBe('unavailable');
  const otherSession = await port.listSources({ coordinatorSessionId: 'session-b', graph, workPackageId: 'wp-a', after: first.nextCursor });
  expect(otherSession.kind).toBe('unavailable');

  const approvalPage = read(await port.listSources({ coordinatorSessionId: session, graph, workPackageId: 'wp-a', after: first.nextCursor }));
  expect(approvalPage.items).toHaveLength(1);
  expect(approvalPage.items[0]?.id).toContain('auth-1@1');
  if (approvalPage.nextCursor === null) throw new Error('task binding phase missing');
  const bindingPage = read(await port.listSources({ coordinatorSessionId: session, graph, workPackageId: 'wp-a', after: approvalPage.nextCursor }));
  expect(bindingPage.items).toHaveLength(20);
  expect(bindingPage.items.every(item => item.ref?.kind === 'retained_task' || item.ref?.kind === 'authorization' || item.ref?.kind === 'specification')).toBe(true);
  expect(bindingPage.nextCursor).not.toBeNull();
  const complete = [...bindingPage.items];
  const last = read(await port.listSources({ coordinatorSessionId: session, graph, workPackageId: 'wp-a', after: bindingPage.nextCursor }));
  complete.push(...last.items);
  expect(complete).toHaveLength(33);
  expect(last.nextCursor).toBeNull();
  const foreignCursor = await port.listVersions({ coordinatorSessionId: 'session-b', after: JSON.stringify({ coordinatorSessionId: session, generation: 1, graphId: harness.graphId, version: 1 }) });
  expect(foreignCursor.kind).toBe('unavailable');
  const foreignGraphCursor = await port.listSources({ coordinatorSessionId: session, graph: { ...graph, version: 2 }, workPackageId: 'wp-a', after: first.nextCursor });
  expect(foreignGraphCursor.kind).toBe('unavailable');
});

test('tracker 按 observed sourceVersion 连续读取；显式当前读取更新正文，旧版本不会被替换', async () => {
  const harness = makeHarness();
  let current = { body: '甲'.repeat(90), sourceVersion: 'updated-1' };
  let reads = 0;
  const tracker = trackerWithBody(() => { reads++; return { kind: 'read', value: { ref: { kind: 'route-map', id: '42' }, title: 'map', ...current } }; });
  const port = service(harness, { tracker, routeMapIssueRef: '42' });
  const source = { kind: 'tracker', issueRef: '42' } as const;
  const first = read(await port.readSource({ coordinatorSessionId: session, source, sourceVersion: null, offset: 0, maxBytes: 10 }));
  expect(first.text).toBe('甲'.repeat(3));
  const continuation = read(await port.readSource({ coordinatorSessionId: session, source, sourceVersion: first.sourceVersion, offset: first.end, maxBytes: 10 }));
  expect(continuation.text).toBe('甲'.repeat(3));
  expect(reads).toBe(1);
  current = { body: '乙'.repeat(90), sourceVersion: 'updated-2' };
  const pinned = read(await port.readSource({ coordinatorSessionId: session, source, sourceVersion: first.sourceVersion, offset: first.end, maxBytes: 10 }));
  expect(pinned.text).toBe('甲'.repeat(3));
  expect(reads).toBe(1);
  const refreshed = read(await port.readSource({ coordinatorSessionId: session, source, sourceVersion: null, offset: 0, maxBytes: 10 }));
  expect(refreshed).toMatchObject({ text: '乙'.repeat(3), sourceVersion: 'updated-2' });
  expect(reads).toBe(2);
  expect((await port.readSource({ coordinatorSessionId: session, source, sourceVersion: first.sourceVersion, offset: first.end, maxBytes: 10 })).kind).toBe('stale');
});

test('原生规格读取要求Task、Work Package、locator与contract revision全部匹配', async () => {
  const harness = makeHarness([executionWorkPackage('wp-a')]);
  const specBinding: NonNullable<MaterializationBindingRecord['specBinding']> = {
    provider: 'openspec', relativePath: 'openspec/changes/unit-a', contentDigest: 'digest-a',
    providerVersion: '1', contractRevision: 7, trackingRevision: 9,
  };
  recordBinding(harness, { workPackageId: 'wp-a', orcaTaskId: 'task-a', specBinding });
  const calls: unknown[] = [];
  const provider: SpecificationProvider = {
    providerId: 'openspec', providerVersion: '1',
    readUnit: () => Promise.reject(new Error('not used')),
    readRoleTransition: () => Promise.reject(new Error('not used')),
    readFiles: input => { calls.push(input); return Promise.resolve({ kind: 'read', value: { items: [{ path: 'spec.md', sourceVersion: 'file-v1', byteLength: 4 }], nextCursor: input.after === null ? 'spec.md' : null } }); },
    readFileRange: input => { calls.push(input); return Promise.resolve({ kind: 'read', value: { text: 'test', sourceVersion: 'file-v1', offset: input.offset, end: 4, byteLength: 4 } }); },
  };
  const port = service(harness, { specification: () => Promise.resolve(provider) });
  const graph = graphRef(harness);
  const files = read(await port.listSources({ coordinatorSessionId: session, graph, workPackageId: 'wp-a', orcaTaskId: 'task-a', after: null }));
  const file = files.items[0]?.ref;
  if (file?.kind !== 'specification') throw new Error('specification source missing');
  expect(file).toMatchObject({ kind: 'specification', workPackageId: 'wp-a', orcaTaskId: 'task-a' });
  expect(files.nextCursor).not.toBeNull();
  const foreignCursor = JSON.stringify({ ...JSON.parse(files.nextCursor!) as Record<string, unknown>, coordinatorSessionId: 'other-session' });
  expect(await port.listSources({ coordinatorSessionId: session, graph, workPackageId: 'wp-a', orcaTaskId: 'task-a', after: foreignCursor })).toMatchObject({ kind: 'unavailable', code: 'invalid_cursor' });
  const spoofed = await port.readSource({ coordinatorSessionId: session, source: { ...file, workPackageId: 'wp-spoof' }, sourceVersion: 'file-v1', offset: 0, maxBytes: 64 });
  expect(spoofed).toMatchObject({ kind: 'unavailable', code: 'not_recorded_binding' });
  expect(calls).toHaveLength(1);
  const accepted = read(await port.readSource({ coordinatorSessionId: session, source: file, sourceVersion: 'file-v1', offset: 0, maxBytes: 64 }));
  expect(accepted.text).toBe('test');
  expect(calls).toHaveLength(2);
  expect(calls[1]).toMatchObject({ locator: { worktreeId: 'worktree-a', relativePath: 'openspec/changes/unit-a' }, contractRevision: 7, path: 'spec.md', sourceVersion: 'file-v1' });
  const trackerRevision = await port.readSource({ coordinatorSessionId: session, source: file, sourceVersion: 'tracking-v10', offset: 0, maxBytes: 64 });
  expect(trackerRevision.kind).toBe('read');
});

test('正文范围接受4至65536字节并拒绝范围外请求', async () => {
  const harness = makeHarness();
  const tracker = trackerWithBody(() => ({ kind: 'read', value: { ref: { kind: 'route-map', id: '42' }, title: 'map', body: 'x'.repeat(70_000), sourceVersion: 'v1' } }));
  const port = service(harness, { tracker, routeMapIssueRef: '42' });
  const source = { kind: 'tracker', issueRef: '42' } as const;
  const smallest = await port.readSource({ coordinatorSessionId: session, source, sourceVersion: null, offset: 0, maxBytes: 4 });
  const smallestRange = read(smallest);
  expect(smallestRange.text).toBe('xxxx');
  const maximum = await port.readSource({ coordinatorSessionId: session, source, sourceVersion: 'v1', offset: 4, maxBytes: 65_536 });
  const maximumRange = read(maximum);
  expect(maximumRange.byteLength).toBe(70_000);
  expect((await port.readSource({ coordinatorSessionId: session, source, sourceVersion: 'v1', offset: 0, maxBytes: 3 })).kind).toBe('unavailable');
  expect((await port.readSource({ coordinatorSessionId: session, source, sourceVersion: 'v1', offset: 0, maxBytes: 65_537 })).kind).toBe('unavailable');
});

test('UTF-8 范围在完整字符边界结束并沿调用方版本续读', async () => {
  const fake = createFakeGraphBasis({
    bodies: { 'tracker:42': '甲乙' },
  });
  const source = { kind: 'tracker', issueRef: '42' } as const;
  const first = read(await fake.port.readSource({ coordinatorSessionId: session, source, sourceVersion: 'map-v7', offset: 0, maxBytes: 4 }));
  expect(first).toMatchObject({ sourceVersion: 'map-v7', text: '甲', offset: 0, end: 3, byteLength: 6 });
  const next = read(await fake.port.readSource({ coordinatorSessionId: session, source, sourceVersion: first.sourceVersion, offset: first.end, maxBytes: 3 }));
  expect(next).toMatchObject({ sourceVersion: 'map-v7', text: '乙', offset: 3, end: 6 });
});
