/**
 * IC-08 / IP-B5：受控 Git 集成的固定顺序 Integration Operation
 * （Owner: `m1-execute-and-validate-work-packages`）。
 *
 * 只有 Validator 已接受结果、且当前 Session 仍是 Execution Coordination Lease 持有者时，才可以按
 * Execution Authorization 的 Git Integration Policy 执行集成。顺序固定且不可重排：
 *
 * 1. 核验已接受的验证结果与 Lease 持有；
 * 2. 核验 Git Integration Policy；
 * 3. 每个步骤先持久化 Operation Intent 与 expected HEAD，再执行该步骤；
 * 4. 执行 commit → 集成 canonical 分支 → 推送唯一获批 remote/ref；
 * 5. 按步骤自己的目标回读核验 HEAD（commit 核验 source worktree、integrate 核验 canonical、
 *    push 核验获批 remote/ref），完成 Intent。
 *
 * 任一步 `unknown` 时以同一 OperationId 对账，不换 ID 重试，也不继续后续步骤。这里不使用 shell：
 * 副作用由注入的 `GitIntegrationPort` 完成，本模块只拥有顺序、准入与对账规则。
 */

import type { CoordinationScopeId, OperationId, WorkPackageId } from './dto/identity.js';
import type { OperationOutcome } from './dto/operation-outcome.js';
import type { BranchCoordinationStore, CoordinationSnapshot, CoordinationWriter } from './ports/branch-coordination-store.js';
import {
  buildExecutionScope,
  type ExecutionAuthority,
  type ExecutionScope,
} from './ports/execution-backend.js';
import { beginIntent, blockLane, resolveLane, settleIntent } from './coordination/intent-service.js';
import { readScope } from './planning/scope-read.js';
import {
  evaluateGitIntegration,
  type GitIntegrationDecision,
  type GitIntegrationRequest,
} from '../domain/git-integration-policy.js';
import { nextIntegrationRound } from '../domain/git-integration-policy.js';
import type { GitIntegrationPolicy, RoleAuthorities } from '../domain/planning/execution-authorization.js';
import type { WorkPackageStatus } from '../domain/work-package-status.js';
import {
  runIntegrationReconciliationRound,
  type IntegrationReconciliationContext,
} from './integration-reconciliation.js';

/** 集成步骤闭集；顺序即数组顺序。 */
export const GIT_INTEGRATION_STEPS = ['commit', 'integrate_canonical', 'push'] as const;

export type GitIntegrationStep = (typeof GIT_INTEGRATION_STEPS)[number];

/**
 * 合并树复验的两个 Git 步骤。
 *
 * 它们不进入 GIT_INTEGRATION_STEPS 的线性顺序：只在 canonical 已前移时按有限轮次执行，每步都先登记
 * Operation Intent 再执行，重放只按同一 OperationId 对账。
 */
export const GIT_RECONCILIATION_STEPS = ['merge_canonical', 'merge_commit'] as const;

export type GitReconciliationStep = (typeof GIT_RECONCILIATION_STEPS)[number];

export type GitStepKind = GitIntegrationStep | GitReconciliationStep;

export type GitStepRequest = {
  readonly step: GitStepKind;
  readonly workPackageId: WorkPackageId;
  /** 精确 Worker worktree：commit 步的 cwd 与 source 读回目标。 */
  readonly sourceWorktreePath: string;
  /** 获批的 canonical 分支：Policy 的核验目标，不是要合并进来的源。 */
  readonly branch: string;
  /**
   * 要合并/推送的**源**分支：Work Package 隔离 worktree 自己的分支。
   *
   * 它与 `branch` 必须分开：canonical 分支也是「分支」，但把它当源会让 `merge --ff-only` 变成自我合并，
   * 报告成功而什么都没集成。
   */
  readonly sourceBranch: string;
  readonly remote: string | null;
  readonly ref: string | null;
  readonly expectedHead: string;
  /** 已复验的精确树 OID；merge_commit 步必填：提交前/后都必须与它一致，错误树不得进入 canonical。 */
  readonly expectedTree?: string | null;
  readonly commitMessage: string | null;
};

/** 读回目标闭集：每一步只核验自己的目标。 */
export type GitReadbackTarget =
  | { readonly kind: 'source'; readonly worktreePath: string }
  | { readonly kind: 'canonical' }
  | { readonly kind: 'remote'; readonly remote: string; readonly ref: string };

export type GitHeadRead =
  | { readonly kind: 'read'; readonly head: string }
  | { readonly kind: 'unavailable'; readonly reason: string };

/** 祖先关系只读探针：`unavailable` 表示无法证明，不能当作 `no`。 */
export type GitAncestryRead =
  | { readonly kind: 'yes' }
  | { readonly kind: 'no' }
  | { readonly kind: 'unavailable'; readonly reason: string };

/** 精确树读回：合并复验要绑定的是 worktree 当前 index 的树 OID。 */
export type GitTreeRead =
  | { readonly kind: 'read'; readonly tree: string }
  | { readonly kind: 'unavailable'; readonly reason: string };

export type GitStepOutcome =
  | { readonly kind: 'committed'; readonly head: string }
  | { readonly kind: 'integrated'; readonly head: string }
  | { readonly kind: 'pushed'; readonly remote: string; readonly ref: string; readonly head: string }
  /** `merge_canonical`：已在包 worktree 内把 canonical HEAD 合并进 index（`--no-commit`）。 */
  | { readonly kind: 'merge_applied'; readonly conflicts: readonly string[] }
  /** `merge_canonical`：canonical 已是包 HEAD 的祖先，无需合并。 */
  | { readonly kind: 'already_merged' }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string }
  | { readonly kind: 'unknown'; readonly reason: string };

/**
 * Git 副作用 seam。
 *
 * M0 登记的 Orca 操作目录只覆盖 worktree、Task、Dispatch 与 Delivery，没有 Git 变更操作，因此集成
 * 能力以这个端口表达：Companion 不实现 Git 客户端，也不用 shell 代替 `ExecutionBackend`。
 */
export type GitIntegrationPort = {
  readonly run: (request: GitStepRequest, scope: ExecutionScope) => Promise<GitStepOutcome>;
  /** 只按同一 OperationId 对账，不得创建新的 Git 操作。 */
  readonly reconcile: (request: GitStepRequest, scope: ExecutionScope) => Promise<GitStepOutcome>;
  /** 只读回读指定目标的 HEAD。 */
  readonly readHead: (target: GitReadbackTarget) => Promise<GitHeadRead>;
  /** 只读判断祖先关系；无法核验时必须返回 `unavailable`，不得推断成 `no`。 */
  readonly isAncestor: (input: {
    readonly ancestor: string;
    readonly descendant: string;
  }) => Promise<GitAncestryRead>;
  /** 只读回读 worktree 当前 index 的精确树 OID。 */
  readonly readTree: (input: { readonly worktreePath: string }) => Promise<GitTreeRead>;
};

/** 集成涉及的两个精确 worktree；canonical 路径只用于构造 adapter。 */
export type IntegrationWorkspace = {
  readonly canonicalWorktreePath: string;
  readonly workPackageWorktreePath: string;
};

export type IntegrationOperationIds = {
  readonly commit: OperationId;
  readonly integrate: OperationId;
  readonly push: OperationId;
};

/** 与已发出的集成意图保持同一身份；完成判定只认最后一步 push。 */
export function integrationOperationIdsFor(input: {
  readonly scopeId: CoordinationScopeId;
  readonly graphId: string;
  readonly generation: number;
  readonly workPackageId: WorkPackageId;
}): IntegrationOperationIds {
  const segments = [input.scopeId, input.graphId, String(input.generation), input.workPackageId]
    .map((segment) => encodeURIComponent(segment));
  const suffix = segments.join(':');
  return {
    commit: `git-integration-commit:${suffix}` as OperationId,
    integrate: `git-integration-integrate:${suffix}` as OperationId,
    push: `git-integration-push:${suffix}` as OperationId,
  };
}

export function completedIntegrationRef(
  snapshot: Pick<CoordinationSnapshot, 'scope' | 'graphGenerations' | 'settledGitIntegrationIntents'>,
  workPackageId: WorkPackageId,
): OperationId | null {
  const graphId = snapshot.scope.graphId;
  const generation = snapshot.graphGenerations.find((entry) => entry.graphId === graphId);
  if (graphId === null || generation === undefined) return null;
  const pushId = integrationOperationIdsFor({
    scopeId: snapshot.scope.coordinationScopeId,
    graphId,
    generation: generation.generation,
    workPackageId,
  }).push;
  return snapshot.settledGitIntegrationIntents.some((intent) =>
    intent.operationId === pushId && intent.operationCategory === 'git-integration' &&
    intent.state === 'settled' && intent.outcomeClass === 'accepted' &&
    intent.target.kind === 'work-package' && intent.target.id === workPackageId,
  ) ? pushId : null;
}

export type IntegrateWorkPackageInput = {
  readonly port: GitIntegrationPort;
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly writer: CoordinationWriter;
  readonly expectedRevision: number;
  readonly backendIdentityRef: string;
  /** 当前图身份；合并复验轮次的稳定身份与运行依据从这里派生。 */
  readonly graphId: string;
  readonly graphGeneration: number;
  readonly authorizationId: string;
  readonly runId: string;
  readonly consumerGeneration: number;
  readonly timeoutMs: number;
  readonly workPackageId: WorkPackageId;
  readonly status: WorkPackageStatus;
  /** 当前 Session 是否持有本 Scope 的 Execution Coordination Lease。 */
  readonly executionLeaseHeldByCurrentSession: boolean;
  readonly authority: RoleAuthorities;
  readonly policy: GitIntegrationPolicy;
  /** 授权范围内的目标；remote/ref 只在 push 与 integrate 步骤使用。 */
  readonly request: GitIntegrationRequest;
  /** 两个精确 worktree：canonical 集成目标与 Worker source。 */
  readonly workspace: IntegrationWorkspace;
  readonly baselineHead: string;
  readonly commitMessage: string;
  readonly operationIds: IntegrationOperationIds;
  /**
   * 合并树复验的装配；`null` 表示本进程没有复验能力。
   *
   * 只有装配存在时，canonical 前移才会走「合并 → 原 Validator 复验 → 普通 merge commit → fast-forward」
   * 的有界轮次；没有装配时保持旧的确定性行为（canonical 不是祖先即拒绝），不静默降级成未复验的集成。
   */
  readonly reconciliation: IntegrationReconciliationContext | null;
};

export type IntegrationFailure = {
  readonly code: string;
  readonly message: string;
  /** 越界或被拒绝的具体部分；无则为空数组。 */
  readonly outOfScope: readonly string[];
};

export type IntegrateWorkPackageResult =
  | { readonly kind: 'integrated'; readonly head: string; readonly steps: readonly GitIntegrationStep[] }
  | { readonly kind: 'rejected'; readonly failure: IntegrationFailure }
  | { readonly kind: 'unknown'; readonly operationId: OperationId; readonly reason: string }
  | { readonly kind: 'blocked'; readonly laneKey: string; readonly reason: string };

function rejection(
  code: string,
  message: string,
  outOfScope: readonly string[] = [],
): IntegrateWorkPackageResult {
  return { kind: 'rejected', failure: { code, message, outOfScope } };
}

function decisionFailure(decision: Extract<GitIntegrationDecision, { kind: 'denied' }>): IntegrateWorkPackageResult {
  return rejection(decision.code, decision.message, decision.outOfScope);
}

/** 把 Git 步骤结果映射到统一三值，`unknown` 因此沿用 IC-02 的对账语义。 */
function asOperationOutcome(
  outcome: GitStepOutcome,
  operationId: OperationId,
  target: { readonly kind: string; readonly id: string },
): OperationOutcome<unknown> {
  if (outcome.kind === 'rejected') {
    return { kind: 'rejected', code: outcome.code, message: outcome.message };
  }
  if (outcome.kind === 'unknown') {
    return { kind: 'unknown', operation: { operationId, target }, reason: outcome.reason };
  }
  return { kind: 'accepted', operation: { operationId, target }, value: outcome };
}

function headOf(outcome: GitStepOutcome): string | null {
  return outcome.kind === 'committed' || outcome.kind === 'integrated' || outcome.kind === 'pushed'
    ? outcome.head
    : null;
}

/** 读回目标的诊断名；blocked reason 必须指名是哪个目标。 */
function readbackLabel(target: GitReadbackTarget): string {
  if (target.kind === 'source') return 'source HEAD';
  if (target.kind === 'canonical') return 'canonical HEAD';
  return `remote ${target.remote} ${target.ref} 的 HEAD`;
}

function executionScope(
  input: IntegrateWorkPackageInput,
  operationId: OperationId,
  target: { readonly kind: string; readonly id: string },
  expectedRevision: number,
): ExecutionScope {
  const authority: ExecutionAuthority = {
    kind: 'execution_coordination',
    graphGeneration: input.graphGeneration,
    authorizationId: input.authorizationId,
    runId: input.runId,
    consumerGeneration: input.consumerGeneration,
  };
  return buildExecutionScope({
    coordinationScopeId: input.coordinationScopeId,
    coordinatorSessionId: input.writer.coordinatorSessionId,
    runtimeIncarnationId: input.writer.runtimeIncarnationId,
    fencingGeneration: input.writer.fencingGeneration,
    backendIdentityRef: input.backendIdentityRef,
    operationId,
    target,
    expectedRevision,
    timeoutMs: input.timeoutMs,
    authority,
  });
}

/**
 * 执行一次受控集成。
 *
 * 判定顺序与副作用顺序都固定；任何一步失败都停在原处，不执行后续步骤，也不产生部分集成结果。
 */
export async function integrateWorkPackage(
  input: IntegrateWorkPackageInput,
): Promise<IntegrateWorkPackageResult> {
  // 步骤 1：只有 Validator 已接受的结果才可集成；仅完成实现不能进入这里。
  if (input.status.workPackageId !== input.workPackageId) {
    return rejection('work_package_mismatch', '验证状态不属于待集成的 Work Package');
  }
  if (input.status.validation.kind !== 'validated') {
    return rejection(
      'validation_not_accepted',
      `Work Package ${input.workPackageId} 的验证状态为 ${input.status.validation.kind}，不接受集成`,
    );
  }
  if (!input.executionLeaseHeldByCurrentSession) {
    return rejection('lease_not_held', '只有 Execution Coordination Lease 持有者可以执行集成');
  }

  // 步骤 2：Policy 核验。commit 只需 canonical 分支；integrate 与 push 还需要获批 remote/ref。
  const policyDecisions = [
    evaluateGitIntegration({ policy: input.policy, authority: input.authority, request: input.request }),
    evaluateGitIntegration({ policy: input.policy, authority: input.authority, request: { ...input.request, kind: 'commit', remote: null, ref: null } }),
  ];
  for (const decision of policyDecisions) {
    if (decision.kind === 'denied') {
      return decisionFailure(decision);
    }
  }
  if (input.request.kind !== 'integrate_canonical') {
    return rejection('unsupported_integration_request', `完整集成只接受 integrate_canonical 请求，实际为 ${input.request.kind}`);
  }
  const approvedRemote = input.request.remote;
  const approvedRef = input.request.ref;
  if (approvedRemote === null || approvedRef === null) {
    return rejection('missing_remote_or_ref', '集成与推送必须指定获批的 remote 与 ref');
  }

  const current = readScope(input.store, input.coordinationScopeId);
  if (current.kind === 'rejected') {
    return rejection(current.code, current.message);
  }
  if (current.scope.revision !== input.expectedRevision) {
    return rejection(
      'stale_revision',
      `expected revision ${input.expectedRevision} 已过期，当前为 ${current.scope.revision}`,
    );
  }

  const target = { kind: 'work-package', id: input.workPackageId };
  const operationIdFor: Readonly<Record<GitIntegrationStep, OperationId>> = {
    commit: input.operationIds.commit,
    integrate_canonical: input.operationIds.integrate,
    push: input.operationIds.push,
  };

  /** 步骤 → 读回目标；intent 重放与正常路径共用同一映射。 */
  const readbackFor = (step: GitIntegrationStep): GitReadbackTarget => {
    if (step === 'commit') {
      return { kind: 'source', worktreePath: input.workspace.workPackageWorktreePath };
    }
    if (step === 'integrate_canonical') {
      return { kind: 'canonical' };
    }
    return { kind: 'remote', remote: approvedRemote, ref: approvedRef };
  };

  // 每步只核验自己的目标：commit 核验 source worktree，integrate/push 核验 canonical。因此这里按目标
  // 分别记录 expected HEAD，而不是把上一步的回读值顺延给下一步——commit 后 source HEAD 已经前移，
  // 拿它去核验 canonical 会必然不符。
  let sourceExpectedHead = input.baselineHead;
  let canonicalExpectedHead: string | null = null;
  const expectedHeadFor = (step: GitIntegrationStep): string =>
    step === 'commit' ? sourceExpectedHead : (canonicalExpectedHead ?? sourceExpectedHead);
  const recordExpectedHead = (step: GitIntegrationStep, head: string): void => {
    if (step === 'commit') {
      sourceExpectedHead = head;
      return;
    }
    canonicalExpectedHead = head;
  };

  // canonical 的核验基准必须在任何 mutation 之前读到：读不到就不进入集成。
  const canonicalBefore = await input.port.readHead({ kind: 'canonical' });
  if (canonicalBefore.kind === 'unavailable') {
    return {
      kind: 'blocked',
      laneKey: input.workPackageId,
      reason: `无法在集成前回读 canonical HEAD：${canonicalBefore.reason}`,
    };
  }
  canonicalExpectedHead = canonicalBefore.head;

  const completed: GitIntegrationStep[] = [];

  /**
   * 合并树复验轮次。
   *
   * canonical 已前移时，在包 worktree 里合并当前已归属的 canonical HEAD，由原 Validator Session 复验
   * 精确合并树，再创建普通 merge commit 使 canonical 成为其后继；随后 `merge --ff-only` 才能推进
   * canonical。每轮独立有限，且集成整体串行（本函数只处理一个包）。canonical 再次前移时用下一轮
   * 处理；额度耗尽即阻塞，不重置、不跳过复验。
   */
  const reconcileRounds = async (): Promise<
    | { readonly kind: 'ok'; readonly canonicalHead: string }
    | { readonly kind: 'result'; readonly result: IntegrateWorkPackageResult }
  > => {
    const reconciliation = input.reconciliation;
    if (reconciliation === null) {
      return {
        kind: 'result',
        result: rejection('reconciliation_unavailable', 'canonical 已前移但没有可用的集成复验装配'),
      };
    }
    let canonicalHead = canonicalExpectedHead ?? sourceExpectedHead;
    for (;;) {
      const listed = reconciliation.store.list(input.coordinationScopeId, input.workPackageId);
      if (listed.kind === 'rejected') {
        return {
          kind: 'result',
          result: {
            kind: 'blocked',
            laneKey: input.workPackageId,
            reason: '无法读取集成复验轮次：' + listed.message,
          },
        };
      }
      const existingRounds = listed.records;
      // pending 与 blocked 都是「未完成但可续办」的轮次；只有 validated/rejected 是终态。
      const unfinished = [...existingRounds]
        .reverse()
        .find((entry) => entry.state === 'pending' || entry.state === 'blocked');
      let roundNumber: number;
      let roundTargetHead: string;
      if (unfinished !== undefined) {
        // 恢复未完成轮次：targetHead 固定为原记录值，绝不覆盖成当前 canonical——同一天然身份若用不同
        // 载荷重放会被 store 拒绝而永久阻塞。先沿原目标结清该轮，再用下一额度轮次追新 head。
        roundNumber = unfinished.round;
        roundTargetHead = unfinished.targetHead;
      } else {
        const ancestry = await input.port.isAncestor({
          ancestor: canonicalHead,
          descendant: sourceExpectedHead,
        });
        if (ancestry.kind === 'unavailable') {
          return {
            kind: 'result',
            result: {
              kind: 'blocked',
              laneKey: input.workPackageId,
              reason: `无法核验 canonical HEAD 与包 HEAD 的祖先关系：${ancestry.reason}`,
            },
          };
        }
        if (ancestry.kind === 'yes') {
          // 已完成但 ack 未决的轮次必须在恢复时补 ack；ack 幂等，未决时保持阻塞，不继续下一步。
          const validated = [...existingRounds].reverse().find((entry) => entry.state === 'validated');
          if (validated !== undefined) {
            const acknowledged = await reconciliation.acknowledgeResult(validated);
            if (acknowledged.kind === 'blocked') {
              return {
                kind: 'result',
                result: { kind: 'blocked', laneKey: input.workPackageId, reason: acknowledged.reason },
              };
            }
          }
          return { kind: 'ok', canonicalHead };
        }
        const verdict = nextIntegrationRound(existingRounds.length, reconciliation.limit);
        if (verdict.kind === 'budget_exhausted') {
          return {
            kind: 'result',
            result: {
              kind: 'blocked',
              laneKey: input.workPackageId,
              reason: '集成复验预算已耗尽（' + String(existingRounds.length) + '/' + String(reconciliation.limit) + '）',
            },
          };
        }
        roundNumber = verdict.round;
        roundTargetHead = canonicalHead;
      }
      const round = await runIntegrationReconciliationRound({
        port: input.port,
        reconciliation,
        store: input.store,
        writer: input.writer,
        coordinationScopeId: input.coordinationScopeId,
        graphId: input.graphId,
        graphGeneration: input.graphGeneration,
        authorizationId: input.authorizationId,
        runId: input.runId,
        consumerGeneration: input.consumerGeneration,
        backendIdentityRef: input.backendIdentityRef,
        timeoutMs: input.timeoutMs,
        workPackageId: input.workPackageId,
        worktreePath: input.workspace.workPackageWorktreePath,
        canonicalHead: roundTargetHead,
        round: roundNumber,
        commitMessage: input.commitMessage,
      });
      if (round.kind === 'completed') {
        // 合并提交让包 HEAD 前移；canonical 也可能在这段时间里再次前移，因此每轮都重新读取。
        if (round.packageHead.length > 0) {
          sourceExpectedHead = round.packageHead;
        }
        const after = await input.port.readHead({ kind: 'canonical' });
        if (after.kind === 'unavailable') {
          return {
            kind: 'result',
            result: {
              kind: 'blocked',
              laneKey: input.workPackageId,
              reason: `无法回读 canonical HEAD：${after.reason}`,
            },
          };
        }
        canonicalHead = after.head;
        continue;
      }
      if (round.kind === 'unknown') {
        return { kind: 'result', result: { kind: 'unknown', operationId: round.operationId, reason: round.reason } };
      }
      if (round.kind === 'rejected') {
        return { kind: 'result', result: rejection(round.code, round.message) };
      }
      if (round.kind === 'budget_exhausted') {
        return {
          kind: 'result',
          result: {
            kind: 'blocked',
            laneKey: input.workPackageId,
            reason: `集成复验预算已耗尽（${String(round.consumed)}/${String(round.limit)}）`,
          },
        };
      }
      return { kind: 'result', result: { kind: 'blocked', laneKey: round.laneKey, reason: round.reason } };
    }
  };

  let roundsDone = input.reconciliation === null;

  for (const step of GIT_INTEGRATION_STEPS) {
    // commit 之后、integrate 之前完成所有需要的合并树复验；这样 integrate 的 expected HEAD 一定是
    // 复验完成后重新归属的 canonical HEAD。
    if (step === 'integrate_canonical' && !roundsDone) {
      roundsDone = true;
      const reconciled = await reconcileRounds();
      if (reconciled.kind === 'result') {
        return reconciled.result;
      }
      canonicalExpectedHead = reconciled.canonicalHead;
    }
    const operationId = operationIdFor[step];
    const priorIntent = input.store.query({
      kind: 'intent',
      coordinationScopeId: input.coordinationScopeId,
      operationId,
    });
    const persistedExpectedHead =
      priorIntent.kind === 'intent' && priorIntent.intent !== null
        ? priorIntent.intent.expectedHead
        : expectedHeadFor(step);
    const revision = readScope(input.store, input.coordinationScopeId);
    if (revision.kind === 'rejected') {
      return rejection(revision.code, revision.message);
    }
    const begun = beginIntent(input.store, {
      coordinationScopeId: input.coordinationScopeId,
      operationId,
      target,
      operationCategory: 'git-integration',
      expectedHead: persistedExpectedHead ?? expectedHeadFor(step),
      writer: input.writer,
      expectedRevision: revision.scope.revision,
    });
    if (begun.kind === 'lane_blocked') {
      return { kind: 'blocked', laneKey: begun.laneKey, reason: `lane 已被未决意图 ${begun.blockingIntent.operationId} 阻塞` };
    }
    if (begun.kind === 'lane_busy') {
      return { kind: 'blocked', laneKey: begun.laneKey, reason: `lane 上已有未决意图 ${begun.activeIntent.operationId}` };
    }
    if (begun.kind === 'rejected') {
      return { kind: 'blocked', laneKey: target.id, reason: begun.rejection.message };
    }

    if (begun.kind === 'existing') {
      if (
        begun.intent.expectedHead === null ||
        (step === 'commit' && begun.intent.expectedHead !== expectedHeadFor(step))
      ) {
        return {
          kind: 'blocked',
          laneKey: begun.intent.laneKey,
          reason: `意图 ${operationId} 缺少或不匹配 expected HEAD`,
        };
      }
      if (begun.intent.state === 'settled' && begun.intent.outcomeClass !== 'accepted') {
        return {
          kind: 'blocked',
          laneKey: begun.intent.laneKey,
          reason: `意图 ${operationId} 尚无已接受的确定结果（${begun.intent.state}）`,
        };
      }
      if (begun.intent.state === 'settled') {
        const replayReadback = readbackFor(step);
        const read = await input.port.readHead(replayReadback);
        if (read.kind === 'unavailable') {
          return {
            kind: 'blocked',
            laneKey: target.id,
            reason: `无法回读 ${readbackLabel(replayReadback)}：${read.reason}`,
          };
        }
        recordExpectedHead(step, read.head);
        completed.push(step);
        continue;
      }
    }

    const request: GitStepRequest = {
      step,
      workPackageId: input.workPackageId,
      sourceWorktreePath: input.workspace.workPackageWorktreePath,
      branch: input.request.branch,
      sourceBranch: input.request.sourceBranch,
      remote: approvedRemote,
      ref: approvedRef,
      expectedHead: persistedExpectedHead ?? expectedHeadFor(step),
      commitMessage: step === 'commit' ? input.commitMessage : null,
    };
    const scope = executionScope(input, operationId, target, revision.scope.revision);
    let outcome = begun.kind === 'existing'
      ? await input.port.reconcile(request, scope)
      : await input.port.run(request, scope);
    if (outcome.kind === 'unknown' && begun.kind !== 'existing') {
      outcome = await input.port.reconcile(request, scope);
    }
    const asOutcome = asOperationOutcome(outcome, operationId, target);

    if (outcome.kind === 'unknown') {
      const blockedRevision = readScope(input.store, input.coordinationScopeId);
      const reason = `步骤 ${step} 的结果无法判定：${outcome.reason}`;
      if (blockedRevision.kind === 'read') {
        blockLane(input.store, {
          coordinationScopeId: input.coordinationScopeId,
          operationId,
          writer: input.writer,
          expectedRevision: blockedRevision.scope.revision,
          reason,
        });
      }
      return { kind: 'unknown', operationId, reason: `${reason}，lane 保持阻塞` };
    }

    if (outcome.kind === 'rejected') {
      const settleRevision = readScope(input.store, input.coordinationScopeId);
      if (settleRevision.kind === 'read') {
        const settled = settleIntent(input.store, {
          coordinationScopeId: input.coordinationScopeId,
          operationId,
          writer: input.writer,
          expectedRevision: settleRevision.scope.revision,
          outcome: asOutcome,
        });
        if (settled.kind === 'rejected') {
          return { kind: 'blocked', laneKey: target.id, reason: settled.rejection.message };
        }
      }
      return rejection(outcome.code, outcome.message);
    }

    // 步骤 5：按该步骤自己的目标回读核验，然后才完成该步骤的 Intent。
    const readback = readbackFor(step);
    const read = await input.port.readHead(readback);
    const settledRevision = readScope(input.store, input.coordinationScopeId);
    if (settledRevision.kind === 'rejected') {
      return rejection(settledRevision.code, settledRevision.message);
    }
    if (read.kind === 'unavailable') {
      blockLane(input.store, {
        coordinationScopeId: input.coordinationScopeId,
        operationId,
        writer: input.writer,
        expectedRevision: settledRevision.scope.revision,
        reason: `步骤 ${step} 后无法回读 ${readbackLabel(readback)}：${read.reason}`,
      });
      return { kind: 'blocked', laneKey: target.id, reason: `步骤 ${step} 后无法回读 ${readbackLabel(readback)}` };
    }
    if (headOf(outcome) !== null && read.head !== headOf(outcome)) {
      blockLane(input.store, {
        coordinationScopeId: input.coordinationScopeId,
        operationId,
        writer: input.writer,
        expectedRevision: settledRevision.scope.revision,
        reason: `步骤 ${step} 后回读 ${readbackLabel(readback)} ${read.head} 与步骤报告不一致`,
      });
      return {
        kind: 'blocked',
        laneKey: target.id,
        reason: `步骤 ${step} 后回读 ${readbackLabel(readback)} 与步骤报告不一致，无法归属该变化`,
      };
    }
    const settled = begun.kind === 'existing' && begun.intent.state === 'blocked'
      ? resolveLane(input.store, {
          coordinationScopeId: input.coordinationScopeId, operationId, writer: input.writer,
          expectedRevision: settledRevision.scope.revision, outcomeClass: 'accepted',
        })
      : settleIntent(input.store, {
          coordinationScopeId: input.coordinationScopeId,
          operationId,
          writer: input.writer,
          expectedRevision: settledRevision.scope.revision,
          outcome: asOutcome,
        });
    if (settled.kind === 'rejected') {
      return { kind: 'blocked', laneKey: target.id, reason: settled.rejection.message };
    }
    recordExpectedHead(step, read.head);
    completed.push(step);
  }

  return { kind: 'integrated', head: canonicalExpectedHead ?? sourceExpectedHead, steps: completed };
}
