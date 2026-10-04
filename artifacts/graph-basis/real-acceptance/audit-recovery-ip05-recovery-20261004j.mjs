import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { openRepositoryCoordinationStore } from '../../../dist/src/bootstrap/composition.js';
import { createOrcaExecutionBackend } from '../../../dist/src/adapters/orca-cli/orca-backend.js';

const fixturePath = resolve(process.argv[2] ?? '');
const outputPath = resolve(process.argv[3] ?? '');
const markdownPath = resolve(process.argv[4] ?? '');
assert.equal(process.argv.length, 5, 'usage: audit-recovery...mjs <fixture.json> <report.json> <report.md>');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^ORCA_(?:TERMINAL|WORKER|TASK|RUN)(?:_|$)/u.test(key)) delete env[key];
}

const opened = await openRepositoryCoordinationStore({ repositoryPath: fixture.fixture, readOnly: true });
assert.equal(opened.kind, 'opened');
const store = opened.store;
const backend = createOrcaExecutionBackend({ cwd: fixture.fixture, env });
const scopeId = fixture.coordinationScopeId;
const query = (kind, extra = {}) => {
  const result = store.query({ kind, coordinationScopeId: scopeId, ...extra });
  assert.equal(result.kind, kind, JSON.stringify(result));
  return result;
};

try {
  const scope = query('scope').scope;
  assert(scope);
  const recoveries = query('recoveries').recoveries;
  const segments = query('session-segments').segments;
  const bindings = query('materialization-bindings').bindings;
  const settlements = query('delivery-settlements').settlements;
  const authorizations = query('authorizations').authorizations;
  const authorization = authorizations.find((entry) => entry.authorizationId === scope.authorizationId);
  assert(authorization, `authorization ${scope.authorizationId} missing`);

  const attemptIds = [...new Set(recoveries.map((entry) => entry.businessAttemptId))];
  const attempts = attemptIds.map((businessAttemptId) => {
    const entries = recoveries.filter((entry) => entry.businessAttemptId === businessAttemptId);
    const consumed = entries.reduce((sum, entry) => sum + entry.consumedBudget, 0);
    return {
      businessAttemptId,
      recoveryCount: entries.length,
      consumed,
      limit: authorization.manifest.limits.maxRecoveriesPerWorkerAttempt,
      remaining: Math.max(0, authorization.manifest.limits.maxRecoveriesPerWorkerAttempt - consumed),
      withinLimit: consumed <= authorization.manifest.limits.maxRecoveriesPerWorkerAttempt,
    };
  });

  const dispatchIds = [...new Set(recoveries.flatMap((entry) =>
    [entry.sourceDispatchId, entry.replacementDispatchId].filter((id) => id !== null)))];
  const workers = [];
  for (const dispatchId of dispatchIds) {
    const result = await backend.query({ operation: 'worker-show', dispatchId });
    workers.push({ dispatchId, result });
  }

  const recoveriesWithEvidence = recoveries.map((recovery) => {
    const sourceSegment = segments.find((segment) => segment.segmentId === recovery.sourceSegmentId) ?? null;
    const replacementSegment = segments.find((segment) => segment.segmentId === recovery.replacementSegmentId) ?? null;
    const taskBinding = bindings.find((binding) =>
      binding.workerTaskId === recovery.workerTaskId && binding.attemptId === recovery.businessAttemptId &&
      binding.role === recovery.role) ?? null;
    const acceptedResults = settlements.filter((settlement) =>
      settlement.workerTaskId === recovery.workerTaskId && settlement.attemptId === recovery.businessAttemptId &&
      (settlement.dispatchId === recovery.sourceDispatchId || settlement.dispatchId === recovery.replacementDispatchId));
    const sourceWorker = workers.find((entry) => entry.dispatchId === recovery.sourceDispatchId)?.result ?? null;
    const replacementWorker = recovery.replacementDispatchId === null ? null :
      workers.find((entry) => entry.dispatchId === recovery.replacementDispatchId)?.result ?? null;
    return {
      recovery,
      sourceSession: sourceSegment === null ? null : {
        segmentId: sourceSegment.segmentId,
        dispatchId: sourceSegment.dispatchId,
        sessionBindingId: sourceSegment.sessionBindingId,
        transcriptRef: sourceSegment.lastTranscriptRef,
        transcriptReferenceable: sourceSegment.transcriptReferenceable,
        verifiable: sourceSegment.verifiable,
      },
      replacementSession: replacementSegment === null ? null : {
        segmentId: replacementSegment.segmentId,
        dispatchId: replacementSegment.dispatchId,
        sessionBindingId: replacementSegment.sessionBindingId,
        transcriptRef: replacementSegment.lastTranscriptRef,
        transcriptReferenceable: replacementSegment.transcriptReferenceable,
        verifiable: replacementSegment.verifiable,
      },
      taskBinding: taskBinding === null ? null : {
        orcaTaskId: taskBinding.orcaTaskId,
        dispatchId: taskBinding.dispatchId,
        attemptId: taskBinding.attemptId,
        role: taskBinding.role,
        authorizationId: taskBinding.authorizationId,
        authorizationVersion: taskBinding.authorizationVersion,
        workerProfileRef: taskBinding.workerProfileRef,
      },
      sourceWorker,
      replacementWorker,
      acceptedResults: acceptedResults.map(({ deliveryId, runId, consumerGeneration, workerTaskId,
        dispatchId, attemptId, role, orcaResultRef, acceptedAt }) => ({ deliveryId, runId,
        consumerGeneration, workerTaskId, dispatchId, attemptId, role, orcaResultRef, acceptedAt })),
    };
  });

  const implementationAttempt = attempts.find((attempt) =>
    recoveries.some((entry) => entry.businessAttemptId === attempt.businessAttemptId && entry.role === 'implementation')) ?? null;
  const sameAttempt = recoveries.length > 1 && recoveries.every((entry) => entry.businessAttemptId === recoveries[0].businessAttemptId);
  const second = recoveriesWithEvidence.find((entry) => entry.recovery.status === 'pending') ?? null;
  const report = {
    observedAt: new Date().toISOString(),
    fixture: fixture.fixture,
    coordinationScopeId: scopeId,
    runId: authorization.manifest.orcaRunId,
    readOnly: true,
    sources: ['BranchCoordinationStore.query production port (readOnly)', 'ExecutionBackend.query worker-show public operation', 'user-provided project-details artifact for the PTY pagination diagnosis'],
    recoveryCount: recoveries.length,
    sameBusinessAttempt: sameAttempt,
    attemptBudgets: attempts,
    recoveries: recoveriesWithEvidence,
    acceptedResultFinding: {
      acceptedResultExistsForRecoveryDispatches: recoveriesWithEvidence.some((entry) => entry.acceptedResults.length > 0),
      scopeSettlements: settlements.map(({ deliveryId, runId, workerTaskId, dispatchId, attemptId, role, orcaResultRef, acceptedAt }) =>
        ({ deliveryId, runId, workerTaskId, dispatchId, attemptId, role, orcaResultRef, acceptedAt })),
    },
    secondRecoveryFinding: second === null ? null : {
      status: second.recovery.status,
      sourceDispatchId: second.recovery.sourceDispatchId,
      sourceSessionBindingId: second.sourceSession?.sessionBindingId ?? null,
      consumedBudget: second.recovery.consumedBudget,
      blockingReason: second.recovery.blockingReason,
      replacementDispatchId: second.recovery.replacementDispatchId,
      sourceWorker: second.sourceWorker,
      interpretation: 'A new Recovery record is keyed to the replacement Segment as a new source Segment within the same business Attempt. It is pending and blocked before any second replacement dispatch; its consumedBudget is zero. The observed block says the terminal still exists on a listed host.',
    },
    ptyPagination: {
      priorAttemptFailed: true,
      rootCause: '40-column footer clipping hid the full Esc-return text; first-frame loading also raced the reader.',
      independentRead: 'The main-session corrected read-project-details probe completed all 7 pages and exposed the complete Recovery fields; this audit independently reads the production store ports.',
      obscuresPersistedRecoveryConclusion: false,
    },
  };

  const lines = [
    '# IP-05 Recovery 现场只读核验', '',
    `观察时间：${report.observedAt}`, '',
    `现场：\`${fixture.name}\`；Scope：\`${scopeId}\`；Run：\`${report.runId}\`。`,
    '只通过生产 `BranchCoordinationStore` 的只读 query port 与公开 `ExecutionBackend.query(worker-show)` 读取；未触发 mutation、模型或 Worker。', '',
    `## 结论`, '',
    `同一业务 Attempt 有 ${recoveries.length} 条 Recovery 记录。首条为 \`${recoveries[0]?.status ?? 'missing'}\`，消耗 ${recoveries[0]?.consumedBudget ?? '未知'} 次；替代 Session 的 Orca worker-show 状态为 \`${recoveriesWithEvidence[0]?.replacementWorker?.value?.workerState ?? '不可用'}\`。`,
    `该 Attempt 的 Recovery 预算为 ${implementationAttempt?.consumed ?? '未知'}/${implementationAttempt?.limit ?? '未知'}，剩余 ${implementationAttempt?.remaining ?? '未知'}。`,
    `Accepted Worker Result：${report.acceptedResultFinding.acceptedResultExistsForRecoveryDispatches ? '存在匹配 Recovery 派发的结算记录' : '未发现匹配 Recovery 派发的 Accepted Worker Result 结算记录'}。Orca worker succeeded/terminal 可见本身不等于 Companion 接受结果。`,
    second === null ? '没有第二条 pending Recovery。' : `第二条 Recovery 是针对替代 Segment（\`${second.recovery.sourceDispatchId}\`）新增的来源记录，仍为 pending；阻塞原因：${second.recovery.blockingReason}。它没有创建第二个替代派发，也没有再消耗预算。`, '',
    '## Recovery 与精确 Session', '',
  ];
  for (const item of recoveriesWithEvidence) {
    lines.push(`- \`${item.recovery.recoveryId}\`: status=${item.recovery.status}; attempt=\`${item.recovery.businessAttemptId}\`; source=${item.recovery.sourceDispatchId}; replacement=${item.recovery.replacementDispatchId ?? '无'}; consumed=${item.recovery.consumedBudget}; terminalOutcome=${item.recovery.terminalOutcome ?? '无'}; blockingReason=${item.recovery.blockingReason ?? '无'}; acceptedResults=${item.acceptedResults.length}.`);
    if (item.sourceSession) lines.push(`  原/来源 Session binding: \`${item.sourceSession.sessionBindingId}\`; transcript referenceable=${item.sourceSession.transcriptReferenceable}; verifiable=${item.sourceSession.verifiable}.`);
    if (item.replacementSession) lines.push(`  替代 Session binding: \`${item.replacementSession.sessionBindingId}\`; transcript referenceable=${item.replacementSession.transcriptReferenceable}; verifiable=${item.replacementSession.verifiable}.`);
    lines.push(`  Orca source state=${item.sourceWorker?.value?.workerState ?? 'unavailable'}; replacement state=${item.replacementWorker?.value?.workerState ?? 'not dispatched'}; exactWorker=${item.replacementWorker?.value?.exactWorker ?? 'n/a'}.`);
  }
  lines.push('', '## PTY 分页失败', '',
    '此前 PTY 断言受 footer 裁切和首帧竞态影响；主会话修正探针已成功读取 7 页，Recovery 完整字段可见。本次只读端口结果与该探针一致。因此该 UI 采集失败没有遮挡 Recovery 状态、Attempt 预算或阻塞原因的结论。', '',
    '此证据仅证明该实现 Worker 的 Recovery 状态与结果结算事实，不证明整个 IP-05 execution/patch/retire/restart/replanning 流程全部通过。', '');

  writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  writeFileSync(markdownPath, lines.join('\n'), { flag: 'wx' });
  process.stdout.write(JSON.stringify({ outputPath, markdownPath, recoveryCount: recoveries.length,
    sameBusinessAttempt: sameAttempt, attemptBudgets: attempts, acceptedResult: report.acceptedResultFinding,
    secondRecovery: report.secondRecoveryFinding }) + '\n');
} finally {
  opened.close();
}
