/**
 * IC-05：确定性 Execution Graph 编译（Owner: `m1-plan-and-authorize-execution`）。
 *
 * 编译是纯函数式的结构转换：同一份 Implementation Plan 与同一份配置必须得到相同的 Work Package
 * 集合与依赖拓扑。编译器只检查 schema、引用、无环、Scope Envelope 与预算上限，不评判规划语义
 * （D4）——「这个工作包该不该存在」属于 Coordinator 与用户，不属于编译器。
 *
 * 计划来自 Coordinator，因此在编译边界先按闭集解析一次：字段缺失、类型不符或未知取值都在这里
 * fail closed，不会以 `any` 的形状流进编译逻辑。任一检查失败即返回显式错误列表且不产出候选图，
 * 没有部分结果，也没有静默截断。
 */

import {
  parseEntityRef,
  parseRevision,
  parseStableId,
  type GraphGeneration,
  type GraphId,
  type IdentityResult,
  type VersionedRef,
  type WorkPackageId,
} from '../../application/dto/identity.js';
import type { ExecutionLimits } from './budget-policy.js';
import { assertWithinCaps, budgetFromLimits } from './budget-policy.js';
import type {
  ExecutionGraph,
  ImplementationPlan,
  PlannedWorkPackage,
  ScopeEnvelope,
  WorkPackage,
  WorkPackageBudget,
} from './execution-graph.js';

export type GraphCompilationInput = {
  /** 未解析的计划：编译边界自己做运行时校验，不信任类型标注。 */
  readonly plan: unknown;
  readonly limits: ExecutionLimits;
  readonly graphId: GraphId;
  readonly generation: GraphGeneration;
};

export type CompilationErrorCode =
  | 'invalid_schema'
  | 'empty_plan'
  | 'duplicate_key'
  | 'unknown_dependency'
  | 'self_dependency'
  | 'cycle'
  | 'invalid_scope_envelope'
  | 'budget_exceeded';

export type CompilationError = {
  readonly code: CompilationErrorCode;
  readonly message: string;
  readonly workPackageKey: string | null;
};

export type CompilationResult =
  | { readonly ok: true; readonly graph: ExecutionGraph }
  | { readonly ok: false; readonly errors: readonly CompilationError[] };

function error(
  code: CompilationErrorCode,
  message: string,
  workPackageKey: string | null = null,
): CompilationError {
  return { code, message, workPackageKey };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** WorkPackageId 由 GraphId 与计划内的键派生：同一世代内确定且不跨世代复用。 */
export function workPackageIdFor(graphId: GraphId, key: string): WorkPackageId {
  return `${graphId}:${key}` as WorkPackageId;
}

function isValidEnvelopePath(path: string): boolean {
  if (path.length === 0 || path.includes('\0') || path.includes('\\')) {
    return false;
  }
  if (path.startsWith('/') || path.endsWith('/') || path.endsWith('/.')) {
    return false;
  }
  if (path === '.') {
    return false;
  }
  return path.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function validateEnvelope(envelope: ScopeEnvelope): string | null {
  if (envelope.include.length === 0) {
    return 'Scope Envelope 的 include 不得为空';
  }
  for (const path of [...envelope.include, ...envelope.exclude]) {
    if (!isValidEnvelopePath(path)) {
      return `Scope Envelope 含有非法路径 ${JSON.stringify(path)}`;
    }
  }
  return null;
}

function parsePathList(raw: unknown, field: string): IdentityResult<readonly string[]> {
  if (!Array.isArray(raw)) {
    return { ok: false, field, message: '必须是字符串数组' };
  }
  const values: string[] = [];
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== 'string' || entry.length === 0) {
      return { ok: false, field: `${field}[${index}]`, message: '必须是非空字符串' };
    }
    values.push(entry);
  }
  return { ok: true, value: values };
}

function parseScopeEnvelope(raw: unknown, field: string): IdentityResult<ScopeEnvelope> {
  if (!isRecord(raw)) {
    return { ok: false, field, message: '必须是对象' };
  }
  const include = parsePathList(raw['include'], `${field}.include`);
  if (!include.ok) {
    return include;
  }
  const exclude = parsePathList(raw['exclude'], `${field}.exclude`);
  if (!exclude.ok) {
    return exclude;
  }
  return { ok: true, value: { include: include.value, exclude: exclude.value } };
}

const BUDGET_KEYS = [
  'implementationAttempts',
  'validatorRepairs',
  'graphRevisions',
  'specificationRevisions',
  'maxRecoveriesPerWorkerAttempt',
] as const satisfies readonly (keyof WorkPackageBudget)[];

function parseRequestedBudget(
  raw: unknown,
  field: string,
): IdentityResult<Partial<WorkPackageBudget>> {
  if (raw === undefined) {
    return { ok: true, value: {} };
  }
  if (!isRecord(raw)) {
    return { ok: false, field, message: '必须是对象' };
  }
  const requested: Partial<Record<keyof WorkPackageBudget, number>> = {};
  for (const key of BUDGET_KEYS) {
    const value = raw[key];
    if (value === undefined) {
      continue;
    }
    const parsed = parseRevision(value, `${field}.${key}`);
    if (!parsed.ok) {
      return parsed;
    }
    requested[key] = parsed.value;
  }
  return { ok: true, value: requested };
}

function parsePlannedWorkPackage(raw: unknown, field: string): IdentityResult<PlannedWorkPackage> {
  if (!isRecord(raw)) {
    return { ok: false, field, message: '必须是对象' };
  }
  const key = parseStableId(raw['key'], `${field}.key`);
  if (!key.ok) {
    return key;
  }
  const title = parseStableId(raw['title'], `${field}.title`);
  if (!title.ok) {
    return title;
  }
  const dependsOn = parsePathList(raw['dependsOn'], `${field}.dependsOn`);
  if (!dependsOn.ok) {
    return dependsOn;
  }
  const scopeEnvelope = parseScopeEnvelope(raw['scopeEnvelope'], `${field}.scopeEnvelope`);
  if (!scopeEnvelope.ok) {
    return scopeEnvelope;
  }
  const requestedBudget = parseRequestedBudget(raw['requestedBudget'], `${field}.requestedBudget`);
  if (!requestedBudget.ok) {
    return requestedBudget;
  }
  const planned: PlannedWorkPackage = {
    key: key.value,
    title: title.value,
    dependsOn: dependsOn.value,
    scopeEnvelope: scopeEnvelope.value,
    ...(raw['requestedBudget'] === undefined ? {} : { requestedBudget: requestedBudget.value }),
  };
  return { ok: true, value: planned };
}

/** Implementation Plan 的运行时解析：字段闭集、引用校验，未知形状一律拒绝。 */
export function parseImplementationPlan(raw: unknown, field = 'plan'): IdentityResult<ImplementationPlan> {
  if (!isRecord(raw)) {
    return { ok: false, field, message: '必须是对象' };
  }
  const planRevision = parseRevision(raw['planRevision'], `${field}.planRevision`);
  if (!planRevision.ok) {
    return planRevision;
  }
  const destinationRef = parseEntityRef(raw['destinationRef'], `${field}.destinationRef`, ['destination']);
  if (!destinationRef.ok) {
    return destinationRef;
  }
  const destinationVersion = parseRevision(
    isRecord(raw['destinationRef']) ? raw['destinationRef']['version'] : undefined,
    `${field}.destinationRef.version`,
  );
  if (!destinationVersion.ok) {
    return destinationVersion;
  }
  const rawWorkPackages = raw['workPackages'];
  if (!Array.isArray(rawWorkPackages)) {
    return { ok: false, field: `${field}.workPackages`, message: '必须是数组' };
  }
  const workPackages: PlannedWorkPackage[] = [];
  for (const [index, entry] of rawWorkPackages.entries()) {
    const parsed = parsePlannedWorkPackage(entry, `${field}.workPackages[${index}]`);
    if (!parsed.ok) {
      return parsed;
    }
    workPackages.push(parsed.value);
  }
  const ref: VersionedRef<'destination'> = {
    kind: 'destination',
    id: destinationRef.value.id,
    version: destinationVersion.value,
  };
  return { ok: true, value: { planRevision: planRevision.value, destinationRef: ref, workPackages } };
}

/** 检测依赖环；返回参与环的键，便于把结论直接呈现给用户。 */
function findCycle(edges: ReadonlyMap<string, readonly string[]>): readonly string[] | null {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  let cycle: readonly string[] | null = null;

  const walk = (node: string, path: readonly string[]): void => {
    if (cycle !== null) {
      return;
    }
    if (visiting.has(node)) {
      const start = path.indexOf(node);
      cycle = start === -1 ? [...path, node] : [...path.slice(start), node];
      return;
    }
    if (visited.has(node)) {
      return;
    }
    visiting.add(node);
    for (const next of edges.get(node) ?? []) {
      walk(next, [...path, node]);
      if (cycle !== null) {
        return;
      }
    }
    visiting.delete(node);
    visited.add(node);
  };

  for (const node of [...edges.keys()].sort()) {
    walk(node, []);
    if (cycle !== null) {
      break;
    }
  }
  return cycle;
}

/**
 * 编译候选 Execution Graph。
 *
 * 输出顺序按 key 升序、依赖按 key 升序，因此结果与计划内的书写顺序无关；这就是「同一计划编译出
 * 相同拓扑」的可观察形式。
 */
export function compileExecutionGraph(input: GraphCompilationInput): CompilationResult {
  const parsed = parseImplementationPlan(input.plan);
  if (!parsed.ok) {
    return { ok: false, errors: [error('invalid_schema', `${parsed.field}: ${parsed.message}`)] };
  }
  const plan = parsed.value;
  if (plan.workPackages.length === 0) {
    return { ok: false, errors: [error('empty_plan', 'Implementation Plan 不包含任何 Work Package')] };
  }

  const errors: CompilationError[] = [];
  const keys = new Set<string>();
  for (const planned of plan.workPackages) {
    if (keys.has(planned.key)) {
      errors.push(error('duplicate_key', `Work Package key ${planned.key} 重复`, planned.key));
      continue;
    }
    keys.add(planned.key);
  }

  const edges = new Map<string, readonly string[]>();
  for (const planned of plan.workPackages) {
    const dependencies: string[] = [];
    for (const dependency of planned.dependsOn) {
      if (dependency === planned.key) {
        errors.push(error('self_dependency', `Work Package ${planned.key} 依赖自身`, planned.key));
        continue;
      }
      if (!keys.has(dependency)) {
        errors.push(
          error('unknown_dependency', `Work Package ${planned.key} 引用了未知的 Work Package ${dependency}`, planned.key),
        );
        continue;
      }
      dependencies.push(dependency);
    }
    edges.set(planned.key, dependencies);

    const envelopeError = validateEnvelope(planned.scopeEnvelope);
    if (envelopeError !== null) {
      errors.push(error('invalid_scope_envelope', `Work Package ${planned.key}：${envelopeError}`, planned.key));
    }
  }

  if (errors.length === 0) {
    const cycle = findCycle(edges);
    if (cycle !== null) {
      errors.push(error('cycle', `依赖存在环：${cycle.join(' -> ')}`, cycle[0] ?? null));
    }
  }

  for (const violation of assertWithinCaps({ limits: input.limits, workPackages: plan.workPackages })) {
    errors.push(error('budget_exceeded', violation.message, violation.workPackageKey));
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const budget = budgetFromLimits(input.limits);
  const workPackages: readonly WorkPackage[] = [...plan.workPackages]
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
    .map((planned) => ({
      workPackageId: workPackageIdFor(input.graphId, planned.key),
      title: planned.title,
      dependsOn: [...(edges.get(planned.key) ?? [])]
        .sort()
        .map((key) => workPackageIdFor(input.graphId, key)),
      scopeEnvelope: {
        include: [...planned.scopeEnvelope.include],
        exclude: [...planned.scopeEnvelope.exclude],
      },
      budget,
    }));

  return {
    ok: true,
    graph: {
      graphId: input.graphId,
      generation: input.generation,
      concurrencyLimit: input.limits.concurrencyLimit,
      workPackages,
    },
  };
}
