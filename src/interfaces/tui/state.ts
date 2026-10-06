/**
 * MOD-06：进程内展示态与纯 reducer（Owner: `m2-deliver-planning-tui`）。
 *
 * 这里保存的全是**展示态**：当前屏幕、overlay 栈、Sidebar 密度、选中 Session、每 Session 草稿与
 * 滚动位置、未读标记、工具记录展开集合与 inspector 选择。没有任何业务事实：Scope 状态、图、Worker、
 * Pending Interaction 都来自 IC-11 快照与语义事件。
 *
 * reducer 是纯函数，因此「render/effect/resize/re-mount 不产生业务副作用」是结构性的：这里能表达的
 * 动作只有展示态变化，没有派发、恢复、重试或写入。
 */

import type { WorkPackageExecutionState } from '../../application/execution/execution-view.js';
import type { UiDraft } from '../../application/ports/ui-input-store.js';
import type { BasisSourceRef, GraphVersionRef } from '../../application/tui/graph-basis.js';
import { emptyDraft, textDraft } from './input/composer-editor.js';
import { tuiIconMode, type TuiIconMode } from './theme.js';

export type ProjectPanelState = { readonly open: boolean; readonly tab: number; readonly selectedKey: string | null; readonly detail: string | null; readonly scroll: number };

/* -------------------------------------------------------------------------- */
/* 图历史与执行依据（IP-04）                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 依据下钻的来源页面。
 *
 * 回到 Inspector 时不恢复任何字段：Inspector 的选择、栏目与滚动本来就留在 `inspector*` 里，
 * 因此这里只记「从哪来」；从项目面板进入才需要原栏目、对象与滚动位置。
 */
export type BasisOrigin =
  | { readonly kind: 'inspector' }
  | {
      readonly kind: 'project';
      readonly tab: number;
      readonly detail: string | null;
      readonly selectedKey: string | null;
      readonly scroll: number;
    };

/**
 * 一层依据页面。
 *
 * 每层只保存展示态：光标、翻页游标与已访问的正文偏移。图版本、来源引用与正文偏移都是**精确身份**，
 * 因此返回、续读和迟到隔离都不依赖 Scope revision。
 */
export type BasisFrame =
  | { readonly kind: 'root'; readonly index: number }
  | { readonly kind: 'versions'; readonly index: number; readonly after: string | null; readonly previous: readonly (string | null)[] }
  | {
      readonly kind: 'version';
      readonly ref: GraphVersionRef;
      readonly selection: string | null;
      /** 历史版本沿用 Inspector 的三栏目与显式关系选择。 */
      readonly tab: number;
      readonly relations: readonly string[] | null;
      readonly relationIndex: number;
    }
  | {
      readonly kind: 'sources';
      readonly graph: GraphVersionRef;
      readonly workPackageId: string | null;
      /** 原生规格目录帧：下钻到某个保留 Task 的真实文件目录，其余帧没有这个身份。 */
      readonly orcaTaskId?: string;
      readonly index: number;
      readonly after: string | null;
      readonly previous: readonly (string | null)[];
    }
  | {
      readonly kind: 'body';
      readonly source: BasisSourceRef;
      readonly label: string;
      readonly sourceVersion: string | null;
      readonly offset: number;
      /** 已访问的正文偏移；PgUp 只能回到真正读过的范围，不猜更早的游标。 */
      readonly visited: readonly number[];
      readonly scroll: number;
    };

export type BasisState = { readonly origin: BasisOrigin; readonly frames: readonly BasisFrame[] };

export const BASIS_ROOT_FRAME: BasisFrame = { kind: 'root', index: 0 };

/** 来源引用的稳定身份：Task、原生 unit 的具体文件、授权版本与 tracker 引用各自一把 key。 */
export function basisSourceKey(source: BasisSourceRef): string {
  switch (source.kind) {
    case 'initial_plan':
    case 'graph_patch':
      return `${source.kind}:${source.graph.graphId}:${source.graph.generation}:${source.graph.version}`;
    case 'authorization':
      return `authorization:${source.authorizationId}@${source.authorizationVersion}`;
    case 'retained_task':
      return `retained_task:${source.workPackageId}:${source.orcaTaskId}`;
    case 'specification':
      // 同一 unit 的不同文件必须分开：缓存与读取身份都包含 path，否则两个文件会互相覆盖。
      return `specification:${source.orcaTaskId}:${source.locator.worktreeId}:${source.locator.relativePath}:${source.path}:${source.contractRevision}`;
    case 'tracker':
      return `tracker:${source.issueRef}`;
  }
}

export function basisStack(origin: BasisOrigin): BasisState {
  return { origin, frames: [BASIS_ROOT_FRAME] };
}

export function basisTop(stack: BasisState): BasisFrame {
  return stack.frames.at(-1) ?? BASIS_ROOT_FRAME;
}

/** 下钻一层；调用方只追加已经确定身份的页面，不改写下层。 */
export function basisEnter(stack: BasisState, frame: BasisFrame): BasisState {
  return { ...stack, frames: [...stack.frames, frame] };
}

/** 替换栈顶的展示态（光标、翻页、偏移）；页面身份不变。 */
export function basisReplaceTop(stack: BasisState, frame: BasisFrame): BasisState {
  return { ...stack, frames: [...stack.frames.slice(0, -1), frame] };
}

/** Esc 的逐层返回：弹出栈顶；连根页面一起弹出时返回 `null`，表示回到来源页面。 */
export function basisBack(stack: BasisState): BasisState | null {
  return stack.frames.length <= 1 ? null : { ...stack, frames: stack.frames.slice(0, -1) };
}

/**
 * 页面的读取身份。
 *
 * 迟到的读取结果只能写回自己那一页：Session 相同但 key 不同的响应必须被丢弃，因此 key 同时包含
 * 层级、精确图版本/来源引用与翻页游标。
 */
export function basisFrameKey(frame: BasisFrame): string {
  switch (frame.kind) {
    case 'root': return 'root';
    case 'versions': return `versions:${frame.after ?? ''}`;
    case 'version': return `version:${frame.ref.graphId}:${frame.ref.generation}:${frame.ref.version}`;
    case 'sources': return `sources:${frame.graph.graphId}:${frame.graph.generation}:${frame.graph.version}:${frame.workPackageId ?? '*'}:${frame.orcaTaskId ?? '*'}:${frame.after ?? ''}`;
    case 'body': return `body:${basisSourceKey(frame.source)}:${frame.sourceVersion ?? '-'}:${frame.offset}`;
  }
}

export type SidebarDensity = 'full' | 'compact' | 'collapsed';
export type OverlayKind =
  | 'help'
  | 'command-palette'
  | 'options'
  | 'statusline-settings'
  /** 执行并发默认额度编辑：保存只改项目默认值，不影响当前批准额度。 */
  | 'execution-settings'
  | 'graph-inspector'
  | 'session-picker'
  | 'handoff-target'
  | 'event-drawer'
  | 'model-picker'
  /** 角色模型菜单：provider/model 候选 + 独立水平 effort + 默认返回动作。 */
  | 'model-role-menu'
  /** 角色连接编辑：同一弹窗框内的内存字段，key 只显示遮罩。 */
  | 'model-settings-editor'
  | 'handoff-review'
  /** 执行阶段交接复用同一交互，但主题与记录是 `ExecutionHandoffState`。 */
  | 'execution-handoff-review'
  /** 规划 → 执行的完整 Manifest 审阅；只读展示 + 一次显式批准。 */
  | 'authorization-review'
  /** 有界输入记录管理：查看、恢复、核验与删除草稿/冲突副本/待核验提交。 */
  | 'input-record-manager'
  | 'paste-viewer';

/** 等待用户确认的动作（IP-05、IP-06）；`null` 表示没有待确认动作。 */
export type PendingConfirmation =
  | { readonly kind: 'cancel' }
  | { readonly kind: 'exit' }
  /** 退出前保存失败：只有再次明确确认后才丢弃未保存输入并退出。 */
  | { readonly kind: 'exit-discard' }
  | null;

/** 执行图过滤条件（状态集合）；空集合表示不过滤。 */
export type ExecutionFilter = readonly WorkPackageExecutionState[];

/**
 * 过滤预设。
 *
 * 过滤只隐藏节点，不改变顺序或位置；预设是展示态，不是业务状态。
 */
export const EXECUTION_FILTER_PRESETS = [
  { label: '全部', states: [] },
  { label: 'attention', states: ['blocked', 'unknown'] },
  {
    label: '进行中',
    states: ['admitting', 'specifying', 'implementing', 'validating', 'repairing', 'reconciling'],
  },
  { label: '待集成', states: ['waiting_integration'] },
] as const satisfies readonly { label: string; states: ExecutionFilter }[];

/** 轮换到下一个过滤预设；用于 Command Palette 的单一入口。 */
export function nextExecutionFilter(current: ExecutionFilter): ExecutionFilter {
  const index = EXECUTION_FILTER_PRESETS.findIndex(
    (preset) =>
      preset.states.length === current.length &&
      preset.states.every((state) => current.includes(state)),
  );
  const next = EXECUTION_FILTER_PRESETS[(index + 1) % EXECUTION_FILTER_PRESETS.length];
  return next?.states ?? [];
}

/** 当前过滤条件的可读标签。 */
export function executionFilterLabel(filter: ExecutionFilter): string {
  const preset = EXECUTION_FILTER_PRESETS.find(
    (entry) => entry.states.length === filter.length && entry.states.every((state) => filter.includes(state)),
  );
  if (preset !== undefined) {
    return preset.label;
  }
  return filter.length === 0 ? '全部' : filter.join(',');
}

/** composer 的两种严格分离模式；Answer 模式绑定 interaction ID 与 expected revision。 */
export type ComposerMode =
  | { readonly kind: 'message' }
  | { readonly kind: 'answer'; readonly interactionId: string; readonly expectedRevision: number };

/**
 * 角色模型菜单的内存选择态（IP-06）。
 *
 * 三块区域按定稿顺序循环：候选列表 → 独立 effort → 动作。`action` 的 0 永远是返回，因此 Esc 与默认
 * 确认都不会改变任何绑定。
 */
export type ModelRoleMenuState = {
  readonly role: import('./ports.js').ModelSettingsRole;
  readonly selectedCandidateRef: string | null;
  readonly focus: 'list' | 'effort' | 'actions';
  readonly action: number;
  /** 候选自带可信能力来源时才可能有值；没有来源时恒为 `null`。 */
  readonly effort: string | null;
};

/**
 * 角色连接编辑的内存字段（IP-06）。
 *
 * 整个结构只存在于进程内内存：它不进入 IC-13 的 `UiDraft`、草稿存储或提交记录，因此 `secret`
 * 不会随输入恢复、resize 或重挂载落盘。渲染时始终以遮罩显示，错误与日志也只带 code 和安全文案。
 *
 * 字段覆盖完整的 provider 连接：codex 连接、凭据来源与 SDK 字段路径，以及 effort 的可信能力来源。
 * `credentialRef` 是 opaque 引用而非 key，保存时原样带回，因此不提供编辑入口。
 *
 * `harness` 与三个 `native*` 字段是**附加**的：缺省即按 codex 连接处理，旧夹具与旧行为因此保持不变。
 * 只有 Worker 角色在 codex 之外显式选择 harness 时才提供原生连接字段；Coordinator 始终用 LangChain。
 */
export type ModelSettingsEdit = {
  readonly role: import('./ports.js').ModelSettingsRole;
  readonly label: string;
  readonly providerIntegration: string;
  readonly model: string;
  /** 非秘密选项，逐行 `key = value`；保存时按行解析。 */
  readonly options: string;
  /** Worker harness；空串或缺失表示沿用现有 profile、按 codex 处理。 */
  readonly harness?: string;
  readonly codexProviderId: string;
  readonly codexBaseUrl: string;
  /** 空串表示该连接不配置 codex 连接。 */
  readonly codexWireApi: '' | 'responses' | 'chat';
  /** 原生连接的 providerId；非 codex harness 必填。 */
  readonly nativeProviderId?: string;
  /** 原生连接的 baseUrl；managed 凭据必填，harness_login 可缺省。 */
  readonly nativeBaseUrl?: string;
  /** 原生连接的接口族；managed 必填，取值来自 `NATIVE_WORKER_APIS`。 */
  readonly nativeApi?: string;
  readonly credentialKind: 'harness_login' | 'managed';
  readonly credentialRef: string;
  readonly credentialOptionPath: string;
  /** 三者全空表示无可信来源；全非空才构成可保存的 effort 能力。 */
  readonly effortSource: string;
  readonly effortValues: string;
  readonly effortOptionPath: string;
  readonly secret: string;
};

/** 编辑器字段顺序；Enter 提交保存，Esc 逐层返回并保留已输入内容。 */
export const MODEL_SETTINGS_FIELDS = [
  'label',
  'providerIntegration',
  'model',
  'options',
  'harness',
  'codexProviderId',
  'codexBaseUrl',
  'codexWireApi',
  'nativeProviderId',
  'nativeBaseUrl',
  'nativeApi',
  'credentialKind',
  'credentialOptionPath',
  'effortSource',
  'effortValues',
  'effortOptionPath',
  'secret',
] as const satisfies readonly (keyof ModelSettingsEdit)[];
export type ModelSettingsField = (typeof MODEL_SETTINGS_FIELDS)[number];

/** overlay 刚打开、快照尚未返回时的空编辑；不含任何秘密。 */
export const EMPTY_MODEL_SETTINGS_EDIT: ModelSettingsEdit = {
  role: 'coordinator',
  label: '',
  providerIntegration: '',
  model: '',
  options: '',
  harness: '',
  codexProviderId: '',
  codexBaseUrl: '',
  codexWireApi: '',
  nativeProviderId: '',
  nativeBaseUrl: '',
  nativeApi: '',
  credentialKind: 'harness_login',
  credentialRef: '',
  credentialOptionPath: '',
  effortSource: '',
  effortValues: '',
  effortOptionPath: '',
  secret: '',
};

/** `legacy-review` 是 Home 之上的旧记录迁移确认屏：未确认前不进入任何 Scope。 */
export type TuiScreen = 'home' | 'wizard' | 'legacy-review' | 'workspace';

export type TuiState = {
  readonly dialogSelections: Readonly<Partial<Record<OverlayKind, { readonly query: UiDraft; readonly selectedId: string | null }>>>;
  readonly handoffCommand: 'handoff' | 'execution-handoff';
  readonly projectPanel: ProjectPanelState;
  readonly iconMode: TuiIconMode;
  readonly iconModeUnsaved: boolean;
  readonly preferencesRevision: number;
  readonly inspectorTab: number;
  readonly inspectorDetail: boolean;
  readonly inspectorScroll: number;
  readonly inspectorRelations: readonly string[] | null;
  readonly relationIndex: number;
  readonly reviewTab: number;
  readonly reviewScroll: number;
  readonly reviewAction: number;
  readonly slashIndex: number;
  readonly slashDismissed: boolean;
  readonly screen: TuiScreen;
  readonly overlayStack: readonly OverlayKind[];
  readonly sidebarDensity: SidebarDensity;
  readonly selectedSessionId: string | null;
  readonly drafts: Readonly<Record<string, UiDraft>>;
  /** 回答草稿：按 interaction ID 与 expected revision 隔离，永不自动改绑。 */
  readonly answerDrafts: Readonly<Record<string, UiDraft>>;
  /** 已批准原型夹具的演示位置；生产 App 使用来源锚点。 */
  readonly scrollOffsets: Readonly<Record<string, number>>;
  readonly readingAnchors: Readonly<Record<string, import('./render/transcript-reader.js').TranscriptAnchor | null>>;
  readonly unreadSessionIds: readonly string[];
  readonly composerMode: ComposerMode;
  readonly expandedToolIds: readonly string[];
  readonly detailedTranscript: boolean;
  readonly inspectorSelection: string | null;
  readonly notice: string | null;
  readonly attention: boolean;
  /** Handoff cutover 后 Source transcript 只读。 */
  readonly readOnlySessionIds: readonly string[];
  /** 等待确认的动作；危险态下的 Cancel 与 Exit 需要它，Pause 从不使用它。 */
  readonly pendingConfirmation: PendingConfirmation;
  readonly confirmationFrames: readonly {readonly pendingConfirmation:PendingConfirmation;readonly reviewTab:number;readonly reviewScroll:number;readonly reviewAction:number}[];
  /** 执行图过滤（展示态）：只隐藏节点。 */
  readonly executionFilter: ExecutionFilter;
  /** 正在审阅的 Execution Handoff 记录；`null` 表示没有。 */
  readonly executionHandoffReviewId: string | null;
  /** 角色模型列表的高亮下标；`model-picker` overlay 独占。 */
  readonly modelRoleIndex: number;
  /** 角色模型菜单的选择态；`null` 表示 overlay 未打开。 */
  readonly modelRoleMenu: ModelRoleMenuState | null;
  /** 角色连接编辑的内存字段；`null` 表示 overlay 未打开。 */
  readonly modelSettingsEdit: ModelSettingsEdit | null;
  /** 编辑器当前字段；用字段身份而不是下标，隐藏字段才不会让光标指向不存在的行。 */
  readonly modelSettingsField: ModelSettingsField;
  /** 保存/应用的结构化结果；失败时编辑器保留全部输入。 */
  readonly modelSettingsNotice: string | null;
  /** 依据下钻栈；`null` 表示没有打开依据或历史页面。 */
  readonly basis: BasisState | null;
};

export const initialTuiState: TuiState = {
  dialogSelections: {},
  handoffCommand: 'handoff',
  projectPanel: { open: false, tab: 0, selectedKey: null, detail: null, scroll: 0 },
  iconMode: tuiIconMode,
  iconModeUnsaved: false,
  preferencesRevision: 0,
  inspectorTab: 0,
  inspectorDetail: false,
  inspectorScroll: 0,
  inspectorRelations: null,
  relationIndex: 0,
  reviewTab: 0,
  reviewScroll: 0,
  reviewAction: 0,
  slashIndex: 0,
  slashDismissed: false,
  screen: 'home',
  overlayStack: [],
  sidebarDensity: 'full',
  selectedSessionId: null,
  drafts: {},
  answerDrafts: {},
  scrollOffsets: {},
  readingAnchors: {},
  unreadSessionIds: [],
  composerMode: { kind: 'message' },
  expandedToolIds: [],
  detailedTranscript: false,
  inspectorSelection: null,
  notice: null,
  attention: false,
  readOnlySessionIds: [],
  pendingConfirmation: null,
  confirmationFrames:[],
  executionFilter: [],
  executionHandoffReviewId: null,
  modelRoleIndex: 0,
  modelRoleMenu: null,
  modelSettingsEdit: null,
  modelSettingsField: 'label',
  modelSettingsNotice: null,
  basis: null,
};

export type AnswerReturnState = Pick<TuiState, 'selectedSessionId' | 'composerMode' | 'projectPanel' | 'expandedToolIds' | 'detailedTranscript'> & {
  readonly anchor: import('./render/transcript-reader.js').TranscriptAnchor | null;
};

export type TuiAction =
  | { readonly kind: 'dialog-selection'; readonly overlay: OverlayKind; readonly query: UiDraft; readonly selectedId: string | null }
  | { readonly kind: 'transcript-details'; readonly detailed: boolean; readonly expanded?: readonly string[] }
  | { readonly kind: 'handoff-target'; readonly command: 'handoff' | 'execution-handoff' }
  | { readonly kind: 'project-panel'; readonly panel: ProjectPanelState }
  | { readonly kind: 'icons'; readonly mode: TuiIconMode }
  | { readonly kind: 'icons-unsaved'; readonly unsaved: boolean }
  | { readonly kind: 'preferences-revision'; readonly revision: number }
  | { readonly kind: 'inspector-view'; readonly tab?: number; readonly detail?: boolean; readonly scroll?: number; readonly relations?: readonly string[] | null; readonly relationIndex?: number }
  | { readonly kind: 'review-view'; readonly tab?: number; readonly scroll?: number; readonly action?: number }
  | { readonly kind: 'slash-view'; readonly index: number; readonly dismissed: boolean }
  | { readonly kind: 'screen'; readonly screen: TuiScreen }
  | { readonly kind: 'overlay-open'; readonly overlay: OverlayKind }
  | { readonly kind: 'overlay-close-top' }
  | { readonly kind: 'overlay-close-all' }
  | { readonly kind: 'sidebar-toggle'; readonly allowed: SidebarDensity }
  | { readonly kind: 'sidebar-resized'; readonly allowed: SidebarDensity }
  | { readonly kind: 'session-selected'; readonly coordinatorSessionId: string }
  | { readonly kind: 'sessions-loaded'; readonly coordinatorSessionIds: readonly string[]; readonly preferred: string | null }
  | { readonly kind: 'draft-changed'; readonly coordinatorSessionId: string; readonly text?: string; readonly draft?: UiDraft }
  | { readonly kind: 'answer-draft-changed'; readonly answerKey: string; readonly text?: string; readonly draft?: UiDraft }
  | { readonly kind: 'scroll-changed'; readonly coordinatorSessionId: string; readonly offset: number }
  | { readonly kind: 'reading-anchor'; readonly coordinatorSessionId: string; readonly anchor: import('./render/transcript-reader.js').TranscriptAnchor | null }
  | { readonly kind: 'events-arrived'; readonly coordinatorSessionIds: readonly (string | null)[] }
  | { readonly kind: 'answer-mode-entered'; readonly interactionId: string; readonly expectedRevision: number; readonly coordinatorSessionId?: string; readonly closeProject?: boolean }
  | { readonly kind: 'answer-returned'; readonly origin: AnswerReturnState }
  | { readonly kind: 'composer-mode-reset' }
  | { readonly kind: 'tool-toggled'; readonly entryId: string }
  | { readonly kind: 'inspector-selected'; readonly workPackageId: string }
  | { readonly kind: 'notice'; readonly notice: string | null }
  | { readonly kind: 'attention-cleared' }
  | { readonly kind: 'session-read-only'; readonly coordinatorSessionId: string }
  | { readonly kind: 'confirmation-requested'; readonly pending: Exclude<PendingConfirmation, null> }
  | { readonly kind: 'confirmation-dismissed' }
  | { readonly kind: 'execution-filter-changed'; readonly filter: ExecutionFilter }
  | { readonly kind: 'execution-handoff-review'; readonly handoffId: string | null }
  | { readonly kind: 'model-role-selected'; readonly index: number }
  | { readonly kind: 'model-role-menu'; readonly menu: ModelRoleMenuState | null }
  | { readonly kind: 'model-settings-edit'; readonly edit: ModelSettingsEdit | null; readonly field?: ModelSettingsField }
  | { readonly kind: 'model-settings-notice'; readonly notice: string | null }
  /** 依据下钻栈；`frames` 为 `null` 或空表示关闭并回到来源页面。 */
  | { readonly kind: 'basis-frames'; readonly frames: readonly BasisFrame[] | null; readonly origin?: BasisOrigin };

/** 密度只允许在「宽度允许的上限」之内降级；任何动作都不会强制展开。 */
function clampDensity(current: SidebarDensity, allowed: SidebarDensity): SidebarDensity {
  const order: readonly SidebarDensity[] = ['collapsed', 'compact', 'full'];
  return order.indexOf(current) <= order.indexOf(allowed) ? current : allowed;
}

export function reduceTuiState(state: TuiState, action: TuiAction): TuiState {
  switch (action.kind) {
    case 'transcript-details': return { ...state, detailedTranscript: action.detailed, expandedToolIds: action.expanded === undefined ? state.expandedToolIds : boundedExpansions(action.expanded) };
    case 'handoff-target': return { ...state, handoffCommand: action.command };
    case 'project-panel': return { ...state, projectPanel: action.panel };
    case 'icons': return { ...state, iconMode: action.mode };
    case 'icons-unsaved': return { ...state, iconModeUnsaved: action.unsaved };
    case 'preferences-revision': return { ...state, preferencesRevision: action.revision };
    case 'slash-view': return { ...state, slashIndex: action.index, slashDismissed: action.dismissed };
    case 'review-view': return { ...state, reviewTab: action.tab ?? state.reviewTab, reviewScroll: action.scroll ?? state.reviewScroll, reviewAction: action.action ?? state.reviewAction };
    case 'inspector-view': return { ...state, inspectorDetail: action.detail ?? state.inspectorDetail, inspectorTab: action.tab ?? state.inspectorTab, inspectorScroll: action.scroll ?? state.inspectorScroll, inspectorRelations: action.relations === undefined ? state.inspectorRelations : action.relations, relationIndex: action.relationIndex ?? state.relationIndex };
    case 'screen':
      return { ...state, screen: action.screen };
    case 'overlay-open':
      return state.overlayStack.at(-1) === action.overlay ? state : { ...state, overlayStack: [...state.overlayStack, action.overlay] };
    case 'dialog-selection':
      return { ...state, dialogSelections: { ...state.dialogSelections, [action.overlay]: { query: action.query, selectedId: action.selectedId } } };
    case 'overlay-close-top':
      return { ...state, overlayStack: state.overlayStack.slice(0, -1) };
    case 'overlay-close-all':
      return { ...state, overlayStack: [] };
    case 'sidebar-toggle': {
      const next: SidebarDensity = state.sidebarDensity === 'collapsed' ? 'compact' : 'collapsed';
      return { ...state, sidebarDensity: clampDensity(next, action.allowed) };
    }
    case 'sidebar-resized':
      return { ...state, sidebarDensity: clampDensity(state.sidebarDensity, action.allowed) };
    case 'session-selected':
      return {
        ...state,
        selectedSessionId: action.coordinatorSessionId,
        composerMode: { kind: 'message' },
        unreadSessionIds: state.unreadSessionIds.filter(
          (id) => id !== action.coordinatorSessionId,
        ),
      };
    case 'sessions-loaded': {
      if (state.selectedSessionId !== null) {
        return state;
      }
      return { ...state, selectedSessionId: action.preferred };
    }
    case 'draft-changed':
      return {
        ...state,
        drafts: { ...state.drafts, [action.coordinatorSessionId]: action.draft ?? textDraft(action.text ?? '') },
      };
    case 'answer-draft-changed':
      return {
        ...state,
        answerDrafts: { ...state.answerDrafts, [action.answerKey]: action.draft ?? textDraft(action.text ?? '') },
      };
    case 'reading-anchor':
      return { ...state, readingAnchors: { ...state.readingAnchors, [action.coordinatorSessionId]: action.anchor } };
    case 'scroll-changed':
      return {
        ...state,
        scrollOffsets: { ...state.scrollOffsets, [action.coordinatorSessionId]: action.offset },
      };
    case 'events-arrived': {
      // 一批事件只更新一次展示态，不切换 transcript/composer，也不动 Scope 级图。
      const unread = new Set(state.unreadSessionIds);
      for (const id of action.coordinatorSessionIds) {
        if (id !== null && id !== state.selectedSessionId) {
          unread.add(id);
        }
      }
      if (unread.size === state.unreadSessionIds.length && state.attention) {
        return state;
      }
      return {
        ...state,
        unreadSessionIds: [...unread],
        attention: true,
      };
    }
    case 'answer-mode-entered':
      return {
        ...state,
        ...(action.coordinatorSessionId === undefined ? {} : { selectedSessionId: action.coordinatorSessionId }),
        ...(action.closeProject ? { projectPanel: { ...state.projectPanel, open: false } } : {}),
        composerMode: {
          kind: 'answer',
          interactionId: action.interactionId,
          expectedRevision: action.expectedRevision,
        },
      };
    case 'answer-returned': {
      const { anchor, ...origin } = action.origin;
      return { ...state, ...origin, readingAnchors: origin.selectedSessionId === null ? state.readingAnchors : { ...state.readingAnchors, [origin.selectedSessionId]: anchor } };
    }
    case 'composer-mode-reset':
      return { ...state, composerMode: { kind: 'message' } };
    case 'tool-toggled':
      return {
        ...state,
        expandedToolIds: state.expandedToolIds.includes(action.entryId)
          ? state.expandedToolIds.filter((id) => id !== action.entryId)
          : boundedExpansions([...state.expandedToolIds, action.entryId]),
      };
    case 'inspector-selected':
      return { ...state, inspectorSelection: action.workPackageId, inspectorScroll: 0 };
    case 'notice':
      return { ...state, notice: action.notice };
    case 'attention-cleared':
      return { ...state, attention: false };
    case 'session-read-only':
      return state.readOnlySessionIds.includes(action.coordinatorSessionId)
        ? state
        : { ...state, readOnlySessionIds: [...state.readOnlySessionIds, action.coordinatorSessionId] };
    case 'confirmation-requested':
      return state.pendingConfirmation?.kind===action.pending.kind?state:{ ...state, confirmationFrames:[...state.confirmationFrames,{pendingConfirmation:state.pendingConfirmation,reviewTab:state.reviewTab,reviewScroll:state.reviewScroll,reviewAction:state.reviewAction}],pendingConfirmation: action.pending, reviewTab: 0, reviewScroll: 0, reviewAction: 0 };
    case 'confirmation-dismissed':
      return state.pendingConfirmation === null ? state : { ...state,pendingConfirmation:null,...state.confirmationFrames.at(-1),confirmationFrames:state.confirmationFrames.slice(0,-1) };
    case 'execution-filter-changed':
      return { ...state, executionFilter: action.filter };
    case 'execution-handoff-review':
      return { ...state, executionHandoffReviewId: action.handoffId };
    case 'model-role-selected':
      return { ...state, modelRoleIndex: action.index };
    case 'model-role-menu':
      return { ...state, modelRoleMenu: action.menu, modelSettingsNotice: action.menu === null ? null : state.modelSettingsNotice };
    case 'model-settings-edit':
      return {
        ...state,
        modelSettingsEdit: action.edit,
        modelSettingsField: action.field ?? (action.edit === null ? 'label' : state.modelSettingsField),
        modelSettingsNotice: action.edit === null ? null : state.modelSettingsNotice,
      };
    case 'model-settings-notice':
      return state.modelSettingsNotice === action.notice ? state : { ...state, modelSettingsNotice: action.notice };
    // 依据栈只有展示态：reducer 不知道任何图版本、来源引用或正文内容，因此下钻、翻页与返回
    // 在结构上就不可能写入协调事实。`origin` 缺席时沿用当前来源页面。
    case 'basis-frames': {
      if (action.frames === null || action.frames.length === 0) return { ...state, basis: null };
      return { ...state, basis: { origin: action.origin ?? state.basis?.origin ?? { kind: 'inspector' }, frames: action.frames } };
    }
  }
}

function boundedExpansions(ids: readonly string[]): readonly string[] {
  const retained: string[] = []; let bytes = 0;
  for (const id of [...ids].reverse()) {
    const size = id.length * 2 + 64;
    if (retained.length >= 64 || bytes + size > 256 * 1024) break;
    retained.unshift(id); bytes += size;
  }
  return retained;
}

/** 当前 Session 的 composer 文本；没有草稿时为空串。 */
export function draftFor(state: TuiState, coordinatorSessionId: string | null): string {
  if (coordinatorSessionId === null) {
    return '';
  }
  return state.drafts[coordinatorSessionId]?.text ?? '';
}

/**
 * 回答草稿的隔离 key。
 *
 * 按 Session、InteractionId 与 expected revision 三元组隔离：交互的 owner 可能转移，同 ID/rev 的
 * 旧回答草稿因此不会投影到新 Session 上。
 */
export function answerDraftKey(
  coordinatorSessionId: string,
  interactionId: string,
  expectedRevision: number,
): string {
  return JSON.stringify([coordinatorSessionId, interactionId, expectedRevision]);
}

/** composer 当前应显示的文本；回答模式下读回答草稿，普通模式读 Session 草稿。 */
export function composerDraftFor(state: TuiState, coordinatorSessionId: string | null): string {
  return composerInputFor(state, coordinatorSessionId).text;
}

export function composerInputFor(state: TuiState, coordinatorSessionId: string | null): UiDraft {
  if (state.composerMode.kind === 'answer') {
    if (coordinatorSessionId === null) {
      return emptyDraft();
    }
    const key = answerDraftKey(
      coordinatorSessionId,
      state.composerMode.interactionId,
      state.composerMode.expectedRevision,
    );
    return state.answerDrafts[key] ?? emptyDraft();
  }
  return coordinatorSessionId === null ? emptyDraft() : state.drafts[coordinatorSessionId] ?? emptyDraft();
}

/** 是否允许该 Session 提交普通消息：只读 transcript 与 composer 模式无关，仅由只读集合决定。 */
export function isComposerReadOnly(state: TuiState, coordinatorSessionId: string | null): boolean {
  return coordinatorSessionId !== null && state.readOnlySessionIds.includes(coordinatorSessionId);
}
