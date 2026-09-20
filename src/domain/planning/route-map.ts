/**
 * IC-05：Route Map 与 Decision Ticket 的领域类型（Owner: `m1-plan-and-authorize-execution`）。
 *
 * Route Map 的正文归 issue tracker，本地只保存引用与 revision：这个模块不保存票据正文，也不读取
 * 时钟或网络。它唯一的实质工作是固定章节结构——读取时把地图正文解析成六个固定章节，写入时只
 * 替换这些章节的内容，因此「复述已解决决策」永远不会长出新的章节结构或第二份地图（D2）。
 *
 * 用户提供的 roadmap、OpenSpec、任务列表或既有计划都只是 Planning Reference：它们可以被引用，
 * 但不能被直接采用为权威规划成果（D1）。
 */

import {
  parseEntityRef,
  parseRevision,
  parseStableId,
  type EntityRef,
  type IdentityResult,
  type PlanningCycleId,
  type VersionedRef,
} from '../../application/dto/identity.js';

/** 固定章节集合；顺序即写入顺序，因此同一次更新的输出是确定的。 */
export const ROUTE_MAP_SECTIONS = [
  'destination',
  'resolved_decisions',
  'open_decision_tickets',
  'dependencies',
  'fog',
  'scope_boundaries',
] as const;

export type RouteMapSection = (typeof ROUTE_MAP_SECTIONS)[number];

/** 章节标题是解析与写入共用的唯一事实源，不在两处各写一份字符串。 */
export const ROUTE_MAP_SECTION_HEADINGS: Readonly<Record<RouteMapSection, string>> = {
  destination: 'Destination',
  resolved_decisions: 'Resolved Decisions',
  open_decision_tickets: 'Open Decision Tickets',
  dependencies: 'Dependencies',
  fog: 'Fog',
  scope_boundaries: 'Scope Boundaries',
};

/** 地图票据的外部引用；`version` 是调用方读到的地图 revision，不是 tracker 的 issue 版本。 */
export type RouteMapRef = VersionedRef<'route-map'>;

export type DecisionTicketRef = VersionedRef<'decision-ticket'>;

export const DECISION_TICKET_STATES = ['open', 'resolved'] as const;

export type DecisionTicketState = (typeof DECISION_TICKET_STATES)[number];

/**
 * 票据的领域投影。
 *
 * 正文留在 tracker；这里只有判断 Frontier 与依赖所需的字段。`blockedBy` 为空表示未阻塞。
 */
export type DecisionTicket = {
  readonly ticketRef: DecisionTicketRef;
  readonly state: DecisionTicketState;
  readonly blockedBy: readonly EntityRef<'decision-ticket'>[];
  /** tracker assignee 的可见部分；Claim 的权威部分是本地 Session 记录（D3）。 */
  readonly assignee: string | null;
};

export type RouteMapSections = Readonly<Record<RouteMapSection, string>>;

export type RouteMapSnapshot = {
  readonly routeMapRef: RouteMapRef;
  readonly planningCycleId: PlanningCycleId;
  readonly sections: RouteMapSections;
};

/** 用户提供的规划输入；只能被引用，不能成为权威规划成果。 */
export const PLANNING_REFERENCE_SOURCES = ['roadmap', 'openspec', 'task-list', 'existing-plan'] as const;

export type PlanningReferenceSource = (typeof PLANNING_REFERENCE_SOURCES)[number];

/** 判别标记让「参考」在任何边界都无法被误读成权威输入。 */
export const PLANNING_REFERENCE_KIND = 'planning_reference' as const;

export type PlanningReference = {
  readonly kind: typeof PLANNING_REFERENCE_KIND;
  readonly source: PlanningReferenceSource;
  readonly ref: EntityRef<string>;
  readonly note: string;
};

export function classifyPlanningReference(
  source: PlanningReferenceSource,
  ref: EntityRef<string>,
  note = '',
): PlanningReference {
  return { kind: PLANNING_REFERENCE_KIND, source, ref, note };
}

export function isPlanningReference(raw: unknown): raw is PlanningReference {
  if (typeof raw !== 'object' || raw === null) {
    return false;
  }
  const candidate = raw as { readonly kind?: unknown; readonly source?: unknown };
  return (
    candidate.kind === PLANNING_REFERENCE_KIND &&
    typeof candidate.source === 'string' &&
    (PLANNING_REFERENCE_SOURCES as readonly string[]).includes(candidate.source)
  );
}

/** 章节标题的匹配形态：行首 `## `，不接受更深的层级。 */
const HEADING_PATTERN = /^##[ \t]+(.+?)[ \t]*$/;

function sectionOfHeading(heading: string): RouteMapSection | null {
  const normalized = heading.trim().toLowerCase();
  for (const section of ROUTE_MAP_SECTIONS) {
    if (ROUTE_MAP_SECTION_HEADINGS[section].toLowerCase() === normalized) {
      return section;
    }
  }
  return null;
}

function emptySections(): Record<RouteMapSection, string> {
  return {
    destination: '',
    resolved_decisions: '',
    open_decision_tickets: '',
    dependencies: '',
    fog: '',
    scope_boundaries: '',
  };
}

/**
 * 把地图正文解析成固定章节。
 *
 * 未登记的二级标题与正文里的散文都不进入结果：它们既不会被读成某个章节，也不会被写入路径覆盖。
 * 缺失的章节返回空字符串，因此「章节不存在」与「章节为空」在写入时是同一件事。
 */
export function parseRouteMapSections(body: string): RouteMapSections {
  const sections = emptySections();
  const lines = body.split('\n');
  let current: RouteMapSection | null = null;
  let buffer: string[] = [];

  const flush = (): void => {
    if (current === null) {
      return;
    }
    sections[current] = buffer.join('\n').replace(/^\n+/, '').replace(/\s+$/, '');
  };

  for (const line of lines) {
    const match = HEADING_PATTERN.exec(line);
    if (match !== null) {
      flush();
      buffer = [];
      current = sectionOfHeading(match[1] ?? '');
      continue;
    }
    if (current !== null) {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}

/**
 * 把某个固定章节整体替换为 `content`。
 *
 * 章节已存在时只替换它的正文；不存在时追加到文末。其它章节的相对顺序与内容不变，因此
 * 「复述已解决决策」不会新增章节结构，也不会重排地图。
 */
export function renderRouteMapSection(body: string, section: RouteMapSection, content: string): string {
  const heading = `## ${ROUTE_MAP_SECTION_HEADINGS[section]}`;
  const normalized = content.trim();
  const trimmedBody = body.replace(/\s+$/, '');
  const lines = trimmedBody.length === 0 ? [] : trimmedBody.split('\n');

  const headingIndex = lines.findIndex((line) => {
    const match = HEADING_PATTERN.exec(line);
    return match !== null && sectionOfHeading(match[1] ?? '') === section;
  });

  const block = normalized.length === 0 ? [heading] : [heading, '', ...normalized.split('\n')];

  if (headingIndex === -1) {
    return lines.length === 0 ? block.join('\n') : `${lines.join('\n')}\n\n${block.join('\n')}`;
  }

  let end = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (HEADING_PATTERN.exec(lines[index] ?? '') !== null) {
      end = index;
      break;
    }
  }
  return [...lines.slice(0, headingIndex), ...block, ...lines.slice(end)].join('\n').replace(/\s+$/, '');
}

export function routeMapSnapshot(
  routeMapRef: RouteMapRef,
  planningCycleId: PlanningCycleId,
  body: string,
): RouteMapSnapshot {
  return { routeMapRef, planningCycleId, sections: parseRouteMapSections(body) };
}

/** 解析 tracker 返回的地图引用；kind 与 revision 都按闭集校验，缺失即 fail closed。 */
export function parseRouteMapRef(raw: unknown, field: string): IdentityResult<RouteMapRef> {
  const ref = parseEntityRef(raw, field, ['route-map']);
  if (!ref.ok) {
    return ref;
  }
  const version = parseRevision(
    typeof raw === 'object' && raw !== null ? (raw as { readonly version?: unknown }).version : undefined,
    `${field}.version`,
  );
  if (!version.ok) {
    return version;
  }
  return { ok: true, value: { kind: 'route-map', id: ref.value.id, version: version.value } };
}

/** 解析票据引用；`version` 是调用方读到的票据 revision，缺失即拒绝。 */
export function parseDecisionTicketRef(raw: unknown, field: string): IdentityResult<DecisionTicketRef> {
  const ref = parseEntityRef(raw, field, ['decision-ticket']);
  if (!ref.ok) {
    return ref;
  }
  const version = parseRevision(
    typeof raw === 'object' && raw !== null ? (raw as { readonly version?: unknown }).version : undefined,
    `${field}.version`,
  );
  if (!version.ok) {
    return version;
  }
  return { ok: true, value: { kind: 'decision-ticket', id: ref.value.id, version: version.value } };
}

/** 章节名解析：只接受固定集合，供工具 handler 在触达 tracker 之前拒绝未知章节。 */
export function parseRouteMapSection(raw: unknown): RouteMapSection | null {
  const parsed = parseStableId(raw, 'section');
  if (!parsed.ok) {
    return null;
  }
  return (ROUTE_MAP_SECTIONS as readonly string[]).includes(parsed.value)
    ? (parsed.value as RouteMapSection)
    : null;
}

export type RouteMapSectionWrite = {
  readonly section: RouteMapSection;
  readonly content: string;
};
