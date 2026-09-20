import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import type { ExecutionBackend, ExecutionScope } from '../src/application/ports/execution-backend.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  EntityRef,
  OperationId,
  PlanningCycleId,
  RuntimeIncarnationId,
} from '../src/application/dto/identity.js';
import type { OperationOutcome } from '../src/application/dto/operation-outcome.js';
import type {
  CoordinationCommandResult,
  CoordinationWriter,
} from '../src/application/ports/branch-coordination-store.js';
import {
  beginIntent,
  blockLane,
  resolveLane,
  settleIntent,
  type SettleIntentResult,
} from '../src/application/coordination/intent-service.js';
import { acquireRuntimeLease } from '../src/application/coordination/lease-service.js';
import { openCoordinationStore, type CoordinationStore } from '../src/adapters/storage/coordination-store.js';

const SCOPE = 'scope-1' as CoordinationScopeId;
const SESSION = 'session-a' as CoordinatorSessionId;
const INCARNATION = 'inc-1' as RuntimeIncarnationId;
const TARGET: EntityRef<string> = { kind: 'orca_run', id: 'run-1' };

let directory = '';
let store: CoordinationStore;
let writer: CoordinationWriter;
let now = 5_000;

const clock = (): number => now;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-intent-'));
  now = 5_000;
  const opened = openCoordinationStore({ databasePath: join(directory, 'coordination.sqlite'), clock });
  if (opened.kind !== 'opened') {
    throw new Error(opened.message);
  }
  store = opened.store;

  const bootstrap: CoordinationCommandResult = store.transact({
    kind: 'create-scope',
    coordinationScopeId: SCOPE,
    expectedRevision: 0,
    writer: { coordinatorSessionId: SESSION, runtimeIncarnationId: INCARNATION, fencingGeneration: 0 },
    mode: 'route_planning',
    controlState: 'active',
    planningCycleId: 'cycle-1' as PlanningCycleId,
  });
  if (bootstrap.kind !== 'committed') {
    throw new Error('无法创建测试 Scope');
  }
  const registered = store.transact({
    kind: 'register-session',
    coordinationScopeId: SCOPE,
    expectedRevision: bootstrap.revision,
    writer: { coordinatorSessionId: SESSION, runtimeIncarnationId: INCARNATION, fencingGeneration: 0 },
    coordinatorSessionId: SESSION,
    coordinatorModelConfigurationRef: 'profile-a',
    lifecycleState: 'registered',
  });
  if (registered.kind !== 'committed') {
    throw new Error('无法注册测试 Session');
  }
  const lease = acquireRuntimeLease(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION,
    runtimeIncarnationId: INCARNATION,
    fencingGeneration: 0,
  });
  if (lease.kind !== 'acquired') {
    throw new Error('无法取得测试 Runtime Lease');
  }
  writer = {
    coordinatorSessionId: SESSION,
    runtimeIncarnationId: INCARNATION,
    fencingGeneration: lease.lease.fencingGeneration,
  };
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

function executionScope(operationId: string, expectedRevision: number): ExecutionScope {
  return {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION,
    runtimeIncarnationId: INCARNATION,
    fencingGeneration: writer.fencingGeneration,
    backendIdentityRef: 'identity-ref',
    operationId,
    target: TARGET,
    expectedRevision,
    timeoutMs: 5_000,
    authority: { kind: 'route_planning' },
  };
}

type OperationRun = {
  readonly begin: ReturnType<typeof beginIntent>;
  readonly settle: SettleIntentResult | null;
};

/** FLOW-01 的最小用例：先落盘意图，再调用外部 mutation，最后按三值结果收尾。 */
async function runOperation(
  operationId: OperationId,
  operationCategory: string,
  backend: ExecutionBackend,
): Promise<OperationRun> {
  const begin = beginIntent(store, {
    coordinationScopeId: SCOPE,
    operationId,
    target: TARGET,
    operationCategory,
    writer,
    expectedRevision: revisionOf(),
  });
  if (begin.kind !== 'registered') {
    return { begin, settle: null };
  }
  const outcome = await backend.mutate(
    { operation: 'run-create', objective: '测试目标' },
    executionScope(operationId, begin.revision),
  );
  const settle = settleIntent(store, {
    coordinationScopeId: SCOPE,
    operationId,
    writer,
    expectedRevision: begin.revision,
    outcome,
  });
  return { begin, settle };
}

function recordingBackend(
  observed: boolean[],
  outcome: OperationOutcome<unknown>,
): ExecutionBackend {
  return {
    query: () => Promise.resolve({ kind: 'rejected', code: 'not_used', message: '测试不使用查询' }),
    mutate: (_input, scope) => {
      const recorded = store.query({
        kind: 'intent',
        coordinationScopeId: SCOPE,
        operationId: scope.operationId as OperationId,
      });
      observed.push(recorded.kind === 'intent' && recorded.intent !== null && recorded.intent.state === 'pending');
      return Promise.resolve(outcome);
    },
  };
}

function acceptedOutcome(operationId: string, backendRequestId: string): OperationOutcome<unknown> {
  return {
    kind: 'accepted',
    operation: { operationId, target: TARGET, backendRequestId },
    value: { recorded: true },
  };
}

test('意图先于外部调用落盘，确定结果随后收尾', async () => {
  const observed: boolean[] = [];
  const run = await runOperation(
    'op-1' as OperationId,
    'run-create',
    recordingBackend(observed, acceptedOutcome('op-1', 'req-1')),
  );

  expect(observed).toEqual([true]);
  expect(run.begin.kind).toBe('registered');
  expect(run.settle?.kind).toBe('settled');
  if (run.settle?.kind === 'settled') {
    expect(run.settle.outcomeClass).toBe('accepted');
    expect(run.settle.intent.state).toBe('settled');
    expect(run.settle.intent.outcomeClass).toBe('accepted');
    expect(run.settle.intent.backendRequestId).toBe('req-1');
    expect(run.settle.intent.settledAt).not.toBeNull();
  }
});

test('重复 OperationId 返回既有记录而不是创建第二条意图', async () => {
  await runOperation(
    'op-1' as OperationId,
    'run-create',
    recordingBackend([], acceptedOutcome('op-1', 'req-1')),
  );

  const duplicate = beginIntent(store, {
    coordinationScopeId: SCOPE,
    operationId: 'op-1' as OperationId,
    target: TARGET,
    operationCategory: 'run-create',
    writer,
    expectedRevision: revisionOf(),
  });

  expect(duplicate.kind).toBe('existing');
  const intents = store.query({ kind: 'intents', coordinationScopeId: SCOPE });
  if (intents.kind === 'intents') {
    expect(intents.intents.filter((intent) => intent.operationId === 'op-1')).toHaveLength(1);
  }
});

test('重复 OperationId 不能改绑目标或操作类别', async () => {
  await runOperation(
    'op-1' as OperationId,
    'run-create',
    recordingBackend([], acceptedOutcome('op-1', 'req-1')),
  );

  const duplicate = beginIntent(store, {
    coordinationScopeId: SCOPE,
    operationId: 'op-1' as OperationId,
    target: { kind: 'orca_run', id: 'other-run' },
    operationCategory: 'run-start',
    writer,
    expectedRevision: revisionOf(),
  });

  expect(duplicate).toMatchObject({ kind: 'rejected', rejection: { code: 'invalid_state' } });
});

test('rejected 收尾记录分类且不携带 backend request 引用', async () => {
  const rejected: OperationOutcome<unknown> = { kind: 'rejected', code: 'run_not_startable', message: '未启动' };
  const run = await runOperation('op-2' as OperationId, 'run-create', recordingBackend([], rejected));

  expect(run.settle?.kind).toBe('settled');
  if (run.settle?.kind === 'settled') {
    expect(run.settle.outcomeClass).toBe('rejected');
    expect(run.settle.intent.backendRequestId).toBeNull();
  }
});

test('unknown 结果保留未决并记录 backend request 引用', async () => {
  const unknown: OperationOutcome<unknown> = {
    kind: 'unknown',
    operation: { operationId: 'op-3', target: TARGET, backendRequestId: 'req-3' },
    reason: '响应丢失',
  };
  const run = await runOperation('op-3' as OperationId, 'run-create', recordingBackend([], unknown));

  expect(run.settle?.kind).toBe('retained');
  if (run.settle?.kind === 'retained') {
    expect(run.settle.intent.state).toBe('pending');
    expect(run.settle.intent.outcomeClass).toBeNull();
    expect(run.settle.intent.backendRequestId).toBe('req-3');
  }

  // 同一 lane 上的新变更被拒绝，其它 lane 不受影响。
  const sameLane = beginIntent(store, {
    coordinationScopeId: SCOPE,
    operationId: 'op-4' as OperationId,
    target: TARGET,
    operationCategory: 'run-create',
    writer,
    expectedRevision: revisionOf(),
  });
  expect(sameLane.kind).toBe('lane_busy');

  const otherLane = beginIntent(store, {
    coordinationScopeId: SCOPE,
    operationId: 'op-5' as OperationId,
    target: { kind: 'orca_task', id: 'task-1' },
    operationCategory: 'task-create',
    writer,
    expectedRevision: revisionOf(),
  });
  expect(otherLane.kind).toBe('registered');
});

test('不匹配的 OperationOutcome 不能收尾另一条 intent', () => {
  const begin = beginIntent(store, {
    coordinationScopeId: SCOPE,
    operationId: 'op-a' as OperationId,
    target: TARGET,
    operationCategory: 'run-create',
    writer,
    expectedRevision: revisionOf(),
  });
  expect(begin.kind).toBe('registered');
  if (begin.kind !== 'registered') {
    return;
  }

  const mismatched = settleIntent(store, {
    coordinationScopeId: SCOPE,
    operationId: 'op-a' as OperationId,
    writer,
    expectedRevision: begin.revision,
    outcome: {
      kind: 'accepted',
      operation: {
        operationId: 'op-b',
        target: { kind: 'orca_run', id: 'run-b' },
        backendRequestId: 'req-b',
      },
      value: {},
    },
  });

  expect(mismatched.kind).toBe('rejected');
  const intent = store.query({
    kind: 'intent',
    coordinationScopeId: SCOPE,
    operationId: 'op-a' as OperationId,
  });
  if (intent.kind === 'intent') {
    expect(intent.intent?.state).toBe('pending');
    expect(intent.intent?.backendRequestId).toBeNull();
  }
});

test('对账仍不确定时阻塞该 lane，收尾后解除', async () => {
  const unknown: OperationOutcome<unknown> = {
    kind: 'unknown',
    operation: { operationId: 'op-6', target: TARGET, backendRequestId: 'req-6' },
    reason: 'transport 故障',
  };
  await runOperation('op-6' as OperationId, 'run-create', recordingBackend([], unknown));

  const blocked = blockLane(store, {
    coordinationScopeId: SCOPE,
    operationId: 'op-6' as OperationId,
    writer,
    expectedRevision: revisionOf(),
    reason: '对账仍无法判定副作用是否发生',
  });
  expect(blocked.kind).toBe('settled');
  if (blocked.kind === 'settled') {
    expect(blocked.intent.state).toBe('blocked');
    expect(blocked.intent.blockingReason).not.toBeNull();
  }

  const newOnLane = beginIntent(store, {
    coordinationScopeId: SCOPE,
    operationId: 'op-7' as OperationId,
    target: TARGET,
    operationCategory: 'run-create',
    writer,
    expectedRevision: revisionOf(),
  });
  expect(newOnLane.kind).toBe('lane_blocked');

  const resolved = resolveLane(store, {
    coordinationScopeId: SCOPE,
    operationId: 'op-6' as OperationId,
    writer,
    expectedRevision: revisionOf(),
    outcomeClass: 'rejected',
    backendRequestId: 'req-6',
  });
  expect(resolved.kind).toBe('settled');
  if (resolved.kind === 'settled') {
    expect(resolved.intent.state).toBe('settled');
    expect(resolved.intent.outcomeClass).toBe('rejected');
    expect(resolved.intent.blockingReason).toBeNull();
  }

  const afterResolve = beginIntent(store, {
    coordinationScopeId: SCOPE,
    operationId: 'op-8' as OperationId,
    target: TARGET,
    operationCategory: 'run-create',
    writer,
    expectedRevision: revisionOf(),
  });
  expect(afterResolve.kind).toBe('registered');
});
