/** 将持久化的基线补救记录接到真实 Codex Planner 派发与 Delivery 结算。 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createCodexWorkerLaunch } from '../adapters/agents/codex-launch.js';
import { installCodexSessionStartReporter } from '../adapters/agents/codex-launch.js';
import { bindCodexSessionFromStartReport } from '../adapters/agents/session-binding.js';
import type { CodexSessionStartReport } from '../adapters/agents/codex-transcript.js';
import { driveBaselineWorker, verifyBaselineWorker } from '../adapters/agents/baseline-worker.js';
import { readDeliveryBatch } from '../adapters/orca-cli/delivery-reader.js';
import type { WorktreeListResult } from '../application/ports/execution-backend.js';
import { settleBaselineReconciliation, type BaselineReconciliationDriver } from '../application/execution/baseline-reconciliation.js';
import type { CoordinationScopeId, DispatchId, OperationId, WorkerTaskId } from '../application/dto/identity.js';
import type { BranchCoordinationStore, CoordinationWriter } from '../application/ports/branch-coordination-store.js';
import type { ExecutionBackend } from '../application/ports/execution-backend.js';
import { workPackageComment } from '../application/materialize-work-package.js';
import { loadCurrentGraph } from '../application/planning/graph-history.js';
import { workPackageOf } from '../domain/planning/execution-graph.js';
import { readBaselineGitObservations } from '../adapters/git/baseline-observer.js';
import { ackConsumedDelivery, settleDelivery } from '../application/delivery/process-delivery.js';
import { codexSessionPathsUnder, parseOrcaWorkerDoneLocator } from './execution-runtime.js';

export type BaselineReconciliationRuntimeInput = {
  readonly store: BranchCoordinationStore;
  readonly backend: ExecutionBackend;
  readonly writer: CoordinationWriter;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly execution: {
    readonly backendIdentityRef: string;
    readonly graphGeneration: number;
    readonly authorizationId: string;
    readonly runId: string;
    readonly consumerGeneration: number;
    readonly timeoutMs: number;
  };
  readonly canonicalWorktreePath: string;
  readonly repoSelector: string;
  readonly worktreePaths: ReadonlyMap<string, string>;
  readonly workerModel: string;
  readonly codexSandboxMode: Parameters<typeof createCodexWorkerLaunch>[0]['sandboxMode'] | null;
  readonly companionStateRoot: string;
  readonly bindingWindowMs: number;
};

function readReport(path: string): CodexSessionStartReport | null {
  if (!existsSync(path)) return null;
  const line = readFileSync(path, 'utf8').split('\n').find(Boolean);
  if (line === undefined) return null;
  try { return JSON.parse(line) as CodexSessionStartReport; } catch { return null; }
}

export function createBaselineReconciliationDriver(input: BaselineReconciliationRuntimeInput): BaselineReconciliationDriver {
  return async (plan) => {
    if (input.codexSandboxMode === null) {
      return { kind: 'blocked', reason: 'Codex sandbox 风险未获当前 Manifest 授权' };
    }
    const listed = await input.backend.query({ operation: 'worktree-list', repo: input.repoSelector, limit: 1_000 });
    if (listed.kind !== 'accepted') return { kind: 'blocked', reason: `worktree-list: ${listed.message}` };
    const worktrees = listed.value as WorktreeListResult;
    if (worktrees.truncated || worktrees.hostScope === null || worktrees.hostScope.omittedHostIds.length > 0) {
      return { kind: 'blocked', reason: 'worktree-list 范围不完整' };
    }
    const path = input.worktreePaths.get(plan.workPackageId);
    const matches = worktrees.worktrees.filter((entry) =>
      entry.path === path && entry.comment === workPackageComment(plan.workPackageId) && !entry.isMainWorktree);
    if (matches.length !== 1) return { kind: 'blocked', reason: '基线补救 worktree 无法唯一定位' };
    const worktree = matches[0]!;
    const launchId = `baseline-reconciliation:${encodeURIComponent(plan.reconciliationId)}`;
    const paths = codexSessionPathsUnder(input.companionStateRoot, launchId);
    installCodexSessionStartReporter(paths);
    const dispatchStartedAt = new Date().toISOString();
    const operationId = (step: string): OperationId => `op:${launchId}:${step}` as OperationId;
    const workerInput = {
      ...input,
      plan,
      canonicalWorktree: input.canonicalWorktreePath,
      worktree: worktree.worktreeId,
      workerLaunch: createCodexWorkerLaunch({
        launchId, model: input.workerModel, sandboxMode: input.codexSandboxMode,
        stateRoot: paths.stateRoot, sessionStartReporterPath: paths.reporterPath,
      }),
      operationIds: {
        task: operationId('task'), workerPrepare: operationId('terminal'),
        workerStart: operationId('worker-start'), workerActivate: operationId('activate'),
      },
      observeSession: async (dispatchId: string) => {
        const deadline = Date.now() + input.bindingWindowMs;
        while (Date.now() < deadline) {
          const report = readReport(paths.reportPath);
          if (report !== null) {
            const bound = bindCodexSessionFromStartReport({
              facts: {
                harness: 'codex', role: 'planner', workerTaskId: plan.reconciliationId as WorkerTaskId,
                dispatchId: dispatchId as DispatchId, attemptId: plan.reconciliationId,
              },
              report,
              workspace: worktree.path,
              expectedCodexHome: join(paths.stateRoot, createHash('sha256').update(launchId).digest('hex').slice(0, 20)),
              dispatchStartedAt, bindingDeadlineAt: new Date().toISOString(),
            });
            return bound.kind === 'bound' ? {
              harness: bound.binding.harness, role: bound.binding.role,
              workerTaskId: bound.binding.workerTaskId, dispatchId: bound.binding.dispatchId,
              attemptId: bound.binding.attemptId, providerSessionId: bound.binding.providerSessionId,
              transcriptRef: bound.binding.transcriptRef, observedAt: bound.binding.observedAt,
            } : null;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 250));
        }
        return null;
      },
    };
    const driven = await driveBaselineWorker(workerInput);
    if (driven.kind !== 'waiting') return driven;
    const recordRead = input.store.query({
      kind: 'baseline-reconciliations', coordinationScopeId: input.coordinationScopeId,
      workPackageId: plan.workPackageId,
    });
    const record = recordRead.kind === 'baseline-reconciliations'
      ? recordRead.reconciliations.find((entry) => entry.reconciliationId === plan.reconciliationId) : undefined;
    if (record?.orcaTaskId === null || record?.dispatchId === null || record === undefined) {
      return { kind: 'blocked', reason: '基线补救 Task/Dispatch 绑定不可读' };
    }
    const delivery = await readDeliveryBatch(input.backend, {
      backendIdentityRef: input.execution.backendIdentityRef, runId: input.execution.runId,
      types: ['worker_done'], timeoutMs: input.execution.timeoutMs,
    });
    if (delivery.kind !== 'accepted') return { kind: 'blocked', reason: `Delivery 不可读：${delivery.message}` };
    const batch = delivery.value;
    if (batch.delivery === null) return batch.messages.length === 0
      ? { kind: 'waiting' } : { kind: 'blocked', reason: '基线补救 Delivery 缺少稳定身份' };
    const matched = batch.messages.find((message) => {
      const locator = parseOrcaWorkerDoneLocator(message.payload, message.body);
      return locator?.orcaTaskId === record.orcaTaskId && locator.orcaDispatchId === record.dispatchId;
    });
    if (matched === undefined) {
      if (batch.messages.some((message) => message.type === 'worker_done')) return { kind: 'waiting' };
      const acked = await ackConsumedDelivery({
        store: input.store, backend: input.backend, writer: input.writer,
        coordinationScopeId: input.coordinationScopeId,
        ...input.execution,
        deliveryId: batch.delivery.deliveryId, deliveryRunId: batch.delivery.runId,
      });
      return acked.kind === 'acked' ? { kind: 'waiting' } : { kind: 'blocked', reason: acked.message };
    }
    const locator = parseOrcaWorkerDoneLocator(matched.payload, matched.body);
    if (locator === null) return { kind: 'blocked', reason: '基线补救结果无法定位' };
    const scope = input.store.query({ kind: 'scope', coordinationScopeId: input.coordinationScopeId });
    const authorization = input.store.query({
      kind: 'authorization', coordinationScopeId: input.coordinationScopeId,
      authorizationId: input.execution.authorizationId,
    });
    const graph = scope.kind === 'scope' && scope.scope?.graphId !== null && scope.scope?.graphId !== undefined
      ? loadCurrentGraph({ store: input.store, coordinationScopeId: input.coordinationScopeId, graphId: scope.scope.graphId })
      : null;
    const workPackage = graph?.kind === 'loaded' ? workPackageOf(graph.version.graph, plan.workPackageId) : null;
    if (scope.kind !== 'scope' || scope.scope === null || authorization.kind !== 'authorization' ||
        authorization.authorization === null || workPackage === null || graph?.kind !== 'loaded') {
      return { kind: 'blocked', reason: '基线补救的当前图、授权或 Scope 不可核验' };
    }
    const observed = await readBaselineGitObservations({
      worktreePath: worktree.path, requiredBaselineHead: plan.requiredBaselineHead,
    });
    if (observed.kind !== 'observed') return { kind: 'blocked', reason: observed.reason };
    const specBinding = {
      provider: 'openspec', relativePath: 'openspec/specs/execution/graph-patching/spec.md',
      contentDigest: createHash('sha256').update(plan.reconciliationId).digest('hex'),
      providerVersion: '1', contractRevision: graph.version.version, trackingRevision: graph.version.version,
    };
    const attribution = {
      runId: input.execution.runId, consumerGeneration: input.execution.consumerGeneration,
      graphGeneration: input.execution.graphGeneration, authorizationId: input.execution.authorizationId,
      workerTaskId: plan.reconciliationId as WorkerTaskId,
      dispatchId: record.dispatchId, attemptId: plan.reconciliationId,
      role: 'planner' as const, specBinding, worktreeId: worktree.worktreeId,
    };
    const settled = await settleDelivery({
      store: input.store, backend: input.backend, writer: input.writer,
      coordinationScopeId: input.coordinationScopeId,
      expectedRevision: scope.scope.revision,
      ...input.execution,
      orcaTaskId: record.orcaTaskId,
      delivery: {
        deliveryId: batch.delivery.deliveryId,
        claimed: attribution,
        acceptedResult: { outcome: locator.outcome, filesModified: locator.files, summary: locator.summary },
      },
      trusted: {
        ...attribution, authority: authorization.authorization.manifest.permissions,
        scopeEnvelope: workPackage.scopeEnvelope, changedPaths: observed.git.dirtyPaths,
      },
      operationIds: {
        acceptResult: operationId(`accept:${batch.delivery.deliveryId}`),
        ack: operationId(`ack:${batch.delivery.deliveryId}`),
      },
    });
    if (settled.kind !== 'settled' && settled.kind !== 'replayed') {
      return { kind: 'blocked', reason: settled.kind === 'rejected' ? settled.failure.message :
        settled.kind === 'unknown' ? settled.reason : `${settled.kind}: 基线结果未结算` };
    }
    if (locator.outcome !== 'succeeded') {
      settleBaselineReconciliation({
        store: input.store, coordinationScopeId: input.coordinationScopeId, writer: input.writer,
        reconciliationId: plan.reconciliationId,
        observations: {
          observedHead: observed.git.observedHead,
          ancestryVerified: false, targetHeadVerified: false,
          dirtyPathsReconciled: false, scopeReconciled: false,
        },
      });
      return { kind: 'blocked', reason: `基线补救 Worker 结果：${locator.outcome}` };
    }
    const verified = await verifyBaselineWorker(workerInput);
    return verified.kind === 'verified' || verified.kind === 'blocked'
      ? verified : { kind: 'blocked', reason: verified.message };
  };
}
