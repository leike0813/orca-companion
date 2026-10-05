/**
 * IC-07 / IP-A3：Worker 报告的边界校验入口（Owner: `m1-admit-work-package-specifications`）。
 *
 * 这是唯一允许原始 Worker 载荷进入领域层的地方。校验分两步，顺序不可交换：
 *
 * 1. 先按字段白名单取出报告内容，丢弃一切由模型填写的 scope、身份、Run、consumer generation 与
 *    operation identity 字段。这些字段不是「校验失败」，而是根本不存在于领域类型里，被丢弃的字段名
 *    会进入诊断，但字段值不进入日志。
 * 2. 再校验内容的结构、角色与版本，通过后连同 Controller 派生的归属一起交给调用方。
 *
 * 报告通过校验也只是候选结果：本模块不做 Accepted Worker Result 记录，也不推进任何生命周期。
 */

import type {
  CoordinationScopeId,
  DispatchId,
  WorkerTaskId,
} from './dto/identity.js';
import { WORKER_ROLES, type WorkerRole } from '../domain/planning/execution-authorization.js';
import {
  TASK_CONTRACT_SCHEMA_VERSION,
  TASK_ENVELOPE_SCHEMA_VERSION,
  type SpecBinding,
  type TaskEnvelope,
} from '../domain/task-contract.js';
import type { ClaimedResultAttribution } from '../domain/worker-result-verification.js';
import {
  ESCALATION_REASONS,
  EVIDENCE_RECORD_KINDS,
  evidenceIsBounded,
  type EscalationReason,
  type EvidenceRecord,
  type EvidenceRecordKind,
  type WorkerEscalation,
  type WorkerQuestion,
  type WorkerReport,
  type WorkerResult,
} from '../domain/worker-report.js';

/**
 * 模型与 Worker 都不允许填写的字段。
 *
 * 这张表是「丢弃而不是信任」的唯一事实源：出现任何一个都只是被忽略，且字段名进入诊断。
 */
export const WORKER_SUPPLIED_IDENTITY_FIELDS = [
  'coordinationScopeId',
  'coordinatorSessionId',
  'runtimeIncarnationId',
  'fencingGeneration',
  'scope',
  'authority',
  'runId',
  'consumerGeneration',
  'operationId',
  'operationCategory',
  'backendIdentityRef',
  'workerTaskId',
  'dispatchId',
  'attemptId',
  'role',
] as const;

export type WorkerSuppliedIdentityField = (typeof WORKER_SUPPLIED_IDENTITY_FIELDS)[number];

/** Controller 从可信 Execution Scope 派生的归属；这是唯一被接受的归属来源。 */
export type WorkerReportAttribution = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly role: WorkerRole;
  readonly workerTaskId: WorkerTaskId;
  readonly dispatchId: DispatchId;
  readonly attemptId: string;
  readonly resultSchemaVersion: number;
};

/** 校验后的候选报告：内容来自 Worker，归属来自 Controller。 */
export type CandidateWorkerReport = {
  readonly attribution: WorkerReportAttribution;
  readonly report: WorkerReport;
  /** 载荷里出现并被丢弃的身份字段名；值不保留。 */
  readonly droppedIdentityFields: readonly string[];
  /** `true` 表示这只是候选结果，尚未通过身份、版本、权限与证据校验。 */
  readonly candidateOnly: true;
};

export type WorkerReportParseFailure = {
  readonly kind: 'rejected';
  readonly code: string;
  readonly field: string;
  readonly message: string;
  readonly droppedIdentityFields: readonly string[];
};

export type WorkerReportParseResult =
  | { readonly kind: 'parsed'; readonly candidate: CandidateWorkerReport }
  | WorkerReportParseFailure;

export type TaskEnvelopeAttribution = {
  readonly workerTaskId: WorkerTaskId;
  readonly dispatchId: DispatchId;
  readonly attemptId: string;
  readonly role: WorkerRole;
};

export type TaskEnvelopeParseResult =
  | {
      readonly kind: 'parsed';
      readonly envelope: TaskEnvelope;
      readonly droppedIdentityFields: readonly string[];
    }
  | WorkerReportParseFailure;

function reject(
  code: string,
  field: string,
  message: string,
  droppedIdentityFields: readonly string[],
): WorkerReportParseFailure {
  return { kind: 'rejected', code, field, message, droppedIdentityFields };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function droppedIdentityFields(payload: Record<string, unknown>): readonly string[] {
  return WORKER_SUPPLIED_IDENTITY_FIELDS.filter((field) => Object.hasOwn(payload, field));
}

function droppedTaskEnvelopeIdentityFields(payload: Record<string, unknown>): readonly string[] {
  return WORKER_SUPPLIED_IDENTITY_FIELDS.filter(
    (field) => field !== 'authority' && Object.hasOwn(payload, field),
  );
}

function readNonEmptyString(source: Record<string, unknown>, field: string): string | null {
  const value = source[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readStringArray(source: Record<string, unknown>, field: string): readonly string[] | null {
  const value = source[field];
  if (!Array.isArray(value)) {
    return null;
  }
  if (value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    return null;
  }
  return value as readonly string[];
}

function nonNegativeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validAuthority(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return [
    'planner',
    'implementation',
    'validator',
    'finalizer',
    'gitIntegration',
    'dependencyChanges',
  ].every((field) => typeof value[field] === 'boolean');
}

function validEvidenceRequirements(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        readNonEmptyString(entry, 'evidenceKind') !== null &&
        readStringArray(entry, 'coveredPaths') !== null,
    )
  );
}

function validWorkPackageBudget(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return [
    'implementationAttempts',
    'validatorRepairs',
    'graphRevisions',
    'specificationRevisions',
    'integrationReconciliations',
    'maxRecoveriesPerWorkerAttempt',
  ].every((field) => nonNegativeInteger(value[field]));
}

/**
 * 派发前的 Task Envelope 运行时边界。
 *
 * Task/Dispatch/Attempt/角色只取 Controller attribution；raw 中的同名字段会被丢弃。其余字段按
 * Task Envelope 的封闭结构校验，避免 TypeScript 类型在 JSON 边界消失后变成隐式信任。
 */
export function parseTaskEnvelope(
  raw: unknown,
  attribution: TaskEnvelopeAttribution,
): TaskEnvelopeParseResult {
  if (!isRecord(raw)) {
    return reject('invalid_payload', 'taskEnvelope', 'Task Envelope 必须是对象', []);
  }
  const dropped = droppedTaskEnvelopeIdentityFields(raw);
  const taskContract = raw['taskContract'];
  const specBinding = raw['specBinding'];
  const workspace = raw['workspace'];
  const authority = raw['authority'];
  const budget = raw['budget'];
  const expectedEvidence = raw['expectedEvidence'];
  if (raw['schemaVersion'] !== TASK_ENVELOPE_SCHEMA_VERSION) {
    return reject('unsupported_schema_version', 'schemaVersion', 'Task Envelope 结构版本不受支持', dropped);
  }
  if (
    !isRecord(taskContract) ||
    taskContract['schemaVersion'] !== TASK_CONTRACT_SCHEMA_VERSION ||
    readNonEmptyString(taskContract, 'workPackageId') === null ||
    !nonNegativeInteger(taskContract['graphGeneration']) ||
    !Array.isArray(taskContract['dependencies']) ||
    taskContract['dependencies'].some((id) => typeof id !== 'string' || id.length === 0) ||
    !isRecord(taskContract['scopeEnvelope']) ||
    readStringArray(taskContract['scopeEnvelope'], 'include') === null ||
    readStringArray(taskContract['scopeEnvelope'], 'exclude') === null ||
    readNonEmptyString(taskContract, 'baselineHead') === null ||
    !validAuthority(taskContract['authority']) ||
    !validWorkPackageBudget(taskContract['budget']) ||
    !validEvidenceRequirements(taskContract['acceptanceEvidence']) ||
    !nonNegativeInteger(taskContract['resultSchemaVersion'])
  ) {
    return reject('invalid_payload', 'taskContract', 'Task Contract 结构无效', dropped);
  }
  if (specBinding === null) {
    if (attribution.role !== 'planner' || readNonEmptyString(raw, 'specificationUnitPath') === null) {
      return reject('invalid_payload', 'specificationUnitPath', 'Planner 必须声明规格目标路径', dropped);
    }
  } else if (
    !isRecord(specBinding) ||
    ['provider', 'relativePath', 'contentDigest', 'providerVersion'].some(
      (field) => readNonEmptyString(specBinding, field) === null,
    ) ||
    !nonNegativeInteger(specBinding['contractRevision']) ||
    !nonNegativeInteger(specBinding['trackingRevision'])
  ) {
    return reject('invalid_payload', 'specBinding', 'Spec Binding 结构无效', dropped);
  }
  if (
    !isRecord(workspace) ||
    ['worktreeId', 'canonicalWorktree', 'relativePath'].some(
      (field) => readNonEmptyString(workspace, field) === null,
    ) ||
    !validAuthority(authority) ||
    !isRecord(budget) ||
    !['implementationAttempts', 'validatorRepairs', 'recoveries'].every((field) =>
      nonNegativeInteger(budget[field]),
    ) ||
    !validEvidenceRequirements(expectedEvidence) ||
    (raw['instructions'] !== undefined && readStringArray(raw, 'instructions') === null)
  ) {
    return reject('invalid_payload', 'taskEnvelope', 'Task Envelope 字段结构无效', dropped);
  }
  if ((authority as TaskEnvelope['authority'])[attribution.role] !== true) {
    return reject('role_not_authorized', 'authority', `未授权 ${attribution.role} 角色`, dropped);
  }
  return {
    kind: 'parsed',
    envelope: {
      schemaVersion: TASK_ENVELOPE_SCHEMA_VERSION,
      workerTaskId: attribution.workerTaskId,
      dispatchId: attribution.dispatchId,
      attemptId: attribution.attemptId,
      role: attribution.role,
      taskContract: taskContract as TaskEnvelope['taskContract'],
      specBinding: specBinding as TaskEnvelope['specBinding'],
      ...(readNonEmptyString(raw, 'specificationUnitPath') === null
        ? {}
        : { specificationUnitPath: readNonEmptyString(raw, 'specificationUnitPath')! }),
      // 指令是宿主写出的正文：这里原样带回（缺省为空），不参与任何身份判定。
      instructions: readStringArray(raw, 'instructions') ?? [],
      workspace: workspace as TaskEnvelope['workspace'],
      authority: authority as TaskEnvelope['authority'],
      budget: budget as TaskEnvelope['budget'],
      expectedEvidence: expectedEvidence as TaskEnvelope['expectedEvidence'],
    },
    droppedIdentityFields: dropped,
  };
}

type OperationLike<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

function readEvidence(source: Record<string, unknown>): OperationLike<readonly EvidenceRecord[]> {
  const raw = source['evidence'];
  if (!Array.isArray(raw)) {
    return { ok: false, message: 'evidence 必须是数组' };
  }
  const records: EvidenceRecord[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry)) {
      return { ok: false, message: `evidence[${index}] 不是对象` };
    }
    const evidenceId = readNonEmptyString(entry, 'evidenceId');
    const kind = readNonEmptyString(entry, 'kind');
    const coveredPaths = readStringArray(entry, 'coveredPaths');
    const summary = readNonEmptyString(entry, 'summary');
    const outcome = entry['outcome'];
    if (evidenceId === null || kind === null || coveredPaths === null || summary === null) {
      return { ok: false, message: `evidence[${index}] 缺少 evidenceId、kind、coveredPaths 或 summary` };
    }
    if (!(EVIDENCE_RECORD_KINDS as readonly string[]).includes(kind)) {
      return { ok: false, message: `evidence[${index}].kind 取值不受支持: ${kind}` };
    }
    if (outcome !== 'passed' && outcome !== 'failed') {
      return { ok: false, message: `evidence[${index}].outcome 必须是 passed 或 failed` };
    }
    const command = entry['command'];
    if (command !== undefined && command !== null && typeof command !== 'string') {
      return { ok: false, message: `evidence[${index}].command 必须是字符串或 null` };
    }
    const record: EvidenceRecord = {
      evidenceId,
      kind: kind as EvidenceRecordKind,
      coveredPaths,
      command: typeof command === 'string' ? command : null,
      summary,
      outcome,
    };
    if (!evidenceIsBounded(record)) {
      return {
        ok: false,
        message: `evidence[${index}] 未限定在受影响的工作区范围内，或缺少可复核的命令与结果`,
      };
    }
    records.push(record);
  }
  return { ok: true, value: records };
}

/** 按报告种类与判别字段解析出领域报告；未知种类 fail closed。 */
function readReport(payload: Record<string, unknown>): OperationLike<WorkerReport> {
  const reportId = readNonEmptyString(payload, 'reportId');
  if (reportId === null) {
    return { ok: false, message: 'reportId 必须是非空字符串' };
  }
  const kind = payload['kind'];
  if (kind === 'result') {
    const summary = readNonEmptyString(payload, 'summary');
    if (summary === null) {
      return { ok: false, message: 'Worker Result 缺少 summary' };
    }
    const evidence = readEvidence(payload);
    if (!evidence.ok) {
      return evidence;
    }
    const result: WorkerResult = { reportId, summary, evidence: evidence.value };
    return { ok: true, value: result };
  }
  if (kind === 'question') {
    const question = readNonEmptyString(payload, 'question');
    const blocked = readStringArray(payload, 'blockedWorkPackageIds');
    if (question === null || blocked === null) {
      return { ok: false, message: 'Worker Question 缺少 question 或 blockedWorkPackageIds' };
    }
    const result: WorkerQuestion = { reportId, question, blockedWorkPackageIds: blocked };
    return { ok: true, value: result };
  }
  if (kind === 'escalation') {
    const reason = readNonEmptyString(payload, 'reason');
    const request = readNonEmptyString(payload, 'request');
    if (reason === null || request === null) {
      return { ok: false, message: 'Worker Escalation 缺少 reason 或 request' };
    }
    if (!(ESCALATION_REASONS as readonly string[]).includes(reason)) {
      return { ok: false, message: `Worker Escalation 的 reason 取值不受支持: ${reason}` };
    }
    const result: WorkerEscalation = { reportId, reason: reason as EscalationReason, request };
    return { ok: true, value: result };
  }
  return { ok: false, message: `未登记的 Worker 报告 kind: ${String(kind)}` };
}

/**
 * 校验一份原始 Worker 报告载荷。
 *
 * `attribution` 必须由 Controller 从可信 Execution Scope 派生；本函数不会从载荷里读取任何归属字段，
 * 载荷里出现的身份字段只会被丢弃并记入诊断。
 */
export function parseWorkerReport(
  rawPayload: unknown,
  attribution: WorkerReportAttribution,
): WorkerReportParseResult {
  if (!isRecord(rawPayload)) {
    return reject('invalid_payload', 'payload', 'Worker 报告载荷必须是对象', []);
  }
  const dropped = droppedIdentityFields(rawPayload);
  if (attribution.resultSchemaVersion !== 1) {
    return reject(
      'unsupported_schema_version',
      'resultSchemaVersion',
      `Worker 报告结构版本 ${attribution.resultSchemaVersion} 不受支持`,
      dropped,
    );
  }
  const report = readReport(rawPayload);
  if (!report.ok) {
    return reject('invalid_payload', 'payload', report.message, dropped);
  }
  return {
    kind: 'parsed',
    candidate: {
      attribution,
      report: report.value,
      droppedIdentityFields: dropped,
      candidateOnly: true,
    },
  };
}

/**
 * 真实 Orca Worker 报告的归属 locator。
 *
 * 真实 Codex Worker 投递的 `worker_done` 载荷是 Orca 自己的规范形状——它给出 Orca Task 身份、Orca
 * Dispatch 身份、结果状态与改动文件列表，**不**回显 Companion 的 Task Envelope 身份，也不带 Companion
 * 的 `result` 正文。因此这类消息只能用于**定位**已被 Controller 记录的那次派发：归属由
 * `materialization_bindings.orcaTaskId` 与 Session Segment 解析，而不是让 Worker 复述 Companion 身份。
 *
 * 这是 locator 的唯一实现（Delivery 归属装配、集成复验、基线补救与 Delivery ack 批次守卫共用），
 * 放在应用层以便边界判定与 bootstrap 装配复用同一份解析。
 */
export type OrcaWorkerDoneLocator = {
  readonly orcaTaskId: string;
  readonly orcaDispatchId: string;
  readonly outcome: string;
  readonly files: readonly string[];
  /** 结果正文的来源：Orca 消息的 `body`（Worker 的叙述）；缺失时为空串。 */
  readonly summary: string;
};

function payloadString(source: Record<string, unknown>, field: string): string | null {
  const value = source[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function parseOrcaWorkerDoneLocator(
  raw: string | null,
  body: string | null,
): OrcaWorkerDoneLocator | null {
  if (raw === null) {
    return null;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    return null;
  }
  const record = decoded as Record<string, unknown>;
  // Orca 保留被拒绝的 lifecycle 回报作诊断；它不是已接受的 Worker 结果载体。
  if ('_orcaLifecycleRejection' in record) {
    return null;
  }
  if ('result' in record) {
    // Companion 形状：交给 `parseDeliveryClaimedPayload`，这里不接管。
    return null;
  }
  const orcaTaskId = payloadString(record, 'taskId');
  const orcaDispatchId = payloadString(record, 'dispatchId');
  const outcome = payloadString(record, 'outcome');
  if (orcaTaskId === null || orcaDispatchId === null || outcome === null) {
    return null;
  }
  const rawFiles = record['filesModified'];
  const files = Array.isArray(rawFiles)
    ? rawFiles.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
  return { orcaTaskId, orcaDispatchId, outcome, files, summary: body ?? '' };
}

/**
 * Delivery message 载荷里**声称的**归属与结果正文（Companion 形状）。
 *
 * Orca 的 delivery message 只给出 payload 原文；任务/派发/尝试归属由生命周期消息的 payload JSON 承载，
 * 因此这里把 payload 解析成 ClaimedResultAttribution（缺字段即 null，与领域类型的合同一致）与归一化后
 * 的结果正文。它只是「声称」：归属是否成立只能由 verifyWorkerResult(claimed, trusted) 判定，其中 trusted
 * 全部来自 store、当前图、授权与 Git。
 */
export type DeliveryClaimedPayload = {
  readonly claimed: ClaimedResultAttribution;
  readonly acceptedResult: unknown;
};

export type DeliveryPayloadParse =
  | { readonly kind: 'parsed'; readonly payload: DeliveryClaimedPayload }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string };

function payloadCount(source: Record<string, unknown>, field: string): number | null {
  const value = source[field];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function payloadRole(source: Record<string, unknown>): WorkerRole | null {
  const value = source['role'];
  return typeof value === 'string' && (WORKER_ROLES as readonly string[]).includes(value)
    ? (value as WorkerRole)
    : null;
}

function payloadSpecBinding(source: Record<string, unknown>): SpecBinding | null {
  const raw = source['specBinding'];
  if (!isRecord(raw)) {
    return null;
  }
  const provider = readNonEmptyString(raw, 'provider');
  const relativePath = readNonEmptyString(raw, 'relativePath');
  const contentDigest = readNonEmptyString(raw, 'contentDigest');
  const providerVersion = readNonEmptyString(raw, 'providerVersion');
  const contractRevision = payloadCount(raw, 'contractRevision');
  const trackingRevision = payloadCount(raw, 'trackingRevision');
  if (
    provider === null ||
    relativePath === null ||
    contentDigest === null ||
    providerVersion === null ||
    contractRevision === null ||
    trackingRevision === null
  ) {
    return null;
  }
  return { provider, relativePath, contentDigest, providerVersion, contractRevision, trackingRevision };
}

/**
 * 解析 Companion 形状的 `worker_done` 载荷：带 `result` 正文与自报身份。
 *
 * 归属字段只用于**定位**，不构成信任；返回的 claimed 由 TrustedExecutionFacts 判定。Orca 规范形状
 * （无 `result`、只有 taskId/dispatchId）由 parseOrcaWorkerDoneLocator 处理，两者互不接管。
 */
export function parseDeliveryClaimedPayload(raw: string | null): DeliveryPayloadParse {
  if (raw === null) {
    return { kind: 'rejected', code: 'payload_missing', message: 'Delivery message 没有 payload：无法判定归属与结果正文' };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    return { kind: 'rejected', code: 'payload_not_json', message: 'Delivery message 的 payload 不是合法 JSON' };
  }
  if (!isRecord(decoded)) {
    return { kind: 'rejected', code: 'payload_not_object', message: 'Delivery message 的 payload 不是 JSON 对象' };
  }
  if (!('result' in decoded)) {
    return { kind: 'rejected', code: 'result_missing', message: 'Delivery message 的 payload 没有结果正文' };
  }
  const workerTaskId = readNonEmptyString(decoded, 'workerTaskId');
  const dispatchId = readNonEmptyString(decoded, 'dispatchId');
  return {
    kind: 'parsed',
    payload: {
      claimed: {
        runId: readNonEmptyString(decoded, 'runId'),
        consumerGeneration: payloadCount(decoded, 'consumerGeneration'),
        graphGeneration: payloadCount(decoded, 'graphGeneration'),
        authorizationId: readNonEmptyString(decoded, 'authorizationId'),
        workerTaskId: workerTaskId === null ? null : (workerTaskId as ClaimedResultAttribution['workerTaskId']),
        dispatchId: dispatchId === null ? null : (dispatchId as ClaimedResultAttribution['dispatchId']),
        attemptId: readNonEmptyString(decoded, 'attemptId'),
        role: payloadRole(decoded),
        specBinding: payloadSpecBinding(decoded),
        worktreeId: readNonEmptyString(decoded, 'worktreeId'),
      },
      acceptedResult: decoded['result'],
    },
  };
}
