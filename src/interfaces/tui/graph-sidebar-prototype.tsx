/** Throwaway graph-sidebar comparison for wayfinder issue 43. */
import { Select, useSpinner } from '@inkjs/ui';
import { Box, Text, useAnimation, useInput, useWindowSize } from 'ink';
import { useState } from 'react';

import type { ControllerSnapshot } from '../../application/controller-service.js';
import { projectTranscriptPage, projectTuiViewModel, type TuiViewModel, type WorkPackageNodeView } from '../../application/tui/view-model.js';
import { layoutExecutionGraph, visibleRows, type GraphLayoutRow } from './render/graph-layout.js';
import { allowedSidebarDensity, displayWidth, padToDisplayWidth, sidebarWidthFor, truncateToDisplayWidth } from './render/width.js';
import { bodyWidth } from './screens/workspace.js';
import { StatusLine } from './components/status-line.js';
import { TopBar } from './components/top-bar.js';
import { tuiColors, tuiIconMode, tuiIcons, tuiSpinnerGlyphs, type TuiIconMode } from './theme.js';

type Phase = 'planning' | 'execution' | 'blocked';
type PrototypeProps = {
  readonly snapshots: Record<Phase, ControllerSnapshot>;
  readonly scenario: Phase;
  readonly terminalWidth: number;
  readonly large: boolean;
  readonly adaptive: boolean;
  readonly onExit: () => void;
};
type Point = { readonly x: number; readonly y: number };
type Cell = { mask: number; color: string; priority: number; glyph: string | null; bold: boolean; spinning?: boolean };
type Canvas = { readonly cells: Cell[][]; readonly positions: ReadonlyMap<string, Point> };

const phases: readonly Phase[] = ['planning', 'execution', 'blocked'];
const UP = 1;
const RIGHT = 2;
const DOWN = 4;
const LEFT = 8;
const lineChars = {
  ascii: [' ', '|', '-', '+', '|', '|', '+', '+', '-', '+', '-', '+', '+', '+', '+', '+'],
  nerd: [' ', '│', '─', '└', '│', '│', '┌', '├', '─', '┘', '─', '┴', '┐', '┤', '┬', '┼'],
};

function visual(node: WorkPackageNodeView, planning: boolean, iconMode: TuiIconMode) {
  const icons = tuiIcons[iconMode];
  if (planning) return { symbol: icons.candidate, label: '候选', color: tuiColors.accent };
  switch (node.state) {
    case 'accepted': return { symbol: icons.accepted, label: '已接受', color: tuiColors.success };
    case 'implementing': return { symbol: icons.running, label: '实施中', color: tuiColors.accent };
    case 'reconciling': return { symbol: icons.reconciling, label: '对账中', color: tuiColors.warning };
    case 'blocked': return { symbol: icons.blocked, label: '阻塞', color: tuiColors.error };
    case 'waiting': return { symbol: icons.waiting, label: '等待', color: tuiColors.muted };
    case 'unknown': return { symbol: icons.unknown, label: '待核验', color: tuiColors.warning };
    default: return { symbol: icons.candidate, label: node.state, color: tuiColors.focus };
  }
}

function workerLabel(node: WorkPackageNodeView): string {
  switch (node.liveness) {
    case 'live': return 'live';
    case 'exited': return '已退出';
    case 'unverifiable': return '待核验';
    case null: return '未观察';
  }
}

function makeCanvas(rows: readonly GraphLayoutRow[], width: number, horizontal: boolean, planning: boolean, frame: number, iconMode: TuiIconMode, rowGap?: number, selectedId?: string, abbreviate = false): Canvas {
  const maxDepth = Math.max(0, ...rows.map((row) => row.depth));
  const maxLayer = Math.max(1, ...Array.from({ length: maxDepth + 1 }, (_, depth) => rows.filter((row) => row.depth === depth).length));
  const gap = rowGap ?? (width < 30 ? 3 : width >= 60 ? 5 : 4);
  const height = horizontal ? Math.max(13, maxLayer * (rowGap ?? (width < 30 ? 3 : 4)) + 3) : maxDepth * gap + 1;
  const cells = Array.from({ length: height }, () =>
    Array.from({ length: width }, (): Cell => ({ mask: 0, color: tuiColors.border, priority: -1, glyph: null, bold: false })),
  );
  const positions = new Map<string, Point>();
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const layer = rows.filter((row) => row.depth === depth);
    layer.forEach((row, index) => {
      const x = horizontal
        ? Math.round(2 + depth * (width - 6) / Math.max(1, maxDepth))
        : Math.round((index + 1) * (width - 2) / (layer.length + 1));
      const y = horizontal
        ? Math.round((index + 1) * (height - 1) / (layer.length + 1))
        : depth * gap;
      positions.set(row.workPackageId, { x, y });
    });
  }
  const mark = (point: Point, bit: number, color: string, priority: number) => {
    const cell = cells[point.y]?.[point.x];
    if (cell === undefined) return;
    cell.mask |= bit;
    if (priority > cell.priority) {
      cell.color = color;
      cell.priority = priority;
    }
  };
  const drawPath = (points: readonly Point[], color: string, priority: number): Point[] => {
    const path: Point[] = [];
    for (let index = 1; index < points.length; index += 1) {
      const start = points[index - 1]!;
      const end = points[index]!;
      const dx = Math.sign(end.x - start.x);
      const dy = Math.sign(end.y - start.y);
      let current = start;
      while (current.x !== end.x || current.y !== end.y) {
        const next = { x: current.x + dx, y: current.y + dy };
        const firstBit = dx > 0 ? RIGHT : dx < 0 ? LEFT : dy > 0 ? DOWN : UP;
        const secondBit = dx > 0 ? LEFT : dx < 0 ? RIGHT : dy > 0 ? UP : DOWN;
        mark(current, firstBit, color, priority);
        mark(next, secondBit, color, priority);
        path.push(next);
        current = next;
      }
    }
    return path;
  };

  for (const row of rows) {
    const target = positions.get(row.workPackageId);
    if (target === undefined) continue;
    for (const dependency of row.node.dependsOn) {
      const source = positions.get(dependency);
      if (source === undefined) continue;
      const long = row.depth - (rows.find((item) => item.workPackageId === dependency)?.depth ?? row.depth) > 1;
      const approachY = target.y + Math.sign(source.y - target.y);
      const points = horizontal
        ? long
          ? [{ x: source.x + 1, y: source.y }, { x: source.x + 1, y: height - 2 }, { x: target.x - 1, y: height - 2 }, { x: target.x - 1, y: target.y }, target]
          : source.y === target.y
            ? [{ x: source.x + 1, y: source.y }, target]
            : [{ x: source.x + 1, y: source.y }, { x: source.x + 2, y: source.y }, { x: source.x + 2, y: approachY }, { x: target.x - 1, y: approachY }, { x: target.x - 1, y: target.y }, target]
        : long
          ? [source, { x: width - 2, y: source.y }, { x: width - 2, y: target.y - 1 }, { x: target.x, y: target.y - 1 }, target]
          : [source, { x: source.x, y: source.y + 1 }, { x: target.x, y: source.y + 1 }, target];
      const blocked = row.node.state === 'blocked' || row.node.liveness === 'unverifiable';
      const active = row.node.active && row.node.liveness === 'live';
      const selected = row.workPackageId === selectedId;
      const color = selected ? tuiColors.focus : blocked ? tuiColors.error : active ? tuiColors.accent : row.node.state === 'accepted' ? tuiColors.success : tuiColors.border;
      const priority = selected ? 4 : blocked ? 3 : active ? 2 : row.node.state === 'accepted' ? 1 : 0;
      const path = drawPath(points, color, priority);
      if (active && path.length > 2) {
        const pulse = path[Math.floor(frame / 2) % (path.length - 1)];
        const cell = pulse === undefined ? undefined : cells[pulse.y]?.[pulse.x];
        if (cell !== undefined) {
          cell.glyph = iconMode === 'ascii' ? '.' : '•';
          cell.color = tuiColors.accent;
          cell.bold = true;
        }
      }
    }
  }
  for (const row of rows) {
    const point = positions.get(row.workPackageId);
    if (point === undefined) continue;
    const state = visual(row.node, planning, iconMode);
    const number = abbreviate && row.workPackageId !== selectedId && row.node.state !== 'blocked' ? '' : String(row.position + 1);
    if (row.workPackageId === selectedId) {
      const marker = cells[point.y]?.[point.x - 1];
      if (marker !== undefined) {
        marker.glyph = iconMode === 'ascii' ? '>' : '›';
        marker.color = tuiColors.focus;
        marker.bold = true;
      }
    }
    for (const [offset, character] of [...state.symbol + ' ' + number].entries()) {
      const cell = cells[point.y]?.[point.x + offset];
      if (cell !== undefined) {
        cell.glyph = character;
        cell.color = state.color;
        cell.bold = true;
        cell.spinning = offset === 0 && !planning && row.node.state === 'implementing' && row.node.liveness === 'live';
      }
    }
  }
  return { cells, positions };
}

function GraphNodeSpinner({ iconMode }: { readonly iconMode: TuiIconMode }) {
  const { frame } = useSpinner({ type: iconMode === 'nerd' ? 'moon' : 'line' });
  return <Text>{iconMode === 'nerd' ? tuiSpinnerGlyphs[frame.trim()] ?? tuiIcons[iconMode].running : frame}</Text>;
}

function GraphCanvas({ cells, iconMode, start = 0, end = cells.length }: {
  readonly cells: Cell[][];
  readonly iconMode: TuiIconMode;
  readonly start?: number;
  readonly end?: number;
}) {
  return (
    <Box flexDirection="column">
      {cells.slice(start, end).map((line, rowIndex) => {
        const chars = line.map((cell) => cell.glyph ?? lineChars[iconMode][cell.mask] ?? ' ');
        let end = chars.length;
        while (end > 0 && chars[end - 1] === ' ') end -= 1;
        const parts: { text: string; color: string; bold: boolean; spinning: boolean }[] = [];
        for (let index = 0; index < end; index += 1) {
          const cell = line[index]!;
          const previous = parts.at(-1);
          if (previous !== undefined && !previous.spinning && !cell.spinning && previous.color === cell.color && previous.bold === cell.bold) previous.text += chars[index];
          else parts.push({ text: chars[index] ?? ' ', color: cell.color, bold: cell.bold, spinning: cell.spinning === true });
        }
        return <Text key={rowIndex}>{parts.length === 0 ? ' ' : parts.map((part, index) => <Text key={index} color={part.color} bold={part.bold}>{part.spinning ? <GraphNodeSpinner iconMode={iconMode} /> : part.text}</Text>)}</Text>;
      })}
    </Box>
  );
}

export function GraphIconHint({ width, optionsKey = '' }: { readonly width: number; readonly optionsKey?: string }) {
  return <Text color={tuiColors.muted}>{truncateToDisplayWidth('图标异常？' + optionsKey + '选项切ASCII', width)}</Text>;
}

export function AdaptiveGraphSidebar({ view, width, height, horizontal, selectedId, inspector = false, infoTab = 0, iconMode = tuiIconMode }: {
  readonly view: TuiViewModel;
  readonly width: number;
  readonly height: number;
  readonly horizontal: boolean;
  readonly selectedId: string | null;
  readonly inspector?: boolean;
  readonly infoTab?: number;
  readonly iconMode?: TuiIconMode;
}) {
  const rows = visibleRows(layoutExecutionGraph(view.graph?.nodes ?? []));
  const planning = view.scope.mode === 'route_planning';
  const { frame } = useAnimation({ interval: 140, isActive: rows.some((row) => row.node.active && row.node.liveness === 'live') });
  const selected = rows.find((row) => row.workPackageId === selectedId) ?? rows.find((row) => row.node.active) ?? rows[0];
  const active = rows.find((row) => row.node.active);
  const showActive = active !== undefined && active.workPackageId !== selected?.workPackageId;
  const pinned = Math.min(view.blockers.length, 2) + (showActive ? 1 : 0);
  const shortInspector = inspector && height < 20;
  const infoHeight = inspector ? shortInspector ? 9 : 11 : 7;
  const budget = Math.max(1, height - 2 - infoHeight - pinned);
  const maxDepth = Math.max(0, ...rows.map((row) => row.depth));
  const gap = width >= 55 && budget >= maxDepth * 5 + 1 ? 5 : budget >= maxDepth * 4 + 1 ? 4 : 3;
  const canvas = makeCanvas(rows, width, horizontal, planning, frame, iconMode, gap, selected?.workPackageId, width < 32);
  const focusY = canvas.positions.get(selected?.workPackageId ?? '')?.y ?? 0;
  const start = Math.max(0, Math.min(canvas.cells.length - budget, focusY - Math.floor(budget / 2)));
  const end = Math.min(canvas.cells.length, start + budget);
  const above = rows.filter((row) => (canvas.positions.get(row.workPackageId)?.y ?? 0) < start).length;
  const below = rows.filter((row) => (canvas.positions.get(row.workPackageId)?.y ?? 0) >= end).length;
  const accepted = planning ? 0 : rows.filter((row) => row.node.state === 'accepted').length;
  const fit = (value: string) => truncateToDisplayWidth(value, width);
  const node = selected?.node;
  const cardWidth = Math.max(1, width - 4);
  const cardFit = (value: string, limit = cardWidth) => truncateToDisplayWidth(value, limit);
  const dependencies = (ids: readonly string[]) => ids.map((id) => {
    const row = rows.find((item) => item.workPackageId === id);
    return row === undefined ? id : String(row.position + 1) + (inspector ? ' ' + row.node.title : '');
  }).join(' · ') || '无';
  const field = (label: string, value: string, limit = cardWidth) => <Text>
    <Text color={tuiColors.muted}>{padToDisplayWidth(label, Math.min(6, Math.floor(limit / 3)))} </Text>
    {cardFit(value, Math.max(1, limit - Math.min(6, Math.floor(limit / 3)) - 1))}
  </Text>;
  const pair = (left: [string, string], right: [string, string]) => cardWidth >= 60
    ? <Box flexDirection="row"><Box width={Math.floor(cardWidth / 2)}>{field(...left, Math.floor(cardWidth / 2))}</Box>
      <Box width={cardWidth - Math.floor(cardWidth / 2)}>{field(...right, cardWidth - Math.floor(cardWidth / 2))}</Box></Box>
    : field(left[0], left[1] + ' · ' + right[0] + ' ' + right[1]);
  const sectionTitles = ['执行依据', '工作范围', '完整身份'];
  const sectionTitle = sectionTitles[infoTab] ?? sectionTitles[0]!;
  const sectionHeading = '[' + sectionTitle + '] · ' + (infoTab + 1) + '/3 · Tab';
  const detail = node === undefined ? null : infoTab === 1 ? <>
    {shortInspector ? pair(['包含', node.scopeEnvelope.include.join(', ') || '无'], ['排除', node.scopeEnvelope.exclude.join(', ') || '无'])
      : <>{field('包含', node.scopeEnvelope.include.join(', ') || '无')}{field('排除', node.scopeEnvelope.exclude.join(', ') || '无')}</>}
    {field('依据', node.derivedFrom.join(', ') || '尚无执行依据')}
  </> : infoTab === 2 ? <>
    {shortInspector ? pair(['节点', node.workPackageId], ['基线', node.baselineHead ?? '未提供']) : field('节点', node.workPackageId)}
    {field('图', (view.graph?.graphId ?? '不可读') + ' v' + (view.graph?.graphVersion ?? '?') + ' · 第 ' + (view.graph?.generation ?? '?') + ' 代')}
    {shortInspector ? null : field('基线', node.baselineHead ?? '未提供')}
  </> : <>
    {pair(['角色', node.role ?? '未派发'], ['尝试', node.attemptId ?? '未建立'])}
    {shortInspector ? pair(['工作区', node.worktreePath ?? '尚未建立'], ['验证', (node.validation?.state ?? '未提供') + ' · 集成 ' + (node.integration?.state ?? '未提供')])
      : <>{field('工作区', node.worktreePath ?? '尚未建立')}{pair(['验证', node.validation?.state ?? '未提供'], ['集成', node.integration?.state ?? '未提供'])}</>}
  </>;
  return (
    <Box flexDirection="column">
      <Text bold color={tuiColors.accent}>{fit(planning ? `${rows.length} 节点 · 候选图` : `${accepted}/${rows.length} 已接受 · ${view.blockers.length} 阻塞`)}</Text>
      <Text color={tuiColors.muted}>{fit((horizontal ? '横向' : '纵向') + (above + below ? ` · 图外 ↑${above} ↓${below}` : ' · 全图可见'))}</Text>
      <GraphCanvas cells={canvas.cells} iconMode={iconMode} start={start} end={end} />
      <Box flexDirection="column" width={width} height={infoHeight} flexShrink={0} borderStyle="round" borderColor={tuiColors.border} paddingX={1} overflow="hidden">
        <Text bold color={node === undefined ? tuiColors.muted : visual(node, planning, iconMode).color}>{cardFit(selected === undefined ? '无节点' : `${selected.position + 1} ${selected.node.title}`)}</Text>
        {node === undefined ? null : <>
          {field('状态', visual(node, planning, iconMode).label + ' · Worker ' + workerLabel(node))}
          <Text color={tuiColors.accent}>{cardFit('── 依赖关系 ' + '─'.repeat(Math.max(0, cardWidth - displayWidth('── 依赖关系 '))))}</Text>
          {shortInspector ? pair(['前驱', dependencies(node.dependsOn)], ['后继', dependencies(rows.filter((row) => row.node.dependsOn.includes(node.workPackageId)).map((row) => row.workPackageId))])
            : <>{field('前驱', dependencies(node.dependsOn))}{field('后继', dependencies(rows.filter((row) => row.node.dependsOn.includes(node.workPackageId)).map((row) => row.workPackageId)))}</>}
          {inspector ? <><Text color={tuiColors.accent}>{cardFit(sectionHeading)}</Text>{detail}</> : null}
        </>}
      </Box>
      {showActive ? <Text color={tuiColors.accent}>{fit(`当前 ${active.position + 1} ${active.node.title} · ${visual(active.node, planning, iconMode).label}`)}</Text> : null}
      {view.blockers.slice(0, 2).map((blocker) => <Text key={blocker.code} color={tuiColors.error}>{fit('! ' + blocker.message)}</Text>)}
    </Box>
  );
}

function GraphSidebar({ view, width, compact, variant, iconMode }: {
  readonly view: TuiViewModel;
  readonly width: number;
  readonly compact: boolean;
  readonly variant: number;
  readonly iconMode: TuiIconMode;
}) {
  const rows = visibleRows(layoutExecutionGraph(view.graph?.nodes ?? []));
  const { frame } = useAnimation({ interval: 140, isActive: rows.some((row) => row.node.active && row.node.liveness === 'live') });
  const planning = view.scope.mode === 'route_planning';
  const accepted = planning ? 0 : rows.filter((row) => row.node.state === 'accepted').length;
  const active = rows.find((row) => row.node.active)?.node;
  const numberById = new Map(rows.map((row) => [row.workPackageId, row.position + 1]));
  const fit = (value: string) => truncateToDisplayWidth(value, width);
  const canvas = makeCanvas(rows, width, variant === 1, planning, frame, iconMode);
  return (
    <Box flexDirection="column">
      <Text bold color={tuiColors.accent}>{fit(planning ? '候选图 · ' + String(rows.length) + ' 节点' : String(accepted) + '/' + String(rows.length) + ' 已接受 · ' + String(view.blockers.length) + ' 阻塞')}</Text>
      <Text color={tuiColors.muted}>{fit(variant === 0 ? '拓扑分叉' : '横向流向')}</Text>
      <GraphCanvas cells={canvas.cells} iconMode={iconMode} />
      {compact ? (
        <>
          {active === undefined ? null : <Text color={tuiColors.accent}>{fit(tuiIcons[iconMode].running + ' ' + active.shortKey + ' ' + visual(active, planning, iconMode).label)}</Text>}
          {view.blockers.slice(0, 2).map((blocker) => <Text key={blocker.code} color={tuiColors.error}>{fit('! ' + blocker.message)}</Text>)}
        </>
      ) : (
        <>
          {rows.map((row) => {
            const state = visual(row.node, planning, iconMode);
            const dependencies = row.node.dependsOn.map((id) => numberById.get(id) ?? '?').join(',');
            return <Text key={row.workPackageId} color={state.color}>{fit(String(row.position + 1) + ' ' + state.symbol + ' ' + row.node.title + ' · ' + state.label + (dependencies ? ' ←' + dependencies : ''))}</Text>;
          })}
          {active === undefined ? null : <Text color={tuiColors.accent}>{fit('当前 ' + active.shortKey + ' · Worker ' + workerLabel(active))}</Text>}
          {view.blockers.slice(0, 2).map((blocker) => <Text key={blocker.code} color={tuiColors.error}>{fit('! ' + blocker.message)}</Text>)}
        </>
      )}
    </Box>
  );
}

export function GraphSidebarPrototype(props: PrototypeProps) {
  const size = useWindowSize();
  const terminalWidth = size.columns || props.terminalWidth;
  const terminalHeight = size.rows || 40;
  const density = allowedSidebarDensity(terminalWidth);
  const graphWidth = props.adaptive && density !== 'collapsed'
    ? Math.min(70, Math.max(24, Math.round(terminalWidth * 0.42)))
    : props.large && density === 'full' && terminalWidth >= 160 ? 64 : sidebarWidthFor(density);
  const width = graphWidth !== sidebarWidthFor(density) ? terminalWidth - graphWidth - 2 : bodyWidth(terminalWidth, density);
  const [phase, setPhase] = useState<Phase>(props.scenario);
  const [variant, setVariant] = useState(0);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [iconMode, setIconMode] = useState<TuiIconMode>(tuiIconMode);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const snapshot = props.snapshots[phase];
  const view = projectTuiViewModel({
    snapshot,
    transcript: projectTranscriptPage(null, { coordinatorSessionId: 'session-a' }),
    selectedSessionId: 'session-a',
    unreadSessionIds: [],
    includeGraphNodes: density !== 'collapsed',
  });
  const graphRows = props.adaptive && density !== 'collapsed' ? visibleRows(layoutExecutionGraph(view.graph?.nodes ?? [])) : [];
  const activeId = graphRows.find((row) => row.node.active)?.workPackageId ?? graphRows[0]?.workPackageId ?? null;
  useInput((input, key) => {
    if (key.ctrl && input === 'c') props.onExit();
    else if (optionsOpen) { if (key.escape) setOptionsOpen(false); }
    else if (input.toLowerCase() === 'o') setOptionsOpen(true);
    else if (key.tab) setVariant((current) => 1 - current);
    else if (input.toLowerCase() === 'm') setPhase((current) => phases[(phases.indexOf(current) + 1) % phases.length] ?? 'planning');
    else if (props.adaptive && (input.toLowerCase() === 'j' || input.toLowerCase() === 'k')) {
      const index = graphRows.findIndex((row) => row.workPackageId === (focusId ?? activeId));
      const next = Math.max(0, Math.min(graphRows.length - 1, index + (input.toLowerCase() === 'j' ? 1 : -1)));
      setFocusId(graphRows[next]?.workPackageId ?? null);
    } else if (props.adaptive && input.toLowerCase() === 'f') setFocusId(null);
  });

  const summary = variant === 0
    ? '▏执行图已折叠 · active ' + String(view.execution.activeWorkPackageCount) + ' · !' + String(view.blockers.length) + ' 阻塞'
    : '▏! ' + String(view.blockers.length) + ' 阻塞 · 当前 ' + (view.execution.activeWorkPackageId ?? '无');
  return (
    <Box flexDirection="column" height={terminalHeight}>
      <TopBar
        coordinationScopeId={view.scope.coordinationScopeId}
        mode={view.scope.mode}
        controlState={view.scope.controlState}
        graphLabel={view.graph === null ? null : view.graph.graphId + ' v' + String(view.graph.graphVersion)}
        generation={view.graph?.generation ?? null}
        authorizationLabel={view.scope.authorization?.authorizationId ?? null}
        activeWorkPackageCount={view.execution.activeWorkPackageCount}
        reconciling={view.execution.reconciliation.pending}
        availableWidth={terminalWidth}
      />
      <Box flexDirection="row" flexGrow={1}>
        <Box flexDirection="column" width={width} flexGrow={1}>
          {density === 'collapsed' ? <Text bold color={view.blockers.length > 0 ? tuiColors.error : tuiColors.accent}>{truncateToDisplayWidth(summary, width)}</Text> : null}
          <Box flexDirection="column" flexGrow={1} marginTop={1}>
            <Box borderStyle="single" borderTop={false} borderRight={false} borderBottom={false} borderColor={tuiColors.accent} paddingLeft={1}>
              <Text bold color={tuiColors.accent}>› 执行图现在走到哪里？有需要我处理的阻塞吗？</Text>
            </Box>
            <Box marginTop={1} flexDirection="column">
              <Text><Text color={tuiColors.success}>● </Text>{phase === 'planning' ? '候选图已经排出依赖顺序，仍在等待执行授权。' : phase === 'blocked' ? '节点位置保持不变；对账未完成，当前状态需要核验。' : '当前只有一个工作包在运行。阻塞与 Worker 存活状态分别显示在右侧。'}</Text>
            </Box>
          </Box>
          <Box borderStyle="round" borderColor={tuiColors.focus} paddingX={1}><Text color={tuiColors.muted}>› 继续提问…</Text></Box>
          <StatusLine scope={view.scope} compaction={view.compaction} maintenance={view.maintenance} blockerCount={view.blockers.length} notice={null} sidebarDensity={density} execution={view.execution} availableWidth={width} />
        </Box>
        {density === 'collapsed' ? null : (
          <Box flexDirection="column" width={graphWidth + 2} borderStyle="single" borderColor={tuiColors.border} borderTop={false} borderBottom={false} borderRight={false} overflowY="hidden">
            {optionsOpen ? <Box flexDirection="column">
              <Text bold>选项 · 图标</Text>
              <Select options={[{ label: 'Nerd Fonts' + (iconMode === 'nerd' ? ' · 当前' : ''), value: 'nerd' }, { label: 'ASCII' + (iconMode === 'ascii' ? ' · 当前' : ''), value: 'ascii' }]}
                onChange={(value) => { setIconMode(value === 'ascii' ? 'ascii' : 'nerd'); setOptionsOpen(false); }} />
              <Text dimColor>Enter 应用 · Esc 返回</Text>
            </Box> : props.adaptive
              ? <AdaptiveGraphSidebar view={view} width={graphWidth} height={Math.max(1, terminalHeight - 5)} horizontal={variant === 1} selectedId={focusId ?? activeId} iconMode={iconMode} />
              : <GraphSidebar view={view} width={graphWidth} compact={density === 'compact'} variant={variant} iconMode={iconMode} />}
            <Box flexGrow={1} />
            <GraphIconHint width={graphWidth} optionsKey="O" />
          </Box>
        )}
      </Box>
      <Text color={tuiColors.muted}>{truncateToDisplayWidth((variant === 0 ? '拓扑分叉' : '横向流向') + ' · ' + phase + (props.adaptive ? '  |  J/K 选节点 · F 回当前' : '') + '  |  Tab 切换布局 · M 切换场景 · Ctrl+C 退出', terminalWidth)}</Text>
    </Box>
  );
}
