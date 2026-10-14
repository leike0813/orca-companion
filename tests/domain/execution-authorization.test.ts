/**
 * Execution Authorization Manifest 领域行为测试（change: `m1-plan-and-authorize-execution`，Owner: IP-6）。
 *
 * 覆盖 Requirement「Manifest completeness and atomic approval」下的 Scenario：
 * - 缺字段不提交批准：缺 baseline HEAD、预算上限、恢复上限、Git/Dependency Policy 或 accepted risks 即拒绝。
 * - 恢复上限显式绑定且取默认值：默认值只在组装阶段写入，严格解析阶段不猜默认值。
 * - 单次决定覆盖整份 Manifest：内容指纹绑定整份 Manifest，字段顺序不影响、任一字段变化即变化。
 * 以及 Requirement「Authorization authorizes bounded operations」下的 Scenario：
 * - 策略内操作不再逐次审批：派发、依赖变更与受控 Git 集成按 Manifest 权限放行。
 * - 越界操作需要单独授权：publish / deploy 始终需要单独授权；没有授权时任何类别都不放行。
 */

import { expect, test } from 'vitest';

import { DEFAULT_EXECUTION_LIMITS } from '../../src/domain/planning/budget-policy.js';
import {
  MANIFEST_VERSION,
  RESERVED_OPERATIONS,
  WORKER_ROLES,
  assembleManifest,
  authorizeOperation,
  defaultRecoveriesPerWorkerAttempt,
  manifestFingerprint,
  parseManifest,
  type ExecutionAuthorizationManifest,
  type ExecutionAuthorizationRecord,
  type RoleAuthorities,
} from '../../src/domain/planning/execution-authorization.js';
import { executionModelConfiguration } from '../support/execution-harness.js';

function baseManifest(): Record<string, unknown> {
  return {
    manifestVersion: MANIFEST_VERSION,
    coordinationScopeId: 'scope-1',
    planningCycleId: 'cycle-1',
    destinationRef: { kind: 'destination', id: 'dest-1', version: 1 },
    routeMapRef: { kind: 'route-map', id: 'map-1', version: 2 },
    implementationPlanRef: { kind: 'implementation-plan', id: 'plan-1', version: 1 },
    graph: { graphId: 'graph-1', generation: 1, version: 1 },
    baselineHead: 'abcdef0123456789abcdef0123456789abcdef01',
    orcaRunId: 'run-1',
    workerProfiles: WORKER_ROLES.map((role) => ({
      profileRef: { kind: 'worker-profile', id: `p-${role}` },
      role,
      harness: 'codex',
      modelSelection: executionModelConfiguration(),
      supportLevel: 'complete', qualificationRef: 'fixture:qualification',
    })),
    recoveryUtilityProfile: {
      profileRef: { kind: 'worker-profile', id: 'p-recovery' },
      harness: 'codex',
      modelSelection: executionModelConfiguration(),
      supportLevel: 'complete', qualificationRef: 'fixture:qualification',
    },
    permissions: {
      planner: true,
      implementation: true,
      validator: true,
      finalizer: true,
      gitIntegration: true,
      dependencyChanges: true,
    },
    limits: { ...DEFAULT_EXECUTION_LIMITS },
    workspacePolicy: { canonicalWorktree: '/work/repo', worktreeIsolation: 'per_work_package' },
    gitPolicy: { canonicalBranch: 'main', remotes: ['origin'], refs: ['main'], allowForcePush: false },
    dependencyPolicy: { allowDependencyChanges: false, registry: null },
    acceptedRisks: [],
  };
}

function omit(raw: Record<string, unknown>, ...keys: readonly string[]): Record<string, unknown> {
  const copy = { ...raw };
  for (const key of keys) {
    delete copy[key];
  }
  return copy;
}

test('Finalizer repair permission is explicit, bounded and fingerprinted', () => {
  const legacy = parseManifest(baseManifest());
  const repair = parseManifest({ ...baseManifest(), finalizerPolicy: { mode: 'repair', repairLimit: 1 } });
  expect(legacy.ok).toBe(true);
  expect(repair.ok).toBe(true);
  if (!legacy.ok || !repair.ok) return;
  expect(legacy.value.finalizerPolicy).toBeUndefined();
  expect(repair.value.finalizerPolicy).toEqual({ mode: 'repair', repairLimit: 1 });
  expect(manifestFingerprint(legacy.value)).not.toBe(manifestFingerprint(repair.value));
  for (const raw of [
    { ...baseManifest(), manifestVersion: 4, finalizerPolicy: { mode: 'repair', repairLimit: 1 } },
    { ...baseManifest(), finalizerPolicy: { mode: 'repair', repairLimit: 0 } },
    { ...baseManifest(), finalizerPolicy: { mode: 'repair', repairLimit: DEFAULT_EXECUTION_LIMITS.validatorRepairs + 1 } },
    { ...baseManifest(), finalizerPolicy: { mode: 'repair', repairLimit: 1 }, permissions: { ...(baseManifest().permissions as object), gitIntegration: false } },
  ]) expect(parseManifest(raw).ok).toBe(false);
});

/**
 * 显式 v4 兼容夹具：从当前夹具移除两处资格绑定，得到迁移前的旧形状。
 *
 * v4 解析必须逐字段读回这份内容且不注入默认资格字段，否则既有 v4 记录的指纹会被改写。
 */
function v4Manifest(): Record<string, unknown> {
  const raw: Record<string, unknown> = { ...baseManifest(), manifestVersion: 4 };
  raw['workerProfiles'] = (raw['workerProfiles'] as Record<string, unknown>[]).map((profile) =>
    omit(profile, 'supportLevel', 'qualificationRef'),
  );
  raw['recoveryUtilityProfile'] = omit(
    raw['recoveryUtilityProfile'] as Record<string, unknown>,
    'supportLevel',
    'qualificationRef',
  );
  return raw;
}

function manifestFixture(): ExecutionAuthorizationManifest {
  const parsed = parseManifest(baseManifest());
  if (!parsed.ok) {
    throw new Error(`fixture Manifest 应当合法，实际失败于 ${parsed.field}`);
  }
  return parsed.value;
}

function recordFixture(permissionOverrides: Partial<RoleAuthorities> = {}): ExecutionAuthorizationRecord {
  const base = manifestFixture();
  const manifest: ExecutionAuthorizationManifest = {
    ...base,
    permissions: { ...base.permissions, ...permissionOverrides },
  };
  return {
    coordinationScopeId: manifest.coordinationScopeId,
    authorizationId: 'auth-1',
    authorizationVersion: 1,
    manifestVersion: manifest.manifestVersion,
    fingerprint: manifestFingerprint(manifest),
    manifest,
    approvedAt: 1_700_000_000_000,
    approvalRef: 'approval-1',
  };
}

/** 只打乱顶层键的书写顺序，内容不变；规范 JSON 应当得到同一个指纹。 */
function reorderKeys(manifest: ExecutionAuthorizationManifest): ExecutionAuthorizationManifest {
  return Object.fromEntries(Object.entries(manifest).reverse()) as ExecutionAuthorizationManifest;
}

test('缺少任一必填字段时不进入待批准状态，并指向该字段', () => {
  const cases: readonly { readonly removed: readonly string[]; readonly expected: string }[] = [
    { removed: ['baselineHead'], expected: 'baselineHead' },
    { removed: ['limits'], expected: 'limits' },
    { removed: ['gitPolicy'], expected: 'gitPolicy' },
    { removed: ['workerProfiles'], expected: 'workerProfiles' },
    { removed: ['acceptedRisks'], expected: 'acceptedRisks' },
  ];

  for (const { removed, expected } of cases) {
    const parsed = parseManifest(omit(baseManifest(), ...removed));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.field).toContain(expected);
    }
  }
});

test('limits 缺少恢复上限字段即拒绝', () => {
  const raw = baseManifest();
  raw['limits'] = omit(raw['limits'] as Record<string, unknown>, 'maxRecoveriesPerWorkerAttempt');

  const parsed = parseManifest(raw);

  expect(parsed.ok).toBe(false);
  if (!parsed.ok) {
    expect(parsed.field).toContain('maxRecoveriesPerWorkerAttempt');
  }
});

test('组装阶段显式写入默认恢复上限，严格解析阶段不猜默认值', () => {
  const raw = baseManifest();
  raw['limits'] = omit(raw['limits'] as Record<string, unknown>, 'maxRecoveriesPerWorkerAttempt');

  expect(parseManifest(raw).ok).toBe(false);

  const assembled = assembleManifest(raw);
  expect(assembled.ok).toBe(true);
  if (assembled.ok) {
    expect(assembled.value.limits.maxRecoveriesPerWorkerAttempt).toBe(1);
    expect(assembled.value.limits).toEqual(DEFAULT_EXECUTION_LIMITS);
  }
});

test('组装阶段补齐所有缺失上限，其余取默认值', () => {
  const raw = { ...baseManifest(), limits: {} };

  expect(parseManifest(raw).ok).toBe(false);

  const assembled = assembleManifest(raw);
  expect(assembled.ok).toBe(true);
  if (assembled.ok) {
    expect(assembled.value.limits).toEqual(DEFAULT_EXECUTION_LIMITS);
    expect(assembled.value.limits.maxRecoveriesPerWorkerAttempt).toBe(defaultRecoveriesPerWorkerAttempt());
  }
});

test('未知 manifestVersion 即拒绝', () => {
  for (const version of [MANIFEST_VERSION + 1, 0, 1, 2, 3, 99]) {
    const parsed = parseManifest({ ...baseManifest(), manifestVersion: version });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.field).toContain('manifestVersion');
    }
  }
});

test('不在默认权限内的策略取值即拒绝', () => {
  const forcePushRaw = baseManifest();
  forcePushRaw['gitPolicy'] = {
    ...(forcePushRaw['gitPolicy'] as Record<string, unknown>),
    allowForcePush: true,
  };
  const forcePush = parseManifest(forcePushRaw);
  expect(forcePush.ok).toBe(false);
  if (!forcePush.ok) {
    expect(forcePush.field).toContain('allowForcePush');
  }

  const sharedWorktreeRaw = baseManifest();
  sharedWorktreeRaw['workspacePolicy'] = { canonicalWorktree: '/work/repo', worktreeIsolation: 'shared' };
  const sharedWorktree = parseManifest(sharedWorktreeRaw);
  expect(sharedWorktree.ok).toBe(false);
  if (!sharedWorktree.ok) {
    expect(sharedWorktree.field).toContain('worktreeIsolation');
  }
});

test('workerProfiles 缺少任一角色即拒绝', () => {
  for (const role of WORKER_ROLES) {
    const raw = baseManifest();
    const profiles = raw['workerProfiles'] as readonly Record<string, unknown>[];
    raw['workerProfiles'] = profiles.filter((profile) => profile['role'] !== role);

    const parsed = parseManifest(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.field).toContain('workerProfiles');
    }
  }
});

test('Manifest 指纹对同一内容稳定、对字段顺序不敏感、对内容变化敏感', () => {
  const manifest = manifestFixture();
  const fingerprint = manifestFingerprint(manifest);

  expect(manifestFingerprint(manifestFixture())).toBe(fingerprint);
  expect(manifestFingerprint(reorderKeys(manifest))).toBe(fingerprint);

  expect(manifestFingerprint({ ...manifest, baselineHead: 'deadbeef' })).not.toBe(fingerprint);
  expect(
    manifestFingerprint({ ...manifest, limits: { ...manifest.limits, graphRevisions: 7 } }),
  ).not.toBe(fingerprint);
});

test('发布与部署永远需要单独授权，没有授权时任何类别都不放行', () => {
  expect(RESERVED_OPERATIONS).toEqual(['publish', 'deploy']);

  const record = recordFixture();
  for (const category of RESERVED_OPERATIONS) {
    expect(authorizeOperation({ authorization: record, category })).toEqual({
      kind: 'requires_separate_authorization',
      category,
    });
  }

  for (const category of ['publish', 'deploy', 'worker-dispatch', 'unknown-operation']) {
    expect(authorizeOperation({ authorization: null, category }).kind).toBe('not_authorized');
  }
});

test('策略内操作直接通过，Manifest 未授权的权限项仍拒绝', () => {
  const record = recordFixture();
  expect(authorizeOperation({ authorization: record, category: 'worker-dispatch', role: 'implementation' }).kind).toBe(
    'authorized',
  );
  expect(authorizeOperation({ authorization: record, category: 'dependency-change' }).kind).toBe('authorized');
  expect(authorizeOperation({ authorization: record, category: 'git-integration' }).kind).toBe('authorized');
  expect(
    authorizeOperation({ authorization: record, category: 'worker-dispatch', role: 'validator' }).kind,
  ).toBe('authorized');

  const noGit = recordFixture({ gitIntegration: false });
  expect(authorizeOperation({ authorization: noGit, category: 'git-integration' }).kind).toBe('not_authorized');

  const noDependencyChanges = recordFixture({ dependencyChanges: false });
  expect(authorizeOperation({ authorization: noDependencyChanges, category: 'dependency-change' }).kind).toBe(
    'not_authorized',
  );

  const noValidator = recordFixture({ validator: false });
  expect(
    authorizeOperation({ authorization: noValidator, category: 'worker-dispatch', role: 'validator' }).kind,
  ).toBe('not_authorized');
  expect(authorizeOperation({ authorization: record, category: 'worker-dispatch' }).kind).toBe('not_authorized');
  expect(authorizeOperation({ authorization: record, category: 'unknown-operation' })).toEqual({
    kind: 'requires_separate_authorization',
    category: 'unknown-operation',
  });
});

test('默认恢复上限为 1', () => {
  expect(defaultRecoveriesPerWorkerAttempt()).toBe(1);
});

test('拒绝旧 Manifest 版本、缺模型绑定与重复角色的授权', () => {
  for (const version of [1, 2, 3]) {
    expect(parseManifest({ ...baseManifest(), manifestVersion: version }).ok).toBe(false);
  }

  const missingModel = baseManifest();
  (missingModel['workerProfiles'] as Record<string, unknown>[])[0] = {
    profileRef: { kind: 'worker-profile', id: 'p-planner' },
    role: 'planner',
    harness: 'codex',
  };
  expect(parseManifest(missingModel).ok).toBe(false);

  expect(parseManifest(omit(baseManifest(), 'recoveryUtilityProfile')).ok).toBe(false);

  const duplicated = baseManifest();
  const profiles = duplicated['workerProfiles'] as Record<string, unknown>[];
  profiles[1] = { ...profiles[0]!, id: undefined, profileRef: { kind: 'worker-profile', id: 'p-planner-2' } };
  expect(parseManifest(duplicated).ok).toBe(false);
});

test('v5 缺 supportLevel / qualificationRef 或等级低于角色下限即拒绝', () => {
  for (const key of ['supportLevel', 'qualificationRef'] as const) {
    const raw = baseManifest();
    const profiles = raw['workerProfiles'] as Record<string, unknown>[];
    delete profiles[0]![key];

    const parsed = parseManifest(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.field).toContain(`workerProfiles[0].${key}`);
    }
  }

  // Recovery Utility 不是豁免通道：它的资格绑定同样必填。
  const utility = baseManifest();
  delete (utility['recoveryUtilityProfile'] as Record<string, unknown>)['qualificationRef'];
  const utilityParsed = parseManifest(utility);
  expect(utilityParsed.ok).toBe(false);
  if (!utilityParsed.ok) {
    expect(utilityParsed.field).toContain('recoveryUtilityProfile.qualificationRef');
  }

  // 等级按角色下限判定：validator 需要 enhanced，basic 不够。
  const basicValidator = baseManifest();
  const validatorProfiles = basicValidator['workerProfiles'] as Record<string, unknown>[];
  const validatorIndex = validatorProfiles.findIndex((profile) => profile['role'] === 'validator');
  validatorProfiles[validatorIndex] = { ...validatorProfiles[validatorIndex]!, supportLevel: 'basic' };
  const basicParsed = parseManifest(basicValidator);
  expect(basicParsed.ok).toBe(false);
  if (!basicParsed.ok) {
    expect(basicParsed.field).toContain('workerProfiles[2].supportLevel');
    expect(basicParsed.message).toContain('validator');
  }
});

test('v5 允许 Recovery Utility 为 null：关闭历史恢复也必须是显式批准', () => {
  const parsed = parseManifest({ ...baseManifest(), recoveryUtilityProfile: null });
  expect(parsed.ok).toBe(true);
  if (parsed.ok) {
    expect(parsed.value.recoveryUtilityProfile).toBeNull();
  }
});

test('显式 v4 Manifest 按旧形状读回、指纹逐位保持；null Recovery Utility 仍被拒绝', () => {
  const oldShape = v4Manifest();
  const parsed = parseManifest(oldShape);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    return;
  }
  // 逐字段读回：v4 不新增 supportLevel / qualificationRef，也不丢弃任何旧字段。
  expect(parsed.value).toStrictEqual(oldShape);
  // 迁移前同一份旧形状内容的指纹；补默认资格字段会立刻改变它，因此必须逐位保持。
  expect(manifestFingerprint(parsed.value)).toBe(
    'b21c0aee91f60278af9e3491f753bb02fd8ef23b47fa89ff5c02017f55d8d933',
  );

  const withNullUtility = parseManifest({ ...oldShape, recoveryUtilityProfile: null });
  expect(withNullUtility.ok).toBe(false);
  if (!withNullUtility.ok) {
    expect(withNullUtility.field).toContain('recoveryUtilityProfile');
  }
});

test('modelSelection 缺少可信来源或结构不合法时拒绝', () => {
  const withSelection = (selection: Record<string, unknown>): boolean => {
    const raw = baseManifest();
    const profiles = raw['workerProfiles'] as Record<string, unknown>[];
    profiles[0] = { ...profiles[0]!, modelSelection: selection };
    return parseManifest(raw).ok;
  };

  // 非空 effort 要求非空能力且取值属于 values。
  expect(withSelection({ model: 'gpt-5', effort: 'high', effortCapability: null, catalogSource: null })).toBe(false);
  expect(
    withSelection({
      model: 'gpt-5',
      effort: 'extreme',
      effortCapability: { values: ['low', 'high'], source: 'catalog' },
      catalogSource: 'catalog',
    }),
  ).toBe(false);
  // 非空能力要求目录来源。
  expect(
    withSelection({
      model: 'gpt-5',
      effort: null,
      effortCapability: { values: ['low', 'high'], source: 'catalog' },
      catalogSource: null,
    }),
  ).toBe(false);
  // 旧 modelConfiguration 形状的多余键在 strict schema 下拒绝。
  expect(
    withSelection({ model: 'gpt-5', effort: null, effortCapability: null, catalogSource: null, modelOptions: {} }),
  ).toBe(false);
  // 合法：可信来源 + 属于 values 的 effort。
  expect(
    withSelection({
      model: 'gpt-5',
      effort: 'high',
      effortCapability: { values: ['low', 'high'], source: 'catalog' },
      catalogSource: 'catalog',
    }),
  ).toBe(true);
  // 合法：手填未验证 native ID，无来源且不捏造 effort。
  expect(withSelection({ model: 'gpt-5', effort: null, effortCapability: null, catalogSource: null })).toBe(true);
});

test('模型绑定进入内容指纹：换模型就是另一份授权', () => {
  const base = manifestFixture();
  const rebound = parseManifest({
    ...base,
    workerProfiles: base.workerProfiles.map((profile) =>
      profile.role === 'implementation'
        ? { ...profile, modelSelection: executionModelConfiguration({ model: 'other-model' }) }
        : profile,
    ),
  });
  expect(rebound.ok).toBe(true);
  if (!rebound.ok) return;
  expect(manifestFingerprint(rebound.value)).not.toBe(manifestFingerprint(base));
});
