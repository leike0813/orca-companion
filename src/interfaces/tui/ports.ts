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
};

export type TuiQuestionQuery =
  | { readonly kind: 'pending-interactions'; readonly coordinatorSessionId: string; readonly after?: import('../../application/ports/branch-coordination-store.js').InteractionPageCursor }
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
};

export type ModelConfigurationOption = {
  readonly configurationRef: string;
  readonly model: string;
};

export type ModelCatalogPort = {
  readonly load: () => Promise<ModelCatalog>;
};

/**
 * Route Planning Handoff 的意图端口。
 *
 * `prepareProposal` 由宿主从权威来源读好 map/plan revision、Target 与 Capsule 引用后提交一次
 * `planning-handoff: prepare`；界面只触发它并展示结果，不构造这些引用。`targetCoordinatorSessionId`
 * 必须来自用户在选择界面里的明确选择：宿主不会替用户挑一个接收方。
 */
export type HandoffIntentPort = {
  readonly prepareProposal: (targetCoordinatorSessionId: string) => Promise<ControllerCommandResult>;
  readonly cutover: (proposalId: string) => Promise<ControllerCommandResult>;
  readonly cancel: (proposalId: string) => Promise<ControllerCommandResult>;
};

/**
 * Execution Handoff 的意图端口（IP-11）。
 *
 * 与 Route Planning Handoff 分开：这里推进的是 `ExecutionHandoffState`，`review` 所需的事实
 * （Scope revision、当前 Graph Generation、Target 生命周期、Source checkpoint 与 Capsule 可移植性）
 * 由宿主从权威来源读好后提交，界面不构造它们，也不复用 `PlanningHandoffProposal`。
 */
export type ExecutionHandoffIntentPort = {
  readonly prepare: (targetCoordinatorSessionId: string) => Promise<ControllerCommandResult>;
  readonly review: (handoffId: string) => Promise<ControllerCommandResult>;
  readonly cutover: (handoffId: string) => Promise<ControllerCommandResult>;
  readonly cancel: (handoffId: string) => Promise<ControllerCommandResult>;
};
