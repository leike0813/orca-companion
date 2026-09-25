/** Graph Patch Planner 的生产 Worker port：Task、Session 与 Delivery 都按可信身份核验。 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createCodexWorkerLaunch, installCodexSessionStartReporter } from '../adapters/agents/codex-launch.js';
import { bindCodexSessionFromStartReport } from '../adapters/agents/session-binding.js';
import type { CodexSessionStartReport } from '../adapters/agents/codex-transcript.js';
import { readDeliveryBatch } from '../adapters/orca-cli/delivery-reader.js';
import { dispatchScopedWorker, type ScopedWorkerDispatchInput } from '../adapters/agents/utility-worker.js';
import { ackConsumedDelivery, settleDelivery } from '../application/delivery/process-delivery.js';
import type { DispatchId, OperationId, WorkerTaskId } from '../application/dto/identity.js';
import { workerStateLiveness } from '../application/execution/execution-view.js';
import type { GraphPatchPlannerOutcome, GraphPatchPlannerRequest } from '../application/execution/graph-patch-planner.js';
import { graphPatchPlannerInstruction } from '../application/execution/graph-patch-planner.js';
import type { BranchCoordinationStore, CoordinationWriter } from '../application/ports/branch-coordination-store.js';
import type { ExecutionBackend } from '../application/ports/execution-backend.js';
import type { SpecBinding } from '../domain/task-contract.js';
import type { WorkerListResult } from '../adapters/orca-cli/operation-catalog.js';
import { codexSessionPathsUnder, parseOrcaWorkerDoneLocator } from './execution-runtime.js';

export type GraphPatchWorkerInput = {
  readonly store: BranchCoordinationStore;
  readonly backend: ExecutionBackend;
  readonly writer: CoordinationWriter;
  readonly request: GraphPatchPlannerRequest;
  readonly execution: ScopedWorkerDispatchInput['execution'];
  readonly canonicalWorktreePath: string;
  readonly companionStateRoot: string;
  readonly workerModel: string;
  readonly bindingWindowMs: number;
  readonly reportTimeoutMs: number;
};

function scopeRevision(input: GraphPatchWorkerInput): number | null {
  const read = input.store.query({ kind: 'scope', coordinationScopeId: input.request.coordinationScopeId });
  return read.kind === 'scope' && read.scope !== null ? read.scope.revision : null;
}

function readReport(path: string): CodexSessionStartReport | null {
  if (!existsSync(path)) return null;
  const line = readFileSync(path, 'utf8').split('\n').find(Boolean);
  if (line === undefined) return null;
  try {
    return JSON.parse(line) as CodexSessionStartReport;
  } catch {
    return null;
  }
}

/** Worker 正文必须是一份完整 JSON 草案；Markdown 包裹会造成不可核验的额外内容。 */
function draftFromBody(body: string | null): Record<string, unknown> | null {
  if (body === null) return null;
  try {
    const draft: unknown = JSON.parse(body.trim());
    return typeof draft === 'object' && draft !== null && !Array.isArray(draft)
      ? draft as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function taskRows(value: unknown): readonly Record<string, unknown>[] | null {
  const rows = Array.isArray(value) ? value :
    typeof value === 'object' && value !== null && Array.isArray((value as Record<string, unknown>)['tasks'])
      ? (value as { tasks: unknown[] }).tasks : null;
  return rows === null ? null : rows.filter((row): row is Record<string, unknown> =>
    typeof row === 'object' && row !== null && !Array.isArray(row));
}

function recordedDraft(value: unknown): Record<string, unknown> | null {
  const result = typeof value === 'string' ? draftFromBody(value) : value;
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return null;
  const record = result as Record<string, unknown>;
  return record['kind'] === 'graph_patch' &&
    typeof record['draft'] === 'object' && record['draft'] !== null && !Array.isArray(record['draft'])
    ? record['draft'] as Record<string, unknown> : null;
}

/** 同一工具调用始终使用同一组 OperationId；重放发现已登记派发时停止，绝不新建 Task。 */
export async function runGraphPatchPlannerWorker(input: GraphPatchWorkerInput): Promise<GraphPatchPlannerOutcome> {
  const { request, execution } = input;
  const scope = input.store.query({ kind: 'scope', coordinationScopeId: request.coordinationScopeId });
  if (scope.kind !== 'scope' || scope.scope === null || scope.scope.mode !== 'execution_coordination' ||
      scope.scope.controlState !== 'active' || scope.scope.graphId !== request.graphId ||
      scope.scope.graphVersion !== request.baseGraphVersion || scope.scope.authorizationId !== execution.authorizationId) {
    return { kind: 'rejected', code: 'graph_scope_changed', message: '当前 Scope、图版本或授权已变化' };
  }
  const authorization = input.store.query({
    kind: 'authorization', coordinationScopeId: request.coordinationScopeId, authorizationId: execution.authorizationId,
  });
  if (authorization.kind !== 'authorization' || authorization.authorization === null ||
      !authorization.authorization.manifest.permissions.planner ||
      !authorization.authorization.manifest.workerProfiles.some((profile) => profile.role === 'planner' && profile.harness === 'codex')) {
    return { kind: 'rejected', code: 'planner_not_authorized', message: '当前授权未批准 Codex Planner' };
  }
  const operationId = (step: string): OperationId => `${request.operationId}:${step}` as OperationId;
  const workerTaskId = `${request.patchId}:planner-task` as WorkerTaskId;
  const attemptId = `${request.patchId}:planner-attempt`;
  const launchId = `${request.patchId}:planner-launch`;
  const paths = codexSessionPathsUnder(input.companionStateRoot, launchId);
  installCodexSessionStartReporter(paths);
  const instruction = graphPatchPlannerInstruction(request);
  const spec = JSON.stringify({
    schemaVersion: 1,
    taskKind: 'graph-patch-planner',
    role: 'planner',
    graphId: request.graphId,
    baseGraphVersion: request.baseGraphVersion,
    patchId: request.patchId,
    workerTaskId,
    attemptId,
    readOnly: true,
    instruction: `${instruction}\n\n将完整 JSON 草案作为 worker_done 正文提交；正文不得包含 Markdown 或其它文字。`,
  });
  const specBinding: SpecBinding = {
    provider: 'openspec',
    relativePath: 'openspec/specs/execution/graph-patching/spec.md',
    contentDigest: createHash('sha256').update(spec).digest('hex'),
    providerVersion: '1',
    contractRevision: request.baseGraphVersion,
    trackingRevision: request.baseGraphVersion,
  };
  const prior = input.store.query({ kind: 'intent', coordinationScopeId: request.coordinationScopeId, operationId: operationId('task') });
  if (prior.kind !== 'intent') {
    return { kind: 'rejected', code: 'intent_unreadable', message: '无法核验既有 Planner 派发' };
  }
  if (prior.intent !== null && (prior.intent.state !== 'settled' || prior.intent.outcomeClass !== 'accepted')) {
    return { kind: 'unknown', reason: `Planner 派发 ${operationId('task')} 尚未确定，须按原身份对账` };
  }
  const workers = await input.backend.query({ operation: 'worker-list', runId: execution.runId });
  if (workers.kind !== 'accepted') {
    return { kind: 'rejected', code: workers.code, message: `无法核验运行中 Worker：${workers.message}` };
  }
  let resumed: { readonly orcaTaskId: string; readonly dispatchId: string } | null = null;
  if (prior.intent !== null) {
    const listed = await input.backend.query({
      operation: 'task-list', backendIdentityRef: execution.backendIdentityRef, runId: execution.runId,
    });
    const rows = listed.kind === 'accepted' ? taskRows(listed.value) : null;
    if (rows === null) return { kind: 'unknown', reason: '已登记 Planner Task，但 Orca Task 清单不可核验' };
    const matches = rows.filter((row) => row['spec'] === spec);
    if (matches.length !== 1 || typeof matches[0]?.['id'] !== 'string') {
      return { kind: 'unknown', reason: '已登记 Planner Task，但无法按精确 Task Envelope 唯一定位' };
    }
    const orcaTaskId = matches[0]['id'];
    const draft = recordedDraft(matches[0]['result']);
    const snapshot = input.store.query({ kind: 'snapshot', coordinationScopeId: request.coordinationScopeId });
    const settlement = snapshot.kind === 'snapshot'
      ? snapshot.snapshot.deliverySettlements.find((entry) =>
          entry.workerTaskId === workerTaskId && entry.role === 'planner' &&
          entry.runId === execution.runId && entry.consumerGeneration === execution.consumerGeneration &&
          entry.orcaResultRef.startsWith(`${orcaTaskId}#`))
      : undefined;
    if (settlement !== undefined) {
      if (draft !== null) return { kind: 'accepted', draftRef: settlement.orcaResultRef, payload: draft };
      const result = typeof matches[0]['result'] === 'string'
        ? draftFromBody(matches[0]['result']) : matches[0]['result'];
      if (typeof result === 'object' && result !== null && 'outcome' in result) {
        return { kind: 'rejected', code: 'planner_failed', message: 'Graph Patch Planner 未成功交付结构化草案' };
      }
    }
    const dispatches = (workers.value as WorkerListResult).workers.filter((worker) =>
      worker.taskId === orcaTaskId && worker.runId === execution.runId && worker.dispatchId !== null);
    const dispatch = dispatches[0];
    if (dispatches.length !== 1 || dispatch === undefined || dispatch.dispatchId === null) {
      return { kind: 'unknown', reason: 'Planner Task 已登记，但无法按原 Task/Run 唯一定位 Dispatch' };
    }
    const report = readReport(paths.reportPath);
    if (report === null || report.observedAt === null) {
      return { kind: 'unknown', reason: 'Planner Dispatch 已登记，但精确 Codex SessionStart 报告不可读' };
    }
    const bound = bindCodexSessionFromStartReport({
      facts: { harness: 'codex', role: 'planner', workerTaskId,
        dispatchId: dispatch.dispatchId as DispatchId, attemptId },
      report,
      workspace: input.canonicalWorktreePath,
      expectedCodexHome: join(paths.stateRoot, createHash('sha256').update(launchId).digest('hex').slice(0, 20)),
      dispatchStartedAt: report.observedAt,
      bindingDeadlineAt: report.observedAt,
    });
    if (bound.kind !== 'bound') return { kind: 'unknown', reason: `Planner Session Binding 不可核验：${bound.message}` };
    resumed = { orcaTaskId, dispatchId: dispatch.dispatchId };
  } else {
    if ((workers.value as WorkerListResult).workers.some((worker) => workerStateLiveness(worker.workerState) !== 'exited')) {
      return { kind: 'rejected', code: 'worker_in_flight', message: '存在运行中或不可核验的 Worker，不能开始 Graph Patch Planner' };
    }
    const pending = await readDeliveryBatch(input.backend, {
      backendIdentityRef: execution.backendIdentityRef, runId: execution.runId,
      types: ['worker_done'], timeoutMs: execution.timeoutMs,
    });
    if (pending.kind !== 'accepted' || pending.value.delivery !== null || pending.value.messages.length > 0) {
      return { kind: 'rejected', code: 'delivery_pending', message: '存在未确认或不可读的 Delivery，先完成对账' };
    }
  }
  const dispatchStartedAt = new Date().toISOString();
  const dispatched = resumed === null ? await dispatchScopedWorker({
    store: input.store,
    backend: input.backend,
    writer: input.writer,
    coordinationScopeId: request.coordinationScopeId,
    workPackageId: request.patchId,
    spec,
    taskTitle: `Graph Patch Planner ${request.patchId}`,
    execution,
    workerLaunch: createCodexWorkerLaunch({
      launchId,
      model: input.workerModel,
      sandboxMode: 'read-only-local-control',
      stateRoot: paths.stateRoot,
      sessionStartReporterPath: paths.reporterPath,
    }),
    worktree: `path:${input.canonicalWorktreePath}`,
    operationIds: {
      task: operationId('task'),
      workerPrepare: operationId('terminal'),
      workerStart: operationId('worker-start'),
      workerActivate: operationId('activate'),
    },
    observeSession: async (dispatchId) => {
      const deadline = Date.now() + input.bindingWindowMs;
      while (Date.now() < deadline) {
        const report = readReport(paths.reportPath);
        if (report !== null) {
          const bound = bindCodexSessionFromStartReport({
            facts: {
              harness: 'codex', role: 'planner', workerTaskId,
              dispatchId: dispatchId as DispatchId, attemptId,
            },
            report,
            workspace: input.canonicalWorktreePath,
            expectedCodexHome: join(paths.stateRoot, createHash('sha256').update(launchId).digest('hex').slice(0, 20)),
            dispatchStartedAt,
            bindingDeadlineAt: new Date().toISOString(),
          });
          return bound.kind === 'bound' ? {
            harness: bound.binding.harness,
            role: bound.binding.role,
            workerTaskId: bound.binding.workerTaskId,
            dispatchId: bound.binding.dispatchId,
            attemptId: bound.binding.attemptId,
            providerSessionId: bound.binding.providerSessionId,
            transcriptRef: bound.binding.transcriptRef,
            observedAt: bound.binding.observedAt,
          } : null;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
      }
      return null;
    },
  }) : { kind: 'dispatched' as const, ...resumed };
  if (dispatched.kind !== 'dispatched') {
    return dispatched.kind === 'unknown'
      ? { kind: 'unknown', reason: `${dispatched.operationId}: ${dispatched.reason}` }
      : dispatched.kind === 'rejected'
        ? { kind: 'rejected', code: dispatched.code, message: dispatched.message }
        : { kind: 'unknown', reason: dispatched.kind === 'blocked' ? dispatched.reason : dispatched.message };
  }

  const deadline = Date.now() + input.reportTimeoutMs;
  while (Date.now() < deadline) {
    const batch = await readDeliveryBatch(input.backend, {
      backendIdentityRef: execution.backendIdentityRef,
      runId: execution.runId,
      wait: true,
      types: ['worker_done'],
      timeoutMs: Math.min(30_000, deadline - Date.now()),
    });
    if (batch.kind !== 'accepted') {
      return { kind: 'unknown', reason: `Planner Delivery 不可读：${batch.code} ${batch.message}` };
    }
    const identity = batch.value.delivery;
    if (identity === null) {
      if (batch.value.messages.length > 0) return { kind: 'unknown', reason: 'Planner Delivery 缺少稳定身份' };
      continue;
    }
    const results = batch.value.messages.filter((message) => message.type === 'worker_done');
    if (results.length === 0) {
      const acked = await ackConsumedDelivery({
        store: input.store, backend: input.backend, writer: input.writer,
        coordinationScopeId: request.coordinationScopeId,
        backendIdentityRef: execution.backendIdentityRef,
        graphGeneration: execution.graphGeneration,
        authorizationId: execution.authorizationId,
        runId: execution.runId,
        consumerGeneration: execution.consumerGeneration,
        timeoutMs: execution.timeoutMs,
        deliveryId: identity.deliveryId,
        deliveryRunId: identity.runId,
      });
      if (acked.kind !== 'acked') return { kind: 'unknown', reason: acked.message };
      continue;
    }
    const matched = results.find((message) => {
      const locator = parseOrcaWorkerDoneLocator(message.payload, message.body);
      return locator?.orcaTaskId === dispatched.orcaTaskId && locator.orcaDispatchId === dispatched.dispatchId;
    });
    if (matched === undefined) return { kind: 'unknown', reason: '当前未确认 Delivery 属于其它 Worker；Planner 结果仍待对账' };
    const locator = parseOrcaWorkerDoneLocator(matched.payload, matched.body);
    if (locator === null) return { kind: 'unknown', reason: 'Planner Delivery 缺少可核验的结果定位' };
    if (locator.files.length > 0) {
      return { kind: 'rejected', code: 'planner_modified_files', message: '只读 Graph Patch Planner 报告了文件改动' };
    }
    const draft = locator.outcome === 'succeeded' ? draftFromBody(matched.body) : null;
    if (locator.outcome === 'succeeded' && draft === null) {
      return { kind: 'rejected', code: 'invalid_planner_draft', message: 'Planner 的 worker_done 正文不是完整 JSON 对象' };
    }
    const attribution = {
      runId: execution.runId,
      consumerGeneration: execution.consumerGeneration,
      graphGeneration: execution.graphGeneration,
      authorizationId: execution.authorizationId,
      workerTaskId,
      dispatchId: dispatched.dispatchId as DispatchId,
      attemptId,
      role: 'planner' as const,
      specBinding,
      worktreeId: `path:${input.canonicalWorktreePath}`,
    };
    const revision = scopeRevision(input);
    if (revision === null) return { kind: 'unknown', reason: '无法重读 Scope revision 以结算 Planner Delivery' };
    const settled = await settleDelivery({
      store: input.store, backend: input.backend, coordinationScopeId: request.coordinationScopeId,
      writer: input.writer, expectedRevision: revision,
      backendIdentityRef: execution.backendIdentityRef,
      graphGeneration: execution.graphGeneration,
      authorizationId: execution.authorizationId,
      runId: execution.runId,
      consumerGeneration: execution.consumerGeneration,
      timeoutMs: execution.timeoutMs,
      orcaTaskId: dispatched.orcaTaskId,
      delivery: {
        deliveryId: identity.deliveryId,
        claimed: attribution,
        acceptedResult: draft === null
          ? { kind: 'graph_patch', outcome: locator.outcome, summary: locator.summary }
          : { kind: 'graph_patch', draft },
      },
      trusted: {
        ...attribution,
        authority: authorization.authorization.manifest.permissions,
        scopeEnvelope: { include: ['**'], exclude: [] },
        changedPaths: locator.files,
      },
      operationIds: { acceptResult: operationId('accept-result'), ack: operationId('ack') },
    });
    if (settled.kind === 'settled' || settled.kind === 'replayed') {
      if (draft === null) return { kind: 'rejected', code: 'planner_failed', message: 'Graph Patch Planner 未成功交付结构化草案' };
      return { kind: 'accepted', draftRef: settled.kind === 'settled' ? settled.orcaResultRef : settled.settlement.orcaResultRef, payload: draft };
    }
    return settled.kind === 'rejected'
      ? { kind: 'rejected', code: settled.failure.code, message: settled.failure.message }
      : { kind: 'unknown', reason: settled.kind === 'unknown' ? settled.reason : `${settled.kind}: Planner 结果未结算` };
  }
  return { kind: 'unknown', reason: `等待 Graph Patch Planner ${request.patchId} 的结果超时；派发身份已登记` };
}
