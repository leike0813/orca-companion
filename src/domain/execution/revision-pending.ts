/**
 * IC-10 / IP-5：revision pending 的有界持有（Owner: `m1-evolve-execution-graph`，D8）。
 *
 * 持有是**调度**事实，不是 Worker 取消：受影响 Work Package 的当前 Worker 继续运行至可核验终态，但其后
 * 不再派发后续角色或依赖工作；与它无拓扑关系的节点仍按既有准入规则进入 Execution Frontier。
 *
 * 三个断言面因此被显式表达出来：
 * - `frozen`：受影响节点与其未接受后代——恰好这些，不多不少；
 * - `admissible`：未被冻结、依赖已通过且尚未接受的节点；
 * - `evaluateHeldResult`：受持有影响的旧结果不得越过持有推进生命周期或集成。
 *
 * 纯判定：不读存储、不派发、不杀死任何 Worker。
 */

import type { WorkPackageId } from '../../application/dto/identity.js';
import type { ExecutionGraph } from '../planning/execution-graph.js';
import { unacceptedDescendants } from './graph-patch.js';

export type RevisionHold = {
  readonly workPackageId: WorkPackageId;
  readonly source: 'graph_patch' | 'specification_revision' | 'retirement';
  readonly sourceRef: string;
};

export type RevisionPendingProjection = {
  /** 被冻结的节点：每个未释放持有对应的受影响节点与其未接受后代。 */
  readonly frozen: readonly WorkPackageId[];
  /** 仍可进入 Execution Frontier 的节点；并发上限为 1 不是拓扑准入限制。 */
  readonly admissible: readonly WorkPackageId[];
};

export type RevisionPendingInput = {
  readonly graph: ExecutionGraph;
  /** 只包含仍未释放的持有。 */
  readonly holds: readonly RevisionHold[];
  readonly accepted: readonly WorkPackageId[];
  /** 图依赖已通过的 Work Package。 */
  readonly dependenciesSatisfied: readonly WorkPackageId[];
};

/** 被持有冻结的节点集合：受影响节点加上它们的未接受后代。 */
export function frozenWorkPackageIds(input: {
  readonly graph: ExecutionGraph;
  readonly holds: readonly RevisionHold[];
  readonly accepted: readonly WorkPackageId[];
}): readonly WorkPackageId[] {
  const affected = [...new Set(input.holds.map((hold) => hold.workPackageId))];
  if (affected.length === 0) {
    return [];
  }
  const descendants = unacceptedDescendants({
    graph: input.graph,
    affected,
    accepted: input.accepted,
  });
  return [...new Set<WorkPackageId>([...affected, ...descendants])].sort();
}

/**
 * 投影持有期间的准入结果。
 *
 * 判定顺序刻意保持简单：先算冻结集合，再从「未接受且依赖已通过」的节点里减去冻结集合。因此无关节点
 * 继续可准入，而受影响节点及其后代既不会成为候选，也不会因为并发上限为 1 而把无关工作一起挡下。
 */
export function projectRevisionPending(input: RevisionPendingInput): RevisionPendingProjection {
  const frozen = frozenWorkPackageIds(input);
  const frozenSet = new Set(frozen);
  const accepted = new Set(input.accepted);
  const admissible = input.graph.workPackages
    .map((workPackage) => workPackage.workPackageId)
    .filter(
      (workPackageId) =>
        !frozenSet.has(workPackageId) &&
        !accepted.has(workPackageId) &&
        input.dependenciesSatisfied.includes(workPackageId),
    )
    .sort();
  return { frozen, admissible };
}

/** 该节点此刻是否被持有冻结：它的后续角色与依赖工作都不得派发。 */
export function isFrozen(projection: RevisionPendingProjection, workPackageId: WorkPackageId): boolean {
  return projection.frozen.includes(workPackageId);
}

export type HoldReleaseFacts = {
  /** 受影响节点的当前 Worker 是否已到可核验终态。 */
  readonly currentWorkerSettled: boolean;
  /** 修订是否已被接受（重新准入通过或图重定义已提交）。 */
  readonly revisionAccepted: boolean;
  /** 节点是否已被 retire。 */
  readonly nodeRetired: boolean;
};

/**
 * 持有能否解除。
 *
 * 解除需要两件事同时成立：当前 Worker 已结清，且修订被接受或节点被退休。只满足其中一个就解除会让
 * 旧结果越过未完成的修订，或在 Worker 仍在运行时改变它脚下的契约。
 */
export function mayReleaseHold(facts: HoldReleaseFacts): boolean {
  return facts.currentWorkerSettled && (facts.revisionAccepted || facts.nodeRetired);
}

export type HeldResultVerdict =
  | { readonly kind: 'may_advance' }
  | { readonly kind: 'blocked_by_hold'; readonly workPackageId: WorkPackageId; readonly reason: string };

/**
 * 旧结果此刻能否推进生命周期或集成。
 *
 * 受持有影响的节点一律阻止：旧结果的证据描述的是修订前的契约，越过持有推进会让两种契约同时在图上
 * 成立。
 */
export function evaluateHeldResult(input: {
  readonly frozen: readonly WorkPackageId[];
  readonly workPackageId: WorkPackageId;
}): HeldResultVerdict {
  if (!input.frozen.includes(input.workPackageId)) {
    return { kind: 'may_advance' };
  }
  return {
    kind: 'blocked_by_hold',
    workPackageId: input.workPackageId,
    reason: `Work Package ${input.workPackageId} 处于 revision pending，旧结果不得越过持有推进`,
  };
}
