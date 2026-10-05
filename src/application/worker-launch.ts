import type { CoordinationScopeId, OperationId } from './dto/identity.js';
import type { BranchCoordinationStore } from './ports/branch-coordination-store.js';
import type { ExecutionBackend, ExecutionMutation } from './ports/execution-backend.js';

/** 读取 prepared-terminal intent 的可核验句柄：只有查询给出确定结果才可能 none，其余缺证据一律 evidence_missing。 */
export type KnownTerminalHandle =
  | { readonly kind: 'none' }
  | { readonly kind: 'known'; readonly handle: string }
  | { readonly kind: 'evidence_missing' };

export function knownTerminalHandleFor(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
  operationId: OperationId,
): KnownTerminalHandle {
  const read = store.query({ kind: 'intent', coordinationScopeId, operationId });
  if (read.kind !== 'intent') {
    return { kind: 'evidence_missing' };
  }
  const intent = read.intent;
  if (intent === null) {
    return { kind: 'none' };
  }
  if (intent.state === 'settled' && intent.outcomeClass === 'rejected') {
    return { kind: 'none' };
  }
  const handle = intent.terminalHandle;
  return handle === null || handle === undefined
    ? { kind: 'evidence_missing' }
    : { kind: 'known', handle };
}

export type PreparedTerminalLaunch = {
  readonly title: string;
  readonly command: string;
};

export type PreparedTerminalStrategy<T extends PreparedTerminalLaunch = PreparedTerminalLaunch> = {
  readonly kind: 'prepared_terminal';
  readonly harness: string;
  readonly activation: 'none' | 'submit_draft';
  /** 仅用于展示；崩溃恢复以 prepared 创建回执里的 terminal handle 为资源 owner。 */
  readonly title: string;
  readonly prepare: (input: { readonly worktreePath: string }) => Promise<T>;
};

/** Worker 启动只有两条登记路径；函数型 prepare 不能从模型 DTO 反序列化。 */
export type WorkerLaunchStrategy =
  | {
      readonly kind: 'orca_managed';
      readonly agent: string;
      readonly model?: string;
      readonly effort?: string;
    }
  | PreparedTerminalStrategy;

export type WorkerLaunchFailure =
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string }
  | { readonly kind: 'unknown'; readonly operationId: OperationId; readonly reason: string }
  | { readonly kind: 'blocked'; readonly laneKey: string; readonly reason: string };

export type WorkerLaunchMutationResult = { readonly kind: 'accepted'; readonly terminalHandle?: string } | WorkerLaunchFailure;

export type PreparedTerminalBinding = {
  readonly handle: string;
  readonly title: string;
  readonly worktreeSelector: string;
  readonly activation: PreparedTerminalStrategy['activation'];
};

export type PreparedWorkerLaunch =
  | {
      readonly kind: 'ready';
      readonly worker: {
        readonly agent?: string;
        readonly terminal?: string;
        readonly model?: string;
        readonly effort?: string;
      };
      readonly preparedTerminal: PreparedTerminalBinding | null;
    }
  | WorkerLaunchFailure;

type TerminalEntry = {
  readonly handle: string;
  readonly connected: boolean;
  readonly writable: boolean;
  readonly title: string | null;
};

function rejected(code: string, message: string): WorkerLaunchFailure {
  return { kind: 'rejected', code, message };
}

async function worktreePath(
  backend: ExecutionBackend,
  worktreeId: string,
  knownPath: string | undefined,
): Promise<string | WorkerLaunchFailure> {
  if (knownPath !== undefined) {
    return knownPath;
  }
  const listed = await backend.query({ operation: 'worktree-list', limit: 1_000 });
  if (listed.kind === 'rejected') {
    return listed;
  }
  const value = listed.value as {
    readonly worktrees?: unknown;
    readonly truncated?: unknown;
    readonly hostScope?: { readonly omittedHostIds?: readonly unknown[] } | null;
  };
  if (
    !Array.isArray(value.worktrees) ||
    value.truncated !== false ||
    value.hostScope === null ||
    !Array.isArray(value.hostScope?.omittedHostIds) ||
    value.hostScope.omittedHostIds.length > 0
  ) {
    return rejected('worktree_scope_unverifiable', '无法完整列举 Worker worktree，拒绝准备 harness');
  }
  const worktrees = value.worktrees as readonly unknown[];
  const matches = worktrees.filter((entry) => {
    return typeof entry === 'object' && entry !== null && (entry as Record<string, unknown>)['worktreeId'] === worktreeId;
  });
  const path = typeof matches[0] === 'object' && matches[0] !== null
    ? (matches[0] as Record<string, unknown>)['path']
    : undefined;
  return matches.length === 1 && typeof path === 'string' && path.length > 0
    ? path
    : rejected('worktree_unverifiable', `无法按 exact id 定位 Worker worktree：${worktreeId}`);
}

async function preparedTerminal(
  backend: ExecutionBackend,
  worktreeSelector: string,
  title: string,
  handle?: string,
): Promise<TerminalEntry | null | WorkerLaunchFailure> {
  const listed = await backend.query({ operation: 'terminal-list', worktree: worktreeSelector, limit: 1_000 });
  if (listed.kind === 'rejected') {
    return listed;
  }
  const value = listed.value as {
    readonly terminals?: unknown;
    readonly omittedHostIds?: readonly unknown[];
    readonly truncated?: unknown;
  };
  if (
    !Array.isArray(value.terminals) ||
    value.truncated !== false ||
    !Array.isArray(value.omittedHostIds) ||
    value.omittedHostIds.length > 0
  ) {
    return rejected('terminal_scope_unverifiable', 'terminal 列举范围不完整，拒绝猜测 prepared terminal');
  }
  const terminals: TerminalEntry[] = [];
  for (const raw of value.terminals as readonly unknown[]) {
    if (typeof raw !== 'object' || raw === null) {
      return rejected('invalid_terminal_response', 'terminal list 含非对象条目');
    }
    const record = raw as Record<string, unknown>;
    if (
      typeof record['handle'] !== 'string' ||
      typeof record['connected'] !== 'boolean' ||
      typeof record['writable'] !== 'boolean' ||
      (record['title'] !== null && typeof record['title'] !== 'string')
    ) {
      return rejected('invalid_terminal_response', 'terminal list 条目缺少 exact handle 或存活字段');
    }
    terminals.push({
      handle: record['handle'],
      connected: record['connected'],
      writable: record['writable'],
      title: record['title'],
    });
  }
  const matches = terminals.filter((terminal) => handle === undefined ? terminal.title === title : terminal.handle === handle);
  if (matches.length > 1) {
    return { kind: 'blocked', laneKey: title, reason: `稳定 title 命中 ${matches.length} 个 terminal，无法确定资源归属` };
  }
  return matches[0] ?? null;
}

/** 准备 Worker 启动输入；prepared terminal 创建必须由调用方用自己的 Operation Intent 包裹。 */
export async function prepareWorkerLaunch(input: {
  readonly backend: ExecutionBackend;
  readonly strategy: WorkerLaunchStrategy;
  readonly worktreeId: string;
  readonly worktreePath?: string;
  /** Original terminal-create receipt identity, rechecked in the exact worktree. */
  readonly knownTerminalHandle?: string;
  readonly timeoutMs: number;
  readonly createTerminal: (mutation: Extract<ExecutionMutation, { operation: 'terminal-create' }>) => Promise<WorkerLaunchMutationResult>;
}): Promise<PreparedWorkerLaunch> {
  if (input.strategy.kind === 'orca_managed') {
    return {
      kind: 'ready',
      worker: {
        agent: input.strategy.agent,
        ...(input.strategy.model === undefined ? {} : { model: input.strategy.model }),
        ...(input.strategy.effort === undefined ? {} : { effort: input.strategy.effort }),
      },
      preparedTerminal: null,
    };
  }

  const path = await worktreePath(input.backend, input.worktreeId, input.worktreePath);
  if (typeof path !== 'string') {
    return path;
  }
  const selector = `path:${path}`;
  let terminal = await preparedTerminal(input.backend, selector, input.strategy.title, input.knownTerminalHandle);
  if (terminal !== null && ('kind' in terminal)) {
    return terminal;
  }
  if (terminal === null) {
    if (input.knownTerminalHandle !== undefined) {
      return rejected('prepared_terminal_unavailable', '原 terminal-create 回执资源不在当前 worktree，拒绝重复创建');
    }
    let prepared: PreparedTerminalLaunch;
    try {
      prepared = await input.strategy.prepare({ worktreePath: path });
    } catch (error) {
      return rejected('worker_harness_prepare_failed', error instanceof Error ? error.message : String(error));
    }
    if (prepared.title !== input.strategy.title || prepared.command.length === 0) {
      return rejected('invalid_worker_launcher', 'Worker Harness Adapter 返回了不稳定 title 或空 launcher');
    }
    const created = await input.createTerminal({
      operation: 'terminal-create',
      worktree: selector,
      title: prepared.title,
      command: prepared.command,
    });
    if (created.kind !== 'accepted') {
      return created;
    }
    terminal = await preparedTerminal(input.backend, selector, input.strategy.title, created.terminalHandle);
    if (terminal !== null && ('kind' in terminal)) {
      return terminal;
    }
  }
  if (terminal === null || !terminal.connected || !terminal.writable) {
    return rejected('prepared_terminal_unavailable', 'prepared terminal 未能以 connected + writable 的 exact 资源读回');
  }
  const waited = await input.backend.query({
    operation: 'terminal-wait',
    terminal: terminal.handle,
    waitFor: 'tui-idle',
    timeoutMs: input.timeoutMs,
  });
  if (waited.kind === 'rejected') {
    return waited;
  }
  return {
    kind: 'ready',
    worker: { terminal: terminal.handle },
    preparedTerminal: {
      handle: terminal.handle,
      title: input.strategy.title,
      worktreeSelector: selector,
      activation: input.strategy.activation,
    },
  };
}

/**
 * 提交已由 Orca 写入的 prepared terminal draft。
 *
 * 当前 CLI 的 terminal-read 不提供 draft 字段（只有 screen tail），因此不做屏幕文本猜测：activation 为
 * submit_draft 时直接提交一次；调用方用稳定 Operation Intent 包裹该 mutation，重放由 Intent 复用而不重发。
 */
export async function activatePreparedWorker(input: {
  readonly backend: ExecutionBackend;
  readonly terminal: PreparedTerminalBinding | null;
  readonly submitTerminal: (mutation: Extract<ExecutionMutation, { operation: 'terminal-submit' }>) => Promise<WorkerLaunchMutationResult>;
}): Promise<WorkerLaunchMutationResult> {
  if (input.terminal === null || input.terminal.activation === 'none') {
    return { kind: 'accepted' };
  }
  return input.submitTerminal({ operation: 'terminal-submit', terminal: input.terminal.handle });
}

/** Orca 接管后必须读回同一个 exact external terminal，才承认正式 Dispatch。 */
export async function verifyPreparedWorker(
  backend: ExecutionBackend,
  dispatchId: string,
  terminal: PreparedTerminalBinding | null,
): Promise<WorkerLaunchFailure | null> {
  if (terminal === null) {
    return null;
  }
  const shown = await backend.query({ operation: 'worker-show', dispatchId });
  if (shown.kind === 'rejected') {
    return shown;
  }
  const value = shown.value as { readonly exactWorker?: unknown; readonly agentTerminalHandle?: unknown };
  return value.exactWorker === true && value.agentTerminalHandle === terminal.handle
    ? null
    : rejected('worker_adoption_unverifiable', 'worker-start 后无法读回 exact Worker 与 prepared terminal 绑定');
}
