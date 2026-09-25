/**
 * IP-07：Orca `worker-stop` stop verdict 与 `WorkerStopPort` 生产实现的行为测试。
 *
 * 覆盖 change `m2-wire-execution-runtime` 的 Scenario「Cancel 停止结果不确定」的可观察语义：
 * 活跃 Worker 名单用 Orca 自己的 `--terminal-state active` 过滤；同一 Dispatch 的停止请求复用同一
 * OperationId；只有可核验的回执才推进为 stopped，`stop_unknown`、未知 mutation 结果与不可解析回执
 * 一律停在 unverifiable（或受理未决的 unconfirmed），并且不换 ID 重试。
 *
 * 后端全部是 fake：测试不启动真实 Orca runtime、不派发真实 Worker；store 用真实 sqlite 适配器，
 * 因为它承载的 intent 生命周期正是被测合同的一部分。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import type {
  ExecutionAuthority,
  ExecutionBackend,
  ExecutionMutation,
  ExecutionQuery,
  ExecutionScope,
} from '../../src/application/ports/execution-backend.js';
import type {
  ExecutionQueryResult,
  OperationOutcome,
} from '../../src/application/dto/operation-outcome.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  OperationId,
  PlanningCycleId,
  RuntimeIncarnationId,
} from '../../src/application/dto/identity.js';
import { openCoordinationStore, type CoordinationStore } from '../../src/adapters/storage/coordination-store.js';
import { beginIntent } from '../../src/application/coordination/intent-service.js';
import { acquireRuntimeLease } from '../../src/application/coordination/lease-service.js';
import { initializeCoordinationScope } from '../../src/application/planning/initialize-scope.js';
import type { CoordinationWriter } from '../../src/application/ports/branch-coordination-store.js';
import {
  createOrcaWorkerStopPort,
  parseWorkerStopReceipt,
  workerStopOutcomeOf,
  type WorkerStopReceipt,
} from '../../src/adapters/orca-cli/worker-stop.js';

const SCOPE = 'scope-worker-stop' as CoordinationScopeId;
const SESSION = 'session-a' as CoordinatorSessionId;
const INCARNATION = 'inc-a' as RuntimeIncarnationId;
const CYCLE = 'cycle-1' as PlanningCycleId;

const RUN_ID = 'run-1';
const DISPATCH = 'dispatch-1';
const OPERATION_ID = `worker-stop:${SCOPE}:${DISPATCH}` as OperationId;

type StopMutation = Extract<ExecutionMutation, { operation: 'worker-stop' }>;

function stubBackend(handlers: {
  readonly list?: (query: Extract<ExecutionQuery, { operation: 'worker-list' }>) => ExecutionQueryResult;
  readonly stop?: (scope: ExecutionScope) => OperationOutcome<unknown>;
  readonly requestShow?: (requestId: string) => ExecutionQueryResult;
}): {
  readonly backend: ExecutionBackend;
  readonly mutations: { readonly input: StopMutation; readonly scope: ExecutionScope }[];
  readonly queries: ExecutionQuery[];
} {
  const mutations: { readonly input: StopMutation; readonly scope: ExecutionScope }[] = [];
  const queries: ExecutionQuery[] = [];
  const backend: ExecutionBackend = {
    query: (input) => {
      queries.push(input);
      if (input.operation === 'worker-list') {
        return Promise.resolve(handlers.list?.(input) ?? { kind: 'accepted', value: { workers: [] } });
      }
      if (input.operation === 'request-show') {
        return Promise.resolve(
          handlers.requestShow?.(input.requestId) ?? { kind: 'rejected', code: 'unreachable', message: '无登记响应' },
        );
      }
      return Promise.resolve({ kind: 'rejected', code: 'invalid_input', message: `未登记的查询 ${input.operation}` });
    },
    mutate: (input, scope) => {
      if (input.operation !== 'worker-stop') {
        return Promise.resolve({ kind: 'rejected', code: 'invalid_input', message: `未登记的变更 ${input.operation}` });
      }
      mutations.push({ input, scope });
      return Promise.resolve(
        handlers.stop?.(scope) ?? {
          kind: 'accepted',
          operation: { operationId: scope.operationId, backendRequestId: 'req-stop-1', target: scope.target },
          value: {
            dispatchId: DISPATCH,
            state: 'stopped',
            alreadySettled: false,
            processAction: 'closed_agent_terminal',
          },
        },
      );
    },
  };
  return { backend, mutations, queries };
}

function acceptedStop(scope: ExecutionScope, value: unknown, backendRequestId = 'req-stop-1'): OperationOutcome<unknown> {
  return {
    kind: 'accepted',
    operation: { operationId: scope.operationId, backendRequestId, target: scope.target },
    value,
  };
}

let directory = '';
let store: CoordinationStore;
let writer: CoordinationWriter;
let now = 1_000;
let activeRunId: string | null = RUN_ID;
let authorityValue: ExecutionAuthority | null = {
  kind: 'execution_coordination',
  graphGeneration: 1,
  authorizationId: 'auth-1',
  runId: RUN_ID,
  consumerGeneration: 1,
};

const clock = (): number => now;

function scopeRevision(): number {
  const read = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
  if (read.kind !== 'scope' || read.scope === null) {
    throw new Error('Scope 不存在');
  }
  return read.scope.revision;
}

function intentOf(operationId: OperationId) {
  const read = store.query({ kind: 'intent', coordinationScopeId: SCOPE, operationId });
  if (read.kind !== 'intent') {
    throw new Error('意图查询被拒绝');
  }
  return read.intent;
}

function port(backend: ExecutionBackend) {
  return createOrcaWorkerStopPort({
    backend,
    coordinationScopeId: SCOPE,
    backendIdentityRef: 'identity-ref-1',
    timeoutMs: 5_000,
    activeRunId: () => activeRunId,
    authority: () => authorityValue,
    store,
    clock,
  });
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-worker-stop-'));
  now = 1_000;
  activeRunId = RUN_ID;
  authorityValue = {
    kind: 'execution_coordination',
    graphGeneration: 1,
    authorizationId: 'auth-1',
    runId: RUN_ID,
    consumerGeneration: 1,
  };
  const opened = openCoordinationStore({ databasePath: join(directory, 'coordination.sqlite'), clock });
  if (opened.kind !== 'opened') {
    throw new Error('无法打开测试 Coordination Store');
  }
  store = opened.store;
  const initialized = initializeCoordinationScope({
    store,
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION,
    coordinatorModelConfigurationRef: 'model-config-1',
    planningCycleId: CYCLE,
    fullBranchRef: 'refs/heads/main',
    canonicalWorktreePath: '/tmp/orca-worker-stop-worktree',
  });
  if (initialized.kind !== 'initialized') {
    throw new Error('无法创建测试 Scope');
  }
  const acquired = acquireRuntimeLease(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION,
    runtimeIncarnationId: INCARNATION,
    fencingGeneration: 0,
  });
  if (acquired.kind !== 'acquired') {
    throw new Error('无法取得 Runtime Lease');
  }
  writer = {
    coordinatorSessionId: SESSION,
    runtimeIncarnationId: INCARNATION,
    fencingGeneration: acquired.lease.fencingGeneration,
  };
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test('名单：无当前 Run 时按 unavailable 报告，不发查询', async () => {
  const stub = stubBackend({});
  activeRunId = null;

  const result = await port(stub.backend).listActiveDispatches({ coordinationScopeId: SCOPE });

  expect(result).toEqual({ kind: 'unavailable', reason: 'no-active-run' });
  expect(stub.queries).toEqual([]);
});

test('名单：用 Run 与 --terminal-state active 过滤，只取非空 dispatchId', async () => {
  const stub = stubBackend({
    list: () => ({
      kind: 'accepted',
      value: {
        workers: [
          { dispatchId: DISPATCH, taskId: 'task-1', runId: RUN_ID, workerState: 'ready', terminalState: 'active', agentTerminalHandle: null },
          { dispatchId: null, taskId: 'task-2', runId: RUN_ID, workerState: 'ready', terminalState: 'active', agentTerminalHandle: null },
          { dispatchId: 'dispatch-2', taskId: 'task-3', runId: RUN_ID, workerState: 'ready', terminalState: 'active', agentTerminalHandle: null },
        ],
      },
    }),
  });

  const result = await port(stub.backend).listActiveDispatches({ coordinationScopeId: SCOPE });

  expect(result).toEqual({ kind: 'listed', dispatchIds: [DISPATCH, 'dispatch-2'] });
  expect(stub.queries).toEqual([{ operation: 'worker-list', runId: RUN_ID, terminalState: 'active' }]);
});

test('名单：查询失败或载荷不完整一律 unavailable，不读作「没有 Worker」', async () => {
  const failing = stubBackend({
    list: () => ({ kind: 'rejected', code: 'runtime_unreachable', message: 'Orca runtime 不可达' }),
  });
  const malformed = stubBackend({ list: () => ({ kind: 'accepted', value: { workers: 'not-an-array' } }) });

  expect(await port(failing.backend).listActiveDispatches({ coordinationScopeId: SCOPE })).toEqual({
    kind: 'unavailable',
    reason: 'runtime_unreachable: Orca runtime 不可达',
  });
  const result = await port(malformed.backend).listActiveDispatches({ coordinationScopeId: SCOPE });
  expect(result.kind).toBe('unavailable');
});

test('新鲜停止：回执为已停止 state → stopped，scope 身份稳定，意图收尾为 accepted', async () => {
  const stub = stubBackend({});
  const stopPort = port(stub.backend);
  const revisionBefore = scopeRevision();

  const outcome = await stopPort.requestStop({ coordinationScopeId: SCOPE, writer, dispatchId: DISPATCH });

  expect(outcome).toBe('stopped');
  expect(stub.mutations).toHaveLength(1);
  const [call] = stub.mutations;
  expect(call?.input).toEqual({ operation: 'worker-stop', dispatchId: DISPATCH });
  expect(call?.scope).toMatchObject({
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION,
    runtimeIncarnationId: INCARNATION,
    backendIdentityRef: 'identity-ref-1',
    operationId: OPERATION_ID,
    target: { kind: 'worker-dispatch', id: DISPATCH },
    expectedRevision: revisionBefore,
    timeoutMs: 5_000,
    authority: authorityValue,
  });
  expect(intentOf(OPERATION_ID)).toMatchObject({
    state: 'settled',
    outcomeClass: 'accepted',
    backendRequestId: 'req-stop-1',
    target: { kind: 'worker-dispatch', id: DISPATCH },
    operationCategory: 'worker-stop',
    expectedRevision: revisionBefore,
  });

  // 同一 Dispatch 的重放复用同一 OperationId，并且不再发 mutation。
  expect(await stopPort.requestStop({ coordinationScopeId: SCOPE, writer, dispatchId: DISPATCH })).toBe('stopped');
  expect(stub.mutations).toHaveLength(1);
});

test('stop_unknown：报告 unverifiable，绝不读成 stopped', async () => {
  const stub = stubBackend({
    stop: (scope) =>
      acceptedStop(scope, {
        dispatchId: DISPATCH,
        state: 'stop_unknown',
        alreadySettled: false,
        processAction: 'unknown',
        lastError: 'The recorded worker process is unverifiable; no terminal was closed.',
      }),
  });
  const stopPort = port(stub.backend);

  expect(await stopPort.requestStop({ coordinationScopeId: SCOPE, writer, dispatchId: DISPATCH })).toBe('unverifiable');
  expect(intentOf(OPERATION_ID)).toMatchObject({ state: 'blocked' });

  // 重放原位：仍不是 stopped，也不会再发一次 mutation。
  expect(await stopPort.requestStop({ coordinationScopeId: SCOPE, writer, dispatchId: DISPATCH })).toBe('unconfirmed');
  expect(stub.mutations).toHaveLength(1);
});

test('mutation 结果未知：按原 ID 对账，仍不确定则 unverifiable 且 lane 阻塞、零重试', async () => {
  const stub = stubBackend({
    stop: (scope) => ({
      kind: 'unknown',
      operation: { operationId: scope.operationId, backendRequestId: 'req-stop-unknown', target: scope.target },
      reason: 'process_timeout',
    }),
    requestShow: (requestId) => ({ kind: 'accepted', value: { requestId, state: 'pending', interpretation: null } }),
  });

  const outcome = await port(stub.backend).requestStop({ coordinationScopeId: SCOPE, writer, dispatchId: DISPATCH });

  expect(outcome).toBe('unverifiable');
  expect(stub.mutations).toHaveLength(1);
  expect(stub.queries).toContainEqual({ operation: 'request-show', requestId: 'req-stop-unknown' });
  expect(intentOf(OPERATION_ID)).toMatchObject({
    state: 'blocked',
    backendRequestId: 'req-stop-unknown',
  });
});

test('lane 上已有未决意图：返回 unconfirmed，零 mutation', async () => {
  const seeding = beginIntent(store, {
    coordinationScopeId: SCOPE,
    operationId: 'worker-stop:seeded' as OperationId,
    target: { kind: 'worker-dispatch', id: DISPATCH },
    operationCategory: 'worker-stop',
    writer,
    expectedRevision: scopeRevision(),
  });
  expect(seeding.kind).toBe('registered');
  const stub = stubBackend({});

  const outcome = await port(stub.backend).requestStop({ coordinationScopeId: SCOPE, writer, dispatchId: DISPATCH });

  expect(outcome).toBe('unconfirmed');
  expect(stub.mutations).toEqual([]);
});

test('无法装配执行授权：不发 mutation，报告 unverifiable', async () => {
  const stub = stubBackend({});
  authorityValue = null;

  const outcome = await port(stub.backend).requestStop({ coordinationScopeId: SCOPE, writer, dispatchId: DISPATCH });

  expect(outcome).toBe('unverifiable');
  expect(stub.mutations).toEqual([]);
  expect(intentOf(OPERATION_ID)).toMatchObject({ state: 'pending' });
});

test('回执解析：缺字段与错类型 fail closed，processAction 可为 null', () => {
  const valid = {
    dispatchId: DISPATCH,
    state: 'stopped',
    alreadySettled: false,
    processAction: 'closed_agent_terminal',
  };

  expect(parseWorkerStopReceipt(valid)).toEqual({
    ok: true,
    value: { ...valid, processAction: 'closed_agent_terminal' },
  });
  expect(parseWorkerStopReceipt({ ...valid, processAction: null })).toEqual({
    ok: true,
    value: { ...valid, processAction: null },
  });
  expect(parseWorkerStopReceipt('stopped').ok).toBe(false);
  expect(parseWorkerStopReceipt({ state: 'stopped', alreadySettled: false }).ok).toBe(false);
  expect(parseWorkerStopReceipt({ ...valid, state: 42 }).ok).toBe(false);
  expect(parseWorkerStopReceipt({ ...valid, alreadySettled: 'false' }).ok).toBe(false);
  expect(parseWorkerStopReceipt({ ...valid, processAction: 7 }).ok).toBe(false);
});

test('三值映射：只把可核验的已停止 state 读成 stopped', () => {
  const receipt = (state: string, alreadySettled: boolean): WorkerStopReceipt => ({
    dispatchId: DISPATCH,
    state,
    alreadySettled,
    processAction: null,
  });

  expect(workerStopOutcomeOf(receipt('stopped', false))).toBe('stopped');
  expect(workerStopOutcomeOf(receipt('stopped', true))).toBe('stopped');
  expect(workerStopOutcomeOf(receipt('succeeded', true))).toBe('stopped');
  expect(workerStopOutcomeOf(receipt('succeeded', false))).toBe('unverifiable');
  expect(workerStopOutcomeOf(receipt('stop_unknown', false))).toBe('unverifiable');
  expect(workerStopOutcomeOf(receipt('abandoned', true))).toBe('unverifiable');
  expect(workerStopOutcomeOf(receipt('stopping', false))).toBe('unconfirmed');
  expect(workerStopOutcomeOf(receipt('ready', true))).toBe('unconfirmed');
  expect(workerStopOutcomeOf(receipt('completed', true))).toBe('unverifiable');
  expect(workerStopOutcomeOf(receipt('not-a-registered-state', false))).toBe('unverifiable');
});
