/**
 * MOD-06：TUI 对应用层的窄端口（Owner: `m2-deliver-planning-tui`）。
 *
 * 屏幕与组件只依赖这些端口，不 import Bootstrap、store、Orca adapter 或 workflow。
 *
 * 端口刻意**不暴露** `CoordinationScopeId` 与 `CoordinationWriter`：宿主在装配时把端口绑定到唯一
 * Scope 并提供写入者身份，界面只表达用户意图。这样「模型和界面不得填写 scope、身份、Run 或
 * operation identity」是结构性的，而不是靠纪律（AGENTS.md §5）。
 */

import type {
  ControllerCommandResult,
  ControllerSnapshot,
  ControllerTranscriptPage,
  SemanticEvent,
  Unsubscribe,
} from '../../application/controller-service.js';
import type { UiInputStore } from '../../application/ports/ui-input-store.js';
import type { SubmissionQuery, SubmissionStatus } from '../../application/coordinator/submission-status.js';
import type { TranscriptReadingPort } from '../../application/coordinator/history.js';
import type {
  EffortCapability,
  ModelSettingsRole as DomainModelSettingsRole,
} from '../../domain/model-configuration.js';
import type {
  ModelSettingsSnapshot,
  SaveModelSettingsInput,
  SaveModelSettingsResult,
} from '../../application/configuration/model-settings.js';
import type { TuiPreferencesPort } from '../../application/configuration/tui-preferences.js';
import type { ProjectDetailsPort } from '../../application/tui/project-presentation.js';
import type { GraphBasisPort } from '../../application/tui/graph-basis.js';

export type { ModelSettingsSnapshot, SaveModelSettingsInput, SaveModelSettingsResult };

export type SnapshotLoad =
  | { readonly kind: 'snapshot'; readonly snapshot: ControllerSnapshot }
  | { readonly kind: 'failed'; readonly code: string; readonly message: string };

export type TranscriptLoad =
  | { readonly kind: 'transcript'; readonly transcript: ControllerTranscriptPage }
  | { readonly kind: 'failed'; readonly code: string; readonly message: string };

/** 用户意图；scope 与 writer 由宿主补齐，界面不构造它们。 */
export type TuiIntent =
  | {
      readonly kind: 'send-session-message';
      readonly coordinatorSessionId: string;
      readonly submissionId: string;
      readonly content: string;
    }
  | {
      readonly kind: 'answer-pending-interaction';
      readonly coordinatorSessionId: string;
      readonly submissionId: string;
      readonly interactionId: string;
      readonly expectedRevision: number;
      readonly answer: string;
    }
  | { readonly kind: 'compact-session'; readonly coordinatorSessionId: string; readonly reason: string }
  | {
      readonly kind: 'switch-model-configuration';
      readonly coordinatorSessionId: string;
      readonly nextConfigurationRef: string;
    }
  | { readonly kind: 'scope-control'; readonly action: 'pause' | 'resume' | 'cancel' }
  | { readonly kind: 'authorization-review' }
  | {
      readonly kind: 'authorization-approve';
      readonly fingerprint: string;
      readonly expectedRevision: number;
    };

export type TuiPorts = {
  readonly commandStatus: (ref: import('../../application/tui/command-result.js').CommandResultRef) => Promise<ControllerCommandResult>;
  readonly reading: TranscriptReadingPort;
  readonly questions?: (input: TuiQuestionQuery) => Promise<import('../../application/controller-service.js').ControllerQuestionResult>;
  readonly inputStore: UiInputStore;
  readonly submissionStatus: (query: SubmissionQuery) => Promise<SubmissionStatus>;
  readonly snapshot: (selectedSessionId: string | null) => Promise<SnapshotLoad>;
  readonly transcript: (
    coordinatorSessionId: string,
    cursor: string | null,
  ) => Promise<TranscriptLoad>;
  readonly execute: (intent: TuiIntent) => Promise<ControllerCommandResult>;
  readonly subscribe: (listener: (event: SemanticEvent) => void) => Unsubscribe;
  readonly scopeSetup: ScopeSetupPort;
  readonly modelCatalog: ModelCatalogPort;
  readonly handoff: HandoffIntentPort;
  readonly executionHandoff: ExecutionHandoffIntentPort;
  readonly executionAuthorization: ExecutionAuthorizationIntentPort;
  /**
   * 角色模型配置端口。
   *
   * 可选：未装配的宿主按「角色模型配置未接通」显示不可用，界面不伪造候选或保存入口。
   */
  readonly modelSettings?: ModelSettingsPort;
  readonly preferences?: TuiPreferencesPort;
  readonly projectDetails?: ProjectDetailsPort;
  /**
   * 图历史与执行依据的有界只读入口（IP-04）。
   *
   * 可选：未装配的宿主按「依据读取未接通」显示不可用，界面不伪造版本目录、来源或正文，也不退回
   * 当前快照猜测历史内容。阅读永远不授权执行：四个动作都是查询，没有写入口。
   */
  readonly graphBasis?: GraphBasisPort;
};

export type TuiQuestionQuery =
  | { readonly kind: 'pending-interactions'; readonly coordinatorSessionId?: string; readonly after?: import('../../application/ports/branch-coordination-store.js').InteractionPageCursor }
  | { readonly kind: 'pending-interaction'; readonly coordinatorSessionId: string; readonly interactionId: string };

/**
 * Execution Authorization 的审阅结果。
 *
 * 界面只显示宿主读好的完整 Manifest 与门禁判决：它不组装 Manifest、不计算指纹，也不替用户判断
 * 「也许可以批准」。`manifestRows` 已由宿主投影成展示行，因此界面不需要、也无法接触领域字段。
 */
export type ExecutionAuthorizationView = {
  readonly fingerprint: string;
  readonly scopeRevision: number;
  readonly candidate: {
    readonly graphId: string;
    readonly generation: number;
    readonly version: number;
    readonly baselineHead: string;
    readonly workPackageCount: number;
  };
  readonly manifestRows: readonly { readonly label: string; readonly value: string }[];
  readonly sections: readonly import('../../application/tui/command-result.js').ReviewSection[];
  readonly gate: { readonly ready: boolean; readonly blockers: readonly string[] };
};

export type ExecutionAuthorizationLoad =
  | { readonly kind: 'review'; readonly review: ExecutionAuthorizationView }
  | { readonly kind: 'blocked'; readonly code: string; readonly message: string }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string };

/**
 * 规划 → 执行的授权意图端口（IP-01）。
 *
 * `review` 是只读的：它只读当前规划产物与配置，返回完整 Manifest 与指纹。`approve` 只携带该指纹与
 * 用户看到的 Scope revision，宿主重读全部权威输入后才写入批准并原子切换；界面填不了任何身份。
 */
export type ExecutionAuthorizationIntentPort = {
  readonly review: () => Promise<ExecutionAuthorizationLoad>;
  readonly approve: (input: {
    readonly fingerprint: string;
    readonly expectedRevision: number;
  }) => Promise<ControllerCommandResult>;
};

/** 仓库里已有的 Coordination Scope 摘要；Home 只用它列出候选，不推断身份。 */
export type ScopeCandidate = {
  readonly coordinationScopeId: string;
  readonly mode: string;
  readonly controlState: string;
};

/** 旧记录缺失的注册绑定；值来自当前 Git 身份，由宿主读取，界面不构造。 */
export type LegacyScopeBinding = {
  readonly fullBranchRef: string;
  readonly canonicalWorktreePath: string;
};

export type HomeResolution =
  | { readonly kind: 'restore'; readonly coordinationScopeId: string }
  /** 缺少注册绑定的旧记录：只列出候选，用户必须在 Review 里确认一次性迁移。 */
  | {
      readonly kind: 'legacy';
      readonly candidates: readonly ScopeCandidate[];
      readonly binding: LegacyScopeBinding;
    }
  | { readonly kind: 'wizard' }
  | { readonly kind: 'failed'; readonly code: string; readonly message: string };

export const WIZARD_CHECKS = ['repository', 'orca', 'identity', 'model', 'tracker'] as const;

export type WizardCheckId = (typeof WIZARD_CHECKS)[number];

export type WizardCheck = {
  readonly id: WizardCheckId;
  readonly ok: boolean;
  readonly detail: string;
};

/**
 * 向导的核验与提交端口。
 *
 * `verify` 是只读的：它只探测 repository/canonical worktree、Orca 能力与身份、Coordinator Model
 * Configuration 与 tracker，不写任何记录。`initialize` 在用户 Review 确认后恰好调用一次，由应用层
 * 以单事务创建 Scope、初始 Planning Cycle 与首个 Coordinator Session。
 */
export type ScopeSetupPort = {
  readonly resolveHome: () => Promise<HomeResolution>;
  readonly verify: () => Promise<readonly WizardCheck[]>;
  readonly proposal: () => Promise<WizardProposal>;
  readonly initialize: (proposal: WizardProposal) => Promise<ControllerCommandResult>;
  /**
   * 旧 Scope 的一次性身份绑定。只有用户在该记录的 Review 里确认后才调用；成功后宿主才把它登记为
   * 当前 Scope，因此「未确认前不恢复」是结构性的，而不是靠界面自觉。
   */
  readonly bindLegacyIdentity: (coordinationScopeId: string) => Promise<ControllerCommandResult>;
};

/** Review 界面展示的提议值；全部由调用方准备，界面不生成身份。 */
export type WizardProposal = {
  readonly coordinationScopeId: string;
  readonly coordinatorSessionId: string;
  readonly coordinatorModelConfigurationRef: string;
  readonly planningCycleId: string;
  readonly repositoryPath: string;
  readonly canonicalWorktree: string;
  readonly trackerRef: string;
};

/**
 * Coordinator Model Configuration 的可用清单与切换准入。
 *
 * `switchable` 由宿主用 `assertSwitchable({suspension, inFlightModelOperations})` 判定：只有它同时持有
 * 「是否挂起」与「在途模型操作数」这两个权威事实。界面只显示判决，不自己猜。
 */
export type ModelCatalog = {
  readonly options: readonly ModelConfigurationOption[];
  readonly currentConfigurationRef: string | null;
  readonly switchable: boolean;
  readonly switchBlockReason: string | null;
  /**
   * 定稿 #52 的三组角色模型。
   *
   * 缺省表示宿主尚未接通角色模型配置，界面据此显示「未接通」而不是虚构候选；此时 Coordinator 组
   * 仍由 `options` 表达，保持 6A 的切换合同不变。
   */
  readonly roles?: readonly ModelRoleView[];
  /** 项目配置 revision；编辑器保存的 CAS 基准。缺省表示没有可用的保存基准。 */
  readonly configurationRevision?: number;
};

export type ModelConfigurationOption = {
  readonly configurationRef: string;
  readonly model: string;
  /** 候选行展示 `provider / model`；缺省时只展示 model。 */
  readonly provider?: string;
  /** 独立 effort 选择的可信来源；缺省或 `null` 表示没有可保存的 effort。 */
  readonly effortCapability?: EffortCapability | null;
};

export type ModelCatalogPort = {
  readonly load: (coordinatorSessionId: string) => Promise<ModelCatalog>;
};

/**
 * 角色槽位。
 *
 * 前四类生产角色与 `recovery_utility` 来自领域 `ModelProfileRole`；`planning_utility` 与
 * `specification_validator` 还没有生产生命周期，界面按定稿列出并显示宿主给出的不可用原因，不把它们
 * 折进领域四主角色。
 */
export type ModelSettingsRole =
  | DomainModelSettingsRole
  | 'planning_utility'
  | 'specification_validator';

/** 定稿 #52 的三个分区。顺序由 `roles` 数组给定，界面不重排。 */
export type ModelRoleGroup = 'current' | 'planning' | 'execution';

/** 角色候选：只展示 provider/model，effort 只能取自该模型的可信能力来源。 */
export type ModelRoleCandidate = {
  /** Coordinator 组是 configurationRef，Worker 组是 modelRef；界面原样回传给 save/apply。 */
  readonly candidateRef: string;
  readonly connectionRef: string | null;
  readonly provider: string;
  readonly model: string;
  /** `null` 表示该模型没有可信 effort 能力来源；界面不得提供虚构 effort。 */
  readonly effortCapability: EffortCapability | null;
};

/** 角色当前绑定；未配置时为 `null`，界面显示未配置而不是取最近对象。 */
export type ModelRoleBinding = {
  readonly candidateRef: string;
  readonly provider: string;
  readonly model: string;
  readonly effort: string | null;
};

export type ModelRoleView = {
  readonly role: ModelSettingsRole;
  readonly label: string;
  readonly group: ModelRoleGroup;
  readonly current: ModelRoleBinding | null;
  readonly candidates: readonly ModelRoleCandidate[];
  /** 不可用时必须给出原因；界面原样显示，不替宿主判断可行性。 */
  readonly availability: { readonly available: boolean; readonly reason: string | null };
};

/**
 * 载入结果。
 *
 * 快照是应用层的非秘密投影，界面直接消费，不在此再复制一份形状；`failed` 只带结构化 code 与
 * 安全文案，绝不携带凭据或文件载荷。
 */
export type ModelSettingsLoad =
  | { readonly kind: 'loaded'; readonly snapshot: ModelSettingsSnapshotView }
  | { readonly kind: 'failed'; readonly code: string; readonly message: string };

/**
 * 完整连接的非秘密视图。
 *
 * 应用的 ModelSettingsConnectionSummary 只带 label、providerIntegration 与凭据来源，但保存始终
 * **新增**连接，因此编辑既有连接必须能原样带回 codex 连接与凭据的引用与 SDK 字段路径，否则保存
 * 会静默丢掉它们。credentialRef 是 opaque 引用而非 key，因此可以进入界面。
 */
export type ModelSettingsConnectionView = {
  readonly connectionRef: string;
  readonly label: string;
  readonly providerIntegration: string;
  readonly modelOptions: Readonly<Record<string, unknown>>;
  readonly credential:
    | { readonly kind: 'harness_login' }
    | { readonly kind: 'managed'; readonly credentialRef: string; readonly optionPath: string };
  readonly codex: {
    readonly providerId: string;
    readonly baseUrl: string;
    readonly wireApi: 'responses' | 'chat';
  } | null;
};

/**
 * 载入快照。
 *
 * 除了 connections 升级为完整非秘密视图，其余字段全部直接复用应用的 ModelSettingsSnapshot，
 * 因此角色绑定、模型与 Coordinator 候选只有一份形状。
 */
export type ModelSettingsSnapshotView = Omit<ModelSettingsSnapshot, 'connections'> & {
  readonly connections: readonly ModelSettingsConnectionView[];
};

/**
 * 角色显式应用。
 *
 * 这里只提交角色、模型引用、effort 与 CAS 基准：完整连接、选项与凭据引用由宿主从项目配置按
 * `modelRef` 解析，界面无法凭摘要重建它们，因此也不会有机会填错凭据。
 */
export type ModelSettingsApplyInput = {
  readonly role: ModelSettingsRole;
  readonly modelRef: string;
  readonly effort: string | null;
  readonly expectedRevision: number;
};

/**
 * 角色模型配置端口（IP-06）。
 *
 * 三个动作严格分离：`load` 只读非秘密快照，`save` 追加不可变引用且不代表应用，`apply` 只保存
 * 角色 profile 并返回 profileRef；真正的授权替换仍由 `executionAuthorization.review/approve` 走完。
 * Coordinator 的应用复用既有 `switch-model-configuration` 意图，保留挂起与在途操作的原合同。
 *
 * `save` 的输入与结果直接用应用层 `ModelSettingsService` 的类型：编辑器提交完整连接候选
 * （含 codex 连接、凭据引用与 SDK 字段路径、effort 能力来源），不在界面层复制第二份形状。
 */
export type ModelSettingsPort = {
  readonly load: () => Promise<ModelSettingsLoad>;
  readonly save: (input: SaveModelSettingsInput) => Promise<SaveModelSettingsResult>;
  readonly apply: (input: ModelSettingsApplyInput) => Promise<SaveModelSettingsResult>;
};

/**
 * Route Planning Handoff 的意图端口。
 *
 * `prepareProposal` 由宿主从权威来源读好 map/plan revision、Target 与 Capsule 引用后提交一次
 * `planning-handoff: prepare`；界面只触发它并展示结果，不构造这些引用。`targetCoordinatorSessionId`
 * 必须来自用户在选择界面里的明确选择：宿主不会替用户挑一个接收方。
 */
export type HandoffIntentPort = {
  readonly read: (proposalId: string) => Promise<import('../../application/controller-service.js').ControllerPlanningHandoffView | null>;
  readonly prepareProposal: (targetCoordinatorSessionId: string) => Promise<ControllerCommandResult>;
  readonly cutover: (proposalId: string, expectedRevision: number) => Promise<ControllerCommandResult>;
  readonly cancel: (proposalId: string, expectedRevision: number) => Promise<ControllerCommandResult>;
};

/**
 * Execution Handoff 的意图端口（IP-11）。
 *
 * 与 Route Planning Handoff 分开：这里推进的是 `ExecutionHandoffState`，`review` 所需的事实
 * （Scope revision、当前 Graph Generation、Target 生命周期、Source checkpoint 与 Capsule 可移植性）
 * 由宿主从权威来源读好后提交，界面不构造它们，也不复用 `PlanningHandoffProposal`。
 */
export type ExecutionHandoffIntentPort = {
  readonly read: (handoffId: string) => Promise<import('../../application/controller-service.js').ControllerHandoffView | null>;
  readonly prepare: (targetCoordinatorSessionId: string) => Promise<ControllerCommandResult>;
  readonly review: (handoffId: string) => Promise<ControllerCommandResult>;
  readonly cutover: (handoffId: string, expectedRevision: number) => Promise<ControllerCommandResult>;
  readonly cancel: (handoffId: string, expectedRevision: number) => Promise<ControllerCommandResult>;
};
