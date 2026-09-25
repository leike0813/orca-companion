/**
 * Dispatch Candidate 物化用例测试
 * （change: `m1-admit-work-package-specifications`，Owner: IP-A2）。
 *
 * 覆盖 Requirement「Dispatch Candidate 物化恰好一个角色级 Orca Task」的运行时部分：
 * - 选中候选时先建立并核验 worktree，再物化 Task；
 * - 既有 worktree 被复用而不是重复建立；
 * - 前置条件不满足（授权失效、预算耗尽、图未授权）时不产生任何 mutation；
 * - 物化结果 unknown 时以原 OperationId 对账，且不创建第二个 Task。
 *
 * 全部通过 fake `ExecutionBackend` 验证：这些路径本就是故障与拒绝路径，不需要真实 Orca。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { openCoordinationStore, type CoordinationStore } from '../../src/adapters/storage/coordination-store.js';
import { acquireRuntimeLease } from '../../src/application/coordination/lease-service.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  OperationId,
  PlanningCycleId,
  RuntimeIncarnationId,
  WorkPackageId,
} from '../../src/application/dto/identity.js';
import type { ExecutionQueryResult, OperationOutcome } from '../../src/application/dto/operation-outcome.js';
import {
  materializeWorkPackage,
  workPackageComment,
  worktreeNameFor,
  type MaterializeWorkPackageContext,
} from '../../src/application/materialize-work-package.js';
import type {
  BranchCoordinationStore,
  CoordinationWriter,
} from '../../src/application/ports/branch-coordination-store.js';
import type {
  ExecutionBackend,
  ExecutionMutation,
  ExecutionOperation,
  ExecutionQuery,
  ExecutionScope,
  WorktreeSummary,
} from '../../src/application/ports/execution-backend.js';
import type { WorkPackageBudgetField } from '../../src/domain/dispatch-candidate.js';
import { DEFAULT_EXECUTION_LIMITS, budgetFromLimits } from '../../src/domain/planning/budget-policy.js';
import type { RoleAuthorities } from '../../src/domain/planning/execution-authorization.js';
import { initializeCoordinationScope } from '../../src/application/planning/initialize-scope.js';
import { orcaDispatchIdFromReceipt, orcaTaskIdFromReceipt } from '../../src/application/ports/execution-backend.js';

const SCOPE = 'scope-1' as CoordinationScopeId;
const SESSION_A = 'session-a' as CoordinatorSessionId;
const CYCLE = 'cycle-1' as PlanningCycleId;
const WP = 'wp-1' as WorkPackageId;

test('Work Package 身份可作为 Orca worktree 的 Git 分支名', () => {
  const name = worktreeNameFor('scope#g1:readme' as WorkPackageId);
  expect(execFileSync('git', ['check-ref-format', '--branch', name], { encoding: 'utf8' }).trim()).toBe(name);
  expect(worktreeNameFor('scope#g1:other' as WorkPackageId)).not.toBe(name);
});

const AUTHORITIES: RoleAuthorities = {
  planner: true,
  implementation: true,
  validator: true,
  finalizer: true,
  gitIntegration: false,
  dependencyChanges: false,
};

let directory = '';
let store: CoordinationStore;
let writer: CoordinationWriter;

const clock = (): number => 1_000;

type Call =
  | { readonly kind: 'query'; readonly operation: ExecutionOperation }
  | { readonly kind: 'mutate'; readonly operation: ExecutionMutation; readonly scope: ExecutionScope };

/** 记录型 fake backend：默认成功，可按调用序号注入拒绝或 unknown。 */
function fakeBackend(script: {
  readonly worktrees?: readonly WorktreeSummary[];
  readonly createdWorktreeId?: string;
  readonly createdHead?: string;
  readonly mutating?: (
    call: number,
    mutation: ExecutionMutation,
    scope: ExecutionScope,
  ) => OperationOutcome<unknown> | undefined;
  readonly queryResult?: (call: number, query: ExecutionQuery) => ExecutionQueryResult | undefined;
}): { readonly backend: ExecutionBackend; readonly calls: readonly Call[] } {
  const calls: Call[] = [];
  let worktrees = [...(script.worktrees ?? [])];
  let mutations = 0;

  const backend: ExecutionBackend = {
    query: (input) => {
      calls.push({ kind: 'query', operation: input });
      const injected = script.queryResult?.(calls.length, input);
      if (injected !== undefined) {
        return Promise.resolve(injected);
      }
      if (input.operation === 'worktree-list') {
        return Promise.resolve({
          kind: 'accepted',
          value: {
            worktrees,
            totalCount: worktrees.length,
            truncated: false,
            hostScope: { hostIds: ['local'], omittedHostIds: [] },
          },
        });
      }
      return Promise.resolve({ kind: 'rejected', code: 'unregistered_fake_query', message: 'fake 未登记该查询' });
    },
    mutate: (input, scope) => {
      calls.push({ kind: 'mutate', operation: input, scope });
      mutations += 1;
      const injected = script.mutating?.(mutations, input, scope);
      if (injected !== undefined) {
        return Promise.resolve(injected);
      }
      if (input.operation === 'worktree-create') {
        const worktreeId = script.createdWorktreeId ?? 'wt-created-1';
        worktrees = [
          ...worktrees,
          {
            worktreeId,
            path: '/tmp/worktrees/wp-1',
            branch: 'refs/heads/wp-1',
            head: script.createdHead ?? 'abcdef0123456789abcdef0123456789abcdef01',
            displayName: worktreeNameFor(WP),
            comment: input.comment ?? null,
            isMainWorktree: false,
          },
        ];
        return Promise.resolve({
          kind: 'accepted',
          operation: { operationId: scope.operationId, target: scope.target },
          value: { worktreeId },
        });
      }
      if (input.operation === 'task-create') {
        return Promise.resolve({
          kind: 'accepted',
          operation: { operationId: scope.operationId, target: scope.target },
          value: { task: { id: 'orca-task-1', status: 'ready' }, spec: input.spec },
        });
      }
      if (input.operation === 'worker-start') {
        return Promise.resolve({
          kind: 'accepted',
          operation: { operationId: scope.operationId, target: scope.target },
          value: { runId: 'run-1', taskId: input.taskId, dispatchId: 'dispatch-1', state: 'ready' },
        });
      }
      return Promise.resolve({
        kind: 'accepted',
        operation: { operationId: scope.operationId, target: scope.target },
        value: null,
      });
    },
  };
  return { backend, calls };
}

function isolatedWorktree(): WorktreeSummary {
  return {
    worktreeId: 'wt-existing-1',
    path: '/tmp/worktrees/wp-1',
    branch: 'refs/heads/wp-1',
    head: 'abcdef0123456789abcdef0123456789abcdef01',
    displayName: worktreeNameFor(WP),
    comment: workPackageComment(WP),
    isMainWorktree: false,
  };
}

/** 把 Scope 推进到 execution_coordination 并持有 Execution Lease。 */
function enterExecution(): void {
  const scope = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
  if (scope.kind !== 'scope' || scope.scope === null) {
    throw new Error('Scope 不存在');
  }
  const acquired = store.transact({
    kind: 'acquire-execution-lease',
    coordinationScopeId: SCOPE,
    expectedRevision: scope.scope.revision,
    writer,
  });
  if (acquired.kind !== 'committed') {
    throw new Error(`无法取得 Execution Lease: ${acquired.message}`);
  }
  const transitioned = store.transact({
    kind: 'update-scope-mode',
    coordinationScopeId: SCOPE,
    expectedRevision: acquired.revision,
    writer,
    mode: 'execution_coordination',
    planningCycleId: CYCLE,
  });
  if (transitioned.kind !== 'committed') {
    throw new Error(`无法切换到 execution_coordination: ${transitioned.message}`);
  }
}

function revision(): number {
  const scope = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
  if (scope.kind !== 'scope' || scope.scope === null) {
    throw new Error('Scope 不存在');
  }
  return scope.scope.revision;
}

type MaterializeOverrides = {
  readonly authorizationValid?: boolean;
  readonly consumed?: readonly { readonly field: WorkPackageBudgetField; readonly consumed: number }[];
  readonly lifecycleStage?: 'pending' | 'frontier';
  readonly selectedCandidateId?: WorkPackageId | null;
  readonly dependenciesSatisfied?: readonly WorkPackageId[];
  readonly controlState?: string;
};

function context(
  operationSuffix = '1',
  workerLaunch: MaterializeWorkPackageContext['candidate']['workerLaunch'] = {
    kind: 'orca_managed',
    agent: 'codex',
    model: 'minimax-cn/MiniMax-M3',
  },
): MaterializeWorkPackageContext {
  return {
    candidate: {
      coordinationScopeId: SCOPE,
      writer,
      role: 'implementation',
      graphGeneration: 1,
      authorizationId: 'auth-1',
      runId: 'run-1',
      consumerGeneration: 1,
      backendIdentityRef: 'identity-ref',
      launchId: 'worker-launch-1',
      taskEnvelope: {
        schemaVersion: 1,
        workerTaskId: 'worker-task-1' as never,
        dispatchId: 'dispatch-candidate-1' as never,
        attemptId: 'attempt-1',
        role: 'implementation',
        taskContract: {
          schemaVersion: 1,
          workPackageId: WP,
          graphGeneration: 1,
          dependencies: [],
          scopeEnvelope: { include: ['src/domain'], exclude: [] },
          baselineHead: 'abcdef0123456789abcdef0123456789abcdef01',
          authority: AUTHORITIES,
          budget: budgetFromLimits(DEFAULT_EXECUTION_LIMITS),
          acceptanceEvidence: [{ evidenceKind: 'command', coveredPaths: ['src/domain'] }],
          resultSchemaVersion: 1,
        },
        instructions: [],
        specBinding: {
          provider: 'openspec',
          relativePath: 'openspec/changes/wp-1',
          contentDigest: 'digest-1',
          providerVersion: '1',
          contractRevision: 1,
          trackingRevision: 1,
        },
        workspace: {
          worktreeId: 'pending-worktree',
          canonicalWorktree: '/work/repo',
          relativePath: '.',
        },
        authority: AUTHORITIES,
        budget: { implementationAttempts: 2, validatorRepairs: 2, recoveries: 1 },
        expectedEvidence: [{ evidenceKind: 'command', coveredPaths: ['src/domain'] }],
      },
      workerLaunch,
      timeoutMs: 5_000,
    },
    paths: {
      repoSelector: 'path:/work/repo',
      canonicalWorktree: '/work/repo',
      baseBranch: 'main',
      baselineHead: 'abcdef0123456789abcdef0123456789abcdef01',
    },
    operationIds: {
      worktree: `op-worktree-${operationSuffix}` as OperationId,
      task: `op-task-${operationSuffix}` as OperationId,
      workerPrepare: `op-worker-prepare-${operationSuffix}` as OperationId,
      workerStart: `op-worker-${operationSuffix}` as OperationId,
      workerActivate: `op-worker-activate-${operationSuffix}` as OperationId,
    },
    workPackage: {
      scopeEnvelope: { include: ['src/domain'], exclude: [] },
      budget: budgetFromLimits(DEFAULT_EXECUTION_LIMITS),
    },
  };
}

function facts(overrides: MaterializeOverrides = {}) {
  return {
    candidateWorkPackageId: WP,
    candidateRole: 'implementation' as const,
    lifecycleStage: overrides.lifecycleStage ?? ('frontier' as const),
    selectedCandidateId: overrides.selectedCandidateId === undefined ? WP : overrides.selectedCandidateId,
    revisionPending: [],
    dependenciesSatisfied: overrides.dependenciesSatisfied ?? [WP],
    controlState: overrides.controlState ?? 'active',
    authorization: {
      valid: overrides.authorizationValid ?? true,
      authorizationId: overrides.authorizationValid === false ? null : 'auth-1',
      authorizationVersion: overrides.authorizationValid === false ? null : 1,
      reason: overrides.authorizationValid === false ? 'Graph Generation 尚无有效的 Execution Authorization' : null,
    },
    authority: AUTHORITIES,
    requiredBudgetField: 'implementationAttempts' as const,
    consumed: (overrides.consumed ?? []).map((entry) => ({
      workPackageId: WP,
      field: entry.field,
      consumed: entry.consumed,
    })),
  };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-materialize-'));
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
    fullBranchRef: 'refs/heads/main',
    canonicalWorktreePath: '/tmp/orca-test-worktree',
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
  enterExecution();
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test('选中候选时先建立并核验 worktree，再物化一个角色级 Task', async () => {
  const { backend, calls } = fakeBackend({ createdWorktreeId: 'wt-created-1' });
  const result = await materializeWorkPackage({
    store,
    backend,
    coordinationScopeId: SCOPE,
    workPackageId: WP,
    context: context(),
    facts: facts(),
    expectedRevision: revision(),
  });

  expect(result.kind).toBe('materialized');
  if (result.kind !== 'materialized') {
    return;
  }
  expect(result.worktree.worktreeId).toBe('wt-created-1');
  expect(result.orcaTaskId).toBe('orca-task-1');
  expect(result.worktreeReused).toBe(false);

  const mutations = calls.filter((call) => call.kind === 'mutate').map((call) => call.operation.operation);
  expect(mutations).toEqual(['worktree-create', 'task-create', 'worker-start']);

  // 建立 worktree 的 mutation 先于 Task 创建。
  const worktreeIndex = mutations.indexOf('worktree-create');
  const taskIndex = mutations.indexOf('task-create');
  expect(worktreeIndex).toBeLessThan(taskIndex);
  const taskCreate = calls.find(
    (call): call is Extract<Call, { kind: 'mutate' }> =>
      call.kind === 'mutate' && call.operation.operation === 'task-create',
  );
  expect(taskCreate?.operation.operation).toBe('task-create');
  if (taskCreate?.operation.operation === 'task-create') {
    const envelope = JSON.parse(taskCreate.operation.spec) as {
      readonly role: string;
      readonly workspace: { readonly worktreeId: string };
    };
    expect(envelope.role).toBe('implementation');
    expect(envelope.workspace.worktreeId).toBe('wt-created-1');
  }

  // 每个外部 mutation 携带自己的稳定 OperationId，且互不复用。
  const operationIds = calls
    .filter((call) => call.kind === 'mutate')
    .map((call) => (call.kind === 'mutate' ? call.scope.operationId : ''));
  expect(operationIds).toEqual(['op-worktree-1', 'op-task-1', 'op-worker-1']);
  expect(new Set(operationIds).size).toBe(3);
  const workerStart = calls.find(
    (call) => call.kind === 'mutate' && call.operation.operation === 'worker-start',
  );
  expect(workerStart?.kind === 'mutate' && workerStart.operation.operation === 'worker-start'
    ? workerStart.operation.taskId
    : null).toBe('orca-task-1');

  // Materialization Binding 可回读，且只保存最小索引。
  const binding = store.query({
    kind: 'materialization-bindings',
    coordinationScopeId: SCOPE,
    workPackageId: WP,
  });
  expect(binding.kind).toBe('materialization-bindings');
  if (binding.kind === 'materialization-bindings') {
    expect(binding.bindings[0]?.orcaTaskId).toBe('orca-task-1');
    expect(binding.bindings[0]?.creationOperationId).toBe('op-task-1');
  }
});

test('既有通过核验的 worktree 被复用，不重复建立', async () => {
  const { backend, calls } = fakeBackend({ worktrees: [isolatedWorktree()] });
  const result = await materializeWorkPackage({
    store,
    backend,
    coordinationScopeId: SCOPE,
    workPackageId: WP,
    context: context('2'),
    facts: facts(),
    expectedRevision: revision(),
  });

  expect(result.kind).toBe('materialized');
  if (result.kind !== 'materialized') {
    return;
  }
  expect(result.worktreeReused).toBe(true);
  const mutations = calls.filter((call) => call.kind === 'mutate').map((call) => call.operation.operation);
  expect(mutations).not.toContain('worktree-create');
  expect(mutations).toEqual(['task-create', 'worker-start']);
});

test('prepared-terminal 先准备隔离 harness，再把 exact terminal 交给 Orca 接管', async () => {
  let terminalCreated = false;
  const { backend, calls } = fakeBackend({
    worktrees: [isolatedWorktree()],
    mutating: (_call, mutation) => {
      if (mutation.operation === 'terminal-create') {
        terminalCreated = true;
      }
      return undefined;
    },
    queryResult: (_call, query) => {
      if (query.operation === 'terminal-list') {
        return {
          kind: 'accepted',
          value: {
            terminals: terminalCreated
              ? [{
                  handle: 'terminal-prepared-1',
                  connected: true,
                  writable: true,
                  orphaned: false,
                  executionHostId: 'local',
                  worktreeId: 'wt-existing-1',
                  branch: 'refs/heads/wp-1',
                  title: 'companion:prepared:1',
                }]
              : [],
            hostIds: ['local'],
            omittedHostIds: [],
            totalCount: terminalCreated ? 1 : 0,
            truncated: false,
          },
        };
      }
      if (query.operation === 'terminal-wait') {
        return { kind: 'accepted', value: { state: 'tui-idle' } };
      }
      if (query.operation === 'worker-show') {
        return {
          kind: 'accepted',
          value: { dispatchId: 'dispatch-1', exactWorker: true, agentTerminalHandle: 'terminal-prepared-1' },
        };
      }
      if (query.operation === 'terminal-read') {
        return { kind: 'accepted', value: { terminal: { draft: '[Pasted Content]' } } };
      }
      return undefined;
    },
  });

  const result = await materializeWorkPackage({
    store,
    backend,
    coordinationScopeId: SCOPE,
    workPackageId: WP,
    context: context('prepared', {
      kind: 'prepared_terminal',
      harness: 'codex',
      activation: 'submit_draft',
      title: 'companion:prepared:1',
      prepare: () => Promise.resolve({ title: 'companion:prepared:1', command: 'fixed-codex-launcher' }),
    }),
    facts: facts(),
    expectedRevision: revision(),
  });

  expect(result.kind).toBe('materialized');
  const mutations = calls.filter((call) => call.kind === 'mutate');
  expect(mutations.map((call) => call.operation.operation)).toEqual([
    'task-create',
    'terminal-create',
    'worker-start',
    'terminal-submit',
  ]);
  expect(mutations.map((call) => call.scope.operationId)).toEqual([
    'op-task-prepared',
    'op-worker-prepare-prepared',
    'op-worker-prepared',
    'op-worker-activate-prepared',
  ]);
  const started = mutations.find((call) => call.operation.operation === 'worker-start');
  expect(started?.operation).toMatchObject({
    operation: 'worker-start',
    terminal: 'terminal-prepared-1',
  });
});

test('worktree 列举未覆盖全部执行主机时拒绝物化', async () => {
  const { backend, calls } = fakeBackend({
    queryResult: (_call, query) =>
      query.operation === 'worktree-list'
        ? {
            kind: 'accepted',
            value: {
              worktrees: [],
              totalCount: 0,
              truncated: false,
              hostScope: { hostIds: ['local'], omittedHostIds: ['remote'] },
            },
          }
        : undefined,
  });
  const result = await materializeWorkPackage({
    store,
    backend,
    coordinationScopeId: SCOPE,
    workPackageId: WP,
    context: context('host-scope'),
    facts: facts(),
    expectedRevision: revision(),
  });

  expect(result.kind).toBe('rejected');
  if (result.kind === 'rejected') {
    expect(result.failure.code).toBe('worktree_scope_unverifiable');
  }
  expect(calls.filter((call) => call.kind === 'mutate')).toHaveLength(0);
});

test('未进入 Frontier 的 Work Package 不产生 worktree，也不产生任何 mutation', async () => {
  const { backend, calls } = fakeBackend({});
  const result = await materializeWorkPackage({
    store,
    backend,
    coordinationScopeId: SCOPE,
    workPackageId: WP,
    context: context('3'),
    facts: facts({ lifecycleStage: 'pending' }),
    expectedRevision: revision(),
  });

  expect(result.kind).toBe('rejected');
  expect(calls.filter((call) => call.kind === 'mutate')).toHaveLength(0);
  // 判定被拒绝时连 worktree 查询都不需要发生。
  expect(calls).toHaveLength(0);
});

test('未完成的独立基线补救阻止普通角色派发', async () => {
  const recorded = store.transact({
    kind: 'record-baseline-reconciliation',
    coordinationScopeId: SCOPE,
    expectedRevision: revision(),
    writer,
    reconciliationId: 'baseline-test',
    workPackageId: WP,
    requiredBaselineHead: 'head-2',
  });
  expect(recorded.kind).toBe('committed');
  const { backend, calls } = fakeBackend({});
  const result = await materializeWorkPackage({
    store,
    backend,
    coordinationScopeId: SCOPE,
    workPackageId: WP,
    context: context('baseline'),
    facts: facts({}),
    expectedRevision: revision(),
  });
  expect(result.kind === 'rejected' ? result.failure.code : null).toBe('baseline_reconciliation_pending');
  expect(calls).toHaveLength(0);
});

test('授权失效或预算耗尽时拒绝物化且零副作用', async () => {
  const unauthorized = fakeBackend({});
  const rejectedByAuth = await materializeWorkPackage({
    store,
    backend: unauthorized.backend,
    coordinationScopeId: SCOPE,
    workPackageId: WP,
    context: context('4'),
    facts: facts({ authorizationValid: false }),
    expectedRevision: revision(),
  });
  const exhausted = fakeBackend({});
  const rejectedByBudget = await materializeWorkPackage({
    store,
    backend: exhausted.backend,
    coordinationScopeId: SCOPE,
    workPackageId: WP,
    context: context('5'),
    facts: facts({ consumed: [{ field: 'implementationAttempts', consumed: 2 }] }),
    expectedRevision: revision(),
  });

  expect(rejectedByAuth.kind).toBe('rejected');
  expect(rejectedByBudget.kind).toBe('rejected');
  if (rejectedByAuth.kind === 'rejected') {
    expect(rejectedByAuth.failure.code).toBe('authorization_invalid');
  }
  if (rejectedByBudget.kind === 'rejected') {
    expect(rejectedByBudget.failure.code).toBe('budget_exhausted');
  }
  expect(unauthorized.calls).toHaveLength(0);
  expect(exhausted.calls).toHaveLength(0);
  // 零副作用：没有 worktree、没有 Task、没有 Materialization Binding。
  const bindings = store.query({ kind: 'materialization-bindings', coordinationScopeId: SCOPE });
  expect(bindings.kind === 'materialization-bindings' ? bindings.bindings : []).toHaveLength(0);
});

test('图未授权时不物化任何 Task，backend 未收到任何 mutation', async () => {
  const { backend, calls } = fakeBackend({});
  const result = await materializeWorkPackage({
    store,
    backend,
    coordinationScopeId: SCOPE,
    workPackageId: WP,
    context: context('6'),
    facts: facts({ authorizationValid: false }),
    expectedRevision: revision(),
  });

  expect(result.kind).toBe('rejected');
  expect(calls.filter((call) => call.kind === 'mutate')).toHaveLength(0);
});

test('物化结果未知时以原 OperationId 对账，且不创建第二个 Task', async () => {
  // 第一次 task-create 返回 unknown；对账查询返回 pending（不构成「未发生」的证明）。
  const unknownOperationId = 'op-task-7';
  const { backend, calls } = fakeBackend({
    createdWorktreeId: 'wt-created-7',
    mutating: (call, mutation) => {
      if (call === 2 && mutation.operation === 'task-create') {
        return {
          kind: 'unknown',
          operation: {
            operationId: unknownOperationId,
            backendRequestId: 'req-1',
            target: { kind: 'task', id: WP },
          },
          reason: 'process_timeout',
        };
      }
      return undefined;
    },
    queryResult: (_call, query) => {
      if (query.operation === 'request-show') {
        return { kind: 'accepted', value: { requestId: query.requestId, state: 'pending' } };
      }
      return undefined;
    },
  });

  const result = await materializeWorkPackage({
    store,
    backend,
    coordinationScopeId: SCOPE,
    workPackageId: WP,
    context: context('7'),
    facts: facts(),
    expectedRevision: revision(),
  });

  expect(result.kind).toBe('unknown');
  if (result.kind === 'unknown') {
    expect(result.operationId).toBe(unknownOperationId);
  }

  const taskCreates = calls.filter(
    (call) => call.kind === 'mutate' && call.operation.operation === 'task-create',
  );
  expect(taskCreates).toHaveLength(1);

  // 对账使用同一个 OperationId，而不是换一个新 ID 重放。
  const requestShows = calls.filter(
    (call) => call.kind === 'query' && call.operation.operation === 'request-show',
  );
  expect(requestShows.length).toBeGreaterThan(0);
  for (const call of requestShows) {
    expect(call.kind === 'query' && call.operation.operation === 'request-show' ? call.operation.requestId : null).toBe(
      'req-1',
    );
  }

  // lane 保持阻塞：同一 lane 上的下一次物化不会产生新的 Task。
  const blocked = fakeBackend({ worktrees: [isolatedWorktree()] });
  const retried = await materializeWorkPackage({
    store,
    backend: blocked.backend,
    coordinationScopeId: SCOPE,
    workPackageId: WP,
    context: context('8'),
    facts: facts(),
    expectedRevision: revision(),
  });
  expect(retried.kind === 'blocked' || retried.kind === 'rejected').toBe(true);
  expect(
    blocked.calls.filter((call) => call.kind === 'mutate' && call.operation.operation === 'task-create'),
  ).toHaveLength(0);
});

test('request-show 仅证明请求完成但没有资源结果时仍保持 lane 阻塞', async () => {
  const first = fakeBackend({
    worktrees: [isolatedWorktree()],
    mutating: (call, mutation) =>
      call === 1 && mutation.operation === 'task-create'
        ? {
            kind: 'unknown',
            operation: {
              operationId: 'op-task-completed',
              backendRequestId: 'req-completed',
              target: { kind: 'task', id: WP },
            },
            reason: 'response_lost',
          }
        : undefined,
    queryResult: (_call, query) =>
      query.operation === 'request-show'
        ? {
            kind: 'accepted',
            value: { requestId: query.requestId, state: 'completed', interpretation: 'request recorded' },
          }
        : undefined,
  });
  const result = await materializeWorkPackage({
    store,
    backend: first.backend,
    coordinationScopeId: SCOPE,
    workPackageId: WP,
    context: context('completed'),
    facts: facts(),
    expectedRevision: revision(),
  });
  expect(result.kind).toBe('unknown');

  const retry = fakeBackend({ worktrees: [isolatedWorktree()] });
  const retried = await materializeWorkPackage({
    store,
    backend: retry.backend,
    coordinationScopeId: SCOPE,
    workPackageId: WP,
    context: context('completed-retry'),
    facts: facts(),
    expectedRevision: revision(),
  });
  expect(retried.kind).toBe('blocked');
  expect(
    retry.calls.filter((call) => call.kind === 'mutate' && call.operation.operation === 'task-create'),
  ).toHaveLength(0);
});

test('Worker 启动失败后复用已绑定 Task，不创建第二个 Task', async () => {
  let rejectFirstStart = true;
  const execution = fakeBackend({
    worktrees: [isolatedWorktree()],
    mutating: (_call, mutation) => {
      if (mutation.operation === 'worker-start' && rejectFirstStart) {
        rejectFirstStart = false;
        return { kind: 'rejected', code: 'worker_start_rejected', message: 'worker 未启动' };
      }
      return undefined;
    },
  });
  const first = await materializeWorkPackage({
    store,
    backend: execution.backend,
    coordinationScopeId: SCOPE,
    workPackageId: WP,
    context: context('start-1'),
    facts: facts(),
    expectedRevision: revision(),
  });
  expect(first.kind).toBe('rejected');

  const second = await materializeWorkPackage({
    store,
    backend: execution.backend,
    coordinationScopeId: SCOPE,
    workPackageId: WP,
    context: context('start-2'),
    facts: facts(),
    expectedRevision: revision(),
  });
  expect(second.kind).toBe('materialized');
  expect(
    execution.calls.filter((call) => call.kind === 'mutate' && call.operation.operation === 'task-create'),
  ).toHaveLength(1);
});

test('worktree 建立回执缺身份时判为 unknown，不继续创建 Task', async () => {
  const { backend, calls } = fakeBackend({
    mutating: (call, mutation) => {
      if (call === 1 && mutation.operation === 'worktree-create') {
        return {
          kind: 'accepted',
          operation: { operationId: 'op-worktree-9', target: { kind: 'worktree', id: WP } },
          value: {},
        };
      }
      return undefined;
    },
  });

  const result = await materializeWorkPackage({
    store,
    backend,
    coordinationScopeId: SCOPE,
    workPackageId: WP,
    context: context('9'),
    facts: facts(),
    expectedRevision: revision(),
  });

  expect(result.kind).toBe('unknown');
  expect(
    calls.filter((call) => call.kind === 'mutate' && call.operation.operation === 'task-create'),
  ).toHaveLength(0);
});

test('新建 worktree 未绑定授权 baseline 时阻塞且不创建 Task', async () => {
  const { backend, calls } = fakeBackend({ createdHead: 'different-head' });
  const result = await materializeWorkPackage({
    store,
    backend,
    coordinationScopeId: SCOPE,
    workPackageId: WP,
    context: context('wrong-head'),
    facts: facts(),
    expectedRevision: revision(),
  });

  expect(result.kind).toBe('unknown');
  expect(
    calls.filter((call) => call.kind === 'mutate' && call.operation.operation === 'task-create'),
  ).toHaveLength(0);
});

test('Orca 记录的确定失败被透传为拒绝，且不产生绑定', async () => {
  const { backend } = fakeBackend({
    worktrees: [isolatedWorktree()],
    mutating: (call, mutation) =>
      mutation.operation === 'task-create' && call === 1
        ? {
            kind: 'accepted',
            operation: { operationId: 'op-task-10', target: { kind: 'task', id: WP } },
            value: { ok: false, code: 'task_not_startable', message: 'task 不可启动' },
          }
        : undefined,
  });

  const result = await materializeWorkPackage({
    store,
    backend,
    coordinationScopeId: SCOPE,
    workPackageId: WP,
    context: context('10'),
    facts: facts(),
    expectedRevision: revision(),
  });

  expect(result.kind).toBe('rejected');
  if (result.kind === 'rejected') {
    expect(result.failure.code).toBe('task_not_startable');
  }
  const bindings = store.query({ kind: 'materialization-bindings', coordinationScopeId: SCOPE });
  expect(bindings.kind === 'materialization-bindings' ? bindings.bindings : []).toHaveLength(0);
});

test('并发写入在「读 revision → 写」之间推进 revision 时，物化仍按最新 revision 完成', async () => {
  const { backend } = fakeBackend({ createdWorktreeId: 'wt-created-1' });
  // 精确模拟并发写入（Runtime Lease 心跳续租就是这么写的）：它在物化进行中推进一次 Scope revision。
  const racing: BranchCoordinationStore = {
    ...store,
    transact: (command) => {
      if (command.kind === 'settle-intent') {
        const current = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
        if (current.kind === 'scope' && current.scope !== null) {
          store.transact({
            kind: 'begin-intent',
            coordinationScopeId: SCOPE,
            expectedRevision: current.scope.revision,
            writer,
            operationId: 'op-concurrent-heartbeat' as OperationId,
            target: { kind: 'task', id: 'concurrent-heartbeat' },
            operationCategory: 'runtime-heartbeat',
          });
        }
      }
      return store.transact(command);
    },
  };

  const result = await materializeWorkPackage({
    store: racing,
    backend,
    coordinationScopeId: SCOPE,
    workPackageId: WP,
    context: context(),
    facts: facts(),
    expectedRevision: revision(),
  });

  // 外部副作用已经发生（Task 已建立）：并发的心跳写入不能把它变成永久阻塞。
  expect(result.kind).toBe('materialized');
  const intents = store.query({ kind: 'intents', coordinationScopeId: SCOPE });
  const taskIntent = intents.kind === 'intents'
    ? intents.intents.find((intent) => intent.operationCategory === 'materialize-task')
    : undefined;
  expect(taskIntent?.state).toBe('settled');
  expect(taskIntent?.outcomeClass).toBe('accepted');
  const bindings = store.query({ kind: 'materialization-bindings', coordinationScopeId: SCOPE });
  expect(bindings.kind === 'materialization-bindings' ? bindings.bindings : []).toHaveLength(1);
});

test('task-create / worker-start 回执身份只有一处解析：嵌套与平铺两种真实形态都认', () => {
  // 真实 Orca 把 Task 包在 `task` 下、Dispatch 包在 `dispatch` 下；只认平铺字段会让「创建成功但
  // 判定不可核验」，正是 Finalizer 派发在真实运行里卡住的原因。
  expect(orcaTaskIdFromReceipt({ task: { id: 'task-1' } })).toBe('task-1');
  expect(orcaDispatchIdFromReceipt({ dispatch: { id: 'dispatch-1' } })).toBe('dispatch-1');
  expect(orcaTaskIdFromReceipt({ taskId: 'task-2' })).toBe('task-2');
  expect(orcaTaskIdFromReceipt({ task_id: 'task-3' })).toBe('task-3');
  expect(orcaDispatchIdFromReceipt({ dispatch_id: 'dispatch-2' })).toBe('dispatch-2');
  // 缺失或形态不符一律不可核验，绝不猜。
  expect(orcaTaskIdFromReceipt({ task: { id: 42 } })).toBeNull();
  expect(orcaTaskIdFromReceipt(null)).toBeNull();
  expect(orcaDispatchIdFromReceipt({})).toBeNull();
});

test('worker-start 结果未知但 Orca 列举里已有该 Task 的 Worker：按事实收尾，不再阻塞 lane', async () => {
  const execution = fakeBackend({
    worktrees: [isolatedWorktree()],
    mutating: (_call, mutation, scope) =>
      mutation.operation === 'worker-start'
        ? {
            kind: 'unknown',
            operation: {
              // 真实 adapter 会回显请求的 OperationId；这里同样回显，只是没有 backendRequestId。
              operationId: scope.operationId,
              target: { kind: 'worker-task', id: WP },
            },
            reason: 'response_lost',
          }
        : undefined,
    queryResult: (_call, query) =>
      query.operation === 'worker-list'
        ? {
            kind: 'accepted',
            value: { workers: [{ dispatchId: 'ctx-observed-1', taskId: 'orca-task-1', workerState: 'running' }] },
          }
        : undefined,
  });

  const result = await materializeWorkPackage({
    store,
    backend: execution.backend,
    coordinationScopeId: SCOPE,
    workPackageId: WP,
    context: context('facts-observed'),
    facts: facts(),
    expectedRevision: revision(),
  });

  // 事实证明 worker-start 发生过：物化按成功路径继续，不再把 lane 阻塞在原地。
  expect(result.kind).toBe('materialized');
  const intents = store.query({ kind: 'intents', coordinationScopeId: SCOPE });
  const started = (intents.kind === 'intents' ? intents.intents : []).filter(
    (entry) => entry.operationCategory === 'materialize-worker-start',
  );
  expect(started.map((entry) => entry.state)).toEqual(['settled']);
  expect(started[0]?.outcomeClass).toBe('accepted');
});

test('worker-start 结果未知且 Orca 列举里没有该 Task：保持 lane 阻塞', async () => {
  const execution = fakeBackend({
    worktrees: [isolatedWorktree()],
    mutating: (_call, mutation, scope) =>
      mutation.operation === 'worker-start'
        ? {
            kind: 'unknown',
            operation: {
              operationId: scope.operationId,
              target: { kind: 'worker-task', id: WP },
            },
            reason: 'response_lost',
          }
        : undefined,
    queryResult: (_call, query) =>
      query.operation === 'worker-list'
        ? { kind: 'accepted', value: { workers: [] } }
        : undefined,
  });

  const result = await materializeWorkPackage({
    store,
    backend: execution.backend,
    coordinationScopeId: SCOPE,
    workPackageId: WP,
    context: context('facts-absent'),
    facts: facts(),
    expectedRevision: revision(),
  });

  expect(result.kind).toBe('unknown');
});
