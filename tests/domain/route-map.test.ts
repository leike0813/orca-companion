/**
 * Route Map 领域行为测试（change: `m1-plan-and-authorize-execution`，Owner: IP-2）。
 *
 * 覆盖 Requirement「Route Map authority and fixed-section updates」下的 Scenario：
 * - 用户提供的计划只作参考：roadmap/OpenSpec 等输入只能被分类为 Planning Reference。
 * - 本地不保存地图副本：解析只产出六个固定章节，未登记的二级标题与散文不进入结果。
 * - 写入固定章节：更新只替换目标章节，其它章节内容与相对顺序不变。
 * - 复述已解决决策不新增章节：重复写入不会长出新的章节结构。
 * 另外覆盖 `parseRouteMapRef` / `parseDecisionTicketRef` / `parseRouteMapSection` 的窄校验（fail closed）。
 */

import { expect, test } from 'vitest';

import {
  ROUTE_MAP_SECTIONS,
  classifyPlanningReference,
  isPlanningReference,
  parseDecisionTicketRef,
  parseRouteMapRef,
  parseRouteMapSection,
  parseRouteMapSections,
  renderRouteMapSection,
} from '../../src/domain/planning/route-map.js';

/** 按出现顺序取出正文里的二级标题，用于断言「章节结构没有被改动」。 */
function sectionHeadings(body: string): readonly string[] {
  return (body.match(/^##[ \t]+.+$/gm) ?? []).map((line) => line.replace(/^##[ \t]+/, '').trim());
}

test('用户提供的计划只是 Planning Reference，不会被读成权威规划成果', () => {
  const reference = classifyPlanningReference('openspec', { kind: 'openspec-doc', id: 'x' });

  expect(isPlanningReference(reference)).toBe(true);
  expect(reference.kind).toBe('planning_reference');
  expect(reference.source).toBe('openspec');

  for (const foreign of [
    { kind: 'openspec-doc', id: 'x' },
    { kind: 'planning_reference', source: 'unknown-source' },
    { kind: 'planning_reference' },
    null,
  ]) {
    expect(isPlanningReference(foreign)).toBe(false);
  }
});

test('解析只产出六个固定章节，正文里的其它二级标题与散文不进入结果', () => {
  const body = [
    '# 项目地图',
    '这段散文位于所有章节之外，不属于任何固定章节。',
    '## Destination',
    '把项目推进到目的地 A。',
    '## Notes',
    'Notes 下的内容不是固定章节。',
    '## Fog',
    '尚未厘清的部分。',
  ].join('\n');

  const sections = parseRouteMapSections(body);

  expect(Object.keys(sections).sort()).toEqual([...ROUTE_MAP_SECTIONS].sort());
  expect(sections.destination).toBe('把项目推进到目的地 A。');
  expect(sections.fog).toBe('尚未厘清的部分。');
  expect(sections.resolved_decisions).toBe('');
  expect(sections.open_decision_tickets).toBe('');
  expect(sections.dependencies).toBe('');
  expect(sections.scope_boundaries).toBe('');
  for (const value of Object.values(sections)) {
    expect(value).not.toContain('散文');
    expect(value).not.toContain('Notes 下的内容');
  }
});

test('写入固定章节只替换目标章节，其它章节内容与相对顺序不变', () => {
  const body = renderRouteMapSection(
    renderRouteMapSection(
      renderRouteMapSection('', 'destination', '目的地 D'),
      'fog',
      '尚未厘清的部分。',
    ),
    'scope_boundaries',
    '只改 src/planning',
  );
  const before = parseRouteMapSections(body);

  const updated = renderRouteMapSection(body, 'fog', '新内容');
  const after = parseRouteMapSections(updated);

  expect(after).toEqual({ ...before, fog: '新内容' });
  expect(sectionHeadings(updated)).toEqual(sectionHeadings(body));
  expect(sectionHeadings(body)).toEqual(['Destination', 'Fog', 'Scope Boundaries']);
});

test('复述已解决决策只写固定章节，不新增章节结构', () => {
  const base = renderRouteMapSection('', 'destination', '目的地 D');
  const once = renderRouteMapSection(base, 'resolved_decisions', '决策一：采用方案 A');
  const twice = renderRouteMapSection(once, 'resolved_decisions', '决策一：采用方案 A');

  expect(sectionHeadings(once)).toEqual([...sectionHeadings(base), 'Resolved Decisions']);
  expect(sectionHeadings(twice)).toEqual(sectionHeadings(once));
  expect(parseRouteMapSections(twice).resolved_decisions).toBe('决策一：采用方案 A');
});

test('已有全部固定章节时重复写入已解决决策不会产生平行章节', () => {
  const full = ROUTE_MAP_SECTIONS.reduce<string>(
    (body, section) => renderRouteMapSection(body, section, `${section} 的内容`),
    '',
  );
  const headingsBefore = sectionHeadings(full);

  const rewritten = renderRouteMapSection(
    renderRouteMapSection(full, 'resolved_decisions', '决策二：换一条路径'),
    'resolved_decisions',
    '决策二：换一条路径',
  );

  expect(headingsBefore).toHaveLength(ROUTE_MAP_SECTIONS.length);
  expect(sectionHeadings(rewritten)).toEqual(headingsBefore);
  expect(parseRouteMapSections(rewritten).resolved_decisions).toBe('决策二：换一条路径');
});

test('章节写入往返稳定且连续写入同一内容是幂等的', () => {
  const body = '## Destination\n\n起始目的地';

  for (const section of ROUTE_MAP_SECTIONS) {
    const once = renderRouteMapSection(body, section, `${section} 的内容`);
    const twice = renderRouteMapSection(once, section, `${section} 的内容`);

    expect(twice).toBe(once);
    expect(parseRouteMapSections(once)[section]).toBe(`${section} 的内容`);
    expect(parseRouteMapSections(twice)).toEqual(parseRouteMapSections(once));
  }
});

test('地图与票据引用只接受闭集 kind，且必须带非负整数 version', () => {
  const map = parseRouteMapRef({ kind: 'route-map', id: 'm', version: 2 }, 'ref');
  expect(map.ok).toBe(true);
  if (map.ok) {
    expect(map.value).toEqual({ kind: 'route-map', id: 'm', version: 2 });
  }

  for (const raw of [
    { kind: 'route-map', id: 'm' },
    { kind: 'route-map', id: 'm', version: -1 },
    { kind: 'route-map', id: 'm', version: 1.5 },
    { kind: 'decision-ticket', id: 'm', version: 2 },
    { id: 'm', version: 2 },
    null,
  ]) {
    const parsed = parseRouteMapRef(raw, 'ref');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.field).toContain('ref');
    }
  }

  const ticket = parseDecisionTicketRef({ kind: 'decision-ticket', id: 't', version: 3 }, 'ticketRef');
  expect(ticket.ok).toBe(true);
  if (ticket.ok) {
    expect(ticket.value.kind).toBe('decision-ticket');
  }

  for (const raw of [
    { kind: 'decision-ticket', id: 't' },
    { kind: 'decision-ticket', id: 't', version: -1 },
    { kind: 'decision-ticket', id: 't', version: 0.5 },
    { kind: 'route-map', id: 't', version: 1 },
  ]) {
    expect(parseDecisionTicketRef(raw, 'ticketRef').ok).toBe(false);
  }
});

test('章节名解析只接受六个固定章节', () => {
  expect(parseRouteMapSection('fog')).toBe('fog');
  for (const section of ROUTE_MAP_SECTIONS) {
    expect(parseRouteMapSection(section)).toBe(section);
  }
  for (const raw of ['nope', '', 7, null, { section: 'fog' }]) {
    expect(parseRouteMapSection(raw)).toBeNull();
  }
});
