/**
 * Worker 报告边界校验测试
 * （change: `m1-admit-work-package-specifications`，Owner: IP-A3）。
 *
 * 覆盖 Requirement「Task Envelope 固定 scope、authority、预算与期望证据」的 Worker 侧 Scenario
 * 与「Worker 以结构化报告与有界证据回报，且报告只算候选结果」的全部 Scenario：
 * - 模型填写的 scope、身份、Run、consumer generation、operation identity 一律被丢弃；
 * - 四类报告载荷被归一为候选结果，不产生生命周期推进；
 * - Worker Question 只列出依赖该回答的工作；
 * - 证据范围与失效、证据有界性。
 */

import { expect, test } from 'vitest';

import type {
  CoordinationScopeId,
  DispatchId,
  WorkerTaskId,
} from '../../src/application/dto/identity.js';
import {
  WORKER_SUPPLIED_IDENTITY_FIELDS,
  parseTaskEnvelope,
  parseWorkerReport,
  type WorkerReportAttribution,
} from '../../src/application/worker-report-dto.js';
import {
  evidenceIsBounded,
  invalidateEvidence,
  isWorkerEscalation,
  isWorkerQuestion,
  isWorkerResult,
  missingExpectedEvidence,
  pathTouchesCoverage,
  type EvidenceRecord,
} from '../../src/domain/worker-report.js';
import {
  TASK_ENVELOPE_SCHEMA_VERSION,
  roleIsAuthorized,
  type TaskEnvelope,
} from '../../src/domain/task-contract.js';
import { DEFAULT_EXECUTION_LIMITS, budgetFromLimits } from '../../src/domain/planning/budget-policy.js';
import type { RoleAuthorities } from '../../src/domain/planning/execution-authorization.js';

const attribution: WorkerReportAttribution = {
  coordinationScopeId: 'scope-1' as CoordinationScopeId,
  role: 'implementation',
  workerTaskId: 'task-1' as WorkerTaskId,
  dispatchId: 'dispatch-1' as DispatchId,
  attemptId: 'attempt-1',
  resultSchemaVersion: 1,
};

function evidence(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    evidenceId: 'ev-1',
    kind: 'command',
    coveredPaths: ['src/domain'],
    command: 'pnpm vitest run tests/domain',
    summary: '领域测试通过',
    outcome: 'passed',
    ...overrides,
  };
}

function resultPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: 'result', reportId: 'r-1', summary: '实现完成', evidence: [evidence()], ...overrides };
}

const AUTHORITIES: RoleAuthorities = {
  planner: true,
  implementation: true,
  validator: true,
  finalizer: true,
  gitIntegration: false,
  dependencyChanges: false,
};

/** 由 Controller 从可信输入组装的 Task Envelope；字段全部由 Controller 填定。 */
function controllerEnvelope(): TaskEnvelope {
  const parsed = parseTaskEnvelope({
    schemaVersion: TASK_ENVELOPE_SCHEMA_VERSION,
    workerTaskId: 'forged-task',
    dispatchId: 'forged-dispatch',
    attemptId: 'forged-attempt',
    role: 'finalizer',
    taskContract: {
      schemaVersion: 1,
      workPackageId: 'wp-1' as never,
      graphGeneration: 1,
      dependencies: [],
      scopeEnvelope: { include: ['src/domain'], exclude: [] },
      baselineHead: 'abcdef0123456789abcdef0123456789abcdef01',
      authority: AUTHORITIES,
      budget: budgetFromLimits(DEFAULT_EXECUTION_LIMITS),
      acceptanceEvidence: [{ evidenceKind: 'command', coveredPaths: ['src/domain'] }],
      resultSchemaVersion: 1,
    },
    specBinding: {
      provider: 'openspec',
      relativePath: 'openspec/changes/x',
      contentDigest: 'digest-1',
      providerVersion: '1',
      contractRevision: 1,
      trackingRevision: 1,
    },
    workspace: {
      worktreeId: 'repo-1::/tmp/worktrees/wp-1',
      canonicalWorktree: '/work/repo',
      relativePath: '.',
    },
    authority: AUTHORITIES,
    budget: { implementationAttempts: 2, validatorRepairs: 2, recoveries: 1 },
    expectedEvidence: [{ evidenceKind: 'command', coveredPaths: ['src/domain'] }],
  }, {
    workerTaskId: attribution.workerTaskId,
    dispatchId: attribution.dispatchId,
    attemptId: attribution.attemptId,
    role: attribution.role,
  });
  if (parsed.kind !== 'parsed') {
    throw new Error(parsed.message);
  }
  return parsed.envelope;
}

test('Task Envelope 运行时边界使用 Controller 归属并拒绝不完整结构', () => {
  const envelope = controllerEnvelope();
  expect(envelope.workerTaskId).toBe(attribution.workerTaskId);
  expect(envelope.dispatchId).toBe(attribution.dispatchId);
  expect(envelope.role).toBe(attribution.role);

  const invalid = parseTaskEnvelope(
    { schemaVersion: TASK_ENVELOPE_SCHEMA_VERSION, taskContract: {} },
    {
      workerTaskId: attribution.workerTaskId,
      dispatchId: attribution.dispatchId,
      attemptId: attribution.attemptId,
      role: attribution.role,
    },
  );
  expect(invalid.kind).toBe('rejected');
});

test('派发携带的 Task Envelope 字段全部由 Controller 填定，且不含 Worker 可填的身份位', () => {
  const envelope = controllerEnvelope();

  // 角色、worktree、authority、预算与期望证据都已固定。
  expect(envelope.role).toBe('implementation');
  expect(envelope.workspace.worktreeId).toBe('repo-1::/tmp/worktrees/wp-1');
  expect(roleIsAuthorized(envelope.authority, 'implementation')).toBe(true);
  // Git 集成与依赖变更不属于角色执行权限，只作为 Manifest 的独立字段出现。
  expect(roleIsAuthorized(envelope.authority, 'planner')).toBe(true);
  expect(envelope.budget.implementationAttempts).toBe(2);
  expect(envelope.expectedEvidence).toHaveLength(1);
  // Task Envelope 里没有 scope、Run、consumer generation 或 operation identity 字段。
  for (const forbidden of ['scope', 'runId', 'consumerGeneration', 'operationId', 'coordinationScopeId']) {
    expect(Object.hasOwn(envelope, forbidden)).toBe(false);
  }
});

test('模型填写的 scope、身份、Run、consumer generation 与 operation identity 被丢弃', () => {
  const payload = {
    ...resultPayload(),
    // 以下全部由模型/Worker 提供，必须被忽略。
    coordinationScopeId: 'forged-scope',
    coordinatorSessionId: 'forged-session',
    runtimeIncarnationId: 'forged-incarnation',
    fencingGeneration: 99,
    scope: { operationId: 'forged-op' },
    authority: { kind: 'execution_coordination', runId: 'forged-run' },
    runId: 'forged-run',
    consumerGeneration: 7,
    operationId: 'forged-op',
    operationCategory: 'forged-category',
    backendIdentityRef: 'forged-identity',
    workerTaskId: 'forged-task',
    dispatchId: 'forged-dispatch',
    attemptId: 'forged-attempt',
    role: 'finalizer',
  };

  const parsed = parseWorkerReport(payload, attribution);
  expect(parsed.kind).toBe('parsed');
  if (parsed.kind !== 'parsed') {
    return;
  }
  // 归属只来自 Controller 派生的可信值。
  expect(parsed.candidate.attribution).toEqual(attribution);
  expect(parsed.candidate.attribution.role).toBe('implementation');
  expect(parsed.candidate.attribution.workerTaskId).toBe('task-1');
  // 被丢弃的字段名进入诊断，字段值不保留。
  expect(parsed.candidate.droppedIdentityFields).toContain('runId');
  expect(parsed.candidate.droppedIdentityFields).toContain('operationId');
  expect(parsed.candidate.droppedIdentityFields).toContain('role');
  expect(JSON.stringify(parsed.candidate)).not.toContain('forged-run');
  expect(JSON.stringify(parsed.candidate)).not.toContain('forged-task');
});

test('每个受保护字段都被识别为模型可填并会被丢弃', () => {
  for (const field of WORKER_SUPPLIED_IDENTITY_FIELDS) {
    const payload = { ...resultPayload(), [field]: 'forged' };
    const parsed = parseWorkerReport(payload, attribution);
    expect(parsed.kind).toBe('parsed');
    if (parsed.kind === 'parsed') {
      expect(parsed.candidate.droppedIdentityFields).toContain(field);
    }
  }
});

test('四类报告载荷归一为候选结果，不产生生命周期推进', () => {
  const parsedResult = parseWorkerReport(resultPayload(), attribution);
  const parsedQuestion = parseWorkerReport(
    { kind: 'question', reportId: 'r-2', question: '依赖版本选哪个？', blockedWorkPackageIds: ['wp-2'] },
    attribution,
  );
  const parsedEscalation = parseWorkerReport(
    { kind: 'escalation', reportId: 'r-3', reason: 'authority', request: '需要 Git 集成权限' },
    attribution,
  );

  expect(parsedResult.kind).toBe('parsed');
  expect(parsedQuestion.kind).toBe('parsed');
  expect(parsedEscalation.kind).toBe('parsed');
  if (parsedResult.kind === 'parsed') {
    expect(isWorkerResult(parsedResult.candidate.report)).toBe(true);
    // 报告只是候选：这里没有 Accepted Worker Result，也没有生命周期状态。
    expect(parsedResult.candidate.candidateOnly).toBe(true);
    expect(Object.keys(parsedResult.candidate)).not.toContain('acceptedWorkerResult');
    expect(Object.keys(parsedResult.candidate)).not.toContain('lifecycleState');
  }
  if (parsedQuestion.kind === 'parsed') {
    expect(isWorkerQuestion(parsedQuestion.candidate.report)).toBe(true);
  }
  if (parsedEscalation.kind === 'parsed') {
    expect(isWorkerEscalation(parsedEscalation.candidate.report)).toBe(true);
  }
});

test('Worker Question 只列出依赖该回答的工作，其余工作不在其中', () => {
  const parsed = parseWorkerReport(
    { kind: 'question', reportId: 'r-2', question: '需要确认接口', blockedWorkPackageIds: ['wp-2'] },
    attribution,
  );

  expect(parsed.kind).toBe('parsed');
  if (parsed.kind !== 'parsed' || !isWorkerQuestion(parsed.candidate.report)) {
    return;
  }
  expect(parsed.candidate.report.blockedWorkPackageIds).toEqual(['wp-2']);
  expect(parsed.candidate.report.blockedWorkPackageIds).not.toContain('wp-3');
});

test('越界或未登记的载荷被拒绝并保留诊断', () => {
  const unknownKind = parseWorkerReport({ kind: 'unknown-kind', reportId: 'r-1' }, attribution);
  const missingSummary = parseWorkerReport({ kind: 'result', reportId: 'r-1' }, attribution);
  const badEvidenceKind = parseWorkerReport(
    resultPayload({ evidence: [{ ...evidence(), kind: 'transcript-dump' }] }),
    attribution,
  );
  const unboundedEvidence = parseWorkerReport(
    resultPayload({ evidence: [{ ...evidence(), coveredPaths: ['.'] }] }),
    attribution,
  );
  const unsupportedVersion = parseWorkerReport(resultPayload(), { ...attribution, resultSchemaVersion: 2 });
  const notAnObject = parseWorkerReport('not-a-report', attribution);

  expect(unknownKind.kind).toBe('rejected');
  expect(missingSummary.kind).toBe('rejected');
  expect(badEvidenceKind.kind).toBe('rejected');
  expect(unboundedEvidence.kind).toBe('rejected');
  expect(unsupportedVersion.kind).toBe('rejected');
  expect(notAnObject.kind).toBe('rejected');
  if (unsupportedVersion.kind === 'rejected') {
    expect(unsupportedVersion.code).toBe('unsupported_schema_version');
  }
  if (badEvidenceKind.kind === 'rejected') {
    expect(badEvidenceKind.message).toContain('kind');
  }
});

test('变更触及证据范围后证据失效，未被触及的证据保持可用', () => {
  const evidenceRecords: readonly EvidenceRecord[] = [
    evidence({ evidenceId: 'ev-domain', coveredPaths: ['src/domain'] }),
    evidence({ evidenceId: 'ev-app', coveredPaths: ['src/application/materialize-work-package.ts'] }),
    evidence({ evidenceId: 'ev-tests', coveredPaths: ['tests/domain'] }),
  ];

  const invalidated = invalidateEvidence(evidenceRecords, ['src/domain/dispatch-candidate.ts']);

  expect(invalidated).toHaveLength(1);
  expect(invalidated[0]?.evidenceId).toBe('ev-domain');
  expect(invalidated[0]?.invalidatedPaths).toEqual(['src/domain/dispatch-candidate.ts']);
});

test('证据覆盖范围只按路径边界判定，不做模糊匹配', () => {
  expect(pathTouchesCoverage('src/domain', 'src/domain/x.ts')).toBe(true);
  expect(pathTouchesCoverage('src/domain', 'src/domain')).toBe(true);
  expect(pathTouchesCoverage('src/domain', 'src/application/x.ts')).toBe(false);
  expect(pathTouchesCoverage('src/domain/x.ts', 'src/domain/xy.ts')).toBe(false);
  expect(pathTouchesCoverage('src/domain', 'src/domainX/x.ts')).toBe(false);
});

test('证据记录必须有界：范围非空且不含仓库根，命令与结论可复核', () => {
  expect(evidenceIsBounded(evidence())).toBe(true);
  expect(evidenceIsBounded(evidence({ coveredPaths: [] }))).toBe(false);
  expect(evidenceIsBounded(evidence({ coveredPaths: ['.'] }))).toBe(false);
  expect(evidenceIsBounded(evidence({ coveredPaths: ['/'] }))).toBe(false);
  expect(evidenceIsBounded(evidence({ command: null }))).toBe(false);
  expect(evidenceIsBounded(evidence({ summary: '' }))).toBe(false);
});

test('缺失的期望证据被逐条列出', () => {
  const missing = missingExpectedEvidence(
    [
      { evidenceKind: 'command', coveredPaths: ['src/domain'] },
      { evidenceKind: 'review', coveredPaths: ['src/domain'] },
    ],
    [evidence()],
  );

  expect(missing).toEqual(['review']);
});
