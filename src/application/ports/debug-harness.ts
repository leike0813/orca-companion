/**
 * IP-04 / D-04：调试宿主的应用端口（Owner: 本 change 的 debug host）。
 *
 * 调试会话没有 Coordination Scope：它只是一个普通目录、一个真实 Session 与一份固定的模型配置
 * 快照。因此本端口不出现 Scope、Graph、Run、Worker、Execution Authorization 或 ControllerSnapshot
 * ——它们在调试里不存在，凭空造一个只会让界面开始依赖协调语义。
 *
 * 身份只有两个：`debugDirectoryId`（真实目录 realpath 的命名空间）与 `coordinatorSessionId`（该
 * 目录下的真实会话身份）。它们与 IC-13 的 `UiDebugMessageTarget` 一一对应，因此草稿、待核验提交
 * 与历史按同一对身份隔离。
 */
import type { AgentTurnRetryOutcome, AgentTurnState } from './agent-turn.js';
import type { CoordinatorModelConfiguration } from '../coordinator/model-config-switch.js';
import type { TranscriptReadingPort } from '../coordinator/history.js';
import type { SubmissionStatus } from '../coordinator/submission-status.js';
import type { UiInputStore } from './ui-input-store.js';
import type { ProviderCatalog } from '../configuration/provider-catalog.js';
import type { ProviderLibrary } from '../configuration/provider-library.js';
import type { ProjectContextStatus } from '../tui/project-presentation.js';

/** 拒绝原因的封闭取值；界面按 code 判定，不解析文案。 */
export const DEBUG_HARNESS_CODES = [
  /** `--debug` 指向的目录不存在、不可读或不是目录。 */
  'directory_unavailable',
  /** 用户级调试会话注册表不可读或不可写。 */
  'registry_unreadable',
  /** 继续的会话不属于当前调试目录，或该目录没有会话。 */
  'session_unknown',
  /** 选择的模型不在用户模型库中。 */
  'model_unknown',
  /** 配置无法构造出 chat model。 */
  'model_resolution_failed',
  /** 五项能力核验未通过；调试 host 因此拒绝打开会话。 */
  'capability_missing',
  /** 同一会话已有存活写者（文件锁 + pid 核验）。 */
  'session_locked',
  /** 会话库或输入库无法打开。 */
  'storage_unavailable',
  /** 端口已关闭。 */
  'closed',
  /** 尚未打开任何调试会话。 */
  'not_open',
  /** 同一宿主已经打开了一个调试会话。 */
  'already_open',
  'blank_content',
  'content_too_long',
  'invalid_submission',
  /** 同一 submissionId 已经提交过内容不同的消息。 */
  'content_conflict',
] as const;

export type DebugHarnessCode = (typeof DEBUG_HARNESS_CODES)[number];

/** 用户模型库里的一个可选模型；不含凭据引用之外的任何秘密信息。 */
export type DebugModelOption = {
  readonly modelRef: string;
  readonly connectionRef: string;
  readonly connectionLabel: string;
  readonly providerIntegration: string;
  readonly model: string;
  /** 该模型的可信 effort 取值；`null` 表示没有可信来源，不允许选择 effort。 */
  readonly efforts: readonly string[] | null;
};

/** 注册表里的一条调试会话：固定配置快照，运行时不再回查可变用户库。 */
export type DebugSessionSummary = {
  readonly coordinatorSessionId: string;
  readonly debugDirectoryId: string;
  readonly directoryPath: string;
  readonly configuration: CoordinatorModelConfiguration;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** 轮次状态；`null` 表示未读取——home 是纯只读查询，不打开会话库，真实状态以 `open` 后为准。 */
  readonly turn: AgentTurnState | null;
};

export type DebugHomeLoad =
  | {
      readonly kind: 'home';
      readonly debugDirectoryId: string;
      readonly directoryPath: string;
      /** 该真实目录下的会话，按创建时间排序；新建与继续都从这里选。 */
      readonly sessions: readonly DebugSessionSummary[];
      readonly models: readonly DebugModelOption[];
    }
  | { readonly kind: 'failed'; readonly code: DebugHarnessCode; readonly message: string };

/** 打开必须是用户的明确选择：新建绑定一个已存在的模型，继续绑定注册表里已有的会话。 */
export type DebugOpenInput =
  | { readonly kind: 'new'; readonly modelRef: string; readonly effort?: string | null }
  | { readonly kind: 'continue'; readonly coordinatorSessionId: string };

export type DebugOpenResult =
  | {
      readonly kind: 'opened';
      readonly state: DebugSessionState;
      /** `true` 表示读回了既有历史；`false` 表示这是该目录下的首个会话。 */
      readonly recovered: boolean;
      /** 通过的五项能力名；核验未通过时不会走到这里。 */
      readonly capabilities: readonly string[];
    }
  | { readonly kind: 'rejected'; readonly code: DebugHarnessCode; readonly message: string };

/** 当前打开的会话状态：会话身份、固定模型配置与轮次状态。 */
export type DebugSessionState = {
  readonly debugDirectoryId: string;
  readonly directoryPath: string;
  readonly coordinatorSessionId: string;
  readonly configuration: CoordinatorModelConfiguration;
  readonly turn: AgentTurnState;
  /** 本进程是否有在途轮次；界面据此显示「正在运行」而不必猜轮次状态。 */
  readonly running: boolean;
  /** 最近一次已提交请求的真实用量与声明窗口；读不到时为 `unavailable`，界面据此渲染共享状态行。 */
  readonly context?: ProjectContextStatus;
};

export type DebugStateLoad =
  | { readonly kind: 'state'; readonly state: DebugSessionState }
  | { readonly kind: 'no-session' }
  | { readonly kind: 'failed'; readonly code: DebugHarnessCode; readonly message: string };

export type DebugSendInput = {
  /** UI 在一次提交时生成，同一次重试必须复用；它派生已提交条目与 Wake Batch 的身份。 */
  readonly submissionId: string;
  readonly content: string;
};

/** 提交三值：`unknown` 表示无法证明已受理，只能沿原 submissionId 核验，不得重发。 */
export type DebugSendResult =
  | { readonly kind: 'accepted'; readonly submissionId: string; readonly replayed: boolean }
  | { readonly kind: 'rejected'; readonly code: DebugHarnessCode; readonly message: string }
  | { readonly kind: 'unknown'; readonly submissionId: string; readonly reason: string };

/** 会话级事件；transcript 增量的通知走 `reading.subscribe`，不重复投影。 */
export type DebugEvent =
  | {
      readonly kind: 'turn-changed';
      readonly coordinatorSessionId: string;
      readonly turn: AgentTurnState;
    }
  | {
      readonly kind: 'message-committed';
      readonly coordinatorSessionId: string;
      readonly submissionId: string;
    };

export type DebugSubmissionQuery = {
  readonly submissionId: string;
  readonly content: string;
};

export type DebugHarnessPort = {
  /** 列出该目录的会话与用户模型库里的模型；只读，不探测模型也不取得写者。 */
  readonly home: () => DebugHomeLoad;
  /**
   * 用户级 Provider library 与公共模型目录：调试配置模型用的是与普通启动同一份服务和
   * CredentialStore，因此两个 profile 看到同一份连接、模型与凭据引用。
   *
   * 这里是应用层服务而不是 TUI 端口：调试界面与普通启动渲染同一个编辑器组件。
   */
  readonly providerLibrary: { readonly library: ProviderLibrary; readonly catalog: ProviderCatalog };
  /** 明确选择新建或继续：只有到这一步才核验能力、打开存储并取得单写者锁。 */
  readonly open: (input: DebugOpenInput) => Promise<DebugOpenResult>;
  readonly state: () => DebugStateLoad;
  /** 落盘用户消息并唤醒一次轮次；返回的是提交结果，不是模型是否已经回答。 */
  readonly send: (input: DebugSendInput) => Promise<DebugSendResult>;
  /** 按原 submissionId 核验权威记录：accepted / not-found / conflict / unverifiable。 */
  readonly submission: (query: DebugSubmissionQuery) => SubmissionStatus;
  /** 同步停止：先取消在途请求，再上停止 latch。 */
  readonly stop: () => void;
  /** 明确恢复：核验通过才解除停止；调试会话没有协调副作用需要重放。 */
  readonly retry: () => Promise<AgentTurnRetryOutcome>;
  /** 退出意图：先取消在途模型工作，之后才允许保存草稿。 */
  readonly exitIntent: () => void;
  readonly reading: TranscriptReadingPort;
  readonly inputStore: UiInputStore;
  readonly subscribe: (listener: (event: DebugEvent) => void) => () => void;
  readonly close: () => void;
};
