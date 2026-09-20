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
 * 5. 回读核验 HEAD，完成 Intent。
 *
 * 任一步 `unknown` 时以同一 OperationId 对账，不换 ID 重试，也不继续后续步骤。这里不使用 shell：
 * 副作用由注入的 `GitIntegrationPort` 完成，本模块只拥有顺序、准入与对账规则。
 */

import type { CoordinationScopeId, OperationId, WorkPackageId } from './dto/identity.js';
import type { OperationOutcome } from './dto/operation-outcome.js';
import type { BranchCoordinationStore, CoordinationWriter } from './ports/branch-coordination-store.js';
import {
  buildExecutionScope,
  type ExecutionAuthority,
  type ExecutionScope,
} from './ports/execution-backend.js';
import { beginIntent, blockLane, settleIntent } from './coordination/intent-service.js';
import { readScope } from './planning/scope-read.js';
import {
  evaluateGitIntegration,
  type GitIntegrationDecision,
  type GitIntegrationRequest,
} from '../domain/git-integration-policy.js';
import type { GitIntegrationPolicy, RoleAuthorities } from '../domain/planning/execution-authorization.js';
import type { WorkPackageStatus } from '../domain/work-package-status.js';

/** 集成步骤闭集；顺序即数组顺序。 */
export const GIT_INTEGRATION_STEPS = ['commit', 'integrate_canonical', 'push'] as const;

export type GitIntegrationStep = (typeof GIT_INTEGRATION_STEPS)[number];

export type GitStepRequest = {
  readonly step: GitIntegrationStep;
  readonly workPackageId: WorkPackageId;
  readonly branch: string;
  readonly remote: string | null;
  readonly ref: string | null;
  readonly expectedHead: string;
  readonly commitMessage: string | null;
};

export type GitStepOutcome =
  | { readonly kind: 'committed'; readonly head: string }
  | { readonly kind: 'integrated'; readonly head: string }
  | { readonly kind: 'pushed'; readonly remote: string; readonly ref: string; readonly head: string }
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
  /** 只读回读 canonical HEAD，用于按 expected HEAD 核验结果。 */
  readonly readCanonicalHead: () => Promise<
    { readonly kind: 'read'; readonly head: string } | { readonly kind: 'unavailable'; readonly reason: string }
  >;
};

export type IntegrationOperationIds = {
  readonly commit: OperationId;
  readonly integrate: OperationId;
  readonly push: OperationId;
};

export type IntegrateWorkPackageInput = {
  readonly port: GitIntegrationPort;
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly writer: CoordinationWriter;
  readonly expectedRevision: number;
  readonly backendIdentityRef: string;
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
  readonly baselineHead: string;
  readonly commitMessage: string;
  readonly operationIds: IntegrationOperationIds;
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
  if (input.request.remote === null || input.request.ref === null) {
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

  let expectedHead = input.baselineHead;
  const completed: GitIntegrationStep[] = [];

  for (const step of GIT_INTEGRATION_STEPS) {
    const operationId = operationIdFor[step];
    const priorIntent = input.store.query({
      kind: 'intent',
      coordinationScopeId: input.coordinationScopeId,
      operationId,
    });
    const persistedExpectedHead =
      priorIntent.kind === 'intent' && priorIntent.intent !== null
        ? priorIntent.intent.expectedHead
        : expectedHead;
    const revision = readScope(input.store, input.coordinationScopeId);
    if (revision.kind === 'rejected') {
      return rejection(revision.code, revision.message);
    }
    const begun = beginIntent(input.store, {
      coordinationScopeId: input.coordinationScopeId,
      operationId,
      target,
      operationCategory: 'git-integration',
      expectedHead: persistedExpectedHead ?? expectedHead,
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
      if (begun.intent.expectedHead === null || (step === 'commit' && begun.intent.expectedHead !== expectedHead)) {
        return {
          kind: 'blocked',
          laneKey: begun.intent.laneKey,
          reason: `意图 ${operationId} 缺少或不匹配 expected HEAD`,
        };
      }
      if (begun.intent.state !== 'settled' || begun.intent.outcomeClass !== 'accepted') {
        return {
          kind: 'blocked',
          laneKey: begun.intent.laneKey,
          reason: `意图 ${operationId} 尚无已接受的确定结果（${begun.intent.state}）`,
        };
      }
      const read = await input.port.readCanonicalHead();
      if (read.kind === 'unavailable') {
        return { kind: 'blocked', laneKey: target.id, reason: `无法回读 canonical HEAD：${read.reason}` };
      }
      expectedHead = read.head;
      completed.push(step);
      continue;
    }

    const request: GitStepRequest = {
      step,
      workPackageId: input.workPackageId,
      branch: input.request.branch,
      remote: input.request.remote,
      ref: input.request.ref,
      expectedHead,
      commitMessage: step === 'commit' ? input.commitMessage : null,
    };
    const scope = executionScope(input, operationId, target, revision.scope.revision);
    let outcome = await input.port.run(request, scope);
    if (outcome.kind === 'unknown') {
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

    // 步骤 5：按 expected HEAD 回读核验，然后才完成该步骤的 Intent。
    const read = await input.port.readCanonicalHead();
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
        reason: `步骤 ${step} 后无法回读 canonical HEAD：${read.reason}`,
      });
      return { kind: 'blocked', laneKey: target.id, reason: `步骤 ${step} 后无法回读 canonical HEAD` };
    }
    if (headOf(outcome) !== null && read.head !== headOf(outcome)) {
      blockLane(input.store, {
        coordinationScopeId: input.coordinationScopeId,
        operationId,
        writer: input.writer,
        expectedRevision: settledRevision.scope.revision,
        reason: `步骤 ${step} 后回读 HEAD ${read.head} 与步骤报告不一致`,
      });
      return {
        kind: 'blocked',
        laneKey: target.id,
        reason: `步骤 ${step} 后回读 HEAD 与步骤报告不一致，无法归属该变化`,
      };
    }
    const settled = settleIntent(input.store, {
      coordinationScopeId: input.coordinationScopeId,
      operationId,
      writer: input.writer,
      expectedRevision: settledRevision.scope.revision,
      outcome: asOutcome,
    });
    if (settled.kind === 'rejected') {
      return { kind: 'blocked', laneKey: target.id, reason: settled.rejection.message };
    }
    expectedHead = read.head;
    completed.push(step);
  }

  return { kind: 'integrated', head: expectedHead, steps: completed };
}
