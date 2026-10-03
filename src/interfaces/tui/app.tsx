/**
 * TUI 容器：唯一持有输入映射、加载与命令派发的地方。
 *
 * 硬边界：
 * - 所有加载都是只读 query；`execute` 只在用户明确动作（提交、命令、回答、切换模型、交接确认）时调用，
 *   因此 render/effect/resize/重挂载不可能触发恢复、派发、重试或写入；
 * - 事件只进入 Event Drawer 投影与未读标记，不切换 transcript、不抢占 composer、不改变 Scope 级图；
 * - 没有 TTY 判断：那发生在挂载 Ink 之前的 `src/bootstrap/tui-entry.ts`。
 */

import { Box, Text, useInput, usePaste, useWindowSize } from 'ink';
import { ThemeProvider } from '@inkjs/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { resolveGlobalAction } from './input/keymap.js';
import type { AnswerPanelView } from './components/answer-panel.js';
import type { PasteViewerView } from './components/paste-viewer.js';
import type { ControllerInteractionView } from '../../application/controller-service.js';
import type { InteractionPageCursor } from '../../application/ports/branch-coordination-store.js';
import { bodyWidth } from './screens/workspace.js';
import { wrapByDisplayWidth } from './render/width.js';
import { editComposer, editorLayout, emptyDraft, textDraft, type EditorKey } from './input/composer-editor.js';
import { allowedSidebarDensity, composerContentWidth } from './render/width.js';
import { requiresConfirmation } from './components/control-bar.js';
import {
  createInputProtection,
  type SaveOutcome,
} from './input/input-protection.js';
import type {
  InputManagerEntry,
  InputRecordManagerView,
} from './components/input-record-manager.js';
import {
  answerDraftKey,
  composerDraftFor,
  composerInputFor,
  executionFilterLabel,
  initialTuiState,
  isComposerReadOnly,
  nextExecutionFilter,
  reduceTuiState,
  type ComposerMode,
  type OverlayKind,
  type PendingConfirmation,
  type TuiAction,
  type TuiState,
} from './state.js';
import { Home } from './screens/home.js';
import { Wizard, allChecksPassed } from './screens/wizard.js';
import { Workspace, workspaceLayout, type WorkspaceActions } from './screens/workspace.js';
import { COMMAND_IDS, COMMAND_METADATA, commandReason, HELP_LINES, slashCandidates, parseSlashInput, type CommandId } from './components/command-palette.js';
import { projectItems, projectDetailViewport } from './components/project-panel.js';
import { selectedGraphNode } from './components/graph-inspector.js';
import { preferredSessionId } from './components/session-picker.js';
import { tuiTheme } from './theme.js';
import {
  projectTranscriptPage,
  projectTuiViewModel,
  type TuiViewModel,
} from '../../application/tui/view-model.js';
import type {
  ControllerCommandResult,
  ControllerSnapshot,
  ControllerTranscriptPage,
  SemanticEvent,
} from '../../application/controller-service.js';
import type {
  UiDraft,
  UiInputRecord,
  UiInputTarget,
} from '../../application/ports/ui-input-store.js';
import type { SubmissionQuery, SubmissionStatus } from '../../application/coordinator/submission-status.js';
import type {
  ExecutionAuthorizationLoad,
  HomeResolution,
  ModelCatalog,
  ScopeCandidate,
  TuiPorts,
  WizardCheck,
  WizardProposal,
} from './ports.js';

const EMPTY_MODEL_CATALOG: ModelCatalog = {
  options: [],
  currentConfigurationRef: null,
  switchable: false,
  switchBlockReason: '尚未加载 Model Picker 数据',
};

/** Event Drawer 的有界窗口：语义事件再多也不会让渲染无界增长。 */
export const EVENT_WINDOW = 50;

export type TuiAppProps = {
  readonly ports: TuiPorts;
  readonly terminalWidth: number;
  /** 已知的 Scope（例如由 `--scope` 或 Home 选择提供）；`null` 时先解析 Home。 */
  readonly initialScopeId: string | null;
  readonly onExit: () => void;
};

/**
 * 覆盖层的选择光标。
 *
 * `useState` 在一次渲染批次里读到的仍是旧值：同一批按键里的 `Down, Down` 会两次都基于同一个
 * `paletteSelection` 计算，结果只移动一格。输入处理必须读同步事实源，因此这里用 ref 承载当前索引，
 * state 只负责触发重渲染。
 */
export type SelectionCursor = {
  readonly current: () => number;
  /** 按方向键移动；`maximum` 是允许的最大索引（含）。 */
  readonly move: (delta: number, maximum: number) => void;
  readonly set: (index: number) => void;
};

function useSelectionCursor(initial = 0): SelectionCursor & { readonly value: number } {
  const [value, setValue] = useState(initial);
  const ref = useRef(initial);
  const set = useCallback((index: number) => {
    ref.current = index;
    setValue(index);
  }, []);
  const move = useCallback(
    (delta: number, maximum: number) => {
      set(Math.min(Math.max(0, ref.current + delta), Math.max(0, maximum)));
    },
    [set],
  );
  const current = useCallback(() => ref.current, []);
  return { value, current, move, set };
}

function resultNotice(result: ControllerCommandResult): string | null {
  switch (result.kind) {
    case 'accepted':
      return null;
    case 'rejected':
      return `${result.code}: ${result.message}`;
    case 'unknown':
      return `unknown(${result.code}): ${result.message}（需对账）`;
  }
}

type AnswerMode = Extract<ComposerMode, { readonly kind: 'answer' }>;

function messageInputTarget(coordinationScopeId: string, coordinatorSessionId: string): UiInputTarget {
  return { kind: 'message', coordinationScopeId, coordinatorSessionId };
}

function answerInputTarget(
  coordinationScopeId: string,
  coordinatorSessionId: string,
  mode: AnswerMode,
): UiInputTarget {
  return {
    kind: 'answer',
    coordinationScopeId,
    coordinatorSessionId,
    interactionId: mode.interactionId,
    expectedRevision: mode.expectedRevision,
  };
}

/** 当前 composer 输入的目标；没有选中 Session 或 Scope 时为空，界面因此不会构造半截身份。 */
function currentInputTarget(state: TuiState, coordinationScopeId: string | null): UiInputTarget | null {
  const session = state.selectedSessionId;
  if (session === null || coordinationScopeId === null) {
    return null;
  }
  return state.composerMode.kind === 'answer'
    ? answerInputTarget(coordinationScopeId, session, state.composerMode)
    : messageInputTarget(coordinationScopeId, session);
}

function saveOutcomeText(outcome: SaveOutcome): string {
  if (outcome.status === 'failed') {
    return `${outcome.code}: ${outcome.message}`;
  }
  return outcome.status === 'conflict' ? outcome.message : '已保存';
}

/** 从记录派生只读核验查询；普通消息按 Session 与 submissionId，回答另加交互绑定。 */
function submissionQueryFor(record: UiInputRecord): SubmissionQuery | null {
  if (record.kind !== 'submission') {
    return null;
  }
  const { target } = record;
  const base = {
    coordinatorSessionId: target.coordinatorSessionId,
    submissionId: record.submissionId,
    content: record.draft.text,
  };
  return target.kind === 'answer'
    ? { kind: 'answer', ...base, interactionId: target.interactionId, expectedRevision: target.expectedRevision }
    : { kind: 'message', ...base };
}

/** 把某个目标的文本写回展示态的 action：普通草稿与回答草稿分别走各自的隔离槽。 */
function draftActionFor(target: UiInputTarget, draft: UiDraft): TuiAction {
  return target.kind === 'message'
    ? { kind: 'draft-changed', coordinatorSessionId: target.coordinatorSessionId, draft }
    : {
        kind: 'answer-draft-changed',
        answerKey: answerDraftKey(
          target.coordinatorSessionId,
          target.interactionId,
          target.expectedRevision,
        ),
        draft,
      };
}

/** 两个输入目标是否是同一个：回答要求 interaction 与 revision 都一致。 */
function sameInputTarget(a: UiInputTarget, b: UiInputTarget): boolean {
  const base =
    a.coordinationScopeId === b.coordinationScopeId &&
    a.coordinatorSessionId === b.coordinatorSessionId;
  if (a.kind === 'message' && b.kind === 'message') {
    return base;
  }
  if (a.kind === 'answer' && b.kind === 'answer') {
    return base && a.interactionId === b.interactionId && a.expectedRevision === b.expectedRevision;
  }
  return false;
}

function selectedInputEntry(view: InputRecordManagerView | null): InputManagerEntry | null {
  return view === null ? null : (view.entries[view.selectedIndex] ?? null);
}

/** 两个 composer 模式是否指向同一次提交（普通模式或同一 interaction + revision）。 */
function sameComposerMode(a: ComposerMode, b: ComposerMode): boolean {
  if (a.kind === 'message' && b.kind === 'message') {
    return true;
  }
  if (a.kind === 'answer' && b.kind === 'answer') {
    return a.interactionId === b.interactionId && a.expectedRevision === b.expectedRevision;
  }
  return false;
}

function inputManagerEntriesOf(
  records: readonly UiInputRecord[],
  invalidRecords: readonly { readonly key: string; readonly revision: number }[],
): readonly InputManagerEntry[] {
  return [
    ...records.map((record): InputManagerEntry => ({ kind: 'record', record })),
    ...invalidRecords.map((invalid): InputManagerEntry => ({ kind: 'invalid', ...invalid })),
  ];
}

export function TuiApp(props: TuiAppProps) {
  return <ThemeProvider theme={tuiTheme}><TuiAppContent {...props} /></ThemeProvider>;
}

function TuiAppContent(props: TuiAppProps) {
  const { ports, onExit } = props;
  // 终端宽度是渲染输入，不是业务状态：resize 只重算布局，不重新查询也不改变用户偏好。
  // 必须用 `useWindowSize`：它自己订阅 resize 并触发重渲染；只读 `stdout.columns` 在真实 PTY 里
  // 不会重排（实测 resize 后仍按旧宽度绘制），那会让中文混排与边框在新宽度下失配。
  const windowSize = useWindowSize();
  const terminalWidth = windowSize.columns === undefined ? props.terminalWidth : windowSize.columns;
  const [state, setState] = useState<TuiState>(initialTuiState);
  const [events, setEvents] = useState<readonly SemanticEvent[]>([]);
  const [snapshot, setSnapshot] = useState<ControllerSnapshot | null>(null);
  const [transcript, setTranscript] = useState<ControllerTranscriptPage | null>(null);
  const [home, setHome] = useState<HomeResolution | null>(null);
  const [candidates, setCandidates] = useState<readonly ScopeCandidate[]>([]);
  const homeSelection = useSelectionCursor();
  /** 迁移被拒绝时的结构化原因；Review 已由 `screen` 表达，这里只留展示文案。 */
  const [legacyNotice, setLegacyNotice] = useState<string | null>(null);
  const [checks, setChecks] = useState<readonly WizardCheck[] | null>(null);
  const [proposal, setProposal] = useState<WizardProposal | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [blocker, setBlocker] = useState<string | null>(null);
  const [scopeId, setScopeId] = useState<string | null>(props.initialScopeId);
  const paletteSelection = useSelectionCursor();
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog>(EMPTY_MODEL_CATALOG);
  const [modelRejection, setModelRejection] = useState<string | null>(null);
  const [handoffProposalId, setHandoffProposalId] = useState<string | null>(null);
  /**
   * 正在审阅的完整 Manifest。
   *
   * 它不由快照派生：审阅事实由宿主在用户打开审阅时读一次，含指纹与门禁；因此它保存在组件内，而不是
   * 塞进展示态 reducer，也不会随事件批次被改写。
   */
  const [authorizationReview, setAuthorizationReview] = useState<ExecutionAuthorizationLoad | null>(null);
  /**
   * 输入记录管理 overlay 的当前投影；`null` 表示未打开。
   *
   * 列表、正文视口与反馈都在这里：组件只渲染读好的内容，容器自己经 `inputStore` 执行动作。
   */
  const [inputManager, setInputManager] = useState<InputRecordManagerView | null>(null);
  const [answerPanel, setAnswerPanel] = useState<AnswerPanelView | null>(null);
  const answerPanelRef = useRef<AnswerPanelView | null>(null);
  const updateAnswerPanel = (value: AnswerPanelView | null) => { answerPanelRef.current = value; setAnswerPanel(value); };
  const answerRequest = useRef(0);
  const answerPage = useRef<{ items: readonly ControllerInteractionView[]; next: InteractionPageCursor | null; cursors: readonly (InteractionPageCursor | undefined)[] }>({ items: [], next: null, cursors: [undefined] });
  const [pasteViewer, setPasteViewer] = useState<PasteViewerView | null>(null);
  const pasteViewerRef = useRef<PasteViewerView | null>(null);
  const updatePasteViewer = (value: PasteViewerView | null) => { pasteViewerRef.current = value; setPasteViewer(value); };
  /** 输入记录管理的同步镜像：同一批按键要读到最新选择与视口。 */
  const inputManagerRef = useRef<InputRecordManagerView | null>(null);
  inputManagerRef.current = inputManager;
  /** 合并窗口自动保存失败时的通知出口；`dispatch` 定义后才接线。 */
  const noticeRef = useRef<(message: string) => void>(() => undefined);
  /**
   * 输入保护模块：每个挂载一次，只经 `ports.inputStore` 同步读写。
   *
   * 它不打开数据库、不发送、不恢复模型；`dispose` 只取消计时器，卸载时绝不写库。
   */
  const [protection] = useState(() =>
    createInputProtection({
      store: props.ports.inputStore,
      onSaveOutcome: (outcome) => {
        noticeRef.current(`输入保存失败：${saveOutcomeText(outcome)}（输入仍保留在内存中）`);
      },
    }),
  );
  /** 向导初始化的同步闩锁：初始化必须恰好一次，不能靠异步 state 挡重复确认。 */
  const wizardSubmittingRef = useRef(false);

  /** 最新的展示态镜像：输入回调与异步加载需要读取它，但不应因此重建监听器。 */
  const stateRef = useRef(state);
  stateRef.current = state;

  /**
   * 展示态的唯一写入口。
   *
   * 同时把结果写回 `stateRef`：一次按键批次可能在同一帧里连续投递多个键（粘贴、连击、PTY 批量写入），
   * 若只有 `setState`，下一次按键读到的仍是旧渲染里的状态——`Ctrl+P` 紧跟方向键就会把命令投给 composer。
   */
  const dispatch = useCallback((action: TuiAction) => {
    const next = reduceTuiState(stateRef.current, action);
    stateRef.current = next;
    setState(next);
  }, []);
  noticeRef.current = (message) => {
    dispatch({ kind: 'notice', notice: message });
  };

  // 卸载只取消计时器：组件重挂载绝不产生新的持久写入。
  useEffect(() => () => protection.dispose(), [protection]);

  const scopeIdRef = useRef(scopeId);
  scopeIdRef.current = scopeId;
  /** 当前 Coordination Scope：优先取快照，其次取 Home 解析结果。 */
  const coordinationScopeId = snapshot?.coordinationScopeId ?? scopeId;
  const coordScopeRef = useRef<string | null>(coordinationScopeId);
  coordScopeRef.current = coordinationScopeId;

  const loadSnapshot = useCallback(
    async (selectedSessionId: string | null) => {
      const result = await ports.snapshot(selectedSessionId);
      if (result.kind === 'snapshot') {
        setSnapshot(result.snapshot);
        return;
      }
      setBlocker(`${result.code}: ${result.message}`);
    },
    [ports],
  );

  const loadTranscript = useCallback(
    async (coordinatorSessionId: string) => {
      const result = await ports.transcript(coordinatorSessionId, null);
      if (result.kind === 'transcript') {
        setTranscript(result.transcript);
      }
    },
    [ports],
  );

  // 挂载时解析 Home 并订阅事件；这两件事都只读，重挂载不会产生业务副作用。
  useEffect(() => {
    let cancelled = false;
    let pendingEvents: SemanticEvent[] = [];
    const pendingSessionIds = new Set<string | null>();
    const seenEventIds = new Set<string>();
    let flushScheduled = false;
    void (async () => {
      if (scopeIdRef.current !== null) {
        return;
      }
      const resolution = await ports.scopeSetup.resolveHome();
      if (cancelled) {
        return;
      }
      setHome(resolution);
      if (resolution.kind === 'restore') {
        setScopeId(resolution.coordinationScopeId);
      }
      if (resolution.kind === 'legacy') {
        setCandidates(resolution.candidates);
      }
    })();
    const unsubscribe = ports.subscribe((event) => {
      if (seenEventIds.has(event.eventId)) {
        return;
      }
      seenEventIds.add(event.eventId);
      // ponytail: 只去重最近 20 个窗口；若跨更长时段重放，改用来源游标。
      if (seenEventIds.size > EVENT_WINDOW * 20) {
        const oldest = seenEventIds.values().next().value;
        if (oldest !== undefined) {
          seenEventIds.delete(oldest);
        }
      }
      pendingEvents.push(event);
      pendingEvents = pendingEvents.slice(-EVENT_WINDOW);
      pendingSessionIds.add(event.coordinatorSessionId);
      if (flushScheduled) {
        return;
      }
      flushScheduled = true;
      queueMicrotask(() => {
        if (cancelled) {
          return;
        }
        // 同一轮投递只刷新一次；窗口与去重集合都保持有界。
        const batch = pendingEvents;
        const sessionIds = [...pendingSessionIds];
        pendingEvents = [];
        pendingSessionIds.clear();
        flushScheduled = false;
        setEvents((current) => [...current, ...batch].slice(-EVENT_WINDOW));
        dispatch({ kind: 'events-arrived', coordinatorSessionIds: sessionIds });
      });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [dispatch, ports]);

  // Scope 就绪后：进入 workspace 并加载一次快照。
  useEffect(() => {
    if (scopeId === null) {
      return;
    }
    dispatch({ kind: 'screen', screen: 'workspace' });
    void loadSnapshot(stateRef.current.selectedSessionId);
  }, [dispatch, loadSnapshot, scopeId]);

  useEffect(() => {
    if(state.selectedSessionId===null)return;
    let active=true;
    void ports.modelCatalog.load().then(catalog=>{ if(active) setModelCatalog(catalog); }).catch(()=>{ if(active) setModelCatalog(EMPTY_MODEL_CATALOG); });
    return ()=>{active=false;};
  }, [ports, state.selectedSessionId, snapshot?.sessions.find(session=>session.coordinatorSessionId===state.selectedSessionId)?.coordinatorModelConfigurationRef]);

  // 选中 Session 后加载其 transcript。
  useEffect(() => {
    if (state.selectedSessionId === null || state.screen !== 'workspace') {
      return;
    }
    void loadTranscript(state.selectedSessionId);
  }, [loadTranscript, state.selectedSessionId, state.screen]);

  /**
   * 载入当前目标的持久草稿。
   *
   * 这是只读 effect：只 `read`，不写库、不发送、不恢复模型。用户已在编辑时保护模块返回 `stale`，
   * 因此异步载入永远不会覆盖新输入；切换 Session 或进入/退出回答模式时同样按各自目标隔离载入。
   */
  useEffect(() => {
    if (state.screen !== 'workspace') {
      return;
    }
    const target = currentInputTarget(state, coordinationScopeId);
    if (target === null) {
      return;
    }
    const loaded = protection.load(target);
    if (loaded.status === 'failed') {
      dispatch({ kind: 'notice', notice: `草稿载入失败：${loaded.code} ${loaded.message}` });
      return;
    }
    if (loaded.status === 'loaded') {
      dispatch(draftActionFor(target, loaded.draft));
    }
  }, [
    coordinationScopeId,
    dispatch,
    protection,
    state.composerMode,
    state.screen,
    state.selectedSessionId,
  ]);

  // Session 列表就绪后应用默认选中规则（待答优先）。
  useEffect(() => {
    if (snapshot === null) {
      return;
    }
    dispatch({
      kind: 'sessions-loaded',
      coordinatorSessionIds: snapshot.sessions.map((session) => session.coordinatorSessionId),
      preferred: preferredSessionId(
        snapshot.sessions.map((session) => ({
          ...session,
          unread: false,
          selected: false,
        })),
        stateRef.current.selectedSessionId,
      ),
    });
  }, [dispatch, snapshot]);

  // resize 只收紧密度上限；用户折叠过的 Sidebar 不会被重新展开。
  useEffect(() => {
    dispatch({ kind: 'sidebar-resized', allowed: allowedSidebarDensity(terminalWidth) });
  }, [dispatch, terminalWidth]);

  const viewModel: TuiViewModel | null = useMemo(() => {
    if (snapshot === null) {
      return null;
    }
    return projectTuiViewModel({
      snapshot,
      transcript: projectTranscriptPage(transcript, {
        coordinatorSessionId: state.selectedSessionId,
        scrollOffset: state.selectedSessionId === null ? 0 : (state.scrollOffsets[state.selectedSessionId] ?? 0),
        readOnly: isComposerReadOnly(state, state.selectedSessionId),
      }),
      selectedSessionId: state.selectedSessionId,
      unreadSessionIds: state.unreadSessionIds,
      executionFilter: state.executionFilter,
      includeGraphNodes: state.sidebarDensity !== 'collapsed' || state.projectPanel.open || state.overlayStack.at(-1) === 'graph-inspector',
    });
  }, [snapshot, state, transcript]);
  const viewModelRef = useRef<TuiViewModel | null>(null);
  viewModelRef.current = viewModel;
  // A collapsed sidebar omits nodes; initialize only after the Inspector projection is available.
  useEffect(() => {
    if(state.overlayStack.at(-1)!=='graph-inspector'||state.inspectorSelection!==null)return;
    const node=selectedGraphNode(viewModel?.graph??null,null);
    if(node)dispatch({kind:'inspector-selected',workPackageId:node.workPackageId});
  }, [dispatch,state.overlayStack,state.inspectorSelection,viewModel?.graph]);
  /** 快照的同步镜像：提交时需要当前模式来决定 `/handoff` 落到哪个业务合同。 */
  const snapshotRef = useRef<ControllerSnapshot | null>(null);
  snapshotRef.current = snapshot;
  /** `runCommand` 定义之前的提交路径需要它；读时取最新实现，避免互相依赖。 */
  const runCommandRef = useRef<(command: CommandId) => Promise<void>>(() => Promise.resolve());
  const openAnswerRef = useRef<(interactionId?: string, skipId?: string) => Promise<boolean>>(() => Promise.resolve(false));
  const readQuestions = async (query: import('./ports.js').TuiQuestionQuery): Promise<import('../../application/controller-service.js').ControllerQuestionResult> => {
    if (!ports.questions) return { kind: 'rejected', code: 'questions_unavailable', message: '当前问题读取不可用' };
    try { return await ports.questions(query); }
    catch (error) { return { kind: 'rejected', code: 'questions_unreadable', message: error instanceof Error ? error.message : String(error) }; }
  };

  const showAnswer = async (item: ControllerInteractionView, index: number, count: number): Promise<boolean> => {
    const session = stateRef.current.selectedSessionId;
    const scope = coordScopeRef.current;
    const request = ++answerRequest.current;
    if (session === null || scope === null || item.ownerCoordinatorSessionId !== session || ports.questions === undefined) {
      dispatch({ kind: 'notice', notice: 'questions_unavailable：当前问题读取不可用' }); return false;
    }
    const detail = await readQuestions({ kind: 'pending-interaction', coordinatorSessionId: session, interactionId: item.interactionId });
    if (request !== answerRequest.current || stateRef.current.selectedSessionId !== session || coordScopeRef.current !== scope) return false;
    if (detail.kind !== 'pending-interaction' || !detail.interaction || detail.interaction.state !== 'open' ||
      detail.interaction.ownerCoordinatorSessionId !== session || detail.interaction.interactionId !== item.interactionId || detail.interaction.expectedRevision !== item.expectedRevision) {
      dispatch({ kind: 'notice', notice: detail.kind === 'rejected' ? `${detail.code}: ${detail.message}` : 'stale_revision：问题已变化，请重新打开' }); return false;
    }
    const saved = protection.flushAll();
    if (saved.status !== 'saved') { dispatch({ kind: 'notice', notice: saveOutcomeText(saved) }); return false; }
    dispatch({ kind: 'answer-mode-entered', interactionId: item.interactionId, expectedRevision: item.expectedRevision });
    updateAnswerPanel({ interaction: detail.interaction, index, count, option: 0, focus: detail.interaction.question?.options.length ? 'options' : 'text', scroll: 0 });
    return true;
  };

  const openAnswer = async (interactionId?: string, skipId?: string): Promise<boolean> => {
    const session = stateRef.current.selectedSessionId;
    const scope = coordScopeRef.current;
    const request = ++answerRequest.current;
    if (!session || !scope || !ports.questions) { dispatch({ kind: 'notice', notice: 'questions_unavailable：当前问题读取不可用' }); return false; }
    const page = await readQuestions({ kind: 'pending-interactions', coordinatorSessionId: session });
    if (request !== answerRequest.current || stateRef.current.selectedSessionId !== session || coordScopeRef.current !== scope) return false;
    if (page.kind !== 'pending-interactions') { dispatch({ kind: 'notice', notice: page.kind === 'rejected' ? `${page.code}: ${page.message}` : '问题列表不可读' }); return false; }
    const items = page.interactions.filter((item) => item.ownerCoordinatorSessionId === session && item.state === 'open' && item.interactionId !== skipId).slice(0, 20);
    answerPage.current = { items, next: page.nextCursor, cursors: [undefined] };
    const index = interactionId === undefined ? 0 : items.findIndex((item) => item.interactionId === interactionId);
    const item = items[index];
    if (!item) { dispatch({ kind: 'notice', notice: '当前 Session 没有待答问题' }); return false; }
    return showAnswer(item, index, items.length);
  };
  openAnswerRef.current = openAnswer;

  const navigateAnswer = async (direction: number): Promise<void> => {
    const current = answerPanelRef.current;
    const session = stateRef.current.selectedSessionId;
    if (!current || !session || !ports.questions) return;
    const saved = protection.flushAll();
    if (saved.status !== 'saved') { dispatch({ kind: 'notice', notice: saveOutcomeText(saved) }); return; }
    const index = current.index + direction;
    const item = answerPage.current.items[index];
    if (item) { await showAnswer(item, index, answerPage.current.items.length); return; }
    const cursors = answerPage.current.cursors;
    const after = direction > 0 ? answerPage.current.next ?? undefined : cursors.at(-2);
    if ((direction > 0 && !answerPage.current.next) || (direction < 0 && cursors.length < 2)) return;
    const request = ++answerRequest.current;
    const page = await readQuestions({ kind: 'pending-interactions', coordinatorSessionId: session, ...(after === undefined ? {} : { after }) });
    if (request !== answerRequest.current || stateRef.current.selectedSessionId !== session || page.kind !== 'pending-interactions') return;
    answerPage.current = { items: page.interactions, next: page.nextCursor, cursors: direction > 0 ? [...cursors, after] : cursors.slice(0, -1) };
    const nextIndex = direction > 0 ? 0 : page.interactions.length - 1;
    const next = page.interactions[nextIndex];
    if (next) await showAnswer(next, nextIndex, page.interactions.length);
  };

  const reload = useCallback(async () => {
    await loadSnapshot(stateRef.current.selectedSessionId);
    const selected = stateRef.current.selectedSessionId;
    if (selected !== null) {
      await loadTranscript(selected);
    }
  }, [loadSnapshot, loadTranscript]);

  const submit = useCallback(async () => {
    const current = stateRef.current;
    const session = current.selectedSessionId;
    const scope = coordScopeRef.current;
    if (session === null || scope === null) {
      return;
    }
    const text = composerDraftFor(current, session);
    if (text.trim().length === 0 || isComposerReadOnly(current, session)) {
      return;
    }
    // `context_exhausted` 表示上下文无法安全收敛：界面不再发起新的模型调用，也不写提交快照。
    if (viewModelRef.current?.compaction?.status === 'context_exhausted') {
      dispatch({ kind: 'notice', notice: 'context_exhausted：已停止发起新的模型调用' });
      return;
    }
    const target = currentInputTarget(current, scope);
    if (target === null) {
      return;
    }
    // 严格 slash：只要以 `/` 开头就不是消息；未知、参数或多行格式错误都保留输入。
    const slash = parseSlashInput(text, snapshotRef.current?.mode ?? 'route_planning');
    if (slash.kind === 'error') {
      dispatch({ kind: 'notice', notice: `${slash.code}: ${slash.message}` });
      return;
    }
    if (slash.kind === 'command') {
      const unavailable=commandReason(slash.command,{mode:snapshotRef.current?.mode??'route_planning',selectedSessionId:session,pasteBlocks:composerInputFor(current,session).pasteBlocks.length});
      if(unavailable){dispatch({kind:'notice',notice:unavailable});return;}
      if (slash.command === 'answer') { await openAnswerRef.current(); return; }
      if (slash.command === 'paste') { await runCommandRef.current('paste'); return; }
      const generation = protection.generation(target);
      await runCommandRef.current(slash.command);
      // 命令成功只结清这次输入；等待期间的新输入（代际变化）与清理失败都保留。
      if (protection.generation(target) === generation) {
        const cleared = protection.clearInput(target);
        if (cleared.status === 'saved') {
          dispatch(draftActionFor(target, emptyDraft()));
        } else {
          dispatch({ kind: 'notice', notice: `命令输入未结清：${saveOutcomeText(cleared)}` });
        }
      }
      return;
    }
    // 单活跃提交：同一 Session 已有等待确认或不可核验的提交时不再发起第二次请求。
    const lane = protection.pendingSubmission(scope, session);
    if (lane.status === 'failed') {
      dispatch({ kind: 'notice', notice: `提交前无法读取待核验提交：${lane.code} ${lane.message}` });
      return;
    }
    if (lane.status === 'active') {
      dispatch({
        kind: 'notice',
        notice: `该 Session 已有一条待核验提交（${lane.state}）${lane.submissionId}：先在 /inputs 核验或清理`,
      });
      return;
    }
    // 提交前先把草稿落盘；保存失败或存在待解冲突时不发起调用，也不丢内存输入。
    const flushed = protection.flushAll();
    if (flushed.status !== 'saved') {
      dispatch({ kind: 'notice', notice: `输入未保存，未发起提交：${saveOutcomeText(flushed)}` });
      return;
    }
    const submissionId = globalThis.crypto.randomUUID();
    const generation = protection.generation(target);
    const snapshotDraft: UiDraft = protection.draftOf(target) ?? {
      text,
      cursor: text.length,
      pasteBlocks: [],
    };
    const begun = protection.beginSubmission({ target, draft: snapshotDraft, submissionId });
    if (begun.status !== 'started') {
      dispatch({
        kind: 'notice',
        notice:
          begun.status === 'lane-busy'
            ? `该 Session 已有待核验提交 ${begun.submissionId}（${begun.state}）`
            : `提交快照未保存，未发起提交：${begun.code} ${begun.message}`,
      });
      return;
    }
    const submittedMode = current.composerMode;
    let result: ControllerCommandResult;
    try {
      result =
        submittedMode.kind === 'answer'
          ? await ports.execute({
              kind: 'answer-pending-interaction',
              coordinatorSessionId: session,
              interactionId: submittedMode.interactionId,
              expectedRevision: submittedMode.expectedRevision,
              submissionId,
              answer: text,
            })
          : await ports.execute({
              kind: 'send-session-message',
              coordinatorSessionId: session,
              submissionId,
              content: text,
            });
    } catch (error) {
      // 调用抛异常既不证明受理也不证明未发生：按 `unknown` 处理，lane 保持待核验。
      result = {
        kind: 'unknown',
        code: 'execute_threw',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    const settled = protection.settleSubmission({
      target,
      submissionId,
      outcome:
        result.kind === 'accepted'
          ? { kind: 'accepted' }
          : result.kind === 'rejected'
            ? { kind: 'rejected', code: result.code, message: result.message }
            : { kind: 'unknown', code: result.code, message: result.message },
    });
    const settlementNote =
      settled.status === 'saved'
        ? null
        : result.kind === 'accepted'
          ? `已受理，但输入快照清理失败：${saveOutcomeText(settled)}（可在 /inputs 重新核验或删除）`
          : `提交状态回写失败：${saveOutcomeText(settled)}；原提交 ${submissionId} 仍待核验`;
    // 失败优先：结算异常与拒绝/未知原因一起展示，绝不被成功文案遮蔽。
    const notes = [settlementNote, resultNotice(result)].filter(
      (entry): entry is string => entry !== null,
    );
    dispatch({ kind: 'notice', notice: notes.length === 0 ? null : notes.join(' · ') });
    if (result.kind === 'accepted') {
      // 只结清原提交：用户已继续编辑（代际变化）时保留新输入，也不复位模式以免隐藏新回答草稿。
      if (protection.generation(target) === generation) {
        const cleared = protection.clearDraft(target);
        if (cleared.status === 'saved') {
          // 只有持久草稿真的被清除才清界面正文；清理失败时保留输入并如实提示。
          dispatch(draftActionFor(target, emptyDraft()));
          // 只有界面仍停在这条提交对应的 Session 与 composer 模式时才复位。
          if (
            stateRef.current.selectedSessionId === session &&
            sameComposerMode(stateRef.current.composerMode, submittedMode)
          ) {
            dispatch({ kind: 'composer-mode-reset' });
            if (submittedMode.kind === 'answer') {
              updateAnswerPanel(null);
              await openAnswerRef.current(undefined, submittedMode.interactionId);
            }
          }
        } else {
          dispatch({ kind: 'notice', notice: `已受理，但草稿未清除：${saveOutcomeText(cleared)}` });
        }
      }
      await reload();
    }
    // 拒绝（含 stale revision）时保留输入内容，只提示重读。
  }, [dispatch, ports, protection, reload]);

  /** 提交一次 Scope 级控制意图；终态一律来自 Controller 已持久化的控制状态。 */
  const applyScopeControl = useCallback(
    async (action: 'pause' | 'resume' | 'cancel') => {
      const result = await ports.execute({ kind: 'scope-control', action });
      dispatch({ kind: 'notice', notice: resultNotice(result) });
      await reload();
    },
    [dispatch, ports, reload],
  );

  /**
   * Scope 级控制入口。
   *
   * Pause 从不要求确认；Cancel 只在危险态（活跃/不可核验 Worker、待答交互、未决操作）下要求一次确认。
   * 确认本身不写任何控制状态，它只是提交一次与直接调用相同的意图。
   */
  const requestScopeControl = useCallback(
    (action: 'pause' | 'resume' | 'cancel') => {
      const view = viewModelRef.current;
      if (action === 'cancel' && view === null && scopeIdRef.current !== null) {
        // Scope 已确定但执行快照尚未落地：「未知」不能读作「没有危险态」。
        dispatch({ kind: 'confirmation-requested', pending: { kind: 'cancel' } });
        return;
      }
      if (view !== null && requiresConfirmation(action, view.execution.hazards)) {
        dispatch({ kind: 'confirmation-requested', pending: { kind: 'cancel' } });
        return;
      }
      void applyScopeControl(action);
    },
    [applyScopeControl, dispatch],
  );

  /**
   * Exit / `Ctrl+C` 的入口。
   *
   * 退出只结束前台进程：不写控制状态、请求 Worker 停止或隐式 Pause/Cancel。存在活跃 Worker、待答交互
   * 或未决操作时必须先确认。
   */
  const requestExit = useCallback(() => {
    // 退出前先立即保存所有未保存输入；保存失败默认留在界面，只有再次明确确认才丢弃。
    if (protection.hasUnsaved()) {
      const flushed = protection.flushAll();
      if (flushed.status !== 'saved') {
        dispatch({ kind: 'notice', notice: `输入未保存：${saveOutcomeText(flushed)}` });
        dispatch({ kind: 'confirmation-requested', pending: { kind: 'exit-discard' } });
        return;
      }
    }
    const view = viewModelRef.current;
    if (view === null && scopeIdRef.current !== null) {
      // Scope 已确定但执行快照尚未落地：无法排除活跃 Worker 或未决操作，因此先确认再退出。
      dispatch({ kind: 'confirmation-requested', pending: { kind: 'exit' } });
      return;
    }
    if (view !== null && requiresConfirmation('exit', view.execution.hazards)) {
      dispatch({ kind: 'confirmation-requested', pending: { kind: 'exit' } });
      return;
    }
    onExit();
  }, [dispatch, onExit, protection]);

  /** 确认一次待确认动作；`exit` 只结束前台进程，`cancel` 提交取消意图。 */
  const confirmPending = useCallback(
    (pending: Exclude<PendingConfirmation, null>) => {
      if (pending.kind === 'exit') {
        onExit();
        return;
      }
      if (pending.kind === 'exit-discard') {
        // 用户已明确同意丢弃：只清内存脏标记（不删持久记录），随后退出。
        protection.discardUnsaved();
        onExit();
        return;
      }
      void applyScopeControl('cancel');
    },
    [applyScopeControl, onExit, protection],
  );

  const runCommand = useCallback(
    async (command: CommandId, recipient?: string) => {
      const current = stateRef.current;
      const session = current.selectedSessionId;
      const reason=commandReason(command,{mode:snapshotRef.current?.mode??'route_planning',selectedSessionId:session,pasteBlocks:composerInputFor(current,session).pasteBlocks.length});
      if(reason){dispatch({kind:'notice',notice:reason});return;}
      if (current.overlayStack.at(-1) === 'command-palette') dispatch({ kind: 'overlay-close-top' });
      dispatch({kind:'review-view',tab:0,scroll:0,action:0});
      switch (command) {
        case 'answer':
          await openAnswerRef.current(); return;
        case 'paste': {
          const current = stateRef.current;
          updatePasteViewer({ draft: composerInputFor(current, current.selectedSessionId), block: 0, scroll: 0 });
          dispatch({ kind: 'overlay-open', overlay: 'paste-viewer' }); return;
        }
        case 'compact': {
          if (session === null) {
            dispatch({ kind: 'notice', notice: '/compact 需要先选中一个 Coordinator Session' });
            return;
          }
          const result = await ports.execute({
            kind: 'compact-session',
            coordinatorSessionId: session,
            reason: 'user-requested',
          });
          dispatch({ kind: 'notice', notice: resultNotice(result) });
          await reload();
          return;
        }
        case 'model-picker': {
          setModelRejection(null);
          setModelCatalog(await ports.modelCatalog.load());
          dispatch({ kind: 'overlay-open', overlay: 'model-picker' });
          return;
        }
        case 'handoff': {
          if(recipient===undefined){dispatch({kind:'handoff-target',command:'handoff'});dispatch({kind:'overlay-open',overlay:'handoff-target'});return;}
          const target=recipient;
          const result = await ports.handoff.prepareProposal(target);
          dispatch({ kind: 'notice', notice: resultNotice(result) });
          if (result.kind === 'accepted') {
            const loaded = await ports.snapshot(stateRef.current.selectedSessionId);
            if (loaded.kind === 'snapshot') {
              setSnapshot(loaded.snapshot);
              setHandoffProposalId(
                loaded.snapshot.planningHandoffs.find(
                  (entry) => entry.phase === 'prepared' || entry.phase === 'reviewed',
                )?.proposalId ?? null,
              );
            }
            dispatch({ kind: 'overlay-open', overlay: 'handoff-review' });
          }
          return;
        }
        case 'session-picker': {
          dispatch({ kind: 'overlay-open', overlay: 'session-picker' });
          return;
        }
        case 'event-drawer':
        case 'project':
          dispatch({kind:'project-panel',panel:{...stateRef.current.projectPanel,open:true,tab:command==='event-drawer'?2:0,selectedKey:command==='event-drawer'?'event:'+events.at(-1)?.eventId:null,detail:null,scroll:0}});
          return;
        case 'options': dispatch({kind:'overlay-open',overlay:'options'}); return;
        case 'statusline': dispatch({kind:'notice',notice:'用户级状态栏设置尚未接通'});return;
        case 'graph-inspector':
          dispatch({ kind: 'overlay-open', overlay: 'graph-inspector' });
          return;
        case 'toggle-sidebar':
          dispatch({
            kind: 'sidebar-toggle',
            allowed: allowedSidebarDensity(terminalWidth),
          });
          return;
        case 'help':
          dispatch({
            kind: 'notice',
            notice: HELP_LINES[0] + ' · ' + COMMAND_IDS.map(id=>COMMAND_METADATA[id].alias).filter(Boolean).map(alias=>'/'+alias).join(' '),
          });
          return;
        case 'pause':
        case 'resume':
        case 'cancel':
          requestScopeControl(command);
          return;
        case 'execution-handoff': {
          if(recipient===undefined){dispatch({kind:'handoff-target',command:'execution-handoff'});dispatch({kind:'overlay-open',overlay:'handoff-target'});return;}
          const target=recipient;
          const prepared = await ports.executionHandoff.prepare(target);
          dispatch({ kind: 'notice', notice: resultNotice(prepared) });
          if (prepared.kind !== 'accepted') {
            return;
          }
          const loaded = await ports.snapshot(stateRef.current.selectedSessionId);
          if (loaded.kind !== 'snapshot') {
            return;
          }
          setSnapshot(loaded.snapshot);
          // 待审阅的记录优先取 prepared/reviewed；没有可推进的记录时把 blocked 记录也展示出来，
          // 否则 fail closed 只留下「没有待审阅的记录」这句无信息量的提示。
          const candidate =
            loaded.snapshot.handoffs.find(
              (handoff) => handoff.phase === 'prepared' || handoff.phase === 'reviewed',
            ) ??
            loaded.snapshot.handoffs.find((handoff) => handoff.phase === 'blocked') ??
            null;
          let record = candidate;
          if (candidate !== null && candidate.phase === 'prepared') {
            // 复核由宿主读好权威事实后提交；失败即写入 blocked，Source 保持唯一 owner。
            const reviewed = await ports.executionHandoff.review(candidate.handoffId);
            dispatch({ kind: 'notice', notice: resultNotice(reviewed) });
            const after = await ports.snapshot(stateRef.current.selectedSessionId);
            if (after.kind === 'snapshot') {
              setSnapshot(after.snapshot);
              record =
                after.snapshot.handoffs.find((handoff) => handoff.handoffId === candidate.handoffId) ??
                candidate;
            }
          }
          dispatch({ kind: 'execution-handoff-review', handoffId: record?.handoffId ?? null });
          dispatch({ kind: 'overlay-open', overlay: 'execution-handoff-review' });
          return;
        }
        case 'authorize-execution': {
          // 审阅事实由宿主现读现算：界面只显示它、只回传指纹，不组装也不缓存第二份 Manifest。
          const loaded = await ports.executionAuthorization.review();
          setAuthorizationReview(loaded);
          if (loaded.kind !== 'review') {
            dispatch({ kind: 'notice', notice: `${loaded.code}: ${loaded.message}` });
          }
          dispatch({ kind: 'overlay-open', overlay: 'authorization-review' });
          return;
        }
        case 'filter-execution': {
          const next = nextExecutionFilter(stateRef.current.executionFilter);
          dispatch({ kind: 'execution-filter-changed', filter: next });
          dispatch({
            kind: 'notice',
            notice: `执行图过滤：${executionFilterLabel(next)}（只隐藏节点，不改变顺序）`,
          });
          return;
        }
        case 'exit':
          requestExit();
          return;
        case 'input-record-manager': {
          const scope = coordScopeRef.current;
          if (scope === null) {
            dispatch({ kind: 'notice', notice: '尚未确定 Coordination Scope，无法打开输入记录管理' });
            return;
          }
          const listed = protection.list(scope);
          if (listed.status === 'failed') {
            dispatch({ kind: 'notice', notice: `输入记录读取失败：${listed.code} ${listed.message}` });
            return;
          }
          setInputManager({
            entries: inputManagerEntriesOf(listed.records, listed.invalidRecords),
            usage: listed.usage,
            selectedIndex: 0,
            bodyScroll: 0,
            bodyFocus: false,
            feedback: null,
            confirmDelete: false,
          });
          dispatch({ kind: 'overlay-open', overlay: 'input-record-manager' });
          return;
        }
      }
    },
    [dispatch, events, ports, protection, reload, requestExit, requestScopeControl, terminalWidth],
  );
  runCommandRef.current = runCommand;

  /** 重新读该 Scope 的输入记录并刷新 overlay；读取失败只更新反馈，不伪造空列表。 */
  const refreshInputManager = useCallback((): void => {
    const scope = coordScopeRef.current;
    if (scope === null) {
      return;
    }
    const listed = protection.list(scope);
    if (listed.status === 'failed') {
      setInputManager((current) =>
        current === null ? null : { ...current, feedback: `${listed.code}: ${listed.message}`, confirmDelete: false },
      );
      return;
    }
    const entries = inputManagerEntriesOf(listed.records, listed.invalidRecords);
    setInputManager((current) => ({
      entries,
      usage: listed.usage,
      selectedIndex: Math.min(current?.selectedIndex ?? 0, Math.max(0, entries.length - 1)),
      bodyScroll: 0,
      bodyFocus: current?.bodyFocus ?? false,
      feedback: current?.feedback ?? null,
      confirmDelete: false,
    }));
  }, [protection]);

  /** 恢复选中记录：只作用于它自己的目标；只有该目标正是当前 composer 时才刷新显示。 */
  const restoreInputRecord = useCallback((): void => {
    const entry = selectedInputEntry(inputManagerRef.current);
    if (entry === null) {
      return;
    }
    if (entry.kind === 'invalid') {
      setInputManager((current) => (current === null ? null : { ...current, feedback: '不可读记录只能删除' }));
      return;
    }
    const outcome = protection.adoptRecord(entry.record);
    if (outcome.status === 'saved') {
      const target = currentInputTarget(stateRef.current, coordScopeRef.current);
      if (target !== null && sameInputTarget(target, entry.record.target)) {
        dispatch(draftActionFor(target, entry.record.draft));
      }
    }
    setInputManager((current) =>
      current === null
        ? null
        : {
            ...current,
            feedback:
              outcome.status === 'saved'
                ? `已把 ${entry.record.kind} 记录的正文恢复为该目标的草稿`
                : `恢复失败：${saveOutcomeText(outcome)}`,
          },
    );
    refreshInputManager();
  }, [dispatch, protection, refreshInputManager]);

  /** 核验选中提交：`accepted` 立即清理记录；其余按结论如实回写，不猜测、不盲重试。 */
  const verifyInputRecord = useCallback(async (): Promise<void> => {
    let entry = selectedInputEntry(inputManagerRef.current);
    if (entry !== null && entry.kind === 'invalid') {
      // spec 的「不可读记录重新核验入口」：先重读该 Scope，能解析出来就按同一身份继续核验。
      const scope = coordScopeRef.current;
      const invalidKey = entry.key;
      const listed = scope === null ? null : protection.list(scope);
      refreshInputManager();
      const reread =
        listed === null || listed.status !== 'ok'
          ? null
          : (inputManagerEntriesOf(listed.records, listed.invalidRecords).find((candidate) =>
              candidate.kind === 'record' ? candidate.record.key === invalidKey : candidate.key === invalidKey,
            ) ?? null);
      entry = reread;
      if (entry === null || entry.kind !== 'record') {
        setInputManager((current) =>
          current === null
            ? null
            : { ...current, feedback: '记录仍不可读：已重新读取，仍无法解析，可显式删除' },
        );
        return;
      }
    }
    if (entry === null || entry.kind !== 'record') {
      setInputManager((current) => (current === null ? null : { ...current, feedback: '只有有效记录可以核验' }));
      return;
    }
    const query = submissionQueryFor(entry.record);
    if (query === null) {
      setInputManager((current) => (current === null ? null : { ...current, feedback: '只有待核验提交可以核验' }));
      return;
    }
    let status: SubmissionStatus;
    try {
      status = await ports.submissionStatus(query);
    } catch (error) {
      status = { kind: 'unverifiable', reason: error instanceof Error ? error.message : String(error) };
    }
    let feedback: string;
    if (status.kind === 'accepted') {
      const removed = protection.removeRecord(entry.record.key, entry.record.revision);
      feedback =
        removed.status === 'saved'
          ? `已受理（${status.ref.kind}:${status.ref.id}）并已清理记录`
          : `已受理，但记录清理失败：${saveOutcomeText(removed)}`;
    } else if (status.kind === 'not-found') {
      feedback = '未发现该提交：保持待核验';
    } else if (status.kind === 'conflict') {
      const marked = protection.markVerified({
        key: entry.record.key,
        status: 'conflict',
        reason: `${status.code}: ${status.message}`,
      });
      feedback = marked.status === 'saved' ? `内容冲突：${status.code}` : `核验结论未落盘：${saveOutcomeText(marked)}`;
    } else {
      const marked = protection.markVerified({
        key: entry.record.key,
        status: 'unverifiable',
        reason: status.reason,
      });
      feedback = marked.status === 'saved' ? `不可核验：${status.reason}` : `核验结论未落盘：${saveOutcomeText(marked)}`;
    }
    refreshInputManager();
    setInputManager((current) => (current === null ? null : { ...current, feedback }));
  }, [ports, protection, refreshInputManager]);

  /** 删除选中记录（二次确认）：一次同步 CAS 删除，不替用户覆盖别的新草稿。 */
  const deleteInputRecord = useCallback((): void => {
    const view = inputManagerRef.current;
    const entry = selectedInputEntry(view);
    if (view === null || entry === null) {
      return;
    }
    if (!view.confirmDelete) {
      setInputManager((current) => (current === null ? null : { ...current, confirmDelete: true }));
      return;
    }
    const key = entry.kind === 'record' ? entry.record.key : entry.key;
    const revision = entry.kind === 'record' ? entry.record.revision : entry.revision;
    const removed = protection.removeRecord(key, revision);
    setInputManager((current) =>
      current === null
        ? null
        : {
            ...current,
            confirmDelete: false,
            feedback: removed.status === 'saved' ? '记录已删除' : `删除失败：${saveOutcomeText(removed)}`,
          },
    );
    refreshInputManager();
  }, [protection, refreshInputManager]);

  const moveInputManagerSelection = useCallback((delta: number): void => {
    setInputManager((current) => {
      if (current === null) {
        return current;
      }
      const last = Math.max(0, current.entries.length - 1);
      return {
        ...current,
        selectedIndex: Math.min(Math.max(0, current.selectedIndex + delta), last),
        bodyScroll: 0,
        confirmDelete: false,
      };
    });
  }, []);

  const scrollInputManagerBody = useCallback((delta: number): void => {
    setInputManager((current) =>
      current === null ? null : { ...current, bodyScroll: Math.max(0, current.bodyScroll + delta) },
    );
  }, []);

  const confirmHandoff = useCallback(async () => {
    const proposal =
      viewModelRef.current?.planningHandoffs.find((entry) => entry.proposalId === handoffProposalId) ?? null;
    if (proposal === null) {
      dispatch({ kind: 'overlay-close-top' });
      return;
    }
    const result = await ports.handoff.cutover(proposal.proposalId);
    dispatch({ kind: 'notice', notice: resultNotice(result) });
    if (result.kind === 'accepted') {
      dispatch({ kind: 'overlay-close-top' });
      // cutover 后 Source transcript 只读，并自动选中 Target（激活门由应用层判定）。
      dispatch({ kind: 'session-read-only', coordinatorSessionId: proposal.sourceSessionId });
      dispatch({ kind: 'session-selected', coordinatorSessionId: proposal.targetSessionId });
      dispatch({ kind: 'notice', notice: 'cutover 完成：等待你在 Target 发送下一条普通 Prompt' });
      await reload();
    }
  }, [dispatch, handoffProposalId, ports, reload]);

  /** Execution Handoff 的 cutover 确认；失败即 fail closed，Source 保持唯一 owner。 */
  const confirmExecutionHandoff = useCallback(async () => {
    const handoffId = stateRef.current.executionHandoffReviewId;
    if (handoffId === null) {
      dispatch({ kind: 'overlay-close-top' });
      return;
    }
    const record =
      viewModelRef.current?.execution.handoffs.find((handoff) => handoff.handoffId === handoffId) ?? null;
    if (record !== null && record.phase !== 'reviewed') {
      // 只有复核通过的记录才允许 cutover：fail closed 由界面与宿主两层一起保证。
      dispatch({
        kind: 'notice',
        notice: `交接处于 ${record.phase}，不能 cutover（Source 仍是唯一 owner）`,
      });
      await reload();
      return;
    }
    const result = await ports.executionHandoff.cutover(handoffId);
    dispatch({ kind: 'notice', notice: resultNotice(result) });
    if (result.kind !== 'accepted' || record === null) {
      await reload();
      return;
    }
    dispatch({ kind: 'overlay-close-top' });
    dispatch({ kind: 'execution-handoff-review', handoffId: null });
    // cutover 后 Source transcript 转为只读并自动选中 Target；Target 保持 awaiting_user_prompt。
    dispatch({ kind: 'session-read-only', coordinatorSessionId: record.sourceSessionId });
    dispatch({ kind: 'session-selected', coordinatorSessionId: record.targetSessionId });
    dispatch({ kind: 'notice', notice: 'cutover 完成：Target 处于 awaiting_user_prompt' });
    await reload();
  }, [dispatch, ports, reload]);

  const cancelExecutionHandoff = useCallback(async () => {
    const handoffId = stateRef.current.executionHandoffReviewId;
    if (handoffId !== null) {
      const result = await ports.executionHandoff.cancel(handoffId);
      dispatch({ kind: 'notice', notice: resultNotice(result) });
    }
    dispatch({ kind: 'overlay-close-top' });
    dispatch({ kind: 'execution-handoff-review', handoffId: null });
    await reload();
  }, [dispatch, ports, reload]);

  /**
   * 批准 Execution Authorization 并原子切换到 Execution Coordination。
   *
   * 只回传用户在审阅里看到的指纹与 Scope revision：宿主重读全部权威输入后才写入批准与切换，因此
   * 界面无法把「旧内容」当成批准对象，也无法跳过门禁。
   */
  const confirmAuthorization = useCallback(async () => {
    const load = authorizationReview;
    if (load === null || load.kind !== 'review' || !load.review.gate.ready) {
      dispatch({ kind: 'notice', notice: '当前没有可批准的完整 Manifest（门禁未通过或事实不可读）' });
      return;
    }
    const result = await ports.executionAuthorization.approve({
      fingerprint: load.review.fingerprint,
      expectedRevision: load.review.scopeRevision,
    });
    dispatch({ kind: 'notice', notice: resultNotice(result) });
    if (result.kind === 'accepted') {
      dispatch({ kind: 'overlay-close-top' });
      setAuthorizationReview(null);
      await reload();
      return;
    }
    // 拒绝或阻塞时重读审阅事实：规划引用可能已经变化，用户需要看到新指纹再决定。
    setAuthorizationReview(await ports.executionAuthorization.review());
  }, [authorizationReview, dispatch, ports, reload]);

  const cancelAuthorization = useCallback(() => {
    dispatch({ kind: 'overlay-close-top' });
    setAuthorizationReview(null);
  }, [dispatch]);

  const cancelHandoff = useCallback(async () => {
    if (handoffProposalId === null) {
      dispatch({ kind: 'overlay-close-top' });
      return;
    }
    const result = await ports.handoff.cancel(handoffProposalId);
    dispatch({ kind: 'notice', notice: resultNotice(result) });
    dispatch({ kind: 'overlay-close-top' });
    await reload();
  }, [dispatch, handoffProposalId, ports, reload]);

  const runChecks = useCallback(async () => {
    const verified = await ports.scopeSetup.verify();
    setChecks(verified);
    if (verified.every((check) => check.ok)) {
      setProposal(await ports.scopeSetup.proposal());
    }
  }, [ports]);

  const confirmWizard = useCallback(async () => {
    if (proposal === null || !allChecksPassed(checks)) {
      return;
    }
    // 同步闩锁：`setConfirmed` 是异步的，挡不住同一 tick 的第二次 Enter。初始化必须恰好一次。
    if (wizardSubmittingRef.current) {
      return;
    }
    wizardSubmittingRef.current = true;
    setConfirmed(true);
    const result = await ports.scopeSetup.initialize(proposal);
    if (result.kind === 'accepted') {
      setScopeId(proposal.coordinationScopeId);
      return;
    }
    wizardSubmittingRef.current = false;
    setConfirmed(false);
    setBlocker(resultNotice(result) ?? '初始化被拒绝');
  }, [checks, proposal, ports]);

  /**
   * 旧记录的一次性迁移：只有用户在 Review 里确认后才提交。成功时宿主已经写入绑定并把它登记为当前
   * Scope，界面随后才切换到它；失败时停留在 Review 并显示结构化原因。
   */
  const confirmLegacyScope = useCallback(
    async (coordinationScopeId: string) => {
      const result = await ports.scopeSetup.bindLegacyIdentity(coordinationScopeId);
      if (result.kind === 'accepted') {
        setLegacyNotice(null);
        setScopeId(coordinationScopeId);
        return;
      }
      setLegacyNotice(resultNotice(result) ?? '迁移被拒绝');
    },
    [ports],
  );

  // 路由必须读**同步镜像**：同一批按键里 `Ctrl+P` 之后紧跟的方向键/Enter 不能等到下一次渲染才知道
  // 覆盖层已经打开（那会把命令投给 composer）。渲染本身仍用下面 `state` 派生出的值。
  const topOverlay = (): OverlayKind | null => stateRef.current.overlayStack.at(-1) ?? null;
  const workspaceActions: WorkspaceActions = {
    dispatch,
    composerChange: (draft) => {
      const target = currentInputTarget(stateRef.current, coordScopeRef.current);
      if (target === null) {
        return;
      }
      answerRequest.current++;
      // 编辑只更新内存与合并计时器；真正的持久写入由保护模块在窗口到期时执行。
      protection.edit(target, draft);
      dispatch(draftActionFor(target, draft));
      dispatch({kind:'slash-view',index:0,dismissed:false});
    },
    submit: () => {
      void submit();
    },
    toggleTool: (entryId) => dispatch({ kind: 'tool-toggled', entryId }),
    selectSession: (coordinatorSessionId) => {
      // 切 Session 前立即保存当前输入；失败如实提示，输入仍保留在内存。
      if (protection.hasUnsaved()) {
        const flushed = protection.flushAll();
        if (flushed.status !== 'saved') {
          dispatch({ kind: 'notice', notice: `切换前输入未保存：${saveOutcomeText(flushed)}` });
        }
      }
      dispatch({ kind: 'session-selected', coordinatorSessionId });
      answerRequest.current++;
      updateAnswerPanel(null);
      dispatch({ kind: 'overlay-close-top' });
    },
    enterAnswer: (interactionId, expectedRevision) => {
      // 进入回答模式前先把当前草稿落盘，避免模式切换丢掉未保存输入。
      if (protection.hasUnsaved()) {
        const flushed = protection.flushAll();
        if (flushed.status !== 'saved') {
          dispatch({ kind: 'notice', notice: `进入回答模式前输入未保存：${saveOutcomeText(flushed)}` });
        }
      }
      void expectedRevision;
      void openAnswerRef.current(interactionId);
    },
    runCommand: (command) => {
      void runCommand(command);
    },
    selectRecipient: (coordinatorSessionId) => {
      dispatch({kind:'overlay-close-top'});
      void runCommand(stateRef.current.handoffCommand,coordinatorSessionId);
    },
    selectModel: (configurationRef) => {
      void (async () => {
        const session = stateRef.current.selectedSessionId;
        if (session === null) {
          return;
        }
        const result = await ports.execute({
          kind: 'switch-model-configuration',
          coordinatorSessionId: session,
          nextConfigurationRef: configurationRef,
        });
        setModelRejection(result.kind === 'accepted' ? null : (resultNotice(result) ?? null));
        if (result.kind === 'accepted') {
          dispatch({ kind: 'overlay-close-top' });
          await reload();
        }
      })();
    },
    confirmPending: () => {
      const pending = stateRef.current.pendingConfirmation;
      if (pending === null) return;
      dispatch({ kind: 'confirmation-dismissed' });
      confirmPending(pending);
    },
    dismissPending: () => dispatch({ kind: 'confirmation-dismissed' }),
    confirmHandoff: () => {
      void confirmHandoff();
    },
    cancelHandoff: () => {
      void cancelHandoff();
    },
    confirmExecutionHandoff: () => {
      void confirmExecutionHandoff();
    },
    cancelExecutionHandoff: () => {
      void cancelExecutionHandoff();
    },
    confirmAuthorization: () => {
      void confirmAuthorization();
    },
    cancelAuthorization: () => {
      cancelAuthorization();
    },
    closeTopOverlay: () => dispatch({ kind: 'overlay-close-top' }),
  };

  useInput((input, key) => {
    if (key.eventType === 'release') return;
    // 待确认动作独占输入；y/n 沿原 ConfirmInput，方向键与 Enter 使用默认返回的动作栏。
    const pending = stateRef.current.pendingConfirmation;
    if (pending !== null) {
      if (key.escape === true) {
        dispatch({ kind: 'confirmation-dismissed' });
      }
      else if (key.tab) dispatch({kind:'review-view',tab:stateRef.current.reviewTab===0?1:0,scroll:0});
      else if (key.upArrow||key.downArrow||key.pageUp||key.pageDown) dispatch({kind:'review-view',scroll:Math.max(0,stateRef.current.reviewScroll+(key.upArrow||key.pageUp?-1:1)*(key.pageUp||key.pageDown?8:1))});
      else if (key.leftArrow||key.rightArrow) dispatch({kind:'review-view',action:stateRef.current.reviewAction===0?1:0});
      else if (key.return) {
        if(stateRef.current.reviewAction===0) dispatch({kind:'confirmation-dismissed'});
        else workspaceActions.confirmPending();
      }
      return;
    }
    const action = resolveGlobalAction(input, key);
    if (action === 'exit') {
      // Exit 与 `Ctrl+C` 只结束前台进程；Scope 不因此进入暂停或取消。
      requestExit();
      return;
    }
    if (action === 'escape') {
      answerRequest.current++;
      if (topOverlay() === 'input-record-manager') {
        if (inputManagerRef.current?.bodyFocus === true) {
          // 正文视口里的 Esc 只返回列表，不关闭 overlay，也不把 `/` 输入变成聊天。
          setInputManager((current) => (current === null ? null : { ...current, bodyFocus: false }));
          return;
        }
        setInputManager(null);
        dispatch({ kind: 'overlay-close-top' });
        return;
      }
      if(topOverlay()==='graph-inspector'&&stateRef.current.inspectorRelations){dispatch({kind:'inspector-view',relations:null});return;}
      if(topOverlay()==='graph-inspector'&&stateRef.current.inspectorDetail){dispatch({kind:'inspector-view',detail:false,scroll:0});return;}
      if (stateRef.current.overlayStack.length > 0) {
        dispatch({ kind: 'overlay-close-top' });
        return;
      }
      const project=stateRef.current.projectPanel;
      if(project.open){dispatch({kind:'project-panel',panel:project.detail?{...project,detail:null,scroll:0}:{...project,open:false}});return;}
      const draft=composerInputFor(stateRef.current,stateRef.current.selectedSessionId);
      if(!stateRef.current.slashDismissed&&slashCandidates(draft.text,snapshotRef.current?.mode??'route_planning').length){dispatch({kind:'slash-view',index:0,dismissed:true});return;}
      if (stateRef.current.composerMode.kind === 'answer') {
        const saved = protection.flushAll();
        if (saved.status !== 'saved') { dispatch({ kind: 'notice', notice: saveOutcomeText(saved) }); return; }
        updateAnswerPanel(null);
        dispatch({ kind: 'composer-mode-reset' });
        return;
      }
      if (stateRef.current.screen === 'wizard' || stateRef.current.screen === 'legacy-review') {
        dispatch({ kind: 'screen', screen: 'home' });
      }
      return;
    }
    const overlay = topOverlay();
    // 任何 overlay 都优先消费输入：全局导航键（Ctrl+P/B/G/T、Shift+Left）不穿透到调用的工作区。
    // Esc 逐层返回与 Ctrl+C 退出在上面单独处理，因此关闭弹窗与退出保留。
    if (overlay !== null && (action === 'command-palette' || action === 'toggle-sidebar' || action === 'graph-inspector' || action === 'enter-answer' || action === 'toggle-tool')) return;
    if (stateRef.current.screen === 'workspace' && topOverlay() === null && answerPanelRef.current && key.shift && (key.leftArrow || key.rightArrow)) {
      void navigateAnswer(key.leftArrow ? -1 : 1); return;
    }
    if (action === 'command-palette') {
      answerRequest.current++;
      paletteSelection.set(0);
      dispatch({ kind: 'overlay-open', overlay: 'command-palette' });
      return;
    }
    if (action === 'toggle-sidebar') {
      dispatch({kind:'project-panel',panel:{...stateRef.current.projectPanel,open:!stateRef.current.projectPanel.open}});
      return;
    }
    if (action === 'graph-inspector') {
      answerRequest.current++;
      void runCommand('graph-inspector');
      return;
    }
    if (action === 'enter-answer') {
      if (stateRef.current.screen === 'workspace') void openAnswerRef.current();
      return;
    }

    if (stateRef.current.screen === 'legacy-review') {
      // Review 屏只接受 Enter（确认迁移）；Esc 由上面的通用分支退回候选列表。
      if (key.return === true) {
        const candidate = candidates[homeSelection.current()];
        if (candidate !== undefined) {
          void confirmLegacyScope(candidate.coordinationScopeId);
        }
      }
      return;
    }
    if (stateRef.current.screen === 'home') {
      handleHomeKey(input, key, {
        candidates,
        cursor: homeSelection,
        onOpenLegacyReview: () => dispatch({ kind: 'screen', screen: 'legacy-review' }),
        onStartWizard: () => {
          dispatch({ kind: 'screen', screen: 'wizard' });
          void runChecks();
        },
      });
      return;
    }
    if (stateRef.current.screen === 'wizard') {
      handleWizardKey(input, key, { runChecks, confirmWizard });
      return;
    }
    if (topOverlay() === 'command-palette') {
      handlePaletteKey(key, { commands: COMMAND_IDS, cursor: paletteSelection, run: (command) => { void runCommand(command); } });
      return;
    }
    if (topOverlay() === 'model-picker') {
      return;
    }
    if (topOverlay() === 'graph-inspector') {
      const current=stateRef.current;
      if(key.tab){dispatch({kind:'inspector-view',tab:(current.inspectorTab+1)%3,scroll:0});return;}
      if(key.pageUp||key.pageDown){dispatch({kind:'inspector-view',scroll:Math.max(0,current.inspectorScroll+(key.pageUp?-1:1))});return;}
      if(current.inspectorRelations){
        if(key.upArrow||key.downArrow)dispatch({kind:'inspector-view',relationIndex:Math.max(0,Math.min(current.inspectorRelations.length-1,current.relationIndex+(key.upArrow?-1:1)))});
        if(key.return){const id=current.inspectorRelations[current.relationIndex],graph=viewModelRef.current?.graph??null,node=selectedGraphNode(graph,current.inspectorSelection),target=graph?.nodes.find(n=>n.workPackageId===id);
          if(target&&node&&(node.dependsOn.includes(target.workPackageId)||target.dependsOn.includes(node.workPackageId)))dispatch({kind:'inspector-selected',workPackageId:target.workPackageId});
          else dispatch({kind:'notice',notice:'所选关系已改变，请重新选择'});
          dispatch({kind:'inspector-view',relations:null,scroll:0});}return;
      }
      if(key.return){dispatch({kind:'inspector-view',detail:!current.inspectorDetail,scroll:0});return;}
      if(current.inspectorDetail&&(key.upArrow||key.downArrow)){dispatch({kind:'inspector-view',scroll:Math.max(0,current.inspectorScroll+(key.upArrow?-1:1))});return;}
      if(key.leftArrow||key.rightArrow){const graph=viewModelRef.current?.graph??null,nodes=graph?.nodes??[],node=selectedGraphNode(graph,current.inspectorSelection);
        if(!node){dispatch({kind:'notice',notice:'所选节点已不在当前图中，请重新选择'});return;}
        if(current.inspectorSelection===null)dispatch({kind:'inspector-selected',workPackageId:node.workPackageId});
        const ids=node?(key.rightArrow?node.dependsOn:nodes.filter(n=>n.dependsOn.includes(node.workPackageId)).map(n=>n.workPackageId)):[];
        if(ids.length===1&&ids[0])dispatch({kind:'inspector-selected',workPackageId:ids[0]});else if(ids.length>1)dispatch({kind:'inspector-view',relations:ids,relationIndex:0});return;}
      handleInspectorKey(key, {
        nodes: viewModelRef.current?.graph?.nodes ?? [],
        selection: selectedGraphNode(viewModelRef.current?.graph??null,stateRef.current.inspectorSelection)?.workPackageId??stateRef.current.inspectorSelection,
        select: (workPackageId) => dispatch({ kind: 'inspector-selected', workPackageId }),
      });
      return;
    }
    if (topOverlay() === 'session-picker' || topOverlay() === 'handoff-target') {
      return;
    }
    if (topOverlay() === 'input-record-manager') {
      const view = inputManagerRef.current;
      if (view !== null && view.bodyFocus) {
        // 正文视口接管方向键与 Enter；Esc 已在上面的分支返回列表。
        if (key.upArrow === true) {
          scrollInputManagerBody(-1);
          return;
        }
        if (key.downArrow === true) {
          scrollInputManagerBody(1);
          return;
        }
        if (key.return === true) {
          setInputManager((current) => (current === null ? null : { ...current, bodyFocus: false }));
        }
        return;
      }
      if (key.upArrow === true) {
        moveInputManagerSelection(-1);
        return;
      }
      if (key.downArrow === true) {
        moveInputManagerSelection(1);
        return;
      }
      if (key.return === true) {
        setInputManager((current) => (current === null ? null : { ...current, bodyFocus: true, bodyScroll: 0 }));
        return;
      }
      if (input === 'r') {
        restoreInputRecord();
        return;
      }
      if (input === 'v') {
        void verifyInputRecord();
        return;
      }
      if (input === 'd') {
        deleteInputRecord();
        return;
      }
      if (input === 'n' && view?.confirmDelete === true) {
        setInputManager((current) => (current === null ? null : { ...current, confirmDelete: false }));
        return;
      }
      if (input === 'y' && view?.confirmDelete === true) {
        deleteInputRecord();
        return;
      }
      return;
    }
    if (action === 'toggle-tool') {
      const entries = viewModelRef.current?.transcript.entries ?? [];
      const lastTool = [...entries].reverse().find((entry) => entry.kind === 'tool');
      if (lastTool === undefined) {
        return;
      }
      dispatch({ kind: 'tool-toggled', entryId: lastTool.id });
      return;
    }
    if (topOverlay() === 'paste-viewer') {
      const viewer = pasteViewerRef.current;
      if (!viewer) return;
      if (key.leftArrow || key.rightArrow) updatePasteViewer({ ...viewer, block: Math.max(0, Math.min(viewer.draft.pasteBlocks.length - 1, viewer.block + (key.leftArrow ? -1 : 1))), scroll: 0 });
      if (key.upArrow || key.downArrow || key.pageUp || key.pageDown) {
        const block = viewer.draft.pasteBlocks[viewer.block];
        const lines = block ? editorLayout(textDraft(viewer.draft.text.slice(block.start, block.end)), terminalWidth - 2).length : 1;
        updatePasteViewer({ ...viewer, scroll: Math.max(0, Math.min(lines - 1, viewer.scroll + (key.upArrow || key.pageUp ? -1 : 1) * (key.pageUp || key.pageDown ? 10 : 1))) });
      }
      return;
    }
    if(topOverlay()==='options'){ if(key.return)dispatch({kind:'icons',mode:stateRef.current.iconMode==='nerd'?'ascii':'nerd'});return; }
    if (topOverlay() !== null) {
      if(key.tab){dispatch({kind:'review-view',tab:(stateRef.current.reviewTab+1)%3,scroll:0});return;}
      if(key.upArrow||key.downArrow){dispatch({kind:'review-view',scroll:Math.max(0,stateRef.current.reviewScroll+(key.upArrow?-1:1))});return;}
      if(key.leftArrow||key.rightArrow){dispatch({kind:'review-view',action:stateRef.current.reviewAction===0?1:0});return;}
      if(key.return){
        if(stateRef.current.reviewAction===0){dispatch({kind:'overlay-close-top'});return;}
        if(topOverlay()==='handoff-review')void confirmHandoff();
        if(topOverlay()==='execution-handoff-review')void confirmExecutionHandoff();
        if(topOverlay()==='authorization-review')void confirmAuthorization();
      }
      return;
    }
    const project=stateRef.current.projectPanel;
    if(project.open){
      const view=viewModelRef.current;if(!view)return;
      if(key.tab){const tab=(project.tab+1)%3;dispatch({kind:'project-panel',panel:{...project,tab,detail:null,selectedKey:projectItems(view,events,tab)[0]?.key??null,scroll:0}});return;}
      if(project.detail){
        if(key.upArrow||key.downArrow){
          const layout=workspaceLayout(view,stateRef.current,terminalWidth,windowSize.rows??process.stdout.rows??24);
          const viewport=projectDetailViewport(view,events,project,layout.projectWidth,layout.bodyRows);
          dispatch({kind:'project-panel',panel:{...project,scroll:Math.max(0,Math.min(viewport.maxScroll,viewport.offset+(key.upArrow?-1:1)))}});
        }return;
      }
      const items=projectItems(view,events,project.tab),index=project.selectedKey===null?0:items.findIndex(i=>i.key===project.selectedKey);
      if(key.upArrow||key.downArrow){const item=items[Math.max(0,Math.min(items.length-1,index+(key.upArrow?-1:1)))];if(item)dispatch({kind:'project-panel',panel:{...project,selectedKey:item.key}});return;}
      if(key.return){const item=items[index];if(!item){dispatch({kind:'notice',notice:'所选对象已不在当前窗口，请重新选择'});return;}
        if(item.key==='pending'){dispatch({kind:'project-panel',panel:{...project,tab:1,selectedKey:null}});return;}
        if(item.key==='authorize'){void runCommand('authorize-execution');return;}
        const interaction=view.interactions.find(i=>i.interactionId===item.key);
        if(interaction?.ownerCoordinatorSessionId===stateRef.current.selectedSessionId&&interaction.state==='open'){
          void openAnswerRef.current(interaction.interactionId).then(opened=>{if(opened)dispatch({kind:'project-panel',panel:{...stateRef.current.projectPanel,open:false}});});return;
        }
        dispatch({kind:'project-panel',panel:{...project,detail:item.key,selectedKey:item.key,scroll:0}});
      }return;
    }
    const inputDraft=composerInputFor(stateRef.current,stateRef.current.selectedSessionId);
    const matches=stateRef.current.slashDismissed?[]:slashCandidates(inputDraft.text,snapshotRef.current?.mode??'route_planning');
    if(matches.length){
      if(key.upArrow||key.downArrow){dispatch({kind:'slash-view',index:Math.max(0,Math.min(matches.length-1,stateRef.current.slashIndex+(key.upArrow?-1:1))),dismissed:false});return;}
      if((key.return||key.tab)&&!key.meta&&!key.shift){
        const command=matches[Math.min(stateRef.current.slashIndex,matches.length-1)];
        if(command){const reason=commandReason(command,{mode:snapshotRef.current?.mode??'route_planning',selectedSessionId:stateRef.current.selectedSessionId,pasteBlocks:inputDraft.pasteBlocks.length});
          if(reason){dispatch({kind:'notice',notice:reason});return;}
          workspaceActions.composerChange(textDraft('/'+COMMAND_METADATA[command].alias));
          dispatch({kind:'slash-view',index:0,dismissed:true});
        }return;
      }
    }
    const panel = answerPanelRef.current;
    if (panel && stateRef.current.composerMode.kind === 'answer') {
      const options = panel.interaction.question?.options ?? [];
      if (key.tab) { updateAnswerPanel({ ...panel, focus: panel.focus === 'options' || !options.length ? 'text' : 'options' }); return; }
      if (key.pageUp || key.pageDown) {
        const lines = wrapByDisplayWidth(panel.interaction.question?.text ?? '', bodyWidth(terminalWidth, stateRef.current.sidebarDensity)).length;
        updateAnswerPanel({ ...panel, scroll: Math.max(0, Math.min(lines - 1, panel.scroll + (key.pageUp ? -3 : 3))) }); return;
      }
      if (panel.focus === 'options') {
        if (key.upArrow || key.downArrow) updateAnswerPanel({ ...panel, option: Math.max(0, Math.min(options.length - 1, panel.option + (key.upArrow ? -1 : 1))) });
        if (key.return && !key.meta && !key.shift && !isComposerReadOnly(stateRef.current, stateRef.current.selectedSessionId)) {
          const option = options[panel.option];
          if (option) { workspaceActions.composerChange(textDraft(option.label)); workspaceActions.submit(); }
        }
        return;
      }
    }
    if (key.ctrl && input === 'r') {
      dispatch({ kind: 'notice', notice: '历史搜索尚未接通' }); return;
    }
    handleComposerKey(input, key, {
      readOnly: isComposerReadOnly(stateRef.current, stateRef.current.selectedSessionId),
      draft: composerInputFor(stateRef.current, stateRef.current.selectedSessionId),
      width: composerContentWidth(bodyWidth(terminalWidth, stateRef.current.sidebarDensity)),
      change: workspaceActions.composerChange,
      submit: workspaceActions.submit,
    });
  });

  /**
   * 粘贴：只在工作区、无 overlay、无待确认动作、非只读且有明确目标时插入全文并立即保存。
   *
   * 它不触发发送或命令解析；换行归一，在当前光标插入，长载荷作为原子块编辑。
   */
  usePaste((text) => {
    const current = stateRef.current;
    if (current.screen !== 'workspace') {
      return;
    }
    if (current.pendingConfirmation !== null || current.overlayStack.length > 0 || current.projectPanel.open) {
      return;
    }
    if (isComposerReadOnly(current, current.selectedSessionId)) {
      return;
    }
    const target = currentInputTarget(current, coordScopeRef.current);
    if (target === null) {
      return;
    }
    const normalized = text.replace(/\r\n?/gu, '\n');
    if (normalized.length === 0) {
      return;
    }
    answerRequest.current++;
    dispatch({kind:'slash-view',index:0,dismissed:true});
    if (answerPanelRef.current) updateAnswerPanel({ ...answerPanelRef.current, focus: 'text' });
    const outcome = protection.paste(target, normalized);
    dispatch(draftActionFor(target, protection.draftOf(target) ?? emptyDraft()));
    if (outcome.status !== 'saved') {
      dispatch({ kind: 'notice', notice: `粘贴未保存：${saveOutcomeText(outcome)}（内容仍保留在内存中）` });
    }
  });

  if (state.screen === 'home' || state.screen === 'legacy-review') {
    return (
      <Home
        resolution={home}
        selectedIndex={homeSelection.value}
        reviewingLegacy={state.screen === 'legacy-review'}
        notice={legacyNotice}
        onStartWizard={() => {
          dispatch({ kind: 'screen', screen: 'wizard' });
          void runChecks();
        }}
        availableWidth={terminalWidth}
      />
    );
  }

  if (state.screen === 'wizard') {
    return (
      <Wizard
        checks={checks}
        proposal={proposal}
        confirmed={confirmed}
        blocker={blocker}
        onRunChecks={() => {
          void runChecks();
        }}
        onConfirm={() => {
          void confirmWizard();
        }}
        onCancel={() => dispatch({ kind: 'screen', screen: 'home' })}
        availableWidth={terminalWidth}
      />
    );
  }

  if (viewModel === null) {
    return (
      <Box flexDirection="column">
        <Text dimColor>正在加载 Coordination Scope 快照…</Text>
        {blocker === null ? null : <Text>{`! ${blocker}`}</Text>}
      </Box>
    );
  }

  return (
    <Workspace
      viewModel={viewModel}
      ui={state}
      terminalWidth={terminalWidth}
      terminalHeight={windowSize.rows ?? process.stdout.rows ?? 24}
      events={events}
      actions={workspaceActions}
      modelCatalog={modelCatalog}
      modelRejection={modelRejection}
      paletteSelection={paletteSelection.value}
      composerDisabledReason={
        viewModel.compaction?.status === 'context_exhausted'
          ? 'context_exhausted：已停止发起新的模型调用'
          : null
      }
      newlineHint="Alt+Enter 换行"
      handoffProposal={
        viewModel.planningHandoffs.find((entry) => entry.proposalId === handoffProposalId) ?? null
      }
      authorizationReview={authorizationReview}
      commands={COMMAND_IDS}
      inputManager={inputManager}
      answerPanel={state.composerMode.kind === 'answer' ? answerPanel : null}
      pasteViewer={pasteViewer}
    />
  );
}

type HomeKeyContext = {
  readonly candidates: readonly ScopeCandidate[];
  readonly cursor: SelectionCursor;
  readonly onOpenLegacyReview: () => void;
  readonly onStartWizard: () => void;
};

/**
 * Home 的键位：候选列表只列出**缺少绑定的旧记录**，因此 Enter 一律先打开迁移 Review，
 * 绝不直接进入某个 Scope。
 */
function handleHomeKey(
  input: string,
  key: { readonly upArrow?: boolean; readonly downArrow?: boolean; readonly return?: boolean },
  context: HomeKeyContext,
): void {
  if (key.upArrow === true) {
    context.cursor.move(-1, context.candidates.length - 1);
    return;
  }
  if (key.downArrow === true) {
    context.cursor.move(1, context.candidates.length - 1);
    return;
  }
  if (input === 'n') {
    context.onStartWizard();
    return;
  }
  if (key.return !== true) {
    return;
  }
  if (context.candidates[context.cursor.current()] === undefined) {
    return;
  }
  // 候选只列出缺少绑定的旧记录：Enter 一律先打开迁移 Review，绝不直接进入某个 Scope。
  context.onOpenLegacyReview();
}

function handleWizardKey(
  input: string,
  key: { readonly return?: boolean },
  context: { readonly runChecks: () => Promise<void>; readonly confirmWizard: () => Promise<void> },
): void {
  if (input === 'r') {
    void context.runChecks();
    return;
  }
  if (key.return === true) {
    void context.confirmWizard();
  }
}

function handlePaletteKey(
  key: { readonly upArrow?: boolean; readonly downArrow?: boolean; readonly return?: boolean },
  context: {
    readonly commands: readonly CommandId[];
    readonly cursor: SelectionCursor;
    readonly run: (command: CommandId) => void;
  },
): void {
  if (key.upArrow === true) {
    context.cursor.move(-1, context.commands.length - 1);
    return;
  }
  if (key.downArrow === true) {
    context.cursor.move(1, context.commands.length - 1);
    return;
  }
  if (key.return === true) {
    const command = context.commands[context.cursor.current()];
    if (command !== undefined) {
      context.run(command);
    }
  }
}

function handleInspectorKey(
  key: {
    readonly upArrow?: boolean;
    readonly downArrow?: boolean;
    readonly leftArrow?: boolean;
    readonly rightArrow?: boolean;
  },
  context: {
    readonly nodes: readonly {
      readonly workPackageId: string;
      readonly dependsOn: readonly string[];
    }[];
    readonly selection: string | null;
    readonly select: (workPackageId: string) => void;
  },
): void {
  const index = context.nodes.findIndex((node) => node.workPackageId === context.selection);
  if (key.downArrow === true) {
    const next = context.nodes[Math.min(context.nodes.length - 1, index + 1)];
    if (next !== undefined) {
      context.select(next.workPackageId);
    }
    return;
  }
  if (key.upArrow === true) {
    const next = context.nodes[Math.max(0, index <= 0 ? 0 : index - 1)];
    if (next !== undefined) {
      context.select(next.workPackageId);
    }
    return;
  }
}


export type ComposerKeyContext = {
  readonly readOnly: boolean;
  readonly draft: UiDraft;
  readonly width?: number;
  readonly change: (draft: UiDraft) => void;
  readonly submit: () => void;
};

/**
 * composer 输入。
 *
 * 普通字符只进入草稿；Enter 提交；Shift/Alt+Enter 换行由 `key.shift`/`key.meta` 判定，终端无法区分
 * 时回退为 Alt+Enter（提示里显示实际键位）。
 */
export function handleComposerKey(
  input: string,
  key: EditorKey,
  context: ComposerKeyContext,
): void {
  if (context.readOnly) {
    return;
  }
  if (key.return === true) {
    if (key.shift === true || key.meta === true) {
      context.change(editComposer(context.draft, input, key, context.width));
      return;
    }
    if (context.draft.text.trim()) context.submit();
    return;
  }
  const next = editComposer(context.draft, input, key, context.width);
  if (next !== context.draft) context.change(next);
}
