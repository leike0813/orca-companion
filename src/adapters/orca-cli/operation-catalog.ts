/**
 * IP-2 / D2 / D6：Orca 操作目录与响应解析。
 *
 * 目录是访问 Orca 的唯一入口：每个受支持命令登记为一条「操作 ID → argv 构造 + 结果解析 + 输出上限 +
 * 是否可变」记录，adapter 只按操作 ID 取值，从不接受拼接好的 argv。未登记的 ID 在构造 argv 之前就被
 * 拒绝，因此上层拿不到「任意 Orca 命令」。
 *
 * 所有 TypeScript 片段都是本地 contract mirror：对照公开 CLI 的真实 JSON 外壳
 * （`{ id, ok, result | error, _meta.runtimeId }`，见 `docs/research/orca-public-control-contracts.md`）
 * 做必需字段、类型与控制流枚举三类判定，未知枚举与缺失必填字段一律 fail closed。
 */

import type {
  DeliveryBatch,
  DeliveryMessage,
} from '../../application/dto/operation-outcome.js';
import type {
  ExecutionMutation,
  ExecutionOperation,
  ExecutionQuery,
} from '../../application/ports/execution-backend.js';
import type { OutputLimits } from './process-runner.js';

export type QueryOperation = ExecutionQuery['operation'];
export type MutationOperation = ExecutionMutation['operation'];
export type OrcaOperation = QueryOperation | MutationOperation;
export type OperationInput<K extends OrcaOperation> = Extract<ExecutionOperation, { operation: K }>;

/** 该操作从哪里取协调身份；`none` 表示命令不接受身份参数。 */
export type IdentityUse = 'none' | 'from' | 'terminal';

export type OperationParse<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

export type OperationSpec<Input> = {
  readonly mutating: boolean;
  readonly format: 'json' | 'text';
  readonly identity: IdentityUse;
  readonly limits?: OutputLimits;
  readonly buildArgv: (input: Input, identity: string | undefined) => readonly string[];
  readonly parseResult?: (result: unknown) => OperationParse<unknown>;
};

type EntryFor<K extends OrcaOperation> = {
  readonly mutating: boolean;
  readonly format: 'json' | 'text';
  readonly identity: IdentityUse;
  readonly limits?: OutputLimits;
  readonly buildArgv: (input: OperationInput<K>, identity: string | undefined) => readonly string[];
  readonly parseResult?: (result: unknown) => OperationParse<unknown>;
};

/** `check --wait` 之类长会话输出单独放宽上限，仍是有界值。 */
const LONG_READ_LIMITS: OutputLimits = { maxBytes: 4 * 1024 * 1024, maxLines: 40_000 };

// ---------------------------------------------------------------------------
// 窄校验器
// ---------------------------------------------------------------------------

export function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function readRecordField(source: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  return readRecord(source[key]);
}

export function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' ? value : null;
}

export function readBoolean(source: Record<string, unknown>, key: string): boolean | null {
  const value = source[key];
  return typeof value === 'boolean' ? value : null;
}

export function readNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function readArray(source: Record<string, unknown>, key: string): readonly unknown[] | null {
  const value = source[key];
  return Array.isArray(value) ? value : null;
}

function invalid<T>(message: string): OperationParse<T> {
  return { ok: false, message };
}

function parsed<T>(value: T): OperationParse<T> {
  return { ok: true, value };
}

/** 缺失必填字段或类型不符时 fail closed。 */
function requireRecord(result: unknown, label: string): Record<string, unknown> | OperationParse<never> {
  const record = readRecord(result);
  if (record === undefined) {
    return invalid(`${label}: 结果不是对象`);
  }
  return record;
}

function isParseFailure(value: unknown): value is OperationParse<never> {
  return typeof value === 'object' && value !== null && 'ok' in value && value.ok === false;
}

// ---------------------------------------------------------------------------
// 公开响应形状
// ---------------------------------------------------------------------------

export type RuntimeStatus = {
  readonly state: string;
  readonly reachable: boolean;
  readonly runtimeId: string | null;
  readonly appVersion: string | null;
  readonly capabilities: readonly string[];
};

export type HostEntry = {
  readonly id: string;
  readonly kind: string;
  readonly platform: string | null;
};

export type TerminalSummary = {
  readonly handle: string;
  readonly connected: boolean;
  readonly writable: boolean;
  readonly orphaned: boolean;
  readonly executionHostId: string | null;
  readonly worktreeId: string | null;
  readonly branch: string | null;
  readonly title: string | null;
};

export type TerminalListResult = {
  readonly terminals: readonly TerminalSummary[];
  readonly hostIds: readonly string[];
  readonly omittedHostIds: readonly string[];
  readonly totalCount: number | null;
  readonly truncated: boolean;
};

export type RunSummary = {
  readonly runId: string;
  readonly objective: string;
  readonly consumerGeneration: number;
  readonly coordinatorHandle: string | null;
  readonly legacy: boolean;
};

export type RunListResult = {
  readonly runs: readonly RunSummary[];
  readonly nextCursor: string | null;
};

export type RequestState = 'completed' | 'pending' | 'absent';

export type RequestShowResult = {
  readonly requestId: string;
  readonly state: RequestState;
  readonly interpretation: string | null;
};

export type WorkerShowResult = {
  readonly dispatchId: string | null;
  readonly taskId: string | null;
  readonly dispatchStatus: string | null;
  readonly workerState: string | null;
  readonly workerStage: string | null;
  readonly agentTerminalHandle: string | null;
  /** 以下为可选诊断字段：缺失时为 null，不因此判整个响应无效。 */
  readonly observationStatus: string | null;
  readonly exactWorker: boolean | null;
};

export type WorkerEntry = {
  readonly dispatchId: string | null;
  readonly taskId: string | null;
  readonly runId: string | null;
  readonly workerState: string | null;
  readonly terminalState: string | null;
  readonly agentTerminalHandle: string | null;
};

export type WorkerListResult = {
  readonly workers: readonly WorkerEntry[];
};

/** `worker-start` 回执的公开状态词表；未登记的取值 fail closed。 */
const WORKER_START_STATES: ReadonlySet<string> = new Set(['ready', 'failed', 'outcome_unknown']);

export type WorkerStartReceipt = {
  readonly state: string;
  readonly stage: string | null;
  readonly runId: string | null;
  readonly taskId: string | null;
  readonly dispatchId: string | null;
};

// ---------------------------------------------------------------------------
// 解析器
// ---------------------------------------------------------------------------

export function parseRuntimeStatus(result: unknown): OperationParse<RuntimeStatus> {
  const record = requireRecord(result, 'status');
  if (isParseFailure(record)) {
    return record;
  }
  const runtime = readRecordField(record, 'runtime');
  if (runtime === undefined) {
    return invalid('status: 缺少 runtime 对象');
  }
  const reachable = readBoolean(runtime, 'reachable');
  if (reachable === null) {
    return invalid('status.runtime: 缺少 reachable');
  }
  const capabilities = readStringArray(runtime, 'capabilities');
  if (capabilities === undefined) {
    // 能力声明是 M0 门禁的输入，缺失时 fail closed，不能当作「没有要求」。
    return invalid('status.runtime: 缺少 capabilities 数组');
  }
  return parsed({
    state: readString(runtime, 'state') ?? 'unknown',
    reachable,
    runtimeId: readString(runtime, 'runtimeId'),
    appVersion: readString(runtime, 'appVersion'),
    capabilities,
  });
}

export function parseHostList(result: unknown): OperationParse<readonly HostEntry[]> {
  const record = requireRecord(result, 'host list');
  if (isParseFailure(record)) {
    return record;
  }
  const hosts = readArray(record, 'hosts');
  if (hosts === null) {
    return invalid('host list: 缺少 hosts 数组');
  }
  const entries: HostEntry[] = [];
  for (const raw of hosts) {
    const host = readRecord(raw);
    const id = host === undefined ? null : readString(host, 'id');
    const kind = host === undefined ? null : readString(host, 'kind');
    if (host === undefined || id === null || kind === null) {
      return invalid('host list: 存在缺少 id 或 kind 的条目');
    }
    entries.push({ id, kind, platform: readString(host, 'platform') });
  }
  return parsed(entries);
}

export function parseTerminalSummary(raw: unknown): OperationParse<TerminalSummary> {
  const terminal = readRecord(raw);
  if (terminal === undefined) {
    return invalid('terminal: 条目不是对象');
  }
  const handle = readString(terminal, 'handle');
  const connected = readBoolean(terminal, 'connected');
  const writable = readBoolean(terminal, 'writable');
  if (handle === null || connected === null || writable === null) {
    return invalid('terminal: 缺少 handle、connected 或 writable');
  }
  return parsed({
    handle,
    connected,
    writable,
    orphaned: readBoolean(terminal, 'orphaned') ?? false,
    executionHostId: readString(terminal, 'executionHostId'),
    worktreeId: readString(terminal, 'worktreeId'),
    branch: readString(terminal, 'branch'),
    title: readString(terminal, 'title'),
  });
}

export function parseTerminalList(result: unknown): OperationParse<TerminalListResult> {
  const record = requireRecord(result, 'terminal list');
  if (isParseFailure(record)) {
    return record;
  }
  const terminals = readArray(record, 'terminals');
  const hostScope = readRecordField(record, 'hostScope');
  if (terminals === null || hostScope === undefined) {
    return invalid('terminal list: 缺少 terminals 或 hostScope');
  }
  const hostIds = readStringArray(hostScope, 'hostIds');
  const omittedHostIds = readStringArray(hostScope, 'omittedHostIds');
  if (hostIds === undefined || omittedHostIds === undefined) {
    return invalid('terminal list: hostScope 含非字符串条目');
  }
  const entries: TerminalSummary[] = [];
  for (const raw of terminals) {
    const entry = parseTerminalSummary(raw);
    if (!entry.ok) {
      return entry;
    }
    entries.push(entry.value);
  }
  return parsed({
    terminals: entries,
    hostIds,
    omittedHostIds,
    totalCount: readNumber(record, 'totalCount'),
    truncated: readBoolean(record, 'truncated') ?? false,
  });
}

export function parseTerminalShow(result: unknown): OperationParse<TerminalSummary> {
  const record = requireRecord(result, 'terminal show');
  if (isParseFailure(record)) {
    return record;
  }
  return parseTerminalSummary(record['terminal']);
}

function readStringArray(source: Record<string, unknown>, key: string): readonly string[] | undefined {
  const values = readArray(source, key);
  if (values === null) {
    return [];
  }
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') {
      return undefined;
    }
    result.push(value);
  }
  return result;
}

function parseRunSummary(raw: unknown): RunSummary | undefined {
  const run = readRecord(raw);
  if (run === undefined) {
    return undefined;
  }
  const runId = readString(run, 'id');
  const objective = readString(run, 'objective');
  const consumerGeneration = readNumber(run, 'consumer_generation');
  if (runId === null || objective === null || consumerGeneration === null) {
    return undefined;
  }
  return {
    runId,
    objective,
    consumerGeneration,
    coordinatorHandle: readString(run, 'coordinator_handle'),
    legacy: (readNumber(run, 'legacy') ?? 0) === 1,
  };
}

export function parseRunList(result: unknown): OperationParse<RunListResult> {
  const record = requireRecord(result, 'run list');
  if (isParseFailure(record)) {
    return record;
  }
  const runs = readArray(record, 'runs');
  if (runs === null) {
    return invalid('run list: 缺少 runs 数组');
  }
  const entries: RunSummary[] = [];
  for (const raw of runs) {
    const run = parseRunSummary(raw);
    if (run === undefined) {
      return invalid('run list: 存在缺少 id、objective 或 consumer_generation 的条目');
    }
    entries.push(run);
  }
  return parsed({ runs: entries, nextCursor: readString(record, 'nextCursor') });
}

export function parseRunShow(result: unknown): OperationParse<RunSummary> {
  const record = requireRecord(result, 'run show');
  if (isParseFailure(record)) {
    return record;
  }
  const run = parseRunSummary(record['run']);
  if (run === undefined) {
    return invalid('run show: run 缺少 id、objective 或 consumer_generation');
  }
  return parsed(run);
}

export function parseRunCurrent(result: unknown): OperationParse<{ readonly run: RunSummary | null }> {
  const record = requireRecord(result, 'run current');
  if (isParseFailure(record)) {
    return record;
  }
  const raw = record['run'];
  if (raw === null || raw === undefined) {
    return parsed({ run: null });
  }
  const run = parseRunSummary(raw);
  if (run === undefined) {
    return invalid('run current: run 缺少 id、objective 或 consumer_generation');
  }
  return parsed({ run });
}

export function parseRequestShow(result: unknown): OperationParse<RequestShowResult> {
  const record = requireRecord(result, 'request show');
  if (isParseFailure(record)) {
    return record;
  }
  const requestId = readString(record, 'requestId');
  const state = readString(record, 'state');
  if (requestId === null || state === null) {
    return invalid('request show: 缺少 requestId 或 state');
  }
  if (state !== 'completed' && state !== 'pending' && state !== 'absent') {
    return invalid(`request show: 未知 state ${state}`);
  }
  return parsed({ requestId, state, interpretation: readString(record, 'interpretation') });
}

/**
 * 字段名按真实载荷登记：`dispatch` 与 `worker` 使用 snake_case（`task_id`、
 * `agent_terminal_handle`），`observation` 使用 camelCase（`status`、`exactWorker`）。
 */
export function parseWorkerShow(result: unknown): OperationParse<WorkerShowResult> {
  const record = requireRecord(result, 'worker show');
  if (isParseFailure(record)) {
    return record;
  }
  const dispatch = readRecordField(record, 'dispatch');
  const worker = readRecordField(record, 'worker');
  const observation = readRecordField(record, 'observation');
  if (worker === undefined) {
    return invalid('worker show: 缺少 worker 对象');
  }
  const workerState = readString(worker, 'state');
  if (workerState === null) {
    return invalid('worker show: 缺少 worker.state');
  }
  return parsed({
    dispatchId: dispatch === undefined ? null : readString(dispatch, 'id'),
    taskId: dispatch === undefined ? null : readString(dispatch, 'task_id'),
    dispatchStatus: dispatch === undefined ? null : readString(dispatch, 'status'),
    workerState,
    workerStage: readString(worker, 'stage'),
    agentTerminalHandle: readString(worker, 'agent_terminal_handle'),
    observationStatus: observation === undefined ? null : readString(observation, 'status'),
    exactWorker: observation === undefined ? null : readBoolean(observation, 'exactWorker'),
  });
}

export function parseWorkerList(result: unknown): OperationParse<WorkerListResult> {
  const record = requireRecord(result, 'worker list');
  if (isParseFailure(record)) {
    return record;
  }
  const workers = readArray(record, 'workers');
  if (workers === null) {
    return invalid('worker list: 缺少 workers 数组');
  }
  const entries: WorkerEntry[] = [];
  for (const raw of workers) {
    const worker = readRecord(raw);
    if (worker === undefined) {
      return invalid('worker list: 条目不是对象');
    }
    entries.push({
      dispatchId: readString(worker, 'dispatchId'),
      taskId: readString(worker, 'taskId'),
      runId: readString(worker, 'runId'),
      workerState: readString(worker, 'workerState'),
      terminalState: readString(worker, 'terminalState'),
      agentTerminalHandle: readString(worker, 'agentTerminalHandle'),
    });
  }
  return parsed({ workers: entries });
}

/** 回执的 `state` 在 result 顶层；`stage` 只有失败路径才给出 `failedStage`。 */
export function parseWorkerStartReceipt(result: unknown): OperationParse<WorkerStartReceipt> {
  const record = requireRecord(result, 'worker start');
  if (isParseFailure(record)) {
    return record;
  }
  const state = readString(record, 'state');
  if (state === null) {
    return invalid('worker start: 缺少 state');
  }
  if (!WORKER_START_STATES.has(state)) {
    return invalid(`worker start: 未知 state ${state}`);
  }
  return parsed({
    state,
    stage: readString(record, 'failedStage'),
    runId: readString(record, 'runId'),
    taskId: readString(record, 'taskId'),
    dispatchId: readString(record, 'dispatchId'),
  });
}

export function parseDeliveryBatch(result: unknown): OperationParse<DeliveryBatch> {
  const record = requireRecord(result, 'delivery read');
  if (isParseFailure(record)) {
    return record;
  }
  const messages = readArray(record, 'messages');
  if (messages === null) {
    return invalid('delivery read: 缺少 messages 数组');
  }
  const entries: DeliveryMessage[] = [];
  for (const raw of messages) {
    const entry = parseDeliveryMessage(raw);
    if (!entry.ok) {
      return entry;
    }
    entries.push(entry.value);
  }
  const deliveryId = readString(record, 'deliveryId');
  const runId = readString(record, 'runId');
  return parsed({
    delivery: deliveryId === null ? null : { deliveryId, runId },
    messages: entries,
    timedOut: readBoolean(record, 'timedOut') ?? false,
    cancelled: readBoolean(record, 'cancelled') ?? false,
  });
}

/** 已解析 `DeliveryBatch` 的结构确认：`delivery-read` 的 parser 已在 backend 侧跑过一次。 */
export function isDeliveryBatch(value: unknown): value is DeliveryBatch {
  const record = readRecord(value);
  if (record === undefined) {
    return false;
  }
  const delivery = record['delivery'];
  if (delivery !== null && delivery !== undefined) {
    const identity = readRecord(delivery);
    if (identity === undefined || typeof identity['deliveryId'] !== 'string') {
      return false;
    }
  }
  const messages = record['messages'];
  if (!Array.isArray(messages)) {
    return false;
  }
  return messages.every((message) => {
    const entry = readRecord(message);
    return entry !== undefined && typeof entry['messageId'] === 'string' && typeof entry['fromHandle'] === 'string';
  });
}

function parseDeliveryMessage(raw: unknown): OperationParse<DeliveryMessage> {
  const message = readRecord(raw);
  if (message === undefined) {
    return invalid('delivery message: 条目不是对象');
  }
  const messageId = readString(message, 'id');
  const fromHandle = readString(message, 'from_handle');
  if (messageId === null || fromHandle === null) {
    return invalid('delivery message: 缺少 id 或 from_handle');
  }
  const contract = readString(message, 'delivery_contract');
  if (contract !== null && contract !== 'legacy_direct' && contract !== 'current_delivery' && contract !== 'audit_only') {
    return invalid(`delivery message: 未知 delivery_contract ${contract}`);
  }
  return parsed({
    messageId,
    runId: readString(message, 'run_id'),
    deliveryContract: contract,
    fromHandle,
    toHandle: readString(message, 'to_handle'),
    type: readString(message, 'type'),
    subject: readString(message, 'subject'),
    priority: readString(message, 'priority'),
    body: readString(message, 'body'),
    payload: readString(message, 'payload'),
  });
}

// ---------------------------------------------------------------------------
// 操作目录
// ---------------------------------------------------------------------------

function pushFlag(args: string[], flag: string, value: unknown): void {
  if (value !== undefined) {
    if (
      (typeof value !== 'string' && typeof value !== 'number') ||
      (typeof value === 'string' && value.length === 0) ||
      (typeof value === 'number' && (!Number.isInteger(value) || value < 0))
    ) {
      throw new Error(`${flag} 的值无效`);
    }
    args.push(flag, String(value));
  }
}

function pushSwitch(args: string[], enabled: unknown, flag: string): void {
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw new Error(`${flag} 必须是布尔值`);
  }
  if (enabled === true) {
    args.push(flag);
  }
}

function oneOf(value: unknown, allowed: readonly string[], field: string): string {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`${field} 不是登记值`);
  }
  return value;
}

function pushIdentity(args: string[], identity: string | undefined, flag: string): void {
  if (identity === undefined) {
    throw new Error(`操作需要协调身份，但 ${flag} 没有可解析的 handle`);
  }
  args.push(flag, identity);
}

export const ORCA_OPERATIONS = {
  version: {
    mutating: false,
    format: 'text',
    identity: 'none',
    buildArgv: () => ['--version'],
  },
  status: {
    mutating: false,
    format: 'json',
    identity: 'none',
    buildArgv: () => ['status', '--json'],
    parseResult: parseRuntimeStatus,
  },
  'host-list': {
    mutating: false,
    format: 'json',
    identity: 'none',
    buildArgv: () => ['host', 'list', '--json'],
    parseResult: parseHostList,
  },
  'worktree-current': {
    mutating: false,
    format: 'json',
    identity: 'none',
    buildArgv: () => ['worktree', 'current', '--json'],
  },
  'terminal-list': {
    mutating: false,
    format: 'json',
    identity: 'none',
    buildArgv: (input) => {
      const args = ['terminal', 'list', '--json'];
      pushFlag(args, '--worktree', input.worktree);
      pushFlag(args, '--limit', input.limit);
      return args;
    },
    parseResult: parseTerminalList,
  },
  'terminal-show': {
    mutating: false,
    format: 'json',
    identity: 'none',
    buildArgv: (input) => ['terminal', 'show', '--terminal', input.terminal, '--json'],
    parseResult: parseTerminalShow,
  },
  'terminal-read': {
    mutating: false,
    format: 'json',
    identity: 'none',
    limits: LONG_READ_LIMITS,
    buildArgv: (input) => {
      if (input.screen === true && input.cursor !== undefined) {
        throw new Error('--screen 与 --cursor 不能同时使用');
      }
      const args = ['terminal', 'read', '--terminal', input.terminal, '--json'];
      pushFlag(args, '--cursor', input.cursor);
      pushFlag(args, '--limit', input.limit);
      pushSwitch(args, input.screen, '--screen');
      return args;
    },
  },
  'terminal-wait': {
    mutating: false,
    format: 'json',
    identity: 'none',
    buildArgv: (input) => {
      const args = [
        'terminal',
        'wait',
        '--terminal',
        input.terminal,
        '--for',
        oneOf(input.waitFor, ['exit', 'tui-idle'], 'waitFor'),
        '--json',
      ];
      pushFlag(args, '--timeout-ms', input.timeoutMs);
      return args;
    },
  },
  'run-list': {
    mutating: false,
    format: 'json',
    identity: 'none',
    buildArgv: (input) => {
      const args = ['orchestration', 'run-list', '--json'];
      pushFlag(args, '--limit', input.limit);
      pushFlag(args, '--cursor', input.cursor);
      return args;
    },
    parseResult: parseRunList,
  },
  'run-show': {
    mutating: false,
    format: 'json',
    identity: 'none',
    buildArgv: (input) => ['orchestration', 'run-show', '--id', input.runId, '--json'],
    parseResult: parseRunShow,
  },
  'run-current': {
    mutating: false,
    format: 'json',
    identity: 'from',
    buildArgv: (_input, identity) => {
      const args = ['orchestration', 'run-current', '--json'];
      pushIdentity(args, identity, '--from');
      return args;
    },
    parseResult: parseRunCurrent,
  },
  'task-list': {
    mutating: false,
    format: 'json',
    identity: 'from',
    buildArgv: (input, identity) => {
      const args = ['orchestration', 'task-list', '--json'];
      pushIdentity(args, identity, '--from');
      pushFlag(args, '--run', input.runId);
      pushFlag(args, '--status', input.status);
      pushSwitch(args, input.ready, '--ready');
      pushSwitch(args, input.brief, '--brief');
      return args;
    },
  },
  'worker-show': {
    mutating: false,
    format: 'json',
    identity: 'none',
    buildArgv: (input) => ['orchestration', 'worker-show', '--dispatch', input.dispatchId, '--json'],
    parseResult: parseWorkerShow,
  },
  'worker-read': {
    mutating: false,
    format: 'json',
    identity: 'none',
    limits: LONG_READ_LIMITS,
    buildArgv: (input) => {
      const args = ['orchestration', 'worker-read', '--dispatch', input.dispatchId, '--json'];
      pushFlag(
        args,
        '--source',
        input.source === undefined ? undefined : oneOf(input.source, ['auto', 'transcript', 'terminal'], 'source'),
      );
      pushFlag(args, '--cursor', input.cursor);
      pushFlag(args, '--limit', input.limit);
      return args;
    },
  },
  'worker-list': {
    mutating: false,
    format: 'json',
    identity: 'none',
    buildArgv: (input) => {
      const args = ['orchestration', 'worker-list', '--json'];
      pushFlag(args, '--run', input.runId);
      pushFlag(
        args,
        '--terminal-state',
        input.terminalState === undefined
          ? undefined
          : oneOf(
              input.terminalState,
              ['active', 'reclaimable', 'retained', 'release_pending', 'release_unknown', 'released'],
              'terminalState',
            ),
      );
      return args;
    },
    parseResult: parseWorkerList,
  },
  'delivery-read': {
    mutating: false,
    format: 'json',
    identity: 'terminal',
    limits: LONG_READ_LIMITS,
    buildArgv: (input, identity) => {
      const args = ['orchestration', 'check', '--json'];
      pushIdentity(args, identity, '--terminal');
      pushFlag(args, '--run', input.runId);
      if (input.types !== undefined && (!Array.isArray(input.types) || input.types.some((type) => typeof type !== 'string' || type.length === 0))) {
        throw new Error('types 必须是非空字符串数组');
      }
      pushFlag(args, '--types', input.types === undefined || input.types.length === 0 ? undefined : input.types.join(','));
      pushSwitch(args, input.wait, '--wait');
      pushFlag(args, '--timeout-ms', input.timeoutMs);
      const readMode = input.readMode === undefined ? 'default' : oneOf(input.readMode, ['default', 'peek', 'all'], 'readMode');
      pushSwitch(args, readMode === 'peek', '--peek');
      pushSwitch(args, readMode === 'all', '--all');
      return args;
    },
    parseResult: parseDeliveryBatch,
  },
  'request-show': {
    mutating: false,
    format: 'json',
    identity: 'none',
    buildArgv: (input) => ['orchestration', 'request-show', '--request', input.requestId, '--json'],
    parseResult: parseRequestShow,
  },
  'terminal-create': {
    mutating: true,
    format: 'json',
    identity: 'none',
    buildArgv: (input) => {
      const args = ['terminal', 'create', '--worktree', input.worktree, '--json'];
      pushFlag(args, '--title', input.title);
      pushFlag(args, '--command', input.command);
      return args;
    },
  },
  'run-create': {
    mutating: true,
    format: 'json',
    identity: 'from',
    buildArgv: (input, identity) => {
      const args = ['orchestration', 'run-create', '--objective', input.objective, '--json'];
      pushIdentity(args, identity, '--from');
      pushFlag(args, '--retry-request', input.retryRequestId);
      return args;
    },
  },
  'run-use': {
    mutating: true,
    format: 'json',
    identity: 'from',
    buildArgv: (input, identity) => {
      const args = ['orchestration', 'run-use', '--id', input.runId, '--json'];
      pushIdentity(args, identity, '--from');
      pushSwitch(args, input.takeoverLegacy, '--takeover-legacy');
      return args;
    },
  },
  'task-create': {
    mutating: true,
    format: 'json',
    identity: 'from',
    buildArgv: (input, identity) => {
      const args = ['orchestration', 'task-create', '--spec', input.spec, '--json'];
      pushIdentity(args, identity, '--from');
      if (input.deps !== undefined && (!Array.isArray(input.deps) || input.deps.some((dep) => typeof dep !== 'string' || dep.length === 0))) {
        throw new Error('deps 必须是非空字符串数组');
      }
      pushFlag(args, '--deps', input.deps === undefined ? undefined : JSON.stringify(input.deps));
      pushFlag(args, '--parent', input.parentTaskId);
      pushFlag(args, '--run', input.runId);
      pushFlag(args, '--task-title', input.taskTitle);
      pushFlag(args, '--display-name', input.displayName);
      return args;
    },
  },
  'task-update': {
    mutating: true,
    format: 'json',
    identity: 'from',
    buildArgv: (input, identity) => {
      const args = [
        'orchestration',
        'task-update',
        '--id',
        input.taskId,
        '--status',
        oneOf(input.status, ['pending', 'ready', 'dispatched', 'completed', 'failed', 'blocked'], 'status'),
        '--json',
      ];
      pushIdentity(args, identity, '--from');
      pushFlag(args, '--result', input.result === undefined ? undefined : JSON.stringify(input.result));
      return args;
    },
  },
  'worker-start': {
    mutating: true,
    format: 'json',
    identity: 'from',
    buildArgv: (input, identity) => {
      if ((input.agent === undefined) === (input.terminal === undefined)) {
        throw new Error('worker-start 必须且只能指定 agent 或 terminal 之一');
      }
      if (input.effort !== undefined && input.model === undefined) {
        throw new Error('--effort 需要同时指定 --model');
      }
      const args = ['orchestration', 'worker-start', '--task', input.taskId, '--json'];
      pushIdentity(args, identity, '--from');
      pushFlag(args, '--agent', input.agent);
      pushFlag(args, '--terminal', input.terminal);
      pushFlag(args, '--model', input.model);
      pushFlag(args, '--effort', input.effort);
      pushFlag(args, '--worktree', input.worktree);
      pushFlag(args, '--on', input.on);
      pushFlag(args, '--retry-of', input.retryOfDispatchId);
      pushFlag(args, '--run', input.runId);
      pushFlag(args, '--timeout-ms', input.timeoutMs);
      return args;
    },
    parseResult: parseWorkerStartReceipt,
  },
  'worker-stop': {
    mutating: true,
    format: 'json',
    identity: 'none',
    buildArgv: (input) => ['orchestration', 'worker-stop', '--dispatch', input.dispatchId, '--json'],
  },
  'worker-abandon': {
    mutating: true,
    format: 'json',
    identity: 'none',
    buildArgv: (input) => ['orchestration', 'worker-abandon', '--dispatch', input.dispatchId, '--json'],
  },
  'worker-release': {
    mutating: true,
    format: 'json',
    identity: 'none',
    buildArgv: (input) => ['orchestration', 'worker-release', '--dispatch', input.dispatchId, '--json'],
  },
  'delivery-ack': {
    mutating: true,
    format: 'json',
    identity: 'terminal',
    buildArgv: (input, identity) => {
      const args = ['orchestration', 'check', '--json'];
      pushIdentity(args, identity, '--terminal');
      pushFlag(args, '--run', input.runId);
      args.push('--ack', input.deliveryId);
      return args;
    },
  },
} satisfies { readonly [K in OrcaOperation]: EntryFor<K> };

export function isRegisteredOrcaOperation(operation: string): operation is OrcaOperation {
  return Object.hasOwn(ORCA_OPERATIONS, operation);
}

/**
 * 取出统一签名的操作记录。表中每个条目都已按自己 variant 的输入形状校验过（见上面的 `satisfies`）；
 * 这里只把异构表按共同签名取出，避免在调用点使用 `any` 或逐操作复制分支。
 */
export function operationSpec(operation: OrcaOperation): OperationSpec<ExecutionOperation> {
  return ORCA_OPERATIONS[operation] as unknown as OperationSpec<ExecutionOperation>;
}

export type OrcaEnvelope =
  | {
      readonly kind: 'ok';
      readonly result: unknown;
      readonly requestId: string;
      readonly runtimeId: string | null;
    }
  | {
      readonly kind: 'error';
      readonly code: string;
      readonly message: string;
      readonly requestId: string;
      readonly runtimeId: string | null;
    }
  | { readonly kind: 'invalid'; readonly message: string };

function readRuntimeId(envelope: Record<string, unknown>): string | null {
  const meta = readRecordField(envelope, '_meta');
  return meta === undefined ? null : readString(meta, 'runtimeId');
}

/**
 * 解析真实 CLI 外壳。顶层 `id` 是 Orca 的请求凭据，也是 `request-show` / `--retry-request` 接受的标识；
 * `_meta.runtimeId` 为 `null` 时请求根本没有抵达 runtime。
 */
export function parseOrcaEnvelope(raw: string): OrcaEnvelope {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { kind: 'invalid', message: '标准输出为空，没有可解析的 JSON 文档' };
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return { kind: 'invalid', message: '标准输出不是合法 JSON 文档' };
  }
  const envelope = readRecord(value);
  if (envelope === undefined) {
    return { kind: 'invalid', message: 'JSON 文档不是对象' };
  }
  const requestId = readString(envelope, 'id');
  if (requestId === null) {
    return { kind: 'invalid', message: 'envelope 缺少请求 id' };
  }
  const runtimeId = readRuntimeId(envelope);
  const ok = readBoolean(envelope, 'ok');
  if (ok === true) {
    return { kind: 'ok', result: envelope['result'], requestId, runtimeId };
  }
  if (ok === false) {
    const error = readRecordField(envelope, 'error');
    const code = error === undefined ? null : readString(error, 'code');
    if (error === undefined || code === null) {
      return { kind: 'invalid', message: 'error envelope 缺少 error.code' };
    }
    return { kind: 'error', code, message: readString(error, 'message') ?? code, requestId, runtimeId };
  }
  return { kind: 'invalid', message: 'envelope 缺少布尔 ok 字段' };
}
