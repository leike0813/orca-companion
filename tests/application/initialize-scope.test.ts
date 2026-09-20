/**
 * `m1-plan-and-authorize-execution` 的行为测试：Coordination Scope 的创建（IC-05）。
 *
 * 覆盖 `planning/execution-authorization` 的 Requirement「Manifest completeness and atomic
 * approval」中的 Scenario「初始化向导不询问恢复上限」：创建阶段只建立 Scope、首个 Planning Cycle
 * 与首个 Coordinator Session，外加「首个 Session 是当前规划责任方」这条共享事实，不写预算、权限
 * 或 accepted risks。
 *
 * 这里同时固定两件可观察事实：初始化是原子的（不会留下第二个 Session 或第二个责任方），且
 * bootstrap 窗口只覆盖创建那一次调用——Scope 出现之后，没有 Runtime Lease 的写入者（包括创建者
 * 自己）都不能再写共享状态。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { openCoordinationStore, type CoordinationStore } from '../../src/adapters/storage/coordination-store.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  PlanningCycleId,
  RuntimeIncarnationId,
} from '../../src/application/dto/identity.js';
import { executionPolicyIsAbsent } from '../../src/application/planning/authorization-service.js';
import { initializeCoordinationScope } from '../../src/application/planning/initialize-scope.js';
import type {
  BudgetCounterRecord,
  CoordinatorSessionRegistration,
  PlanningResponsibilityRecord,
  ScopeRecord,
} from '../../src/application/ports/branch-coordination-store.js';
import type { ExecutionAuthorizationRecord } from '../../src/domain/planning/execution-authorization.js';

const SCOPE = 'scope-1' as CoordinationScopeId;
const SESSION_A = 'session-a' as CoordinatorSessionId;
const SESSION_B = 'session-b' as CoordinatorSessionId;
const CYCLE = 'cycle-1' as PlanningCycleId;

let directory = '';
let store: CoordinationStore;
let now = 1_000;

const clock = (): number => now;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-planning-init-'));
  now = 1_000;
  const opened = openCoordinationStore({ databasePath: join(directory, 'coordination.sqlite'), clock });
  if (opened.kind !== 'opened') {
    throw new Error(opened.message);
  }
  store = opened.store;
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

function initialize(sessionId: CoordinatorSessionId) {
  return initializeCoordinationScope({
    store,
    coordinationScopeId: SCOPE,
    coordinatorSessionId: sessionId,
    coordinatorModelConfigurationRef: `model-config-${sessionId}`,
    planningCycleId: CYCLE,
  });
}

function scopeRecord(): ScopeRecord {
  const result = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
  if (result.kind !== 'scope' || result.scope === null) {
    throw new Error('Scope 不存在');
  }
  return result.scope;
}

function sessions(): readonly CoordinatorSessionRegistration[] {
  const result = store.query({ kind: 'sessions', coordinationScopeId: SCOPE });
  if (result.kind !== 'sessions') {
    throw new Error('无法读取 Session registry');
  }
  return result.sessions;
}

function responsibility(): PlanningResponsibilityRecord | null {
  const result = store.query({ kind: 'planning-responsibility', coordinationScopeId: SCOPE });
  if (result.kind !== 'planning-responsibility') {
    throw new Error('无法读取规划责任方');
  }
  return result.responsibility;
}

function authorizations(): readonly ExecutionAuthorizationRecord[] {
  const result = store.query({ kind: 'authorizations', coordinationScopeId: SCOPE });
  if (result.kind !== 'authorizations') {
    throw new Error('无法读取授权记录');
  }
  return result.authorizations;
}

function budgetCounters(): readonly BudgetCounterRecord[] {
  const result = store.query({ kind: 'budget-counters', coordinationScopeId: SCOPE });
  if (result.kind !== 'budget-counters') {
    throw new Error('无法读取预算计数');
  }
  return result.counters;
}

test('初始化原子创建 Scope、首个 Planning Cycle 与首个 Session', () => {
  const result = initialize(SESSION_A);

  expect(result.kind).toBe('initialized');
  if (result.kind !== 'initialized') {
    return;
  }
  expect(result.revision).toBe(1);

  const scope = scopeRecord();
  expect(scope.mode).toBe('route_planning');
  expect(scope.controlState).toBe('active');
  expect(scope.planningCycleId).toBe(CYCLE);
  expect(scope.revision).toBe(1);

  const registered = sessions();
  expect(registered).toHaveLength(1);
  expect(registered[0]?.coordinatorSessionId).toBe(SESSION_A);
  expect(responsibility()?.coordinatorSessionId).toBe(SESSION_A);
});

/**
 * 重复创建首先表现为 Scope 级 CAS 过期：IC-03 store 的事务前导先做 expected revision 检查、后做
 * 「Scope 是否已存在」检查（与 `create-scope` 一致），所以拒绝码是 `stale_revision`。关键的可
 * 观察结果是不产生任何部分状态。
 */
test('重复创建同一 Scope 被拒绝，且不留下第二个 Session 或第二个责任方', () => {
  expect(initialize(SESSION_A).kind).toBe('initialized');
  const revisionBefore = scopeRecord().revision;

  const again = initialize(SESSION_B);

  expect(again.kind).toBe('rejected');
  if (again.kind === 'rejected') {
    expect(again.code).toBe('stale_revision');
  }
  expect(sessions()).toHaveLength(1);
  expect(sessions()[0]?.coordinatorSessionId).toBe(SESSION_A);
  expect(responsibility()?.coordinatorSessionId).toBe(SESSION_A);
  expect(scopeRecord().revision).toBe(revisionBefore);
});

test('初始化向导不写入恢复上限、预算、权限或 accepted risks', () => {
  expect(initialize(SESSION_A).kind).toBe('initialized');

  expect(executionPolicyIsAbsent({ store, coordinationScopeId: SCOPE })).toBe(true);
  expect(authorizations()).toEqual([]);
  expect(budgetCounters()).toEqual([]);

  const scope = scopeRecord();
  expect(scope.authorizationId).toBeNull();
  expect(scope.authorizationVersion).toBeNull();

  // 没有 Run 创建之类的副作用意图：初始化路径不产生 operation intent。
  const intents = store.query({ kind: 'intents', coordinationScopeId: SCOPE });
  expect(intents.kind).toBe('intents');
  if (intents.kind === 'intents') {
    expect(intents.intents).toEqual([]);
  }
});

test('bootstrap 窗口只覆盖创建那一次调用：之后没有 Runtime Lease 就不能写共享状态', () => {
  expect(initialize(SESSION_A).kind).toBe('initialized');
  const revisionBefore = scopeRecord().revision;

  const writerFor = (sessionId: CoordinatorSessionId) => ({
    coordinatorSessionId: sessionId,
    runtimeIncarnationId: `${sessionId}-inc` as RuntimeIncarnationId,
    fencingGeneration: 0,
  });

  // 另一个尚未注册、当然也没有 Runtime Lease 的 Session。
  const other = store.transact({
    kind: 'record-control-state',
    coordinationScopeId: SCOPE,
    expectedRevision: revisionBefore,
    writer: writerFor(SESSION_B),
    controlState: 'paused',
  });
  expect(other.kind).toBe('rejected');
  if (other.kind === 'rejected') {
    expect(other.code).toBe('fenced');
  }

  // 创建者自己也不例外：初始化调用结束后，没有租约同样不能写。
  const creator = store.transact({
    kind: 'record-control-state',
    coordinationScopeId: SCOPE,
    expectedRevision: revisionBefore,
    writer: writerFor(SESSION_A),
    controlState: 'paused',
  });
  expect(creator.kind).toBe('rejected');
  if (creator.kind === 'rejected') {
    expect(creator.code).toBe('fenced');
  }

  expect(scopeRecord().controlState).toBe('active');
  expect(scopeRecord().revision).toBe(revisionBefore);
});
