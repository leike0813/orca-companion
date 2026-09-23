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

export type SidebarDensity = 'full' | 'compact' | 'collapsed';

export type OverlayKind =
  | 'command-palette'
  | 'graph-inspector'
  | 'session-picker'
  | 'event-drawer'
  | 'model-picker'
  | 'handoff-review';

/** composer 的两种严格分离模式；Answer 模式绑定 interaction ID 与 expected revision。 */
export type ComposerMode =
  | { readonly kind: 'message' }
  | { readonly kind: 'answer'; readonly interactionId: string; readonly expectedRevision: number };

export type TuiScreen = 'home' | 'wizard' | 'workspace';

export type TuiState = {
  readonly screen: TuiScreen;
  readonly overlayStack: readonly OverlayKind[];
  readonly sidebarDensity: SidebarDensity;
  readonly selectedSessionId: string | null;
  readonly drafts: Readonly<Record<string, string>>;
  readonly scrollOffsets: Readonly<Record<string, number>>;
  readonly unreadSessionIds: readonly string[];
  readonly composerMode: ComposerMode;
  readonly expandedToolIds: readonly string[];
  readonly inspectorSelection: string | null;
  readonly notice: string | null;
  readonly attention: boolean;
  /** Handoff cutover 后 Source transcript 只读。 */
  readonly readOnlySessionIds: readonly string[];
};

export const initialTuiState: TuiState = {
  screen: 'home',
  overlayStack: [],
  sidebarDensity: 'full',
  selectedSessionId: null,
  drafts: {},
  scrollOffsets: {},
  unreadSessionIds: [],
  composerMode: { kind: 'message' },
  expandedToolIds: [],
  inspectorSelection: null,
  notice: null,
  attention: false,
  readOnlySessionIds: [],
};

export type TuiAction =
  | { readonly kind: 'screen'; readonly screen: TuiScreen }
  | { readonly kind: 'overlay-open'; readonly overlay: OverlayKind }
  | { readonly kind: 'overlay-close-top' }
  | { readonly kind: 'overlay-close-all' }
  | { readonly kind: 'sidebar-toggle'; readonly allowed: SidebarDensity }
  | { readonly kind: 'sidebar-resized'; readonly allowed: SidebarDensity }
  | { readonly kind: 'session-selected'; readonly coordinatorSessionId: string }
  | { readonly kind: 'sessions-loaded'; readonly coordinatorSessionIds: readonly string[]; readonly preferred: string | null }
  | { readonly kind: 'draft-changed'; readonly coordinatorSessionId: string; readonly text: string }
  | { readonly kind: 'scroll-changed'; readonly coordinatorSessionId: string; readonly offset: number }
  | { readonly kind: 'event-arrived'; readonly coordinatorSessionId: string | null }
  | { readonly kind: 'answer-mode-entered'; readonly interactionId: string; readonly expectedRevision: number }
  | { readonly kind: 'composer-mode-reset' }
  | { readonly kind: 'tool-toggled'; readonly entryId: string }
  | { readonly kind: 'inspector-selected'; readonly workPackageId: string }
  | { readonly kind: 'notice'; readonly notice: string | null }
  | { readonly kind: 'attention-cleared' }
  | { readonly kind: 'session-read-only'; readonly coordinatorSessionId: string };

/** 密度只允许在「宽度允许的上限」之内降级；任何动作都不会强制展开。 */
function clampDensity(current: SidebarDensity, allowed: SidebarDensity): SidebarDensity {
  const order: readonly SidebarDensity[] = ['collapsed', 'compact', 'full'];
  return order.indexOf(current) <= order.indexOf(allowed) ? current : allowed;
}

export function reduceTuiState(state: TuiState, action: TuiAction): TuiState {
  switch (action.kind) {
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
        drafts: { ...state.drafts, [action.coordinatorSessionId]: action.text },
      };
    case 'scroll-changed':
      return {
        ...state,
        scrollOffsets: { ...state.scrollOffsets, [action.coordinatorSessionId]: action.offset },
      };
    case 'event-arrived': {
      // 事件只增加标记：不切换 transcript、不抢占 composer、不动 Scope 级图。
      if (
        action.coordinatorSessionId === null ||
        action.coordinatorSessionId === state.selectedSessionId
      ) {
        return { ...state, attention: true };
      }
      if (state.unreadSessionIds.includes(action.coordinatorSessionId)) {
        return state;
      }
      return {
        ...state,
        unreadSessionIds: [...state.unreadSessionIds, action.coordinatorSessionId],
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
          : [...state.expandedToolIds, action.entryId],
      };
    case 'inspector-selected':
      return { ...state, inspectorSelection: action.workPackageId };
    case 'notice':
      return { ...state, notice: action.notice };
    case 'attention-cleared':
      return { ...state, attention: false };
    case 'session-read-only':
      return state.readOnlySessionIds.includes(action.coordinatorSessionId)
        ? state
        : { ...state, readOnlySessionIds: [...state.readOnlySessionIds, action.coordinatorSessionId] };
  }
}

/** 当前 Session 的 composer 文本；没有草稿时为空串。 */
export function draftFor(state: TuiState, coordinatorSessionId: string | null): string {
  if (coordinatorSessionId === null) {
    return '';
  }
  return state.drafts[coordinatorSessionId] ?? '';
}

/** 是否允许该 Session 提交普通消息：只读 transcript 与 composer 模式无关，仅由只读集合决定。 */
export function isComposerReadOnly(state: TuiState, coordinatorSessionId: string | null): boolean {
  return coordinatorSessionId !== null && state.readOnlySessionIds.includes(coordinatorSessionId);
}
