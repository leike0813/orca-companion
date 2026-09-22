/**
 * `m1-evolve-execution-graph` 验收层：Graph Compiler 的失败分支（IP-10，D14）。
 *
 * 六类编译失败各用一条独立断言覆盖：缺处置、引用缺失、成环、超预算、未授权与版本漂移。每一条都要求
 * **整体拒绝且不产生 GraphVersion**。
 *
 * 编译、Admission 与提交路径都不接受 `ExecutionBackend`：它们不产生外部副作用，所以这里不需要（也不该
 * 有）fake backend 替身。真实调用不进入本文件：Graph Patch Planner 与真实 Run cutover 只由被显式开启的
 * real-harness 用例覆盖。
 */

import { afterEach, beforeEach, expect, test } from 'vitest';

import type { OperationId, WorkPackageId } from '../../../src/application/dto/identity.js';
import { DEFAULT_EXECUTION_LIMITS } from '../../../src/domain/planning/budget-policy.js';
import type { ExecutionAuthorizationRecord } from '../../../src/domain/planning/execution-authorization.js';
import { admitGraphRevision, applyGraphRevision } from '../../../src/application/execution/graph-patch-service.js';
import { createExecutionScopeHarness, type ExecutionScopeHarness } from '../../support/execution-harness.js';

const TRUSTED_OPERATION = 'op-trusted' as OperationId;

let harness: ExecutionScopeHarness;

beforeEach(() => {
  harness = createExecutionScopeHarness();
});

afterEach(() => {
  harness.close();
});

function patch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    baseGraphVersion: harness.currentGraph().version,
    patchId: 'patch-acceptance',
    operationId: 'op-acceptance',
    add: [],
    revise: [],
    retire: [],
    descendants: [],
    takesOver: [],
    ...overrides,
  };
}

function admit(
  payload: Record<string, unknown>,
  authorization: ExecutionAuthorizationRecord | null = harness.authorization(),
) {
  return admitGraphRevision({
    draft: { payload, operationId: TRUSTED_OPERATION, patchId: 'patch-acceptance' },
    current: harness.currentGraph(),
    limits: harness.limits,
    authorization,
    acceptedWorkPackageIds: ['wp-a' as WorkPackageId],
    dispatchedWorkPackageIds: [],
  });
}

function expectRejectedWithoutVersion(result: ReturnType<typeof admit>, code: string): void {
  expect(result.kind).toBe('rejected');
  if (result.kind === 'rejected') {
    expect(result.errors.map((entry) => entry.code)).toContain(code);
  }
  expect(harness.versionCount()).toBe(1);
}

test('未接受后代缺少处置时整体拒绝', () => {
  expectRejectedWithoutVersion(
    admit(
      patch({
        revise: [
          {
            workPackageId: 'wp-b',
            title: 'B 修订',
            dependsOn: [{ kind: 'existing', workPackageId: 'wp-a' }],
            scopeEnvelope: { include: ['src'], exclude: [] },
          },
        ],
      }),
    ),
    'undisposed_descendant',
  );
});

test('引用缺失时整体拒绝', () => {
  expectRejectedWithoutVersion(
    admit(
      patch({
        revise: [
          {
            workPackageId: 'wp-b',
            title: 'B 修订',
            dependsOn: [{ kind: 'existing', workPackageId: 'wp-missing' }],
            scopeEnvelope: { include: ['src'], exclude: [] },
          },
        ],
        descendants: [{ workPackageId: 'wp-c', disposition: 'unchanged' }],
      }),
    ),
    'unknown_reference',
  );
});

test('成环时整体拒绝', () => {
  expectRejectedWithoutVersion(
    admit(
      patch({
        revise: [
          {
            workPackageId: 'wp-b',
            title: 'B 修订',
            dependsOn: [{ kind: 'existing', workPackageId: 'wp-c' }],
            scopeEnvelope: { include: ['src'], exclude: [] },
          },
          {
            workPackageId: 'wp-c',
            title: 'C 修订',
            dependsOn: [{ kind: 'existing', workPackageId: 'wp-b' }],
            scopeEnvelope: { include: ['src'], exclude: [] },
          },
        ],
        descendants: [{ workPackageId: 'wp-c', disposition: 'graph_revision' }],
      }),
    ),
    'cycle',
  );
});

test('超预算时整体拒绝', () => {
  const constrained = createExecutionScopeHarness({
    limits: { ...DEFAULT_EXECUTION_LIMITS, maxActiveWorkPackages: 4 },
  });
  try {
    const payload = {
      baseGraphVersion: constrained.currentGraph().version,
      patchId: 'patch-budget',
      operationId: 'op-budget',
      add: [
        {
          key: 'extra',
          title: '额外节点',
          dependsOn: [{ kind: 'existing', workPackageId: 'wp-a' }],
          scopeEnvelope: { include: ['src'], exclude: [] },
        },
      ],
      revise: [],
      retire: [],
      descendants: [],
      takesOver: [],
    };
    const result = admitGraphRevision({
      draft: { payload, operationId: TRUSTED_OPERATION, patchId: 'patch-budget' },
      current: constrained.currentGraph(),
      limits: constrained.limits,
      authorization: constrained.authorization(),
      acceptedWorkPackageIds: ['wp-a' as WorkPackageId],
      dispatchedWorkPackageIds: [],
    });
    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') {
      expect(result.errors.map((entry) => entry.code)).toContain('budget_exceeded');
    }
    expect(constrained.versionCount()).toBe(1);
  } finally {
    constrained.close();
  }
});

test('未授权时整体拒绝', () => {
  expectRejectedWithoutVersion(admit(patch(), null), 'not_authorized');
});

test('版本漂移时整体拒绝', () => {
  const drifted = admit(patch({ baseGraphVersion: harness.currentGraph().version + 1 }));
  expect(drifted.kind).toBe('rejected');
  if (drifted.kind === 'rejected') {
    expect(drifted.errors.map((entry) => entry.code)).toEqual(['base_version_mismatch']);
  }
  expect(harness.versionCount()).toBe(1);
});

test('Admission 通过的补丁才产生一次 GraphVersion，且被拒绝的候选不落库', () => {
  const admitted = admit(
    patch({
      revise: [
        {
          workPackageId: 'wp-b',
          title: 'B 修订',
          dependsOn: [{ kind: 'existing', workPackageId: 'wp-a' }],
          scopeEnvelope: { include: ['src'], exclude: [] },
        },
      ],
      descendants: [{ workPackageId: 'wp-c', disposition: 'unchanged' }],
    }),
  );
  expect(admitted.kind).toBe('admitted');
  if (admitted.kind !== 'admitted') {
    return;
  }
  const applied = applyGraphRevision({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    revision: admitted.revision,
    current: harness.currentGraph(),
    authorizationId: 'auth-1',
    baselines: new Map([...admitted.revision.revisedWorkPackageIds, ...admitted.revision.specificationRevisionRequiredWorkPackageIds].map((id) => [id, null])),
  });
  expect(applied.kind).toBe('applied');
  expect(harness.versionCount()).toBe(2);
});
