/**
 * 受控 Git 集成用例测试
 * （change: `m1-execute-and-validate-work-packages`，Owner: IP-B5）。
 *
 * 覆盖 Requirement「集成以 Validator 接受的结果为前提」与「集成操作限制在授权范围内」的运行时部分：
 * 未验证结果零副作用、越界请求被拒绝、授权内的普通集成按固定顺序执行并核验 expected HEAD。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { openCoordinationStore, type CoordinationStore } from '../../src/adapters/storage/coordination-store.js';
import { acquireRuntimeLease } from '../../src/application/coordination/lease-service.js';
import { beginIntent } from '../../src/application/coordination/intent-service.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  OperationId,
  PlanningCycleId,
  RuntimeIncarnationId,
  WorkPackageId,
} from '../../src/application/dto/identity.js';
import {
  integrateWorkPackage,
  type GitIntegrationPort,
  type GitStepOutcome,
  type GitStepRequest,
  type IntegrateWorkPackageInput,
} from '../../src/application/integrate-work-package.js';
import { initializeCoordinationScope } from '../../src/application/planning/initialize-scope.js';
import type { CoordinationWriter } from '../../src/application/ports/branch-coordination-store.js';
import type { ExecutionScope } from '../../src/application/ports/execution-backend.js';
import type { GitIntegrationPolicy, RoleAuthorities } from '../../src/domain/planning/execution-authorization.js';
import {
  initialWorkPackageStatus,
  withValidationStatus,
  type WorkPackageStatus,
} from '../../src/domain/work-package-status.js';

const SCOPE = 'scope-1' as CoordinationScopeId;
const SESSION_A = 'session-a' as CoordinatorSessionId;
const CYCLE = 'cycle-1' as PlanningCycleId;
const WP = 'wp-1' as WorkPackageId;

const AUTHORITY: RoleAuthorities = {
  planner: true,
  implementation: true,
  validator: true,
  finalizer: true,
  gitIntegration: true,
  dependencyChanges: false,
};

const POLICY: GitIntegrationPolicy = {
  canonicalBranch: 'main',
  remotes: ['origin'],
  refs: ['refs/heads/main'],
  allowForcePush: false,
};

const BASELINE = 'aaaa00000000000000000000000000000000000000';
const COMMIT_HEAD = 'bbbb00000000000000000000000000000000000000';
const INTEGRATED_HEAD = 'cccc00000000000000000000000000000000000000';

let directory = '';
let store: CoordinationStore;
let writer: CoordinationWriter;

const clock = (): number => 1_000;

/** 记录型 fake Git 端口：按步骤推进 HEAD，并可按步骤注入拒绝或 unknown。 */
function fakePort(script: {
  readonly mutating?: (step: GitStepRequest) => 'rejected' | 'unknown' | undefined;
  readonly headFor?: (step: GitStepRequest) => string;
  /** 回读值可以与步骤报告不同，用来模拟「回读与报告不一致」。 */
  readonly readHead?: string;
  readonly readUnavailable?: boolean;
  readonly reconcileAs?: (step: GitStepRequest) => GitStepOutcome;
} = {}): {
  readonly port: GitIntegrationPort;
  readonly requests: readonly GitStepRequest[];
  readonly scopes: readonly ExecutionScope[];
  readonly heads: readonly string[];
} {
  const requests: GitStepRequest[] = [];
  const scopes: ExecutionScope[] = [];
  const unknown = (request: GitStepRequest): GitStepOutcome => ({
    kind: 'unknown',
    reason: `无法对账 ${request.step}`,
  });
  const heads: string[] = [];
  let head = BASELINE;
  const port: GitIntegrationPort = {
    run: (request, scope) => {
      requests.push(request);
      scopes.push(scope);
      const injected = script.mutating?.(request);
      if (injected === 'rejected') {
        return Promise.resolve({ kind: 'rejected', code: 'git_rejected', message: '被拒绝' });
      }
      if (injected === 'unknown') {
        return Promise.resolve({ kind: 'unknown', reason: 'transport' });
      }
      head = script.headFor?.(request) ?? (request.step === 'commit' ? COMMIT_HEAD : INTEGRATED_HEAD);
      if (request.step === 'push') {
        return Promise.resolve({ kind: 'pushed', remote: request.remote ?? 'origin', ref: request.ref ?? 'refs/heads/main', head });
      }
      return Promise.resolve(
        request.step === 'commit' ? { kind: 'committed', head } : { kind: 'integrated', head },
      );
    },
    reconcile: (request, scope) => {
      scopes.push(scope);
      const result = script.reconcileAs?.(request) ?? unknown(request);
      if (result.kind === 'committed' || result.kind === 'integrated' || result.kind === 'pushed') {
        head = result.head;
      }
      return Promise.resolve(result);
    },
    readCanonicalHead: () => {
      if (script.readUnavailable === true) {
        return Promise.resolve({ kind: 'unavailable', reason: 'git unavailable' });
      }
      const observed = script.readHead ?? head;
      heads.push(observed);
      return Promise.resolve({ kind: 'read', head: observed });
    },
  };
  return { port, requests, scopes, heads };
}

function validatedStatus(): WorkPackageStatus {
  return withValidationStatus(initialWorkPackageStatus(WP), {
    kind: 'validated',
    validationAttemptId: 'validation-1',
    acceptedResultRef: 'orca-task-1#abc',
  });
}

function revision(): number {
  const scope = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
  if (scope.kind !== 'scope' || scope.scope === null) {
    throw new Error('Scope 不存在');
  }
  return scope.scope.revision;
}

function input(port: GitIntegrationPort, overrides: Partial<IntegrateWorkPackageInput> = {}): IntegrateWorkPackageInput {
  return {
    port,
    store,
    coordinationScopeId: SCOPE,
    writer,
    expectedRevision: revision(),
    backendIdentityRef: 'identity-ref',
    graphGeneration: 1,
    authorizationId: 'auth-1',
    runId: 'run-1',
    consumerGeneration: 1,
    timeoutMs: 5_000,
    workPackageId: WP,
    status: validatedStatus(),
    executionLeaseHeldByCurrentSession: true,
    authority: AUTHORITY,
    policy: POLICY,
    request: { kind: 'integrate_canonical', remote: 'origin', ref: 'refs/heads/main', branch: 'main' },
    baselineHead: BASELINE,
    commitMessage: 'feat: wp-1',
    operationIds: {
      commit: 'op-commit' as OperationId,
      integrate: 'op-integrate' as OperationId,
      push: 'op-push' as OperationId,
    },
    ...overrides,
  };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-integrate-'));
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

test('仅完成实现但尚未通过验证时不执行任何 Git 操作', async () => {
  const { port, requests } = fakePort();
  const status = initialWorkPackageStatus(WP);

  const result = await integrateWorkPackage(input(port, { status }));

  expect(result).toMatchObject({ kind: 'rejected', failure: { code: 'validation_not_accepted' } });
  expect(requests).toHaveLength(0);
});

test('非 Execution Lease 持有者不能集成', async () => {
  const { port, requests } = fakePort();

  const result = await integrateWorkPackage(input(port, { executionLeaseHeldByCurrentSession: false }));

  expect(result).toMatchObject({ kind: 'rejected', failure: { code: 'lease_not_held' } });
  expect(requests).toHaveLength(0);
});

test('越界的 remote 请求被拒绝且不产生副作用', async () => {
  const { port, requests } = fakePort();

  const result = await integrateWorkPackage(
    input(port, { request: { kind: 'integrate_canonical', remote: 'upstream', ref: 'refs/heads/main', branch: 'main' } }),
  );

  expect(result).toMatchObject({ kind: 'rejected', failure: { code: 'remote_not_approved' } });
  expect(requests).toHaveLength(0);
});

test('force-push 请求在用例入口被拒绝且不产生副作用', async () => {
  const { port, requests } = fakePort();

  const result = await integrateWorkPackage(
    input(port, { request: { kind: 'force_push', remote: 'origin', ref: 'refs/heads/main', branch: 'main' } }),
  );

  expect(result).toMatchObject({ kind: 'rejected', failure: { code: 'force_push_not_permitted' } });
  expect(requests).toHaveLength(0);
});

test('授权内的普通集成按固定顺序执行并核验 expected HEAD', async () => {
  const { port, requests, scopes, heads } = fakePort();

  const result = await integrateWorkPackage(input(port));

  expect(result).toEqual({ kind: 'integrated', head: INTEGRATED_HEAD, steps: ['commit', 'integrate_canonical', 'push'] });
  expect(requests.map((request) => request.step)).toEqual(['commit', 'integrate_canonical', 'push']);
  expect(requests.map((request) => request.expectedHead)).toEqual([BASELINE, COMMIT_HEAD, INTEGRATED_HEAD]);
  expect(requests[0]?.commitMessage).toBe('feat: wp-1');
  expect(requests[1]?.commitMessage).toBeNull();
  expect(heads).toEqual([COMMIT_HEAD, INTEGRATED_HEAD, INTEGRATED_HEAD]);
  expect(scopes.map((scope) => scope.operationId)).toEqual(['op-commit', 'op-integrate', 'op-push']);
  expect(scopes.every((scope) => scope.target.kind === 'work-package' && scope.target.id === WP)).toBe(true);
  const intents = store.query({ kind: 'intents', coordinationScopeId: SCOPE });
  expect(intents.kind === 'intents' ? intents.intents.map((intent) => intent.expectedHead) : []).toEqual([
    BASELINE,
    COMMIT_HEAD,
    INTEGRATED_HEAD,
  ]);
});

test('步骤结果为 unknown 时以原 OperationId 对账并阻塞后续步骤', async () => {
  const { port, requests, scopes } = fakePort({
    mutating: (request) => (request.step === 'integrate_canonical' ? 'unknown' : undefined),
  });

  const result = await integrateWorkPackage(input(port));

  expect(result).toMatchObject({ kind: 'unknown', operationId: 'op-integrate' });
  expect(requests.map((request) => request.step)).toEqual(['commit', 'integrate_canonical']);
  expect(scopes.slice(-2).map((scope) => scope.operationId)).toEqual(['op-integrate', 'op-integrate']);

  // 阻塞的 lane 不会被后续集成绕过。
  const blocked = await integrateWorkPackage(input(port, { operationIds: {
    commit: 'op-commit-2' as OperationId,
    integrate: 'op-integrate-2' as OperationId,
    push: 'op-push-2' as OperationId,
  } }));
  expect(blocked).toMatchObject({ kind: 'blocked' });
});

test('unknown 经同一 OperationId 对账为确定结果后继续', async () => {
  const { port, scopes } = fakePort({
    mutating: (request) => (request.step === 'integrate_canonical' ? 'unknown' : undefined),
    reconcileAs: (request) =>
      request.step === 'integrate_canonical'
        ? { kind: 'integrated', head: INTEGRATED_HEAD }
        : { kind: 'unknown', reason: 'unexpected' },
  });

  const result = await integrateWorkPackage(input(port));

  expect(result.kind).toBe('integrated');
  expect(scopes.filter((scope) => scope.operationId === 'op-integrate')).toHaveLength(2);
});

test('回读 HEAD 与步骤报告不一致时判定为无法归属并阻塞', async () => {
  const { port } = fakePort({ readHead: BASELINE });

  const result = await integrateWorkPackage(input(port));

  expect(result).toMatchObject({ kind: 'blocked' });
  if (result.kind !== 'blocked') {
    return;
  }
  expect(result.reason).toContain('回读 HEAD');
});

test('回读 HEAD 不可用时不完成 intent', async () => {
  const { port, requests } = fakePort({ readUnavailable: true });

  const result = await integrateWorkPackage(input(port));

  expect(result).toMatchObject({ kind: 'blocked' });
  expect(requests.map((request) => request.step)).toEqual(['commit']);
});

test('相同 OperationId 已结算时不重复执行 Git 副作用', async () => {
  const first = fakePort();
  expect((await integrateWorkPackage(input(first.port))).kind).toBe('integrated');

  const replay = fakePort();
  const result = await integrateWorkPackage(input(replay.port));

  expect(result.kind).toBe('integrated');
  expect(replay.requests).toHaveLength(0);
});

test('相同 OperationId 仍为 pending 时不重复执行 Git 副作用', async () => {
  const { port, requests } = fakePort();
  const begun = beginIntent(store, {
    coordinationScopeId: SCOPE,
    operationId: 'op-commit' as OperationId,
    target: { kind: 'work-package', id: WP },
    operationCategory: 'git-integration',
    expectedHead: BASELINE,
    writer,
    expectedRevision: revision(),
  });
  expect(begun.kind).toBe('registered');

  const result = await integrateWorkPackage(input(port));

  expect(result).toMatchObject({ kind: 'blocked' });
  expect(requests).toHaveLength(0);
});
