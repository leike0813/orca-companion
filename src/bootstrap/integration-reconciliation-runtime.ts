import { existsSync, readFileSync } from 'node:fs';

/**
 * IP-03 / D-03：集成复验的生产 channel/runner 装配。
 *
 * 把 IntegrationReconciliationRunner 接到真实的 Orca 派发与 Delivery 读取：
 *
 * - 原 Validator Task 已完成、其 terminal 可能闲置：不重复读取原 worker_done，而是为该轮创建独立的
 *   续接 Task/Dispatch（稳定 Task 创建 OperationId），并 codex resume 原 provider session。
 * - 新 Dispatch 的会话身份只由它自己的 SessionStart 报告证明（WorkerTask/Dispatch/cwd/UUID 精确匹配），
 *   绝不用原 transcript 身份伪造新 Dispatch 的绑定。
 * - 复验结果只接受结构化报告；证据由报告里的真实命令/结论/路径构成，不把 worker_done 的泛化
 *   files/summary 冒充通过。运行时不在持久化之前 ack：返回真实 Delivery 身份，由 IC-08 结算后确认。
 */

import { createCodexResumeLaunch, installCodexSessionStartReporter } from '../adapters/agents/codex-launch.js';
import { bindCodexSessionFromStartReport, type HarnessSessionFacts } from '../adapters/agents/session-binding.js';
import type { CodexSessionStartReport } from '../adapters/agents/codex-transcript.js';
import { decideValidatorSessionContinuity } from '../adapters/agents/validator-runner.js';
import { dispatchScopedWorker } from '../adapters/agents/utility-worker.js';
import type { TerminalSummary, WorkerShowResult } from '../adapters/orca-cli/operation-catalog.js';
import { workerStateLiveness } from '../application/execution/execution-view.js';
import { readDeliveryBatch } from '../adapters/orca-cli/delivery-reader.js';
import type {
  IntegrationReconciliationRecord,
  IntegrationReconciliationOutcome,
  IntegrationReconciliationRequest,
  IntegrationReconciliationRunner,
  IntegrationReconciliationStore,
} from '../application/integration-reconciliation.js';
import {
  ackConsumedDelivery,
  normalizeResultValue,
  resultDigest,
} from '../application/delivery/process-delivery.js';
import { beginIntent, blockLane, resolveLane, settleIntent } from '../application/coordination/intent-service.js';
import {
  buildExecutionScope,
  type ExecutionAuthority,
  type ExecutionScope,
} from '../application/ports/execution-backend.js';
import type {
  CoordinationScopeId,
  DispatchId,
  OperationId,
  WorkPackageId,
  WorkerTaskId,
} from '../application/dto/identity.js';
import type { BranchCoordinationStore, CoordinationWriter } from '../application/ports/branch-coordination-store.js';
import type { CredentialStore } from '../application/ports/credential-store.js';
import type { ExecutionBackend } from '../application/ports/execution-backend.js';
import type { WorkerModelConfiguration } from '../domain/model-configuration.js';
import type { ScopeEnvelope } from '../domain/planning/execution-graph.js';
import { pathsOutsideScopeEnvelope } from '../domain/repair-scope.js';
import { envelopeCheckedPaths } from '../domain/worker-result-verification.js';
import type { SessionBinding } from '../domain/task-contract.js';
import type { EvidenceRecord, EvidenceRecordKind } from '../domain/worker-report.js';
import { codexSessionPathsUnder, parseOrcaWorkerDoneLocator } from './execution-runtime.js';

export type IntegrationReconciliationExecution = {
  readonly backendIdentityRef: string;
  readonly graphGeneration: number;
  readonly authorizationId: string;
  readonly runId: string;
  readonly consumerGeneration: number;
  readonly timeoutMs: number;
};

/** 原 Validator 物化绑定的可信子集；宿主可携带更多已批准字段，本模块只读它需要的。 */
export type IntegrationReconciliationMaterializationBinding = {
  readonly launchId: string;
  readonly worktreeId?: string;
  readonly workerProfileRef?: string;
  readonly [key: string]: unknown;
};

export type IntegrationReconciliationRuntimeInput = {
  readonly store: BranchCoordinationStore;
  readonly backend: ExecutionBackend;
  readonly writer: CoordinationWriter;
  readonly coordinationScopeId: CoordinationScopeId;
  /** 集成复验轮次存储：续接 Task/Dispatch 的真实身份必须在这里立即落盘。 */
  readonly reconciliationStore: IntegrationReconciliationStore;
  readonly execution: IntegrationReconciliationExecution;
  /**
   * 原 Validator 的已证明 Session Binding。
   *
   * 由 foreground 从该 Accept 的 issuedBinding（launchId）重新核验得到：原 workerTask、真实 dispatch、
   * attempt、worktree、codexHome 与 createdAt 全部一致才给出，因此这里不回退到 encoded ID 猜 UUID。
   */
  readonly originalBinding: SessionBinding;
  /** 原 session 的 CODEX_HOME；resume 必须在同一个 HOME 内进行。 */
  readonly originalCodexHome: string;
  /**
   * 原 Accepted Validator 的 exact owner 资源（foreground 从已接受结算 + worker-show 证明后给出）。
   *
   * 只有原 Worker 已终结且该 exact terminal 处于 tui-idle 时，才用 typed terminal-close 释放它，从而让
   * codex resume 原UUID --no-daemon 继续同一 provider session；缺少身份依据时阻塞。
   */
  readonly originalOwner?: {
    readonly dispatchId: DispatchId;
    readonly terminalHandle: string;
  };
  readonly modelConfiguration: WorkerModelConfiguration;
  readonly credentialStore: CredentialStore;
  readonly credentialStorePath: string;
  readonly sandboxMode: Parameters<typeof createCodexResumeLaunch>[0]['sandboxMode'] | null;
  readonly companionStateRoot: string;
  readonly canonicalWorktreePath: string;
  readonly originalMaterializationBinding: IntegrationReconciliationMaterializationBinding;
  /** 待集成的 Work Package；scopeEnvelope 进入续接规格，限定复验允许的改动范围。 */
  readonly workPackage: {
    readonly workPackageId: string;
    readonly scopeEnvelope?: ScopeEnvelope;
    readonly [key: string]: unknown;
  };
  readonly bindingWindowMs: number;
  readonly resultTimeoutMs: number;
  /** 中止/关闭信号：TUI 退出或 store 关闭后不再派发、等待或写入。 */
  readonly signal?: AbortSignal;
  readonly isClosed?: () => boolean;
  /** 原 terminal 是否仍可核验复用；默认 false，即总是以原 provider session resume。 */
  readonly liveTerminalVerified?: () => Promise<boolean>;
  readonly clock?: () => number;
};

/** 续接复验 Task 的稳定规格；身份字段来自轮次请求，正文要求结构化报告。 */
function continuationSpec(
  request: IntegrationReconciliationRequest,
  scopeEnvelope: ScopeEnvelope | undefined,
): string {
  const spec: Record<string, unknown> = {
    schemaVersion: 1,
    taskKind: 'integration-reconciliation',
    role: 'validator',
    workerTaskId: request.continuation.attemptId,
    workPackageId: request.workPackageId,
    round: request.round,
    reconciliationId: request.reconciliationId,
    originalValidationAttemptId: request.validationAttemptId,
    sourceAcceptedResultRef: request.sourceAcceptedResultRef,
    targetHead: request.targetHead,
    conflictPaths: [...request.conflictPaths],
    instruction:
      'canonical 已在原验证之后前移，宿主已把目标 HEAD 合并进本 worktree（--no-commit）。你仍处于原 ' +
      'Validation Attempt：只在 scopeEnvelope 内解决冲突并复验当前合并树。把范围内已验证的解决/修复用 ' +
      'git add 暂存，用 git write-tree 的完整 OID 填 treeRef；不要自行 commit（由 Controller 创建 merge ' +
      'commit）。完成后按 Orca Dispatch 指令提交 worker_done，结构化报告放进 worker-done body（严格有界 ' +
      'JSON）：{ schemaVersion: 1, taskId, dispatchId, outcome: "passed"|"failed", summary, treeRef, ' +
      'filesModified: [<你实际修改的路径>], evidence: [{ kind, coveredPaths, command, outcome, summary }] }。' +
      'filesModified 只列你改过的路径且必须落在 scopeEnvelope 内；coveredPaths 可包含 canonical 导入的其它 ' +
      '包文件（只读复验，不算修改）。',
  };
  if (scopeEnvelope !== undefined) {
    spec['scopeEnvelope'] = { include: [...scopeEnvelope.include], exclude: [...scopeEnvelope.exclude] };
  }
  return JSON.stringify(spec);
}

function delay(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const EVIDENCE_KINDS: readonly EvidenceRecordKind[] = ['command', 'inspection', 'review'];

export type RevalidationReport = {
  readonly outcome: string;
  readonly summary: string;
  readonly treeRef: string;
  /** Worker 声明的实际修改路径；缺该字段即拒绝，不做旧 schema 兼容。 */
  readonly filesModified: readonly string[];
  readonly evidence: readonly EvidenceRecord[];
};

/**
 * 严格解析 Worker 的结构化复验报告。
 *
 * 形状、边界与取值都必须成立：泛化的 worker_done files/summary 不构成通过证据；解析失败一律拒绝，
 * 不降级、不猜。
 */
export function parseRevalidationReport(
  body: string | null,
  expected: { readonly taskId: string; readonly dispatchId: string },
): RevalidationReport | null {
  // 公共 worker-done 允许任意 body：报告以严格有界 JSON 放在 body，并自带 schema/ids 供归属核验。
  if (body === null || body.length === 0 || body.length > 64 * 1024) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(body) as unknown;
  } catch {
    return null;
  }
  if (typeof decoded !== 'object' || decoded === null) return null;
  const fields = decoded as Record<string, unknown>;
  if (fields['schemaVersion'] !== 1) return null;
  if (fields['taskId'] !== expected.taskId || fields['dispatchId'] !== expected.dispatchId) return null;
  const outcome = fields['outcome'];
  const summary = fields['summary'];
  const treeRef = fields['treeRef'];
  const evidence = fields['evidence'];
  if (typeof outcome !== 'string' || outcome.length === 0 || outcome.length > 64) return null;
  if (typeof summary !== 'string' || summary.length === 0 || summary.length > 4096) return null;
  if (typeof treeRef !== 'string' || !COMMIT_ID.test(treeRef)) return null;
  // 写范围声明：字段必须存在；空数组合法（无修改），但每项必须是非空、有界的路径。
  const filesModified = fields['filesModified'];
  if (!Array.isArray(filesModified) || filesModified.length > 512) return null;
  if (filesModified.some((path) => typeof path !== 'string' || path.length === 0 || path.length > 1024)) return null;
  if (!Array.isArray(evidence) || evidence.length === 0 || evidence.length > 64) return null;
  const records: EvidenceRecord[] = [];
  for (const entry of evidence) {
    if (typeof entry !== 'object' || entry === null) return null;
    const item = entry as Record<string, unknown>;
    const kind = item['kind'];
    const coveredPaths = item['coveredPaths'];
    const command = item['command'];
    const recordOutcome = item['outcome'];
    const recordSummary = item['summary'];
    if (typeof kind !== 'string' || !EVIDENCE_KINDS.includes(kind as EvidenceRecordKind)) return null;
    if (!Array.isArray(coveredPaths) || coveredPaths.length === 0 || coveredPaths.length > 512) return null;
    if (coveredPaths.some((path) => typeof path !== 'string' || path.length === 0)) return null;
    if (command !== null && (typeof command !== 'string' || command.length > 4096)) return null;
    // command 证据必须带可复核命令：kind=command 却不能给出命令的一律拒绝，避免泛化通过。
    if (kind === 'command' && (command === null || command.trim().length === 0)) return null;
    if (recordOutcome !== 'passed' && recordOutcome !== 'failed') return null;
    if (typeof recordSummary !== 'string' || recordSummary.length === 0 || recordSummary.length > 4096) return null;
    records.push({
      evidenceId: 'revalidation:' + String(records.length),
      kind: kind as EvidenceRecordKind,
      coveredPaths: coveredPaths as readonly string[],
      command,
      summary: recordSummary,
      outcome: recordOutcome,
    });
  }
  return { outcome, summary, treeRef, filesModified: filesModified as readonly string[], evidence: records };
}

type ResultWait =
  | { readonly kind: 'report'; readonly report: RevalidationReport; readonly deliveryId: string | null; readonly deliveryRunId: string | null }
  | { readonly kind: 'unreadable' };

/** 在新 Dispatch 的 worker_done 上按精确 Task/Dispatch 匹配，只接受结构化报告，不消费原 Validator 结果。 */
async function waitForReport(input: {
  readonly backend: ExecutionBackend;
  readonly execution: IntegrationReconciliationExecution;
  readonly orcaTaskId: string;
  readonly dispatchId: string;
  readonly timeoutMs: number;
  readonly clock: () => number;
  readonly aborted: () => boolean;
}): Promise<ResultWait> {
  const deadline = input.clock() + input.timeoutMs;
  for (;;) {
    if (input.aborted()) return { kind: 'unreadable' };
    const delivery = await readDeliveryBatch(input.backend, {
      backendIdentityRef: input.execution.backendIdentityRef,
      runId: input.execution.runId,
      types: ['worker_done'],
      timeoutMs: input.execution.timeoutMs,
    });
    if (delivery.kind !== 'accepted') return { kind: 'unreadable' };
    const batch = delivery.value;
    const matched = batch.messages.find((message) => {
      const locator = parseOrcaWorkerDoneLocator(message.payload, message.body);
      return locator?.orcaTaskId === input.orcaTaskId && locator.orcaDispatchId === input.dispatchId;
    });
    if (matched !== undefined) {
      const report = parseRevalidationReport(matched.body, {
        taskId: input.orcaTaskId,
        dispatchId: input.dispatchId,
      });
      if (report === null) return { kind: 'unreadable' };
      // 不在持久化之前 ack：返回真实 Delivery 身份交 IC-08 结算后再确认。
      return {
        kind: 'report',
        report,
        deliveryId: batch.delivery === null ? null : batch.delivery.deliveryId,
        deliveryRunId: batch.delivery === null ? null : batch.delivery.runId,
      };
    }
    if (input.clock() >= deadline) return { kind: 'unreadable' };
    await delay(250);
  }
}

/** accept/ack 回调的输入：复用 runner 的同一批可信依赖。 */
export type IntegrationReconciliationSettlementInput = {
  readonly store: BranchCoordinationStore;
  readonly backend: ExecutionBackend;
  readonly writer: CoordinationWriter;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly execution: IntegrationReconciliationExecution;
  /** 原 Validator 的 provider session 身份：回读必须证明 Accepted 结果绑定同一条会话。 */
  readonly originalProviderSessionId: string;
  readonly isClosed?: () => boolean;
};

export type AcceptRevalidationResult =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'blocked'; readonly reason: string };

export type AcknowledgeRevalidationResult =
  | { readonly kind: 'acknowledged' }
  | { readonly kind: 'blocked'; readonly reason: string };

export type IntegrationReconciliationSettlement = {
  readonly acceptResult: (
    reconciliationId: string,
    outcome: Extract<IntegrationReconciliationOutcome, { readonly kind: 'validated' }>,
  ) => Promise<AcceptRevalidationResult>;
  readonly acknowledgeResult: (record: IntegrationReconciliationRecord) => Promise<AcknowledgeRevalidationResult>;
};

/**
 * 集成复验的 accept/ack 回调工厂。
 *
 * accept：把 Accepted Revalidation Result 写进续接 Orca Task 的 result（稳定 task-update 意图），
 * 回读确认后才主张 accepted；不写 role settlement、不碰原 Validator 的 accepted ref。
 * ack：只在 round validated 后调用；先回读已接受结果，再确认匹配的 worker_done Delivery，已推进的投递
 * 在结果回读成立时视为已确认。两个回调都受 closed 信号约束。
 */
export function createIntegrationReconciliationSettlement(
  input: IntegrationReconciliationSettlementInput,
): IntegrationReconciliationSettlement {
  const closed = (): boolean => input.isClosed?.() ?? false;
  const freshRevision = (): number | null => {
    if (closed()) return null;
    const scope = input.store.query({ kind: 'scope', coordinationScopeId: input.coordinationScopeId });
    return scope.kind === 'scope' && scope.scope !== null ? scope.scope.revision : null;
  };
  type AcceptedBody = {
    readonly reconciliationId: string;
    readonly treeRef: string;
    readonly dispatchId: string;
    readonly providerSessionId: string;
    readonly workerTaskId: string;
  };
  // 只接受 status=completed 且带结构化 integration_revalidation body 的精确回读；泛化 task result 不算接受。
  const readAcceptedBody = async (
    taskId: string,
  ): Promise<{ readonly body: AcceptedBody; readonly digest: string } | null> => {
    const listed = await input.backend.query({
      operation: 'task-list',
      backendIdentityRef: input.execution.backendIdentityRef,
      runId: input.execution.runId,
    });
    if (closed() || listed.kind !== 'accepted') return null;
    const value = listed.value as {
      readonly tasks?: readonly { readonly id?: unknown; readonly status?: unknown; readonly result?: unknown }[];
    };
    const task = value.tasks?.find((entry) => entry.id === taskId);
    if (task === undefined || task.status !== 'completed') return null;
    // Orca Task result 可能是 JSON 字符串；复用现有 normalizeResultValue 归一化后再校验。
    const result = normalizeResultValue(task.result);
    if (typeof result !== 'object' || result === null) return null;
    const record = result as Record<string, unknown>;
    if (record['schemaVersion'] !== 1 || record['kind'] !== 'integration_revalidation') return null;
    // 证据必须是非空且全部 passed 的结构化数组；任何失败记录或空证据都不算接受。
    const evidence = record['evidence'];
    if (!Array.isArray(evidence) || evidence.length === 0) return null;
    if (
      !evidence.every(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          (entry as Record<string, unknown>)['outcome'] === 'passed',
      )
    ) {
      return null;
    }
    const reconciliationId = record['reconciliationId'];
    const treeRef = record['treeRef'];
    const dispatchId = record['dispatchId'];
    const providerSessionId = record['providerSessionId'];
    const workerTaskId = record['workerTaskId'];
    if (
      typeof reconciliationId !== 'string' ||
      typeof treeRef !== 'string' ||
      typeof dispatchId !== 'string' ||
      typeof providerSessionId !== 'string' ||
      typeof workerTaskId !== 'string'
    ) {
      return null;
    }
    return {
      body: { reconciliationId, treeRef, dispatchId, providerSessionId, workerTaskId },
      digest: resultDigest(result),
    };
  };
  const acceptedMatches = (
    readback: { readonly body: AcceptedBody; readonly digest: string } | null,
    expected: { readonly reconciliationId: string; readonly treeRef: string; readonly dispatchId: string },
    digest?: string,
  ): boolean =>
    readback !== null &&
    (digest === undefined || readback.digest === digest) &&
    readback.body.reconciliationId === expected.reconciliationId &&
    readback.body.treeRef === expected.treeRef &&
    readback.body.dispatchId === expected.dispatchId &&
    readback.body.providerSessionId === input.originalProviderSessionId;
  const acceptResult: IntegrationReconciliationSettlement['acceptResult'] = async (reconciliationId, outcome) => {
    if (closed()) return { kind: 'blocked', reason: 'store 已关闭：不接受集成复验结果' };
    if (outcome.orcaTaskId === null) return { kind: 'blocked', reason: '集成复验结果缺少可核验的 Orca Task 身份' };
    const operationId = ('integration-revalidation-accept:' + encodeURIComponent(reconciliationId)) as OperationId;
    const target = { kind: 'integration-reconciliation', id: reconciliationId };
    const expected = { reconciliationId, treeRef: outcome.treeRef, dispatchId: outcome.sessionBinding.dispatchId };
    const body = {
      schemaVersion: 1,
      kind: 'integration_revalidation',
      reconciliationId,
      treeRef: outcome.treeRef,
      filesModified: [...outcome.filesModified],
      workerTaskId: outcome.sessionBinding.workerTaskId,
      dispatchId: outcome.sessionBinding.dispatchId,
      providerSessionId: outcome.sessionBinding.providerSessionId,
      evidence: outcome.evidence,
    };
    const expectedDigest = resultDigest(body);
    const matches = async (taskId: string): Promise<{ matched: boolean; readback: unknown }> => {
      const readback = await readAcceptedBody(taskId);
      return { matched: acceptedMatches(readback, expected, expectedDigest), readback };
    };
    // 回读精确成立后把「已发生但未收尾」的原意图按原 ID 收尾：blocked 用 resolveLane，pending 用 settleIntent。
    const finishAccept = (): AcceptRevalidationResult => {
      if (closed()) return { kind: 'blocked', reason: '运行已关闭：不写入接受结果' };
      const current = input.store.query({ kind: 'intent', coordinationScopeId: input.coordinationScopeId, operationId });
      if (current.kind !== 'intent' || current.intent === null) {
        return { kind: 'blocked', reason: 'accept 回读成立但找不到原意图' };
      }
      if (current.intent.state === 'settled' && current.intent.outcomeClass === 'accepted') {
        return { kind: 'accepted' };
      }
      const revision = freshRevision();
      if (revision === null) return { kind: 'blocked', reason: '无法读取 Scope revision' };
      if (current.intent.state === 'blocked') {
        const resolved = resolveLane(input.store, {
          coordinationScopeId: input.coordinationScopeId,
          operationId,
          writer: input.writer,
          expectedRevision: revision,
          outcomeClass: 'accepted',
        });
        return resolved.kind === 'rejected' ? { kind: 'blocked', reason: resolved.rejection.message } : { kind: 'accepted' };
      }
      const settled = settleIntent(input.store, {
        coordinationScopeId: input.coordinationScopeId,
        operationId,
        writer: input.writer,
        expectedRevision: revision,
        outcome: { kind: 'accepted', operation: { operationId, target }, value: { accepted: true } },
      });
      return settled.kind === 'rejected' ? { kind: 'blocked', reason: settled.rejection.message } : { kind: 'accepted' };
    };
    const existingIntent = input.store.query({
      kind: 'intent',
      coordinationScopeId: input.coordinationScopeId,
      operationId,
    });
    if (
      existingIntent.kind === 'intent' &&
      existingIntent.intent !== null &&
      existingIntent.intent.state === 'settled' &&
      existingIntent.intent.outcomeClass === 'accepted'
    ) {
      return (await matches(outcome.orcaTaskId)).matched
        ? finishAccept()
        : { kind: 'blocked', reason: 'accept 意图已接受但结构化结果回读不匹配' };
    }
    const revision = freshRevision();
    if (revision === null) return { kind: 'blocked', reason: '无法读取 Scope revision' };
    const begun = beginIntent(input.store, {
      coordinationScopeId: input.coordinationScopeId,
      operationId,
      target,
      operationCategory: 'integration-revalidation-accept',
      writer: input.writer,
      expectedRevision: revision,
    });
    if (begun.kind === 'lane_blocked' || begun.kind === 'lane_busy') {
      return (await matches(outcome.orcaTaskId)).matched
        ? finishAccept()
        : { kind: 'blocked', reason: 'accept lane 已被未决意图阻塞且结构化结果回读不匹配' };
    }
    if (begun.kind === 'rejected') return { kind: 'blocked', reason: begun.rejection.message };
    if (begun.kind === 'existing') {
      return (await matches(outcome.orcaTaskId)).matched
        ? finishAccept()
        : { kind: 'blocked', reason: 'accept 意图未结算且结构化结果回读不匹配' };
    }
    const authority: ExecutionAuthority = {
      kind: 'execution_coordination',
      graphGeneration: input.execution.graphGeneration,
      authorizationId: input.execution.authorizationId,
      runId: input.execution.runId,
      consumerGeneration: input.execution.consumerGeneration,
    };
    const scope: ExecutionScope = buildExecutionScope({
      coordinationScopeId: input.coordinationScopeId,
      coordinatorSessionId: input.writer.coordinatorSessionId,
      runtimeIncarnationId: input.writer.runtimeIncarnationId,
      fencingGeneration: input.writer.fencingGeneration,
      backendIdentityRef: input.execution.backendIdentityRef,
      operationId,
      target,
      expectedRevision: revision,
      timeoutMs: input.execution.timeoutMs,
      authority,
    });
    await input.backend.mutate(
      { operation: 'task-update', taskId: outcome.orcaTaskId, status: 'completed', result: body },
      scope,
    );
    if (!(await matches(outcome.orcaTaskId)).matched) {
      const blockedRevision = freshRevision();
      if (blockedRevision !== null) {
        blockLane(input.store, {
          coordinationScopeId: input.coordinationScopeId,
          operationId,
          writer: input.writer,
          expectedRevision: blockedRevision,
          reason: 'task-update 后结构化结果回读缺失或不匹配',
        });
      }
      return { kind: 'blocked', reason: 'task-update 后 Accepted Revalidation Result 回读缺失或不匹配' };
    }
    // 回读精确成立：即使 mutate 结果未知，也按原身份把意图收尾为 accepted，不留在 pending/blocked。
    return finishAccept();
  };
  const acknowledgeResult: IntegrationReconciliationSettlement['acknowledgeResult'] = async (record) => {
    if (closed()) return { kind: 'blocked', reason: 'store 已关闭：不 ack' };
    // 未派发续接 Task（例如 already_merged 没有 Worker 结果）时没有可确认的投递。
    if (record.orcaTaskId === null || record.dispatchId === null) {
      return { kind: 'acknowledged' };
    }
    // 先按结构化 body + status 精确回读 Accepted Revalidation Result，成立后才确认投递。
    const body = await readAcceptedBody(record.orcaTaskId);
    if (
      !acceptedMatches(body, {
        reconciliationId: record.reconciliationId,
        treeRef: record.mergedTreeRef ?? '',
        dispatchId: record.dispatchId,
      })
    ) {
      return { kind: 'blocked', reason: 'Accepted Revalidation Result 回读缺失或不匹配：不 ack' };
    }
    const delivery = await readDeliveryBatch(input.backend, {
      backendIdentityRef: input.execution.backendIdentityRef,
      runId: input.execution.runId,
      types: ['worker_done'],
      timeoutMs: input.execution.timeoutMs,
    });
    if (closed()) return { kind: 'blocked', reason: '运行已关闭：不确认投递' };
    if (delivery.kind !== 'accepted') {
      return { kind: 'blocked', reason: '无法读取 Delivery：' + delivery.message };
    }
    const batch = delivery.value;
    const matched = batch.messages.find((message) => {
      const locator = parseOrcaWorkerDoneLocator(message.payload, message.body);
      return locator?.orcaTaskId === record.orcaTaskId && locator.orcaDispatchId === record.dispatchId;
    });
    if (batch.delivery === null) {
      return { kind: 'acknowledged' };
    }
    // 批归属由 central SSOT 负责：这里只按既有 ackConsumedDelivery 确认。
    if (matched === undefined) {
      return { kind: 'acknowledged' };
    }
    const acked = await ackConsumedDelivery({
      store: input.store,
      backend: input.backend,
      writer: input.writer,
      coordinationScopeId: input.coordinationScopeId,
      ...input.execution,
      deliveryId: batch.delivery.deliveryId,
      deliveryRunId: batch.delivery.runId,
    });
    return acked.kind === 'acked' ? { kind: 'acknowledged' } : { kind: 'blocked', reason: acked.message };
  };
  return { acceptResult, acknowledgeResult };
}

/**
 * 写范围准入：只有本包必须解决的冲突路径与 Worker 声明的实际修改路径需要落在授权范围内。
 *
 * 复验的读取范围（evidence.coverage，含已授权 canonical 合入的其它包文件）不在此限：跨范围读取合法，
 * 修改才受授权约束。
 */
export function revalidationWriteScopeViolation(
  scopeEnvelope: ScopeEnvelope | undefined,
  paths: readonly string[],
): string | null {
  const checkedPaths = envelopeCheckedPaths(paths);
  if (checkedPaths.length === 0) return null;
  if (scopeEnvelope === undefined) {
    return '缺少 Work Package Scope Envelope：无法核验修改范围';
  }
  const outside = pathsOutsideScopeEnvelope(scopeEnvelope, checkedPaths);
  return outside.length === 0 ? null : '复验修改超出授权范围：' + outside.join(', ');
}

/** 复验证据不得包含失败记录；覆盖范围本身不裁剪（含 canonical 合入的其它包文件）。 */
function revalidationEvidenceFailure(evidence: readonly EvidenceRecord[]): string | null {
  return evidence.some((record) => record.outcome === 'failed')
    ? '复验证据包含失败记录：不接受通过结论'
    : null;
}

/**
 * 一份复验报告的最终准入。
 *
 * 写范围只看本包解决的冲突与 Worker 声明的 filesModified；evidence 只判失败记录，其 coveredPaths 允许
 * 包含已授权 canonical 导入（只读复验，不作为写授权）。
 */
export function revalidationAdmissionFailure(
  scopeEnvelope: ScopeEnvelope | undefined,
  conflictPaths: readonly string[],
  report: RevalidationReport,
): string | null {
  const scopeFailure = revalidationWriteScopeViolation(scopeEnvelope, [...conflictPaths, ...report.filesModified]);
  if (scopeFailure !== null) return scopeFailure;
  return revalidationEvidenceFailure(report.evidence);
}

/** 构造集成复验 runner：创建/复用续接 Task，resume 原 session，等待并解析结构化结果。 */
export function createIntegrationReconciliationRuntime(
  input: IntegrationReconciliationRuntimeInput,
): IntegrationReconciliationRunner {
  const clock = input.clock ?? Date.now;
  const aborted = (): boolean => (input.signal?.aborted ?? false) || (input.isClosed?.() ?? false);
  const bindContinuation = (reconciliationId: string, orcaTaskId: string, dispatchId: DispatchId | null): { code: string; message: string } | null => {
    // store 已关闭或本轮已中止时绝不写续接身份：拒绝该次派发，由下次运行按 pending 轮次对账。
    if (aborted()) {
      return { code: 'reconciliation_aborted', message: 'store 已关闭或集成复验已中止：不写续接身份' };
    }
    const scope = input.store.query({ kind: 'scope', coordinationScopeId: input.coordinationScopeId });
    if (scope.kind !== 'scope' || scope.scope === null) {
      return { code: 'scope_unreadable', message: '无法读取 Scope revision 以登记续接身份' };
    }
    const bound = input.reconciliationStore.bindContinuation({
      coordinationScopeId: input.coordinationScopeId,
      expectedRevision: scope.scope.revision,
      writer: input.writer,
      workPackageId: input.workPackage.workPackageId as WorkPackageId,
      reconciliationId,
      orcaTaskId,
      dispatchId,
    });
    return bound.kind === 'bound' ? null : { code: bound.code, message: bound.message };
  };
  const ownerRevision = (): number | null => {
    if (aborted()) return null;
    const read = input.store.query({ kind: 'scope', coordinationScopeId: input.coordinationScopeId });
    return read.kind === 'scope' && read.scope !== null ? read.scope.revision : null;
  };
  /** exact terminal 是否已无 live owner：terminal-show 的 connected 为 false 即视为已关闭；不可核验返回 null。 */
  const terminalClosed = async (handle: string): Promise<boolean | null> => {
    const shown = await input.backend.query({ operation: 'terminal-show', terminal: handle });
    if (shown.kind !== 'accepted') return null;
    // terminal-show 已由 parseTerminalShow 归一化为扁平 TerminalSummary（handle/connected/writable/...）。
    const value = shown.value as TerminalSummary;
    return value.handle === handle ? value.connected === false : null;
  };
  /**
   * resume 前释放原 owner：证明原 Worker 已终结、exact terminal tui-idle 后，用 stable Intent 包裹 typed
   * terminal-close；unknown 按原 operationId 只读对账，绝不猜资源、不关其它 terminal、不重复 mutation。
   */
  const releaseOriginalOwner = async (
    request: IntegrationReconciliationRequest,
  ): Promise<{ readonly kind: 'ok' } | { readonly kind: 'blocked'; readonly reason: string }> => {
    const prior = input.reconciliationStore.list(input.coordinationScopeId, request.workPackageId);
    if (prior.kind === 'rejected') return { kind: 'blocked', reason: prior.message };
    const previous = prior.records.filter(record => record.round < request.round &&
      record.state === 'validated' && record.dispatchId !== null &&
      record.validationAttemptId === request.validationAttemptId &&
      record.sourceAcceptedResultRef === request.sourceAcceptedResultRef)
      .reduce<IntegrationReconciliationRecord | null>((latest, record) =>
        latest === null || record.round > latest.round ? record : latest, null);
    let owner = input.originalOwner;
    if (previous !== null) {
      const read = await input.backend.query({ operation: 'worker-show', dispatchId: previous.dispatchId! });
      const worker = read.kind === 'accepted' ? read.value as WorkerShowResult : null;
      if (worker?.dispatchId !== previous.dispatchId || worker?.taskId !== previous.orcaTaskId ||
        worker.agentTerminalHandle === null) {
        return { kind: 'blocked', reason: '前一复验轮次的精确 Worker 不可核验' };
      }
      owner = { dispatchId: previous.dispatchId as DispatchId, terminalHandle: worker.agentTerminalHandle };
    }
    if (owner === undefined) {
      // resume 需要先释放原 owner：缺精确绑定必须 fail closed，绝不 silent skip。
      return { kind: 'blocked', reason: '缺少原 Validator 的精确 owner 绑定：不能在未释放原会话前 resume' };
    }
    const operationId = ('integration-reconciliation-owner-close:' + encodeURIComponent(request.reconciliationId)) as OperationId;
    const target = { kind: 'integration-reconciliation-owner', id: owner.terminalHandle };
    const readIntent = () =>
      input.store.query({ kind: 'intent', coordinationScopeId: input.coordinationScopeId, operationId });
    const existing = readIntent();
    if (existing.kind === 'intent' && existing.intent !== null) {
      if (existing.intent.target.kind !== target.kind || existing.intent.target.id !== target.id) {
        return { kind: 'blocked', reason: '原关闭意图绑定其它 terminal：拒绝异载荷重放' };
      }
      if (existing.intent.state === 'settled' && existing.intent.outcomeClass === 'accepted') return { kind: 'ok' };
      if (existing.intent.state === 'settled') {
        return { kind: 'blocked', reason: 'owner close 已结算为拒绝：按原 operationId 对账' };
      }
      // pending / blocked：按原 ID 实际对账（该 exact terminal 是否已无 live owner），不永久阻塞。
      if ((await terminalClosed(owner.terminalHandle)) !== true) {
        return { kind: 'blocked', reason: 'owner close 结果未确定：按原 operationId 对账' };
      }
      const existingRev = ownerRevision();
      if (existingRev === null) return { kind: 'blocked', reason: '无法读取 Scope revision' };
      const finishedExisting =
        existing.intent.state === 'blocked'
          ? resolveLane(input.store, {
              coordinationScopeId: input.coordinationScopeId,
              operationId,
              writer: input.writer,
              expectedRevision: existingRev,
              outcomeClass: 'accepted',
            })
          : settleIntent(input.store, {
              coordinationScopeId: input.coordinationScopeId,
              operationId,
              writer: input.writer,
              expectedRevision: existingRev,
              outcome: { kind: 'accepted', operation: { operationId, target }, value: { closed: true } },
            });
      return finishedExisting.kind === 'rejected'
        ? { kind: 'blocked', reason: finishedExisting.rejection.message }
        : { kind: 'ok' };
    }
    const shown = await input.backend.query({ operation: 'worker-show', dispatchId: owner.dispatchId });
    if (shown.kind !== 'accepted') return { kind: 'blocked', reason: '无法读取原 Worker 状态：不释放其 terminal' };
    const facts = shown.value as WorkerShowResult;
    // 必须精确核验身份：同一 Dispatch + 同一 exact terminal + exactWorker=true，而不是只看 state。
    if (facts.dispatchId !== owner.dispatchId || facts.agentTerminalHandle !== owner.terminalHandle ||
      facts.exactWorker !== true) {
      return { kind: 'blocked', reason: '原 Worker 身份/exact terminal 无法精确核验：不释放其 terminal' };
    }
    if (workerStateLiveness(facts.workerState) !== 'exited') {
      return { kind: 'blocked', reason: '原 Worker 尚未证明终结：不释放其 terminal' };
    }
    const waited = await input.backend.query({
      operation: 'terminal-wait',
      terminal: owner.terminalHandle,
      waitFor: 'tui-idle',
      timeoutMs: input.execution.timeoutMs,
    });
    const waitSatisfied =
      waited.kind === 'accepted' &&
      (waited.value as { readonly wait?: { readonly satisfied?: unknown } }).wait?.satisfied === true;
    if (!waitSatisfied) return { kind: 'blocked', reason: '原 terminal 未确认 tui-idle（satisfied）：不关闭' };
    const rev = ownerRevision();
    if (rev === null) return { kind: 'blocked', reason: '无法读取 Scope revision' };
    const begun = beginIntent(input.store, {
      coordinationScopeId: input.coordinationScopeId,
      operationId,
      target,
      operationCategory: 'integration-reconciliation-owner-close',
      writer: input.writer,
      expectedRevision: rev,
    });
    if (begun.kind === 'rejected') return { kind: 'blocked', reason: begun.rejection.message };
    if (begun.kind === 'lane_blocked' || begun.kind === 'lane_busy') {
      return { kind: 'blocked', reason: 'owner close lane 已被未决意图阻塞' };
    }
    const finish = (): { readonly kind: 'ok' } | { readonly kind: 'blocked'; readonly reason: string } => {
      const settleRev = ownerRevision();
      if (settleRev === null) return { kind: 'blocked', reason: '无法读取 Scope revision' };
      const settled = settleIntent(input.store, {
        coordinationScopeId: input.coordinationScopeId,
        operationId,
        writer: input.writer,
        expectedRevision: settleRev,
        outcome: { kind: 'accepted', operation: { operationId, target }, value: { closed: true } },
      });
      return settled.kind === 'rejected' ? { kind: 'blocked', reason: settled.rejection.message } : { kind: 'ok' };
    };
    if (begun.kind === 'existing') {
      return (await terminalClosed(owner.terminalHandle)) === true
        ? finish()
        : { kind: 'blocked', reason: 'owner close 结果未确定：保持阻塞' };
    }
    const authority: ExecutionAuthority = {
      kind: 'execution_coordination',
      graphGeneration: input.execution.graphGeneration,
      authorizationId: input.execution.authorizationId,
      runId: input.execution.runId,
      consumerGeneration: input.execution.consumerGeneration,
    };
    if (aborted()) return { kind: 'blocked', reason: '运行已关闭：不释放原 terminal' };
    await input.backend.mutate(
      { operation: 'terminal-close', terminal: owner.terminalHandle },
      buildExecutionScope({
        coordinationScopeId: input.coordinationScopeId,
        coordinatorSessionId: input.writer.coordinatorSessionId,
        runtimeIncarnationId: input.writer.runtimeIncarnationId,
        fencingGeneration: input.writer.fencingGeneration,
        backendIdentityRef: input.execution.backendIdentityRef,
        operationId,
        target,
        expectedRevision: rev,
        timeoutMs: input.execution.timeoutMs,
        authority,
      }),
    );
    // prod 收尾只以 typed 读回为准：terminal-show 的 exact 资源必须明确 connected === false（不依赖
    // raw ptyKilled 回执；那份 probe 事实只作旁证）。
    const closedNow = await terminalClosed(owner.terminalHandle);
    if (closedNow === true) return finish();
    const blockedRev = ownerRevision();
    if (blockedRev !== null) {
      blockLane(input.store, {
        coordinationScopeId: input.coordinationScopeId,
        operationId,
        writer: input.writer,
        expectedRevision: blockedRev,
        reason: 'terminal-close 后无法证明该 exact terminal 已无 live owner',
      });
    }
    return { kind: 'blocked', reason: '无法证明原 terminal 已释放：保持阻塞，按原 operationId 对账' };
  };

  return async (request) => {
    if (aborted()) {
      return { kind: 'step_failed', code: 'reconciliation_aborted', message: '集成复验在派发前被中止或 store 已关闭' };
    }
    if (input.sandboxMode === null) {
      return { kind: 'escalation', reason: 'authority', request: 'Codex 沙箱策略未被当前 Manifest 接受：不派发未授权沙箱的集成复验' };
    }
    const live = input.liveTerminalVerified === undefined ? false : await input.liveTerminalVerified();
    const continuity = decideValidatorSessionContinuity({
      liveTerminalVerified: live,
      providerSessionId: input.originalBinding.providerSessionId.length === 0 ? null : input.originalBinding.providerSessionId,
      originalCodexHome: input.originalCodexHome,
    });
    if (continuity.kind === 'unavailable') {
      return { kind: 'session_lost', reason: continuity.message };
    }
    // 冲突路径必须落在授权范围内：Worker 的自我声明不能替代 Controller 的准入判定。
    const conflictFailure = revalidationWriteScopeViolation(input.workPackage.scopeEnvelope, request.conflictPaths);
    if (conflictFailure !== null) {
      return { kind: 'escalation', reason: 'scope', request: conflictFailure };
    }
    // 只有通过 sandbox/continuity/conflictScope 准入之后，才允许释放原 owner（不能在未授权时先 close）。
    const released = await releaseOriginalOwner(request);
    if (released.kind === 'blocked') {
      return { kind: 'step_failed', code: 'owner_release_blocked', message: released.reason };
    }
    const launchId = input.originalMaterializationBinding.launchId + ':round-' + String(request.round);
    const paths = codexSessionPathsUnder(input.companionStateRoot, launchId);
    installCodexSessionStartReporter(paths);
    const launch = createCodexResumeLaunch({
      launchId,
      modelConfiguration: input.modelConfiguration,
      sessionId: input.originalBinding.providerSessionId,
      codexHome: input.originalCodexHome,
      credentialStore: input.credentialStore,
      credentialStorePath: input.credentialStorePath,
      sandboxMode: input.sandboxMode,
      sessionStartReporterPath: paths.reporterPath,
    });
    const operationId = request.continuation.taskOperationId;
    const stepId = (step: string): OperationId => (String(operationId) + ':' + step) as OperationId;
    // 首/重放都用「本轮最早 pre-launch 意图」（task / terminal-prepare）的 createdAt 作为绑定窗口起点：
    // 它一定早于 terminal 启动与首个 turn 的 SessionStart，迟到报告不会被 observedAt < startedAt 拒绝。
    const prelaunchCreatedAt = [operationId, stepId('terminal')].reduce<number | null>((earliest, id) => {
      const read = input.store.query({
        kind: 'intent',
        coordinationScopeId: input.coordinationScopeId,
        operationId: id,
      });
      if (read.kind !== 'intent' || read.intent === null) return earliest;
      return earliest === null || read.intent.createdAt < earliest ? read.intent.createdAt : earliest;
    }, null);
    const dispatchStartedAt = new Date(prelaunchCreatedAt ?? clock()).toISOString();
    const dispatched = await dispatchScopedWorker({
      store: input.store,
      backend: input.backend,
      writer: input.writer,
      coordinationScopeId: input.coordinationScopeId,
      execution: input.execution,
      workPackageId: request.workPackageId,
      spec: continuationSpec(request, input.workPackage.scopeEnvelope),
      ...(request.continuation.existingTaskId === null ? {} : { existingOrcaTaskId: request.continuation.existingTaskId }),
      workerLaunch: launch,
      worktree: 'path:' + request.worktreePath,
      taskTitle: 'integration-reconciliation:' + request.reconciliationId,
      operationIds: {
        task: operationId,
        workerPrepare: stepId('terminal'),
        workerStart: stepId('worker-start'),
        workerActivate: stepId('activate'),
      },
      onTaskCreated: (orcaTaskId) => {
        return bindContinuation(request.reconciliationId, orcaTaskId, null);
      },
      onDispatchStarted: (orcaTaskId, dispatchId) => {
        return bindContinuation(request.reconciliationId, orcaTaskId, dispatchId as DispatchId);
      },
      // 只有新 Dispatch 自己的 SessionStart 报告能证明它确实恢复了原 provider session；无 fallback。
      observeSession: async (dispatchId): Promise<HarnessSessionFacts | null> => {
        const deadline = clock() + input.bindingWindowMs;
        for (;;) {
          if (aborted()) return null;
          if (paths.reportPath.length > 0) {
            let lines: string[] = [];
            try {
              if (existsSync(paths.reportPath)) {
                lines = readFileSync(paths.reportPath, 'utf8').split('\n').filter((line) => line.length > 0);
              }
            } catch {
              lines = [];
            }
            for (const line of lines) {
              let report: CodexSessionStartReport;
              try {
                report = JSON.parse(line) as CodexSessionStartReport;
              } catch {
                continue;
              }
              if (report.cwd !== request.worktreePath) continue;
              const bound = bindCodexSessionFromStartReport({
                facts: {
                  harness: 'codex',
                  role: 'validator',
                  // 逻辑业务身份来自续接 spec（customSpec 声明）；真实 Orca Task 由 bindContinuation 单独持久化。
                  workerTaskId: request.continuation.attemptId as WorkerTaskId,
                  dispatchId: dispatchId as DispatchId,
                  attemptId: request.validationAttemptId,
                },
                report,
                workspace: request.worktreePath,
                expectedCodexHome: input.originalCodexHome,
                dispatchStartedAt,
                bindingDeadlineAt: new Date(clock()).toISOString(),
              });
              if (bound.kind === 'bound') {
                // 报告证明的必须是原 provider session；不同 UUID 一律不当作原会话的续接。
                if (bound.binding.providerSessionId !== input.originalBinding.providerSessionId) {
                  continue;
                }
                return {
                  harness: bound.binding.harness,
                  role: bound.binding.role,
                  workerTaskId: bound.binding.workerTaskId,
                  dispatchId: bound.binding.dispatchId,
                  attemptId: bound.binding.attemptId,
                  providerSessionId: bound.binding.providerSessionId,
                  transcriptRef: bound.binding.transcriptRef,
                  observedAt: bound.binding.observedAt,
                };
              }
            }
          }
          if (clock() >= deadline) return null;
          await delay(250);
        }
      },
    });
    if (dispatched.kind === 'binding_unavailable') return { kind: 'session_lost', reason: dispatched.message };
    if (dispatched.kind === 'blocked') return { kind: 'step_failed', code: 'reconciliation_dispatch_blocked', message: dispatched.reason };
    if (dispatched.kind === 'unknown') return { kind: 'step_failed', code: 'reconciliation_dispatch_unknown', message: dispatched.reason };
    if (dispatched.kind === 'rejected') return { kind: 'step_failed', code: dispatched.code, message: dispatched.message };
    const waited = await waitForReport({
      backend: input.backend,
      execution: input.execution,
      orcaTaskId: dispatched.orcaTaskId,
      dispatchId: dispatched.dispatchId,
      timeoutMs: input.resultTimeoutMs,
      clock,
      aborted,
    });
    if (waited.kind !== 'report') {
      return { kind: 'step_failed', code: 'reconciliation_result_unreadable', message: '集成复验结构化报告缺失或不可核验：不把无法核验的结果当成验证通过' };
    }
    if (waited.report.outcome !== 'passed') {
      return { kind: 'rejected', reason: '集成复验结构化报告结论：' + waited.report.outcome };
    }
    // 证据覆盖与结论必须在授权范围内、且不含失败记录，才可能被接受。
    const admissionFailure = revalidationAdmissionFailure(
      input.workPackage.scopeEnvelope,
      request.conflictPaths,
      waited.report,
    );
    if (admissionFailure !== null) {
      return { kind: 'escalation', reason: 'scope', request: admissionFailure };
    }
    return {
      kind: 'validated',
      // 证据身份绑定到本轮轮次：可追溯到目标 HEAD 的复验，且不同轮次不会碰撞。
      evidence: waited.report.evidence.map((record, index) => ({
        ...record,
        evidenceId:
          'integration-reconciliation:' + encodeURIComponent(request.reconciliationId) + ':' + String(index),
      })),
      sessionBinding: {
        // 用实际派发得到的绑定（含真实 provider session），不复制原绑定：避免伪造不同 UUID。
        harness: dispatched.binding.harness,
        role: 'validator',
        workerTaskId: dispatched.binding.workerTaskId,
        dispatchId: dispatched.binding.dispatchId,
        attemptId: request.validationAttemptId,
        providerSessionId: dispatched.binding.providerSessionId,
        transcriptRef: dispatched.binding.transcriptRef,
        observedAt: dispatched.binding.observedAt,
      },
      orcaTaskId: dispatched.orcaTaskId,
      dispatchId: dispatched.dispatchId as DispatchId,
      treeRef: waited.report.treeRef,
      filesModified: waited.report.filesModified,
      deliveryId: waited.deliveryId,
      deliveryRunId: waited.deliveryRunId,
    } satisfies IntegrationReconciliationOutcome;
  };
}
