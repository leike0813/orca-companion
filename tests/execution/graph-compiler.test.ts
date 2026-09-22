/**
 * `m1-evolve-execution-graph` 的行为测试：Graph Patch 的编译校验与后代处置（IC-10 / IP-2）。
 *
 * 覆盖 `execution/graph-patching` 的第二个 Requirement：add/revise/retire 的原子集合、未接受后代的
 * 逐一处置、以及影响集合/引用/无环/Scope/预算/授权/版本七类校验。任一失败即整体拒绝，没有任何
 * 部分结果。
 */

import { expect, test } from 'vitest';

import type {
  GraphGeneration,
  GraphId,
  GraphVersion,
  PlanningCycleId,
  WorkPackageId,
} from '../../src/application/dto/identity.js';
import {
  DEFAULT_EXECUTION_LIMITS,
  budgetFromLimits,
  type ExecutionLimits,
} from '../../src/domain/planning/budget-policy.js';
import type { ExecutionGraph, GraphVersionRecord, WorkPackage } from '../../src/domain/planning/execution-graph.js';
import type {
  ExecutionAuthorizationManifest,
  ExecutionAuthorizationRecord,
} from '../../src/domain/planning/execution-authorization.js';
import {
  compileGraphPatch,
  type GraphPatchCompilationResult,
} from '../../src/domain/execution/graph-compiler.js';

const GRAPH_ID = 'graph-1' as GraphId;
const GENERATION = 1 as GraphGeneration;

function workPackage(id: string, dependsOn: readonly string[]): WorkPackage {
  return {
    workPackageId: id as WorkPackageId,
    title: id,
    dependsOn: dependsOn as readonly WorkPackageId[],
    scopeEnvelope: { include: ['src'], exclude: [] },
    budget: budgetFromLimits(DEFAULT_EXECUTION_LIMITS),
  };
}

/** A（已接受）→ B → C，另有无关节点的 D：D 只依赖 A。 */
function graphRecord(overrides?: Partial<ExecutionGraph>): GraphVersionRecord {
  return {
    graphId: GRAPH_ID,
    generation: GENERATION,
    version: 3 as GraphVersion,
    recordKind: 'accepted_revision',
    parentVersion: 2 as GraphVersion,
    patchId: 'patch-0',
    mapRevision: 2,
    planRevision: 1,
    orcaRunId: 'run-1',
    graph: {
      graphId: GRAPH_ID,
      generation: GENERATION,
      concurrencyLimit: 1,
      workPackages: [
        workPackage('wp-a', []),
        workPackage('wp-b', ['wp-a']),
        workPackage('wp-c', ['wp-b']),
        workPackage('wp-d', ['wp-a']),
      ],
      ...overrides,
    },
    recordedAt: 1,
  };
}

function authorizationRecord(): ExecutionAuthorizationRecord {
  const manifest: ExecutionAuthorizationManifest = {
    manifestVersion: 1,
    coordinationScopeId: 'scope-1' as never,
    planningCycleId: 'cycle-1' as PlanningCycleId,
    destinationRef: { kind: 'destination', id: 'dest-1', version: 1 },
    routeMapRef: { kind: 'route-map', id: 'map-1', version: 1 },
    implementationPlanRef: { kind: 'implementation-plan', id: 'plan-1', version: 1 },
    graph: { graphId: GRAPH_ID, generation: GENERATION, version: 3 as GraphVersion },
    baselineHead: 'head-1',
    orcaRunId: 'run-1',
    workerProfiles: [
      { profileRef: { kind: 'worker-profile', id: 'p-planner' }, role: 'planner', harness: 'codex' },
      { profileRef: { kind: 'worker-profile', id: 'p-impl' }, role: 'implementation', harness: 'codex' },
      { profileRef: { kind: 'worker-profile', id: 'p-val' }, role: 'validator', harness: 'codex' },
      { profileRef: { kind: 'worker-profile', id: 'p-fin' }, role: 'finalizer', harness: 'codex' },
    ],
    permissions: {
      planner: true,
      implementation: true,
      validator: true,
      finalizer: true,
      gitIntegration: false,
      dependencyChanges: false,
    },
    limits: DEFAULT_EXECUTION_LIMITS,
    workspacePolicy: { canonicalWorktree: '/work', worktreeIsolation: 'per_work_package' },
    gitPolicy: { canonicalBranch: 'main', remotes: [], refs: [], allowForcePush: false },
    dependencyPolicy: { allowDependencyChanges: false, registry: null },
    acceptedRisks: [],
  };
  return {
    coordinationScopeId: 'scope-1' as never,
    authorizationId: 'auth-1',
    authorizationVersion: 1,
    manifestVersion: 1,
    fingerprint: 'fingerprint-1',
    manifest,
    approvedAt: 1,
    approvalRef: 'approval-1',
  };
}

function patch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    baseGraphVersion: 3,
    patchId: 'patch-1',
    operationId: 'op-1',
    add: [],
    revise: [],
    retire: [],
    descendants: [],
    takesOver: [],
    ...overrides,
  };
}

function compile(
  patchInput: Record<string, unknown>,
  options: {
    readonly limits?: ExecutionLimits;
    readonly accepted?: readonly string[];
    readonly dispatched?: readonly string[];
    readonly authorization?: ExecutionAuthorizationRecord | null;
    readonly current?: GraphVersionRecord;
  } = {},
): GraphPatchCompilationResult {
  return compileGraphPatch({
    patch: patchInput,
    current: options.current ?? graphRecord(),
    limits: options.limits ?? DEFAULT_EXECUTION_LIMITS,
    authorization: options.authorization === undefined ? authorizationRecord() : options.authorization,
    acceptedWorkPackageIds: (options.accepted ?? ['wp-a']).map((id) => id as WorkPackageId),
    dispatchedWorkPackageIds: (options.dispatched ?? []).map((id) => id as WorkPackageId),
  });
}

function codes(result: GraphPatchCompilationResult): readonly string[] {
  return result.ok ? [] : result.errors.map((entry) => entry.code);
}

test('补丁原子应用 add + revise + retire，并保留未受影响的节点', () => {
  const result = compile(
    patch({
      add: [
        {
          key: 'prep',
          title: '前置工作',
          dependsOn: [{ kind: 'existing', workPackageId: 'wp-a' }],
          scopeEnvelope: { include: ['src/prep'], exclude: [] },
        },
      ],
      revise: [
        {
          workPackageId: 'wp-b',
          title: 'B 修订',
          dependsOn: [{ kind: 'added', key: 'prep' }],
          scopeEnvelope: { include: ['src'], exclude: [] },
        },
        {
          workPackageId: 'wp-d',
          title: 'D 修订',
          dependsOn: [{ kind: 'existing', workPackageId: 'wp-a' }],
          scopeEnvelope: { include: ['src'], exclude: [] },
        },
      ],
      descendants: [{ workPackageId: 'wp-c', disposition: 'unchanged' }],
    }),
  );

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }
  const ids = result.value.graph.workPackages.map((entry) => entry.workPackageId).sort();
  expect(ids).toEqual(['graph-1:patch-1:prep', 'wp-a', 'wp-b', 'wp-c', 'wp-d'].sort());
  const revised = result.value.graph.workPackages.find((entry) => entry.workPackageId === 'wp-b');
  expect(revised?.title).toBe('B 修订');
  expect(revised?.dependsOn).toEqual(['graph-1:patch-1:prep']);
  expect(result.value.addedWorkPackageIds).toEqual(['graph-1:patch-1:prep']);
  expect(result.value.revisedWorkPackageIds).toEqual(['wp-b', 'wp-d']);
});

test('未接受后代必须逐一处置，未列出即整体拒绝', () => {
  const result = compile(patch({ revise: [
    { workPackageId: 'wp-b', title: 'B 修订', dependsOn: [{ kind: 'existing', workPackageId: 'wp-a' }], scopeEnvelope: { include: ['src'], exclude: [] } },
  ] }));
  expect(result.ok).toBe(false);
  expect(codes(result)).toContain('undisposed_descendant');
});

test('列出与补丁无关的节点作为后代处置也被拒绝', () => {
  const result = compile(
    patch({
      revise: [
        { workPackageId: 'wp-b', title: 'B 修订', dependsOn: [{ kind: 'existing', workPackageId: 'wp-d' }], scopeEnvelope: { include: ['src'], exclude: [] } },
      ],
      descendants: [{ workPackageId: 'wp-c', disposition: 'unchanged' }, { workPackageId: 'wp-a', disposition: 'unchanged' }],
    }),
  );
  expect(codes(result)).toContain('unexpected_disposition');
});

test('处置为 graph_revision 的后代必须真的出现在 revise 中', () => {
  const missing = compile(
    patch({
      revise: [
        { workPackageId: 'wp-b', title: 'B 修订', dependsOn: [{ kind: 'existing', workPackageId: 'wp-a' }], scopeEnvelope: { include: ['src'], exclude: [] } },
      ],
      descendants: [{ workPackageId: 'wp-c', disposition: 'graph_revision' }],
    }),
  );
  expect(codes(missing)).toContain('unexpected_disposition');

  const complete = compile(
    patch({
      revise: [
        { workPackageId: 'wp-b', title: 'B 修订', dependsOn: [{ kind: 'existing', workPackageId: 'wp-a' }], scopeEnvelope: { include: ['src'], exclude: [] } },
        { workPackageId: 'wp-c', title: 'C 修订', dependsOn: [{ kind: 'existing', workPackageId: 'wp-b' }], scopeEnvelope: { include: ['src'], exclude: [] } },
      ],
      descendants: [{ workPackageId: 'wp-c', disposition: 'graph_revision' }],
    }),
  );
  expect(complete.ok).toBe(true);
});

test('specification_revision 处置保持拓扑但要求后续契约修订', () => {
  const result = compile(
    patch({
      revise: [
        { workPackageId: 'wp-b', title: 'B 修订', dependsOn: [{ kind: 'existing', workPackageId: 'wp-a' }], scopeEnvelope: { include: ['src'], exclude: [] } },
      ],
      descendants: [{ workPackageId: 'wp-c', disposition: 'specification_revision' }],
    }),
  );
  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }
  expect(result.value.specificationRevisionRequiredWorkPackageIds).toEqual(['wp-c']);
  expect(result.value.retiredWorkPackageIds).toEqual([]);
});

test('baseGraphVersion 必须精确匹配当前版本', () => {
  const result = compile(
    patch({
      baseGraphVersion: 2,
      revise: [
        { workPackageId: 'wp-b', title: 'B 修订', dependsOn: [{ kind: 'existing', workPackageId: 'wp-a' }], scopeEnvelope: { include: ['src'], exclude: [] } },
      ],
      descendants: [{ workPackageId: 'wp-c', disposition: 'unchanged' }],
    }),
  );
  expect(codes(result)).toEqual(['base_version_mismatch']);
});

test('引用缺失导致拒绝', () => {
  const unknownExisting = compile(
    patch({
      revise: [
        { workPackageId: 'wp-b', title: 'B 修订', dependsOn: [{ kind: 'existing', workPackageId: 'wp-missing' }], scopeEnvelope: { include: ['src'], exclude: [] } },
      ],
      descendants: [{ workPackageId: 'wp-c', disposition: 'unchanged' }],
    }),
  );
  expect(codes(unknownExisting)).toContain('unknown_reference');

  const unknownAdd = compile(
    patch({
      revise: [
        { workPackageId: 'wp-b', title: 'B 修订', dependsOn: [{ kind: 'added', key: 'nope' }], scopeEnvelope: { include: ['src'], exclude: [] } },
      ],
      descendants: [{ workPackageId: 'wp-c', disposition: 'unchanged' }],
    }),
  );
  expect(codes(unknownAdd)).toContain('unknown_reference');
});

test('退休节点的依赖悬空导致拒绝', () => {
  const result = compile(
    patch({
      retire: ['wp-a'],
      descendants: [
        { workPackageId: 'wp-b', disposition: 'unchanged' },
        { workPackageId: 'wp-c', disposition: 'unchanged' },
        { workPackageId: 'wp-d', disposition: 'unchanged' },
      ],
    }),
  );
  expect(codes(result)).toContain('unknown_reference');
});

test('成环导致拒绝', () => {
  const result = compile(
    patch({
      revise: [
        { workPackageId: 'wp-b', title: 'B 修订', dependsOn: [{ kind: 'existing', workPackageId: 'wp-c' }], scopeEnvelope: { include: ['src'], exclude: [] } },
        { workPackageId: 'wp-c', title: 'C 修订', dependsOn: [{ kind: 'existing', workPackageId: 'wp-b' }], scopeEnvelope: { include: ['src'], exclude: [] } },
      ],
      descendants: [{ workPackageId: 'wp-c', disposition: 'graph_revision' }],
    }),
  );
  expect(codes(result)).toContain('cycle');
});

test('超预算导致拒绝', () => {
  const result = compile(
    patch({
      add: [
        { key: 'prep', title: '前置', dependsOn: [], scopeEnvelope: { include: ['src/prep'], exclude: [] } },
      ],
    }),
    { limits: { ...DEFAULT_EXECUTION_LIMITS, maxActiveWorkPackages: 4 } },
  );
  expect(codes(result)).toContain('budget_exceeded');
});

test('未授权导致拒绝，授权绑定的世代不符也被拒绝', () => {
  expect(codes(compile(patch(), { authorization: null }))).toContain('not_authorized');

  const otherGeneration = authorizationRecord();
  const mismatched: ExecutionAuthorizationRecord = {
    ...otherGeneration,
    manifest: { ...otherGeneration.manifest, graph: { ...otherGeneration.manifest.graph, generation: 9 as GraphGeneration } },
  };
  expect(codes(compile(patch(), { authorization: mismatched }))).toContain('not_authorized');
});

test('已接受节点不得被重定义或退休', () => {
  const revised = compile(
    patch({
      revise: [
        { workPackageId: 'wp-a', title: 'A 修订', dependsOn: [], scopeEnvelope: { include: ['src'], exclude: [] } },
      ],
      descendants: [
        { workPackageId: 'wp-b', disposition: 'unchanged' },
        { workPackageId: 'wp-c', disposition: 'unchanged' },
        { workPackageId: 'wp-d', disposition: 'unchanged' },
      ],
    }),
  );
  expect(codes(revised)).toContain('accepted_node_mutation');

  const retired = compile(patch({ retire: ['wp-a'] }));
  expect(codes(retired)).toContain('accepted_node_mutation');
});

test('takesOver 被记录，退休节点保留可审计历史', () => {
  const result = compile(
    patch({
      add: [
        { key: 'replacement', title: '替代节点', dependsOn: [{ kind: 'existing', workPackageId: 'wp-a' }], scopeEnvelope: { include: ['src'], exclude: [] } },
      ],
      retire: ['wp-b', 'wp-c'],
      takesOver: [{ workPackageId: 'wp-b', takesOverByKey: 'replacement' }],
    }),
  );
  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }
  expect(result.value.takesOver).toEqual([{ workPackageId: 'wp-b', takesOverByKey: 'replacement' }]);
  expect(result.value.retiredWorkPackageIds).toEqual(['wp-b', 'wp-c']);
  expect(result.value.graph.workPackages.map((entry) => entry.workPackageId).sort()).toEqual(
    ['graph-1:patch-1:replacement', 'wp-a', 'wp-d'].sort(),
  );
});

test('接管方必须是同一补丁新增的节点', () => {
  const result = compile(
    patch({ retire: ['wp-b', 'wp-c'], takesOver: [{ workPackageId: 'wp-b', takesOverByKey: 'ghost' }] }),
  );
  expect(codes(result)).toContain('unknown_takeover_target');
});

test('已派发的修订节点进入 revision pending', () => {
  const result = compile(
    patch({
      revise: [
        { workPackageId: 'wp-b', title: 'B 修订', dependsOn: [{ kind: 'existing', workPackageId: 'wp-a' }], scopeEnvelope: { include: ['src'], exclude: [] } },
      ],
      descendants: [{ workPackageId: 'wp-c', disposition: 'unchanged' }],
    }),
    { dispatched: ['wp-b'] },
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.revisionPendingWorkPackageIds).toEqual(['wp-b']);
  }
});

test('已派发的退休目标同样进入 revision pending', () => {
  const result = compile(patch({ retire: ['wp-b', 'wp-c'] }), { dispatched: ['wp-b'] });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.retiredWorkPackageIds).toEqual(['wp-b', 'wp-c']);
    expect(result.value.revisionPendingWorkPackageIds).toEqual(['wp-b']);
  }
});

test('非法形状被拒绝且不产生候选图', () => {
  const result = compile({ baseGraphVersion: 3, patchId: 'patch-1' });
  expect(codes(result)).toEqual(['invalid_schema']);
  const duplicate = compile(
    patch({
      add: [
        { key: 'prep', title: '前置', dependsOn: [], scopeEnvelope: { include: ['src'], exclude: [] } },
        { key: 'prep', title: '重复', dependsOn: [], scopeEnvelope: { include: ['src'], exclude: [] } },
      ],
    }),
  );
  expect(codes(duplicate)).toContain('duplicate_key');
});

test('Scope Envelope 非法导致拒绝', () => {
  const result = compile(
    patch({
      add: [{ key: 'prep', title: '前置', dependsOn: [], scopeEnvelope: { include: ['/abs'], exclude: [] } }],
    }),
  );
  expect(codes(result)).toContain('invalid_scope_envelope');
});

test('编译器不读时钟、不写存储：同一输入得到相同结果', () => {
  const input = patch({
    revise: [
      { workPackageId: 'wp-b', title: 'B 修订', dependsOn: [{ kind: 'existing', workPackageId: 'wp-a' }], scopeEnvelope: { include: ['src'], exclude: [] } },
    ],
    descendants: [{ workPackageId: 'wp-c', disposition: 'unchanged' }],
  });
  expect(compile(input)).toEqual(compile(input));
});
