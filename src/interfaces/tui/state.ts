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
import { emptyDraft, textDraft } from './input/composer-editor.js';
import { tuiIconMode, type TuiIconMode } from './theme.js';

export type ProjectPanelState = { readonly open: boolean; readonly tab: number; readonly selectedKey: string | null; readonly detail: string | null; readonly scroll: number };

export type SidebarDensity = 'full' | 'compact' | 'collapsed';
export type OverlayKind =
  | 'command-palette'
  | 'options'
  | 'graph-inspector'
  | 'session-picker'
  | 'handoff-target'
  | 'event-drawer'
  | 'model-picker'
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

/** `legacy-review` 是 Home 之上的旧记录迁移确认屏：未确认前不进入任何 Scope。 */
export type TuiScreen = 'home' | 'wizard' | 'legacy-review' | 'workspace';

export type TuiState = {
  readonly handoffCommand: 'handoff' | 'execution-handoff';
  readonly projectPanel: ProjectPanelState;
  readonly iconMode: TuiIconMode;
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
  /** 执行图过滤（展示态）：只隐藏节点。 */
  readonly executionFilter: ExecutionFilter;
  /** 正在审阅的 Execution Handoff 记录；`null` 表示没有。 */
  readonly executionHandoffReviewId: string | null;
};

export const initialTuiState: TuiState = {
  handoffCommand: 'handoff',
  projectPanel: { open: false, tab: 0, selectedKey: null, detail: null, scroll: 0 },
  iconMode: tuiIconMode,
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
  executionFilter: [],
  executionHandoffReviewId: null,
};

export type TuiAction =
  | { readonly kind: 'transcript-details'; readonly detailed: boolean; readonly expanded?: readonly string[] }
  | { readonly kind: 'handoff-target'; readonly command: 'handoff' | 'execution-handoff' }
  | { readonly kind: 'project-panel'; readonly panel: ProjectPanelState }
  | { readonly kind: 'icons'; readonly mode: TuiIconMode }
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
  | { readonly kind: 'answer-mode-entered'; readonly interactionId: string; readonly expectedRevision: number }
  | { readonly kind: 'composer-mode-reset' }
  | { readonly kind: 'tool-toggled'; readonly entryId: string }
  | { readonly kind: 'inspector-selected'; readonly workPackageId: string }
  | { readonly kind: 'notice'; readonly notice: string | null }
  | { readonly kind: 'attention-cleared' }
  | { readonly kind: 'session-read-only'; readonly coordinatorSessionId: string }
  | { readonly kind: 'confirmation-requested'; readonly pending: Exclude<PendingConfirmation, null> }
  | { readonly kind: 'confirmation-dismissed' }
  | { readonly kind: 'execution-filter-changed'; readonly filter: ExecutionFilter }
  | { readonly kind: 'execution-handoff-review'; readonly handoffId: string | null };

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
    case 'slash-view': return { ...state, slashIndex: action.index, slashDismissed: action.dismissed };
    case 'review-view': return { ...state, reviewTab: action.tab ?? state.reviewTab, reviewScroll: action.scroll ?? state.reviewScroll, reviewAction: action.action ?? state.reviewAction };
    case 'inspector-view': return { ...state, inspectorDetail: action.detail ?? state.inspectorDetail, inspectorTab: action.tab ?? state.inspectorTab, inspectorScroll: action.scroll ?? state.inspectorScroll, inspectorRelations: action.relations === undefined ? state.inspectorRelations : action.relations, relationIndex: action.relationIndex ?? state.relationIndex };
    case 'screen':
      return { ...state, screen: action.screen };
    case 'overlay-open':
      return { ...state, overlayStack: [...state.overlayStack, action.overlay] };
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
        composerMode: {
          kind: 'answer',
          interactionId: action.interactionId,
          expectedRevision: action.expectedRevision,
        },
      };
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
      return { ...state, pendingConfirmation: action.pending, reviewTab: 0, reviewScroll: 0, reviewAction: 0 };
    case 'confirmation-dismissed':
      return state.pendingConfirmation === null ? state : { ...state, pendingConfirmation: null };
    case 'execution-filter-changed':
      return { ...state, executionFilter: action.filter };
    case 'execution-handoff-review':
      return { ...state, executionHandoffReviewId: action.handoffId };
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
