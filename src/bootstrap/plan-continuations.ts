/**
 * MOD-07：Plan 采用/延续事实的生产读取器（Owner: `m1-evolve-execution-graph` Extend）。
 *
 * `recordPlanContinuations` 只接受「已由宿主回读的事实」：被引用的接受记录是否仍在 Orca、证据是否仍适用、
 * 旧责任当前消耗多少。本模块把那些事实从**真实来源**拼出来——Branch Store 的原有结算/物化/图记录、
 * Orca `task-list` 的真实回读、canonical worktree 的只读 Git 检查，以及预算计数的 effectiveConsumption。
 *
 * 三条硬规则：
 * - **事实绝不伪造**：每个布尔都来自一次确定读取；读不回来返回 `null` 或矛盾事实，由用例阻塞或拒绝；
 * - **只读**：Git 只用 `merge-base --is-ancestor` 与 `diff --name-only`；不建 worktree、不改仓库；
 * - **同一身份重读**：同一次读取器调用按 Work Package 记忆结果，因此预检与落盘看到的是同一份事实。
 */

import type { CoordinationScopeId, GraphId, WorkPackageId } from '../application/dto/identity.js';
import type { OperationIntent } from '../application/dto/operation-intent.js';
import type {
  BranchCoordinationStore,
  DeliverySettlementRecord,
  MaterializationBindingRecord,
  GraphGenerationRecord,
} from '../application/ports/branch-coordination-store.js';
import type { ExecutionBackend } from '../application/ports/execution-backend.js';
import type { PlanContinuationFacts } from '../application/execution/baseline-adoption.js';
import { consumedBudgetForWorkPackage } from '../application/execution/advance-execution.js';
import { readScope } from '../application/planning/scope-read.js';
import { normalizeResultValue, resultDigest } from '../application/delivery/process-delivery.js';
import { integrationOperationIdsFor } from '../application/integrate-work-package.js';
import { workPackageIdFor } from '../domain/planning/graph-compiler.js';
import type { BudgetConsumption } from '../domain/dispatch-candidate.js';
import type {
  ExecutionGraph,
  ImplementationPlan,
  PlannedAdoption,
  PlannedWorkPackage,
} from '../domain/planning/execution-graph.js';
import { runProcess, type ProcessRunner } from '../adapters/orca-cli/process-runner.js';

export type PlanContinuationGitRead =
  | { readonly kind: 'ancestor' }
  | { readonly kind: 'not_ancestor' }
  | { readonly kind: 'unavailable'; readonly reason: string };

export type PlanContinuationChangedPaths =
  | { readonly kind: 'listed'; readonly paths: readonly string[] }
  | { readonly kind: 'unavailable'; readonly reason: string };

/** 只读 Git 事实来源；实现固定为参数数组调用，测试可注入替身。 */
export type PlanContinuationGitPort = {
  readonly isAncestor: (input: {
    readonly worktreePath: string;
    readonly ancestor: string;
    readonly descendant: string;
  }) => Promise<PlanContinuationGitRead>;
  readonly changedPaths: (input: {
    readonly worktreePath: string;
    readonly from: string;
    readonly to: string;
    /** 省略表示全部路径；给出时按 pathspec 限定。 */
    readonly paths?: readonly string[];
  }) => Promise<PlanContinuationChangedPaths>;
};

/** 参数数组加显式 cwd 的受限 Git 调用，与 baseline-observer 同一形态。 */
export function createPlanContinuationGitPort(runner: ProcessRunner = runProcess): PlanContinuationGitPort {
  const gitIn = (worktreePath: string) => (args: readonly string[]) =>
    runner({
      executable: 'git',
      args,
      cwd: worktreePath,
      env: process.env as Record<string, string>,
      timeoutMs: 15_000,
      limits: { maxBytes: 1024 * 1024, maxLines: 20_000 },
    });
  return {
    isAncestor: async ({ worktreePath, ancestor, descendant }) => {
      const result = await gitIn(worktreePath)(['merge-base', '--is-ancestor', ancestor, descendant]);
      if (result.kind === 'unavailable') return { kind: 'unavailable', reason: result.message };
      if (result.kind === 'unknown') return { kind: 'unavailable', reason: result.reason };
      if (result.exitCode === 0) return { kind: 'ancestor' };
      if (result.exitCode === 1) return { kind: 'not_ancestor' };
      return { kind: 'unavailable', reason: `git merge-base 退出码 ${String(result.exitCode)}` };
    },
    changedPaths: async ({ worktreePath, from, to, paths }) => {
      const args = ['diff', '--name-only', '-z', from, to];
      if (paths !== undefined && paths.length > 0) args.push('--', ...paths);
      const result = await gitIn(worktreePath)(args);
      if (result.kind === 'unavailable') return { kind: 'unavailable', reason: result.message };
      if (result.kind === 'unknown') return { kind: 'unavailable', reason: result.reason };
      if (result.exitCode !== 0) return { kind: 'unavailable', reason: `git diff 退出码 ${String(result.exitCode)}` };
      if (result.stdout.truncated) return { kind: 'unavailable', reason: 'git diff 输出被截断' };
      return { kind: 'listed', paths: result.stdout.text.split('\0').filter((entry) => entry.length > 0) };
    },
  };
}

export type PlanContinuationFactReaderContext = {
  readonly store: BranchCoordinationStore;
  readonly backend: ExecutionBackend;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly backendIdentityRef: string;
  /** 候选图绑定的 Replanning Baseline；采用声明必须与它一致。 */
  readonly baselineHead: string;
  readonly plan: ImplementationPlan;
  readonly graph: ExecutionGraph;
  /** canonical worktree 的只读 Git 证据来源；缺省时基线证据无法核验，按矛盾事实阻塞。 */
  readonly canonicalWorktreePath: string | null;
  /** 测试或替代实现用；缺省用参数数组的受限 Git 调用。 */
  readonly git?: PlanContinuationGitPort;
};

/** 每个声明节点回读一次事实；不可读返回 `null`。 */
export type PlanContinuationFactReader = (
  workPackageId: WorkPackageId,
) => Promise<PlanContinuationFacts | null>;

/** 宿主注入生产读取器的装配点。 */
export type PlanContinuationFactReaderFactory = (
  context: PlanContinuationFactReaderContext,
) => PlanContinuationFactReader;

/** `task-list` 回读只看的三个字段；形状不合法即 fail closed。 */
type OrcaTaskRecord = {
  readonly status: string | null;
  readonly result: unknown;
};

function readTaskRecord(value: unknown, taskId: string): OrcaTaskRecord | null {
  const rows = Array.isArray(value)
    ? value
    : typeof value === 'object' && value !== null && Array.isArray((value as Record<string, unknown>)['tasks'])
      ? ((value as Record<string, unknown>)['tasks'] as readonly unknown[])
      : null;
  if (rows === null) return null;
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const record = row as Record<string, unknown>;
    const id = record['id'] ?? record['taskId'] ?? record['task_id'];
    if (id !== taskId) continue;
    const status = record['status'];
    return { status: typeof status === 'string' ? status : null, result: record['result'] };
  }
  return null;
}

/** 接受结果引用形如 `<taskId>#<digest13>`；与 process-delivery 的回读构造同一约定。 */
function splitResultRef(ref: string): { readonly taskId: string; readonly digestPrefix: string } | null {
  const hashIndex = ref.indexOf('#');
  if (hashIndex <= 0 || hashIndex === ref.length - 1) return null;
  return { taskId: ref.slice(0, hashIndex), digestPrefix: ref.slice(hashIndex + 1) };
}

type RecheckResult =
  | { readonly kind: 'recorded' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'conflict'; readonly reason: string };

/** 旧结果必须仍在 Orca：同一 settlement.runId 上 `completed` 且归一化结果摘要匹配。 */
async function recheckAcceptedResult(input: {
  readonly backend: ExecutionBackend;
  readonly backendIdentityRef: string;
  readonly settlement: DeliverySettlementRecord;
  readonly ref: string;
}): Promise<RecheckResult> {
  const parsed = splitResultRef(input.ref);
  if (parsed === null) return { kind: 'missing' };
  const listed = await input.backend.query({
    operation: 'task-list',
    backendIdentityRef: input.backendIdentityRef,
    runId: input.settlement.runId,
  });
  if (listed.kind !== 'accepted') {
    return { kind: 'conflict', reason: `orca:无法回读 Run ${input.settlement.runId} 的 Task 列表：${listed.code}` };
  }
  const record = readTaskRecord(listed.value, parsed.taskId);
  if (record === null) return { kind: 'missing' };
  if (record.status !== 'completed') return { kind: 'missing' };
  if (record.result === null || record.result === undefined) return { kind: 'missing' };
  const observed = resultDigest(normalizeResultValue(record.result));
  if (!observed.startsWith(parsed.digestPrefix)) {
    return { kind: 'conflict', reason: `orca:回读结果摘要与接受记录 ${input.ref} 不一致` };
  }
  return { kind: 'recorded' };
}

/** 旧图是否为当前图的前代：沿 `predecessorGraphId` 从当前图回溯（含自身即非前代）。 */
function isPriorGeneration(input: {
  readonly generations: readonly { readonly graphId: string; readonly predecessorGraphId: string | null }[];
  readonly currentGraphId: string | null;
  readonly priorGraphId: string;
}): boolean {
  if (input.currentGraphId === null) return false;
  const byGraphId = new Map(input.generations.map((generation) => [generation.graphId, generation] as const));
  const visited = new Set<string>();
  let cursor: string | null = input.currentGraphId;
  while (cursor !== null && !visited.has(cursor)) {
    visited.add(cursor);
    if (cursor === input.priorGraphId) return true;
    cursor = byGraphId.get(cursor)?.predecessorGraphId ?? null;
  }
  return false;
}

/** 基线证据是否仍适用：旧集成 commit 是当前基线祖先，且它改动的路径在两者之间没有变化。 */
async function evaluateBaselineEvidence(input: {
  readonly adoption: PlannedAdoption;
  readonly baselineHead: string;
  readonly canonicalWorktreePath: string | null;
  readonly intents: readonly OperationIntent[];
  readonly binding: MaterializationBindingRecord;
  readonly generation: GraphGenerationRecord;
  readonly git: PlanContinuationGitPort;
}): Promise<{ readonly applicable: boolean; readonly conflicts: readonly string[] }> {
  const integrationRef = input.adoption.integrationRef;
  if (integrationRef === undefined || integrationRef.length === 0) {
    return { applicable: false, conflicts: [] };
  }
  const intent = input.intents.find(
    (candidate) =>
      candidate.operationId === integrationRef &&
      candidate.operationCategory === 'git-integration' &&
      candidate.state === 'settled' &&
      candidate.outcomeClass === 'accepted' &&
      candidate.target.kind === 'work-package',
  );
  if (intent === undefined) {
    return { applicable: false, conflicts: [`git:集成引用 ${integrationRef} 不是已接受的 git-integration 意图`] };
  }
  if (intent.target.id !== input.binding.workPackageId) {
    return { applicable: false, conflicts: ['git:push 意图的 Work Package 与被采用结果的物化绑定不一致'] };
  }
  const expectedPush = integrationOperationIdsFor({
    scopeId: input.binding.coordinationScopeId,
    graphId: input.generation.graphId,
    generation: input.generation.generation,
    workPackageId: input.binding.workPackageId,
  }).push;
  if (integrationRef !== expectedPush) {
    return {
      applicable: false,
      conflicts: [`git:集成引用 ${integrationRef} 不是被采用结果所属图代际的 push 步骤`],
    };
  }
  const oldCommit = intent.expectedHead;
  if (oldCommit === null) {
    return { applicable: false, conflicts: [`git:push 意图 ${integrationRef} 缺少 expected HEAD`] };
  }
  if (input.canonicalWorktreePath === null) {
    return { applicable: false, conflicts: ['git:缺少 canonical worktree 路径，无法核验基线证据'] };
  }
  const worktreePath = input.canonicalWorktreePath;
  const ancestry = await input.git.isAncestor({ worktreePath, ancestor: oldCommit, descendant: input.baselineHead });
  if (ancestry.kind === 'not_ancestor') {
    return { applicable: false, conflicts: ['git:旧集成 commit 不是当前基线的祖先'] };
  }
  if (ancestry.kind === 'unavailable') {
    return { applicable: false, conflicts: [`git:无法核验集成祖先关系：${ancestry.reason}`] };
  }
  const touched = await input.git.changedPaths({ worktreePath, from: `${oldCommit}^`, to: oldCommit });
  if (touched.kind === 'unavailable') {
    return { applicable: false, conflicts: [`git:无法读取旧集成 commit 的变更路径：${touched.reason}`] };
  }
  if (touched.paths.length === 0) {
    return { applicable: false, conflicts: ['git:旧集成 commit 没有可核验的变更路径'] };
  }
  const changedSince = await input.git.changedPaths({
    worktreePath,
    from: oldCommit,
    to: input.baselineHead,
    paths: touched.paths,
  });
  if (changedSince.kind === 'unavailable') {
    return { applicable: false, conflicts: [`git:无法比较旧集成 commit 与当前基线：${changedSince.reason}`] };
  }
  return { applicable: changedSince.paths.length === 0, conflicts: [] };
}

/**
 * 构造生产事实读取器。
 *
 * 只读：Store 查询、Orca `task-list`、受限 Git 与预算计数读取，不产生任何副作用。任一必需事实读不回来
 * 返回 `null`，由调用方按「不可读」拒绝，绝不用默认值补齐。
 */
export function createPlanContinuationFactReader(
  context: PlanContinuationFactReaderContext,
): PlanContinuationFactReader {
  const git = context.git ?? createPlanContinuationGitPort();
  const plannedByWorkPackageId = new Map<WorkPackageId, PlannedWorkPackage>();
  for (const planned of context.plan.workPackages) {
    plannedByWorkPackageId.set(workPackageIdFor(context.graph.graphId, planned.key), planned);
  }
  const cache = new Map<WorkPackageId, PlanContinuationFacts | null>();

  const read = async (workPackageId: WorkPackageId): Promise<PlanContinuationFacts | null> => {
    const planned = plannedByWorkPackageId.get(workPackageId);
    if (planned?.adoption === undefined && planned?.lineage === undefined) return null;

    const conflictingFacts: string[] = [];
    let acceptedResultRecorded = false;
    let evidenceStillApplicable = false;
    let newWorktreeBasedOnBaseline = false;

    const bindings = context.store.query({
      kind: 'materialization-bindings',
      coordinationScopeId: context.coordinationScopeId,
      workPackageId,
    });
    if (bindings.kind !== 'materialization-bindings') return null;

    if (planned?.adoption !== undefined) {
      const adoption = planned.adoption;
      const baselineMatches = adoption.baselineHead === context.baselineHead;
      if (!baselineMatches) {
        conflictingFacts.push(`git:采用声明的基线 ${adoption.baselineHead} 不是候选图基线 ${context.baselineHead}`);
      }
      if (bindings.bindings.length > 0) {
        conflictingFacts.push(`orca:Work Package ${workPackageId} 已有物化绑定，不是基于当前基线的全新节点`);
      }
      newWorktreeBasedOnBaseline = baselineMatches && bindings.bindings.length === 0;

      const settlements = context.store.query({
        kind: 'delivery-settlements',
        coordinationScopeId: context.coordinationScopeId,
      });
      if (settlements.kind !== 'delivery-settlements') return null;
      const matchingSettlements = settlements.settlements.filter(
        (candidate) => candidate.orcaResultRef === adoption.adoptedResultRef,
      );
      if (matchingSettlements.length > 1) {
        conflictingFacts.push(`orca:接受记录 ${adoption.adoptedResultRef} 对应多个结算身份`);
      }
      const settlement = matchingSettlements.length === 1 ? matchingSettlements[0] : undefined;
      if (settlement !== undefined) {
        if (settlement.outcome !== 'succeeded') {
          conflictingFacts.push(`orca:接受记录 ${adoption.adoptedResultRef} 的结果不是成功`);
        } else {
          const recheck = await recheckAcceptedResult({
            backend: context.backend,
            backendIdentityRef: context.backendIdentityRef,
            settlement,
            ref: adoption.adoptedResultRef,
          });
          if (recheck.kind === 'recorded') {
            acceptedResultRecorded = true;
          } else if (recheck.kind === 'conflict') {
            conflictingFacts.push(recheck.reason);
          }
        }
      }

      if (adoption.kind === 'baseline_adoption' && settlement !== undefined) {
        const originalBindings = context.store.query({
          kind: 'materialization-bindings',
          coordinationScopeId: context.coordinationScopeId,
        });
        if (originalBindings.kind !== 'materialization-bindings') return null;
        const segments = context.store.query({ kind: 'session-segments', coordinationScopeId: context.coordinationScopeId });
        if (segments.kind !== 'session-segments') return null;
        const taskId = splitResultRef(adoption.adoptedResultRef)?.taskId;
        const matchedBindings = originalBindings.bindings.filter((binding) =>
          binding.identity === 'issued' && binding.orcaTaskId === taskId &&
          binding.workerTaskId === settlement.workerTaskId &&
          binding.attemptId === settlement.attemptId && binding.role === settlement.role &&
          segments.segments.some(segment => segment.workPackageId === binding.workPackageId &&
            segment.workerTaskId === binding.workerTaskId && segment.attemptId === binding.attemptId &&
            segment.role === binding.role && segment.dispatchId === settlement.dispatchId && segment.verifiable) &&
          ((binding.role !== 'implementation' && binding.role !== 'validator') ||
            binding.specBinding?.contractRevision === settlement.contractRevision),
        );
        const generations = context.store.query({
          kind: 'graph-generations',
          coordinationScopeId: context.coordinationScopeId,
        });
        if (generations.kind !== 'graph-generations') return null;
        const matchedGenerations = generations.generations.filter((generation) => generation.orcaRunId === settlement.runId);
        const binding = matchedBindings.length === 1 ? matchedBindings[0] : undefined;
        const generation = matchedGenerations.length === 1 ? matchedGenerations[0] : undefined;
        if (binding === undefined || generation === undefined) {
          conflictingFacts.push('orca:被采用结果的原物化绑定或图代际缺失、身份不符或不唯一');
        } else {
          const versions = context.store.query({
            kind: 'graph-versions',
            coordinationScopeId: context.coordinationScopeId,
            graphId: generation.graphId,
          });
          if (versions.kind !== 'graph-versions') return null;
          const scope = readScope(context.store, context.coordinationScopeId);
          if (scope.kind === 'rejected') return null;
          const member = versions.versions.some((version) =>
            version.graph.workPackages.some((wp) => wp.workPackageId === binding.workPackageId),
          );
          if (!member || !isPriorGeneration({
            generations: generations.generations,
            currentGraphId: scope.scope.graphId,
            priorGraphId: generation.graphId,
          })) {
            conflictingFacts.push('graph:被采用结果的 Work Package 不属于可证明的前代图');
          } else {
            const intents = context.store.query({
              kind: 'intents',
              coordinationScopeId: context.coordinationScopeId,
            });
            if (intents.kind !== 'intents') return null;
            const evidence = await evaluateBaselineEvidence({
              adoption,
              baselineHead: context.baselineHead,
              canonicalWorktreePath: context.canonicalWorktreePath,
              intents: intents.intents,
              binding,
              generation,
              git,
            });
            evidenceStillApplicable = evidence.applicable;
            conflictingFacts.push(...evidence.conflicts);
          }
        }
      }
    }

    let priorConsumed: readonly BudgetConsumption[] = [];
    if (planned?.lineage !== undefined) {
      const priorWorkPackageId = planned.lineage.priorWorkPackageId as WorkPackageId;
      const priorGraphId = planned.lineage.priorGraphId as GraphId;
      const consumed = consumedBudgetForWorkPackage(
        context.store,
        context.coordinationScopeId,
        priorWorkPackageId,
      );
      if (consumed === null) return null;
      priorConsumed = consumed;

      const scopeRead = readScope(context.store, context.coordinationScopeId);
      if (scopeRead.kind === 'rejected') return null;
      const generations = context.store.query({
        kind: 'graph-generations',
        coordinationScopeId: context.coordinationScopeId,
      });
      if (generations.kind !== 'graph-generations') return null;
      if (!generations.generations.some((generation) => generation.graphId === priorGraphId)) {
        conflictingFacts.push(`graph:旧责任所属图 ${priorGraphId} 没有世代记录`);
      } else if (!isPriorGeneration({
        generations: generations.generations,
        currentGraphId: scopeRead.scope.graphId,
        priorGraphId,
      })) {
        conflictingFacts.push(`graph:旧责任所属图 ${priorGraphId} 不是当前代际的前代`);
      }
      const versions = context.store.query({
        kind: 'graph-versions',
        coordinationScopeId: context.coordinationScopeId,
        graphId: priorGraphId,
      });
      if (versions.kind !== 'graph-versions') return null;
      const member = versions.versions.some((version) =>
        version.graph.workPackages.some((workPackage) => workPackage.workPackageId === priorWorkPackageId),
      );
      if (!member) {
        conflictingFacts.push(`graph:旧 Work Package ${priorWorkPackageId} 不属于图 ${priorGraphId}`);
      }
    }

    return {
      acceptedResultRecorded,
      evidenceStillApplicable,
      conflictingFacts,
      materialReadOnly: true,
      newWorktreeBasedOnBaseline,
      priorConsumed,
    };
  };

  return async (workPackageId) => {
    const cached = cache.get(workPackageId);
    if (cached !== undefined) return cached;
    const facts = await read(workPackageId);
    cache.set(workPackageId, facts);
    return facts;
  };
}
