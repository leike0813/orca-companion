/**
 * 受控 Git 集成用例测试
 * （change: `m1-execute-and-validate-work-packages`，Owner: IP-B5）。
 *
 * 覆盖 Requirement「集成以 Validator 接受的结果为前提」与「集成操作限制在授权范围内」的运行时部分：
 * 未验证结果零副作用、越界请求被拒绝、授权内的普通集成按固定顺序执行并核验 expected HEAD。
 */

import { afterEach, beforeEach, expect, test } from 'vitest';

import type { CoordinationStore } from '../../src/adapters/storage/coordination-store.js';
import {
  createExecutionScopeHarness,
  executionWorkPackage,
  type ExecutionScopeHarness,
} from '../support/execution-harness.js';
import { beginIntent, settleIntent } from '../../src/application/coordination/intent-service.js';
import type {
  CoordinationScopeId,
  DispatchId,
  OperationId,
  ValidationAttemptId,
  WorkPackageId,
  WorkerTaskId,
} from '../../src/application/dto/identity.js';
import {
  integrateWorkPackage,
  type GitAncestryRead,
  type GitIntegrationPort,
  type GitReadbackTarget,
  type GitStepOutcome,
  type GitStepRequest,
  type IntegrateWorkPackageInput,
} from '../../src/application/integrate-work-package.js';
import type {
  IntegrationReconciliationContext,
  IntegrationReconciliationOutcome,
  IntegrationReconciliationRecord,
  IntegrationReconciliationRequest,
  IntegrationReconciliationStore,
} from '../../src/application/integration-reconciliation.js';
import { integrationReconciliationBudgetKey } from '../../src/domain/git-integration-policy.js';
import { integrationReconciliationId } from '../../src/application/integration-reconciliation.js';
import type { CoordinationWriter } from '../../src/application/ports/branch-coordination-store.js';
import type { ExecutionScope } from '../../src/application/ports/execution-backend.js';
import type { GitIntegrationPolicy, RoleAuthorities } from '../../src/domain/planning/execution-authorization.js';
import type { SessionBinding } from '../../src/domain/task-contract.js';
import {
  initialWorkPackageStatus,
  withValidationStatus,
  type WorkPackageStatus,
} from '../../src/domain/work-package-status.js';

const SCOPE = 'scope-1' as CoordinationScopeId;
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
const MERGED_HEAD = 'dddd00000000000000000000000000000000000000';
const MERGED_TREE = 'eeee00000000000000000000000000000000000000';

const SESSION_BINDING: SessionBinding = {
  harness: 'codex',
  role: 'validator',
  workerTaskId: 'task-1' as WorkerTaskId,
  dispatchId: 'dispatch-1' as DispatchId,
  attemptId: 'attempt-1',
  providerSessionId: 'provider-session-1',
  transcriptRef: '/tmp/validator-transcript.jsonl',
  observedAt: '2026-01-01T00:00:00.000Z',
};

let store: CoordinationStore;
let writer: CoordinationWriter;
let graphId = '';
let harness: ExecutionScopeHarness;

/** 记录型 fake Git 端口：按目标推进 HEAD，并可按步骤注入拒绝或 unknown。 */
function fakePort(script: {
  readonly mutating?: (step: GitStepRequest) => 'rejected' | 'unknown' | undefined;
  readonly headFor?: (step: GitStepRequest) => string;
  /** 各目标在用例开始时的 HEAD；重放用例用它表达「副作用已经发生」。 */
  readonly initialHeads?: {
    readonly source?: string;
    readonly canonical?: string;
    readonly remote?: string;
  };
  /** 回读值可以与步骤报告不同，用来模拟「回读与报告不一致」，按目标区分。 */
  readonly readHead?: (target: GitReadbackTarget) => string | undefined;
  readonly readUnavailable?: (target: GitReadbackTarget) => boolean;
  readonly reconcileAs?: (step: GitStepRequest) => GitStepOutcome;
  /** 祖先关系探针的返回值；默认 `yes`，使未装配复验的普通路径与旧行为一致。 */
  readonly ancestor?: GitAncestryRead;
  /** 按调用顺序消费的祖先关系结果；耗尽后回落到 `ancestor`。 */
  readonly ancestorQueue?: readonly GitAncestryRead[];
  /** merge_canonical 报告的冲突路径。 */
  readonly mergeConflicts?: readonly string[];
  /** 合并树的回读值；默认不可用（未装配复验时不会被调用）。 */
  readonly tree?: string;
} = {}): {
  readonly port: GitIntegrationPort;
  readonly requests: readonly GitStepRequest[];
  readonly scopes: readonly ExecutionScope[];
  readonly reads: readonly GitReadbackTarget[];
} {
  const requests: GitStepRequest[] = [];
  const scopes: ExecutionScope[] = [];
  const reads: GitReadbackTarget[] = [];
  const ancestorQueue = [...(script.ancestorQueue ?? [])];
  const unknown = (request: GitStepRequest): GitStepOutcome => ({
    kind: 'unknown',
    reason: `无法对账 ${request.step}`,
  });
  const heads: Record<'source' | 'canonical' | 'remote', string> = {
    source: script.initialHeads?.source ?? BASELINE,
    canonical: script.initialHeads?.canonical ?? BASELINE,
    remote: script.initialHeads?.remote ?? BASELINE,
  };
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
      const head =
        script.headFor?.(request) ??
        (request.step === 'commit' ? COMMIT_HEAD : request.step === 'merge_commit' ? MERGED_HEAD : INTEGRATED_HEAD);
      if (request.step === 'push') {
        heads.remote = head;
        return Promise.resolve({ kind: 'pushed', remote: request.remote ?? 'origin', ref: request.ref ?? 'refs/heads/main', head });
      }
      if (request.step === 'commit') {
        heads.source = head;
        return Promise.resolve({ kind: 'committed', head });
      }
      if (request.step === 'merge_canonical') {
        return Promise.resolve({ kind: 'merge_applied', conflicts: script.mergeConflicts ?? [] });
      }
      if (request.step === 'merge_commit') {
        heads.source = head;
        return Promise.resolve({ kind: 'committed', head });
      }
      heads.canonical = head;
      return Promise.resolve({ kind: 'integrated', head });
    },
    reconcile: (request, scope) => {
      scopes.push(scope);
      const result = script.reconcileAs?.(request) ?? unknown(request);
      if (result.kind === 'committed') heads.source = result.head;
      if (result.kind === 'integrated') heads.canonical = result.head;
      if (result.kind === 'pushed') heads.remote = result.head;
      return Promise.resolve(result);
    },
    readHead: (target) => {
      reads.push(target);
      if (script.readUnavailable?.(target) === true) {
        return Promise.resolve({ kind: 'unavailable', reason: 'git unavailable' });
      }
      const observed = script.readHead?.(target) ?? heads[target.kind];
      return Promise.resolve({ kind: 'read', head: observed });
    },
    isAncestor: () => Promise.resolve(ancestorQueue.shift() ?? script.ancestor ?? { kind: 'yes' }),
    readTree: () =>
      Promise.resolve(
        script.tree === undefined
          ? { kind: 'unavailable', reason: '未装配集成复验时的树回读' }
          : { kind: 'read', tree: script.tree },
      ),
  };
  return { port, requests, scopes, reads };
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
    graphId,
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
    request: { kind: 'integrate_canonical', remote: 'origin', ref: 'refs/heads/main', branch: 'main', sourceBranch: 'wp-1' },
    workspace: { canonicalWorktreePath: '/tmp/orca-canonical', workPackageWorktreePath: '/tmp/orca-wp-1' },
    baselineHead: BASELINE,
    commitMessage: 'feat: wp-1',
    reconciliation: null,
    operationIds: {
      commit: 'op-commit' as OperationId,
      integrate: 'op-integrate' as OperationId,
      push: 'op-push' as OperationId,
    },
    ...overrides,
  };
}

beforeEach(() => {
  // 真实执行协调态基座：模式、图引用、授权与 Execution Lease 同批生效，满足 runIntentStep 的
  // active Scope/当前图/当前包/持有核验。
  harness = createExecutionScopeHarness({ workPackages: [executionWorkPackage('wp-1')] });
  store = harness.store;
  writer = harness.writer;
  graphId = harness.graphId;
});

afterEach(() => {
  harness.close();
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
    input(port, { request: { kind: 'integrate_canonical', remote: 'upstream', ref: 'refs/heads/main', branch: 'main', sourceBranch: 'wp-1' } }),
  );

  expect(result).toMatchObject({ kind: 'rejected', failure: { code: 'remote_not_approved' } });
  expect(requests).toHaveLength(0);
});

test('force-push 请求在用例入口被拒绝且不产生副作用', async () => {
  const { port, requests } = fakePort();

  const result = await integrateWorkPackage(
    input(port, { request: { kind: 'force_push', remote: 'origin', ref: 'refs/heads/main', branch: 'main', sourceBranch: 'wp-1' } }),
  );

  expect(result).toMatchObject({ kind: 'rejected', failure: { code: 'force_push_not_permitted' } });
  expect(requests).toHaveLength(0);
});

test('授权内的普通集成按固定顺序执行，且每步只回读自己的目标 HEAD', async () => {
  const { port, requests, scopes, reads } = fakePort();

  const result = await integrateWorkPackage(input(port));

  expect(result).toEqual({ kind: 'integrated', head: INTEGRATED_HEAD, steps: ['commit', 'integrate_canonical', 'push'] });
  expect(requests.map((request) => request.step)).toEqual(['commit', 'integrate_canonical', 'push']);
  // 每步核验自己的目标：integrate 的基准是 canonical HEAD（提交前读到的那个），而不是 commit 步之后
  // 已经前移的 source HEAD——拿 source HEAD 去核验 canonical 会必然不符。
  expect(requests.map((request) => request.expectedHead)).toEqual([BASELINE, BASELINE, INTEGRATED_HEAD]);
  expect(requests.every((request) => request.sourceWorktreePath === '/tmp/orca-wp-1')).toBe(true);
  expect(requests[0]?.commitMessage).toBe('feat: wp-1');
  expect(requests[1]?.commitMessage).toBeNull();
  // 任何 mutation 之前先读到 canonical 的核验基准；随后三步分别回读 source、canonical、获批 remote/ref。
  expect(reads).toEqual([
    { kind: 'canonical' },
    { kind: 'source', worktreePath: '/tmp/orca-wp-1' },
    { kind: 'canonical' },
    { kind: 'remote', remote: 'origin', ref: 'refs/heads/main' },
  ]);
  expect(scopes.map((scope) => scope.operationId)).toEqual(['op-commit', 'op-integrate', 'op-push']);
  expect(scopes.every((scope) => scope.target.kind === 'work-package' && scope.target.id === WP)).toBe(true);
  const intents = store.query({ kind: 'intents', coordinationScopeId: SCOPE });
  expect(intents.kind === 'intents' ? intents.intents.map((intent) => intent.expectedHead) : []).toEqual([
    BASELINE,
    BASELINE,
    INTEGRATED_HEAD,
  ]);
  const snapshot = store.query({ kind: 'snapshot', coordinationScopeId: SCOPE });
  expect(snapshot.kind === 'snapshot'
    ? snapshot.snapshot.settledGitIntegrationIntents.map((intent) => intent.operationId)
    : []).toEqual(['op-commit', 'op-integrate', 'op-push']);
  expect(snapshot.kind === 'snapshot' ? snapshot.snapshot.unresolvedIntents : []).toEqual([]);
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

test('integrate 步回读 canonical HEAD 与步骤报告不一致时判定为无法归属并阻塞', async () => {
  const { port } = fakePort({ readHead: (target) => (target.kind === 'canonical' ? BASELINE : undefined) });

  const result = await integrateWorkPackage(input(port));

  expect(result).toMatchObject({ kind: 'blocked' });
  if (result.kind !== 'blocked') {
    return;
  }
  expect(result.reason).toContain('步骤 integrate_canonical 后回读 canonical HEAD');
});

test('push 步回读 remote ref 与步骤报告不一致时判定为无法归属并阻塞', async () => {
  const { port } = fakePort({ readHead: (target) => (target.kind === 'remote' ? BASELINE : undefined) });

  const result = await integrateWorkPackage(input(port));

  expect(result).toMatchObject({ kind: 'blocked' });
  if (result.kind !== 'blocked') {
    return;
  }
  expect(result.reason).toContain('步骤 push 后回读 remote origin refs/heads/main 的 HEAD');
});

test('回读 HEAD 不可用时不完成 intent', async () => {
  const { port, requests } = fakePort({ readUnavailable: (target) => target.kind === 'source' });

  const result = await integrateWorkPackage(input(port));

  expect(result).toMatchObject({ kind: 'blocked' });
  expect(result.kind === 'blocked' ? result.reason : '').toContain('无法回读 source HEAD');
  expect(requests.map((request) => request.step)).toEqual(['commit']);
});

test('push 未决后按原 OperationId 只读对账并收尾，不重复推送', async () => {
  const first = fakePort({ mutating: request => request.step === 'push' ? 'unknown' : undefined });
  expect((await integrateWorkPackage(input(first.port))).kind).toBe('unknown');
  const replay = fakePort({
    initialHeads: { source: COMMIT_HEAD, canonical: INTEGRATED_HEAD, remote: INTEGRATED_HEAD },
    reconcileAs: request => request.step === 'push'
      ? { kind: 'pushed', remote: 'origin', ref: 'refs/heads/main', head: INTEGRATED_HEAD }
      : { kind: 'unknown', reason: 'unexpected step' },
  });
  const result = await integrateWorkPackage(input(replay.port));
  expect(result.kind).toBe('integrated');
  expect(replay.requests).toHaveLength(0);
  expect(replay.scopes.map(scope => scope.operationId)).toEqual(['op-push']);
  const read = store.query({ kind: 'intent', coordinationScopeId: SCOPE, operationId: 'op-push' as OperationId });
  expect(read.kind === 'intent' ? read.intent : null).toMatchObject({ state: 'settled', outcomeClass: 'accepted' });
});

test('相同 OperationId 已结算时不重复执行 Git 副作用', async () => {
  const first = fakePort();
  expect((await integrateWorkPackage(input(first.port))).kind).toBe('integrated');

  const replay = fakePort({
    initialHeads: { source: COMMIT_HEAD, canonical: INTEGRATED_HEAD, remote: INTEGRATED_HEAD },
  });
  const result = await integrateWorkPackage(input(replay.port));

  expect(result).toEqual({ kind: 'integrated', head: INTEGRATED_HEAD, steps: ['commit', 'integrate_canonical', 'push'] });
  expect(replay.requests).toHaveLength(0);
  // 重放路径同样按目标读回（含 mutation 之前的 canonical 基准），而不是统一读 canonical。
  expect(replay.reads).toEqual([
    { kind: 'canonical' },
    { kind: 'source', worktreePath: '/tmp/orca-wp-1' },
    { kind: 'canonical' },
    { kind: 'remote', remote: 'origin', ref: 'refs/heads/main' },
  ]);
});

test('commit 已结算后重启，只回读原步骤并执行剩余的 merge 与 push', async () => {
  const operationId = 'op-commit' as OperationId;
  expect(beginIntent(store, {
    coordinationScopeId: SCOPE, operationId, target: { kind: 'work-package', id: WP },
    operationCategory: 'git-integration', expectedHead: BASELINE, writer, expectedRevision: revision(),
  }).kind).toBe('registered');
  expect(settleIntent(store, {
    coordinationScopeId: SCOPE, operationId, writer, expectedRevision: revision(),
    outcome: { kind: 'accepted', operation: { operationId, target: { kind: 'work-package', id: WP } },
      value: { kind: 'committed', head: COMMIT_HEAD } },
  }).kind).toBe('settled');

  const resumed = fakePort({ initialHeads: { source: COMMIT_HEAD } });
  const result = await integrateWorkPackage(input(resumed.port));

  expect(result.kind).toBe('integrated');
  expect(resumed.requests.map((request) => request.step)).toEqual(['integrate_canonical', 'push']);
  expect(resumed.scopes.map((scope) => scope.operationId)).toEqual(['op-integrate', 'op-push']);
  expect(resumed.reads).toContainEqual({ kind: 'source', worktreePath: '/tmp/orca-wp-1' });
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

  expect(result).toMatchObject({ kind: 'unknown', operationId: 'op-commit' });
  expect(requests).toHaveLength(0);
});

/** 记录型 fake 集成复验存储：与生产 port 同语义（稳定身份登记 + 额度上限 + CAS 结算）。 */
function fakeReconciliationStore(
  initial: readonly IntegrationReconciliationRecord[] = [],
  limit = 2,
): { readonly store: IntegrationReconciliationStore; readonly records: IntegrationReconciliationRecord[] } {
  const records: IntegrationReconciliationRecord[] = [...initial];
  let revision = 1;
  const store: IntegrationReconciliationStore = {
    register: (request) => {
      const existing = records.find((entry) => entry.reconciliationId === request.reconciliationId);
      if (existing !== undefined) {
        return { kind: 'existing', record: existing, revision };
      }
      if (records.length >= limit) {
        return { kind: 'rejected', code: 'budget_exhausted', message: '集成复验额度已耗尽' };
      }
      const record: IntegrationReconciliationRecord = {
        coordinationScopeId: request.coordinationScopeId,
        workPackageId: request.workPackageId,
        reconciliationId: request.reconciliationId,
        round: request.round,
        validationAttemptId: request.validationAttemptId,
        sourceAcceptedResultRef: request.sourceAcceptedResultRef,
        targetHead: request.targetHead,
        mergedTreeRef: null,
        orcaTaskId: null,
        dispatchId: null,
        state: 'pending',
        blockerRef: null,
        createdAt: 1,
        updatedAt: 1,
      };
      records.push(record);
      revision += 1;
      return { kind: 'registered', record, revision };
    },
    settle: (request) => {
      const index = records.findIndex((entry) => entry.reconciliationId === request.reconciliationId);
      const current = records[index];
      if (current === undefined) {
        return { kind: 'rejected', code: 'not_found', message: '轮次不存在' };
      }
      if (current.state !== 'pending') {
        return current.state === request.state
          ? { kind: 'settled', record: current }
          : { kind: 'rejected', code: 'invalid_state', message: '轮次已结算为 ' + current.state };
      }
      const updated: IntegrationReconciliationRecord = {
        ...current,
        state: request.state,
        mergedTreeRef: request.mergedTreeRef ?? null,
        orcaTaskId: request.orcaTaskId ?? null,
        dispatchId: request.dispatchId ?? null,
        blockerRef: request.blockerRef ?? null,
        updatedAt: current.updatedAt + 1,
      };
      records[index] = updated;
      revision += 1;
      return { kind: 'settled', record: updated };
    },
    bindContinuation: (request) => {
      const index = records.findIndex((entry) => entry.reconciliationId === request.reconciliationId);
      const current = records[index];
      if (current === undefined) {
        return { kind: 'rejected', code: 'not_found', message: '轮次不存在' };
      }
      const updated: IntegrationReconciliationRecord = {
        ...current,
        orcaTaskId: request.orcaTaskId,
        dispatchId: request.dispatchId,
        updatedAt: current.updatedAt + 1,
      };
      records[index] = updated;
      revision += 1;
      return { kind: 'bound', record: updated };
    },
    list: (_coordinationScopeId, workPackageId) => ({
      kind: 'records',
      records: records.filter((entry) => entry.workPackageId === workPackageId),
    }),
  };
  return { store, records };
}

function reconciliationContext(
  store: IntegrationReconciliationStore,
  runner: (request: IntegrationReconciliationRequest) => Promise<IntegrationReconciliationOutcome>,
  limit = 2,
): IntegrationReconciliationContext {
  return {
    store,
    runner,
    validationAttemptId: 'validation-1' as ValidationAttemptId,
    sourceAcceptedResultRef: 'orca-task-1#abc',
    sessionBinding: SESSION_BINDING,
    limit,
    budgetKey: integrationReconciliationBudgetKey(WP),
    approvedLimitRef: 'auth-1',
    // Context 回调在集成用例测试里用 no-op：accept/ack 的取舍由各轮次断言驱动，不在此处另建 Pipeline。
    acceptResult: () => Promise.resolve({ kind: 'accepted' }),
    acknowledgeResult: () => Promise.resolve({ kind: 'acknowledged' }),
  };
}

const validatedOutcome: IntegrationReconciliationOutcome = {
  kind: 'validated',
  evidence: [],
  sessionBinding: SESSION_BINDING,
  orcaTaskId: 'orca-task-reconcile-1',
  dispatchId: 'dispatch-reconcile-1' as DispatchId,
  treeRef: MERGED_TREE,
  filesModified: [],
  deliveryId: 'delivery-reconcile-1',
  deliveryRunId: 'run-1',
};

test('canonical 前移后合并、原 Validator 复验、普通提交，再 fast-forward 集成', async () => {
  const { port, requests } = fakePort({ ancestorQueue: [{ kind: 'no' }, { kind: 'yes' }], tree: MERGED_TREE });
  const { store: reconciliationStore, records } = fakeReconciliationStore();
  const runnerRequests: IntegrationReconciliationRequest[] = [];
  const runner = (request: IntegrationReconciliationRequest): Promise<IntegrationReconciliationOutcome> => {
    runnerRequests.push(request);
    return Promise.resolve(validatedOutcome);
  };

  const result = await integrateWorkPackage(
    input(port, { reconciliation: reconciliationContext(reconciliationStore, runner) }),
  );

  expect(result).toEqual({ kind: 'integrated', head: INTEGRATED_HEAD, steps: ['commit', 'integrate_canonical', 'push'] });
  expect(requests.map((request) => request.step)).toEqual([
    'commit',
    'merge_canonical',
    'merge_commit',
    'integrate_canonical',
    'push',
  ]);
  expect(runnerRequests).toHaveLength(1);
  expect(runnerRequests[0]?.targetHead).toBe(BASELINE);
  expect(runnerRequests[0]?.continuation.existingTaskId).toBeNull();
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    round: 1,
    state: 'validated',
    mergedTreeRef: MERGED_TREE,
    orcaTaskId: 'orca-task-reconcile-1',
    dispatchId: 'dispatch-reconcile-1',
    targetHead: BASELINE,
  });
});

test('集成复验额度耗尽时阻塞，不建立外部资源也不重置', async () => {
  const { port, requests } = fakePort({ ancestorQueue: [{ kind: 'no' }] });
  const { store: reconciliationStore, records } = fakeReconciliationStore([], 0);

  const result = await integrateWorkPackage(
    input(port, {
      reconciliation: reconciliationContext(reconciliationStore, () => Promise.resolve(validatedOutcome), 0),
    }),
  );

  expect(result).toMatchObject({ kind: 'blocked' });
  expect(requests.map((request) => request.step)).toEqual(['commit']);
  expect(records).toHaveLength(0);
});

test('复验 session 丢失时阻塞该轮，且不产生 merge commit', async () => {
  const { port, requests } = fakePort({ ancestorQueue: [{ kind: 'no' }] });
  const { store: reconciliationStore, records } = fakeReconciliationStore();

  const result = await integrateWorkPackage(
    input(port, {
      reconciliation: reconciliationContext(reconciliationStore, () =>
        Promise.resolve({ kind: 'session_lost', reason: 'provider session 不可核验' })),
    }),
  );

  expect(result).toMatchObject({ kind: 'blocked' });
  expect(requests.map((request) => request.step)).toEqual(['commit', 'merge_canonical']);
  expect(records[0]?.state).toBe('blocked');
});

test('Git 步骤 unknown 只阻塞不结算轮次，重启后按原 OperationId 对账续办', async () => {
  let reconciles = 0;
  const { port } = fakePort({
    // 第一次探针报「非祖先」后 unknown 阻塞；第二次先续办 pending 轮次，完成后探针报祖先即可终止。
    ancestorQueue: [{ kind: 'no' }, { kind: 'yes' }],
    tree: MERGED_TREE,
    mutating: (request) => (request.step === 'merge_canonical' ? 'unknown' : undefined),
    reconcileAs: (request) => {
      if (request.step !== 'merge_canonical') {
        return { kind: 'unknown', reason: '未预期的对账步骤' };
      }
      reconciles += 1;
      return reconciles >= 2 ? { kind: 'merge_applied', conflicts: [] } : { kind: 'unknown', reason: 'transport' };
    },
  });
  const { store: reconciliationStore, records } = fakeReconciliationStore();
  const runner = (): Promise<IntegrationReconciliationOutcome> => Promise.resolve(validatedOutcome);

  const first = await integrateWorkPackage(
    input(port, { reconciliation: reconciliationContext(reconciliationStore, runner) }),
  );
  expect(first).toMatchObject({ kind: 'unknown' });
  expect(records).toHaveLength(1);
  // unknown 不结算轮次：保持 pending，lane 阻塞可在下一次触发时对账。
  expect(records[0]?.state).toBe('pending');

  const second = await integrateWorkPackage(
    input(port, { reconciliation: reconciliationContext(reconciliationStore, runner) }),
  );
  expect(second.kind).toBe('integrated');
  expect(records).toHaveLength(1);
  expect(records[0]?.state).toBe('validated');
});

test('未完成的复验轮次重启后沿用原 round，不重复消耗额度或新建轮次', async () => {
  // pending 轮次先被续办，之后探针报祖先即终止，不新建第二轮。
  const { port } = fakePort({ ancestorQueue: [{ kind: 'yes' }], tree: MERGED_TREE });
  const pending: IntegrationReconciliationRecord = {
    coordinationScopeId: SCOPE,
    workPackageId: WP,
    reconciliationId: integrationReconciliationId({
      coordinationScopeId: SCOPE,
      graphId,
      graphGeneration: 1,
      workPackageId: WP,
      round: 1,
    }),
    round: 1,
    validationAttemptId: 'validation-1',
    sourceAcceptedResultRef: 'orca-task-1#abc',
    targetHead: BASELINE,
    mergedTreeRef: null,
    orcaTaskId: null,
    dispatchId: null,
    state: 'pending',
    blockerRef: null,
    createdAt: 1,
    updatedAt: 1,
  };
  const { store: reconciliationStore, records } = fakeReconciliationStore([pending]);
  const runnerRequests: IntegrationReconciliationRequest[] = [];

  const result = await integrateWorkPackage(
    input(port, {
      reconciliation: reconciliationContext(reconciliationStore, (request) => {
        runnerRequests.push(request);
        return Promise.resolve(validatedOutcome);
      }),
    }),
  );

  expect(result.kind).toBe('integrated');
  expect(records).toHaveLength(1);
  expect(records[0]?.round).toBe(1);
  expect(records[0]?.state).toBe('validated');
  expect(runnerRequests).toHaveLength(1);
});

test('pending 轮次固定原 targetHead 先结清，再以新额度轮次追新 canonical，不覆盖原载荷', async () => {
  const CANONICAL_AHEAD = 'ffff00000000000000000000000000000000000000';
  const { port, requests } = fakePort({
    ancestorQueue: [{ kind: 'no' }, { kind: 'yes' }],
    tree: MERGED_TREE,
    initialHeads: { canonical: CANONICAL_AHEAD },
  });
  const pending: IntegrationReconciliationRecord = {
    coordinationScopeId: SCOPE,
    workPackageId: WP,
    reconciliationId: integrationReconciliationId({
      coordinationScopeId: SCOPE,
      graphId,
      graphGeneration: 1,
      workPackageId: WP,
      round: 1,
    }),
    round: 1,
    validationAttemptId: 'validation-1',
    sourceAcceptedResultRef: 'orca-task-1#abc',
    // 原轮次目标固定在更早的 canonical；此时 canonical 已前移到 CANONICAL_AHEAD。
    targetHead: BASELINE,
    mergedTreeRef: null,
    orcaTaskId: null,
    dispatchId: null,
    state: 'pending',
    blockerRef: null,
    createdAt: 1,
    updatedAt: 1,
  };
  const { store: reconciliationStore, records } = fakeReconciliationStore([pending]);
  const runnerRequests: IntegrationReconciliationRequest[] = [];

  const result = await integrateWorkPackage(
    input(port, {
      reconciliation: reconciliationContext(reconciliationStore, (request) => {
        runnerRequests.push(request);
        return Promise.resolve(validatedOutcome);
      }),
    }),
  );

  expect(result.kind).toBe('integrated');
  expect(records).toHaveLength(2);
  // 第一轮沿原目标结清，绝不把当前 canonical 覆盖到原轮次上。
  expect(records[0]).toMatchObject({ round: 1, targetHead: BASELINE, state: 'validated' });
  // 第二轮才以新额度追当前 canonical。
  expect(records[1]).toMatchObject({ round: 2, targetHead: CANONICAL_AHEAD, state: 'validated' });
  expect(runnerRequests.map((request) => request.targetHead)).toEqual([BASELINE, CANONICAL_AHEAD]);
  // 两轮各自 merge_canonical + merge_commit，随后一次 integrate/push。
  expect(requests.map((request) => request.step)).toEqual([
    'commit',
    'merge_canonical',
    'merge_commit',
    'merge_canonical',
    'merge_commit',
    'integrate_canonical',
    'push',
  ]);
});

test('accept 未持久化时保持阻塞：不产生 merge commit 也不集成', async () => {
  const { port, requests } = fakePort({ ancestorQueue: [{ kind: 'no' }], tree: MERGED_TREE });
  const { store: reconciliationStore, records } = fakeReconciliationStore();
  const context: IntegrationReconciliationContext = {
    ...reconciliationContext(reconciliationStore, () => Promise.resolve(validatedOutcome)),
    acceptResult: () => Promise.resolve({ kind: 'blocked', reason: 'accept 未持久化' }),
  };

  const result = await integrateWorkPackage(input(port, { reconciliation: context }));

  expect(result).toMatchObject({ kind: 'blocked' });
  // accept 先于 merge_commit：失败即停在原地，不提交、不集成。
  expect(requests.map((request) => request.step)).toEqual(['commit', 'merge_canonical']);
  expect(records[0]?.state).not.toBe('validated');
});

test('validated 轮次 ack 未决时恢复先补 ack，不重跑 Worker 或 merge', async () => {
  const { port, requests } = fakePort({ ancestorQueue: [{ kind: 'yes' }], tree: MERGED_TREE });
  const validated: IntegrationReconciliationRecord = {
    coordinationScopeId: SCOPE,
    workPackageId: WP,
    reconciliationId: integrationReconciliationId({
      coordinationScopeId: SCOPE,
      graphId,
      graphGeneration: 1,
      workPackageId: WP,
      round: 1,
    }),
    round: 1,
    validationAttemptId: 'validation-1',
    sourceAcceptedResultRef: 'orca-task-1#abc',
    targetHead: BASELINE,
    mergedTreeRef: MERGED_TREE,
    orcaTaskId: 'orca-task-1',
    dispatchId: 'dispatch-1',
    state: 'validated',
    blockerRef: null,
    createdAt: 1,
    updatedAt: 1,
  };
  const { store: reconciliationStore } = fakeReconciliationStore([validated]);
  let ackBlocked = true;
  const context: IntegrationReconciliationContext = {
    ...reconciliationContext(reconciliationStore, () => Promise.reject(new Error('本用例不应再派发 Worker'))),
    acknowledgeResult: () =>
      Promise.resolve(ackBlocked ? { kind: 'blocked', reason: 'ack 未决' } : { kind: 'acknowledged' }),
  };

  const first = await integrateWorkPackage(input(port, { reconciliation: context }));
  expect(first).toMatchObject({ kind: 'blocked' });
  // 只回读原轮次，不重跑 merge。
  expect(requests.map((request) => request.step)).toEqual(['commit']);

  ackBlocked = false;
  const second = await integrateWorkPackage(input(port, { reconciliation: context }));
  expect(second.kind).toBe('integrated');
  expect(requests.map((request) => request.step)).toEqual(['commit', 'integrate_canonical', 'push']);
});
