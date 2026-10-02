/** Throwaway continuous-transcript prototype for wayfinder issue 40. */
import { Select, Spinner, StatusMessage, ThemeProvider } from '@inkjs/ui';
import { Box, Text, useInput, useWindowSize } from 'ink';
import { useState } from 'react';

import type { ControllerSnapshot, ControllerTranscriptPage } from '../../application/controller-service.js';
import { projectTranscriptPage, projectTuiViewModel, type TranscriptEntry } from '../../application/tui/view-model.js';
import { handleComposerKey } from './app.js';
import { textDraft } from './input/composer-editor.js';
import { Sidebar } from './components/sidebar.js';
import { StatusLine } from './components/status-line.js';
import { TopBar } from './components/top-bar.js';
import { allowedSidebarDensity, truncateToDisplayWidth, wrapByDisplayWidth } from './render/width.js';
import { bodyWidth } from './screens/workspace.js';
import { tuiColors, tuiTheme } from './theme.js';

type PrototypeProps = {
  readonly snapshot: ControllerSnapshot;
  readonly transcript: ControllerTranscriptPage;
  readonly terminalWidth: number;
  readonly scenario: string;
  readonly onExit: () => void;
};

type DemoEntry = TranscriptEntry | { readonly kind: 'thought'; readonly id: string; readonly text: string };

export function PrototypeTranscript({ entries, width, expanded, compact }: {
  readonly entries: readonly TranscriptEntry[];
  readonly width: number;
  readonly expanded: boolean;
  readonly compact: boolean;
}) {
  const lastToolId = entries.filter((entry) => entry.kind === 'tool').at(-1)?.id;
  const displayEntries = entries.flatMap<DemoEntry>((entry) =>
    entry.kind === 'tool' && entry.id === lastToolId
      ? [{ kind: 'thought', id: 'thought-preview', text: '先核对现有实现与依赖；把尚未验证的假设留在当前回合。' }, entry]
      : [entry],
  );
  return (
    <Box flexDirection="column">
      {displayEntries.map((entry) => {
        if (entry.kind === 'user') {
          const wrapped = wrapByDisplayWidth(entry.text, Math.max(1, width - 5));
          return (
            <Box key={entry.id} borderStyle="single" borderTop={false} borderRight={false} borderBottom={false} borderColor={tuiColors.accent} paddingLeft={1} marginTop={compact ? 0 : 1} flexDirection="column">
              {wrapped.slice(0, compact ? 1 : 5).map((line, index) => <Text key={index} bold color={tuiColors.accent}>{index === 0 ? '› ' : '  '}{line}{compact && wrapped.length > 1 ? '…' : ''}</Text>)}
              {!compact && wrapped.length > 5 ? <Text color={tuiColors.muted}>  …</Text> : null}
            </Box>
          );
        }
        if (entry.kind === 'agent') {
          const wrapped = wrapByDisplayWidth(entry.text, Math.max(1, width - 3));
          return (
            <Box key={entry.id} flexDirection="column" marginTop={compact ? 0 : 1}>
              {wrapped.slice(0, compact ? 2 : 7).map((line, index) => (
                <Text key={index}>{index === 0 ? <Text color={tuiColors.success}>● </Text> : '  '}{line}</Text>
              ))}
              {!compact && wrapped.length > 7 ? <Text color={tuiColors.muted}>  …</Text> : null}
            </Box>
          );
        }
        if (entry.kind === 'thought') {
          return <Text key={entry.id} italic color={tuiColors.muted}>  ◌ {truncateToDisplayWidth(entry.text, Math.max(1, width - 5))}</Text>;
        }
        const isExpanded = expanded && entry.id === lastToolId;
        const detailLines = entry.detail.split('\n').slice(1).flatMap((line) => wrapByDisplayWidth(line, Math.max(1, width - 8)));
        return (
          <Box key={entry.id} flexDirection="column" marginTop={compact ? 0 : 1} marginLeft={2}>
            <Text><Text color={tuiColors.focus}>{isExpanded ? '▾' : '▸'}</Text>{'  '}<Text bold color={tuiColors.warning}>{truncateToDisplayWidth(entry.name, Math.max(1, width - 12))}</Text>{'  '}<Text color={tuiColors.success}>✓</Text></Text>
            {isExpanded ? (
              <Box flexDirection="column" borderStyle="single" borderTop={false} borderRight={false} borderBottom={false} borderColor={tuiColors.border} paddingLeft={1} marginLeft={1}>
                {detailLines.slice(0, compact ? 2 : 4).map((line, index) => <Text key={index} color={tuiColors.muted}>{line}</Text>)}
                {detailLines.length > (compact ? 2 : 4) ? <Text color={tuiColors.muted}>… 更多输出已折叠</Text> : null}
              </Box>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}

export function WorkspacePrototype(props: PrototypeProps) {
  const size = useWindowSize();
  const terminalWidth = size.columns || props.terminalWidth;
  const terminalHeight = size.rows || 40;
  const density = allowedSidebarDensity(terminalWidth);
  const width = bodyWidth(terminalWidth, density);
  const view = projectTuiViewModel({
    snapshot: props.snapshot,
    transcript: projectTranscriptPage(props.transcript, { coordinatorSessionId: 'session-a' }),
    selectedSessionId: 'session-a',
    unreadSessionIds: [],
    includeGraphNodes: density !== 'collapsed',
  });
  const [draft, setDraft] = useState(props.scenario === 'long-cjk' ? '请对比这两条路线\n并说明中文路径的处理' : '');
  const [expanded, setExpanded] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const history = view.transcript.entries.filter((entry): entry is Extract<TranscriptEntry, { kind: 'user' }> => entry.kind === 'user').slice(-5).reverse();
  const compact = terminalHeight < 35 || width < 70;
  const visibleEntries = view.transcript.entries.slice(compact ? -4 : -13);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      props.onExit();
    } else if (key.ctrl && input === 'r') {
      setHistoryOpen((current) => !current);
    } else if (key.escape && historyOpen) {
      setHistoryOpen(false);
    } else if (key.ctrl && input === 't') {
      setExpanded((current) => !current);
    } else if (!historyOpen) {
      handleComposerKey(input, key, {
        readOnly: false,
        draft: textDraft(draft),
        change: (value) => setDraft(value.text),
        submit: () => setNotice('原型只读：消息未发送'),
      });
    }
  });

  return (
    <ThemeProvider theme={tuiTheme}>
      <Box flexDirection="column" height={terminalHeight}>
        <TopBar
          coordinationScopeId={view.scope.coordinationScopeId}
          mode={view.scope.mode}
          controlState={view.scope.controlState}
          graphLabel={view.graph === null ? null : view.graph.graphId + ' v' + String(view.graph.graphVersion)}
          generation={view.graph?.generation ?? null}
          authorizationLabel={view.scope.authorization === null ? null : view.scope.authorization.authorizationId}
          activeWorkPackageCount={view.execution.activeWorkPackageCount}
          reconciling={view.execution.reconciliation.pending}
          availableWidth={terminalWidth}
        />
        <Box flexDirection="row" flexGrow={1}>
          <Box flexDirection="column" width={width} flexGrow={1}>
            <Box flexDirection="column" flexGrow={1} overflowY="hidden">
              {historyOpen ? (
                <Box flexDirection="column" marginTop={1}>
                  <Text bold color={tuiColors.focus}>最近的消息</Text>
                  {history.length === 0 ? <Text dimColor>暂无已发送消息</Text> : <Select options={history.map((entry) => ({ label: truncateToDisplayWidth(entry.text.replaceAll('\n', ' '), Math.max(12, width - 8)), value: entry.text }))} visibleOptionCount={5} onChange={(value) => { setDraft(value); setHistoryOpen(false); }} />}
                  <Text dimColor>Enter 填入草稿 · Esc 返回</Text>
                </Box>
              ) : (
                <PrototypeTranscript entries={visibleEntries} width={width} expanded={expanded} compact={compact} />
              )}
            </Box>
            {props.scenario === 'blocked' ? <StatusMessage variant="warning">Scope blocked · 等待对账</StatusMessage> : props.scenario === 'empty' ? <Text dimColor>暂无活动</Text> : <Spinner label="正在整理下一步" />}
            {notice === null ? null : <Text color={tuiColors.warning}>{notice}</Text>}
            <Box borderStyle="round" borderColor={tuiColors.focus} paddingX={1} flexDirection="column">
              <Text color={tuiColors.focus} bold>{'›  '}{draft.length === 0 ? <Text color={tuiColors.muted}>输入消息，继续讨论…</Text> : null}</Text>
              {draft.length === 0 ? null : wrapByDisplayWidth(draft, Math.max(1, width - 4)).slice(-4).map((line, index) => <Text key={index}>{line}</Text>)}
            </Box>
            <StatusLine scope={view.scope} compaction={view.compaction} maintenance={view.maintenance} blockerCount={view.blockers.length} notice={null} sidebarDensity={density} execution={view.execution} availableWidth={width} />
          </Box>
          {density === 'collapsed' ? null : <Sidebar density={density} viewModel={view} terminalWidth={terminalWidth} />}
        </Box>
        <Text color={tuiColors.muted}>{truncateToDisplayWidth('Ctrl+R 历史  ·  Ctrl+T 展开工具  ·  Enter 发送  ·  Alt+Enter 换行  ·  Ctrl+C 退出', terminalWidth)}</Text>
      </Box>
    </ThemeProvider>
  );
}
