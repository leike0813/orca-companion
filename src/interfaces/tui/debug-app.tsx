/**
 * 调试前台（`ocp --debug`）：只有会话/模型选择与对话，没有 Scope、执行图、Worker 或协调授权。
 *
 * 界面只依赖应用端口 `DebugHarnessPort`：会话、模型、轮次、提交与停止都由宿主决定，界面不构造
 * 身份，也不复制端口。渲染与输入复用既有管线：`Conversation`（有界 transcript 区域）、`Composer`、
 * `TranscriptReader`（IC-11 有界阅读与滚动）、`input-protection`（IC-13 草稿/提交保护）、
 * `handleComposerKey`（唯一键位映射）与 `commands.ts`（命令与键位的唯一来源）。
 */

import { Box, Text, useInput, usePaste, useWindowSize } from 'ink';
import { ThemeProvider } from '@inkjs/ui';
import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from 'react';

import { CommandPalette } from './components/command-palette.js';
import { Composer } from './components/composer.js';
import { formatContextStatus } from './components/status-line.js';
import { Conversation } from './components/conversation.js';
import { InputRecordManager, type InputManagerEntry, type InputRecordManagerView } from './components/input-record-manager.js';
import { PasteViewer, type PasteViewerView } from './components/paste-viewer.js';
import { ProviderLibraryEditor } from './components/provider-library-editor.js';
import { DialogFrame } from './components/selection-list.js';
import {
  COMMAND_METADATA,
  commandReason,
  conversationCommands,
  helpLines,
  boundedQuery,
  literalMatch,
  parseSlashInput,
  slashCandidates,
  type CommandId,
} from './commands.js';
import { emptyDraft, textDraft } from './input/composer-editor.js';
import { handleComposerKey } from './input/composer-key.js';
import { createInputProtection, type SaveOutcome } from './input/input-protection.js';
import { resolveGlobalAction } from './input/keymap.js';
import { TranscriptReader, type TranscriptFrame } from './render/transcript-reader.js';
import { useTranscriptMouse, inTranscript, type TranscriptRegion } from './input/transcript-mouse.js';
import { composerContentWidth, truncateToDisplayWidth } from './render/width.js';
import type { ComposerMode } from './state.js';
import { tuiColors, tuiTheme } from './theme.js';
import type { AgentTurnState } from '../../application/ports/agent-turn.js';
import type {
  DebugHarnessPort,
  DebugHomeLoad,
  DebugOpenInput,
  DebugSessionState,
} from '../../application/ports/debug-harness.js';
import {
  targetNamespace,
  type UiDraft,
  type UiInputRecord,
  type UiInputTarget,
} from '../../application/ports/ui-input-store.js';

export type DebugAppProps = {
  readonly harness: DebugHarnessPort;
  readonly terminalWidth: number;
  readonly onExit: () => void;
};

/** 调试目录与 slash 的命令集合：唯一来源是 commands.ts 的对话命令白名单。 */
const debugCommands = (query = ''): readonly CommandId[] => conversationCommands().filter(id => {
  const meta = COMMAND_METADATA[id];
  return literalMatch(query, id, meta.label, meta.description, meta.alias ?? '', meta.path);
});

type DebugHome = Extract<DebugHomeLoad, { readonly kind: 'home' }>;

// 同一 PTY 批次里的后续按键必须读到前一键的结果，不能等 React 提交下一帧。
function useImmediateState<T>(initial: T) {
  const [value, setValue] = useState(initial);
  const current = useRef(value);
  const update = useCallback((next: SetStateAction<T>) => {
    current.current = typeof next === 'function' ? (next as (previous: T) => T)(current.current) : next;
    setValue(current.current);
  }, []);
  return [value, update, current] as const;
}

export function DebugApp(props: DebugAppProps) {
  return <ThemeProvider theme={tuiTheme}><DebugShell {...props} /></ThemeProvider>;
}

function reasonText(outcome: SaveOutcome): string {
  return outcome.status === 'saved' ? '' : outcome.status + ': ' + outcome.message;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function modelLabel(configuration: DebugSessionState['configuration']): string {
  return configuration.providerIntegration + ' · ' + configuration.model;
}

function entriesOf(
  records: readonly UiInputRecord[],
  invalid: readonly { readonly key: string; readonly revision: number }[],
): readonly InputManagerEntry[] {
  return [
    ...records.map((record): InputManagerEntry => ({ kind: 'record', record })),
    ...invalid.map((entry): InputManagerEntry => ({ kind: 'invalid', key: entry.key, revision: entry.revision })),
  ];
}

function DebugShell(props: DebugAppProps) {
  const windowSize = useWindowSize();
  const width = Math.max(20, windowSize.columns ?? props.terminalWidth);
  const rows = Math.max(8, windowSize.rows ?? 24);
  const [session, setSession] = useState<DebugSessionState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  if (session === null) {
    return <DebugLauncher {...props} width={width} rows={rows} notice={notice} onNotice={setNotice}
      onOpened={(opened) => { setNotice(null); setSession(opened); }} />;
  }
  return <DebugConversation {...props} width={width} rows={rows} session={session} notice={notice}
    onNotice={setNotice} onExit={props.onExit} />;
}

type LauncherProps = DebugAppProps & {
  readonly width: number;
  readonly rows: number;
  readonly notice: string | null;
  readonly onNotice: (notice: string | null) => void;
  readonly onOpened: (session: DebugSessionState) => void;
};

type ChoiceOption = { readonly value: string; readonly label: string; readonly description?: string };

/** 新建或继续：会话与模型都由用户明确选择，界面不猜默认配置。 */
function DebugLauncher(props: LauncherProps) {
  const { harness, width, rows, notice, onNotice, onOpened } = props;
  const [home, setHome] = useState<DebugHome | null>(null);
  const [step, setStep] = useState<'session' | 'model' | 'provider'>('session');
  const [, setProviderReturnStep, providerReturnStepRef] = useImmediateState<'session' | 'model'>('session');
  const [configuredModel, setConfiguredModel] = useState<{ readonly modelRef: string; readonly effort: string | null } | null>(null);
  const [busy, setBusy, busyRef] = useImmediateState(false);

  useEffect(() => {
    const loaded = harness.home();
    if (loaded.kind === 'failed') { onNotice(loaded.code + ': ' + loaded.message); return; }
    setHome(loaded);
  }, [harness, onNotice]);

  const open = useCallback((input: DebugOpenInput) => {
    if (busyRef.current) return;
    setBusy(true);
    void harness.open(input).then(
      (result) => {
        setBusy(false);
        if (result.kind === 'rejected') { onNotice(result.code + ': ' + result.message); return; }
        onOpened(result.state);
      },
      (error: unknown) => { setBusy(false); onNotice('打开会话失败：' + errorText(error)); },
    );
  }, [harness, onNotice, onOpened, busyRef, setBusy]);

  useInput((input, key) => {
    if (step === 'provider' || (step === 'model' && home !== null && home.models.length === 0)) {
      if (resolveGlobalAction(input, key) === 'exit') { harness.exitIntent(); props.onExit(); }
      return;
    }
    if (key.escape && step !== 'session') { setStep('session'); return; }
    // Ctrl+C 在选择阶段同样先取消在途工作再退出，不进入对话就能中止装配。
    if (resolveGlobalAction(input, key) === 'exit') { harness.exitIntent(); props.onExit(); return; }
    if (busyRef.current) return;
    if (step === 'session' && input === 'n') { setStep('model'); return; }
    if ((step === 'session' || step === 'model') && (input === 'p' || input === 'P')) {
      providerReturnStepRef.current = step;
      setProviderReturnStep(step); setStep('provider'); return;
    }
    // home 按创建时间排序：最近的会话是最后一个。
    const latest = home?.sessions.at(-1);
    if (step === 'session' && (input === 'c' || input === 'C') && latest !== undefined) {
      open({ kind: 'continue', coordinatorSessionId: latest.coordinatorSessionId });
    }
  });

  const header = <>
    <DebugHeader width={width} title={'调试目录 ' + (home?.directoryPath ?? '读取中')} status={step === 'session' ? '选择会话' : '选择模型'} />
    {notice === null ? null : <Text color={tuiColors.warning}>{truncateToDisplayWidth('! ' + notice, width)}</Text>}
  </>;

  if (step === 'session') {
    const options: readonly ChoiceOption[] = [
      { value: 'new', label: '新建调试会话（下一步选择模型）' },
      ...(home?.sessions ?? []).map((entry) => ({
        value: entry.coordinatorSessionId,
        label: '继续 ' + entry.coordinatorSessionId.slice(0, 8) + ' · ' + modelLabel(entry.configuration),
        ...(entry.turn === null || entry.turn.kind === 'idle'
          ? {}
          : { description: '轮次' + entry.turn.kind + '：需 /retry 明确恢复' }),
      })),
    ];
    return <Box flexDirection="column" width={width}>
      {header}
      <DialogFrame title="新建或继续调试会话" summary={home === null ? '读取中' : options.length + ' 项'}
        width={width} rows={Math.max(6, Math.min(12, rows - 6))} footer="↑↓ 选择 · Enter 确认 · n 新建 · p 配置模型 · c 继续最近会话">
        <ChoiceList width={width} options={options} disabled={busy || home === null}
          onSelect={(value) => { if (value === 'new') { setStep('model'); return; } open({ kind: 'continue', coordinatorSessionId: value }); }} />
      </DialogFrame>
    </Box>;
  }

  // 配置模型与打开会话是两个独立的用户选择。
  if (step === 'provider' || (step === 'model' && home !== null && home.models.length === 0)) {
    return <Box flexDirection="column" width={width}>
      {header}
      <ProviderLibraryEditor library={harness.providerLibrary.library} catalog={harness.providerLibrary.catalog}
        onSelect={() => undefined}
        onSelected={(modelRef, effort) => {
          const refreshed = harness.home();
          if (refreshed.kind === 'failed') { onNotice(refreshed.code + ': ' + refreshed.message); return; }
          setHome(refreshed); setConfiguredModel({ modelRef, effort }); setStep('model');
        }}
        onCancel={() => { onNotice(null); setStep(providerReturnStepRef.current); }}
        width={width} rows={Math.max(10, rows - 6)}
        identity="调试不需要 Orca、项目配置或 Scope；连接与模型保存在用户库" />
    </Box>;
  }

  const modelOptions: ChoiceOption[] = (home?.models ?? []).map((entry) => ({
    value: entry.modelRef,
    label: entry.connectionLabel + ' · ' + entry.model,
    ...(entry.efforts === null ? { description: '没有可信 effort 取值' } : {}),
  }));
  if (configuredModel !== null && !modelOptions.some((option) => option.value === configuredModel.modelRef)) {
    modelOptions.push({ value: configuredModel.modelRef, label: '已配置模型 · ' + configuredModel.modelRef });
  }
  return <Box flexDirection="column" width={width}>
    {header}
    <DialogFrame title="选择模型（会话固定该配置）" summary={home === null ? '读取中' : modelOptions.length + ' 项'}
      width={width} rows={Math.max(6, Math.min(12, rows - 6))} footer="↑↓ 选择 · Enter 新建会话 · p 配置模型 · Esc 返回">
      <ChoiceList width={width} options={modelOptions} disabled={busy || modelOptions.length === 0}
        onSelect={(modelRef) => open({ kind: 'new', modelRef, ...(configuredModel?.modelRef === modelRef ? { effort: configuredModel.effort } : {}) })} />
    </DialogFrame>
  </Box>;
}

function ChoiceList(props: {
  readonly options: readonly ChoiceOption[];
  readonly disabled: boolean;
  readonly width: number;
  readonly onSelect: (value: string) => void;
}) {
  const [index, setIndex, indexRef] = useImmediateState(0);
  useInput((_input, key) => {
    if (key.upArrow) setIndex((current) => Math.max(0, current - 1));
    if (key.downArrow) setIndex((current) => Math.min(props.options.length - 1, current + 1));
    if (key.return) { const option = props.options[indexRef.current]; if (option !== undefined) props.onSelect(option.value); }
  }, { isActive: !props.disabled });
  // 会话可以很多：只渲染选中项附近的固定行数，因此打开成本与条目数无关。
  const budget = 6;
  const start = Math.max(0, Math.min(props.options.length - budget, index - Math.floor(budget / 2)));
  return <Box flexDirection="column">
    {props.options.slice(start, start + budget).map((option, offset) => {
      const position = start + offset;
      return <Box key={option.value} flexDirection="column">
      <Text inverse={position === index} color={tuiColors.focus}>
        {truncateToDisplayWidth((position === index ? '› ' : '  ') + option.label, props.width)}
      </Text>
      {option.description === undefined ? null : <Text dimColor>{truncateToDisplayWidth('    ' + option.description, props.width)}</Text>}
      </Box>;
    })}
    {props.options.length > budget
      ? <Text dimColor>{truncateToDisplayWidth('    ' + (start + 1) + '-' + String(Math.min(start + budget, props.options.length)) + ' / ' + String(props.options.length), props.width)}</Text>
      : null}
    {props.options.length === 0 ? <Text dimColor>{props.disabled ? '读取中…' : '没有可用项'}</Text> : null}
  </Box>;
}

function DebugHeader(props: { readonly width: number; readonly title: string; readonly status: string }) {
  return <Box width={props.width} borderStyle="single" borderColor={tuiColors.border} paddingX={1} flexDirection="column">
    <Text color={tuiColors.accent} bold>{truncateToDisplayWidth(props.title, props.width - 4)}</Text>
    <Text dimColor>{truncateToDisplayWidth(props.status, props.width - 4)}</Text>
  </Box>;
}

type ConversationProps = DebugAppProps & {
  readonly width: number;
  readonly rows: number;
  readonly session: DebugSessionState;
  readonly notice: string | null;
  readonly onNotice: (notice: string | null) => void;
  readonly onExit: () => void;
};

const COMPOSER_MESSAGE_MODE: ComposerMode = { kind: 'message' };

function DebugConversation(props: ConversationProps) {
  const { harness, session, width, rows, notice, onNotice, onExit } = props;
  const sessionId = session.coordinatorSessionId;
  const target: UiInputTarget = useMemo(
    () => ({ kind: 'debug-message', debugDirectoryId: session.debugDirectoryId, coordinatorSessionId: sessionId }),
    [session.debugDirectoryId, sessionId],
  );
  const [protection] = useState(() => createInputProtection({ store: harness.inputStore }));
  const [reader] = useState(() => new TranscriptReader(harness.reading));
  const [frame, setFrame] = useState<TranscriptFrame | null>(null);
  const [pendingSubmission, setPendingSubmission] = useState<{ submissionId: string; text: string; status: string } | null>(null);
  const [draft, setDraft, draftRef] = useImmediateState<UiDraft>(emptyDraft());
  const [, setResubmitId, resubmitIdRef] = useImmediateState<string | null>(null);
  const [slashIndex, setSlashIndex, slashIndexRef] = useImmediateState(0);
  const [slashDismissed, setSlashDismissed, slashDismissedRef] = useImmediateState(false);
  const [detailed, setDetailed] = useState(false);
  const [turn, setTurn] = useState<AgentTurnState>(session.turn);
  const [running, setRunning] = useState(session.running);
  const [context, setContext] = useState(session.context ?? { status: 'unavailable' } as const);
  const [overlay, setOverlay, overlayRef] = useImmediateState<'none' | 'palette' | 'help' | 'paste' | 'inputs'>('none');
  const [helpScroll, setHelpScroll] = useState(0);
  const [commandIndex, setCommandIndex, commandIndexRef] = useImmediateState(0);
  const [commandQuery, setCommandQuery, commandQueryRef] = useImmediateState<UiDraft>(emptyDraft());
  const [pasteView, setPasteView, pasteViewRef] = useImmediateState<PasteViewerView | null>(null);
  const [inputManager, setInputManager, inputManagerRef] = useImmediateState<InputRecordManagerView | null>(null);
  const [, setConfirmExit, confirmExitRef] = useImmediateState(false);
  const transcriptRegion = useRef<TranscriptRegion | null>(null);
  const recordTranscriptRegion = useCallback((region: TranscriptRegion | null) => { transcriptRegion.current = region; }, []);
  const filterMouse = useTranscriptMouse(overlay === 'none', wheel => {
    if (overlayRef.current !== 'none' || confirmExitRef.current || !inTranscript(wheel, transcriptRegion.current)) return;
    void reader.move(wheel.direction, 3).then(next => { if (next) setFrame(next); })
      .catch(error => onNotice('历史读取失败：' + errorText(error)));
  });

  const transcriptHeight = useRef(Math.max(4, rows - 14));
  const widthRef = useRef(width);
  widthRef.current = width;
  const detailedRef = useRef(detailed);
  detailedRef.current = detailed;

  // 只读载入：恢复草稿与待核验提交都不发起调用，render/resize/remount 永远不会自动发送。
  useEffect(() => {
    const loaded = protection.load(target);
    if (loaded.status === 'loaded') setDraft(loaded.draft);
    if (loaded.status === 'failed') onNotice('草稿读取失败：' + loaded.code + ' ' + loaded.message);
    const lane = protection.pendingSubmission(targetNamespace(target), sessionId);
    const listed = protection.list(targetNamespace(target));
    if (listed.status === 'ok') {
      const pending = listed.records.find(record => record.kind === 'submission' &&
        record.target.coordinatorSessionId === sessionId && (record.status === 'awaiting' || record.status === 'unknown'));
      if (pending?.kind === 'submission') setPendingSubmission({
        submissionId: pending.submissionId, text: pending.draft.text, status: pending.status });
    }
    if (lane.status === 'active') onNotice('该会话有待核验提交 ' + lane.submissionId + '（' + lane.state + '）：先用 /inputs 恢复或删除');
    if (lane.status === 'failed') onNotice('待核验提交读取失败：' + lane.code + ' ' + lane.message);
  }, [protection, target, sessionId, onNotice]);

  const refreshState = useCallback(() => {
    const loaded = harness.state();
    if (loaded.kind === 'failed') { onNotice(loaded.code + ': ' + loaded.message); return; }
    if (loaded.kind === 'no-session') { onNotice('not_open: 尚未打开调试会话'); return; }
    setTurn(loaded.state.turn);
    setRunning(loaded.state.running);
    setContext(loaded.state.context ?? { status: 'unavailable' });
  }, [harness, onNotice]);

  const loadLatest = useCallback(async () => {
    try {
      reader.setDetailed(detailedRef.current);
      const next = await reader.read(reader.atLatest ? 'latest' : 'anchor', reader.frame?.anchor ?? null);
      if (next !== null) setFrame(next);
    } catch (error) {
      onNotice('历史读取失败：' + errorText(error));
    }
  }, [reader, onNotice]);

  useEffect(() => {
    let current = true;
    void reader.open(sessionId, widthRef.current, transcriptHeight.current, [])
      .then((next) => { if (current && next !== null) setFrame(next); })
      .catch((error: unknown) => { if (current) onNotice('历史读取失败：' + errorText(error)); });
    return () => { current = false; };
  }, [reader, sessionId, onNotice]);

  useEffect(() => harness.subscribe((event) => {
    if (event.coordinatorSessionId !== sessionId) return;
    // 轮次事件同时更新标题栏的运行态：事件只带 turn，权威 running 仍由 state() 给出。
    if (event.kind === 'turn-changed') { refreshState(); return; }
    void loadLatest();
  }), [harness, sessionId, loadLatest, refreshState]);
  // 流式片段与已提交正文都经 IC-11 阅读端口通知到达：只重读，不推进任何状态。
  useEffect(() => harness.reading.subscribe((updated) => {
    if (updated === sessionId) void loadLatest();
  }), [harness, sessionId, loadLatest]);
  useEffect(() => () => { reader.dispose(); protection.dispose(); }, [reader, protection]);

  const recordTranscriptHeight = useCallback((height: number) => {
    if (transcriptHeight.current === height) return;
    transcriptHeight.current = height;
    if (reader.frame !== null) void reader.resize(widthRef.current, height, [])
      .then(next => { if (next !== null) setFrame(next); })
      .catch((error: unknown) => onNotice('历史读取失败：' + errorText(error)));
  }, [reader, onNotice]);

  useEffect(() => {
    let current = true;
    reader.setDetailed(detailedRef.current);
    void reader.resize(widthRef.current, transcriptHeight.current, [])
      .then((next) => { if (current && next !== null) setFrame(next); })
      .catch((error: unknown) => { if (current) onNotice('历史读取失败：' + errorText(error)); });
    return () => { current = false; };
  }, [reader, width, detailed, onNotice]);

  const changeDraft = useCallback((next: UiDraft) => {
    setDraft(next);
    setSlashDismissed(false);
    protection.edit(target, next);
  }, [protection, target]);

  /** 原输入已保存到提交快照后，新的草稿使用独立输入状态。 */
  const resetDraft = useCallback(() => {
    setDraft(emptyDraft());
    setResubmitId(null);
    setSlashDismissed(false);
  }, []);

  const runCommand = useCallback(async (command: CommandId) => {
    const draft = draftRef.current;
    const reason = commandReason(command, { mode: 'debug', selectedSessionId: sessionId, pasteBlocks: draft.pasteBlocks.length });
    if (reason !== null) { onNotice(reason); return; }
    switch (command) {
      case 'exit': {
        // 退出意图先落地：在途模型工作立刻取消，之后才允许保存草稿与确认。
        harness.exitIntent();
        const flushed = protection.flushAll();
        if (flushed.status !== 'saved' && !confirmExitRef.current) {
          setConfirmExit(true);
          onNotice('输入未保存：' + flushed.message + ' · y 确认退出并放弃未保存内容');
          return;
        }
        onExit();
        return;
      }
      case 'stop': {
        harness.stop();
        refreshState();
        return;
      }
      case 'retry': {
        const result = await harness.retry();
        onNotice(result.kind === 'cleared' ? '轮次已恢复' : 'recovery_rejected: ' + result.failure.code + ' ' + result.failure.message);
        refreshState();
        return;
      }
      case 'transcript-details':
        setDetailed((current) => !current);
        return;
      case 'help':
        setHelpScroll(0);
        setOverlay('help');
        return;
      case 'command-directory':
        setCommandIndex(0);
        setCommandQuery(emptyDraft());
        setOverlay('palette');
        return;
      case 'paste': {
        if (draft.pasteBlocks.length === 0) { onNotice('当前草稿没有粘贴块'); return; }
        setPasteView({ draft, block: 0, scroll: 0 });
        setOverlay('paste');
        return;
      }
      case 'input-record-manager': {
        const listed = protection.list(targetNamespace(target));
        if (listed.status !== 'ok') { onNotice(listed.code + ': ' + listed.message); return; }
        setInputManager({
          entries: entriesOf(listed.records, listed.invalidRecords),
          usage: listed.usage,
          selectedIndex: 0,
          bodyScroll: 0,
          bodyFocus: false,
          feedback: null,
          confirmDelete: false,
        });
        setOverlay('inputs');
        return;
      }
      default:
        // 目录与 slash 只暴露已接通的操作；这里是目录与实现脱节时的兜底。
        onNotice('该命令在调试外壳未接通：' + String(COMMAND_METADATA[command].alias ?? command));
    }
  }, [harness, sessionId, draftRef, confirmExitRef, protection, target, onNotice, onExit, refreshState,
    setConfirmExit, setOverlay, setCommandIndex, setCommandQuery, setPasteView, setInputManager]);

  const submit = useCallback(async () => {
    const draft = draftRef.current;
    const text = draft.text;
    if (text.trim().length === 0) return;
    // 严格 slash：以 / 开头就不是消息；未知、参数或多行格式错误都保留输入。
    const slash = parseSlashInput(text, 'debug');
    if (slash.kind === 'error') { onNotice(slash.code + ': ' + slash.message); return; }
    if (slash.kind === 'command') {
      const generation = protection.generation(target);
      await runCommand(slash.command);
      // 命令只结清这一次输入：等待期间的新编辑（代际变化）与清理失败都保留。
      if (protection.generation(target) === generation) {
        const cleared = protection.clearInput(target);
        if (cleared.status === 'saved') resetDraft();
        else onNotice('命令输入未结清：' + reasonText(cleared));
      }
      return;
    }
    const lane = protection.pendingSubmission(targetNamespace(target), sessionId);
    if (lane.status !== 'none') {
      onNotice(lane.status === 'failed'
        ? lane.code + ': ' + lane.message
        : '该会话已有待核验提交 ' + lane.submissionId + '（' + lane.state + '）：先用 /inputs 恢复或删除');
      return;
    }
    const flushed = protection.flushAll();
    if (flushed.status !== 'saved') { onNotice('输入未保存，未发起提交：' + reasonText(flushed)); return; }
    // 恢复回来的待核验提交沿用原身份：不换 submissionId，也不丢正文。
    const submissionId = resubmitIdRef.current ?? globalThis.crypto.randomUUID();
    const snapshot = protection.draftOf(target) ?? draft;
    const begun = protection.beginSubmission({ target, draft: snapshot, submissionId });
    if (begun.status !== 'started') {
      onNotice(begun.status === 'lane-busy'
        ? '该会话已有待核验提交 ' + begun.submissionId + '（' + begun.state + '）'
        : '提交快照未保存，未发起提交：' + begun.code + ' ' + begun.message);
      return;
    }
    const detached = protection.clearDraft(target);
    if (detached.status === 'saved') resetDraft();
    else onNotice('提交快照已保存，草稿分离失败：' + reasonText(detached));
    setPendingSubmission({ submissionId, text, status: 'awaiting' });
    let result: Awaited<ReturnType<DebugHarnessPort['send']>>;
    try {
      result = await harness.send({ submissionId, content: text });
    } catch (error) {
      // 抛异常既不证明受理也不证明未发生：按 unknown 保留原输入与原提交身份。
      result = { kind: 'unknown', submissionId, reason: 'send_threw: ' + errorText(error) };
    }
    const settled = protection.settleSubmission({
      target,
      submissionId,
      outcome: result.kind === 'accepted' ? { kind: 'accepted' }
        : result.kind === 'rejected' ? { kind: 'rejected', code: result.code, message: result.message }
          : { kind: 'unknown', code: 'send_unknown', message: result.reason },
    });
    refreshState();
    if (result.kind === 'accepted') {
      setPendingSubmission(previous => previous?.submissionId === submissionId ? null : previous);
      // 分离失败（CAS 冲突等）后不再补清：晚到的 accepted 只按最新 revision 清理，会删掉并发
      // 写入方的草稿。原记录原样留给 /inputs 显式恢复，并如实告知本次未结清。
      onNotice(detached.status === 'saved' ? null : '提交快照已保存，草稿分离失败：' + reasonText(detached));
      return;
    }
    setPendingSubmission(previous => previous?.submissionId === submissionId ? { ...previous, status: result.kind } : previous);
    onNotice(result.kind + ': ' + (result.kind === 'rejected' ? result.code + ' ' + result.message : result.reason)
      + (settled.status === 'saved' ? '' : ' · 状态回写失败：' + reasonText(settled)));
  }, [draftRef, resubmitIdRef, protection, target, sessionId, harness, runCommand, resetDraft, onNotice, refreshState, setResubmitId]);

  const runCommandRef = useRef(runCommand);
  runCommandRef.current = runCommand;
  const submitRef = useRef(submit);
  submitRef.current = submit;

  usePaste((text) => {
    if (overlayRef.current !== 'none') return;
    const outcome = protection.paste(target, text);
    const next = protection.draftOf(target);
    if (next !== null) { setDraft(next); setSlashDismissed(false); }
    if (outcome.status !== 'saved') onNotice('粘贴块已插入，但保存失败：' + reasonText(outcome));
  });

  const candidates = slashDismissed ? [] : slashCandidates(draft.text, 'debug');

  useInput((input, key) => {
    if (key.eventType === 'release') return;
    const draft = draftRef.current;
    const filtered = filterMouse(input);
    if (filtered !== input && filtered === '') return;
    input = filtered;
    const overlay = overlayRef.current;
    const commandQuery = commandQueryRef.current;
    const commandIndex = commandIndexRef.current;
    const pasteView = pasteViewRef.current;
    const inputManager = inputManagerRef.current;
    const candidates = slashDismissedRef.current ? [] : slashCandidates(draft.text, 'debug');
    if (confirmExitRef.current) {
      if (input === 'y' || input === 'Y') { onExit(); return; }
      if (key.escape) { setConfirmExit(false); onNotice(null); return; }
      return;
    }
    const action = resolveGlobalAction(input, key);
    if (action === 'exit') { void runCommandRef.current('exit'); return; }
    if (overlay !== 'none') {
      if (key.escape && overlay === 'inputs' && inputManager?.bodyFocus) { setInputManager({ ...inputManager, bodyFocus: false }); return; }
      if (key.escape) { setOverlay('none'); setPasteView(null); setInputManager(null); return; }
      if (overlay === 'help' && (key.upArrow || key.downArrow)) {
        setHelpScroll(current => Math.max(0, Math.min(helpLines('debug').length - 1, current + (key.upArrow ? -1 : 1))));
        return;
      }
      if (overlay === 'palette') {
        const commands = debugCommands(commandQuery.text);
        if (key.upArrow) { setCommandIndex((current) => Math.max(0, current - 1)); return; }
        if (key.downArrow) { setCommandIndex((current) => Math.max(0, Math.min(commands.length - 1, current + 1))); return; }
        if (key.return) {
          const command = commands[Math.min(commandIndex, commands.length - 1)];
          setOverlay('none');
          if (command !== undefined) void runCommandRef.current(command);
          return;
        }
        handleComposerKey(input, key, { readOnly: false, draft: commandQuery,
          change: next => { setCommandIndex(0); setCommandQuery(next.text === boundedQuery(next.text) ? next : textDraft(boundedQuery(next.text))); },
          submit: () => undefined });
        return;
      }
      if (overlay === 'paste' && pasteView !== null) {
        if (key.leftArrow) { setPasteView({ ...pasteView, block: Math.max(0, pasteView.block - 1), scroll: 0 }); return; }
        if (key.rightArrow) { setPasteView({ ...pasteView, block: Math.max(0, Math.min(draft.pasteBlocks.length - 1, pasteView.block + 1)), scroll: 0 }); return; }
        if (key.upArrow) { setPasteView({ ...pasteView, scroll: Math.max(0, pasteView.scroll - 1) }); return; }
        if (key.downArrow) { setPasteView({ ...pasteView, scroll: pasteView.scroll + 1 }); return; }
      }
      if (overlay === 'inputs' && inputManager !== null) {
        if (inputManager.confirmDelete) {
          if (input === 'n' || input === 'N') { setInputManager({ ...inputManager, confirmDelete: false }); return; }
          if (input !== 'y' && input !== 'Y') return;
        }
        if (inputManager.bodyFocus && (key.upArrow || key.downArrow)) {
          setInputManager({ ...inputManager, bodyScroll: Math.max(0, inputManager.bodyScroll + (key.upArrow ? -1 : 1)) }); return;
        }
        if (key.upArrow) { setInputManager({ ...inputManager, selectedIndex: Math.max(0, inputManager.selectedIndex - 1) }); return; }
        if (key.downArrow) { setInputManager({ ...inputManager, selectedIndex: Math.min(inputManager.entries.length - 1, inputManager.selectedIndex + 1) }); return; }
        if (input === 'd' || input === 'D') { setInputManager({ ...inputManager, confirmDelete: !inputManager.confirmDelete }); return; }
        const entry = inputManager.entries[inputManager.selectedIndex];
        if (inputManager.confirmDelete) {
          if (entry === undefined) return;
          const removed = protection.removeRecord(entry.kind === 'invalid' ? entry.key : entry.record.key,
            entry.kind === 'invalid' ? entry.revision : entry.record.revision);
          if (removed.status === 'saved' && entry.kind === 'record' && entry.record.kind === 'submission') {
            const submissionId = entry.record.submissionId;
            setPendingSubmission(previous => previous?.submissionId === submissionId ? null : previous);
          }
          const listed = protection.list(targetNamespace(target));
          setInputManager({ ...inputManager, confirmDelete: false, feedback: removed.status === 'saved' ? '记录已删除' : reasonText(removed),
            ...(listed.status === 'ok' ? { entries: entriesOf(listed.records, listed.invalidRecords), usage: listed.usage,
              selectedIndex: Math.max(0, Math.min(inputManager.selectedIndex, listed.records.length + listed.invalidRecords.length - 1)) } : {}) });
          return;
        }
        if (key.return) { setInputManager({ ...inputManager, bodyFocus: !inputManager.bodyFocus }); return; }
        if (input === 'r' || input === 'R' || input === 'v' || input === 'V') {
          if (entry === undefined || entry.kind !== 'record') { setInputManager({ ...inputManager, feedback: '该记录没有可恢复的正文' }); return; }
          if (entry.record.kind === 'submission') {
            const status = harness.submission({ submissionId: entry.record.submissionId, content: entry.record.draft.text });
            let feedback: string | null = null;
            if (status.kind === 'accepted') {
              const removed = protection.removeRecord(entry.record.key, entry.record.revision);
              const submissionId = entry.record.submissionId;
              if (removed.status === 'saved') setPendingSubmission(previous => previous?.submissionId === submissionId ? null : previous);
              feedback = removed.status === 'saved' ? '已受理，提交记录已清理' : '已受理，清理失败：' + reasonText(removed);
            } else if (status.kind === 'conflict' || status.kind === 'unverifiable') {
              const marked = protection.markVerified({ key: entry.record.key, status: status.kind,
                reason: status.kind === 'conflict' ? status.code + ': ' + status.message : status.reason });
              feedback = marked.status === 'saved' ? status.kind : '核验回写失败：' + reasonText(marked);
            }
            if (feedback !== null) {
              const listed = protection.list(targetNamespace(target));
              setInputManager({ ...inputManager, feedback, ...(listed.status === 'ok'
                ? { entries: entriesOf(listed.records, listed.invalidRecords), usage: listed.usage } : {}) });
              return;
            }
          }
          if (input === 'v' || input === 'V') { setInputManager({ ...inputManager, feedback: entry.record.kind === 'submission' ? '未发现提交，保留原身份' : '只有提交记录可以核验' }); return; }
          const adopted = protection.adoptRecord(entry.record);
          if (adopted.status !== 'saved') { setInputManager({ ...inputManager, feedback: reasonText(adopted) }); return; }
          const restored = protection.draftOf(target);
          if (restored !== null) { setDraft(restored); setSlashDismissed(false); }
          const submissionId = entry.record.kind === 'submission' ? entry.record.submissionId : null;
          setResubmitId(submissionId);
          setInputManager({ ...inputManager, feedback: submissionId === null
            ? '已恢复为草稿'
            : '已恢复待核验提交 ' + submissionId + '（沿用原身份）· 核验：not-found' });
          return;
        }
      }
      return;
    }
    if (action === 'command-palette') { void runCommandRef.current('command-directory'); return; }
    if (action === 'toggle-tool') { void runCommandRef.current('transcript-details'); return; }
    if (action === 'escape') { setSlashDismissed(true); return; }
    if (key.pageUp || key.pageDown) {
      void reader.move(key.pageUp ? 'older' : 'newer')
        .then((next) => { if (next !== null) setFrame(next); })
        .catch((error: unknown) => onNotice('历史读取失败：' + errorText(error)));
      return;
    }
    if (candidates.length > 0) {
      if (key.upArrow) { setSlashIndex((current) => Math.max(0, current - 1)); return; }
      if (key.downArrow) { setSlashIndex((current) => Math.min(candidates.length - 1, current + 1)); return; }
      if ((key.return || key.tab) && !key.meta && !key.shift) {
        // 采用与执行分离：Enter 只把候选填入输入，再按一次 Enter 才真正执行。
        const command = candidates[Math.min(slashIndexRef.current, candidates.length - 1)];
        if (command !== undefined) { changeDraft(textDraft('/' + String(COMMAND_METADATA[command].alias))); setSlashDismissed(true); }
        return;
      }
    }
    handleComposerKey(input, key, {
      readOnly: false,
      draft,
      width: composerContentWidth(width),
      change: changeDraft,
      submit: () => { void submitRef.current(); },
    });
  });

  // 停止状态保持可见，但输入照常落盘：是否运行模型由宿主按轮次状态决定。
  const stopped = turn.kind === 'halted' ? '轮次已停止（' + turn.failure.code + '）：消息仍会落盘，/retry 明确恢复后才运行模型' : null;
  const transcriptView = {
    coordinatorSessionId: sessionId,
    entries: [],
    nextCursor: null,
    scrollOffset: 0,
    readOnly: false,
    historyStatus: frame === null ? ('loading' as const) : ('ready' as const),
  };
  const status = running || turn.kind === 'running'
    ? '轮次进行中'
    : turn.kind === 'idle'
      ? '空闲'
      : '已停止 · ' + turn.failure.code;

  return <Box flexDirection="column" width={width} height={rows}>
    <DebugHeader width={width} title={'调试 ' + session.directoryPath}
      status={status + ' · ' + formatContextStatus(context, 'tokens') + ' · ' + modelLabel(session.configuration)} />
    <Conversation width={width} height={Math.max(4, rows - 4)} transcript={transcriptView} frame={frame}
      pendingSubmission={pendingSubmission}
      origin={{ x: 0, y: 4 }} onTranscriptRegion={recordTranscriptRegion}
      expandedToolIds={[]} onToggleTool={() => undefined} availableWidth={width} onTranscriptHeight={recordTranscriptHeight}>
      {candidates.length > 0
        ? <CommandPalette commands={candidates} selectedIndex={Math.min(slashIndex, candidates.length - 1)} onRun={(command) => void runCommandRef.current(command)}
          availableWidth={width} maxRows={Math.min(4, Math.max(1, rows - 20))} slash />
        : null}
      {overlay === 'paste' && pasteView !== null ? <PasteViewer view={pasteView} width={width} rows={Math.max(6, rows - 8)} /> : null}
      {overlay === 'inputs' && inputManager !== null ? <InputRecordManager view={inputManager} availableWidth={width} availableRows={Math.max(6, rows - 12)} /> : null}
      {overlay === 'palette'
        ? <CommandPalette commands={debugCommands(commandQuery.text)} selectedIndex={Math.max(0, Math.min(commandIndex, debugCommands(commandQuery.text).length - 1))}
          onRun={(command) => { setOverlay('none'); void runCommandRef.current(command); }}
          availableWidth={width} maxRows={Math.min(8, Math.max(3, rows - 18))} summary="调试对话" query={commandQuery.text} />
        : null}
      {overlay === 'help'
        ? <DialogFrame title="Help · 调试命令与键位" summary={debugCommands().length + ' 条调试命令'} width={width} rows={Math.max(6, Math.min(14, rows - 12))} footer="↑↓ 浏览 · Esc 返回">
          {helpLines('debug').slice(helpScroll, helpScroll + Math.max(1, Math.min(8, rows - 18))).map((line) => <Text key={line} dimColor>{truncateToDisplayWidth(line, width - 4)}</Text>)}
        </DialogFrame>
        : null}
      {stopped === null ? null : <Text color={tuiColors.warning}>{truncateToDisplayWidth('! ' + stopped, width)}</Text>}
      <Composer value={draft.text} draft={draft} terminalHeight={rows} focused={overlay === 'none'} readOnly={false} mode={COMPOSER_MESSAGE_MODE}
        disabledReason={null} newlineHint="Alt+Enter 换行" availableWidth={width} />
      <Text dimColor>{truncateToDisplayWidth(notice ?? '/help 命令与键位 · PageUp/PageDown 滚动 · Ctrl+T 整体详细', width)}</Text>
    </Conversation>
  </Box>;
}
