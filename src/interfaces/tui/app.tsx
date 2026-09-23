/**
 * TUI 容器：唯一持有输入映射、加载与命令派发的地方。
 *
 * 硬边界：
 * - 所有加载都是只读 query；`execute` 只在用户明确动作（提交、命令、回答、切换模型、交接确认）时调用，
 *   因此 render/effect/resize/重挂载不可能触发恢复、派发、重试或写入；
 * - 事件只进入 Event Drawer 投影与未读标记，不切换 transcript、不抢占 composer、不改变 Scope 级图；
 * - 没有 TTY 判断：那发生在挂载 Ink 之前的 `src/bootstrap/tui-entry.ts`。
 */

import { Box, Text, useInput, useWindowSize } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { resolveGlobalAction } from './input/keymap.js';
import { allowedSidebarDensity } from './render/width.js';
import { requiresConfirmation } from './components/control-bar.js';
import {
  draftFor,
  executionFilterLabel,
  initialTuiState,
  isComposerReadOnly,
  nextExecutionFilter,
  reduceTuiState,
  type OverlayKind,
  type PendingConfirmation,
  type TuiAction,
  type TuiState,
} from './state.js';
import { Home } from './screens/home.js';
import { Wizard, allChecksPassed } from './screens/wizard.js';
import { Workspace, type WorkspaceActions } from './screens/workspace.js';
import { COMMAND_IDS, type CommandId } from './components/command-palette.js';
import { preferredSessionId } from './components/session-picker.js';
import { modelSwitchAdmission } from './components/model-picker.js';
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

export function TuiApp(props: TuiAppProps) {
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
  const sessionPickerSelection = useSelectionCursor();
  const modelSelection = useSelectionCursor();
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog>(EMPTY_MODEL_CATALOG);
  const [modelRejection, setModelRejection] = useState<string | null>(null);
  const [handoffProposalId, setHandoffProposalId] = useState<string | null>(null);
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

  const scopeIdRef = useRef(scopeId);
  scopeIdRef.current = scopeId;

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

  // 选中 Session 后加载其 transcript。
  useEffect(() => {
    if (state.selectedSessionId === null || state.screen !== 'workspace') {
      return;
    }
    void loadTranscript(state.selectedSessionId);
  }, [loadTranscript, state.selectedSessionId, state.screen]);

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
    });
  }, [snapshot, state, transcript]);
  const viewModelRef = useRef<TuiViewModel | null>(null);
  viewModelRef.current = viewModel;

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
    if (session === null) {
      return;
    }
    const text = draftFor(current, session);
    if (text.length === 0 || isComposerReadOnly(current, session)) {
      return;
    }
    // `context_exhausted` 表示上下文无法安全收敛：界面不再发起新的模型调用。
    if (viewModelRef.current?.compaction?.status === 'context_exhausted') {
      dispatch({ kind: 'notice', notice: 'context_exhausted：已停止发起新的模型调用' });
      return;
    }
    const result =
      current.composerMode.kind === 'answer'
        ? await ports.execute({
            kind: 'answer-pending-interaction',
            interactionId: current.composerMode.interactionId,
            expectedRevision: current.composerMode.expectedRevision,
            answer: text,
          })
        : await ports.execute({ kind: 'send-session-message', coordinatorSessionId: session, content: text });
    dispatch({ kind: 'notice', notice: resultNotice(result) });
    if (result.kind === 'accepted') {
      dispatch({ kind: 'draft-changed', coordinatorSessionId: session, text: '' });
      dispatch({ kind: 'composer-mode-reset' });
      await reload();
    }
    // 拒绝（含 stale revision）时保留输入内容，只提示重读。
  }, [dispatch, ports, reload]);

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
  }, [dispatch, onExit]);

  /** 确认一次待确认动作；`exit` 只结束前台进程，`cancel` 提交取消意图。 */
  const confirmPending = useCallback(
    (pending: Exclude<PendingConfirmation, null>) => {
      if (pending.kind === 'exit') {
        onExit();
        return;
      }
      void applyScopeControl('cancel');
    },
    [applyScopeControl, onExit],
  );

  const runCommand = useCallback(
    async (command: CommandId) => {
      const current = stateRef.current;
      const session = current.selectedSessionId;
      dispatch({ kind: 'overlay-close-top' });
      switch (command) {
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
          // Target 必须由用户明确选择：这里用 Session Picker 里当前选中的 Session 作为接收方，
          // 不替用户挑一个（宿主会拒绝 Source 与 Target 相同的提案）。
          const target = stateRef.current.selectedSessionId;
          if (target === null) {
            dispatch({ kind: 'notice', notice: '先在 Session Picker 里选中接收规划责任的 Session，再发起交接' });
            return;
          }
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
          const sessions = viewModelRef.current?.sessions ?? [];
          const current = sessions.findIndex(
            (session) => session.coordinatorSessionId === stateRef.current.selectedSessionId,
          );
          sessionPickerSelection.set(current < 0 ? 0 : current);
          dispatch({ kind: 'overlay-open', overlay: 'session-picker' });
          return;
        }
        case 'event-drawer':
          dispatch({ kind: 'overlay-open', overlay: 'event-drawer' });
          return;
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
            notice: 'Ctrl+P 命令 · Ctrl+B Sidebar · Ctrl+G Inspector · Ctrl+T 工具详情 · Ctrl+A 回答 · Esc 关闭',
          });
          return;
        case 'pause':
        case 'resume':
        case 'cancel':
          requestScopeControl(command);
          return;
        case 'execution-handoff': {
          // 接收方必须由用户在 Session Picker 里明确选中；界面不替用户挑一个 Target。
          const target = stateRef.current.selectedSessionId;
          if (target === null) {
            dispatch({ kind: 'notice', notice: '先在 Session Picker 里选中接收执行责任的 Session，再发起交接' });
            return;
          }
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
      }
    },
    [dispatch, ports, reload, requestExit, requestScopeControl, terminalWidth],
  );

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
    composerChange: (text) => {
      const session = stateRef.current.selectedSessionId;
      if (session === null) {
        return;
      }
      dispatch({ kind: 'draft-changed', coordinatorSessionId: session, text });
    },
    submit: () => {
      void submit();
    },
    toggleTool: (entryId) => dispatch({ kind: 'tool-toggled', entryId }),
    selectSession: (coordinatorSessionId) => {
      dispatch({ kind: 'session-selected', coordinatorSessionId });
      dispatch({ kind: 'overlay-close-top' });
    },
    enterAnswer: (interactionId, expectedRevision) =>
      dispatch({ kind: 'answer-mode-entered', interactionId, expectedRevision }),
    runCommand: (command) => {
      void runCommand(command);
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
    closeTopOverlay: () => dispatch({ kind: 'overlay-close-top' }),
  };

  useInput((input, key) => {
    // 待确认动作是唯一的模态输入：确认前 `y`/`n`/`Esc` 之外的内容被吞掉，不会落到 composer。
    const pending = stateRef.current.pendingConfirmation;
    if (pending !== null) {
      if (input === 'y') {
        dispatch({ kind: 'confirmation-dismissed' });
        confirmPending(pending);
        return;
      }
      if (input === 'n' || key.escape === true) {
        dispatch({ kind: 'confirmation-dismissed' });
        return;
      }
      return;
    }
    const action = resolveGlobalAction(input, { ctrl: key.ctrl, escape: key.escape });
    if (action === 'exit') {
      // Exit 与 `Ctrl+C` 只结束前台进程；Scope 不因此进入暂停或取消。
      requestExit();
      return;
    }
    if (action === 'escape') {
      if (stateRef.current.overlayStack.length > 0) {
        dispatch({ kind: 'overlay-close-top' });
        return;
      }
      if (stateRef.current.screen === 'wizard' || stateRef.current.screen === 'legacy-review') {
        dispatch({ kind: 'screen', screen: 'home' });
      }
      return;
    }
    if (action === 'command-palette') {
      paletteSelection.set(0);
      dispatch({ kind: 'overlay-open', overlay: 'command-palette' });
      return;
    }
    if (action === 'toggle-sidebar') {
      dispatch({ kind: 'sidebar-toggle', allowed: allowedSidebarDensity(terminalWidth) });
      return;
    }
    if (action === 'graph-inspector') {
      dispatch({ kind: 'overlay-open', overlay: 'graph-inspector' });
      return;
    }
    if (action === 'enter-answer') {
      const session = stateRef.current.selectedSessionId;
      // 尚无选中 Session 时（Home→workspace 的过渡帧）取第一条待答交互，而不是报「没有待答问题」。
      const pending = viewModelRef.current?.interactions.find(
        (interaction) =>
          interaction.state === 'open' &&
          (session === null || interaction.ownerCoordinatorSessionId === session),
      );
      if (pending === undefined) {
        dispatch({ kind: 'notice', notice: '当前 Session 没有待答的 Pending Interaction' });
        return;
      }
      dispatch({
        kind: 'answer-mode-entered',
        interactionId: pending.interactionId,
        expectedRevision: pending.expectedRevision,
      });
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
      handleModelKey(key, {
        options: modelCatalog.options,
        cursor: modelSelection,
        // 准入不满足时 Enter 不提交：界面不替 Controller 猜「也许可以」。
        select: modelSwitchAdmission(modelCatalog).allowed ? workspaceActions.selectModel : () => undefined,
      });
      return;
    }
    if (topOverlay() === 'graph-inspector') {
      handleInspectorKey(key, {
        nodes: viewModelRef.current?.graph?.nodes ?? [],
        selection: stateRef.current.inspectorSelection,
        select: (workPackageId) => dispatch({ kind: 'inspector-selected', workPackageId }),
      });
      return;
    }
    if (topOverlay() === 'session-picker') {
      handleSessionPickerKey(key, {
        sessions: viewModelRef.current?.sessions.map((session) => session.coordinatorSessionId) ?? [],
        cursor: sessionPickerSelection,
        select: workspaceActions.selectSession,
      });
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
    if (topOverlay() !== null) {
      // 其余 overlay 只支持 Esc（已在上面处理）与 Enter 的默认动作。
      if (key.return === true && topOverlay() === 'handoff-review') {
        void confirmHandoff();
      }
      if (key.return === true && topOverlay() === 'execution-handoff-review') {
        void confirmExecutionHandoff();
      }
      return;
    }
    handleComposerKey(input, key, {
      readOnly: isComposerReadOnly(stateRef.current, stateRef.current.selectedSessionId),
      draft: draftFor(stateRef.current, stateRef.current.selectedSessionId),
      change: workspaceActions.composerChange,
      submit: workspaceActions.submit,
    });
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
      events={events}
      actions={workspaceActions}
      modelCatalog={modelCatalog}
      modelRejection={modelRejection}
      paletteSelection={paletteSelection.value}
      modelSelection={modelSelection.value}
      composerDisabledReason={
        viewModel.compaction?.status === 'context_exhausted'
          ? 'context_exhausted：已停止发起新的模型调用'
          : null
      }
      newlineHint="Shift+Enter 换行"
      handoffProposal={
        viewModel.planningHandoffs.find((entry) => entry.proposalId === handoffProposalId) ?? null
      }
      commands={COMMAND_IDS}
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
  if (index < 0) {
    return;
  }
  const current = context.nodes[index];
  if (current === undefined) {
    return;
  }
  if (key.rightArrow === true) {
    // 沿依赖方向移动到上游节点。
    const upstream = context.nodes.find((node) => node.workPackageId === current.dependsOn[0]);
    if (upstream !== undefined) {
      context.select(upstream.workPackageId);
    }
    return;
  }
  if (key.leftArrow === true) {
    const downstream = context.nodes.find((node) => node.dependsOn.includes(current.workPackageId));
    if (downstream !== undefined) {
      context.select(downstream.workPackageId);
    }
  }
}

function handleSessionPickerKey(
  key: { readonly upArrow?: boolean; readonly downArrow?: boolean; readonly return?: boolean },
  context: {
    readonly sessions: readonly string[];
    readonly cursor: SelectionCursor;
    readonly select: (coordinatorSessionId: string) => void;
  },
): void {
  if (key.upArrow === true) {
    context.cursor.move(-1, context.sessions.length - 1);
    return;
  }
  if (key.downArrow === true) {
    context.cursor.move(1, context.sessions.length - 1);
    return;
  }
  if (key.return === true) {
    const session = context.sessions[context.cursor.current()];
    if (session !== undefined) {
      context.select(session);
    }
  }
}

function handleModelKey(
  key: { readonly upArrow?: boolean; readonly downArrow?: boolean; readonly return?: boolean },
  context: {
    readonly options: readonly ModelCatalog['options'][number][];
    readonly cursor: SelectionCursor;
    readonly select: (configurationRef: string) => void;
  },
): void {
  if (key.upArrow === true) {
    context.cursor.move(-1, context.options.length - 1);
    return;
  }
  if (key.downArrow === true) {
    context.cursor.move(1, context.options.length - 1);
    return;
  }
  if (key.return === true) {
    const option = context.options[context.cursor.current()];
    if (option !== undefined) {
      context.select(option.configurationRef);
    }
  }
}

export type ComposerKeyContext = {
  readonly readOnly: boolean;
  readonly draft: string;
  readonly change: (text: string) => void;
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
  key: { readonly backspace?: boolean; readonly return?: boolean; readonly shift?: boolean; readonly meta?: boolean },
  context: ComposerKeyContext,
): void {
  if (context.readOnly) {
    return;
  }
  if (key.return === true) {
    if (key.shift === true || key.meta === true) {
      context.change(`${context.draft}\n`);
      return;
    }
    context.submit();
    return;
  }
  if (key.backspace === true) {
    context.change(context.draft.slice(0, -1));
    return;
  }
  if (input.length === 0) {
    return;
  }
  context.change(`${context.draft}${input}`);
}
