/**
 * IP-04 / D-04：独立调试宿主的装配（Owner: 本 change 的 debug host）。
 *
 * `--debug <directory>` 在一个普通目录里启动真实模型、真实工具、真实历史与真实输入管线，而
 * **没有** Coordination Scope、执行图、Run、Worker 或协调授权。因此这里不调用 Orca、不打开
 * 协调库，也不构造任何 ControllerSnapshot：那些事实在调试里不存在，凭空造一个只会让界面开始
 * 依赖协调语义。
 *
 * 复用而不是复制：ProviderLibrary 与唯一 CredentialStore、固定协议 chat-model adapter 与五项能力
 * 核验、Coordinator 小图与 tools 节点、checkpoint 与 UI 输入 store、transcript 阅读端口，全部是
 * 协调宿主已经装配过的那几份。轮次由共享 `AgentTurnDriver` 承担，本模块只提供一次 invoke 的执行。
 *
 * 顺序固定：realpath 归一化 → 用户明确新建或继续 → 解析模型 → 五项能力核验 → 取得单写者锁 →
 * 打开会话库与输入库。能力核验失败时不会留下半可用会话、也不会持有写者。
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

import { verifyModelCapabilities } from '../adapters/agents/capability-probe.js';
import {
  createBuiltinIntegrationResolverAsync,
  resolveChatModel,
  type ExactContextCapability,
  type KeepaliveCapability,
  type NativeCompactionCapability,
} from '../adapters/agents/chat-model-factory.js';
import { JsonCredentialStore } from '../adapters/storage/credential-store.js';
import {
  openCheckpointStore,
  type CheckpointStore,
} from '../adapters/storage/checkpoint-store.js';
import { createTranscriptPreviewStore } from '../adapters/storage/transcript-preview-store.js';
import { openUiInputStore } from '../adapters/storage/ui-input-store.js';
import { FileProviderLibraryStore } from '../adapters/storage/provider-library-store.js';
import {
  acquireDebugWriterLock,
  debugDirectoryId,
  debugSessionPaths,
  debugStateDirectory,
  FileDebugSessionStore,
  resolveDebugDirectory,
  type DebugSessionPaths,
  type DebugSessionRecord,
} from '../adapters/storage/debug-session-store.js';
import { submitDebugUserMessage } from '../application/coordinator/debug-user-message.js';
import { pendingWorkFromHistory } from '../application/coordinator/actionable-work.js';
import {
  coordinatorModelConfigurationSchema,
  type CoordinatorModelConfiguration,
} from '../application/coordinator/model-config-switch.js';
import { COORDINATOR_SESSION_STATE_SCHEMA_VERSION, threadIdFor, userEntryId, userStepId, type CoordinatorSessionState } from '../domain/coordinator/session-state.js';
import type { ModelDefinition, ProviderConnection } from '../domain/model-configuration.js';
import type { CoordinatorSessionId } from '../application/dto/identity.js';
import { AGENT_TURN_MESSAGE_CHARS } from '../application/ports/agent-turn.js';
import type { AgentTurnResult, AgentTurnRetryOutcome } from '../application/ports/agent-turn.js';
import type {
  DebugEvent,
  DebugHarnessCode,
  DebugHarnessPort,
  DebugHomeLoad,
  DebugModelOption,
  DebugOpenInput,
  DebugOpenResult,
  DebugSendInput,
  DebugSendResult,
  DebugSessionState,
  DebugSessionSummary,
  DebugStateLoad,
  DebugSubmissionQuery,
} from '../application/ports/debug-harness.js';
import type { TranscriptReadingPort } from '../application/coordinator/history.js';
import type { UiInputStoreHandle } from '../application/ports/ui-input-store.js';
import type { SubmissionStatus } from '../application/coordinator/submission-status.js';
import { createProviderCatalog } from '../adapters/agents/provider-catalog.js';
import { createProviderLibrary } from '../application/configuration/provider-library.js';
import { AgentTurnDriver } from '../workflow/coordinator/turn-driver.js';
import { createDebugTools } from '../workflow/coordinator/debug-tools.js';
import { createDebugReadServices } from '../adapters/agents/debug-read-tools.js';
import type { DebugReadServices } from '../application/ports/debug-read-tools.js';
import {
  buildSessionBoundedInput,
  contextFailureOf,
  persistBoundedCompaction,
} from '../workflow/coordinator/history-input.js';
import {
  buildCoordinatorGraph,
  type CoordinatorGraphDependencies,
} from '../workflow/coordinator/graph.js';
import {
  COORDINATOR_INVOKE_DEFAULTS,
  pendingToolCallsIn,
} from '../workflow/coordinator/state.js';
import type { CoordinatorToolDefinition } from '../workflow/coordinator/tool-definition.js';

/**
 * 上下文预算与协调宿主在「没有项目配置」时用的是同一个缺省值。
 *
 * 调试会话没有项目配置，因此它复用生产的保守估算与缺省上限，而不是自己发明一个模型窗口：
 * 换成别的数字会让调试结果与真实会话不可比。
 */
const DEBUG_CONTEXT_BUDGET_TOKENS = 100_000;

/** 单个调试会话的诊断上限；到达后停止追加，不轮转。 */
const MAX_DEBUG_DIAGNOSTIC_BYTES = 256 * 1024;

export type DebugModelResolution =
  | {
      readonly kind: 'resolved';
      readonly model: BaseChatModel;
      readonly exactContext: ExactContextCapability | null;
      readonly nativeCompaction: NativeCompactionCapability | null;
      readonly keepalive: KeepaliveCapability | null;
    }
  | { readonly kind: 'failed'; readonly code: string; readonly message: string };

export type DebugRuntimeOptions = {
  /** `--debug` 的目录参数；缺省是当前工作目录。允许非 Git 目录。 */
  readonly directory?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** 用户状态目录；测试与隔离启动替换这一处即可。 */
  readonly stateDirectory?: string;
  readonly clock?: () => number;
  readonly newId?: () => string;
  readonly probeTimeoutMs?: number;
  /** 测试/能力实现的注入 seam，缺省用内置固定协议。 */
  readonly loadIntegration?: (specifier: string) => Promise<unknown>;
  /** 模型解析 seam；缺省走 ProviderLibrary + CredentialStore + 固定协议 adapter。 */
  readonly resolveModel?: (configuration: CoordinatorModelConfiguration) => Promise<DebugModelResolution>;
  /** 只读工具集装配 seam；缺省用 debug 只读工具。 */
  readonly createTools?: (services: DebugReadServices) => readonly CoordinatorToolDefinition[];
  /** 只读文件系统服务的装配 seam；缺省按调试根目录 realpath 建立。 */
  readonly createReadServices?: (input: { readonly rootDirectory: string }) => DebugReadServices;
};

export type DebugHarnessStart =
  | { readonly kind: 'started'; readonly harness: DebugHarnessPort }
  | { readonly kind: 'failed'; readonly code: DebugHarnessCode; readonly message: string };

type OpenSession = {
  readonly record: DebugSessionRecord;
  readonly configuration: CoordinatorModelConfiguration;
  readonly coordinatorSessionId: CoordinatorSessionId;
  readonly checkpoints: CheckpointStore;
  readonly input: UiInputStoreHandle;
  readonly paths: DebugSessionPaths;
  graph: ReturnType<typeof buildCoordinatorGraph>;
  turn: AgentTurnDriver;
  readonly release: () => void;
};

const rejected = (code: DebugHarnessCode, message: string) => ({ kind: 'rejected' as const, code, message });

/** 调试提示：只说明这是什么会话与目录边界，不复制协调宿主的指令。 */
function instructionsFor(directoryPath: string): readonly string[] {
  return [
    '你正在 orca-companion 的调试会话中运行真实模型循环。这里没有项目协调语义，可以自由读写对话。',
    `调试根目录是 ${directoryPath}；只读工具只能访问该目录内部，目录不会被写入。`,
  ];
}

/** 把用户模型库里的一条模型投影成调试可选项；不含任何秘密信息。 */
function modelOptions(library: ReturnType<typeof createProviderLibrary>): DebugModelOption[] {
  const loaded = library.load();
  if (loaded.kind !== 'loaded') return [];
  const connections = new Map(loaded.connections.map((entry) => [entry.connectionRef, entry]));
  return loaded.models.flatMap((model) => {
    const connection = connections.get(model.connectionRef);
    return connection === undefined
      ? []
      : [
          {
            modelRef: model.modelRef,
            connectionRef: connection.connectionRef,
            connectionLabel: connection.label,
            providerIntegration: connection.providerIntegration,
            model: model.model,
            efforts: model.effortCapability?.values ?? null,
          },
        ];
  });
}

/** 由用户模型库的一条记录构造固定配置快照；Session 之后只读这份快照。 */
function configurationFor(input: {
  readonly configurationRef: string;
  readonly model: ModelDefinition;
  readonly connection: ProviderConnection;
  readonly effort: string | null;
}): CoordinatorModelConfiguration | null {
  const capability = input.model.effortCapability;
  const credentialRef = input.connection.credential.credentialRef;
  const parsed = coordinatorModelConfigurationSchema.safeParse({
    configurationRef: input.configurationRef,
    providerIntegration: input.connection.providerIntegration,
    model: input.model.model,
    credentialRefs: [credentialRef],
    nativeWindowOwnerRef: null,
    providerConnection: input.connection,
    modelRef: input.model.modelRef,
    effortCapability: capability,
    effort: input.effort,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * 装配调试宿主。
 *
 * 失败是显式结果：`directory_unavailable` 是唯一在装配期出现的拒绝，因为其余一切都要等用户明确
 * 选择会话之后才需要判定。
 */
export function startDebugHarness(options: DebugRuntimeOptions = {}): Promise<DebugHarnessStart> {
  const environment = options.environment ?? process.env;
  const clock = options.clock ?? Date.now;
  const newId = options.newId ?? randomUUID;
  const resolvedDirectory = resolveDebugDirectory(options.directory ?? process.cwd());
  if (resolvedDirectory.kind === 'rejected') {
    return Promise.resolve({ kind: 'failed', code: 'directory_unavailable', message: resolvedDirectory.message });
  }
  const directoryPath = resolvedDirectory.value;
  const directoryId = debugDirectoryId(directoryPath);
  const stateDirectory = options.stateDirectory ?? debugStateDirectory({ environment });

  // 用户级 CredentialStore 的唯一生产实例来源：调试与协调读同一份用户凭据，也不再另建路径。
  const credentials = new JsonCredentialStore({ environment });
  const catalog = createProviderCatalog({ credentials, environment });
  const library = createProviderLibrary({
    store: new FileProviderLibraryStore({ environment }),
    credentials,
    catalog,
  });
  const integrationResolver = createBuiltinIntegrationResolverAsync(
    options.loadIntegration === undefined ? {} : { load: options.loadIntegration },
  );
  const resolveModel =
    options.resolveModel ??
    (async (configuration: CoordinatorModelConfiguration): Promise<DebugModelResolution> => {
      const integration = await integrationResolver(configuration.providerIntegration);
      if (integration === null) {
        return {
          kind: 'failed',
          code: 'integration_unavailable',
          message: `provider 集成不可用：${configuration.providerIntegration}`,
        };
      }
      const resolved = resolveChatModel(configuration, () => integration, credentials);
      return resolved.kind === 'resolved'
        ? {
            kind: 'resolved',
            model: resolved.model,
            exactContext: resolved.exactContext,
            nativeCompaction: resolved.nativeCompaction,
            keepalive: resolved.keepalive,
          }
        : { kind: 'failed', code: resolved.code, message: resolved.message };
    });

  const registry = new FileDebugSessionStore({ stateDirectory, clock, newId });
  const createReadServices = options.createReadServices ?? ((input: { readonly rootDirectory: string }) => createDebugReadServices(input));
  const createTools = options.createTools ?? createDebugTools;

  let session: OpenSession | null = null;
  let closing = false;
  // 打开阶段的取消：Ctrl+C 或退出意图必须能中断能力核验的请求链，而不是等它跑完五条探测。
  const startupAbort = new AbortController();
  let loopRunning = false;
  const listeners = new Set<(event: DebugEvent) => void>();
  const readingListeners = new Set<(coordinatorSessionId: string) => void>();
  const publish = (event: DebugEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        /* 一个坏订阅者不能拖垮会话；它会重新请求自己错过的那部分 */
      }
    }
  };

  const previews = createTranscriptPreviewStore();

  /**
   * 追加一条有界诊断：固定 code、短 message 与时间戳。
   *
   * 真实故障必须留下可查的证据，但 provider 原始错误体可能带凭据，因此这里只记结构化失败与截断
   * 后的说明。文件到达上限后停止追加，不做轮转。
   */
  const appendDiagnostic = (
    current: OpenSession,
    entry: { readonly kind: string; readonly code: string; readonly message: string },
  ): void => {
    const path = join(current.paths.diagnostics, 'turn.jsonl');
    try {
      // 先算整行再判断容量：否则一次超长行会越过上限半个文件。
      const line = JSON.stringify({
        at: clock(),
        kind: entry.kind,
        code: entry.code,
        message: entry.message.slice(0, AGENT_TURN_MESSAGE_CHARS),
        coordinatorSessionId: current.coordinatorSessionId,
      }) + '\n';
      if (existsSync(path) && statSync(path).size + Buffer.byteLength(line, 'utf8') > MAX_DEBUG_DIAGNOSTIC_BYTES) return;
      appendFileSync(path, line, { encoding: 'utf8', mode: 0o600 });
    } catch {
      // 诊断写不进去也不能影响会话：它只是观测手段，不是权威事实。
    }
  };

  /**
   * 已提交历史的变更通知。
   *
   * 预览只在流式片段经过时通知；一次没有预览的完整响应（例如非流式回退）提交之后，界面只能靠
   * 这个通知去重读历史。因此轮次结束与提交都经过它，而不是指望预览事件。
   */
  const notifyReading = (coordinatorSessionId: string): void => {
    for (const listener of [...readingListeners]) {
      try {
        listener(coordinatorSessionId);
      } catch {
        /* 一个坏订阅者不能拖垮会话；它会重新请求自己错过的那部分 */
      }
    }
  };

  const readingFor = (current: OpenSession): TranscriptReadingPort => {
    const bound = (sessionId: string): CheckpointStore => {
      if (sessionId !== current.coordinatorSessionId) {
        throw new Error('该会话不属于当前调试目录');
      }
      return current.checkpoints;
    };
    return {
      inspection: {
        snapshot: (sessionId) => Promise.resolve(bound(sessionId).readHistoryInspection(sessionId)),
        calls: (query) => Promise.resolve(bound(query.coordinatorSessionId).readHistoryCalls(query)),
        users: (query) => Promise.resolve(bound(query.coordinatorSessionId).readUserHistoryPage(query)),
      },
      history: (query) => Promise.resolve(bound(query.coordinatorSessionId).readHistoryPage(query)),
      body: (query) => {
        const checkpoints = bound(query.coordinatorSessionId);
        if (query.source.kind === 'preview') return Promise.resolve(previews.body(query));
        if (query.source.kind === 'arguments') {
          return Promise.resolve(
            checkpoints.readHistoryArguments({
              coordinatorSessionId: query.coordinatorSessionId,
              entryId: query.source.entryId,
              stepId: query.source.stepId,
              callId: query.source.callId,
              contentRevision: 1,
              offset: query.offset,
              maxBytes: query.maxBytes,
            }),
          );
        }
        if (query.source.kind !== 'history') return Promise.resolve(null);
        const range = checkpoints.readHistoryBody({
          coordinatorSessionId: query.coordinatorSessionId,
          entryId: query.source.entryId,
          contentRevision: query.source.contentRevision,
          offset: query.offset,
          maxBytes: query.maxBytes,
        });
        return Promise.resolve(
          range === null
            ? null
            : {
                source: query.source,
                offset: range.offset,
                end: range.end,
                byteLength: range.byteLength,
                text: range.text,
              },
        );
      },
      previews: (sessionId) => {
        bound(sessionId);
        return Promise.resolve(previews.list(sessionId));
      },
      pin: (sessionId, previewId) => {
        bound(sessionId);
        return previews.pin(sessionId, previewId);
      },
      subscribe: (listener) => {
        readingListeners.add(listener);
        const release = previews.subscribe(listener);
        return () => {
          readingListeners.delete(listener);
          release();
        };
      },
    };
  };

  /**
   * 按用途读取会话记录。
   *
   * 用途不能混用：`metadata` 只读回控制字段（正文按契约是空的），正文分别由 `pending`（派生待办
   * 与未配对调用）、`context`（组装模型输入）与 `tools` 读回。不可恢复一律抛出：把损坏当成
   * 「没有工作」会让会话静默停在旧历史上，看起来像模型正常结束。
   */
  const readState = (current: OpenSession, purpose: 'metadata' | 'pending' | 'context' | 'tools') => {
    const read = current.checkpoints.loadCheckpoint(current.coordinatorSessionId, purpose);
    if (read.kind === 'unrecoverable') {
      throw new Error(`调试会话记录不可恢复：${read.reason}`);
    }
    return read;
  };

  /** 未被回答的用户消息：调试唯一的可执行工作，来源与协调路径同构（按 submissionId）。 */
  const pendingUserWork = (current: OpenSession) => {
    const read = readState(current, 'pending');
    return read.kind === 'recovered'
      ? pendingWorkFromHistory(read.state.committedMessages, new Map()).filter(
          (item) => item.source.sourceKind === 'user-message',
        )
      : [];
  };

  /**
   * 本轮是否真的推进了历史。
   *
   * 用 inspection 的 `upperSequence`（累计提交序号，metadata 读取）而不是「本次读到几条消息」：后者受
   * 有界读取影响，同一条消息可能被重复读到，计数相同并不代表没有进展。序号不变就说明本轮没有写入
   * 任何已提交条目，此时再循环只会把同一个结果反复重放。
   */
  const committedSequence = (current: OpenSession): number =>
    current.checkpoints.readHistoryInspection(current.coordinatorSessionId).upperSequence;

  const stateOf = (current: OpenSession): DebugSessionState => ({
    debugDirectoryId: directoryId,
    directoryPath,
    coordinatorSessionId: current.coordinatorSessionId,
    configuration: current.configuration,
    turn: current.turn.state,
    running: loopRunning,
  });

  /**
   * 一次轮次就是一次图 invoke。
   *
   * `suspended` 与 `work_completed` 都是正常结局：调试没有外部工作要接着消费，因此不会因为
   * 「还有剩余 work」再 invoke 一次——那只会让同一个失败被无限重放。其它结局一律 halted。
   */
  const executeTurn = async (current: OpenSession, signal: AbortSignal): Promise<AgentTurnResult> => {
    const read = readState(current, 'pending');
    const state: CoordinatorSessionState | null = read.kind === 'recovered' ? read.state : null;
    const result = (await current.graph.invoke(
      {
        coordinatorSessionId: current.coordinatorSessionId,
        remainingWork: pendingUserWork(current),
        deferredWork: 0,
        pendingToolCalls: state === null ? 0 : pendingToolCallsIn(state),
      },
      {
        configurable: { thread_id: threadIdFor(current.coordinatorSessionId) },
        signal,
        ...COORDINATOR_INVOKE_DEFAULTS,
      },
    )) as { readonly status: string; readonly note: string };
    return result.status === 'suspended' || result.status === 'work_completed'
      ? { kind: 'completed' }
      : { kind: 'halted', failure: { code: 'halted_by_host', message: result.note } };
  };

  const publishTurn = (current: OpenSession): void => {
    publish({
      kind: 'turn-changed',
      coordinatorSessionId: current.coordinatorSessionId,
      turn: current.turn.state,
    });
  };

  /**
   * 跑完当前所有未回答的用户消息。
   *
   * 只有「用户又发了新消息」才会再跑一轮；每轮都必须消费掉一条真实待办消息，因此不存在空转或
   * 无限 invoke。轮次驱动自己拥有停止 latch 与持久状态，本循环不复制它。
   */
  const runLoop = async (current: OpenSession): Promise<void> => {
    if (loopRunning || closing || current.turn.halted) return;
    loopRunning = true;
    try {
      for (;;) {
        const before = committedSequence(current);
        const outcome = await current.turn.run();
        publishTurn(current);
        if (outcome.kind === 'stopped') {
          appendDiagnostic(current, {
            kind: 'turn_stopped',
            code: outcome.failure.code,
            message: outcome.failure.message,
          });
          return;
        }
        if (closing || current.turn.halted) return;
        if (committedSequence(current) === before) return;
        if (pendingUserWork(current).length === 0) return;
      }
    } catch (error) {
      // 派生待办本身读不回来时按停止处理：异常不得逃出 fire-and-forget 的循环，否则界面只会看到
      // 一个永远 running 的会话和一条未处理的 Promise 拒绝。
      current.turn.stop();
      appendDiagnostic(current, {
        kind: 'turn_error',
        code: 'execution_failed',
        // provider 原始错误可能带响应体或凭据片段：这里只记错误类型，与轮次驱动默认脱敏一致。
        message: error instanceof Error ? error.name : typeof error,
      });
    } finally {
      loopRunning = false;
      // 先落定「没有在途轮次」再通知：提前通知会让界面读到一个仍然 running 的状态并停在那里。
      // 退出路径不再读已释放的存储。
      if (!closing) {
        publishTurn(current);
        notifyReading(current.coordinatorSessionId);
      }
    }
  };

  const open = async (input: DebugOpenInput): Promise<DebugOpenResult> => {
    if (closing) return rejected('closed', '调试宿主已关闭');
    if (session !== null) return rejected('already_open', '同一调试宿主已经打开了一个会话');

    let record: DebugSessionRecord;
    if (input.kind === 'new') {
      if (typeof input.modelRef !== 'string' || input.modelRef.length === 0) {
        return rejected('model_unknown', '必须选择一个用户模型库里的模型');
      }
      const resolved = library.resolveModel(input.modelRef);
      if (resolved.kind !== 'resolved') return rejected('model_unknown', resolved.message);
      const capability = resolved.model.effortCapability;
      const effort = input.effort ?? null;
      if (capability === null ? effort !== null : effort !== null && !capability.values.includes(effort)) {
        return rejected('model_unknown', '所选模型不支持该 effort');
      }
      const configuration = configurationFor({
        configurationRef: newId(),
        model: resolved.model,
        connection: resolved.connection,
        effort,
      });
      if (configuration === null) return rejected('model_unknown', '模型配置快照无效');
      const registered = registry.register({ debugDirectoryId: directoryId, directoryPath, configuration });
      if (registered.kind === 'rejected') return rejected('registry_unreadable', registered.message);
      record = registered.value;
    } else {
      if (typeof input.coordinatorSessionId !== 'string' || input.coordinatorSessionId.length === 0) {
        return rejected('session_unknown', '必须指定一个已存在的调试会话');
      }
      const found = registry.read(directoryId, input.coordinatorSessionId);
      if (found.kind === 'rejected') return rejected('registry_unreadable', found.message);
      if (found.value === null) return rejected('session_unknown', '该调试目录没有这个会话');
      record = found.value;
    }

    const model = await resolveModel(record.configuration);
    // 每个 await 之后都重新确认本进程仍然服务：期间可能已经退出或收到停止意图。
    if (closing || startupAbort.signal.aborted) return rejected('closed', '调试宿主已关闭，能力核验未完成');
    if (model.kind !== 'resolved') return rejected('model_resolution_failed', model.message);
    const verification = await verifyModelCapabilities(model.model, {
      modelRef: record.configuration.configurationRef,
      signal: startupAbort.signal,
      ...(options.probeTimeoutMs === undefined ? {} : { timeoutMs: options.probeTimeoutMs }),
    });
    if (closing || startupAbort.signal.aborted) return rejected('closed', '调试宿主已关闭，能力核验未完成');
    if (verification.kind === 'rejected') return rejected('capability_missing', verification.message);

    const coordinatorSessionId = record.coordinatorSessionId as CoordinatorSessionId;
    const paths = debugSessionPaths(stateDirectory, coordinatorSessionId);
    try {
      mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
      mkdirSync(paths.diagnostics, { recursive: true, mode: 0o700 });
    } catch {
      return rejected('storage_unavailable', `无法创建调试会话目录：${paths.directory}`);
    }
    let tools: readonly CoordinatorToolDefinition[];
    try {
      tools = createTools(createReadServices({ rootDirectory: directoryPath }));
    } catch {
      return rejected('storage_unavailable', '调试目录的只读工具无法装配');
    }
    const lock = acquireDebugWriterLock({ lockPath: paths.writerLock });
    if (lock.kind === 'held') {
      return rejected(
        'session_locked',
        lock.holderPid === null
          ? '该调试会话已被另一个进程打开'
          : `该调试会话正由进程 ${String(lock.holderPid)} 打开`,
      );
    }

    const checkpoints = openCheckpointStore({ databasePath: paths.checkpoints, clock });
    if (checkpoints.kind === 'failed') {
      lock.release();
      return rejected('storage_unavailable', checkpoints.message);
    }
    const inputStore = openUiInputStore({ databasePath: paths.input });
    if (inputStore.kind === 'failed') {
      checkpoints.store.close();
      lock.release();
      return rejected('storage_unavailable', inputStore.message);
    }

    const checkpoint = checkpoints.store.loadCheckpoint(coordinatorSessionId, 'metadata');
    const recovered = checkpoint.kind === 'recovered';
    if (checkpoint.kind === 'unrecoverable' || checkpoint.kind === 'absent' && checkpoints.store.saveCheckpoint({
      schemaVersion: COORDINATOR_SESSION_STATE_SCHEMA_VERSION, coordinatorSessionId,
      committedMessages: [], committedModelSteps: [], wakeBatches: [], graphPosition: 'model', lastCompactionOutcome: null,
    }).kind === 'failed') {
      inputStore.store.close();
      checkpoints.store.close();
      lock.release();
      return rejected('storage_unavailable', '调试会话记录无法初始化或恢复');
    }
    const schemaTokens = Math.ceil(JSON.stringify(tools.map((tool) => ({ name: tool.name, schema: tool.inputSchema }))).length / 4);
    const opened: OpenSession = {
      record,
      configuration: record.configuration,
      coordinatorSessionId,
      checkpoints: checkpoints.store,
      input: inputStore.store,
      paths,
      graph: undefined as unknown as OpenSession['graph'],
      turn: undefined as unknown as OpenSession['turn'],
      release: () => {
        previews.close();
        inputStore.store.close();
        checkpoints.store.close();
        lock.release();
      },
    };
    const dependencies: CoordinatorGraphDependencies = {
      model: model.model,
      configurationRef: record.configuration.configurationRef,
      checkpointer: checkpoints.store.checkpointer,
      sessionRecords: checkpoints.store,
      // 调试没有协调租约：单写者由本会话的 writer.lock 承担，因此这里的判据只回答「本进程是否还在
      // 正常服务」，退出后立刻拒绝继续写入。它不进入任何协调状态，也不伪造 Scope 或 lease。
      assertFencing: () =>
        closing ? { kind: 'fenced' as const, code: 'released_lease' as const } : { kind: 'valid' as const },
      clock,
      newStepId: () => `step:${newId()}`,
      streamObserver: (event) => {
        const sequence = checkpoints.store.readHistoryPage({ coordinatorSessionId: event.coordinatorSessionId }).entries.at(-1)?.sequence ?? 0;
        previews.observe(event, sequence);
      },
      buildMessages: () => {
        const contextRead = readState(opened, 'context');
        if (contextRead.kind !== 'recovered') throw new Error('该调试会话还没有可读的会话记录');
        return buildSessionBoundedInput({
          state: contextRead.state,
          configurationRef: record.configuration.configurationRef,
          tailSequence: checkpoints.store.readHistoryInspection(coordinatorSessionId).upperSequence,
          fixedOverhead: schemaTokens,
          budgetTokens: DEBUG_CONTEXT_BUDGET_TOKENS,
          nativeCompaction: model.nativeCompaction,
          instructions: instructionsFor(directoryPath),
          toolSchema: tools.map((tool) => ({ name: tool.name, description: tool.description, schema: tool.inputSchema })),
          authoritativeFacts: [
            `debugDirectory=${directoryId}`,
            `session=${coordinatorSessionId}`,
            `modelConfiguration=${record.configuration.configurationRef}`,
          ],
          currentWork: null,
          ...(opened.turn.signal === null ? {} : { signal: opened.turn.signal }),
        }).then((built) => {
          // 结论先落盘再判断是否继续：无法复现的输入不该成为一次 provider 请求。
          persistBoundedCompaction({
            checkpoints: checkpoints.store,
            coordinatorSessionId,
            state: contextRead.state,
            built: built.input,
            shakeBoundary: built.shakeBoundary,
          });
          const failure = contextFailureOf(built.input.compaction);
          if (failure !== null) throw new Error(failure);
          return { messages: built.input.messages, note: built.input.compaction.kind };
        });
      },
      planningTools: tools,
      recoveryTools: tools,
    };
    opened.graph = buildCoordinatorGraph(dependencies);
    opened.turn = new AgentTurnDriver({
      coordinatorSessionId,
      turns: checkpoints.store.turns,
      isClosing: () => closing,
      execute: (signal) => executeTurn(opened, signal),
    });
    session = opened;
    return {
      kind: 'opened',
      state: stateOf(opened),
      recovered,
      capabilities: Object.entries(verification.report.capabilities)
        .filter(([, ok]) => ok)
        .map(([name]) => name),
    };
  };

  const send = (input: DebugSendInput): Promise<DebugSendResult> => {
    if (closing) return Promise.resolve(rejected('closed', '调试宿主已关闭'));
    const current = session;
    if (current === null) return Promise.resolve(rejected('not_open', '尚未打开调试会话'));
    const committed = submitDebugUserMessage({
      checkpoints: current.checkpoints,
      debugDirectoryId: directoryId,
      coordinatorSessionId: current.coordinatorSessionId,
      submissionId: input.submissionId,
      content: input.content,
    });
    if (committed.kind === 'rejected') return Promise.resolve(committed);
    if (committed.kind === 'unknown') {
      appendDiagnostic(current, { kind: 'submission_unknown', code: 'submission_unknown', message: committed.reason });
      return Promise.resolve({ kind: 'unknown', submissionId: input.submissionId, reason: committed.reason });
    }
    publish({
      kind: 'message-committed',
      coordinatorSessionId: current.coordinatorSessionId,
      submissionId: input.submissionId,
    });
    notifyReading(current.coordinatorSessionId);
    if (!committed.replayed) void runLoop(current);
    return Promise.resolve({ kind: 'accepted', submissionId: input.submissionId, replayed: committed.replayed });
  };

  const harness: DebugHarnessPort = {
    home(): DebugHomeLoad {
      const listed = registry.list(directoryId);
      if (listed.kind === 'rejected') return { kind: 'failed', code: 'registry_unreadable', message: listed.message };
      const sessions: DebugSessionSummary[] = listed.value.map((record) => ({
        coordinatorSessionId: record.coordinatorSessionId,
        debugDirectoryId: record.debugDirectoryId,
        directoryPath: record.directoryPath,
        configuration: record.configuration,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        // home 是纯只读查询：不打开会话库，因此轮次状态以打开会话后的持久记录为准。
        turn: null,
      }));
      return { kind: 'home', debugDirectoryId: directoryId, directoryPath, sessions, models: modelOptions(library) };
    },
    open,
    state(): DebugStateLoad {
      if (session === null) return { kind: 'no-session' };
      return { kind: 'state', state: stateOf(session) };
    },
    send,
    submission(query: DebugSubmissionQuery): SubmissionStatus {
      const current = session;
      if (current === null) return { kind: 'unverifiable', reason: '尚未打开调试会话' };
      let read;
      try {
        read = current.checkpoints.loadCheckpoint(current.coordinatorSessionId, 'metadata');
      } catch (error) {
        return { kind: 'unverifiable', reason: error instanceof Error ? error.message : String(error) };
      }
      if (read.kind === 'unrecoverable') return { kind: 'unverifiable', reason: read.reason };
      if (read.kind === 'absent') return { kind: 'not-found' };
      let entry;
      try {
        entry = current.checkpoints.readEntry(current.coordinatorSessionId, userEntryId(query.submissionId));
      } catch (error) {
        return { kind: 'unverifiable', reason: error instanceof Error ? error.message : String(error) };
      }
      if (entry === null) return { kind: 'not-found' };
      return entry.role === 'user' && entry.stepId === userStepId(query.submissionId) && entry.content === query.content
        ? { kind: 'accepted', ref: { kind: 'user-message', id: query.submissionId } }
        : { kind: 'conflict', code: 'content_conflict', message: '该 submissionId 已经提交过内容不同的消息' };
    },
    stop(): void {
      startupAbort.abort();
      if (session === null) return;
      session.turn.stop();
      publishTurn(session);
    },
    async retry(): Promise<AgentTurnRetryOutcome> {
      if (session === null) return { kind: 'rejected', failure: { code: 'recovery_rejected', message: '尚未打开调试会话' } };
      // 调试会话没有外部副作用：核验只要求会话记录可读，因此重放工具结果由 tools 节点按原调用身份完成。
      const current = session;
      const outcome = await current.turn.retry(() => {
        // 明确恢复的核验：注册表身份与配置快照一致，且三种用途的正文读回都成功。任一不可读都不放行，
        // 否则恢复后的调用会在损坏的历史或错配的配置上继续，而那看起来像一次正常恢复。
        const record = registry.read(directoryId, current.coordinatorSessionId);
        if (record.kind !== 'ok' || record.value === null) return false;
        if (record.value.configuration.configurationRef !== current.configuration.configurationRef) return false;
        try {
          for (const purpose of ['pending', 'tools', 'context'] as const) readState(current, purpose);
          return true;
        } catch {
          return false;
        }
      });
      publishTurn(current);
      if (outcome.kind === 'cleared') void runLoop(current);
      return outcome;
    },
    exitIntent(): void {
      // 先停止并落盘 halted，再宣告退出：反过来会让驱动以为存储正在关闭而跳过这次写入，
      // 重开后因此读到 running 而不是明确的停止原因。
      startupAbort.abort();
      // 空闲退出不是故障：没有在途轮次时不写 halted，否则下次继续会凭空多出一次恢复。
      if (session !== null && loopRunning) {
        session.turn.stop();
        publishTurn(session);
      }
      closing = true;
    },
    reading: new Proxy({} as TranscriptReadingPort, {
      get: (_target, property) =>
        session === null
          ? () => Promise.reject(new Error('尚未打开调试会话'))
          : (readingFor(session) as unknown as Record<string | symbol, unknown>)[property],
    }),
    inputStore: new Proxy({} as UiInputStoreHandle, {
      get: (_target, property) =>
        session === null
          ? () => ({ kind: 'failed', code: 'not_open', message: '尚未打开调试会话' })
          : (session.input as unknown as Record<string | symbol, unknown>)[property],
    }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close(): void {
      startupAbort.abort();
      closing = true;
      if (session !== null && loopRunning) session.turn.stop();
      session?.release();
      session = null;
      previews.close();
      listeners.clear();
    },
  };
  return Promise.resolve({ kind: 'started', harness });
}
