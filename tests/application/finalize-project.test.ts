/**
 * 项目级收尾用例测试
 * （change: `m1-execute-and-validate-work-packages`，Owner: IP-B7）。
 *
 * 覆盖 Requirement「Finalizer 使用新的只读项目级会话」的两个 Scenario 与「Delivery Verdict 由
 * 独立结论构成并被确定性接受」的写入部分：全部通过才派发只读 Finalizer、存在未决工作时不收尾、
 * 结论以分支级记录保存、不一致时阻塞且不写入。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { openCoordinationStore, type CoordinationStore } from '../../src/adapters/storage/coordination-store.js';
import { acquireRuntimeLease } from '../../src/application/coordination/lease-service.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  PlanningCycleId,
  RuntimeIncarnationId,
  WorkPackageId,
} from '../../src/application/dto/identity.js';
import {
  finalizeProject,
  planFinalizerDispatch,
  type FinalizeProjectInput,
  type FinalizerGateFacts,
} from '../../src/application/finalize-project.js';
import { initializeCoordinationScope } from '../../src/application/planning/initialize-scope.js';
import type { CoordinationWriter } from '../../src/application/ports/branch-coordination-store.js';
import type { FinalizerReportFacts } from '../../src/domain/delivery-verdict.js';
import type { RoleAuthorities } from '../../src/domain/planning/execution-authorization.js';
import {
  initialWorkPackageStatus,
  withValidationStatus,
  type WorkPackageStatus,
} from '../../src/domain/work-package-status.js';

const SCOPE = 'scope-1' as CoordinationScopeId;
const SESSION_A = 'session-a' as CoordinatorSessionId;
const CYCLE = 'cycle-1' as PlanningCycleId;
const WP_1 = 'wp-1' as WorkPackageId;
const WP_2 = 'wp-2' as WorkPackageId;

const AUTHORITY: RoleAuthorities = {
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

function validated(workPackageId: WorkPackageId): WorkPackageStatus {
  return withValidationStatus(initialWorkPackageStatus(workPackageId), {
    kind: 'validated',
    validationAttemptId: `validation-${workPackageId}`,
    acceptedResultRef: `orca-result-${workPackageId}`,
  });
}

function revision(): number {
  const scope = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
  if (scope.kind !== 'scope' || scope.scope === null) {
    throw new Error('Scope 不存在');
  }
  return scope.scope.revision;
}

function gate(overrides: Partial<FinalizerGateFacts> = {}): FinalizerGateFacts {
  return {
    workPackageStatuses: [validated(WP_1), validated(WP_2)],
    pendingInteractionCount: 0,
    unresolvedMutationCount: 0,
    authority: AUTHORITY,
    ...overrides,
  };
}

function report(overrides: Partial<FinalizerReportFacts> = {}): FinalizerReportFacts {
  return {
    role: 'finalizer',
    session: { kind: 'new_read_only', sessionBindingId: 'session-binding-1' },
    readOnly: true,
    coveredWorkPackageIds: [WP_1, WP_2],
    expectedWorkPackageIds: [WP_1, WP_2],
    verdict: { kind: 'deliverable', evidenceRefs: ['orca-result-1'] },
    authoritativeRefs: ['orca-result-1'],
    ...overrides,
  };
}

function input(overrides: Partial<FinalizeProjectInput> = {}): FinalizeProjectInput {
  const statuses = [validated(WP_1), validated(WP_2)];
  return {
    store,
    coordinationScopeId: SCOPE,
    writer,
    expectedRevision: revision(),
    gate: gate({ workPackageStatuses: statuses }),
    report: report(),
    authoritativeRefs: ['orca-result-1'],
    verdictId: 'verdict-1',
    ...overrides,
  };
}

function verdictRecords(): number {
  const read = store.query({ kind: 'delivery-verdicts', coordinationScopeId: SCOPE });
  return read.kind === 'delivery-verdicts' ? read.verdicts.length : -1;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-finalize-'));
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

test('全部通过且无未决工作时派发新的只读项目级 Finalizer', () => {
  const decision = planFinalizerDispatch(gate());

  expect(decision).toEqual({
    kind: 'dispatch',
    plan: {
      role: 'finalizer',
      sessionKind: 'new',
      readOnly: true,
      coversWorkPackageIds: [WP_1, WP_2],
    },
  });
});

test.each([
  ['仍有未通过验证的 Work Package', { workPackageStatuses: [validated(WP_1), initialWorkPackageStatus(WP_2)] }],
  ['存在未决交互', { pendingInteractionCount: 1 }],
  ['存在未结算 mutation', { unresolvedMutationCount: 1 }],
] satisfies readonly (readonly [string, Partial<FinalizerGateFacts>])[])('%s 时不收尾', (_label, overrides) => {
  expect(planFinalizerDispatch(gate(overrides)).kind).toBe('not_ready');
});

test('Manifest 未授权 finalizer 角色时不收尾', () => {
  expect(planFinalizerDispatch(gate({ authority: { ...AUTHORITY, finalizer: false } })).kind).toBe('not_ready');
});

test('接受可交付结论并写入一条分支级记录', () => {
  const result = finalizeProject(input());

  expect(result.kind).toBe('accepted');
  if (result.kind !== 'accepted') {
    return;
  }
  expect(result.deliverable).toBe(true);
  expect(result.record.verdict).toEqual({ kind: 'deliverable', evidenceRefs: ['orca-result-1'] });
  expect(verdictRecords()).toBe(1);
  expect(result.statuses.every((status) => status.delivery.kind === 'deliverable')).toBe(true);
  // 结论不改写验证事实。
  expect(result.statuses.every((status) => status.validation.kind === 'validated')).toBe(true);
});

test('阻塞结论保持不可交付', () => {
  const result = finalizeProject(
    input({ report: report({ verdict: { kind: 'blocked', blockerRefs: ['blocker-1'] } }) }),
  );

  expect(result.kind).toBe('accepted');
  if (result.kind !== 'accepted') {
    return;
  }
  expect(result.deliverable).toBe(false);
  expect(result.statuses.map((status) => status.delivery.kind)).toEqual(['blocked', 'blocked']);
  expect(verdictRecords()).toBe(1);
});

test('证据与既有权威事实不一致时阻塞且不写入结论', () => {
  const result = finalizeProject(
    input({
      report: report({ verdict: { kind: 'deliverable', evidenceRefs: ['orca-result-1', 'unknown-ref'] } }),
    }),
  );

  expect(result).toMatchObject({ kind: 'blocked', code: 'evidence_conflicts_with_authoritative_facts' });
  expect(verdictRecords()).toBe(0);
});

test('Finalizer 不能通过自报权威引用接受未知证据', () => {
  const result = finalizeProject(
    input({
      report: report({
        verdict: { kind: 'deliverable', evidenceRefs: ['invented-ref'] },
        authoritativeRefs: ['invented-ref'],
      }),
    }),
  );

  expect(result).toMatchObject({ kind: 'blocked', code: 'evidence_conflicts_with_authoritative_facts' });
  expect(verdictRecords()).toBe(0);
});

test('存在未决工作时完全不写入结论记录', () => {
  const result = finalizeProject(input({ gate: gate({ pendingInteractionCount: 1 }) }));

  expect(result.kind).toBe('not_ready');
  expect(verdictRecords()).toBe(0);
});

test('Finalizer 不能通过缩小自报 expected 集合绕过项目级覆盖检查', () => {
  const result = finalizeProject(
    input({
      report: report({ expectedWorkPackageIds: [WP_1], coveredWorkPackageIds: [WP_1] }),
    }),
  );

  expect(result).toMatchObject({ kind: 'blocked', code: 'coverage_incomplete' });
  expect(verdictRecords()).toBe(0);
});

test('持久化的 Session Binding 引用来自已核验报告', () => {
  const result = finalizeProject(
    input({
      report: report({ session: { kind: 'new_read_only', sessionBindingId: 'session-binding-verified' } }),
    }),
  );

  expect(result.kind === 'accepted' ? result.record.sessionBindingRef : null).toBe('session-binding-verified');
});
