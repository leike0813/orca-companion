/**
 * 渲染、重挂载与高频事件的零业务副作用（IP-09，`tui/graph-inspection`）。
 *
 * 断言的是可观察事实：`execute` 计数为 0、调用清单只有只读 query、Event Drawer 的窗口有界，
 * 以及折叠态 Sidebar 在结构上不访问图/Worker 详情。
 */

import { describe, expect, test, vi } from 'vitest';
import { createElement } from 'react';

import { EVENT_WINDOW } from '../../src/interfaces/tui/app.js';
import { Sidebar, SIDEBAR_COLLAPSED_MARKER } from '../../src/interfaces/tui/components/sidebar.js';
import { createFakeGraphBasis } from '../support/graph-basis.js';
import {
  projectTranscriptPage,
  projectTuiViewModel,
  projectGraphView,
} from '../../src/application/tui/view-model.js';
import type { BasisSource, BasisSourceRef, GraphVersionSummary } from '../../src/application/tui/graph-basis.js';
import {
  createFakePorts,
  frameText,
  makeSnapshot,
  renderComponent,
  renderTui,
  settle,
  type RenderedTui,
} from './harness.js';

/** 只读端口白名单：渲染路径只允许 query 与只读 store 读取，不允许任何写。 */
const READ_ONLY_PORTS = ['resolveHome', 'snapshot', 'history', 'transcript-body', 'inputStore.read', 'submissionStatus', 'modelCatalog'];

async function pressKey(rendered: RenderedTui, input: string): Promise<void> {
  rendered.stdin.write(input);
  await settle(2);
}

/** Ink 会把单独一个 ESC 当作可能的分块转义前缀挂起再回放，按 Esc 必须等真实时间。 */
async function pressEscape(rendered: RenderedTui): Promise<void> {
  rendered.stdin.write('\u001b');
  await new Promise((resolve) => setTimeout(resolve, 40));
  await settle(2);
}

/* -------------------------------------------------------------------------- */
/* 图历史与执行依据（IP-04）                                                    */
/* -------------------------------------------------------------------------- */

const ENTER = '\r';
const PG_DOWN = '\u001b[6~';
const PG_UP = '\u001b[5~';

/** 一条长中文计划：每行 24 个汉字，足够跨过 64KiB 范围读取的边界。 */
const LONG_PLAN = Array.from({ length: 6000 }, (_, index) => `第${String(index + 1).padStart(5, '0')}行：这是执行依据正文，用于验证有界范围读取与跨页续读。`).join('\n');

function basisFixture(options: { readonly versions?: number; readonly pageSize?: number } = {}) {
  const count = options.versions ?? 2;
  const versions: GraphVersionSummary[] = Array.from({ length: count }, (_, index) => ({
    graphId: 'graph-1',
    generation: 1,
    version: index + 1,
    recordKind: 'initial',
    parentVersion: null,
    patchId: null,
    mapRevision: 3,
    planRevision: 3,
    orcaRunId: 'run-1',
    recordedAt: Date.UTC(2026, 9, 1),
    generationStatus: 'candidate',
    current: index === count - 1,
  }));
  const topology = makeSnapshot().graphTopologies[0]!;
  const graphs = Object.fromEntries(
    versions.map((item) => {
      const snapshot = makeSnapshot({ graph: { graphId: 'graph-1', graphVersion: item.version, generation: item.generation }, graphTopologies: [{ ...topology, graphVersion: item.version }] });
      return [`${item.graphId}:${item.generation}:${item.version}`, projectGraphView(snapshot)];
    }),
  );
  const plan: BasisSourceRef = { kind: 'initial_plan', graph: { graphId: 'graph-1', generation: 1, version: 1 } };
  const sources: BasisSource[] = [{ id: 'plan:graph-1:1:1', label: '初始 Implementation Plan', ref: plan, sourceVersion: 'plan-3', unavailable: null }];
  const basis = createFakeGraphBasis({
    versions,
    graphs,
    sources,
    bodies: { 'initial_plan:graph-1:1:1': LONG_PLAN },
    ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
  });
  const fake = createFakePorts();
  return { fake, ports: { ...fake.ports, graphBasis: basis.port }, basis, versions, sources };
}

/** 完整记录的末项下钻到图版本目录：Ctrl+G → Enter 进详情 → Enter 打开依据 → Enter 进目录。 */
async function openVersionsFromInspector(rendered: RenderedTui): Promise<void> {
  await pressKey(rendered, '\u0007');
  await pressKey(rendered, ENTER);
  await pressKey(rendered, ENTER);
  await pressKey(rendered, ENTER);
  await settle(2);
}

describe('依据下钻的全路径零业务副作用', () => {
  test('首次正文固定实际版本，后续来源变化不会替换正文', async () => {
    const { ports, basis } = basisFixture();
    const seen: (string | null)[] = [];
    const port = {
      ...basis.port,
      listSources: async (input: Parameters<typeof basis.port.listSources>[0]) => {
        const result = await basis.port.listSources(input);
        return result.kind === 'read' ? { ...result, value: { ...result.value, items: result.value.items.map(item => ({ ...item, sourceVersion: null })) } } : result;
      },
      readSource: (input: Parameters<typeof basis.port.readSource>[0]) => {
        seen.push(input.sourceVersion);
        return Promise.resolve({ kind: 'read' as const, value: {
          sourceVersion: seen.length === 1 ? 'observed-v1' : 'observed-v2',
          text: seen.length === 1 ? '原始正文' : '替换正文不得展示',
          offset: input.offset, end: input.offset + 12, byteLength: 100,
        } });
      },
    };
    const rendered = renderTui({ ...ports, graphBasis: port });
    await settle();
    await openVersionsFromInspector(rendered);
    for (let depth = 0; depth < 3; depth++) await pressKey(rendered, ENTER);
    expect(frameText(rendered)).toContain('原始正文');
    await pressKey(rendered, PG_DOWN);
    expect(seen).toEqual([null, 'observed-v1']);
    expect(frameText(rendered)).not.toContain('替换正文不得展示');
    expect(frameText(rendered)).toContain('变化');
    rendered.unmount();
  });

  test('目录端口异常保留入口，逐层返回不产生业务动作', async () => {
    const { fake, ports, basis } = basisFixture();
    const rendered = renderTui({ ...ports, graphBasis: { ...basis.port, listVersions: () => Promise.reject(new Error('transport unavailable')) } });
    await settle();
    await openVersionsFromInspector(rendered);
    expect(frameText(rendered)).toContain('读取失败');
    await pressEscape(rendered);
    expect(frameText(rendered)).toContain('执行依据与历史图');
    expect(fake.executeCount()).toBe(0);
    rendered.unmount();
  });

  test('从 Inspector 逐层读到正文：没有任何 execute、写入或不相关端口调用', async () => {
    const { fake, ports, basis, versions } = basisFixture();
    const rendered = renderTui(ports);
    await settle();

    await openVersionsFromInspector(rendered);
    expect(frameText(rendered)).toContain('图版本历史');
    expect(frameText(rendered)).toContain('G1·v1');

    await pressKey(rendered, ENTER);
    expect(frameText(rendered)).toContain('历史图版本');

    await pressKey(rendered, ENTER);
    expect(frameText(rendered)).toContain('初始 Implementation Plan');

    await pressKey(rendered, ENTER);
    const body = frameText(rendered);
    expect(body).toContain('依据正文');
    expect(body).toContain('第00001行');
    expect(body).toContain('来源版本 plan-3');

    // 只读端口：目录/版本/来源/正文四次读取，没有 execute、没有输入写入。
    expect(fake.executeCount()).toBe(0);
    expect(fake.executeIntents).toEqual([]);
    expect(fake.calls.filter((call) => call.name === 'inputStore.write')).toEqual([]);
    expect(basis.calls.map((call) => call.name)).toEqual([
      'graphBasis.listVersions',
      'graphBasis.readVersion',
      'graphBasis.listSources',
      'graphBasis.readSource',
    ]);
    // 精确身份：正文范围读取带 Session、来源引用、来源版本与偏移。
    const read = basis.callsOf('graphBasis.readSource')[0]!.detail as { coordinatorSessionId: string; source: BasisSourceRef; sourceVersion: string | null; offset: number; maxBytes: number };
    // 读取绑定当前选中的 Session，而不是硬编码身份。
    expect(read.coordinatorSessionId).toBe('session-b');
    expect(read.source).toEqual({ kind: 'initial_plan', graph: { graphId: 'graph-1', generation: 1, version: 1 } });
    expect(read.sourceVersion).toBe('plan-3');
    expect(read.offset).toBe(0);
    expect(read.maxBytes).toBe(64 * 1024);
    expect(basis.callsOf('graphBasis.readVersion')[0]!.detail).toEqual({ coordinatorSessionId: 'session-b', graph: { graphId: 'graph-1', generation: 1, version: 1 } });
    expect(versions).toHaveLength(2);

    rendered.unmount();
  });

  test('PgDn 续读下一段、PgUp 回到已读偏移，resize 不重新读取', async () => {
    const { ports, basis } = basisFixture();
    const rendered = renderTui(ports);
    await settle();

    await openVersionsFromInspector(rendered);
    await pressKey(rendered, ENTER);
    await pressKey(rendered, ENTER);
    await pressKey(rendered, ENTER);
    const first = basis.callsOf('graphBasis.readSource').length;
    const firstOffset = (basis.callsOf('graphBasis.readSource')[0]!.detail as { offset: number }).offset;
    expect(first).toBe(1);
    expect(firstOffset).toBe(0);

    await pressKey(rendered, PG_DOWN);
    const second = basis.callsOf('graphBasis.readSource')[1]!.detail as { offset: number; maxBytes: number };
    expect(second.offset).toBeGreaterThan(0);
    expect(second.offset).toBeLessThanOrEqual(64 * 1024);
    // 续读接在上一次的 end 上，且不超过单次范围上限。
    expect(frameText(rendered)).toContain('字节 ' + second.offset);

    await pressKey(rendered, PG_UP);
    expect(basis.callsOf('graphBasis.readSource').length).toBe(2);
    expect(frameText(rendered)).toContain('字节 0');

    // resize 只重排当前范围：不再发起任何读取。
    rendered.stdout.emit('resize');
    await settle(2);
    expect(basis.callsOf('graphBasis.readSource').length).toBe(2);
    expect(frameText(rendered)).toContain('依据正文');

    rendered.unmount();
  });

  test('目录翻页按 keyset 续读，回翻回到原游标', async () => {
    const { ports } = basisFixture({ versions: 3, pageSize: 1 });
    const rendered = renderTui(ports);
    await settle();

    await openVersionsFromInspector(rendered);
    await vi.waitFor(() => expect(frameText(rendered)).toContain('G1·v1'));
    await pressKey(rendered, PG_DOWN);
    await vi.waitFor(() => expect(frameText(rendered)).toContain('G1·v2'));
    await pressKey(rendered, PG_DOWN);
    await vi.waitFor(() => expect(frameText(rendered)).toContain('G1·v3'));
    await pressKey(rendered, PG_UP);
    await vi.waitFor(() => expect(frameText(rendered)).toContain('G1·v2'));
    await pressKey(rendered, PG_UP);
    await vi.waitFor(() => expect(frameText(rendered)).toContain('G1·v1'));

    rendered.unmount();
  });

  test('迟到的目录响应不覆盖已经返回的页面', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { fake, ports, basis } = basisFixture();
    const delayed = {
      ...basis.port,
      listVersions: async (input: Parameters<typeof basis.port.listVersions>[0]) => {
        await gate;
        return basis.port.listVersions(input);
      },
    };
    const rendered = renderTui({ ...ports, graphBasis: delayed });
    await settle();

    await openVersionsFromInspector(rendered);
    // 目录还在读取中：先逐层返回到入口页，再让旧响应到达。
    expect(frameText(rendered)).toContain('图版本历史');
    expect(frameText(rendered)).toContain('正在读取图版本目录');
    await pressEscape(rendered);
    expect(frameText(rendered)).toContain('执行依据与历史图');
    release!();
    await settle(4);

    const text = frameText(rendered);
    expect(text).toContain('执行依据与历史图');
    expect(text).toContain('图版本历史（全代际）');
    expect(text).not.toContain('G1·v1');
    expect(fake.executeCount()).toBe(0);

    rendered.unmount();
  });

  test('端口未接通时入口给出结构化不可用，且不产生任何读取', async () => {
    const fake = createFakePorts();
    const rendered = renderTui(fake.ports);
    await settle();

    await pressKey(rendered, '\u0007');
    await pressKey(rendered, ENTER);
    await pressKey(rendered, ENTER);
    expect(frameText(rendered)).toContain('依据读取未接通');
    expect(fake.executeCount()).toBe(0);
    expect(frameText(rendered)).not.toContain('执行依据与历史目录');
    expect(frameText(rendered)).toContain('Graph Inspector');

    rendered.unmount();
  });
});


describe('重挂载与 resize 零业务副作用', () => {
  test('挂载、输入与重挂载后 execute 计数为 0，且只有只读调用', async () => {
    const fake = createFakePorts();

    const first = renderTui(fake.ports);
    await settle();
    // resize 只重算布局：不重新查询、更不写入。
    first.stdout.emit('resize');
    await settle(2);
    // 编辑只启动用户的合并计时器（窗口未到，且卸载会取消它）：渲染与输入路径本身不写库。
    first.stdin.write('half-typed');
    await settle(2);
    expect(fake.executeCount()).toBe(0);
    expect(fake.calls.filter((call) => call.name === 'inputStore.write')).toEqual([]);
    first.unmount();

    const second = renderTui(fake.ports);
    await settle();
    expect(frameText(second)).toContain('普通消息');

    expect(fake.executeCount()).toBe(0);
    expect(fake.executeIntents).toEqual([]);
    const names = [...new Set(fake.calls.map((call) => call.name))];
    expect(names.every((name) => READ_ONLY_PORTS.includes(name))).toBe(true);
    // 只读加载确实发生过（不是「什么都没跑」的假绿）。
    expect(names).toContain('snapshot');
    expect(names).toContain('history');
    // 重挂载真的重跑了挂载 effect，而不是复用了上一次的实例。
    expect(fake.calls.filter((call) => call.name === 'resolveHome')).toHaveLength(2);

    second.unmount();
  });
});

describe('高频事件有界刷新', () => {
  test('批量投递 200 条语义事件后无 execute，Event Drawer 窗口有界', async () => {
    const fake = createFakePorts();
    const rendered = renderTui(fake.ports);
    await settle();
    const framesBefore = rendered.frames.length;

    for (let index = 0; index < 200; index += 1) {
      fake.emit({
        eventId: `event-${String(index)}`,
        coordinatorSessionId: 'session-a',
        kind: 'state-changed',
        coordinationScopeId: 'scope-1',
        revision: index,
        reason: `r${String(index)}`,
      });
    }
    fake.emit({
      eventId: 'event-199',
      coordinatorSessionId: 'session-b',
      kind: 'state-changed',
      coordinationScopeId: 'scope-1',
      revision: 199,
      reason: 'duplicate-delivery',
    });
    await settle(2);
    expect(rendered.frames.length - framesBefore).toBeLessThan(EVENT_WINDOW);

    // 事件只进展示态，绝不触发领域动作。
    expect(fake.executeCount()).toBe(0);
    expect(fake.executeIntents).toEqual([]);

    // 打开 Event Drawer 观察窗口：只保留最近 EVENT_WINDOW 条。
    await pressKey(rendered, '\u0010');
    expect(frameText(rendered)).toContain('Command Palette');
    for (let index = 0; index < 4; index += 1) {
      await pressKey(rendered, '\u001b[B');
    }
    await pressKey(rendered, '\r');

    const frame = frameText(rendered);
    expect(frame).toContain('最近事件');
    const shown = frame.match(/state-changed rev=/g) ?? [];
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(EVENT_WINDOW);
    expect(frame).toContain('50');
    expect(shown.length).toBeLessThan(200);
    // 窗口保留的是最新事件，最旧的已被裁掉。
    expect(frame).toContain('(r199)');
    expect(frame).not.toContain('(r0)');
    expect(frame).not.toContain('duplicate-delivery');
    for(let step=0;step<EVENT_WINDOW-1;step++)await pressKey(rendered,'\u001b[B');
    expect(frameText(rendered)).toContain('(r150)');
    expect(frameText(rendered)).not.toContain('(r149)');
    expect(fake.executeCount()).toBe(0);

    rendered.unmount();
  });
});

describe('折叠态不计算不可见详情', () => {
  test('Sidebar 折叠态不访问 graph/workers 字段', async () => {
    const poisoned = new Proxy(
      {},
      {
        get: () => {
          throw new Error('折叠态不得读取图与 Worker 详情');
        },
      },
    );
    // 毒化确实会在读取时抛出，避免「假绿」。
    expect(() => (poisoned as { graph: unknown }).graph).toThrow();

    const viewModel = {
      ...projectTuiViewModel({
        snapshot: makeSnapshot(),
        transcript: projectTranscriptPage(null, { coordinatorSessionId: null }),
        selectedSessionId: null,
        unreadSessionIds: [],
      }),
      graph: poisoned as never,
      workers: poisoned as never,
    };

    const rendered = renderComponent(
      createElement(Sidebar, { density: 'collapsed', viewModel, terminalWidth: 120 }),
    );
    await settle(2);

    const frame = frameText(rendered);
    expect(frame).toContain(SIDEBAR_COLLAPSED_MARKER);
    expect(frame).not.toContain('wp-1');
    expect(frame).not.toContain('ready:');
  });
});
