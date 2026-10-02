/** Throwaway composer comparison for wayfinder issue 47. */
import { ThemeProvider } from '@inkjs/ui';
import { Box, Text, useInput, usePaste, useWindowSize } from 'ink';
import { useRef, useState } from 'react';

import type { ControllerSnapshot, ControllerTranscriptPage } from '../../application/controller-service.js';
import { projectTranscriptPage, projectTuiViewModel } from '../../application/tui/view-model.js';
import { handleComposerKey } from './app.js';
import { CommandPalette } from './components/command-palette.js';
import { InteractionCard } from './components/interaction-card.js';
import { Sidebar } from './components/sidebar.js';
import { StatusLine } from './components/status-line.js';
import { TopBar } from './components/top-bar.js';
import { allowedSidebarDensity, truncateToDisplayWidth, wrapByDisplayWidth } from './render/width.js';
import { bodyWidth } from './screens/workspace.js';
import { tuiColors, tuiTheme } from './theme.js';
import { PrototypeTranscript } from './workspace-prototype.js';

type Scene = 'slash' | 'typing' | 'long' | 'images' | 'answer';
type ImageSample = { readonly name: string; readonly detail: string };
type Props = {
  readonly snapshot: ControllerSnapshot;
  readonly transcript: ControllerTranscriptPage;
  readonly scene: Scene;
  readonly initialVariant: 'inline' | 'review';
  readonly terminalWidth: number;
  readonly onExit: () => void;
};

const longDraft = [
  '请梳理 src/interfaces/tui 里已有的输入路径，再比较两种方案。',
  '需要保留中文、English 和 src/很长的目录/更长的文件名.ts 的完整内容。',
  '第一点：待答问题必须绑定 interaction ID 和 revision。',
  '第二点：图片条目要能看清文件名、顺序和移除入口。',
  '第三点：缩窄终端后，仍能看到光标所在的最后一行。',
  '最后请说明哪些只是演示数据，哪些能力当前真的可以提交。',
].join('\n');
const sampleImages: readonly ImageSample[] = [
  { name: '执行图.png', detail: '1280×720 · 340 KB' },
  { name: '报错截图.png', detail: '900×520 · 180 KB' },
];
const commands = [
  { name: 'compact', hint: '[reason]', detail: '压缩当前 Session', unavailable: null },
  { name: 'help', hint: '', detail: '查看命令', unavailable: null },
  { name: 'authorize', hint: '', detail: '审阅执行授权', unavailable: '当前无候选授权' },
] as const;

/** Shared editor from the chosen above-input comparison; callers own input and navigation. */
export function PrototypeComposerInput(props: { label: string; value: string; width: number }) {
  const width = Math.max(1, props.width - 4);
  const lines = wrapByDisplayWidth(props.value, width);
  return <Box flexDirection="column" borderStyle="round" borderColor={tuiColors.focus} paddingX={1}>
    <Text color={tuiColors.focus} bold>{truncateToDisplayWidth(props.label, width)}</Text>
    <Text>{truncateToDisplayWidth((props.value.length === 0 ? '输入消息…' : lines.at(-1) ?? '') + '▏', width)}</Text>
  </Box>;
}

export function ComposerPrototype(props: Props) {
  const size = useWindowSize();
  const terminalWidth = size.columns || props.terminalWidth;
  const terminalHeight = size.rows || 40;
  const density = allowedSidebarDensity(terminalWidth);
  const width = bodyWidth(terminalWidth, density);
  const [variant, setVariant] = useState<'inline' | 'review'>(props.initialVariant);
  const [sessionId, setSessionId] = useState<'session-a' | 'session-b'>('session-a');
  const [answering, setAnswering] = useState(props.scene === 'answer');
  const [drafts, setDrafts] = useState<Record<string, string>>({
    'session-a:message': props.scene === 'long' || props.scene === 'images' ? longDraft : props.scene === 'slash' ? '/' : '',
    'session-a:answer': '请先确认阻塞节点的状态。',
    'session-b:message': '另一个 Session 的草稿仍在这里。',
  });
  const [images, setImages] = useState<Record<string, readonly ImageSample[]>>({
    'session-a': props.scene === 'images' ? sampleImages : [],
    'session-b': [],
  });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [menuIndex, setMenuIndex] = useState(0);
  const menuIndexRef = useRef(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const draftKey = `${sessionId}:${answering ? 'answer' : 'message'}`;
  const draft = drafts[draftKey] ?? '';
  const attachments = images[sessionId] ?? [];
  const view = projectTuiViewModel({
    snapshot: props.snapshot,
    transcript: projectTranscriptPage(sessionId === 'session-a' ? props.transcript : null, { coordinatorSessionId: sessionId }),
    selectedSessionId: sessionId,
    unreadSessionIds: [],
    includeGraphNodes: density !== 'collapsed',
  });
  const interaction = view.interactions.find((item) => item.ownerCoordinatorSessionId === sessionId && item.state === 'open');
  const query = draft.startsWith('/') && !draft.includes(' ') ? draft.slice(1).toLowerCase() : null;
  const matches = query === null ? [] : commands.filter((command) => command.name.startsWith(query));
  const selectableIndexes = matches.flatMap((command, index) => command.unavailable ? [] : [index]);
  const selectedIndex = selectableIndexes.includes(menuIndex) ? menuIndex : (selectableIndexes[0] ?? -1);
  const slashOpen = !answering && !paletteOpen && !slashDismissed && matches.length > 0;
  const wrapped = wrapByDisplayWidth(draft, Math.max(1, width - 5));
  const previewLines = wrapped.length > 1 && wrapped.at(-1) === '' ? wrapped.slice(0, -1) : wrapped;
  const maxDraftLines = Math.max(2, Math.min(6, Math.floor((terminalHeight - 14) / 3)));
  const visibleDraft = wrapped.slice(-maxDraftLines);
  const fit = (value: string, inset = 0) => truncateToDisplayWidth(value, Math.max(1, width - inset));
  const change = (value: string) => {
    setDrafts((current) => ({ ...current, [draftKey]: value }));
    menuIndexRef.current = 0;
    setMenuIndex(0);
    setSlashDismissed(false);
    setNotice(null);
  };
  const chooseCommand = (name: string) => {
    const command = commands.find((item) => item.name === name);
    if (command?.unavailable) {
      setNotice(`${name}：${command.unavailable}`);
      setSlashDismissed(true);
      return;
    }
    change(`/${name}${command?.hint ? ' ' : ''}`);
    setSlashDismissed(true);
  };
  const moveMenu = (delta: number) => {
    const currentIndex = selectableIndexes.includes(menuIndexRef.current) ? menuIndexRef.current : (selectableIndexes[0] ?? -1);
    if (currentIndex < 0) return;
    const next = selectableIndexes[Math.min(selectableIndexes.length - 1, Math.max(0, selectableIndexes.indexOf(currentIndex) + delta))]!;
    menuIndexRef.current = next;
    setMenuIndex(next);
  };

  usePaste((text) => {
    if (paletteOpen) return;
    change(`${draft}${text.replace(/\r\n?/g, '\n')}`);
  });

  useInput((input, key) => {
    if (key.ctrl && input === 'c') props.onExit();
    else if (key.ctrl && input === 'p') { setPaletteOpen((current) => !current); setPaletteIndex(0); }
    else if (paletteOpen) {
      if (key.escape) setPaletteOpen(false);
      else if (key.upArrow) setPaletteIndex((current) => Math.max(0, current - 1));
      else if (key.downArrow) setPaletteIndex((current) => Math.min(3, current + 1));
      else if (key.return) { setNotice('Command Palette 原型：未执行命令'); setPaletteOpen(false); }
    } else if (key.ctrl && input === 't') setVariant((current) => current === 'inline' ? 'review' : 'inline');
    else if (key.ctrl && input === 'n') { setSessionId((current) => current === 'session-a' ? 'session-b' : 'session-a'); setAnswering(false); setNotice(null); }
    else if (key.ctrl && input === 'a') { setAnswering((current) => interaction === undefined ? false : !current); setNotice(null); }
    else if (key.ctrl && input === 'l') change(longDraft);
    else if (key.ctrl && input === 'o') setImages((current) => ({ ...current, [sessionId]: [...attachments, sampleImages[attachments.length % sampleImages.length]!] }));
    else if (key.ctrl && input === 'd') setImages((current) => ({ ...current, [sessionId]: attachments.slice(0, -1) }));
    else if (key.escape && slashOpen) setSlashDismissed(true);
    else if (slashOpen && key.upArrow) moveMenu(-1);
    else if (slashOpen && key.downArrow) moveMenu(1);
    else if (slashOpen && (key.tab || key.return) && selectableIndexes.length > 0)
      chooseCommand(matches[selectableIndexes.includes(menuIndexRef.current) ? menuIndexRef.current : selectableIndexes[0]!]!.name);
    else if (slashOpen && (key.tab || key.return)) setNotice('当前匹配命令不可用');
    else if (key.tab) { /* Tab only accepts a visible command. */ }
    else handleComposerKey(input, key, {
      readOnly: false,
      draft,
      change,
      submit: () => setNotice(answering && interaction !== undefined
        ? `模拟回答 ${interaction.interactionId} @ revision ${interaction.expectedRevision}；没有提交`
        : '模拟消息：文本与图片均没有提交'),
    });
  });

  const menuRows = variant === 'review' ? matches.length : terminalHeight < 30 ? 2 : 3;
  const firstMenuRow = Math.max(0, selectedIndex - menuRows + 1);
  const menu = slashOpen ? (
    <Box flexDirection="column">
      <Text color={tuiColors.focus}>{fit('命令候选 · ↑↓ 选择 · Tab/Enter 填入 · Esc 关闭', 4)}</Text>
      {matches.slice(firstMenuRow, firstMenuRow + menuRows).map((command, offset) => (
        <Text key={command.name} color={firstMenuRow + offset === selectedIndex ? tuiColors.focus : tuiColors.muted}
          bold={firstMenuRow + offset === selectedIndex} inverse={firstMenuRow + offset === selectedIndex}>
          {fit(`${firstMenuRow + offset === selectedIndex ? '›' : ' '} /${command.name} ${command.hint}  ${command.unavailable ? `不可用：${command.unavailable}` : command.detail}`, 4)}
        </Text>
      ))}
      {matches.length > menuRows ? <Text color={tuiColors.muted}>{fit(`${Math.max(0, selectedIndex) + 1}/${matches.length} · ↑↓ 查看其余候选`, 4)}</Text> : null}
    </Box>
  ) : null;
  const inlineImageLines = attachments.map((item, index) => fit(`${index + 1} @image:${item.name} · 模拟文本引用`, 4));
  const imageLines = attachments.map((item, index) => fit(`${index + 1} ▧ ${item.name} · ${item.detail} · 模拟图片`, 4));

  return (
    <ThemeProvider theme={tuiTheme}>
      <Box flexDirection="column" height={terminalHeight}>
        <TopBar coordinationScopeId={view.scope.coordinationScopeId} mode={view.scope.mode} controlState={view.scope.controlState}
          graphLabel={view.graph === null ? null : `${view.graph.graphId} v${view.graph.graphVersion}`}
          generation={view.graph?.generation ?? null} authorizationLabel={view.scope.authorization?.authorizationId ?? null}
          activeWorkPackageCount={view.execution.activeWorkPackageCount} reconciling={view.execution.reconciliation.pending} availableWidth={terminalWidth} />
        <Box flexDirection="row" flexGrow={1}>
          <Box flexDirection="column" width={width} flexGrow={1}>
            <Box flexDirection="column" flexGrow={1} overflowY="hidden">
              {paletteOpen ? <CommandPalette commands={['compact', 'session-picker', 'graph-inspector', 'help']} selectedIndex={paletteIndex}
                onRun={() => setNotice('原型未执行命令')} availableWidth={width} />
                : <PrototypeTranscript entries={view.transcript.entries.slice(terminalHeight < 30 ? -2 : -5)} width={width} expanded={false} compact={terminalHeight < 35} />}
            </Box>
            {interaction === undefined ? null : terminalHeight < 30
              ? <Text color={answering ? tuiColors.focus : tuiColors.warning}>{fit(`待答 ${interaction.interactionId} @${interaction.expectedRevision} · Ctrl+A 回答`)}</Text>
              : <InteractionCard interaction={interaction} answering={answering}
                onEnterAnswer={() => setAnswering(true)} availableWidth={width} />}
            {variant === 'inline' ? (
              <>
                <Box flexDirection="column" borderStyle="round" borderColor={tuiColors.focus} paddingX={1}>
                  <Text color={tuiColors.focus} bold>{fit(`A · ${props.scene === 'slash' ? '候选在输入框内' : '输入区内展开'} · ${sessionId} · ${answering ? `回答 ${interaction?.interactionId} @${interaction?.expectedRevision}` : '普通消息'}`, 4)}</Text>
                  {wrapped.length > visibleDraft.length ? <Text color={tuiColors.muted}>{fit(`↑ ${wrapped.length - visibleDraft.length} 行在上方 · 共 ${draft.length} 字`, 4)}</Text> : null}
                  {visibleDraft.map((line, index) => <Text key={index}>{fit(line + (index === visibleDraft.length - 1 ? '▏' : ''), 4)}</Text>)}
                  {answering && attachments.length > 0 ? <Text color={tuiColors.warning}>图片不属于当前文本回答</Text> : inlineImageLines.map((line, index) => <Text key={index} color={tuiColors.accent}>{line}</Text>)}
                  {menu}
                </Box>
              </>
            ) : (
              <>
                {props.scene === 'slash' || slashOpen ? null : <Box flexDirection="column" borderStyle="single" borderColor={tuiColors.border}>
                  <Text color={tuiColors.accent} bold>{fit(`B · 独立内容预览 · ${draft.length} 字 · ${attachments.length} 张模拟图片${answering ? '（未包含）' : ''}`, 2)}</Text>
                  {previewLines.slice(0, terminalHeight < 30 ? 1 : 2).map((line, index) => <Text key={index}>{fit(line || ' ', 2)}</Text>)}
                  {previewLines.length > (terminalHeight < 30 ? 2 : 3) ? <Text color={tuiColors.muted}>{fit(`… 中间 ${previewLines.length - (terminalHeight < 30 ? 2 : 3)} 行 · 最后一行如下`, 2)}</Text> : null}
                  {previewLines.length > (terminalHeight < 30 ? 1 : 2) ? <Text>{fit(previewLines.at(-1) ?? '', 2)}</Text> : null}
                  {answering && attachments.length > 0 ? <Text color={tuiColors.warning}>图片不属于当前文本回答</Text> : imageLines.map((line, index) => <Text key={index} color={tuiColors.accent}>{line}</Text>)}
                </Box>}
                {menu === null ? null : <Box flexDirection="column" borderStyle="single" borderColor={tuiColors.border} paddingX={1}>{menu}</Box>}
                <PrototypeComposerInput width={width} value={draft}
                  label={`${props.scene === 'slash' ? 'B · 候选在输入框上方 · ' : ''}${sessionId} · ${answering ? `回答 ${interaction?.interactionId} @${interaction?.expectedRevision}` : '普通消息'} · 编辑`} />
              </>
            )}
            {notice === null ? null : <Text color={tuiColors.warning}>{fit(notice)}</Text>}
            <StatusLine scope={view.scope} compaction={view.compaction} maintenance={view.maintenance} blockerCount={view.blockers.length}
              notice={null} sidebarDensity={density} execution={view.execution} availableWidth={width} />
          </Box>
          {density === 'collapsed' ? null : <Sidebar density={density} viewModel={view} terminalWidth={terminalWidth} />}
        </Box>
        <Text color={tuiColors.muted}>{truncateToDisplayWidth('Ctrl+T 切换 A/B · Tab 补全 · Ctrl+N Session · Ctrl+A 回答 · Ctrl+L 长文 · Ctrl+O 加图 · Ctrl+D 移图 · Ctrl+P 命令 · Ctrl+C 退出', terminalWidth)}</Text>
      </Box>
    </ThemeProvider>
  );
}
