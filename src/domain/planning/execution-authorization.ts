/**
 * IC-05：Execution Authorization Manifest 与版本化授权（Owner: `m1-plan-and-authorize-execution`）。
 *
 * Manifest 是一个不可分的结构：字段集合在这里一次性定型，任何字段缺失都在提交批准之前被拒绝，
 * 后继 change 只能读取和扣减，不能新增预算字段（D7）。批准是对某一份确切内容的一次用户决定，
 * 记录里带内容指纹与版本，因此「内容变了」与「换了一份授权」是同一件事（D9）。
 *
 * 发布与部署永远不在授权范围内：它们不是清单上的一个可选项，而是被显式保留的操作类别（D10）。
 */

import { createHash } from 'node:crypto';

import {
  parseEntityRef,
  parseRevision,
  parseStableId,
  type CoordinationScopeId,
  type EntityRef,
  type GraphGeneration,
  type GraphId,
  type GraphVersion,
  type IdentityResult,
  type PlanningCycleId,
  type Revision,
  type VersionedRef,
} from '../../application/dto/identity.js';
import type { GraphVersionRecord } from './execution-graph.js';
import {
  DEFAULT_EXECUTION_LIMITS,
  DEFAULT_RECOVERIES_PER_WORKER_ATTEMPT,
  applyLimitDefaults,
  parseExecutionLimits,
  type ExecutionLimits,
} from './budget-policy.js';

/** Manifest 的结构版本；字段集合变化时递增，读取到未知版本即拒绝。 */
export const MANIFEST_VERSION = 1;

export const WORKER_ROLES = ['planner', 'implementation', 'validator', 'finalizer'] as const;

export type WorkerRole = (typeof WORKER_ROLES)[number];

export type WorkerProfileRef = {
  readonly profileRef: EntityRef<'worker-profile'>;
  readonly role: WorkerRole;
  readonly harness: string;
};

/** 角色权限；每一项都是显式布尔值，没有「默认允许」的解读空间。 */
export type RoleAuthorities = {
  readonly planner: boolean;
  readonly implementation: boolean;
  readonly validator: boolean;
  readonly finalizer: boolean;
  readonly gitIntegration: boolean;
  readonly dependencyChanges: boolean;
};

export type WorkspacePolicy = {
  readonly canonicalWorktree: string;
  readonly worktreeIsolation: 'per_work_package';
};

export type GitIntegrationPolicy = {
  readonly canonicalBranch: string;
  readonly remotes: readonly string[];
  readonly refs: readonly string[];
  /** force-push 与历史改写不在默认权限内，也没有 Manifests 字段可以打开它。 */
  readonly allowForcePush: false;
};

export type DependencyPolicy = {
  readonly allowDependencyChanges: boolean;
  readonly registry: string | null;
};

export type ManifestGraphRef = {
  readonly graphId: GraphId;
  readonly generation: GraphGeneration;
  readonly version: GraphVersion;
};

export type ExecutionAuthorizationManifest = {
  readonly manifestVersion: number;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly planningCycleId: PlanningCycleId;
  readonly destinationRef: VersionedRef<'destination'>;
  readonly routeMapRef: VersionedRef<'route-map'>;
  readonly implementationPlanRef: VersionedRef<'implementation-plan'>;
  readonly graph: ManifestGraphRef;
  readonly baselineHead: string;
  readonly orcaRunId: string;
  readonly workerProfiles: readonly WorkerProfileRef[];
  readonly permissions: RoleAuthorities;
  readonly limits: ExecutionLimits;
  readonly workspacePolicy: WorkspacePolicy;
  readonly gitPolicy: GitIntegrationPolicy;
  readonly dependencyPolicy: DependencyPolicy;
  readonly acceptedRisks: readonly string[];
};

export type ExecutionAuthorizationRecord = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly authorizationId: string;
  readonly authorizationVersion: Revision;
  readonly manifestVersion: number;
  readonly fingerprint: string;
  readonly manifest: ExecutionAuthorizationManifest;
  readonly approvedAt: number;
  readonly approvalRef: string;
};

function readString(record: Record<string, unknown>, key: string, path: string): IdentityResult<string> {
  const parsed = parseStableId(record[key], `${path}.${key}`);
  return parsed;
}

function readBoolean(record: Record<string, unknown>, key: string, path: string): IdentityResult<boolean> {
  const raw = record[key];
  if (typeof raw !== 'boolean') {
    return { ok: false, field: `${path}.${key}`, message: '必须是布尔值' };
  }
  return { ok: true, value: raw };
}

function readStringArray(record: Record<string, unknown>, key: string, path: string): IdentityResult<readonly string[]> {
  const raw = record[key];
  if (!Array.isArray(raw)) {
    return { ok: false, field: `${path}.${key}`, message: '必须是字符串数组' };
  }
  const values: string[] = [];
  for (const [index, item] of raw.entries()) {
    if (typeof item !== 'string' || item.length === 0) {
      return { ok: false, field: `${path}.${key}[${index}]`, message: '必须是非空字符串' };
    }
    values.push(item);
  }
  return { ok: true, value: values };
}

function readVersionedRef(
  value: unknown,
  path: string,
  kind: string,
): IdentityResult<VersionedRef<string>> {
  const ref = parseEntityRef(value, path, [kind]);
  if (!ref.ok) {
    return ref;
  }
  const version = parseRevision(
    typeof value === 'object' && value !== null ? (value as { readonly version?: unknown }).version : undefined,
    `${path}.version`,
  );
  if (!version.ok) {
    return version;
  }
  return { ok: true, value: { kind: ref.value.kind, id: ref.value.id, version: version.value } };
}

function parseWorkerProfiles(raw: unknown, path: string): IdentityResult<readonly WorkerProfileRef[]> {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, field: path, message: '至少需要一个 Worker Profile' };
  }
  const profiles: WorkerProfileRef[] = [];
  for (const [index, item] of raw.entries()) {
    if (typeof item !== 'object' || item === null) {
      return { ok: false, field: `${path}[${index}]`, message: '必须是对象' };
    }
    const record = item as Record<string, unknown>;
    const profileRef = parseEntityRef(record['profileRef'], `${path}[${index}].profileRef`, ['worker-profile']);
    if (!profileRef.ok) {
      return profileRef;
    }
    const role = record['role'];
    if (typeof role !== 'string' || !(WORKER_ROLES as readonly string[]).includes(role)) {
      return { ok: false, field: `${path}[${index}].role`, message: `未知 Worker 角色 ${String(role)}` };
    }
    const harness = readString(record, 'harness', `${path}[${index}]`);
    if (!harness.ok) {
      return harness;
    }
    profiles.push({
      profileRef: { kind: 'worker-profile', id: profileRef.value.id },
      role: role as WorkerRole,
      harness: harness.value,
    });
  }
  const covered = new Set(profiles.map((profile) => profile.role));
  for (const role of WORKER_ROLES) {
    if (!covered.has(role)) {
      return { ok: false, field: path, message: `缺少 ${role} 角色的 Worker Profile` };
    }
  }
  return { ok: true, value: profiles };
}

function parsePermissions(raw: unknown, path: string): IdentityResult<RoleAuthorities> {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, field: path, message: '必须是对象' };
  }
  const record = raw as Record<string, unknown>;
  const keys = [
    'planner',
    'implementation',
    'validator',
    'finalizer',
    'gitIntegration',
    'dependencyChanges',
  ] as const;
  const values: Record<string, boolean> = {};
  for (const key of keys) {
    const parsed = readBoolean(record, key, path);
    if (!parsed.ok) {
      return parsed;
    }
    values[key] = parsed.value;
  }
  return {
    ok: true,
    value: {
      planner: values['planner'] ?? false,
      implementation: values['implementation'] ?? false,
      validator: values['validator'] ?? false,
      finalizer: values['finalizer'] ?? false,
      gitIntegration: values['gitIntegration'] ?? false,
      dependencyChanges: values['dependencyChanges'] ?? false,
    },
  };
}

function parseWorkspacePolicy(raw: unknown, path: string): IdentityResult<WorkspacePolicy> {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, field: path, message: '必须是对象' };
  }
  const record = raw as Record<string, unknown>;
  const canonicalWorktree = readString(record, 'canonicalWorktree', path);
  if (!canonicalWorktree.ok) {
    return canonicalWorktree;
  }
  if (record['worktreeIsolation'] !== 'per_work_package') {
    return { ok: false, field: `${path}.worktreeIsolation`, message: '必须为 per_work_package' };
  }
  return {
    ok: true,
    value: { canonicalWorktree: canonicalWorktree.value, worktreeIsolation: 'per_work_package' },
  };
}

function parseGitPolicy(raw: unknown, path: string): IdentityResult<GitIntegrationPolicy> {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, field: path, message: '必须是对象' };
  }
  const record = raw as Record<string, unknown>;
  const canonicalBranch = readString(record, 'canonicalBranch', path);
  if (!canonicalBranch.ok) {
    return canonicalBranch;
  }
  const remotes = readStringArray(record, 'remotes', path);
  if (!remotes.ok) {
    return remotes;
  }
  const refs = readStringArray(record, 'refs', path);
  if (!refs.ok) {
    return refs;
  }
  if (record['allowForcePush'] !== false) {
    return { ok: false, field: `${path}.allowForcePush`, message: 'force-push 不在默认权限内，必须为 false' };
  }
  return {
    ok: true,
    value: {
      canonicalBranch: canonicalBranch.value,
      remotes: remotes.value,
      refs: refs.value,
      allowForcePush: false,
    },
  };
}

function parseDependencyPolicy(raw: unknown, path: string): IdentityResult<DependencyPolicy> {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, field: path, message: '必须是对象' };
  }
  const record = raw as Record<string, unknown>;
  const allowDependencyChanges = readBoolean(record, 'allowDependencyChanges', path);
  if (!allowDependencyChanges.ok) {
    return allowDependencyChanges;
  }
  const registry = record['registry'];
  if (registry !== null && (typeof registry !== 'string' || registry.length === 0)) {
    return { ok: false, field: `${path}.registry`, message: '必须是非空字符串或 null' };
  }
  return {
    ok: true,
    value: { allowDependencyChanges: allowDependencyChanges.value, registry: registry },
  };
}

function parseGraphRef(raw: unknown, path: string): IdentityResult<ManifestGraphRef> {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, field: path, message: '必须是对象' };
  }
  const record = raw as Record<string, unknown>;
  const graphId = readString(record, 'graphId', path);
  if (!graphId.ok) {
    return graphId;
  }
  const generation = parseRevision(record['generation'], `${path}.generation`);
  if (!generation.ok) {
    return generation;
  }
  const version = parseRevision(record['version'], `${path}.version`);
  if (!version.ok) {
    return version;
  }
  return {
    ok: true,
    value: {
      graphId: graphId.value as GraphId,
      generation: generation.value as GraphGeneration,
      version: version.value as GraphVersion,
    },
  };
}

/**
 * 严格的 Manifest 解析。
 *
 * 只接受字段闭集：未知顶层字段被忽略不影响判断，但任一必填字段缺失或类型不符都立即失败，因此
 * 「缺字段不提交批准」是解析层的性质，而不是调用方的自觉。
 */
export function parseManifest(raw: unknown, path = 'manifest'): IdentityResult<ExecutionAuthorizationManifest> {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, field: path, message: '必须是对象' };
  }
  const record = raw as Record<string, unknown>;
  const manifestVersion = parseRevision(record['manifestVersion'], `${path}.manifestVersion`);
  if (!manifestVersion.ok) {
    return manifestVersion;
  }
  if (manifestVersion.value !== MANIFEST_VERSION) {
    return { ok: false, field: `${path}.manifestVersion`, message: `未知 Manifest 版本 ${manifestVersion.value}` };
  }
  const coordinationScopeId = readString(record, 'coordinationScopeId', path);
  if (!coordinationScopeId.ok) {
    return coordinationScopeId;
  }
  const planningCycleId = readString(record, 'planningCycleId', path);
  if (!planningCycleId.ok) {
    return planningCycleId;
  }
  const destinationRef = readVersionedRef(record['destinationRef'], `${path}.destinationRef`, 'destination');
  if (!destinationRef.ok) {
    return destinationRef;
  }
  const routeMapRef = readVersionedRef(record['routeMapRef'], `${path}.routeMapRef`, 'route-map');
  if (!routeMapRef.ok) {
    return routeMapRef;
  }
  const implementationPlanRef = readVersionedRef(
    record['implementationPlanRef'],
    `${path}.implementationPlanRef`,
    'implementation-plan',
  );
  if (!implementationPlanRef.ok) {
    return implementationPlanRef;
  }
  const graph = parseGraphRef(record['graph'], `${path}.graph`);
  if (!graph.ok) {
    return graph;
  }
  const baselineHead = readString(record, 'baselineHead', path);
  if (!baselineHead.ok) {
    return baselineHead;
  }
  const orcaRunId = readString(record, 'orcaRunId', path);
  if (!orcaRunId.ok) {
    return orcaRunId;
  }
  const workerProfiles = parseWorkerProfiles(record['workerProfiles'], `${path}.workerProfiles`);
  if (!workerProfiles.ok) {
    return workerProfiles;
  }
  const permissions = parsePermissions(record['permissions'], `${path}.permissions`);
  if (!permissions.ok) {
    return permissions;
  }
  const limits = parseExecutionLimits(record['limits'], `${path}.limits`);
  if (!limits.ok) {
    return limits;
  }
  const workspacePolicy = parseWorkspacePolicy(record['workspacePolicy'], `${path}.workspacePolicy`);
  if (!workspacePolicy.ok) {
    return workspacePolicy;
  }
  const gitPolicy = parseGitPolicy(record['gitPolicy'], `${path}.gitPolicy`);
  if (!gitPolicy.ok) {
    return gitPolicy;
  }
  const dependencyPolicy = parseDependencyPolicy(record['dependencyPolicy'], `${path}.dependencyPolicy`);
  if (!dependencyPolicy.ok) {
    return dependencyPolicy;
  }
  const acceptedRisks = readStringArray(record, 'acceptedRisks', path);
  if (!acceptedRisks.ok) {
    return acceptedRisks;
  }

  return {
    ok: true,
    value: {
      manifestVersion: manifestVersion.value,
      coordinationScopeId: coordinationScopeId.value as CoordinationScopeId,
      planningCycleId: planningCycleId.value as PlanningCycleId,
      destinationRef: { kind: 'destination', id: destinationRef.value.id, version: destinationRef.value.version },
      routeMapRef: { kind: 'route-map', id: routeMapRef.value.id, version: routeMapRef.value.version },
      implementationPlanRef: {
        kind: 'implementation-plan',
        id: implementationPlanRef.value.id,
        version: implementationPlanRef.value.version,
      },
      graph: graph.value,
      baselineHead: baselineHead.value,
      orcaRunId: orcaRunId.value,
      workerProfiles: workerProfiles.value,
      permissions: permissions.value,
      limits: limits.value,
      workspacePolicy: workspacePolicy.value,
      gitPolicy: gitPolicy.value,
      dependencyPolicy: dependencyPolicy.value,
      acceptedRisks: acceptedRisks.value,
    },
  };
}

/**
 * 组装 Manifest：补齐用户未指定的有限上限，再走严格解析。
 *
 * 补齐只发生在这里；`parseManifest` 对缺失字段仍然拒绝，因此「显式写入默认值」与「字段缺失」
 * 在持久化记录里是两件可区分的事。
 */
export function assembleManifest(raw: unknown, path = 'manifest'): IdentityResult<ExecutionAuthorizationManifest> {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, field: path, message: '必须是对象' };
  }
  const record = { ...(raw as Record<string, unknown>) };
  if (record['manifestVersion'] === undefined) {
    record['manifestVersion'] = MANIFEST_VERSION;
  }
  record['limits'] = applyLimitDefaults(record['limits']);
  return parseManifest(record, path);
}

/** 内容指纹：键排序后的规范 JSON 的 SHA-256；内容变化必然产生新指纹。 */
export function manifestFingerprint(manifest: ExecutionAuthorizationManifest): string {
  return createHash('sha256').update(canonicalJson(manifest)).digest('hex');
}

/** Manifest 必须完整绑定当前候选图；空数组表示逐项一致。 */
export function manifestCandidateMismatches(
  manifest: ExecutionAuthorizationManifest,
  candidate: GraphVersionRecord,
): readonly string[] {
  const mismatches: string[] = [];
  if (manifest.graph.graphId !== candidate.graphId) mismatches.push('graphId');
  if (manifest.graph.generation !== candidate.generation) mismatches.push('graphGeneration');
  if (manifest.graph.version !== candidate.version) mismatches.push('graphVersion');
  if (manifest.routeMapRef.version !== candidate.mapRevision) mismatches.push('routeMapRevision');
  if (manifest.implementationPlanRef.version !== candidate.planRevision) mismatches.push('implementationPlanRevision');
  if (manifest.orcaRunId !== candidate.orcaRunId) mismatches.push('orcaRunId');
  return mismatches;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

/** 永远需要单独授权、不可能被 Manifest 覆盖的操作类别。 */
export const RESERVED_OPERATIONS = ['publish', 'deploy'] as const;

export const MANIFEST_OPERATION_CATEGORIES = ['worker-dispatch', 'dependency-change', 'git-integration'] as const;

export type ReservedOperation = (typeof RESERVED_OPERATIONS)[number];

export function isReservedOperation(category: string): boolean {
  return (RESERVED_OPERATIONS as readonly string[]).includes(category);
}

export type AuthorizationDecision =
  | { readonly kind: 'authorized'; readonly authorization: ExecutionAuthorizationRecord }
  | { readonly kind: 'requires_separate_authorization'; readonly category: string }
  | { readonly kind: 'not_authorized'; readonly reason: string };

/**
 * 一次操作是否落在已批准 Manifest 的策略内。
 *
 * 判定只看 Manifest 与该操作类别：发布、部署与未知的越界类别永远落在授权之外，不因为 Manifest
 * 里出现某个布尔值而被放行（D10）。
 */
export function authorizeOperation(input: {
  readonly authorization: ExecutionAuthorizationRecord | null;
  readonly category: string;
  readonly role?: WorkerRole;
}): AuthorizationDecision {
  if (input.authorization === null) {
    return { kind: 'not_authorized', reason: '尚不存在有效的 Execution Authorization' };
  }
  if (isReservedOperation(input.category)) {
    return { kind: 'requires_separate_authorization', category: input.category };
  }
  if (!(MANIFEST_OPERATION_CATEGORIES as readonly string[]).includes(input.category)) {
    return { kind: 'requires_separate_authorization', category: input.category };
  }
  const { permissions } = input.authorization.manifest;
  if (input.category === 'worker-dispatch' && input.role === undefined) {
    return { kind: 'not_authorized', reason: 'Worker 派发必须指定角色' };
  }
  const roleAllowed =
    input.role === undefined
      ? true
      : {
          planner: permissions.planner,
          implementation: permissions.implementation,
          validator: permissions.validator,
          finalizer: permissions.finalizer,
        }[input.role];
  if (!roleAllowed) {
    return { kind: 'not_authorized', reason: `角色 ${String(input.role)} 未获授权` };
  }
  if (input.category === 'git-integration' && !permissions.gitIntegration) {
    return { kind: 'not_authorized', reason: 'Manifest 未授权受控 Git 集成' };
  }
  if (input.category === 'dependency-change' && !permissions.dependencyChanges) {
    return { kind: 'not_authorized', reason: 'Manifest 未授权依赖变更' };
  }
  return { kind: 'authorized', authorization: input.authorization };
}

/** Manifest 的默认执行上限；对调用方可见，避免在执行阶段再次推断。 */
export function defaultManifestLimits(): ExecutionLimits {
  return DEFAULT_EXECUTION_LIMITS;
}

export function defaultRecoveriesPerWorkerAttempt(): number {
  return DEFAULT_RECOVERIES_PER_WORKER_ATTEMPT;
}
