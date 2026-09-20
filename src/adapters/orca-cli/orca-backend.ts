/**
 * IP-2 / IP-3：`ExecutionBackend` 的 Orca CLI transport 实现。
 *
 * 职责边界（MOD-04）：只做封闭 operation catalog 取值、argv 构造、进程调用与 schema/error 转换，
 * 不拥有模式转换、预算、准入、重试或图推进。未知控制流枚举、缺失必填字段与未知 scope 一律 fail closed。
 *
 * 三值处置（D3）：
 * - 本地拒绝（未登记操作、缺少 scope、身份不可解析、进程没能启动）→ `rejected`；
 * - 已抵达 runtime 的确定结果（含确定失败）→ `accepted`；
 * - 不确定状态、传输故障、未登记错误码，以及「进程跑过但结果读不出来」→ `unknown`。
 * 任何路径都不换 OperationId 重试。
 */

import { parseRevision, parseStableId } from '../../application/dto/identity.js';
import type {
  ExecutionQueryResult,
  OperationOutcome,
  OperationRef,
  ReconcileResult,
} from '../../application/dto/operation-outcome.js';
import type {
  ExecutionAuthority,
  ExecutionBackend,
  ExecutionMutation,
  ExecutionOperation,
  ExecutionQuery,
  ExecutionScope,
} from '../../application/ports/execution-backend.js';
import { classifyOrcaFailure } from './error-classification.js';
import {
  isRegisteredOrcaOperation,
  operationSpec,
  parseOrcaEnvelope,
  parseRequestShow,
  readRecord,
  type OperationSpec,
  type OrcaEnvelope,
} from './operation-catalog.js';
import { DEFAULT_OUTPUT_LIMITS, runProcess, type OutputLimits, type ProcessRunner } from './process-runner.js';

export const DEFAULT_QUERY_TIMEOUT_MS = 30_000;

/** 给 CLI 自己的 `--timeout-ms` 留出余量，让它的超时先于我们的进程超时发生。 */
const INNER_TIMEOUT_SLACK_MS = 5_000;

/** 把不透明身份引用解析成当前 runtime 作用域句柄；解析不出即拒绝，绝不猜。 */
export type OrcaIdentityResolver = (ref: string) => Promise<string | undefined> | string | undefined;

export type OrcaExecutionBackendOptions = {
  readonly executable?: string;
  /** 显式工作目录；不依赖调用进程的隐含状态或 UI 焦点。 */
  readonly cwd: string;
  /** 显式环境；不继承 ambient identity（例如未声明的 ORCA_TERMINAL_HANDLE）。 */
  readonly env: Readonly<Record<string, string>>;
  readonly resolveIdentityHandle?: OrcaIdentityResolver;
  /** 注入点：contract test 用记录型假 transport 替换真实进程。 */
  readonly runner?: ProcessRunner;
  readonly defaultTimeoutMs?: number;
  readonly limits?: OutputLimits;
};

/** `accepted` 携带的确定失败：Orca 记录了结果，但结果是拒绝。 */
export type OrcaDefiniteFailure = {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
};

/** 只丢弃保活噪声行；判定是结构化的，不做子串猜测。 */
export function isOrcaKeepaliveLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) {
    return false;
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return false;
  }
  const record = readRecord(value);
  return record !== undefined && Object.hasOwn(record, '_keepalive');
}

type Failure = { readonly ok: false; readonly code: string; readonly message: string };

function failure(code: string, message: string): Failure {
  return { ok: false, code, message };
}

type SpecSelection = { readonly ok: true; readonly spec: OperationSpec<ExecutionOperation> } | Failure;

type IdentityResolution = { readonly ok: true; readonly handle: string | undefined } | Failure;

type ScopeValidation = { readonly ok: true; readonly scope: ExecutionScope } | Failure;

type OperationRun =
  | { readonly kind: 'unreachable'; readonly code: string; readonly message: string }
  | { readonly kind: 'indeterminate'; readonly reason: string }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'json'; readonly envelope: OrcaEnvelope; readonly stdoutTruncated: boolean };

function readAuthority(raw: unknown): ExecutionAuthority | undefined {
  const authority = readRecord(raw);
  if (authority === undefined) {
    return undefined;
  }
  if (authority['kind'] === 'route_planning') {
    return { kind: 'route_planning' };
  }
  if (authority['kind'] !== 'execution_coordination') {
    return undefined;
  }
  const graphGeneration = parseRevision(authority['graphGeneration'], 'scope.authority.graphGeneration');
  const authorizationId = parseStableId(authority['authorizationId'], 'scope.authority.authorizationId');
  const runId = parseStableId(authority['runId'], 'scope.authority.runId');
  const consumerGeneration = parseRevision(authority['consumerGeneration'], 'scope.authority.consumerGeneration');
  if (!graphGeneration.ok || !authorizationId.ok || !runId.ok || !consumerGeneration.ok) {
    return undefined;
  }
  return {
    kind: 'execution_coordination',
    graphGeneration: graphGeneration.value,
    authorizationId: authorizationId.value,
    runId: runId.value,
    consumerGeneration: consumerGeneration.value,
  };
}

function requireText(source: Record<string, unknown>, field: string, label: string): string | Failure {
  const parsed = parseStableId(source[field], label);
  if (!parsed.ok) {
    return failure('invalid_scope', `${label} 无效：${parsed.message}`);
  }
  return parsed.value;
}

function isFailure(value: unknown): value is Failure {
  return typeof value === 'object' && value !== null && 'ok' in value && value.ok === false;
}

/**
 * 变更入参的运行时校验：模型输出与 JS 调用方都可能绕过 TypeScript，因此 scope 必须在运行期核验。
 * `target` 按结构校验；operation variant 与 target kind 的相容性由调用方构造 scope 时保证
 * （M0 未登记实体 kind 词表，登记后在此处收紧）。
 */
export function validateExecutionScope(raw: unknown): ScopeValidation {
  const record = readRecord(raw);
  if (record === undefined) {
    return failure(
      'invalid_scope',
      '缺少 ExecutionScope：变更操作必须携带 controller 签发的 scope',
    );
  }
  const coordinationScopeId = requireText(record, 'coordinationScopeId', 'scope.coordinationScopeId');
  if (isFailure(coordinationScopeId)) {
    return coordinationScopeId;
  }
  const coordinatorSessionId = requireText(record, 'coordinatorSessionId', 'scope.coordinatorSessionId');
  if (isFailure(coordinatorSessionId)) {
    return coordinatorSessionId;
  }
  const runtimeIncarnationId = requireText(record, 'runtimeIncarnationId', 'scope.runtimeIncarnationId');
  if (isFailure(runtimeIncarnationId)) {
    return runtimeIncarnationId;
  }
  const backendIdentityRef = requireText(record, 'backendIdentityRef', 'scope.backendIdentityRef');
  if (isFailure(backendIdentityRef)) {
    return backendIdentityRef;
  }
  const operationId = requireText(record, 'operationId', 'scope.operationId');
  if (isFailure(operationId)) {
    return operationId;
  }
  const fencingGeneration = parseRevision(record['fencingGeneration'], 'scope.fencingGeneration');
  if (!fencingGeneration.ok) {
    return failure('invalid_scope', `scope.fencingGeneration 无效：${fencingGeneration.message}`);
  }
  const expectedRevision = parseRevision(record['expectedRevision'], 'scope.expectedRevision');
  if (!expectedRevision.ok) {
    return failure('invalid_scope', `scope.expectedRevision 无效：${expectedRevision.message}`);
  }
  const timeoutMs = record['timeoutMs'];
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return failure('invalid_scope', 'scope.timeoutMs 必须是有限正数');
  }
  const target = readRecord(record['target']);
  const targetKind = target === undefined ? null : parseStableId(target['kind'], 'scope.target.kind');
  const targetId = target === undefined ? null : parseStableId(target['id'], 'scope.target.id');
  if (targetKind === null || targetId === null || !targetKind.ok || !targetId.ok) {
    return failure('invalid_scope', 'scope.target 必须是带非空 kind 与 id 的引用');
  }
  const authority = readAuthority(record['authority']);
  if (authority === undefined) {
    return failure('invalid_scope', 'scope.authority 不是登记的执行授权判别联合');
  }
  return {
    ok: true,
    scope: {
      coordinationScopeId,
      coordinatorSessionId,
      runtimeIncarnationId,
      fencingGeneration: fencingGeneration.value,
      backendIdentityRef,
      operationId,
      target: { kind: targetKind.value, id: targetId.value },
      expectedRevision: expectedRevision.value,
      timeoutMs,
      authority,
    },
  };
}

export function createOrcaExecutionBackend(options: OrcaExecutionBackendOptions): ExecutionBackend {
  const executable = options.executable ?? 'orca';
  const runner = options.runner ?? runProcess;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  const limits = options.limits ?? DEFAULT_OUTPUT_LIMITS;

  async function resolveIdentity(ref: string | undefined): Promise<IdentityResolution> {
    if (ref === undefined) {
      return { ok: true, handle: undefined };
    }
    const resolver = options.resolveIdentityHandle;
    if (resolver === undefined) {
      return failure('identity_unavailable', `未配置身份解析器，无法把 ${ref} 解析成 terminal handle`);
    }
    const handle = await resolver(ref);
    if (handle === undefined || handle.length === 0) {
      return failure('identity_unavailable', `协调身份 ${ref} 当前不可解析成 terminal handle`);
    }
    return { ok: true, handle };
  }

  /**
   * 只有登记的 `identity` 不为 `none` 时才解析身份。身份无关的操作（例如建立专用终端本身）
   * 不得因为调用方还没有句柄而被拒绝，也不得凭空拿到一个 `--from`。
   */
  async function resolveIdentityFor(
    spec: OperationSpec<ExecutionOperation>,
    ref: string | undefined,
  ): Promise<IdentityResolution> {
    if (spec.identity === 'none') {
      return { ok: true, handle: undefined };
    }
    if (ref === undefined || ref.length === 0) {
      const flag = spec.identity === 'from' ? '--from' : '--terminal';
      return failure('identity_unavailable', `${flag} 需要协调身份引用，但调用方没有提供`);
    }
    return await resolveIdentity(ref);
  }

  function selectSpec(operation: string, expectMutating: boolean): SpecSelection {
    if (!isRegisteredOrcaOperation(operation)) {
      return failure('undeclared_operation', `操作目录未登记 ${operation}`);
    }
    const spec = operationSpec(operation);
    if (spec.mutating !== expectMutating) {
      return failure(
        'operation_kind_mismatch',
        `${operation} 不是${expectMutating ? '变更' : '查询'}操作`,
      );
    }
    return { ok: true, spec };
  }

  async function runOperation(
    spec: OperationSpec<ExecutionOperation>,
    input: ExecutionOperation,
    identity: string | undefined,
    timeoutMs: number,
  ): Promise<OperationRun> {
    let argv: readonly string[];
    try {
      argv = spec.buildArgv(input, identity);
      if (argv.some((argument) => typeof argument !== 'string' || argument.length === 0)) {
        throw new Error('操作参数含缺失、空值或非字符串字段');
      }
    } catch (error) {
      return {
        kind: 'unreachable',
        code: 'invalid_input',
        message: error instanceof Error ? error.message : 'argv 构造失败',
      };
    }
    const result = await runner({
      executable,
      args: [...argv],
      cwd: options.cwd,
      env: options.env,
      timeoutMs,
      limits: spec.limits ?? limits,
      dropStderrLine: isOrcaKeepaliveLine,
    });
    if (result.kind === 'unavailable') {
      return { kind: 'unreachable', code: result.code, message: result.message };
    }
    if (result.kind === 'unknown') {
      return {
        kind: 'indeterminate',
        reason: result.reason === 'timeout' ? 'process_timeout' : 'process_cancelled',
      };
    }
    if (spec.format === 'text') {
      return { kind: 'text', text: result.stdout.text.trim() };
    }
    return {
      kind: 'json',
      envelope: parseOrcaEnvelope(result.stdout.text),
      stdoutTruncated: result.stdout.truncated,
    };
  }

  function internalTimeoutMs(input: ExecutionOperation, fallback: number): number {
    if (input.operation === 'terminal-wait') {
      return input.timeoutMs + INNER_TIMEOUT_SLACK_MS;
    }
    if (input.operation === 'delivery-read' && input.wait === true && input.timeoutMs !== undefined) {
      return input.timeoutMs + INNER_TIMEOUT_SLACK_MS;
    }
    return fallback;
  }

  function parseAccepted(spec: OperationSpec<ExecutionOperation>, result: unknown): { readonly ok: true; readonly value: unknown } | Failure {
    if (spec.parseResult === undefined) {
      return { ok: true, value: result };
    }
    const parsed = spec.parseResult(result);
    if (!parsed.ok) {
      return failure('invalid_response', parsed.message);
    }
    return { ok: true, value: parsed.value };
  }

  function operationRef(
    scope: ExecutionScope,
    backendRequestId: string | null | undefined,
  ): OperationRef {
    const target = { kind: scope.target.kind, id: scope.target.id };
    if (backendRequestId === null || backendRequestId === undefined) {
      return { operationId: scope.operationId, target };
    }
    return { operationId: scope.operationId, backendRequestId, target };
  }

  async function query(input: ExecutionQuery): Promise<ExecutionQueryResult> {
    const record = readRecord(input);
    const operation = record?.['operation'];
    if (typeof operation !== 'string' || operation.length === 0) {
      return { kind: 'rejected', code: 'invalid_input', message: '查询缺少 operation' };
    }
    const selected = selectSpec(operation, false);
    if (!selected.ok) {
      return { kind: 'rejected', code: selected.code, message: selected.message };
    }
    const identityRef = 'backendIdentityRef' in input ? input.backendIdentityRef : undefined;
    const identity = await resolveIdentityFor(selected.spec, identityRef);
    if (!identity.ok) {
      return { kind: 'rejected', code: identity.code, message: identity.message };
    }
    const run = await runOperation(
      selected.spec,
      input,
      identity.handle,
      internalTimeoutMs(input, defaultTimeoutMs),
    );
    if (run.kind === 'unreachable') {
      return { kind: 'rejected', code: run.code, message: run.message };
    }
    if (run.kind === 'indeterminate') {
      // 查询没有副作用，因此超时或取消也是可证明无副作用的拒绝，而不是 unknown。
      return { kind: 'rejected', code: run.reason, message: '查询未能结束，且查询不产生副作用' };
    }
    if (run.kind === 'text') {
      return { kind: 'accepted', value: run.text };
    }
    if (run.stdoutTruncated) {
      return { kind: 'rejected', code: 'output_truncated', message: '标准输出超过上限，结果不可信' };
    }
    if (run.envelope.kind === 'invalid') {
      return { kind: 'rejected', code: 'unparsable_output', message: run.envelope.message };
    }
    if (run.envelope.kind === 'error') {
      return { kind: 'rejected', code: run.envelope.code, message: run.envelope.message };
    }
    const accepted = parseAccepted(selected.spec, run.envelope.result);
    if (!accepted.ok) {
      return { kind: 'rejected', code: accepted.code, message: accepted.message };
    }
    return { kind: 'accepted', value: accepted.value };
  }

  async function mutate(input: ExecutionMutation, scope: ExecutionScope): Promise<OperationOutcome<unknown>> {
    const validated = validateExecutionScope(scope);
    if (!validated.ok) {
      return { kind: 'rejected', code: validated.code, message: validated.message };
    }
    const record = readRecord(input);
    const operation = record?.['operation'];
    if (typeof operation !== 'string' || operation.length === 0) {
      return { kind: 'rejected', code: 'invalid_input', message: '变更缺少 operation' };
    }
    const selected = selectSpec(operation, true);
    if (!selected.ok) {
      return { kind: 'rejected', code: selected.code, message: selected.message };
    }
    const trusted = validated.scope;
    const identity = await resolveIdentityFor(selected.spec, trusted.backendIdentityRef);
    if (!identity.ok) {
      return { kind: 'rejected', code: identity.code, message: identity.message };
    }
    const unanswered = operationRef(trusted, undefined);
    const run = await runOperation(selected.spec, input, identity.handle, trusted.timeoutMs);
    if (run.kind === 'unreachable') {
      // 请求从未离开 transport，可以证明没有副作用。
      return { kind: 'rejected', code: run.code, message: run.message };
    }
    if (run.kind === 'indeterminate') {
      return { kind: 'unknown', operation: unanswered, reason: run.reason };
    }
    if (run.kind === 'text') {
      return { kind: 'unknown', operation: unanswered, reason: 'unexpected_text_output_for_mutation' };
    }
    if (run.stdoutTruncated) {
      return { kind: 'unknown', operation: unanswered, reason: 'stdout_truncated_after_run' };
    }
    if (run.envelope.kind === 'invalid') {
      return { kind: 'unknown', operation: unanswered, reason: `unparsable_output: ${run.envelope.message}` };
    }
    const ref = operationRef(trusted, run.envelope.requestId);
    if (run.envelope.kind === 'error') {
      const classification = classifyOrcaFailure({
        code: run.envelope.code,
        reachedRuntime: run.envelope.runtimeId !== null,
      });
      if (classification.disposition === 'rejected') {
        return { kind: 'rejected', code: run.envelope.code, message: run.envelope.message };
      }
      if (classification.disposition === 'unknown') {
        return { kind: 'unknown', operation: ref, reason: classification.reason };
      }
      // 确定失败仍是 accepted：Orca 已经记录了结果，这不表示 Worker 完成或任务通过。
      const value: OrcaDefiniteFailure = {
        ok: false,
        code: run.envelope.code,
        message: run.envelope.message,
      };
      return { kind: 'accepted', operation: ref, value };
    }
    const accepted = parseAccepted(selected.spec, run.envelope.result);
    if (!accepted.ok) {
      return { kind: 'unknown', operation: ref, reason: `invalid_response: ${accepted.message}` };
    }
    return { kind: 'accepted', operation: ref, value: accepted.value };
  }

  return { query, mutate };
}

/**
 * 按原 OperationId 对账一次不确定结果。只做只读查询，绝不重放 mutation；仍不确定时报告阻塞。
 * `absent` 与 `pending` 都不是「未发生」的证明，因此都返回 `blocked` 并保留该 mutation lane。
 */
export async function reconcileOperation(
  backend: ExecutionBackend,
  operation: OperationRef,
): Promise<ReconcileResult> {
  const requestId = operation.backendRequestId;
  if (requestId === undefined) {
    return { kind: 'blocked', operation, reason: 'no_backend_request_id' };
  }
  const result = await backend.query({ operation: 'request-show', requestId });
  if (result.kind !== 'accepted') {
    return { kind: 'blocked', operation, reason: 'unavailable' };
  }
  const parsed = parseRequestShow(result.value);
  if (!parsed.ok) {
    return { kind: 'blocked', operation, reason: 'unrecognized' };
  }
  if (parsed.value.state === 'completed') {
    return {
      kind: 'settled',
      operation,
      statement: parsed.value.interpretation ?? 'Orca 记录了该请求的确定收据',
    };
  }
  return { kind: 'blocked', operation, reason: parsed.value.state === 'pending' ? 'pending' : 'absent' };
}
