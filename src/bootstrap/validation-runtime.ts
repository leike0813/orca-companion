/**
 * IC-08 / IP-04：Validator 步骤通道的生产装配（Owner: `m2-wire-execution-runtime`）。
 *
 * `runValidation` 拥有「验证 → 范围内修复 → 复验」的顺序与准入，但每一步都必须落在**原 Task / 原
 * Dispatch / 原 Validation Attempt 的同一条真实 harness session** 上。这里提供那条通道：Validator
 * Worker 在同一条 session 内完成一步后，用 `orca orchestration ask` 提交一个有界的 typed JSON 报告
 * 并阻塞，等待宿主通过 `orchestration reply` 下发的下一步许可。
 *
 * 通道是宿主驱动的，不是 `runValidation` 自己轮询的：前台 pump 读取 Delivery 后调用
 * `observe(message)`，把识别出的 typed step 先**耐久保存**（消费证明），再 `advance` 推进等待中的
 * `runStep`。这样 `runValidation` 不会被 pump 阻塞，批量确认也有精确到步骤消息的消费依据。
 *
 * 通道不做判定：角色分离、修复预算、Scope Envelope、证据覆盖仍全部由 `run-validation.ts` 决定；
 * 这里只负责「步骤消息 → typed 结果」与「下一步许可 → reply」的编码与顺序，绝不创建新 session、
 * 新 Task 或用 terminal 输出冒充 transcript。
 */

import type { DeliveryMessage } from '../application/dto/operation-outcome.js';
import type { DispatchId, WorkPackageId, WorkerTaskId } from '../application/dto/identity.js';
import {
  validationRepairStepId,
  type RepairIntent,
  type RunValidationResult,
  type ValidatorStepRequest,
  type ValidatorStepResult,
} from '../application/run-validation.js';
import type { ValidatorHarnessSession } from '../adapters/agents/validator-runner.js';
import type { ScopeEnvelope } from '../domain/planning/execution-graph.js';
import type { SessionBinding } from '../domain/task-contract.js';
import {
  EVIDENCE_RECORD_KINDS,
  ESCALATION_REASONS,
  type EscalationReason,
  type EvidenceRecord,
  type EvidenceRecordKind,
} from '../domain/worker-report.js';

/** Worker 与宿主之间的步骤协议版本；读到未知版本 fail closed。 */
export const VALIDATOR_STEP_SCHEMA_VERSION = 1;

/** 本次派发的可信身份：只接受与之一致的步骤消息，异 Dispatch/Attempt 一律忽略。 */
export type ValidatorStepRouting = {
  readonly workPackageId: WorkPackageId;
  readonly workerTaskId: WorkerTaskId;
  readonly dispatchId: DispatchId;
  /** Envelope 中预先签发的 Dispatch 身份；Orca transport 另由 Session Segment 精确绑定。 */
  readonly taskEnvelopeDispatchId?: DispatchId;
  /** Validation Attempt 身份（与 `SessionBinding.attemptId` 同源）。 */
  readonly validationAttemptId: string;
  readonly sessionBinding: SessionBinding;
  /** 
   * 可选的 Orca Run：只在给了 Run 时按 Run 过滤 inbox 页；缺省表示不按 Run 过滤。
   */
  readonly runId?: string;
};

/** 一条已识别的步骤消息：既是推进 `runStep` 的结果，也是宿主做消费证明/ack 的事实。 */
export type ValidatorStepRecord =
  | {
      readonly kind: 'verified';
      readonly outcome: 'passed' | 'failed';
      readonly summary: string;
      readonly evidence: readonly EvidenceRecord[];
      readonly repairIntent: RepairIntent | null;
    }
  | {
      readonly kind: 'repair_applied';
      readonly changedPaths: readonly string[];
      readonly note: string;
    }
  | { readonly kind: 'escalation'; readonly reason: EscalationReason; readonly request: string };

export type ValidatorStepObservation = {
  /** 原 question message id：reply 必须用它，ack 消费证明也指向它。 */
  readonly messageId: string;
  /** 稳定步骤身份，供宿主登记消费证明。 */
  readonly stepId: string;
  /** 步骤关键字段的确定性摘要；重放同一条消息得到同一个值。 */
  readonly payloadDigest: string;
  readonly record: ValidatorStepRecord;
};

/** 解析失败/不归本 Attempt 时的忽略原因；不是错误，只是不由本通道消费。 */
export type ValidatorStepIgnore = { readonly kind: 'ignored'; readonly reason: string };

/** 步骤消息的稳定身份（用于消费证明与重放匹配）。 */
export function validatorStepIdOf(messageId: string): string {
  return `validator-step:${encodeURIComponent(messageId)}`;
}

/** 答复某条 question 的稳定 mutation 身份；同一问题同一动作重放派生同一个值。 */
export function validatorReplyOperationIdFor(questionMessageId: string, action: ValidatorStepAction): string {
  return `validator-reply:${encodeURIComponent(questionMessageId)}:${action}`;
}

export type ValidatorStepAction = 'repair' | 'verify' | 'finish' | 'refuse';

/** reply 的正文形状；Worker 必须解析它才知道下一步动作。 */
export type ValidatorStepReplyBody = {
  readonly schemaVersion: number;
  readonly kind: 'validator_step_reply';
  readonly action: ValidatorStepAction;
  readonly stepId: string;
  readonly repairIntent: RepairIntent | null;
  readonly reason: string | null;
};

export function encodeValidatorStepReply(input: {
  readonly action: ValidatorStepAction;
  readonly stepId: string;
  readonly repairIntent?: RepairIntent | null;
  readonly reason?: string | null;
}): string {
  const body: ValidatorStepReplyBody = {
    schemaVersion: VALIDATOR_STEP_SCHEMA_VERSION,
    kind: 'validator_step_reply',
    action: input.action,
    stepId: input.stepId,
    repairIntent: input.repairIntent ?? null,
    reason: input.reason ?? null,
  };
  return JSON.stringify(body);
}

type ReadFailure = { readonly kind: 'ignored'; readonly reason: string };

function ignored(reason: string): ReadFailure {
  return { kind: 'ignored', reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonEmptyString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseRepairIntent(raw: unknown): RepairIntent | null | undefined {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (!isRecord(raw)) {
    return undefined;
  }
  const changedPaths = raw['changedPaths'];
  const requiresDesignChange = raw['requiresDesignChange'];
  const requiresDependencyChange = raw['requiresDependencyChange'];
  if (!Array.isArray(changedPaths) || changedPaths.some((path) => typeof path !== 'string' || path.length === 0)) {
    return undefined;
  }
  if (typeof requiresDesignChange !== 'boolean' || typeof requiresDependencyChange !== 'boolean') {
    return undefined;
  }
  return {
    changedPaths: changedPaths as readonly string[],
    requiresDesignChange,
    requiresDependencyChange,
  };
}

const MAX_EVIDENCE_RECORDS = 64;
const MAX_COVERED_PATHS = 512;

function parseEvidence(raw: unknown, messageId: string): readonly EvidenceRecord[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_EVIDENCE_RECORDS) {
    return undefined;
  }
  const records: EvidenceRecord[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry)) {
      return undefined;
    }
    const kind = entry['kind'];
    if (typeof kind !== 'string' || !(EVIDENCE_RECORD_KINDS as readonly string[]).includes(kind)) {
      return undefined;
    }
    const coveredPaths = entry['coveredPaths'];
    if (
      !Array.isArray(coveredPaths) ||
      coveredPaths.length === 0 ||
      coveredPaths.length > MAX_COVERED_PATHS ||
      coveredPaths.some((path) => typeof path !== 'string' || path.length === 0)
    ) {
      return undefined;
    }
    // `evidenceIsBounded` 要求可复核命令非空：这里同样不接受缺少命令的记录。
    const command = readNonEmptyString(entry, 'command');
    const summary = readNonEmptyString(entry, 'summary');
    const outcome = entry['outcome'];
    if (command === null || summary === null || (outcome !== 'passed' && outcome !== 'failed')) {
      return undefined;
    }
    records.push({
      // 证据身份由消息身份确定性派生，重放同一条消息得到同一组 id。
      evidenceId: `${messageId}:evidence:${index}`,
      kind: kind as EvidenceRecordKind,
      coveredPaths: coveredPaths as readonly string[],
      command,
      summary,
      outcome,
    });
  }
  return records;
}

function digestOf(record: ValidatorStepRecord, messageId: string): string {
  // 有界摘要：只覆盖判定用到的字段，不含时间戳或传输噪声，因此重放稳定。
  return `${messageId}:${JSON.stringify(record)}`;
}

/**
 * 把一条 Delivery 消息解析成 typed 步骤。
 *
 * 只接受 `question` 类型、schema/identity 与本次派发精确一致的消息；其它消息返回 `ignored`，
 * 由调用方按普通消息处理（普通 question/escalation 走 Wake，不占用确定性步骤通道）。
 */
export function observeValidatorStepMessage(
  message: DeliveryMessage,
  routing: ValidatorStepRouting,
): ValidatorStepObservation | ValidatorStepIgnore {
  if (message.type !== 'question') {
    return ignored(`消息类型 ${message.type ?? 'null'} 不是 validator 步骤问题`);
  }
  const body = message.body ?? message.payload;
  if (body === null || body.length === 0 || body.length > 64 * 1024) {
    return ignored('步骤正文缺失或超出上限');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch {
    return ignored('步骤正文不是合法 JSON');
  }
  if (!isRecord(decoded)) {
    return ignored('步骤正文不是对象');
  }
  if (decoded['schemaVersion'] !== VALIDATOR_STEP_SCHEMA_VERSION || decoded['kind'] !== 'validator_step') {
    return ignored('步骤协议版本或 kind 不匹配');
  }
  if (
    decoded['workerTaskId'] !== routing.workerTaskId ||
    decoded['dispatchId'] !== (routing.taskEnvelopeDispatchId ?? routing.dispatchId) ||
    decoded['attemptId'] !== routing.validationAttemptId
  ) {
    return ignored('步骤消息不属于当前 Validation Attempt');
  }
  if (routing.runId !== undefined && message.runId !== null && message.runId !== routing.runId) {
    return ignored('步骤消息不属于当前 Run');
  }

  const step = decoded['step'];
  if (step === 'verify') {
    const outcome = decoded['outcome'];
    const summary = readNonEmptyString(decoded, 'summary');
    const evidence = parseEvidence(decoded['evidence'], message.messageId);
    const repairIntent = parseRepairIntent(decoded['repairIntent']);
    if ((outcome !== 'passed' && outcome !== 'failed') || summary === null || evidence === undefined) {
      return ignored('verify 步骤报告字段不完整');
    }
    if (repairIntent === undefined) {
      return ignored('verify 步骤的 repairIntent 形态不合法');
    }
    if (outcome === 'passed' && repairIntent !== null) {
      return ignored('通过的验证不得携带修复意图');
    }
    if (outcome === 'failed' && repairIntent === null) {
      // 失败但没有可判定的修复意图：不能当作普通验证结果继续，按需要升级处理。
      const record: ValidatorStepRecord = {
        kind: 'escalation',
        reason: 'scope',
        request: '验证失败但没有给出可判定的修复意图，当前 Work Package 需要重新规划',
      };
      return observation(message.messageId, record);
    }
    const record: ValidatorStepRecord = { kind: 'verified', outcome, summary, evidence, repairIntent };
    return observation(message.messageId, record);
  }
  if (step === 'repair_applied') {
    const changedPaths = decoded['changedPaths'];
    const note = readNonEmptyString(decoded, 'note');
    if (
      !Array.isArray(changedPaths) ||
      changedPaths.length === 0 ||
      changedPaths.length > MAX_COVERED_PATHS ||
      changedPaths.some((path) => typeof path !== 'string' || path.length === 0) ||
      note === null
    ) {
      return ignored('repair_applied 步骤报告字段不完整');
    }
    const record: ValidatorStepRecord = {
      kind: 'repair_applied',
      changedPaths: changedPaths as readonly string[],
      note,
    };
    return observation(message.messageId, record);
  }
  if (step === 'escalation') {
    const reason = decoded['reason'];
    const request = readNonEmptyString(decoded, 'request');
    if (typeof reason !== 'string' || !(ESCALATION_REASONS as readonly string[]).includes(reason) || request === null) {
      return ignored('escalation 步骤报告字段不完整');
    }
    const record: ValidatorStepRecord = { kind: 'escalation', reason: reason as EscalationReason, request };
    return observation(message.messageId, record);
  }
  return ignored(`未知的 validator 步骤 ${String(step)}`);
}

function observation(messageId: string, record: ValidatorStepRecord): ValidatorStepObservation {
  return { messageId, stepId: validatorStepIdOf(messageId), payloadDigest: digestOf(record, messageId), record };
}

/** 把已识别步骤映射成 `runValidation` 的步骤结论；身份由调用的 Attempt 固定。 */
export function stepResultOf(observation: ValidatorStepObservation, binding: SessionBinding): ValidatorStepResult {
  const record = observation.record;
  if (record.kind === 'escalation') {
    return { kind: 'escalation', reason: record.reason, request: record.request };
  }
  if (record.kind === 'repair_applied') {
    return { kind: 'repair_applied', changedPaths: record.changedPaths, sessionBinding: binding, note: record.note };
  }
  return {
    kind: 'verified',
    outcome: record.outcome,
    evidence: record.evidence,
    summary: record.summary,
    sessionBinding: binding,
    repairIntent: record.repairIntent,
  };
}

// ---------------------------------------------------------------------------
// 宿主驱动的步骤会话
// ---------------------------------------------------------------------------

export type ValidatorReplySendRequest = {
  readonly questionMessageId: string;
  /** 稳定 mutation 身份；宿主用它登记 Intent 并与 unknown 对账。 */
  readonly operationId: string;
  readonly action: ValidatorStepAction;
  readonly repairIntent: RepairIntent | null;
  readonly reason: string | null;
  /** 已编码的 reply 正文；宿主直接交给受控 reply 通道。 */
  readonly body: string;
};

export type ValidatorReplySendOutcome =
  | { readonly kind: 'sent' }
  /** 可证明未生效：答复被拒或 Orca 记录确定失败，问题仍 pending。 */
  | { readonly kind: 'rejected'; readonly reason: string }
  /** 结果不确定：必须按同一 operationId 对账，绝不能据此推进。 */
  | { readonly kind: 'unknown'; readonly reason: string };

export type ValidatorConcludeOutcome =
  | { readonly kind: 'sent' }
  | { readonly kind: 'nothing_pending' }
  | { readonly kind: 'unknown'; readonly reason: string }
  | { readonly kind: 'rejected'; readonly reason: string };

export type ValidatorPendingQuestion = {
  readonly messageId: string;
  readonly stepId: string;
  readonly payloadDigest: string;
  readonly record: ValidatorStepRecord;
};

export type ValidatorHarnessSessionController = {
  /** 供 `createValidatorStepRunner` 包装的真实步骤会话。 */
  readonly session: ValidatorHarnessSession;
  /**
   * 识别一条已投递消息。返回非 `null` 时宿主必须先耐久保存该 observation（消费证明），再
   * `advance`；返回 `null` 表示这条消息不由本通道消费。
   */
  readonly observe: (message: DeliveryMessage) => ValidatorStepObservation | null;
  /** 在宿主完成耐久保存后推进等待中的 `runStep`；无等待者时缓冲给下一次 `runStep`。 */
  readonly advance: (observation: ValidatorStepObservation) => void;
  /** `runValidation` 返回后答复最后一条未决 question（finish/refuse）。 */
  readonly conclude: (result: RunValidationResult) => Promise<ValidatorConcludeOutcome>;
  /** 当前已返回但尚未答复的 question；宿主用它核对 ack 消费证明。 */
  readonly pendingQuestion: () => ValidatorPendingQuestion | null;
};

export type ValidatorHarnessSessionInput = {
  readonly routing: ValidatorStepRouting;
  /** 受控 reply 通道（宿主注入；通常封装 `replyWorkerQuestion` 与 Intent 对账）。 */
  readonly sendReply: (request: ValidatorReplySendRequest) => Promise<ValidatorReplySendOutcome>;
  /** 中止信号：TUI 退出、失去 fencing 或 Scope 取消后不再等待下一步。 */
  readonly signal?: AbortSignal;
};

/**
 * 构造宿主驱动的 Validator 步骤会话。
 *
 * 顺序与准入仍由 `runValidation` 决定；这里只把「上一步已消费的 question」答复成下一步许可，并等待
 * 宿主 `advance` 进来的下一条 typed 报告。任何时刻都不创建新 session/Task，也不把 terminal 输出当
 * 作报告。
 */
export function createValidatorHarnessSession(
  input: ValidatorHarnessSessionInput,
): ValidatorHarnessSessionController {
  let consumed: ValidatorPendingQuestion | null = null;
  const buffered: ValidatorPendingQuestion[] = [];
  let waiter: ((question: ValidatorPendingQuestion | null) => void) | null = null;
  let aborted = input.signal?.aborted ?? false;
  input.signal?.addEventListener('abort', () => {
    aborted = true;
    if (waiter !== null) {
      const resolve = waiter;
      waiter = null;
      resolve(null);
    }
  });

  const waitForNext = (): Promise<ValidatorPendingQuestion | null> => {
    if (buffered.length > 0) {
      return Promise.resolve(buffered.shift()!);
    }
    if (aborted) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      waiter = resolve;
    });
  };

  const send = async (
    pending: ValidatorPendingQuestion,
    action: ValidatorStepAction,
    repairIntent: RepairIntent | null,
    reason: string | null,
  ): Promise<ValidatorReplySendOutcome> => {
    const operationId = validatorReplyOperationIdFor(pending.messageId, action);
    try {
      return await input.sendReply({
        questionMessageId: pending.messageId,
        operationId,
        action,
        repairIntent,
        reason,
        body: encodeValidatorStepReply({ action, stepId: pending.stepId, repairIntent, reason }),
      });
    } catch (error) {
      // 通道抛错只说明这次答复没有可证明地生效，不能据此继续等待下一步。
      return { kind: 'unknown', reason: error instanceof Error ? error.message : 'reply 通道抛出非 Error 值' };
    }
  };

  const runStep = async (request: ValidatorStepRequest): Promise<ValidatorStepResult> => {
    if (consumed !== null) {
      const previous = consumed;
      if (request.kind === 'repair') {
        if (previous.record.kind !== 'verified' || previous.record.outcome !== 'failed') {
          return { kind: 'step_failed', code: 'invalid_step_sequence', message: '修复只能接在一次失败的验证报告之后' };
        }
        if (request.repairIntent === null) {
          return { kind: 'step_failed', code: 'missing_repair_intent', message: '修复步骤缺少修复意图' };
        }
      } else if (previous.record.kind !== 'repair_applied') {
        return { kind: 'step_failed', code: 'invalid_step_sequence', message: '复验只能接在修复报告之后' };
      }
      const action: ValidatorStepAction = request.kind === 'repair' ? 'repair' : 'verify';
      const repairIntent = request.kind === 'repair' ? request.repairIntent : null;
      const sent = await send(previous, action, repairIntent, null);
      consumed = null;
      if (sent.kind !== 'sent') {
        return {
          kind: 'step_failed',
          code: sent.kind === 'unknown' ? 'reply_unknown' : 'reply_rejected',
          message: `${sent.kind === 'unknown' ? '下一步许可结果不确定' : '下一步许可被拒绝'}：${sent.reason}`,
        };
      }
    }

    const next = await waitForNext();
    if (next === null) {
      return { kind: 'session_lost', reason: 'Validator 步骤通道已中止，未收到下一步报告' };
    }
    if (next.record.kind === 'escalation') {
      consumed = next;
      return stepResultOf(next, input.routing.sessionBinding);
    }
    if (request.kind === 'verify' && next.record.kind !== 'verified') {
      consumed = next;
      return { kind: 'step_failed', code: 'invalid_step_sequence', message: '复验步骤收到的是修复报告' };
    }
    if (request.kind === 'repair' && next.record.kind !== 'repair_applied') {
      consumed = next;
      return { kind: 'step_failed', code: 'invalid_step_sequence', message: '修复步骤收到的是验证报告' };
    }
    consumed = next;
    return stepResultOf(next, input.routing.sessionBinding);
  };

  const observe = (message: DeliveryMessage): ValidatorStepObservation | null => {
    const parsed = observeValidatorStepMessage(message, input.routing);
    return 'record' in parsed ? parsed : null;
  };

  const advance = (observation: ValidatorStepObservation): void => {
    const pending: ValidatorPendingQuestion = {
      messageId: observation.messageId,
      stepId: observation.stepId,
      payloadDigest: observation.payloadDigest,
      record: observation.record,
    };
    if (waiter !== null) {
      const resolve = waiter;
      waiter = null;
      resolve(pending);
      return;
    }
    buffered.push(pending);
  };

  const conclude = async (result: RunValidationResult): Promise<ValidatorConcludeOutcome> => {
    if (consumed === null) {
      return { kind: 'nothing_pending' };
    }
    const pending = consumed;
    consumed = null;
    const action: ValidatorStepAction = result.kind === 'validated' ? 'finish' : 'refuse';
    const reason =
      result.kind === 'validated'
        ? null
        : result.kind === 'escalation_required'
          ? `需要升级：${result.reason}`
          : result.kind === 'blocked'
            ? `验证链阻塞：${result.code}`
            : `验证步骤失败：${result.code}`;
    const sent = await send(pending, action, null, reason);
    if (sent.kind === 'sent') {
      return { kind: 'sent' };
    }
    return sent.kind === 'unknown'
      ? { kind: 'unknown', reason: sent.reason }
      : { kind: 'rejected', reason: sent.reason };
  };

  return {
    session: { runStep },
    observe,
    advance,
    conclude,
    pendingQuestion: () =>
      consumed === null
        ? null
        : {
            messageId: consumed.messageId,
            stepId: consumed.stepId,
            payloadDigest: consumed.payloadDigest,
            record: consumed.record,
          },
  };
}

// ---------------------------------------------------------------------------
// 首次 Task Envelope 指令
// ---------------------------------------------------------------------------

/**
 * Validator 的首次派发指令。
 *
 * 正文必须把「怎么报告」讲到 Worker 无法猜错：每一步结束后调用 `orca orchestration ask`，正文是
 * 一个有界的 typed JSON，然后阻塞等待 reply；收到 reply 后严格按 action 执行。允许的改动范围、证据
 * 要求与修复预算都写进正文，不留给 Worker 推断。
 */
export function validatorVerificationInstructions(input: {
  readonly scopeEnvelope: ScopeEnvelope;
  readonly repairBudget: { readonly limit: number; readonly consumed: number };
  readonly workerTaskId: WorkerTaskId;
  readonly dispatchId: DispatchId;
  readonly attemptId: string;
}): readonly string[] {
  const remainingRepairs = Math.max(0, input.repairBudget.limit - input.repairBudget.consumed);
  const identity = JSON.stringify({
    workerTaskId: input.workerTaskId,
    dispatchId: input.dispatchId,
    attemptId: input.attemptId,
  });
  return [
    '你是独立 Validator，工作在实现者之外的同一真实会话中。不要相信实现者的总结，必须自己独立验证当前 worktree。',
    '每一步结束后，用 `orca orchestration ask --question <JSON> --json` 提交有界 JSON 报告并阻塞等待宿主 reply；不得用叙述文字代替 JSON，也不得跳过 ask 直接继续。',
    `报告 JSON 必须包含身份字段 ${identity}，且必须与本次派发一致，否则宿主不接收。`,
    '验证通过的报告（repairIntent 必须是 JSON null，不是字符串 "null"）：{"schemaVersion":1,"kind":"validator_step","step":"verify","outcome":"passed","summary":"...","evidence":[{"kind":"command","coveredPaths":["src/a.ts"],"command":"pnpm test","summary":"...","outcome":"passed"}],"repairIntent":null}。',
    '验证失败的报告必须给出 repairIntent：{"schemaVersion":1,"kind":"validator_step","step":"verify","outcome":"failed","summary":"...","evidence":[{"kind":"command","coveredPaths":["src/a.ts"],"command":"pnpm test","summary":"...","outcome":"failed"}],"repairIntent":{"changedPaths":["src/a.ts"],"requiresDesignChange":false,"requiresDependencyChange":false}}。每条 evidence 的 command 必须非空。',
    '修复步骤报告形状：{"schemaVersion":1,"kind":"validator_step","step":"repair_applied","changedPaths":[...],"note":"..."}。changedPaths 必须与你实际改动一致，且必须落在获批范围内。',
    `只能在获批 Scope Envelope 内直接修复：include=${JSON.stringify([...input.scopeEnvelope.include])}，exclude=${JSON.stringify([...input.scopeEnvelope.exclude])}。需要设计变更、依赖变更或越界改动时，改发 {"schemaVersion":1,"kind":"validator_step","step":"escalation","reason":"scope"|"design"|"dependency"|"authority"|"budget","request":"..."}。`,
    `宿主 reply 是 JSON：{"schemaVersion":1,"kind":"validator_step_reply","action":"repair"|"verify"|"finish"|"refuse","stepId":"...","repairIntent":{...}|null,"reason":"..."|null}。收到 action=repair 时只按给出的 repairIntent 修复并回报 repair_applied；收到 action=verify 时复验并回报 verify；收到 action=finish 时停止验证并以 worker_done 提交最终结论；收到 action=refuse 时停止并提交失败的 worker_done。`,
    `本次剩余修复预算为 ${remainingRepairs} 次（上限 ${input.repairBudget.limit}，已消耗 ${input.repairBudget.consumed}）；超出后宿主会拒绝修复。`,
  ];
}

// 仅用于把 `validationRepairStepId` 保持在本模块的 Host API 视图中，避免调用点重复拼装。
export { validationRepairStepId };
