/**
 * Delivery 结算流水线测试
 * （change: `m1-execute-and-validate-work-packages`，Owner: IP-B2）。
 *
 * 覆盖 Requirement「Delivery 在权威结果与本地引用均持久化后才确认」的三个 Scenario：权威结果与
 * 本地引用落盘后确认、任一步未确定时不确认、重放已结算 Delivery 不重复记录结果。以及旧代际报告
 * 只补历史、不推进生命周期的边界。
 *
 * 全部通过 fake `ExecutionBackend` 验证：这些路径本就是故障与重放路径，不需要真实 Orca。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { openCoordinationStore, type CoordinationStore } from '../../src/adapters/storage/coordination-store.js';
import { acquireRuntimeLease } from '../../src/application/coordination/lease-service.js';
import { beginIntent } from '../../src/application/coordination/intent-service.js';
import { settleDelivery, type SettleDeliveryInput } from '../../src/application/delivery/process-delivery.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  DispatchId,
  OperationId,
  PlanningCycleId,
  RuntimeIncarnationId,
  WorkerTaskId,
} from '../../src/application/dto/identity.js';
import type { ExecutionQueryResult, OperationOutcome } from '../../src/application/dto/operation-outcome.js';
import { initializeCoordinationScope } from '../../src/application/planning/initialize-scope.js';
import type { CoordinationWriter } from '../../src/application/ports/branch-coordination-store.js';
import type {
  ExecutionBackend,
  ExecutionMutation,
  ExecutionOperation,
  ExecutionQuery,
  ExecutionScope,
} from '../../src/application/ports/execution-backend.js';
import type { RoleAuthorities } from '../../src/domain/planning/execution-authorization.js';
import type { SpecBinding } from '../../src/domain/task-contract.js';
import type {
  ClaimedResultAttribution,
  TrustedExecutionFacts,
} from '../../src/domain/worker-result-verification.js';

const SCOPE = 'scope-1' as CoordinationScopeId;
const SESSION_A = 'session-a' as CoordinatorSessionId;
const CYCLE = 'cycle-1' as PlanningCycleId;
const TASK = 'worker-task-1' as WorkerTaskId;
const DISPATCH = 'dispatch-1' as DispatchId;

const AUTHORITY: RoleAuthorities = {
  planner: true,
  implementation: true,
  validator: true,
  finalizer: true,
  gitIntegration: false,
  dependencyChanges: false,
};

const SPEC: SpecBinding = {
  provider: 'openspec',
  relativePath: 'openspec/changes/c/specs/spec.md',
  contentDigest: 'digest-1',
  providerVersion: '0.4.0',
  contractRevision: 3,
  trackingRevision: 5,
};

const ACCEPTED_RESULT = { summary: '实现完成', evidence: [{ evidenceId: 'ev-1' }] };

const TRUSTED: TrustedExecutionFacts = {
  runId: 'run-1',
  consumerGeneration: 1,
  graphGeneration: 1,
  authorizationId: 'auth-1',
  workerTaskId: TASK,
  dispatchId: DISPATCH,
  attemptId: 'attempt-1',
  role: 'implementation',
  specBinding: SPEC,
  worktreeId: 'wt-1',
  authority: AUTHORITY,
  scopeEnvelope: { include: ['src'], exclude: [] },
  changedPaths: ['src/a.ts'],
};

const CLAIMED: ClaimedResultAttribution = {
  runId: 'run-1',
  consumerGeneration: 1,
  graphGeneration: 1,
  authorizationId: 'auth-1',
  workerTaskId: TASK,
  dispatchId: DISPATCH,
  attemptId: 'attempt-1',
  role: 'implementation',
  specBinding: SPEC,
  worktreeId: 'wt-1',
};

let directory = '';
let store: CoordinationStore;
let writer: CoordinationWriter;

const clock = (): number => 1_000;

type Call =
  | { readonly kind: 'query'; readonly operation: ExecutionOperation }
  | { readonly kind: 'mutate'; readonly operation: ExecutionMutation; readonly scope: ExecutionScope };

/** 记录型 fake backend：默认成功，可按调用注入拒绝、unknown 或自定义 task 回读。 */
function fakeBackend(script: {
  readonly deliveryId?: string;
  readonly deliveryRunId?: string | null;
  readonly taskRows?: unknown;
  readonly mutating?: (call: number, mutation: ExecutionMutation) => OperationOutcome<unknown> | undefined;
}): { readonly backend: ExecutionBackend; readonly calls: readonly Call[] } {
  const calls: Call[] = [];
  let mutations = 0;
  const deliveryId = script.deliveryId ?? 'delivery-1';
  const deliveryRunId = script.deliveryRunId === undefined ? 'run-1' : script.deliveryRunId;

  const backend: ExecutionBackend = {
    query: (input: ExecutionQuery): Promise<ExecutionQueryResult> => {
      calls.push({ kind: 'query', operation: input });
      if (input.operation === 'delivery-read') {
        return Promise.resolve({
          kind: 'accepted',
          value: {
            delivery: { deliveryId, runId: deliveryRunId },
            messages: [],
            timedOut: false,
            cancelled: false,
          },
        });
      }
      if (input.operation === 'task-list') {
        const rows = script.taskRows ?? [
          { id: 'orca-task-1', status: 'completed', result: ACCEPTED_RESULT },
        ];
        return Promise.resolve({ kind: 'accepted', value: rows });
      }
      return Promise.resolve({ kind: 'rejected', code: 'unregistered_fake_query', message: 'fake 未登记该查询' });
    },
    mutate: (input: ExecutionMutation, scope: ExecutionScope): Promise<OperationOutcome<unknown>> => {
      calls.push({ kind: 'mutate', operation: input, scope });
      mutations += 1;
      const injected = script.mutating?.(mutations, input);
      if (injected !== undefined) {
        return Promise.resolve(injected);
      }
      return Promise.resolve({
        kind: 'accepted',
        operation: { operationId: scope.operationId, target: scope.target },
        value: input.operation === 'delivery-ack' ? { acknowledged: true } : { ok: true },
      });
    },
  };
  return { backend, calls };
}

function revision(): number {
  const scope = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
  if (scope.kind !== 'scope' || scope.scope === null) {
    throw new Error('Scope 不存在');
  }
  return scope.scope.revision;
}

function settlementInput(backend: ExecutionBackend, overrides: Partial<SettleDeliveryInput> = {}): SettleDeliveryInput {
  return {
    store,
    backend,
    coordinationScopeId: SCOPE,
    writer,
    expectedRevision: revision(),
    backendIdentityRef: 'identity-ref',
    graphGeneration: 1,
    authorizationId: 'auth-1',
    runId: 'run-1',
    consumerGeneration: 1,
    timeoutMs: 5_000,
    orcaTaskId: 'orca-task-1',
    delivery: {
      deliveryId: 'delivery-1',
      claimed: CLAIMED,
      acceptedResult: ACCEPTED_RESULT,
    },
    trusted: TRUSTED,
    operationIds: {
      acceptResult: 'op-accept' as OperationId,
      ack: 'op-ack' as OperationId,
    },
    ...overrides,
  };
}

function settlementRows(): readonly { readonly orcaResultRef: string }[] {
  const result = store.query({ kind: 'delivery-settlements', coordinationScopeId: SCOPE });
  if (result.kind !== 'delivery-settlements') {
    throw new Error('无法读取结算记录');
  }
  return result.settlements;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-delivery-'));
  const opened = openCoordinationStore({ databasePath: join(directory, 'coordination.sqlite'), clock });
  if (opened.kind !== 'opened') {
    throw new Error(opened.message);
  }
  store = opened.store;
  const initialized = initializeCoordinationScope({
    store,
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_A,
    coordinatorModelConfigurationRef: 'model-config-1',
    planningCycleId: CYCLE,
  });
  if (initialized.kind !== 'initialized') {
    throw new Error('无法创建测试 Scope');
  }
  const acquired = acquireRuntimeLease(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_A,
    runtimeIncarnationId: 'inc-a' as RuntimeIncarnationId,
    fencingGeneration: 0,
  });
  if (acquired.kind !== 'acquired') {
    throw new Error('无法取得 Runtime Lease');
  }
  writer = {
    coordinatorSessionId: SESSION_A,
    runtimeIncarnationId: 'inc-a' as RuntimeIncarnationId,
    fencingGeneration: acquired.lease.fencingGeneration,
  };
  const lease = store.transact({
    kind: 'acquire-execution-lease',
    coordinationScopeId: SCOPE,
    expectedRevision: revision(),
    writer,
  });
  if (lease.kind !== 'committed') {
    throw new Error(`无法取得 Execution Lease: ${lease.message}`);
  }
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test('权威结果与本地引用落盘后才确认，且本地不保存结果正文', async () => {
  const { backend, calls } = fakeBackend({});

  const result = await settleDelivery(settlementInput(backend));

  expect(result.kind).toBe('settled');
  expect(calls.map((call) => `${call.kind}:${call.operation.operation}`)).toEqual([
    'query:delivery-read',
    'mutate:task-update',
    'query:task-list',
    'mutate:delivery-ack',
  ]);
  const settlements = settlementRows();
  expect(settlements).toHaveLength(1);
  expect(settlements[0]?.orcaResultRef).toContain('orca-task-1#');
  // Accepted Worker Result 正文只归 Orca：本地记录里没有结果正文。
  expect(JSON.stringify(settlements[0])).not.toContain('实现完成');
});

test('回读不到权威结果时不确认 Delivery', async () => {
  const { backend, calls } = fakeBackend({ taskRows: [{ id: 'orca-task-1', status: 'completed' }] });

  const result = await settleDelivery(settlementInput(backend));

  expect(result.kind).toBe('blocked');
  expect(calls.some((call) => call.kind === 'mutate' && call.operation.operation === 'delivery-ack')).toBe(false);
  expect(settlementRows()).toHaveLength(0);
});

test('记录 Accepted Worker Result 的结果为 unknown 时不确认 Delivery', async () => {
  const { backend, calls } = fakeBackend({
    mutating: (call, mutation) =>
      call === 1 && mutation.operation === 'task-update'
        ? { kind: 'unknown', operation: { operationId: 'op-accept', target: { kind: 'task', id: 'orca-task-1' } }, reason: 'transport' }
        : undefined,
  });

  const result = await settleDelivery(settlementInput(backend));

  expect(result.kind).toBe('unknown');
  expect(calls.some((call) => call.kind === 'mutate' && call.operation.operation === 'delivery-ack')).toBe(false);
  expect(settlementRows()).toHaveLength(0);
});

test('重放已结算 Delivery 不重复记录结果', async () => {
  const first = fakeBackend({});
  expect((await settleDelivery(settlementInput(first.backend))).kind).toBe('settled');
  expect(settlementRows()).toHaveLength(1);

  // 新的一次读取是新的操作：沿用上一次的 OperationId 只会命中已有意图，不会重放外部调用。
  const replay = fakeBackend({});
  const result = await settleDelivery(
    settlementInput(replay.backend, {
      operationIds: { acceptResult: 'op-accept-2' as OperationId, ack: 'op-ack-2' as OperationId },
    }),
  );

  expect(result.kind).toBe('replayed');
  expect(settlementRows()).toHaveLength(1);
  expect(replay.calls.some((call) => call.kind === 'mutate' && call.operation.operation === 'task-update')).toBe(false);
  expect(replay.calls.some((call) => call.kind === 'mutate' && call.operation.operation === 'delivery-ack')).toBe(true);
});

test('沿用同一 OperationId 的恢复重放不再发起第二次外部调用', async () => {
  const first = fakeBackend({});
  expect((await settleDelivery(settlementInput(first.backend))).kind).toBe('settled');

  const replay = fakeBackend({});
  const result = await settleDelivery(settlementInput(replay.backend));

  expect(result.kind).toBe('replayed');
  expect(replay.calls.filter((call) => call.kind === 'mutate')).toHaveLength(0);
});

test('旧代际报告只补历史，不写入结果引用', async () => {
  const { backend, calls } = fakeBackend({});

  const result = await settleDelivery(
    settlementInput(backend, { delivery: { ...settlementInput(backend).delivery, claimed: { ...CLAIMED, runId: 'run-0' } } }),
  );

  expect(result.kind).toBe('history_only');
  expect(settlementRows()).toHaveLength(0);
  expect(calls.some((call) => call.kind === 'mutate' && call.operation.operation === 'delivery-ack')).toBe(true);
});

test('读取到的 Delivery 与待结算身份不一致时不确认也不写入', async () => {
  const { backend } = fakeBackend({ deliveryId: 'delivery-other' });

  const result = await settleDelivery(settlementInput(backend));

  expect(result).toMatchObject({ kind: 'rejected' });
  expect(settlementRows()).toHaveLength(0);
});

test('读取到的 Delivery 属于其它 Run 时不确认也不写入', async () => {
  const { backend, calls } = fakeBackend({ deliveryRunId: 'run-other' });

  const result = await settleDelivery(settlementInput(backend));

  expect(result).toMatchObject({ kind: 'rejected', failure: { code: 'delivery_run_mismatch' } });
  expect(calls.some((call) => call.kind === 'mutate')).toBe(false);
  expect(settlementRows()).toHaveLength(0);
});

test('相同 OperationId 仍为 pending 时不重复发起副作用', async () => {
  const { backend, calls } = fakeBackend({});
  const operationId = 'op-accept' as OperationId;
  const begun = beginIntent(store, {
    coordinationScopeId: SCOPE,
    operationId,
    target: { kind: 'task', id: 'orca-task-1' },
    operationCategory: 'task',
    writer,
    expectedRevision: revision(),
  });
  expect(begun.kind).toBe('registered');

  const result = await settleDelivery(settlementInput(backend));

  expect(result).toMatchObject({ kind: 'blocked' });
  expect(calls.some((call) => call.kind === 'mutate')).toBe(false);
});
