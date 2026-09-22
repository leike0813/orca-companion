/**
 * IC-10 / IP-1、IP-2：Graph Patch 的表示与后代处置（Owner: `m1-evolve-execution-graph`，D3）。
 *
 * Graph Patch 是一次追加记录，不是对既有 GraphVersion 的就地编辑：它声明 exact `baseGraphVersion`、
 * 要新增的节点、要重定义的节点、要退休的节点，以及 base 版本中**每一个**未接受后代的处置。补丁草案
 * 可能来自 Graph Patch Planner，但它的形状在这里被一次性定型；判定与编译在
 * `execution/graph-compiler.ts`，提交在 `graph-patch-service.ts`。
 *
 * 两处刻意设计：
 * - 依赖引用区分 `existing`（指向当前图里的 WorkPackageId）与 `added`（指向同一补丁内新增的 key），
 *   因此不存在「按字符串猜这是哪一种」的路径；
 * - 后代处置必须逐一列出，未列出的未接受后代导致补丁被拒绝（D3）——隐含的「默认不变」会让依赖变化
 *   静默遗留后代。
 *
 * 本模块不读存储、不派发、不判断规划语义。
 */

import {
  parseRevision,
  parseStableId,
  type GraphId,
  type GraphVersion,
  type IdentityResult,
  type OperationId,
  type WorkPackageId,
} from '../../application/dto/identity.js';
import { parseRequestedBudget, parseScopeEnvelope } from '../planning/graph-compiler.js';
import type { ExecutionGraph, ScopeEnvelope, WorkPackageBudget } from '../planning/execution-graph.js';

/** 未接受后代的处置闭集；`retire` 表示该后代随补丁一起移出活动图。 */
export const DESCENDANT_DISPOSITIONS = ['unchanged', 'graph_revision', 'specification_revision', 'retire'] as const;

export type DescendantDispositionKind = (typeof DESCENDANT_DISPOSITIONS)[number];

/**
 * 补丁内的依赖引用。
 *
 * `existing` 指向当前图中仍然存在的 WorkPackageId；`added` 指向同一补丁 `add` 里的键。二者互不冒充，
 * 因此「引用了一个刚被 retire 的节点」与「引用了一个新增节点」在编译期就是可区分的失败。
 */
export type PatchDependencyRef =
  | { readonly kind: 'existing'; readonly workPackageId: WorkPackageId }
  | { readonly kind: 'added'; readonly key: string };

/** 一个由补丁新增的 Patch Work Package；WorkPackageId 与 worktree 在应用时新建。 */
export type PatchWorkPackageAddition = {
  readonly key: string;
  readonly title: string;
  readonly dependsOn: readonly PatchDependencyRef[];
  readonly scopeEnvelope: ScopeEnvelope;
  readonly requestedBudget?: Partial<WorkPackageBudget>;
};

/** 对同一 Work Package 的一次 Graph Revision；依赖与 Scope Envelope 都是绝对值，不是增量。 */
export type PatchWorkPackageRevision = {
  readonly workPackageId: WorkPackageId;
  readonly title: string;
  readonly dependsOn: readonly PatchDependencyRef[];
  readonly scopeEnvelope: ScopeEnvelope;
};

/** 一条未接受后代的处置；每个后代恰好一条。 */
export type PatchDescendantDisposition = {
  readonly workPackageId: WorkPackageId;
  readonly disposition: DescendantDispositionKind;
};

/** 责任接管：被处置节点的责任由同一补丁中新增的某个 Patch Work Package 承担。 */
export type PatchResponsibilityTakeover = {
  readonly workPackageId: WorkPackageId;
  readonly takesOverByKey: string;
};

export type GraphPatch = {
  readonly baseGraphVersion: GraphVersion;
  readonly patchId: string;
  readonly operationId: OperationId;
  readonly add: readonly PatchWorkPackageAddition[];
  readonly revise: readonly PatchWorkPackageRevision[];
  readonly retire: readonly WorkPackageId[];
  readonly descendants: readonly PatchDescendantDisposition[];
  readonly takesOver: readonly PatchResponsibilityTakeover[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseDependencyRef(raw: unknown, field: string): IdentityResult<PatchDependencyRef> {
  if (!isRecord(raw)) {
    return { ok: false, field, message: '必须是对象' };
  }
  const kind = raw['kind'];
  if (kind === 'existing') {
    const workPackageId = parseStableId(raw['workPackageId'], `${field}.workPackageId`);
    if (!workPackageId.ok) {
      return workPackageId;
    }
    return { ok: true, value: { kind: 'existing', workPackageId: workPackageId.value as WorkPackageId } };
  }
  if (kind === 'added') {
    const key = parseStableId(raw['key'], `${field}.key`);
    if (!key.ok) {
      return key;
    }
    return { ok: true, value: { kind: 'added', key: key.value } };
  }
  return { ok: false, field: `${field}.kind`, message: `未知依赖引用 kind: ${String(kind)}` };
}

function parseDependencyList(raw: unknown, field: string): IdentityResult<readonly PatchDependencyRef[]> {
  if (!Array.isArray(raw)) {
    return { ok: false, field, message: '必须是数组' };
  }
  const refs: PatchDependencyRef[] = [];
  for (const [index, entry] of raw.entries()) {
    const parsed = parseDependencyRef(entry, `${field}[${index}]`);
    if (!parsed.ok) {
      return parsed;
    }
    refs.push(parsed.value);
  }
  return { ok: true, value: refs };
}

function parseRecordList<T>(
  raw: unknown,
  field: string,
  parseEntry: (entry: unknown, entryField: string) => IdentityResult<T>,
): IdentityResult<readonly T[]> {
  if (!Array.isArray(raw)) {
    return { ok: false, field, message: '必须是数组' };
  }
  const values: T[] = [];
  for (const [index, entry] of raw.entries()) {
    const parsed = parseEntry(entry, `${field}[${index}]`);
    if (!parsed.ok) {
      return parsed;
    }
    values.push(parsed.value);
  }
  return { ok: true, value: values };
}

function parseId(raw: unknown, field: string): IdentityResult<WorkPackageId> {
  const parsed = parseStableId(raw, field);
  return parsed.ok ? { ok: true, value: parsed.value as WorkPackageId } : parsed;
}

function parseAddition(raw: unknown, field: string): IdentityResult<PatchWorkPackageAddition> {
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
  const dependsOn = parseDependencyList(raw['dependsOn'], `${field}.dependsOn`);
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
  return {
    ok: true,
    value: {
      key: key.value,
      title: title.value,
      dependsOn: dependsOn.value,
      scopeEnvelope: scopeEnvelope.value,
      ...(raw['requestedBudget'] === undefined ? {} : { requestedBudget: requestedBudget.value }),
    },
  };
}

function parseRevisionEntry(raw: unknown, field: string): IdentityResult<PatchWorkPackageRevision> {
  if (!isRecord(raw)) {
    return { ok: false, field, message: '必须是对象' };
  }
  const workPackageId = parseId(raw['workPackageId'], `${field}.workPackageId`);
  if (!workPackageId.ok) {
    return workPackageId;
  }
  const title = parseStableId(raw['title'], `${field}.title`);
  if (!title.ok) {
    return title;
  }
  const dependsOn = parseDependencyList(raw['dependsOn'], `${field}.dependsOn`);
  if (!dependsOn.ok) {
    return dependsOn;
  }
  const scopeEnvelope = parseScopeEnvelope(raw['scopeEnvelope'], `${field}.scopeEnvelope`);
  if (!scopeEnvelope.ok) {
    return scopeEnvelope;
  }
  return {
    ok: true,
    value: {
      workPackageId: workPackageId.value,
      title: title.value,
      dependsOn: dependsOn.value,
      scopeEnvelope: scopeEnvelope.value,
    },
  };
}

function parseDisposition(raw: unknown, field: string): IdentityResult<PatchDescendantDisposition> {
  if (!isRecord(raw)) {
    return { ok: false, field, message: '必须是对象' };
  }
  const workPackageId = parseId(raw['workPackageId'], `${field}.workPackageId`);
  if (!workPackageId.ok) {
    return workPackageId;
  }
  const disposition = raw['disposition'];
  if (typeof disposition !== 'string' || !(DESCENDANT_DISPOSITIONS as readonly string[]).includes(disposition)) {
    return { ok: false, field: `${field}.disposition`, message: `未知后代处置 ${String(disposition)}` };
  }
  return {
    ok: true,
    value: { workPackageId: workPackageId.value, disposition: disposition as DescendantDispositionKind },
  };
}

function parseTakeover(raw: unknown, field: string): IdentityResult<PatchResponsibilityTakeover> {
  if (!isRecord(raw)) {
    return { ok: false, field, message: '必须是对象' };
  }
  const workPackageId = parseId(raw['workPackageId'], `${field}.workPackageId`);
  if (!workPackageId.ok) {
    return workPackageId;
  }
  const takesOverByKey = parseStableId(raw['takesOverByKey'], `${field}.takesOverByKey`);
  if (!takesOverByKey.ok) {
    return takesOverByKey;
  }
  return { ok: true, value: { workPackageId: workPackageId.value, takesOverByKey: takesOverByKey.value } };
}

/** 运行时解析补丁草案：字段闭集、逐项类型校验，未知形状一律拒绝。 */
export function parseGraphPatch(raw: unknown, field = 'patch'): IdentityResult<GraphPatch> {
  if (!isRecord(raw)) {
    return { ok: false, field, message: '必须是对象' };
  }
  const baseGraphVersion = parseRevision(raw['baseGraphVersion'], `${field}.baseGraphVersion`);
  if (!baseGraphVersion.ok) {
    return baseGraphVersion;
  }
  const patchId = parseStableId(raw['patchId'], `${field}.patchId`);
  if (!patchId.ok) {
    return patchId;
  }
  const operationId = parseStableId(raw['operationId'], `${field}.operationId`);
  if (!operationId.ok) {
    return operationId;
  }
  const add = parseRecordList(raw['add'], `${field}.add`, parseAddition);
  if (!add.ok) {
    return add;
  }
  const revise = parseRecordList(raw['revise'], `${field}.revise`, parseRevisionEntry);
  if (!revise.ok) {
    return revise;
  }
  const retire = parseRecordList(raw['retire'], `${field}.retire`, parseId);
  if (!retire.ok) {
    return retire;
  }
  const descendants = parseRecordList(raw['descendants'], `${field}.descendants`, parseDisposition);
  if (!descendants.ok) {
    return descendants;
  }
  const takesOver = parseRecordList(raw['takesOver'], `${field}.takesOver`, parseTakeover);
  if (!takesOver.ok) {
    return takesOver;
  }
  return {
    ok: true,
    value: {
      baseGraphVersion: baseGraphVersion.value as GraphVersion,
      patchId: patchId.value,
      operationId: operationId.value as OperationId,
      add: add.value,
      revise: revise.value,
      retire: retire.value,
      descendants: descendants.value,
      takesOver: takesOver.value,
    },
  };
}

/**
 * 补丁新增节点的 WorkPackageId。
 *
 * 由 GraphId、patchId 与补丁内键确定性派生：同一补丁重放得到同一标识，不同补丁的相同键也不会碰撞
 * 既有节点，因此「新增」不会覆盖任何现存 Work Package。
 */
export function patchWorkPackageIdFor(graphId: GraphId, patchId: string, key: string): WorkPackageId {
  return `${graphId}:${patchId}:${key}` as WorkPackageId;
}

/** 直接依赖 `workPackageId` 的节点。 */
export function directDependents(graph: ExecutionGraph, workPackageId: WorkPackageId): readonly WorkPackageId[] {
  return graph.workPackages
    .filter((workPackage) => workPackage.dependsOn.includes(workPackageId))
    .map((workPackage) => workPackage.workPackageId);
}

/**
 * 受影响节点的全部未接受后代（transitive dependents，不含受影响节点自身）。
 *
 * 「未接受」由调用方从生命周期事实给出：已接受节点不在补丁的处置范围内，因此也不会被隐式改写。
 * 一个本身也是受影响节点的后代仍会出现在结果里——补丁必须能自述「这个后代同时被重定义」，而不是让
 * 读补丁的人从 revise 数组里反推它的处境；调用方按需要排除（例如已由 `retire` 直接表达的节点）。
 */
export function unacceptedDescendants(input: {
  readonly graph: ExecutionGraph;
  readonly affected: readonly WorkPackageId[];
  readonly accepted: readonly WorkPackageId[];
}): readonly WorkPackageId[] {
  const accepted = new Set(input.accepted);
  const found = new Set<WorkPackageId>();
  const visited = new Set<WorkPackageId>(input.affected);
  const queue = [...input.affected];
  while (queue.length > 0) {
    const current = queue.shift() as WorkPackageId;
    for (const dependent of directDependents(input.graph, current)) {
      if (!visited.has(dependent)) {
        visited.add(dependent);
        queue.push(dependent);
      }
      if (!accepted.has(dependent)) {
        found.add(dependent);
      }
    }
  }
  return [...found].sort();
}

/** 未接受节点集合；供 Controller 从生命周期投影构造编译输入。 */
export function unacceptedWorkPackages(
  graph: ExecutionGraph,
  accepted: readonly WorkPackageId[],
): readonly WorkPackageId[] {
  const acceptedSet = new Set(accepted);
  return graph.workPackages
    .map((workPackage) => workPackage.workPackageId)
    .filter((workPackageId) => !acceptedSet.has(workPackageId));
}
