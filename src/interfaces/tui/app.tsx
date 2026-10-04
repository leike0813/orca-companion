/**
 * TUI 容器：唯一持有输入映射、加载与命令派发的地方。
 *
 * 硬边界：
 * - 所有加载都是只读 query；`execute` 只在用户明确动作（提交、命令、回答、切换模型、交接确认）时调用，
 *   因此 render/effect/resize/重挂载不可能触发恢复、派发、重试或写入；
 * - 事件只进入 Event Drawer 投影与未读标记，不切换 transcript、不抢占 composer、不改变 Scope 级图；
 * - 没有 TTY 判断：那发生在挂载 Ink 之前的 `src/bootstrap/tui-entry.ts`。
 */

import { Box, Text, useInput, usePaste, useWindowSize, useStdin, type Key } from 'ink';
import { ThemeProvider } from '@inkjs/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { resolveGlobalAction } from './input/keymap.js';
import { boundedQuery, searchCommands } from './commands.js';
import {
  candidateLabel,
  dedupeRoleCandidates,
  effortValues,
  modelRoleAdmission,
  modelRoles,
  modelSwitchAdmission,
  selectedRoleCandidate,
} from './components/model-picker.js';
import {
  editModelSettingsField,
  formatModelOptions,
  modelSettingsDraft,
  visibleModelSettingsFields,
} from './components/model-settings-editor.js';
import { CommandInvocations, type CommandOutcome, type MutationOutcome } from './command-invocations.js';
import type { ControllerPlanningHandoffView, ControllerHandoffView } from '../../application/controller-service.js';
import type { CommandResultRef } from '../../application/tui/command-result.js';
import type { AnswerPanelView } from './components/answer-panel.js';
import type { PasteViewerView } from './components/paste-viewer.js';
import type { ControllerInteractionView, ControllerQuestionResult } from '../../application/controller-service.js';
import type { InteractionPageCursor } from '../../application/ports/branch-coordination-store.js';
import { bodyWidth } from './screens/workspace.js';
import { TranscriptReader, type TranscriptFrame, type TranscriptAnchor } from './render/transcript-reader.js';
import { InputHistory, readHistoricalInput } from './input/input-history.js';
import { scanHistory } from '../../application/coordinator/history-search.js';
import type { HistorySearchHit, HistoryCall } from '../../application/coordinator/history-inspection.js';
import { userQuestionInteractionId } from '../../application/coordination/pending-interaction.js';
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
  type ModelRoleMenuState,
  type OverlayKind,
  type PendingConfirmation,
  type TuiAction,
  type TuiState,
  type AnswerReturnState,
} from './state.js';
import { Home } from './screens/home.js';
import { Wizard, allChecksPassed } from './screens/wizard.js';
import { Workspace, workspaceLayout, type WorkspaceActions } from './screens/workspace.js';
import { COMMAND_IDS, COMMAND_METADATA, commandReason, HELP_LINES, slashCandidates, parseSlashInput, type CommandId } from './components/command-palette.js';
import { projectItems, projectDetailViewport } from './components/project-panel.js';
import { selectedGraphNode } from './components/graph-inspector.js';
import { preferredSessionId, sessionChoices } from './components/session-picker.js';
import { filterChoices } from './components/selection-list.js';
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
  ModelRoleView,
  ModelSettingsSnapshotView,
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
      return result.summary;
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

type HistoryContext = {
  kind: 'transcript' | 'users' | 'activity'; session: string; query: UiDraft;
  anchor: TranscriptAnchor | null; detailed: boolean; expanded: readonly string[];
  upper: number; initialized: boolean; hit: HistorySearchHit | null; call: HistoryCall | null;
  hits: readonly HistorySearchHit[]; index: number; cursor: string | null; complete: boolean;
  feedback: string; busy: boolean; abort: AbortController;
};

function TuiAppContent(props: TuiAppProps) {
  const { ports, onExit } = props;
  // 终端宽度是渲染输入，不是业务状态：resize 只重算布局，不重新查询也不改变用户偏好。
  // 必须用 `useWindowSize`：它自己订阅 resize 并触发重渲染；只读 `stdout.columns` 在真实 PTY 里
  // 不会重排（实测 resize 后仍按旧宽度绘制），那会让中文混排与边框在新宽度下失配。
  const windowSize = useWindowSize();
  const terminalWidth = windowSize.columns === undefined ? props.terminalWidth : windowSize.columns;
  const [state, setState] = useState<TuiState>(initialTuiState);
  const navigationGeneration = useRef(0);
  const [commandInvocations] = useState(() => new CommandInvocations());
  const [events, setEvents] = useState<readonly SemanticEvent[]>([]);
  const [snapshot, setSnapshot] = useState<ControllerSnapshot | null>(null);
  const [transcript, setTranscript] = useState<ControllerTranscriptPage | null>(null);
  const [reader] = useState(() => new TranscriptReader(ports.reading));
  const [transcriptFrame, setTranscriptFrame] = useState<TranscriptFrame | null>(null);
  const [inputHistory] = useState(() => new InputHistory(ports.reading));
  const [historyPreview, setHistoryPreview] = useState<UiDraft | null>(null);
  const historyPreviewRef = useRef<UiDraft | null>(null);
  const [historyContext, setHistoryContext] = useState<HistoryContext | null>(null);
  const historyContextRef = useRef<HistoryContext | null>(null);
  const functionKeyRef = useRef<(action: 'search-history' | 'navigate-activity') => void>(() => {});
  const { stdin } = useStdin();
  useEffect(() => {
    const onData = (data: Buffer | string) => {
      const text = data.toString();
      // Ink's public useInput omits function-key names. Only these complete keys use stdin.
      if (text.charCodeAt(0) !== 27) return;
      const sequence = text.slice(1);
      if (/^(?:OR|\[R|\[13~|\[\[C|\[57366(?:;1)?u)$/u.test(sequence)) functionKeyRef.current('search-history');
      if (/^(?:OS|\[S|\[14~|\[\[D|\[57367(?:;1)?u)$/u.test(sequence)) functionKeyRef.current('navigate-activity');
    };
    stdin.on('data', onData);
    return () => { stdin.off('data', onData); historyContextRef.current?.abort.abort(); };
  }, [stdin]);
  useEffect(() => () => reader.dispose(), [reader]);
  useEffect(() => {
    inputHistory.cancel(); historyPreviewRef.current = null; setHistoryPreview(null);
    const context = historyContextRef.current;
    if (context !== null && context.session !== state.selectedSessionId) {
      context.abort.abort(); historyContextRef.current = null; setHistoryContext(null); reader.highlight(null);
    }
  }, [state.selectedSessionId, inputHistory, reader]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyUpdated, setHistoryUpdated] = useState(false);
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
  const modelMenuTarget = useRef<string | null>(null);
  const historyKeyRef = useRef<(kind: 'users' | 'transcript' | 'activity') => void>(() => {});
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog>(EMPTY_MODEL_CATALOG);
  const [modelRejection, setModelRejection] = useState<string | null>(null);
  /**
   * 角色模型配置的非秘密快照。
   *
   * 它只在打开编辑器时读一次并跟随编辑；渲染与 resize 不重读、不写入。快照本身不含任何秘密，
   * 用户新输入的 key 另存在 `modelSettingsEdit.secret`，只在内存中。
   */
  const modelSettingsSnapshot = useRef<ModelSettingsSnapshotView | null>(null);
  /**
   * 模型弹窗的调用代次。
   *
   * 载入、保存与应用都是异步的：结果只允许回到发起它的那一次打开。overlay 关闭、切换 Session 或
   * 重新打开时递增，因此迟到结果不会改写其他 Session 的选择、抢走焦点或把旧编辑写进新弹窗。
   */
  const modelInvocation = useRef(0);
  /**
   * 编辑版本与在途闸门。
   *
   * `modelEditVersion` 每次内存编辑变化都递增，因此「保存请求发出之后用户又改了字段」是可检测的：
   * 迟到成功不能抹掉这些后续输入。两个闸门保证同一次编辑不会并发提交两次，也就不会重复追加记录。
   */
  const modelEditVersion = useRef(0);
  const modelSaveInFlight = useRef(false);
  const modelApplyInFlight = useRef(false);
  const [planningReview, setPlanningReview] = useState<ControllerPlanningHandoffView | null>(null);
  const [executionReview, setExecutionReview] = useState<ControllerHandoffView | null>(null);
  const executionReviewRef = useRef<CommandResultRef | null>(null);
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
  const [scopeQuestions, setScopeQuestions] = useState<{ items: readonly ControllerInteractionView[]; page: number; hasPrevious: boolean; hasNext: boolean; loading: boolean; error: string | null }>({ items: [], page: 1, hasPrevious: false, hasNext: false, loading: false, error: null });
  const scopeQuestionPage = useRef<{ next: InteractionPageCursor | null; cursors: readonly (InteractionPageCursor | undefined)[] }>({ next: null, cursors: [undefined] });
  const scopeQuestionRequest = useRef(0);
  const scopeQuestionScope = useRef<string | null>(null);
  const answerReturn = useRef<{ state: AnswerReturnState; panel: AnswerPanelView | null; page: typeof answerPage.current; history: HistoryContext | null } | null>(null);
  const returnAnswerRef = useRef<() => boolean>(() => false);
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
    if(action.kind==='overlay-close-top'||action.kind==='overlay-close-all'||action.kind==='session-selected')navigationGeneration.current++;
    if (action.kind === 'model-settings-edit') modelEditVersion.current += 1;
    const next = reduceTuiState(stateRef.current, action);
    if (action.kind === 'overlay-close-top' || action.kind === 'overlay-close-all' || action.kind === 'session-selected') {
      // 离开模型弹窗的每一条路径（Esc、Command Palette 关闭、逐层返回、切换 Session）共用这一处：
      // 递增调用代次让迟到结果作废，并抹除内存中的 key。此后任何位置看到的都只是遮罩。
      modelInvocation.current += 1;
      const edit = stateRef.current.modelSettingsEdit;
      if (edit !== null && edit.secret !== '') {
        stateRef.current = { ...next, modelSettingsEdit: { ...edit, secret: '' } };
        setState(stateRef.current);
        return;
      }
    }
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
        if (selectedSessionId !== null && selectedSessionId !== stateRef.current.selectedSessionId) return true;
        setSnapshot(result.snapshot);
        setBlocker(null);
        return true;
      }
      setBlocker(`${result.code}: ${result.message}`);
      return false;
    },
    [ports],
  );

  const terminalWidthRef = useRef(terminalWidth);
  terminalWidthRef.current = terminalWidth;
  const transcriptHeight = useRef(12);
  const transcriptRequest = useRef(0);
  const historyReading = useRef(false);
  const applyTranscriptFrame = useCallback((frame: TranscriptFrame | null) => {
    if (frame === null || frame.coordinatorSessionId !== stateRef.current.selectedSessionId) return;
    historyReading.current = historyContextRef.current !== null || !frame.atLatest;
    setTranscriptFrame(frame); setTranscript(frame.page);
    if (frame.atLatest) setHistoryUpdated(false);
    dispatch({ kind: 'reading-anchor', coordinatorSessionId: frame.coordinatorSessionId, anchor: frame.atLatest ? null : frame.anchor });
  }, [dispatch]);
  const loadTranscript = useCallback(async (session: string, cursor: string | null = null, navigate = false) => {
    if (!navigate && historyReading.current && reader.frame?.coordinatorSessionId === session) return;
    const request = ++transcriptRequest.current;
    setHistoryLoading(true);
    try {
      const width = bodyWidth(terminalWidthRef.current, stateRef.current.sidebarDensity);
      reader.setDetailed(stateRef.current.detailedTranscript);
      const restoreAnchor = cursor === 'restore' ? stateRef.current.readingAnchors[session] ?? null : null;
      const frame = reader.frame?.coordinatorSessionId !== session
        ? await reader.open(session, width, transcriptHeight.current, stateRef.current.expandedToolIds, stateRef.current.readingAnchors[session] ?? null)
        : await reader.read(restoreAnchor !== null ? 'anchor' : cursor === 'oldest' ? 'oldest' : !navigate && historyReading.current ? 'anchor' : 'latest', restoreAnchor ?? (!navigate && historyReading.current ? stateRef.current.readingAnchors[session] ?? null : null));
      if (request === transcriptRequest.current) applyTranscriptFrame(frame);
    } catch (error) {
      if (request === transcriptRequest.current) dispatch({ kind: 'notice', notice: '历史读取失败：' + (error instanceof Error ? error.message : String(error)) });
    } finally { if (request === transcriptRequest.current) setHistoryLoading(false); }
  }, [reader, dispatch, applyTranscriptFrame]);
  const resizeTranscript = useCallback(async () => {
    try { reader.setDetailed(stateRef.current.detailedTranscript); applyTranscriptFrame(await reader.resize(bodyWidth(terminalWidthRef.current, stateRef.current.sidebarDensity), transcriptHeight.current, stateRef.current.expandedToolIds)); }
    catch (error) { dispatch({ kind: 'notice', notice: '历史读取失败：' + (error instanceof Error ? error.message : String(error)) }); }
  }, [reader, applyTranscriptFrame, dispatch]);
  const recordTranscriptHeight = useCallback((height: number) => {
    if (transcriptHeight.current === height) return;
    transcriptHeight.current = height;
    if (reader.frame) void resizeTranscript();
  }, [reader, resizeTranscript]);
  useEffect(() => { if (reader.frame) void resizeTranscript(); }, [reader, resizeTranscript, terminalWidth, state.sidebarDensity, state.expandedToolIds, state.detailedTranscript]);
  useEffect(() => ports.reading.subscribe(session => {
    if (session !== stateRef.current.selectedSessionId) return;
    if (historyReading.current) setHistoryUpdated(true);
    else void loadTranscript(session);
  }), [ports, loadTranscript]);

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
        if (batch.some(event => event.kind === 'interaction-opened' || event.kind === 'interaction-resolved')) {
          void loadSnapshot(stateRef.current.selectedSessionId);
          const selected = stateRef.current.selectedSessionId;
          if (selected !== null && sessionIds.includes(selected) && historyReading.current) {
            void reader.read('anchor', stateRef.current.readingAnchors[selected] ?? reader.frame?.anchor ?? null).then(applyTranscriptFrame).catch(error => dispatch({ kind: 'notice', notice: '问题读取失败：' + String(error) }));
          }
        }
        const selected = stateRef.current.selectedSessionId;
        if (selected !== null && sessionIds.includes(selected)) {
          if (historyReading.current) setHistoryUpdated(true); else void loadTranscript(selected);
        }
        dispatch({ kind: 'events-arrived', coordinatorSessionIds: sessionIds });
      });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [dispatch, ports, loadTranscript, loadSnapshot, reader, applyTranscriptFrame]);

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
    void ports.modelCatalog.load(state.selectedSessionId).then(catalog=>{ if(active) setModelCatalog(catalog); }).catch(()=>{ if(active) setModelCatalog(EMPTY_MODEL_CATALOG); });
    return ()=>{active=false;};
  }, [ports, state.selectedSessionId, snapshot?.sessions.find(session=>session.coordinatorSessionId===state.selectedSessionId)?.coordinatorModelConfigurationRef]);

  // 选中 Session 后加载其 transcript。
  useEffect(() => {
    if (state.selectedSessionId === null || state.screen !== 'workspace') {
      return;
    }
    historyReading.current = false;
    setHistoryUpdated(false);
    setTranscriptFrame(null);
    setTranscript(null);
    void loadSnapshot(state.selectedSessionId);
    void loadTranscript(state.selectedSessionId, 'restore', true);
    return () => { transcriptRequest.current += 1; };
  }, [loadTranscript, loadSnapshot, state.selectedSessionId, state.screen]);

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
    const view = projectTuiViewModel({
      snapshot,
      transcript: projectTranscriptPage(transcript, {
        coordinatorSessionId: state.selectedSessionId,
        scrollOffset: 0,
        readOnly: isComposerReadOnly(state, state.selectedSessionId),
        historyStatus: transcript === null ? (historyLoading ? 'loading' : 'unavailable') : 'ready',
        hasUpdates: historyUpdated,
      }),
      selectedSessionId: state.selectedSessionId,
      unreadSessionIds: state.unreadSessionIds,
      executionFilter: state.executionFilter,
      includeGraphNodes: state.sidebarDensity !== 'collapsed' || state.projectPanel.open || state.overlayStack.at(-1) === 'graph-inspector',
    });
    return { ...view, pendingPage: scopeQuestions };
  }, [snapshot, state, transcript, historyLoading, historyUpdated, scopeQuestions]);
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
  const runCommandRef = useRef<(command: CommandId) => Promise<CommandOutcome>>(() => Promise.resolve({kind:'opened'}));
  const openAnswerRef = useRef<(interactionId?: string, skipId?: string, returnToOrigin?: boolean) => Promise<boolean>>(() => Promise.resolve(false));
  const readQuestions = useCallback(async (query: import('./ports.js').TuiQuestionQuery): Promise<import('../../application/controller-service.js').ControllerQuestionResult> => {
    if (!ports.questions) return { kind: 'rejected', code: 'questions_unavailable', message: '当前问题读取不可用' };
    try { return await ports.questions(query); }
    catch (error) { return { kind: 'rejected', code: 'questions_unreadable', message: error instanceof Error ? error.message : String(error) }; }
  }, [ports]);

  const loadScopeQuestions = useCallback(async (direction = 0) => {
    const scope = coordScopeRef.current, request = ++scopeQuestionRequest.current;
    if (scope === null) return;
    if (scopeQuestionScope.current !== scope) {
      scopeQuestionScope.current = scope; scopeQuestionPage.current = { next: null, cursors: [undefined] }; direction = 0;
    }
    const page = scopeQuestionPage.current;
    if (direction > 0 && page.next === null || direction < 0 && page.cursors.length < 2) return;
    const cursors = direction > 0 ? [...page.cursors, page.next!] : direction < 0 ? page.cursors.slice(0, -1) : page.cursors;
    const after = cursors.at(-1);
    setScopeQuestions(current => ({ ...current, loading: true, error: null }));
    const result = await readQuestions({ kind: 'pending-interactions', ...(after === undefined ? {} : { after }) });
    if (request !== scopeQuestionRequest.current || coordScopeRef.current !== scope) return;
    if (result.kind !== 'pending-interactions') {
      setScopeQuestions(current => ({ ...current, loading: false, error: result.kind === 'rejected' ? result.code + ': ' + result.message : '待答列表不可读' })); return;
    }
    scopeQuestionPage.current = { next: result.nextCursor, cursors };
    setScopeQuestions({ items: result.interactions, page: cursors.length, hasPrevious: cursors.length > 1, hasNext: result.nextCursor !== null, loading: false, error: null });
    if (direction !== 0) dispatch({ kind: 'project-panel', panel: { ...stateRef.current.projectPanel, selectedKey: null, detail: null, scroll: 0 } });
  }, [readQuestions, dispatch]);
  useEffect(() => {
    if (state.projectPanel.open && state.projectPanel.tab === 1) void loadScopeQuestions();
    return () => { scopeQuestionRequest.current++; };
  }, [state.projectPanel.open, state.projectPanel.tab, coordinationScopeId, events, loadScopeQuestions]);

  const returnAnswer = (): boolean => {
    const origin = answerReturn.current;
    if (origin === null) return false;
    answerReturn.current = null; answerRequest.current++;
    updateAnswerPanel(origin.panel); answerPage.current = origin.page;
    historyContextRef.current?.abort.abort();
    const history = origin.history === null ? null : { ...origin.history, abort: new AbortController(), busy: false };
    historyContextRef.current = history; setHistoryContext(history);
    reader.highlight(history?.hit ?? null);
    dispatch({ kind: 'answer-returned', origin: origin.state });
    historyReading.current = origin.state.anchor !== null || history !== null;
    const session = origin.state.selectedSessionId;
    if (session !== null && reader.frame?.coordinatorSessionId === session) {
      void reader.open(session, bodyWidth(terminalWidthRef.current, stateRef.current.sidebarDensity), transcriptHeight.current,
        origin.state.expandedToolIds, origin.state.anchor).then(applyTranscriptFrame).catch(error => dispatch({ kind: 'notice', notice: '历史读取失败：' + String(error) }));
    }
    return true;
  };
  returnAnswerRef.current = returnAnswer;

  const showAnswer = async (item: ControllerInteractionView, index: number, count: number, fromProject = false,
    loadedDetail?: Extract<ControllerQuestionResult, { kind: 'pending-interaction' }>): Promise<boolean> => {
    const session = stateRef.current.selectedSessionId;
    const scope = coordScopeRef.current;
    const request = ++answerRequest.current;
    const entryState = stateRef.current;
    if (session === null || scope === null || !fromProject && item.ownerCoordinatorSessionId !== session || ports.questions === undefined) {
      dispatch({ kind: 'notice', notice: 'questions_unavailable：当前问题读取不可用' }); return false;
    }
    const saved = protection.flushAll();
    if (saved.status !== 'saved') { dispatch({ kind: 'notice', notice: saveOutcomeText(saved) + '；请通过 /inputs 处理' }); return false; }
    const targetSession = item.ownerCoordinatorSessionId;
    const detail = loadedDetail ?? await readQuestions({ kind: 'pending-interaction', coordinatorSessionId: targetSession, interactionId: item.interactionId });
    if (request !== answerRequest.current || stateRef.current.selectedSessionId !== session || coordScopeRef.current !== scope || fromProject && stateRef.current.projectPanel !== entryState.projectPanel) return false;
    if (detail.kind !== 'pending-interaction' || !detail.interaction || detail.interaction.state !== 'open' ||
      detail.interaction.ownerCoordinatorSessionId !== targetSession || detail.interaction.interactionId !== item.interactionId || detail.interaction.expectedRevision !== item.expectedRevision) {
      dispatch({ kind: 'notice', notice: detail.kind === 'rejected' ? `${detail.code}: ${detail.message}` : 'stale_revision：问题已变化，请重新打开' }); return false;
    }
    if (fromProject && answerReturn.current === null) {
      const current = stateRef.current;
      answerReturn.current = { state: { selectedSessionId: session, composerMode: current.composerMode, projectPanel: { ...current.projectPanel, selectedKey: item.interactionId },
        expandedToolIds: current.expandedToolIds, detailedTranscript: current.detailedTranscript, anchor: current.readingAnchors[session] ?? null },
        panel: answerPanelRef.current, page: answerPage.current, history: historyContextRef.current };
    }
    if (fromProject) {
      historyContextRef.current?.abort.abort(); historyContextRef.current = null; setHistoryContext(null); reader.highlight(null);
      answerPage.current = { items: [detail.interaction], next: null, cursors: [undefined] };
    }
    // 普通输入召回与回答互不相干：进入回答模式前丢掉仍在显示的预览，
    // 否则下一次 Enter 会把旧聊天原文当成回答提交给当前 interaction。
    inputHistory.cancel(); updateHistoryPreview(null);
    dispatch({ kind: 'answer-mode-entered', coordinatorSessionId: targetSession, interactionId: item.interactionId, expectedRevision: item.expectedRevision, closeProject: fromProject });
    updateAnswerPanel({ interaction: detail.interaction, index, count, option: 0, focus: detail.interaction.question?.options.length ? 'options' : 'text', scroll: 0 });
    return true;
  };

  const openAnswer = async (interactionId?: string, skipId?: string, returnToOrigin = false): Promise<boolean> => {
    const session = stateRef.current.selectedSessionId;
    const scope = coordScopeRef.current;
    const request = ++answerRequest.current;
    if (!session || !scope || !ports.questions) { dispatch({ kind: 'notice', notice: 'questions_unavailable：当前问题读取不可用' }); return false; }
    if (interactionId !== undefined) {
      const saved = protection.flushAll();
      if (saved.status !== 'saved') { dispatch({ kind: 'notice', notice: saveOutcomeText(saved) + '；请通过 /inputs 处理' }); return false; }
      const detail = await readQuestions({ kind: 'pending-interaction', coordinatorSessionId: session, interactionId });
      if (request !== answerRequest.current || stateRef.current.selectedSessionId !== session || coordScopeRef.current !== scope) return false;
      if (detail.kind !== 'pending-interaction' || detail.interaction === null) { dispatch({ kind: 'notice', notice: detail.kind === 'rejected' ? detail.code + ': ' + detail.message : '问题记录缺失' }); return false; }
      if (!returnToOrigin) answerPage.current = { items: [detail.interaction], next: null, cursors: [undefined] };
      return showAnswer(detail.interaction, 0, 1, returnToOrigin, detail);
    }
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
    if(!await loadSnapshot(stateRef.current.selectedSessionId))throw new Error('当前状态不可读');
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
      const unavailable=commandReason(slash.command,{mode:snapshotRef.current?.mode??'route_planning',selectedSessionId:session,pasteBlocks:composerInputFor(current,session).pasteBlocks.length,...(ports.modelSettings===undefined?{}:{modelSettings:true})});
      if(unavailable){dispatch({kind:'notice',notice:unavailable});return;}
      if (slash.command === 'paste') { await runCommandRef.current('paste'); return; }
      const generation = protection.generation(target);
      const outcome = await runCommandRef.current(slash.command);
      // 命令成功只结清这次输入；等待期间的新输入（代际变化）与清理失败都保留。
      if ((outcome.kind === 'opened' || outcome.kind === 'accepted' && !outcome.refreshFailed) && protection.generation(target) === generation) {
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
    const submittedRequest = answerRequest.current;
    const returnContext = answerReturn.current;
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
      if (settled.status === 'saved' && protection.generation(target) === generation) {
        const cleared = protection.clearDraft(target);
        if (cleared.status === 'saved') {
          // 只有持久草稿真的被清除才清界面正文；清理失败时保留输入并如实提示。
          dispatch(draftActionFor(target, emptyDraft()));
          // 只有界面仍停在这条提交对应的 Session 与 composer 模式时才复位。
          if (
            stateRef.current.selectedSessionId === session &&
            sameComposerMode(stateRef.current.composerMode, submittedMode) && answerRequest.current === submittedRequest
          ) {
            dispatch({ kind: 'composer-mode-reset' });
            if (submittedMode.kind === 'answer') {
              updateAnswerPanel(null);
              if (returnContext === null || answerReturn.current !== returnContext || !returnAnswerRef.current()) await openAnswerRef.current(undefined, submittedMode.interactionId);
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

  const runMutation = useCallback(async (key: string, action: () => Promise<ControllerCommandResult>): Promise<MutationOutcome> => {
    const generation=navigationGeneration.current, session=stateRef.current.selectedSessionId;
    const result=await commandInvocations.run(key,async()=>{
      const outcome=await action();
      try{await reload();}catch{return {...outcome,refreshFailed:true};}
      return outcome;
    });
    if(generation===navigationGeneration.current&&session===stateRef.current.selectedSessionId)dispatch({kind:'notice',notice:(resultNotice(result)??'')+(result.refreshFailed?'；状态刷新失败，请核验原结果':'')});
    return result;
  },[commandInvocations,dispatch,reload]);
  /** 提交一次 Scope 级控制意图；终态一律来自 Controller 已持久化的控制状态。 */
  const applyScopeControl = useCallback(
    async (action: 'pause' | 'resume' | 'cancel') => {
      return await runMutation('scope-control:'+coordScopeRef.current,()=>ports.execute({ kind: 'scope-control', action }));
    },
    [ports, runMutation],
  );

  /**
   * Scope 级控制入口。
   *
   * Pause 从不要求确认；Cancel 只在危险态（活跃/不可核验 Worker、待答交互、未决操作）下要求一次确认。
   * 确认本身不写任何控制状态，它只是提交一次与直接调用相同的意图。
   */
  const requestScopeControl = useCallback(
    async (action: 'pause' | 'resume' | 'cancel'): Promise<CommandOutcome> => {
      const view = viewModelRef.current;
      if (action === 'cancel' && view === null && scopeIdRef.current !== null) {
        // Scope 已确定但执行快照尚未落地：「未知」不能读作「没有危险态」。
        dispatch({ kind: 'confirmation-requested', pending: { kind: 'cancel' } });
        return {kind:'opened'};
      }
      if (view !== null && requiresConfirmation(action, view.execution.hazards)) {
        dispatch({ kind: 'confirmation-requested', pending: { kind: 'cancel' } });
        return {kind:'opened'};
      }
      return await applyScopeControl(action);
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
    async (command: CommandId, recipient?: string, toggleProject = false): Promise<CommandOutcome> => {
      const current=stateRef.current, session=current.selectedSessionId;
      const lane=command==='compact'?'compact:'+session:command==='pause'||command==='resume'||command==='cancel'?'scope-control:'+coordScopeRef.current:(command==='handoff'||command==='execution-handoff')&&recipient!==undefined?'handoff-prepare:'+coordScopeRef.current:null;
      const prior=lane===null?undefined:commandInvocations.peek(lane);
      if(prior){dispatch({kind:'notice',notice:(resultNotice(prior)??'')+(prior.refreshFailed?'；请核验原结果':'')});return prior;}
      const generation=++navigationGeneration.current;
      const inputTarget=currentInputTarget(current,coordScopeRef.current),inputGeneration=inputTarget===null?null:protection.generation(inputTarget);
      const active=()=>generation===navigationGeneration.current&&session===stateRef.current.selectedSessionId&&(inputTarget===null||inputGeneration===protection.generation(inputTarget));
      const reject=(code:string,message:string):ControllerCommandResult=>{ if(active())dispatch({kind:'notice',notice:message});return {kind:'rejected',code,message}; };
      const reason=commandReason(command,{mode:snapshotRef.current?.mode??'route_planning',selectedSessionId:session,pasteBlocks:composerInputFor(current,session).pasteBlocks.length,...(snapshotRef.current?{controlState:snapshotRef.current.controlState}:{}),...(ports.modelSettings===undefined?{}:{modelSettings:true})});
      if(reason)return reject('command_unavailable',reason);
      const open=(overlay:OverlayKind, selectedId:string|null=null):CommandOutcome=>{
        if(!active())return {kind:'rejected',code:'navigation_changed',message:'调用入口已改变'};
        dispatch({kind:'review-view',tab:0,scroll:0,action:0});
        dispatch({kind:'dialog-selection',overlay,query:emptyDraft(),selectedId});
        dispatch({kind:'overlay-open',overlay});
        return {kind:'opened'};
      };
      try {
        switch(command){
          case 'verify-command-results': {
            const result=await commandInvocations.verify(async result=>{
              if(result.kind==='accepted'&&result.refreshFailed){try{await reload();return {...result,refreshFailed:false};}catch{return result;}}
              return result.kind==='unknown'&&result.resultRef?await ports.commandStatus(result.resultRef):result;
            });
            if(active())dispatch({kind:'notice',notice:resultNotice(result)});
            return result;
          }
          case 'command-directory': return open('command-palette',COMMAND_IDS[0]??null);
          case 'answer': {
            dispatch({kind:'overlay-close-all'});
            return await openAnswerRef.current()?{kind:'opened'}:reject('question_unavailable','当前没有可回答的问题');
          }
          case 'paste':
            updatePasteViewer({draft:composerInputFor(current,session),block:0,scroll:0});return open('paste-viewer');
          case 'compact':
            if(session===null)return reject('session_missing','未选择会话');
            {const result=await runMutation('compact:'+session,()=>ports.execute({kind:'compact-session',coordinatorSessionId:session,reason:'user-requested'}));if(result.kind==='accepted'&&active())dispatch({kind:'overlay-close-all'});return result;}
          case 'model-picker': {
            if(session===null)return reject('session_missing','未选择会话');
            const catalog=await ports.modelCatalog.load(session);
            if(!active())return reject('navigation_changed','调用入口已改变');
            modelMenuTarget.current=session;setModelRejection(null);setModelCatalog(catalog);
            dispatch({kind:'model-role-selected',index:0});
            dispatch({kind:'model-settings-notice',notice:null});
            return open('model-picker',null);
          }
          case 'model-settings': {
            if(modelSettingsPort===undefined)return reject('model_settings_unavailable','角色模型配置端口尚未接通');
            await openModelSettingsEditor();
            return {kind:'opened'};
          }
          case 'handoff':
          case 'execution-handoff': {
            if(recipient===undefined){
              dispatch({kind:'handoff-target',command});
              const source=command==='handoff'?snapshotRef.current?.sessions.find(s=>s.planningResponsible)?.coordinatorSessionId:snapshotRef.current?.executionLeaseHolderSessionId;
              return open('handoff-target',snapshotRef.current?.sessions.find(s=>s.coordinatorSessionId!==source)?.coordinatorSessionId??null);
            }
            return await runMutation('handoff-prepare:'+coordScopeRef.current,async()=>{
              const prepared=await (command==='handoff'?ports.handoff.prepareProposal(recipient):ports.executionHandoff.prepare(recipient));
              if(prepared.kind!=='accepted')return prepared;
              const initialRef=prepared.resultRef;
              if(initialRef?.kind!==(command==='handoff'?'planning-handoff':'execution-handoff'))return {kind:'unknown',code:'result_ref_unavailable',message:'已受理但缺少本次提案的精确引用，请核验原结果'};
              if(!active())return prepared;
              let ref=initialRef;
              try{
                if(ref.kind==='planning-handoff'){
                  const record=await ports.handoff.read(ref.proposalId);
                  if(!active())return prepared;
                  if(!record)throw new Error('本次提案暂不可读');
                  setPlanningReview(record);
                  open('handoff-review');
                }else if(ref.kind==='execution-handoff'){
                  const id=ref.handoffId,record=await ports.executionHandoff.read(id);
                  if(!active())return prepared;
                  if(record?.phase==='prepared'){
                    const reviewed=await runMutation('handoff-review:'+id,()=>ports.executionHandoff.review(id));
                    if(!active())return reviewed;
                    if(reviewed.kind==='accepted'&&reviewed.resultRef?.kind==='execution-handoff')ref=reviewed.resultRef;
                    else return reviewed;
                  }
                  const shown=await ports.executionHandoff.read(id);
                  if(!active())return prepared;
                  if(!shown)throw new Error('本次提案暂不可读');
                  executionReviewRef.current=ref;setExecutionReview(shown);
                  dispatch({kind:'execution-handoff-review',handoffId:id});
                  open('execution-handoff-review');
                }
                return prepared;
              }catch{return {kind:'unknown',code:'handoff_unreadable',message:'提案已受理，读取结果失败，请核验原提案',resultRef:ref};}
            });
          }
          case 'session-picker':return open('session-picker',session??snapshotRef.current?.sessions[0]?.coordinatorSessionId??null);
          case 'event-drawer':
          case 'pending-list':
          case 'project': {
            dispatch({kind:'overlay-close-all'});
            dispatch({kind:'project-panel',panel:{...current.projectPanel,open:toggleProject?!current.projectPanel.open:true,tab:command==='event-drawer'?2:command==='pending-list'?1:0,selectedKey:command==='event-drawer'?'event:'+events.at(-1)?.eventId:null,detail:null,scroll:0}});
            return {kind:'opened'};
          }
          case 'options':return open('options','icons-'+current.iconMode);
          case 'icons-nerd':
          case 'icons-ascii':dispatch({kind:'icons',mode:command==='icons-ascii'?'ascii':'nerd'});return {kind:'opened'};
          case 'statusline':return reject('command_unavailable','用户级状态栏设置尚未接通');
          case 'graph-inspector':return open('graph-inspector');
          case 'toggle-sidebar':dispatch({kind:'overlay-close-all'});dispatch({kind:'sidebar-toggle',allowed:allowedSidebarDensity(terminalWidth)});return {kind:'opened'};
          case 'help':return open('help');
          case 'pause':
          case 'resume':
          case 'cancel':
            {const result=await requestScopeControl(command);if(result.kind==='accepted'&&active())dispatch({kind:'overlay-close-all'});return result;}
          case 'authorize-execution': {
            const loaded=await ports.executionAuthorization.review();
            if(!active())return reject('navigation_changed','调用入口已改变');
            setAuthorizationReview(loaded);open('authorization-review');
            return loaded.kind==='review'?{kind:'opened'}:reject(loaded.code,loaded.message);
          }
          case 'filter-execution': {
            const next=nextExecutionFilter(current.executionFilter);dispatch({kind:'execution-filter-changed',filter:next});
            dispatch({kind:'notice',notice:'执行图过滤：'+executionFilterLabel(next)});return {kind:'opened'};
          }
          case 'transcript-details':dispatch({kind:'transcript-details',detailed:!current.detailedTranscript});return {kind:'opened'};
          case 'search-history':
          case 'navigate-activity':
          case 'input-history':
            dispatch({kind:'overlay-close-all'});dispatch({kind:'project-panel',panel:{...current.projectPanel,open:false}});
            historyKeyRef.current(command==='input-history'?'users':command==='search-history'?'transcript':'activity');
            return {kind:'opened'};
          case 'exit':requestExit();return {kind:'opened'};
          case 'input-record-manager': {
            const scope=coordScopeRef.current;if(scope===null)return reject('scope_missing','尚未确定 Scope');
            const listed=protection.list(scope);if(listed.status==='failed')return reject(listed.code,listed.message);
            setInputManager({entries:inputManagerEntriesOf(listed.records,listed.invalidRecords),usage:listed.usage,selectedIndex:0,bodyScroll:0,bodyFocus:false,feedback:null,confirmDelete:false});
            return open('input-record-manager');
          }
        }
      } catch(error){return reject('command_read_failed',error instanceof Error?error.message:String(error));}
    },
    [dispatch,events,ports,protection,requestExit,requestScopeControl,runMutation,commandInvocations,reload,terminalWidth],
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
    const record=planningReview, generation=navigationGeneration.current;
    if(!record)return;
    const result=await runMutation('handoff:'+record.proposalId,()=>ports.handoff.cutover(record.proposalId,record.proposalRevision));
    if(result.kind==='accepted'&&generation===navigationGeneration.current) {
      dispatch({kind:'overlay-close-all'});
      dispatch({kind:'session-read-only',coordinatorSessionId:record.sourceSessionId});
    }
  },[dispatch,planningReview,ports,runMutation]);

  const confirmExecutionHandoff = useCallback(async () => {
    const record=executionReview,ref=executionReviewRef.current,generation=navigationGeneration.current;
    if(!record||ref?.kind!=='execution-handoff'||record.phase!=='reviewed')return;
    const result=await runMutation('handoff:'+record.handoffId,()=>ports.executionHandoff.cutover(record.handoffId,ref.revision));
    if(result.kind==='accepted'&&generation===navigationGeneration.current){
      dispatch({kind:'overlay-close-all'});
      dispatch({kind:'session-read-only',coordinatorSessionId:record.sourceSessionId});
    }
  },[dispatch,executionReview,ports,runMutation]);

  const cancelExecutionHandoff = useCallback(async () => {
    const record=executionReview,ref=executionReviewRef.current,generation=navigationGeneration.current;
    if(!record||ref?.kind!=='execution-handoff'){dispatch({kind:'overlay-close-top'});return;}
    const result=await runMutation('handoff:'+record.handoffId,()=>ports.executionHandoff.cancel(record.handoffId,ref.revision));
    if(result.kind==='accepted'&&generation===navigationGeneration.current)dispatch({kind:'overlay-close-top'});
  },[dispatch,executionReview,ports,runMutation]);

  const confirmAuthorization = useCallback(async () => {
    const load=authorizationReview,generation=navigationGeneration.current;
    if(load?.kind!=='review'||!load.review.gate.ready)return;
    const result=await runMutation('authorization:'+coordScopeRef.current,()=>ports.executionAuthorization.approve({
      fingerprint:load.review.fingerprint,expectedRevision:load.review.scopeRevision,
    }));
    if(result.kind==='accepted'&&generation===navigationGeneration.current){
      dispatch({kind:'overlay-close-all'});setAuthorizationReview(null);
    }
  },[authorizationReview,dispatch,ports,runMutation]);

  const cancelAuthorization = useCallback(() => {
    dispatch({kind:'overlay-close-top'});setAuthorizationReview(null);
  },[dispatch]);

  const cancelHandoff = useCallback(async () => {
    const record=planningReview,generation=navigationGeneration.current;
    if(!record){dispatch({kind:'overlay-close-top'});return;}
    const result=await runMutation('handoff:'+record.proposalId,()=>ports.handoff.cancel(record.proposalId,record.proposalRevision));
    if(result.kind==='accepted'&&generation===navigationGeneration.current)dispatch({kind:'overlay-close-top'});
  },[dispatch,planningReview,ports,runMutation]);

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
  const updateHistoryPreview = (draft: UiDraft | null) => { historyPreviewRef.current = draft; setHistoryPreview(draft); };
  const updateHistoryContext = (context: HistoryContext | null) => { historyContextRef.current = context; setHistoryContext(context === null ? null : { ...context }); };
  const closeHistoryContext = (adopt: UiDraft | null = null) => {
    const context = historyContextRef.current;
    context?.abort.abort(); updateHistoryContext(null); updateHistoryPreview(null); inputHistory.cancel(); reader.highlight(null);
    if (context !== null && context.kind !== 'activity') {
      dispatch({ kind: 'transcript-details', detailed: context.detailed, expanded: context.expanded });
      reader.setDetailed(context.detailed);
      void reader.open(context.session, bodyWidth(terminalWidthRef.current, stateRef.current.sidebarDensity), transcriptHeight.current,
        context.expanded, context.anchor).then(applyTranscriptFrame).catch(error => dispatch({ kind: 'notice', notice: String(error) }));
    }
    if (adopt !== null) workspaceActions.composerChange(adopt);
  };
  const showHistoryHit = async (context: HistoryContext, hit: HistorySearchHit) => {
    if (context.abort.signal.aborted || historyContextRef.current !== context) return;
    context.hit = hit;
    if (context.kind === 'users') {
      if (hit.source.kind !== 'history') throw new Error('输入历史来源无效');
      const draft = await readHistoricalInput(ports.reading, context.session, hit.source.entryId, context.abort.signal);
      if (historyContextRef.current === context) updateHistoryPreview(draft);
    } else {
      reader.highlight(hit);
      const frame = await reader.read('anchor', { coordinatorSessionId: context.session, ...hit });
      if (historyContextRef.current === context && !context.abort.signal.aborted) applyTranscriptFrame(frame);
    }
    if (historyContextRef.current === context) {
      context.busy = false;
      context.feedback = context.kind === 'users' ? '↑ 旧 / ↓ 新 · Enter 采用 · Esc 返回' : 'Enter 向新 · Shift+Enter 向旧 · Esc 返回';
      updateHistoryContext(context);
    }
  };
  const seekHistory = async (context: HistoryContext, direction: 'older' | 'newer', restart = false) => {
    if (context.busy || historyContextRef.current !== context) return;
    context.busy = true; context.feedback = '正在查找…'; updateHistoryContext(context);
    try {
      const inspection = ports.reading.inspection;
      if (inspection === undefined) throw new Error('历史检索不可用');
      if (!context.initialized) {
        const snapshot = await inspection.snapshot(context.session);
        context.abort.signal.throwIfAborted(); if (historyContextRef.current !== context) return;
        if (!snapshot.ready && context.kind !== 'users') throw new Error('调用关联索引正在准备');
        context.upper = snapshot.upperSequence; context.initialized = true;
      }
      if (context.kind === 'activity') {
        const boundary = context.call === null ? undefined : { sequence: context.call.sequence, ordinal: context.call.ordinal };
        let edge = boundary;
        if (context.call !== null) {
          const group = await inspection.calls({ coordinatorSessionId: context.session, activityId: context.call.activityId,
            upperSequence: context.upper, direction: direction === 'older' ? 'newer' : 'older' });
          const end = direction === 'older' ? group.calls[0] : group.calls.at(-1);
          if (end !== undefined) edge = { sequence: end.sequence, ordinal: end.ordinal };
        }
        const page = await inspection.calls({ coordinatorSessionId: context.session, upperSequence: context.upper, direction,
          ...(edge === undefined ? {} : direction === 'older' ? { before: edge } : { after: edge }) });
        if (context.abort.signal.aborted || historyContextRef.current !== context) return;
        let call = direction === 'older' ? page.calls.at(-1) : page.calls[0];
        if (call === undefined) { context.busy = false; context.feedback = '已到活动边界 · Esc 返回'; updateHistoryContext(context); return; }
        const start = await inspection.calls({ coordinatorSessionId: context.session, activityId: call.activityId,
          upperSequence: context.upper, direction: 'newer' });
        if (context.abort.signal.aborted || historyContextRef.current !== context) return;
        call = start.calls[0] ?? call;
        context.call = call;
        const expanded = [...new Set([...stateRef.current.expandedToolIds, call.activityId])];
        dispatch({ kind: 'transcript-details', detailed: stateRef.current.detailedTranscript,
          expanded });
        await reader.resize(bodyWidth(terminalWidthRef.current, stateRef.current.sidebarDensity), transcriptHeight.current, expanded);
        await showHistoryHit(context, { source: { kind: 'arguments', entryId: call.entryId, stepId: call.stepId, callId: call.callId, contentRevision: 1 },
          sequence: call.sequence, offset: 0, end: Math.min(1, call.argsByteLength) });
        reader.highlight(null); context.feedback = '↑/↓ 选择活动 · Enter 开合 · Esc 返回'; updateHistoryContext(context); return;
      }
      if (context.kind === 'users' && context.query.text === '') {
        const page = await inspection.users({ coordinatorSessionId: context.session, upperSequence: context.upper, direction,
          ...(context.hit === null ? {} : direction === 'older' ? { before: context.hit.sequence } : { after: context.hit.sequence }) });
        const entry = direction === 'older' ? page.entries.at(-1) : page.entries[0];
        if (entry !== undefined) { await showHistoryHit(context, { source: { kind: 'history', entryId: entry.entryId, contentRevision: 1 }, sequence: entry.sequence, offset: 0, end: Math.min(1, entry.byteLength) }); return; }
        context.busy = false; context.feedback = '已到输入历史边界 · Esc 返回'; updateHistoryContext(context); return;
      }
      if (context.query.text === '') { context.busy = false; context.feedback = '输入查找文字 · Esc 返回'; updateHistoryContext(context); return; }
      const index = context.index + (direction === 'newer' ? 1 : -1);
      if (!restart && context.kind === 'transcript' && index >= 0 && index < context.hits.length) {
        context.index = index; await showHistoryHit(context, context.hits[index]!); return;
      }
      // Older navigation retains one candidate while rescanning bounded batches, never all hits.
      const older = direction === 'older';
      const before = restart ? null : context.hit;
      const position = (hit: HistorySearchHit) => [hit.sequence, hit.source.kind === 'arguments' ? 1 : 0, hit.ordinal ?? 0, hit.offset] as const;
      const precedes = (a: HistorySearchHit, b: HistorySearchHit) => {
        const x = position(a), y = position(b);
        for (let n = 0; n < x.length; n++) { if (x[n] !== y[n]) return x[n]! < y[n]!; }
        return false;
      };
      let cursor = older || restart ? null : context.cursor, candidate: HistorySearchHit | null = null;
      let complete = !older && !restart && context.complete;
      do {
        if (complete) break;
        const page = await (inspection.search?.({ coordinatorSessionId: context.session, target: context.kind,
          literal: context.query.text, upperSequence: context.upper, cursor }, context.abort.signal)
          ?? scanHistory(ports.reading, { coordinatorSessionId: context.session, target: context.kind,
            literal: context.query.text, upperSequence: context.upper, cursor }, context.abort.signal));
        context.abort.signal.throwIfAborted(); if (historyContextRef.current !== context) return;
        const newerHits = !older ? page.hits.filter(hit => before === null || precedes(before, hit)) : [];
        if (!older && newerHits.length > 0) {
          context.hits = newerHits; context.index = 0; context.cursor = page.cursor; context.complete = page.complete;
          await showHistoryHit(context, newerHits[0]!); return;
        }
        for (const hit of older ? page.hits : []) {
          if (before === null || precedes(hit, before)) candidate = hit;
          else { complete = true; break; }
        }
        cursor = page.cursor; complete ||= page.complete;
        context.feedback = '正在扫描保留历史…'; updateHistoryContext(context);
        await new Promise<void>(resolve => setImmediate(resolve));
      } while (!complete);
      if (candidate !== null) { context.hits = [candidate]; context.index = 0; context.cursor = null; context.complete = false; await showHistoryHit(context, candidate); return; }
      context.busy = false; context.feedback = before === null ? '无匹配 · Esc 返回' : '已到匹配边界 · Esc 返回'; updateHistoryContext(context);
    } catch (error) {
      if (context.abort.signal.aborted || historyContextRef.current !== context) return;
      context.busy = false; context.feedback = '读取失败 · Enter 重试：' + (error instanceof Error ? error.message : String(error)); updateHistoryContext(context);
    }
  };
  const beginHistoryContext = async (kind: HistoryContext['kind']) => {
    const isCurrent = (context: HistoryContext) => historyContextRef.current === context;
    const current = stateRef.current, session = current.selectedSessionId;
    if (session === null || current.screen !== 'workspace' || current.overlayStack.length || current.pendingConfirmation !== null || current.projectPanel.open || current.composerMode.kind !== 'message' || isComposerReadOnly(current, session)) return;
    if (historyContextRef.current !== null) return;
    inputHistory.cancel(); updateHistoryPreview(null);
    const context: HistoryContext = { kind, session, query: emptyDraft(), anchor: reader.atLatest ? null : reader.frame?.anchor ?? null,
      detailed: current.detailedTranscript, expanded: current.expandedToolIds, upper: 0, initialized: false, hit: null, call: null,
      hits: [], index: -1, cursor: null, complete: false, feedback: '读取历史范围…', busy: true, abort: new AbortController() };
    updateHistoryContext(context); historyReading.current = true;
    try {
      const inspection = ports.reading.inspection;
      if (inspection === undefined) throw new Error('历史检索不可用');
      const snapshot = await inspection.snapshot(session);
      if (context.abort.signal.aborted || !isCurrent(context)) return;
      if (!snapshot.ready && kind !== 'users') throw new Error('调用关联索引正在准备，请稍后重试');
      context.upper = snapshot.upperSequence; context.initialized = true; context.busy = false; context.feedback = '输入查找文字 · Esc 返回'; updateHistoryContext(context);
      if (kind !== 'transcript') void seekHistory(context, 'older', true);
    } catch (error) { context.busy = false; context.feedback = String(error); updateHistoryContext(context); }
  };
  const changeHistoryQuery = (draft: UiDraft) => {
    const previous = historyContextRef.current;
    if (previous === null || previous.kind === 'activity') return;
    if ([...draft.text].length > 256) { previous.feedback = '查找最多 256 字符'; updateHistoryContext(previous); return; }
    if (draft.text === previous.query.text) { previous.query = draft; updateHistoryContext(previous); return; }
    previous.abort.abort();
    const context = { ...previous, query: draft, hit: null, hits: [], index: -1, cursor: null, complete: false,
      abort: new AbortController(), busy: false };
    updateHistoryContext(context); updateHistoryPreview(null); reader.highlight(null);
    void seekHistory(context, context.kind === 'users' ? 'older' : 'newer', true);
  };
  functionKeyRef.current = action => { if(stateRef.current.overlayStack.length===0&&stateRef.current.pendingConfirmation===null)void runCommand(action); };
  // ---------------------------------------------------------------------
  // 角色模型配置（IP-06）
  // ---------------------------------------------------------------------
  const modelSettingsPort = ports.modelSettings;
  const modelRoleList = (): readonly ModelRoleView[] => modelRoles(modelCatalog);
  const highlightedRole = (): ModelRoleView | null => modelRoleList()[stateRef.current.modelRoleIndex] ?? null;
  const roleMenuRole = (): ModelRoleView | null => {
    const role = stateRef.current.modelRoleMenu?.role;
    return role === undefined ? null : modelRoleList().find((entry) => entry.role === role) ?? null;
  };
  const openModelOverlay = (overlay: OverlayKind, selectedId: string | null = null) => {
    dispatch({ kind: 'review-view', tab: 0, scroll: 0, action: 0 });
    dispatch({ kind: 'dialog-selection', overlay, query: emptyDraft(), selectedId });
    dispatch({ kind: 'overlay-open', overlay });
  };
  const reloadModelCatalog = async () => {
    const session = stateRef.current.selectedSessionId;
    if (session === null) return;
    try {
      setModelCatalog(await ports.modelCatalog.load(session));
    } catch {
      setModelCatalog(EMPTY_MODEL_CATALOG);
    }
  };
  /**
   * 关闭模型弹窗并抹除内存中的 key。
   *
   * 抹除发生在关闭与保存成功两条路径上，因此 overlay 栈、返回上下文和迟到的异步结果都不会再拿到
   * 用户输入的 secret；此后任何位置看到的都是遮罩。
   */
  const eraseModelSecret = () => {
    const edit = stateRef.current.modelSettingsEdit;
    if (edit !== null && edit.secret !== '') {
      dispatch({ kind: 'model-settings-edit', edit: { ...edit, secret: '' }, field: stateRef.current.modelSettingsField });
    }
  };
  const closeModelOverlays = () => {
    modelInvocation.current += 1;
    eraseModelSecret();
    modelSettingsSnapshot.current = null;
    dispatch({ kind: 'model-role-menu', menu: null });
    dispatch({ kind: 'model-settings-edit', edit: null });
    dispatch({ kind: 'overlay-close-all' });
  };
  /** 进入某个角色的候选菜单；不可用时保持当前层并显示宿主给出的原因。 */
  const openModelRole = (role?: ModelRoleView) => {
    const target = role ?? highlightedRole();
    if (target === null) {
      dispatch({ kind: 'model-settings-notice', notice: '! 没有可用的角色' });
      return;
    }
    const admission = modelRoleAdmission(target, modelCatalog);
    if (!admission.allowed) {
      dispatch({ kind: 'model-settings-notice', notice: '! ' + (admission.reason ?? '该角色当前不可用') });
      return;
    }
    const current = target.current;
    const candidates = dedupeRoleCandidates(target.candidates);
    const candidate =
      (current === null
        ? undefined
        : candidates.find((entry) => entry.candidateRef === current.candidateRef) ??
          candidates.find((entry) => entry.provider === current.provider && entry.model === current.model)) ??
      candidates[0] ??
      null;
    const currentEffort = current !== null && current.provider === candidate?.provider && current.model === candidate.model
      ? current.effort : null;
    const effort = effortValues(candidate).includes(currentEffort ?? '') ? currentEffort : null;
    dispatch({ kind: 'model-settings-notice', notice: null });
    dispatch({
      kind: 'model-role-menu',
      menu: { role: target.role, selectedCandidateRef: candidate?.candidateRef ?? null, focus: 'list', action: 0, effort },
    });
    openModelOverlay('model-role-menu', candidate?.candidateRef ?? null);
  };
  /**
   * 载入非秘密快照并打开编辑器。
   *
   * 载入结果绑定本次调用代次：overlay 已关闭或已重新打开时，迟到结果直接丢弃，不会把上一个角色的
   * 字段写进当前弹窗。
   */
  const openModelSettingsEditor = async (role?: ModelRoleView) => {
    const port = modelSettingsPort;
    if (port === undefined) {
      dispatch({ kind: 'model-settings-notice', notice: '! model_settings_unavailable: 角色模型配置端口尚未接通' });
      return;
    }
    const target = role ?? highlightedRole();
    if (target === null) {
      dispatch({ kind: 'model-settings-notice', notice: '! 没有可用的角色' });
      return;
    }
    const invocation = (modelInvocation.current += 1);
    const navigation = navigationGeneration.current;
    dispatch({ kind: 'model-settings-notice', notice: null });
    let loaded;
    try {
      loaded = await port.load();
    } catch {
      if (invocation !== modelInvocation.current || navigation !== navigationGeneration.current) return;
      dispatch({ kind: 'model-settings-notice', notice: '! config_unreadable: 读取模型配置失败' });
      return;
    }
    if (invocation !== modelInvocation.current || navigation !== navigationGeneration.current) return;
    if (loaded.kind !== 'loaded') {
      dispatch({ kind: 'model-settings-notice', notice: '! ' + loaded.code + ': ' + loaded.message });
      return;
    }
    const binding = loaded.snapshot.roles.find((entry) => entry.role === target.role);
    const connection =
      binding?.connectionRef == null
        ? undefined
        : loaded.snapshot.connections.find((entry) => entry.connectionRef === binding.connectionRef);
    const credential = connection?.credential ?? null;
    const capability = binding?.effortCapability ?? null;
    modelSettingsSnapshot.current = loaded.snapshot;
    // 快照就位后才打开编辑器：不存在「框已打开但保存基准尚未载入」的半初始化状态。
    dispatch({ kind: 'overlay-open', overlay: 'model-settings-editor' });
    dispatch({
      kind: 'model-settings-edit',
      field: 'label',
      edit: {
        role: target.role,
        label: connection?.label ?? binding?.connectionLabel ?? '',
        providerIntegration: connection?.providerIntegration ?? binding?.providerIntegration ?? '',
        model: binding?.model ?? '',
        options: formatModelOptions(connection?.modelOptions ?? {}),
        codexProviderId: connection?.codex?.providerId ?? '',
        codexBaseUrl: connection?.codex?.baseUrl ?? '',
        codexWireApi: connection?.codex?.wireApi ?? '',
        credentialKind: credential?.kind ?? 'harness_login',
        credentialRef: credential?.kind === 'managed' ? credential.credentialRef : '',
        credentialOptionPath: credential?.kind === 'managed' ? credential.optionPath : '',
        // 已有能力来源原样复用：界面既不发明也不静默清除它。
        effortSource: capability?.source ?? '',
        effortValues: capability?.values.join(',') ?? '',
        effortOptionPath: capability?.optionPath ?? '',
        secret: '',
      },
    });
  };
  /**
   * 保存内存中的编辑。
   *
   * 保存只追加不可变记录：成功后抹除 key、逐层返回并说明尚未应用；失败时保留全部字段，只更新
   * 结构化提示。
   */
  const saveModelSettings = async () => {
    const port = modelSettingsPort;
    const snapshot = modelSettingsSnapshot.current;
    const edit = stateRef.current.modelSettingsEdit;
    if (port === undefined || snapshot === null || edit === null) {
      dispatch({
        kind: 'model-settings-notice',
        notice:
          port === undefined
            ? '! model_settings_unavailable: 角色模型配置端口尚未接通'
            : '! config_reload_required: 编辑基于旧快照，请关闭后重新载入再保存',
      });
      return;
    }
    // 单次在途：保存期间不接受第二次提交，否则同 revision 会并发追加两条记录。
    if (modelSaveInFlight.current) {
      dispatch({ kind: 'model-settings-notice', notice: '! save_in_flight: 原保存仍在途，请等待结果' });
      return;
    }
    modelSaveInFlight.current = true;
    const invocation = modelInvocation.current;
    const navigation = navigationGeneration.current;
    const editVersion = modelEditVersion.current;
    const savedRevision = snapshot.revision;
    dispatch({ kind: 'model-settings-notice', notice: null });
    const draft = modelSettingsDraft(edit, snapshot.revision);
    if (draft.kind !== 'ok') {
      modelSaveInFlight.current = false;
      dispatch({ kind: 'model-settings-notice', notice: '! ' + draft.message });
      return;
    }
    let result;
    try {
      result = await port.save(draft.input);
    } catch {
      modelSaveInFlight.current = false;
      if (invocation !== modelInvocation.current || navigation !== navigationGeneration.current) return;
      dispatch({ kind: 'model-settings-notice', notice: '! save_failed: 保存未完成，原设置保留' });
      return;
    }
    modelSaveInFlight.current = false;
    if (invocation !== modelInvocation.current || navigation !== navigationGeneration.current) return;
    if (result.kind !== 'saved') {
      dispatch({ kind: 'model-settings-notice', notice: '! ' + result.code + ': ' + result.message });
      return;
    }
    // 用户在等待期间继续编辑：已保存的是发出请求时的快照，当前输入原样保留。
    // 服务只追加不可变记录，因此把 CAS 基准推进到结果 revision 就足以让当前编辑再次保存——
    // 既不丢输入、不清掉 key，也不需要关闭重开。真正的并发冲突仍由服务按实际 revision 拒绝。
    if (modelEditVersion.current !== editVersion) {
      modelSettingsSnapshot.current = { ...snapshot, revision: result.revision };
      dispatch({
        kind: 'model-settings-notice',
        notice:
          '原快照已保存（revision ' +
          String(savedRevision) +
          '）；当前编辑的保存基准已更新为 revision ' +
          String(result.revision) +
 '，再次 Enter 即可保存当前内容',
      });
      return;
    }
    // 保存不代表应用：抹除 key、关闭编辑器，并由用户另行显式应用。
    eraseModelSecret();
    modelSettingsSnapshot.current = null;
    dispatch({ kind: 'model-settings-edit', edit: null });
    dispatch({ kind: 'model-settings-notice', notice: '已保存新的不可变配置，尚未应用' });
    dispatch({ kind: 'notice', notice: '模型配置已保存新的不可变记录，尚未应用' });
    dispatch({ kind: 'overlay-close-top' });
    void reloadModelCatalog();
  };
  /**
   * 提交候选菜单的动作。
   *
   * 0 是返回，逐层退回模型配置页且不改变任何绑定。1 是应用选择：先由宿主保存该候选，Coordinator
   * 再按同一 Session 走既有切换意图，Worker 角色才打开完整 Manifest 审阅——任何情况下都不会
   * 自动批准。
   */
  const submitModelRole = async (action: number) => {
    if (action === 0) {
      dispatch({ kind: 'model-role-menu', menu: null });
      dispatch({ kind: 'overlay-close-top' });
      return;
    }
    const menu = stateRef.current.modelRoleMenu;
    const role = roleMenuRole();
    if (menu === null || role === null || menu.selectedCandidateRef === null) {
      dispatch({ kind: 'model-settings-notice', notice: '! 请先选择一个模型候选' });
      return;
    }
    const candidate = selectedRoleCandidate(role, menu.selectedCandidateRef);
    const efforts = effortValues(candidate);
    const effort = efforts.includes(menu.effort ?? '') ? menu.effort : null;
    if (efforts.length > 0 && effort === null) {
      dispatch({ kind: 'model-settings-notice', notice: '! effort_unsupported: 请先选择该模型支持的 effort' });
      return;
    }
    const port = modelSettingsPort;
    if (port === undefined) {
      dispatch({ kind: 'model-settings-notice', notice: '! model_settings_unavailable: 角色模型配置端口尚未接通' });
      return;
    }
    const revision = modelCatalog.configurationRevision;
    if (revision === undefined) {
      dispatch({ kind: 'model-settings-notice', notice: '! config_unreadable: 没有可用的配置 revision' });
      return;
    }
    const session = modelMenuTarget.current ?? stateRef.current.selectedSessionId;
    if (role.role === 'coordinator' && session === null) {
      dispatch({ kind: 'model-settings-notice', notice: '! session_missing: 未选择 Coordinator Session' });
      return;
    }
    // Coordinator 沿用既有挂起与在途操作的准入：不可切换时不必先保存候选。
    if (role.role === 'coordinator') {
      const admission = modelSwitchAdmission(modelCatalog);
      if (!admission.allowed) {
        setModelRejection(admission.reason);
        dispatch({ kind: 'model-settings-notice', notice: '! ' + (admission.reason ?? '当前不可切换') });
        return;
      }
    }
    // 同一次选择不允许并发应用：重复 Enter 会追加重复 profile，且后到的结果可能覆盖先到的。
    if (modelApplyInFlight.current) {
      dispatch({ kind: 'model-settings-notice', notice: '! apply_in_flight: 原应用仍在途，请等待结果' });
      return;
    }
    dispatch({ kind: 'model-settings-notice', notice: null });
    const invocation = modelInvocation.current;
    const navigation = navigationGeneration.current;
    const appliedRef = menu.selectedCandidateRef;
    const appliedEffort = effort;
    modelApplyInFlight.current = true;
    let saved;
    try {
      saved = await port.apply({ role: role.role, modelRef: menu.selectedCandidateRef, effort, expectedRevision: revision });
    } catch {
      modelApplyInFlight.current = false;
      if (invocation !== modelInvocation.current || navigation !== navigationGeneration.current) return;
      dispatch({ kind: 'model-settings-notice', notice: '! save_failed: 保存未完成，原设置保留' });
      return;
    }
    modelApplyInFlight.current = false;
    if (invocation !== modelInvocation.current || navigation !== navigationGeneration.current) return;
    if (saved.kind !== 'saved') {
      dispatch({ kind: 'model-settings-notice', notice: '! ' + saved.code + ': ' + saved.message });
      return;
    }
    // 等待期间改了候选或 effort：已保存的是旧选择。当前选择原样保留，刷新配置基准后可直接再应用。
    const currentMenu = stateRef.current.modelRoleMenu;
    if (
      currentMenu !== null &&
      (currentMenu.selectedCandidateRef !== appliedRef || currentMenu.effort !== appliedEffort)
    ) {
      void reloadModelCatalog();
      dispatch({
        kind: 'model-settings-notice',
        notice: '原选择已保存；当前选择尚未应用，配置基准已刷新，请再次确认应用',
      });
      return;
    }
    // Coordinator：按同一 Session 走既有切换意图，保留挂起与在途操作的原合同。
    if (role.role === 'coordinator') {
      if (saved.configurationRef === null) {
        dispatch({ kind: 'model-settings-notice', notice: '! result_ref_unavailable: 已保存但缺少新配置引用，请重新选择' });
        return;
      }
      const target = session;
      const generation = navigationGeneration.current;
      const result = await runMutation('model:' + String(target), () =>
        ports.execute({
          kind: 'switch-model-configuration',
          coordinatorSessionId: String(target),
          nextConfigurationRef: saved.configurationRef ?? '',
        }),
      );
      if (generation !== navigationGeneration.current || target !== stateRef.current.selectedSessionId) return;
      setModelRejection(result.kind === 'accepted' ? null : resultNotice(result));
      if (result.kind === 'accepted') {
        closeModelOverlays();
      }
      return;
    }
    // Worker 角色：profile 已保存，授权替换仍必须经过完整 Manifest 审阅与显式批准。
    // 审阅可能失败：失败时保留当前候选选择与焦点，用户可直接重试，而不是被丢回空白页。
    let loaded;
    try {
      loaded = await ports.executionAuthorization.review();
    } catch {
      if (invocation !== modelInvocation.current || navigation !== navigationGeneration.current) return;
      dispatch({ kind: 'model-settings-notice', notice: '! authorization_unreadable: 审阅未完成，保留当前选择，请重试' });
      return;
    }
    if (invocation !== modelInvocation.current || navigation !== navigationGeneration.current) return;
    setAuthorizationReview(loaded);
    dispatch({ kind: 'model-role-menu', menu: null });
    closeModelOverlays();
    openModelOverlay('authorization-review');
  };
  /**
   * 角色候选菜单的键位。
   *
   * 三块区域按定稿顺序循环：候选列表 → 独立 effort → 动作。只有当所选模型自己带可信能力来源时
   * 才存在 effort 区；没有来源时左右键不会产生任何 effort，因此无法保存虚构值。
   */
  const handleModelRoleMenuKey = (input: string, key: Key) => {
    const current=stateRef.current,menu=current.modelRoleMenu;
    if(menu===null)return;
    const role=roleMenuRole();
    const selection=current.dialogSelections['model-role-menu']??{query:emptyDraft(),selectedId:null};
    const choices=dialogChoicesFor('model-role-menu',selection.query.text);
    const candidate=()=>role===null?null:selectedRoleCandidate(role,menu.selectedCandidateRef);
    const moveCandidate=(delta:number)=>{
      if(choices.length===0)return;
      const index=choices.findIndex(choice=>choice.value===selection.selectedId);
      const next=choices[Math.max(0,Math.min(choices.length-1,index+delta))];
      if(next===undefined)return;
      dispatch({kind:'dialog-selection',overlay:'model-role-menu',query:selection.query,selectedId:next.value});
      const kept=effortValues(role===null?null:selectedRoleCandidate(role,next.value)).includes(menu.effort??'');
      dispatch({kind:'model-role-menu',menu:{...menu,selectedCandidateRef:next.value,effort:kept?menu.effort:null}});
    };
    if(key.tab){
      const focuses:ModelRoleMenuState['focus'][]=effortValues(candidate()).length>0?['list','effort','actions']:['list','actions'];
      const next=focuses[(focuses.indexOf(menu.focus)+(key.shift?focuses.length-1:1)+focuses.length)%focuses.length]??'list';
      dispatch({kind:'model-role-menu',menu:{...menu,focus:next,action:next==='actions'?0:menu.action}});
      return;
    }
    if(menu.focus==='list'){
      if(key.upArrow){moveCandidate(-1);return;}
      if(key.downArrow){moveCandidate(1);return;}
    }
    if(menu.focus==='effort'){
      const values=effortValues(candidate());
      if(values.length>0&&(key.leftArrow||key.rightArrow)){
        const index=values.indexOf(menu.effort??'');
        const next=values[(((index+(key.rightArrow?1:values.length-1))%values.length)+values.length)%values.length];
        if(next!==undefined)dispatch({kind:'model-role-menu',menu:{...menu,effort:next}});
        return;
      }
    }
    if(menu.focus==='actions'&&(key.upArrow||key.downArrow||key.leftArrow||key.rightArrow)){
      dispatch({kind:'model-role-menu',menu:{...menu,action:menu.action===0?1:0}});
      return;
    }
    if(key.return&&!key.meta&&!key.shift){
      if(menu.focus==='actions'){void submitModelRole(menu.action);return;}
      const hasEffort=effortValues(candidate()).length>0;
      dispatch({kind:'model-role-menu',menu:{...menu,focus:menu.focus==='list'?(hasEffort?'effort':'actions'):'actions',action:0}});
      return;
    }
    if(menu.focus==='list'){
      const edited=editComposer(selection.query,input,key);
      if(edited!==selection.query){
        // 查询收敛后必须同时移动权威选择：否则 Enter 会应用一个已经不在可见列表里的候选。
        const text=boundedQuery(edited.text),query={...edited,text,cursor:Math.min(edited.cursor,text.length)};
        const matches=dialogChoicesFor('model-role-menu',text);
        const selectedId=matches.some(choice=>choice.value===selection.selectedId)?selection.selectedId:matches[0]?.value??null;
        dispatch({kind:'dialog-selection',overlay:'model-role-menu',query,selectedId});
        const candidate=role===null?null:selectedRoleCandidate(role,selectedId);
        dispatch({kind:'model-role-menu',menu:{...menu,selectedCandidateRef:selectedId,effort:effortValues(candidate).includes(menu.effort??'')?menu.effort:null}});
      }
    }
  };
  /**
   * 连接编辑器的键位。
   *
   * 字段值只改内存中的 ModelSettingsEdit，从不构造 UiDraft，因此不会进入 IC-13 的草稿存储、
   * 提交快照或恢复路径。Enter 直接保存，Esc 由 overlay 关闭路径抹除 key。
   */
  const handleModelSettingsEditorKey = (input: string, key: Key) => {
    const current=stateRef.current,edit=current.modelSettingsEdit;
    if(edit===null)return;
    // 保存在途时 Enter 不再重复提交；输入仍然可用，编辑不会被静默冻结或丢弃。
    if(key.return&&!key.meta&&!key.shift){
      if(modelSaveInFlight.current){dispatch({kind:'model-settings-notice',notice:'! save_in_flight: 原保存仍在途，请等待结果'});return;}
      void saveModelSettings();
      return;
    }
    if(key.upArrow||key.downArrow){
      // 导航与渲染共用同一份可见字段：隐藏的 API Key 不会被光标指向，也不会被数进行号。
      const fields=visibleModelSettingsFields(edit.credentialKind);
      const cursor=Math.max(0,fields.indexOf(current.modelSettingsField));
      const next=fields[(cursor+(key.upArrow?-1:1)+fields.length)%fields.length];
      if(next!==undefined)dispatch({kind:'model-settings-edit',edit,field:next});
      return;
    }
    const field=current.modelSettingsField;
    if(field==='options'&&(key.leftArrow||key.rightArrow))return;
    const next=editModelSettingsField(edit,field,input,key);
    if(next===edit)return;
    // 凭据来源切回 harness_login 时本次输入的 key 被清空：明确告知，不静默丢弃。
    if(edit.secret!==''&&next.secret===''){
      dispatch({kind:'model-settings-notice',notice:'凭据来源已切回 Harness 登录，本次输入的 API Key 已从内存清除'});
    }
    dispatch({kind:'model-settings-edit',edit:next,field:current.modelSettingsField});
  };
  const workspaceActions: WorkspaceActions = {
    dispatch,
    composerChange: (draft) => {
      inputHistory.cancel(); updateHistoryPreview(null);
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
          dispatch({ kind: 'notice', notice: `切换前输入未保存：${saveOutcomeText(flushed)}；请通过 /inputs 处理` }); return;
        }
      }
      answerReturn.current = null; answerRequest.current++;
      historyContextRef.current?.abort.abort(); updateHistoryContext(null); inputHistory.cancel(); updateHistoryPreview(null); reader.highlight(null);
      dispatch({ kind: 'session-selected', coordinatorSessionId });
      answerRequest.current++;
      updateAnswerPanel(null);
      dispatch({ kind: 'overlay-close-all' });
    },
    enterAnswer: (interactionId, expectedRevision) => {
      // 进入回答模式前先把当前草稿落盘，避免模式切换丢掉未保存输入。
      if (protection.hasUnsaved()) {
        const flushed = protection.flushAll();
        if (flushed.status !== 'saved') {
          dispatch({ kind: 'notice', notice: `进入回答模式前输入未保存：${saveOutcomeText(flushed)}` });
        }
      }
      const item = viewModelRef.current?.interactions.find(item => item.interactionId === interactionId);
      if (item) void showAnswer({ ...item, expectedRevision }, 0, 1);
      else dispatch({ kind: 'notice', notice: '问题已移出当前窗口，请从待答列表重新读取' });
    },
    runCommand: (command) => {
      void runCommand(command);
    },
    selectRecipient: (coordinatorSessionId) => {
      void runCommand(stateRef.current.handoffCommand,coordinatorSessionId);
    },
    openModelRole: () => {
      openModelRole();
    },
    saveModelSettings: () => {
      void saveModelSettings();
    },
    submitModelRole: (action) => {
      void submitModelRole(action);
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
    closeTopOverlay: () => {
      // 逐层返回也是一条擦除路径：离开编辑器时立刻丢弃内存中的 key。
      if (topOverlay() === 'model-settings-editor') {
        modelInvocation.current += 1;
        eraseModelSecret();
        modelSettingsSnapshot.current = null;
        dispatch({ kind: 'model-settings-edit', edit: null });
      }
      if (topOverlay() === 'model-role-menu') {
        dispatch({ kind: 'model-role-menu', menu: null });
      }
      dispatch({ kind: 'overlay-close-top' });
    },
  };

  historyKeyRef.current = kind => { void beginHistoryContext(kind); };

  const dialogChoicesFor = (overlay: OverlayKind, query: string) => {
    if(overlay==='command-palette'||overlay==='options')return searchCommands(query).filter(id=>overlay!=='options'||COMMAND_METADATA[id].path.startsWith('选项 →')).map(value=>({value}));
    if(overlay==='model-role-menu')return filterChoices(dedupeRoleCandidates(roleMenuRole()?.candidates??[]).map(candidate=>({value:candidate.candidateRef,label:candidateLabel(candidate),description:candidate.candidateRef})),query);
    const scope=snapshotRef.current,source=scope?.mode==='route_planning'?scope.sessions.find(s=>s.planningResponsible)?.coordinatorSessionId:scope?.executionLeaseHolderSessionId;
    return filterChoices(sessionChoices((viewModelRef.current?.sessions??[]).filter(s=>overlay!=='handoff-target'||s.coordinatorSessionId!==source),stateRef.current.selectedSessionId),query);
  };
  const changeDialogQuery = (overlay: OverlayKind, edited: UiDraft) => {
    const text=boundedQuery(edited.text),query={...edited,text,cursor:Math.min(edited.cursor,text.length)};
    const selected=stateRef.current.dialogSelections[overlay]?.selectedId??null,matches=dialogChoicesFor(overlay,text);
    dispatch({kind:'dialog-selection',overlay,query,selectedId:matches.some(o=>o.value===selected)?selected:matches[0]?.value??null});
  };

  useInput((input, key) => {
    if (key.eventType === 'release') return;
    if(resolveGlobalAction(input,key)==='exit'){void runCommand('exit');return;}
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
    const history = historyContextRef.current;
    if (history !== null) {
      if (key.escape) { closeHistoryContext(); return; }
      if (history.kind === 'activity') {
        if (action === 'enter-answer' && history.call?.name === 'ask_user') {
          const call = history.call;
          void openAnswerRef.current(userQuestionInteractionId(call.operationId), undefined, true); return;
        }
        if (key.upArrow || key.downArrow) void seekHistory(history, key.upArrow ? 'older' : 'newer');
        if (key.return && history.call !== null) dispatch({ kind: 'tool-toggled', entryId: history.call.activityId });
        return;
      }
      if (key.return) {
        if (history.kind === 'users' && historyPreviewRef.current !== null && !history.busy) closeHistoryContext(historyPreviewRef.current);
        else void seekHistory(history, key.shift || history.kind === 'users' && history.hit === null ? 'older' : 'newer', history.hit === null);
        return;
      }
      if (history.kind === 'users' && (key.upArrow || key.downArrow)) { void seekHistory(history, key.upArrow ? 'older' : 'newer'); return; }
      changeHistoryQuery(editComposer(history.query, input, key)); return;
    }
    if (action === 'escape') {
      if (inputHistory.active || historyPreviewRef.current !== null) { inputHistory.cancel(); updateHistoryPreview(null); return; }
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
      if(topOverlay()==='handoff-review'){void cancelHandoff();return;}
      if(topOverlay()==='execution-handoff-review'){void cancelExecutionHandoff();return;}
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
        if (saved.status !== 'saved') { dispatch({ kind: 'notice', notice: saveOutcomeText(saved) + '；请通过 /inputs 处理' }); return; }
        if (returnAnswerRef.current()) return;
        updateAnswerPanel(null);
        dispatch({ kind: 'composer-mode-reset' });
        return;
      }
      const selected = stateRef.current.selectedSessionId;
      if (selected !== null && historyReading.current) {
        void loadTranscript(selected, null, true);
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
      void runCommand('command-directory');
      return;
    }
    if (action === 'toggle-sidebar') {
      void runCommand('project',undefined,true);
      return;
    }
    if (action === 'graph-inspector') {
      answerRequest.current++;
      void runCommand('graph-inspector');
      return;
    }
    if (action === 'enter-answer') {
      if (stateRef.current.screen === 'workspace') void runCommand('answer');
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
    if(overlay==='model-picker'){
      // 角色列表没有查询框：上下移动角色，Enter 进入候选菜单，e 直接编辑该角色的连接。
      const roles=modelRoleList();
      if(key.upArrow||key.downArrow){
        dispatch({kind:'model-role-selected',index:Math.max(0,Math.min(roles.length-1,stateRef.current.modelRoleIndex+(key.upArrow?-1:1)))});return;
      }
      if(input==='e'||input==='E'){void openModelSettingsEditor();return;}
      if(key.return&&!key.meta&&!key.shift){openModelRole();return;}
      return;
    }
    if(overlay==='model-role-menu'){
      handleModelRoleMenuKey(input,key);
      return;
    }
    if(overlay==='model-settings-editor'){
      handleModelSettingsEditorKey(input,key);
      return;
    }
    if(overlay==='command-palette'||overlay==='options'||overlay==='session-picker'||overlay==='handoff-target'){
      const selection=stateRef.current.dialogSelections[overlay]??{query:emptyDraft(),selectedId:null};
      const choices=dialogChoicesFor(overlay,selection.query.text);
      const index=choices.findIndex(o=>o.value===selection.selectedId);
      if(key.upArrow||key.downArrow){
        const item=choices[Math.max(0,Math.min(choices.length-1,index+(key.upArrow?-1:1)))];
        dispatch({kind:'dialog-selection',overlay,query:selection.query,selectedId:item?.value??null});return;
      }
      if(key.return&&!key.meta&&!key.shift){
        const chosen=choices.find(o=>o.value===selection.selectedId);
        if(!chosen){dispatch({kind:'notice',notice:'请明确选择当前结果'});return;}
        if(overlay==='command-palette'||overlay==='options')void runCommand(chosen.value as CommandId);
        else if(overlay==='handoff-target')workspaceActions.selectRecipient?.(chosen.value);
        else workspaceActions.selectSession(chosen.value);
        return;
      }
      const edited=editComposer(selection.query,input,key);
      if(edited!==selection.query)changeDialogQuery(overlay,edited);
      return;
    }
    if(overlay==='help'){
      if(key.upArrow||key.downArrow)dispatch({kind:'review-view',scroll:Math.max(0,Math.min(HELP_LINES.length+COMMAND_IDS.length-1,stateRef.current.reviewScroll+(key.upArrow?-1:1)))});
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
      void runCommand('transcript-details');
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

    if (topOverlay() !== null) {
      if(key.tab){dispatch({kind:'review-view',tab:(stateRef.current.reviewTab+1)%(topOverlay()==='authorization-review'?5:3),scroll:0});return;}
      if(key.upArrow||key.downArrow){dispatch({kind:'review-view',scroll:Math.max(0,stateRef.current.reviewScroll+(key.upArrow?-1:1))});return;}
      if(key.leftArrow||key.rightArrow){dispatch({kind:'review-view',action:stateRef.current.reviewAction===0?1:0});return;}
      if(key.return){
        if(stateRef.current.reviewAction===0){if(topOverlay()==='handoff-review')void cancelHandoff();else if(topOverlay()==='execution-handoff-review')void cancelExecutionHandoff();else dispatch({kind:'overlay-close-top'});return;}
        if(topOverlay()==='handoff-review')void confirmHandoff();
        if(topOverlay()==='execution-handoff-review')void confirmExecutionHandoff();
        if(topOverlay()==='authorization-review')void confirmAuthorization();
      }
      return;
    }
    const project=stateRef.current.projectPanel;
    if(project.open){
      const view=viewModelRef.current;if(!view)return;
      if (project.tab === 1 && project.detail === null && (key.pageUp || key.pageDown)) { void loadScopeQuestions(key.pageUp ? -1 : 1); return; }
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
        const interaction=(view.pendingPage?.items ?? view.interactions).find(i=>i.interactionId===item.key);
        if(interaction?.state==='open'){
          void showAnswer(interaction, 0, 1, true);return;
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
        if(command){const reason=commandReason(command,{mode:snapshotRef.current?.mode??'route_planning',selectedSessionId:stateRef.current.selectedSessionId,pasteBlocks:inputDraft.pasteBlocks.length,...(ports.modelSettings===undefined?{}:{modelSettings:true})});
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
    const readingSession = stateRef.current.selectedSessionId;
    if (readingSession !== null && (key.pageUp || key.pageDown || (key.ctrl && (key.home || key.end)))) {
      if (key.ctrl && key.home) { void loadTranscript(readingSession, 'oldest', true); return; }
      if (key.ctrl && key.end) { void loadTranscript(readingSession, null, true); return; }
      void reader.move(key.pageUp ? 'older' : 'newer').then(applyTranscriptFrame).catch(error => {
        dispatch({ kind: 'notice', notice: '历史读取失败：' + (error instanceof Error ? error.message : String(error)) });
      });
      return;
    }
    if (key.ctrl && input === 'r') {
      void runCommand('input-history'); return;
    }
    if (action === 'search-history' || action === 'navigate-activity') { functionKeyRef.current(action); return; }
    const ordinary = stateRef.current.composerMode.kind === 'message' && readingSession !== null && !isComposerReadOnly(stateRef.current, readingSession);
    const draft = historyPreviewRef.current ?? composerInputFor(stateRef.current, readingSession);
    if (ordinary && !key.ctrl && !key.meta && (key.upArrow || key.downArrow) &&
      (key.upArrow && draft.text === '' || inputHistory.canMove(draft, key.upArrow ? 'older' : 'newer'))) {
      const session = readingSession;
      void inputHistory.move(session, draft, key.upArrow ? 'older' : 'newer').then(value => {
        if (stateRef.current.selectedSessionId === session && value !== null) updateHistoryPreview(inputHistory.active ? value : null);
      }).catch(error => dispatch({ kind: 'notice', notice: '输入历史读取失败：' + String(error) })); return;
    }
    if (historyPreviewRef.current !== null) {
      if (key.return && !key.meta && !key.shift) {
        workspaceActions.composerChange(historyPreviewRef.current); workspaceActions.submit(); return;
      }
      const edited = editComposer(draft, input, key, composerContentWidth(bodyWidth(terminalWidth, stateRef.current.sidebarDensity)));
      if (edited.text !== draft.text || edited.pasteBlocks !== draft.pasteBlocks) workspaceActions.composerChange(edited);
      else updateHistoryPreview(edited);
      return;
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
    const overlay=current.overlayStack.at(-1);
    if(current.pendingConfirmation===null&&overlay&&['command-palette','options','session-picker','handoff-target','model-picker'].includes(overlay)){
      const selected=current.dialogSelections[overlay]??{query:emptyDraft(),selectedId:null};
      changeDialogQuery(overlay,editComposer(selected.query,text.replace(/\r\n?/gu,'\n'),{}));return;
    }
    if (current.pendingConfirmation !== null || current.overlayStack.length > 0 || current.projectPanel.open) {
      return;
    }
    if (historyContextRef.current !== null) {
      const context = historyContextRef.current;
      if (context.kind !== 'activity') changeHistoryQuery(editComposer(context.query, text.replace(/\r\n?/gu, '\n'), {}));
      return;
    }
    if (historyPreviewRef.current !== null) workspaceActions.composerChange(historyPreviewRef.current);
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
      onTranscriptHeight={recordTranscriptHeight}
      transcriptFrame={transcriptFrame}
      historyPreview={historyPreview}
      historyContext={historyContext === null ? null : { label: historyContext.kind === 'transcript' ? 'F3 查找' : historyContext.kind === 'users' ? 'Ctrl+R 输入历史' : 'F4 活动',
        draft: historyContext.query, feedback: historyContext.feedback, editable: historyContext.kind !== 'activity' }}
      events={events}
      actions={workspaceActions}
      modelCatalog={modelCatalog}
      modelRejection={modelRejection}
      modelSettingsAvailable={modelSettingsPort!==undefined}
      modelRole={state.overlayStack.at(-1)==='model-role-menu'?roleMenuRole():highlightedRole()}
      modelIdentity={[viewModel.scope.coordinationScopeId,viewModel.scope.mode==='route_planning'?'规划':'执行',state.selectedSessionId??'未选择会话'].join(' · ')}
      modelSettingsEdit={state.modelSettingsEdit}
      paletteSelection={Math.max(0,searchCommands(state.dialogSelections[state.overlayStack.at(-1)??'command-palette']?.query.text??'').filter(id=>state.overlayStack.at(-1)!=='options'||COMMAND_METADATA[id].path.startsWith('选项 →')).indexOf(state.dialogSelections[state.overlayStack.at(-1)??'command-palette']?.selectedId as CommandId))}
      composerDisabledReason={
        viewModel.compaction?.status === 'context_exhausted'
          ? 'context_exhausted：已停止发起新的模型调用'
          : null
      }
      newlineHint="Alt+Enter 换行"
      handoffProposal={planningReview}
      executionReview={executionReview}
      authorizationReview={authorizationReview}
      commands={state.overlayStack.at(-1)==='command-palette'||state.overlayStack.at(-1)==='options'?searchCommands(state.dialogSelections[state.overlayStack.at(-1)!]?.query.text??''):COMMAND_IDS}
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
