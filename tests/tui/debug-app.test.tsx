/**
 * 调试前台行为测试（`ocp --debug`）。
 *
 * 只断言用户可观察的事实：会话/模型选择、发送与三值提交结果、输入与提交身份保留、停止与恢复、
 * slash 采用与执行分离、Ctrl+C 的取消顺序，以及载入既有草稿时绝不自动发送。
 * 用例不 snapshot 整屏，也不读实现内部结构。
 */

import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { describe, expect, test, vi } from 'vitest';

import { DebugApp } from '../../src/interfaces/tui/debug-app.js';
import type { AgentTurnState } from '../../src/application/ports/agent-turn.js';
import type {
  DebugHarnessPort,
  DebugOpenInput,
  DebugSendInput,
  DebugSendResult,
} from '../../src/application/ports/debug-harness.js';
import type { SubmissionStatus } from '../../src/application/coordinator/submission-status.js';
import type { CoordinatorModelConfiguration } from '../../src/application/coordinator/model-config-switch.js';
import type { UiInputStore } from '../../src/application/ports/ui-input-store.js';
import { targetDraftKey, type UiInputTarget } from '../../src/application/ports/ui-input-store.js';
import type { ProviderCatalog } from '../../src/application/configuration/provider-catalog.js';
import type { ProviderLibrary } from '../../src/application/configuration/provider-library.js';
import { openUiInputStore } from '../../src/adapters/storage/ui-input-store.js';
import type { ModelDefinition, ProviderConnection } from '../../src/domain/model-configuration.js';
import { createTranscriptReadingFixture } from '../support/transcript-reading.js';

const SESSION = 'debug-session-0001';
const CONFIGURATION: CoordinatorModelConfiguration = {
  configurationRef: 'config-a',
  providerIntegration: 'openai-chat',
  model: 'gpt-x',
  credentialRefs: [],
  nativeWindowOwnerRef: null,
};

type FakeHarness = {
  harness: DebugHarnessPort;
  sent: DebugSendInput[];
  opens: DebugOpenInput[];
  submissionQueries: string[];
  inputStore: UiInputStore;
  saves: { readonly connections: unknown[]; readonly models: unknown[] };
  counters: { stops: number; retries: number; exitIntents: number; closes: number };
};

/**
 * 内存里的 Provider library 与公共目录：调试空库配置消费的就是这两个生产服务的形状，
 * 因此连接、模型与凭据引用的保存路径与真实实现一致。
 */
function fakeProviderLibrary(): {
  readonly library: ProviderLibrary;
  readonly catalog: ProviderCatalog;
  readonly saves: { readonly connections: unknown[]; readonly models: unknown[] };
} {
  const saves: { connections: unknown[]; models: unknown[] } = { connections: [], models: [] };
  const connections: ProviderConnection[] = [];
  const models: ModelDefinition[] = [];
  let revision = 0;
  const effortCapability = { values: ['low', 'high'], source: 'native-catalog', optionPath: '/reasoning/effort' };
  const catalogModel = { id: 'gpt-fixture', label: 'GPT Fixture', providerId: 'openai', protocol: 'openai-chat' as const, effortCapability, contextWindow: null };
  const catalog: ProviderCatalog = {
    presets: () => [{ id: 'openai', label: 'OpenAI', protocol: 'openai-chat', baseUrl: 'https://api.openai.com/v1', discovery: true }],
    candidates: () => ({ models: [catalogModel], source: 'catalog', catalogVersion: 'fixture', expired: false }),
    discover: () => Promise.resolve({ models: [catalogModel], source: 'discovery', catalogVersion: 'fixture', expired: false }),
    refresh: () => Promise.resolve({ kind: 'unchanged' as const, catalogVersion: 'fixture' }),
  };
  const library: ProviderLibrary = {
    load: () => ({ kind: 'loaded', revision, connections, models }),
    saveConnection: (input) => {
      saves.connections.push(input);
      const connection: ProviderConnection = {
        connectionRef: 'conn-new',
        label: input.label,
        providerId: input.providerId,
        providerIntegration: input.providerIntegration,
        baseUrl: input.baseUrl,
        credential: { kind: 'managed', credentialRef: 'credential-ref-new' },
      };
      connections.push(connection);
      revision += 1;
      return Promise.resolve({ kind: 'saved' as const, revision, connection });
    },
    saveModel: (input) => {
      saves.models.push(input);
      const model: ModelDefinition = { modelRef: 'model-new', connectionRef: input.connectionRef, model: input.model, effortCapability };
      models.push(model);
      revision += 1;
      return { kind: 'saved' as const, revision, model };
    },
    resolveModel: (modelRef) => {
      const model = models.find((item) => item.modelRef === modelRef);
      const connection = model === undefined ? undefined : connections.find((item) => item.connectionRef === model.connectionRef);
      return model !== undefined && connection !== undefined
        ? { kind: 'resolved' as const, model, connection }
        : { kind: 'rejected' as const, code: 'model_missing', message: 'missing' };
    },
  };
  return { library, catalog, saves };
}

function fakeHarness(overrides: {
  send?: (input: DebugSendInput) => DebugSendResult | Promise<DebugSendResult>;
  turn?: AgentTurnState;
  sessions?: readonly string[];
  submissionStatus?: SubmissionStatus;
  blank?: boolean;
  openRejected?: boolean;
} = {}): FakeHarness {
  const sent: DebugSendInput[] = [];
  const opens: DebugOpenInput[] = [];
  const submissionQueries: string[] = [];
  const provider = fakeProviderLibrary();
  const opened = openUiInputStore({ databasePath: ':memory:' });
  if (opened.kind !== 'opened') throw new Error('无法创建内存 UI 输入存储');
  let turn: AgentTurnState = overrides.turn ?? { kind: 'idle' };
  let open: { readonly kind: 'opened' } | { readonly kind: 'rejected'; readonly code: string; readonly message: string } | null = null;
  const currentModels = () => {
    if (overrides.blank !== true) return [
      { modelRef: 'model-a', connectionRef: 'conn-a', connectionLabel: 'OpenAI', providerIntegration: 'openai-chat', model: 'gpt-x', efforts: null },
      { modelRef: 'model-b', connectionRef: 'conn-b', connectionLabel: 'Anthropic', providerIntegration: 'anthropic-messages', model: 'claude-y', efforts: ['low', 'high'] },
    ];
    const loaded = provider.library.load();
    if (loaded.kind !== 'loaded') return [];
    const { models: savedModels, connections: savedConnections } = loaded;
    return savedModels.map((model) => {
      const connection = savedConnections.find((item) => item.connectionRef === model.connectionRef)!;
      return { modelRef: model.modelRef, connectionRef: connection.connectionRef, connectionLabel: connection.label,
        providerIntegration: connection.providerIntegration, model: model.model, efforts: model.effortCapability?.values ?? null };
    });
  };
  const fake = {
    stops: 0,
    retries: 0,
    exitIntents: 0,
    closes: 0,
  };
  const state = () => open === null
    ? ({ kind: 'no-session' } as const)
    : ({ kind: 'state', state: { debugDirectoryId: 'debug-dir-1', directoryPath: '/tmp/debug-project',
      coordinatorSessionId: SESSION, configuration: CONFIGURATION, turn, running: false } } as const);
  const harness: DebugHarnessPort = {
    home: () => ({
      kind: 'home',
      debugDirectoryId: 'debug-dir-1',
      directoryPath: '/tmp/debug-project',
      sessions: (overrides.sessions ?? []).map((id) => ({
        coordinatorSessionId: id,
        debugDirectoryId: 'debug-dir-1',
        directoryPath: '/tmp/debug-project',
        configuration: CONFIGURATION,
        createdAt: 1,
        updatedAt: 1,
        turn: null,
      })),
      models: currentModels(),
    }),
    providerLibrary: { library: provider.library, catalog: provider.catalog },
    open: (input: DebugOpenInput) => {
      opens.push(input);
      if (overrides.openRejected === true) return Promise.resolve({ kind: 'rejected', code: 'capability_missing', message: '能力核验失败' });
      if (input.kind === 'new' && input.modelRef === 'model-b') {
        return Promise.resolve({ kind: 'rejected', code: 'model_unknown', message: '模型不在用户模型库中' });
      }
      open = { kind: 'opened' };
      return Promise.resolve({ kind: 'opened', recovered: true, capabilities: ['text'],
        state: { debugDirectoryId: 'debug-dir-1', directoryPath: '/tmp/debug-project', coordinatorSessionId: SESSION,
          configuration: CONFIGURATION, turn, running: false } });
    },
    state,
    send: (input) => {
      sent.push(input);
      return Promise.resolve(overrides.send ? overrides.send(input) : { kind: 'accepted', submissionId: input.submissionId, replayed: false });
    },
    submission: (query): SubmissionStatus => {
      submissionQueries.push(query.submissionId);
      return overrides.submissionStatus ?? { kind: 'accepted', ref: { kind: 'debug', id: query.submissionId } };
    },
    stop: () => { fake.stops += 1; turn = { kind: 'halted', failure: { code: 'stopped', message: '用户停止' } }; },
    retry: () => { fake.retries += 1; turn = { kind: 'idle' }; return Promise.resolve({ kind: 'cleared' }); },
    exitIntent: () => { fake.exitIntents += 1; },
    reading: createTranscriptReadingFixture({ coordinatorSessionId: SESSION }),
    inputStore: opened.store,
    subscribe: () => () => undefined,
    close: () => { fake.closes += 1; },
  };
  return { harness, sent, opens, submissionQueries, inputStore: opened.store, saves: provider.saves, counters: fake };
}

async function settle(ticks = 6): Promise<void> {
  for (let index = 0; index < ticks; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function typeText(rendered: { stdin: { write: (input: string) => void } }, text: string): Promise<void> {
  for (const character of text) {
    rendered.stdin.write(character);
    await settle(1);
  }
  await settle(2);
}

/** 恢复出来的草稿已经在 composer 里；输入 slash 前先按退格清行。 */
async function clearLine(rendered: Rendered): Promise<void> {
  for (let index = 0; index < 40; index += 1) {
    rendered.stdin.write('\u007f');
    await settle(1);
  }
}

type Rendered = ReturnType<typeof render>;

/** 进入对话：默认走“新建 → 选模型”，模型选择始终显式。 */
async function renderConversation(fake: FakeHarness, onExit = vi.fn()): Promise<{ rendered: Rendered; onExit: ReturnType<typeof vi.fn> }> {
  const rendered = render(createElement(DebugApp, { harness: fake.harness, terminalWidth: 100, onExit }));
  await settle();
  rendered.stdin.write('n');
  await settle();
  rendered.stdin.write('\r');
  await settle(6);
  return { rendered, onExit };
}

function frameText(rendered: Rendered): string {
  return rendered.lastFrame() ?? '';
}

function recordsOf(fake: FakeHarness) {
  const listed = fake.inputStore.list('debug-dir-1');
  return listed.kind === 'records' ? listed.records : [];
}

describe('tui/debug-app / 调试前台对话', () => {
  test('提交中的原快照立即显示，新草稿在受理后保留', async () => {
    let accept!: (result: DebugSendResult) => void;
    const fake = fakeHarness({ send: () => new Promise(resolve => { accept = resolve; }) });
    const { rendered } = await renderConversation(fake);
    await typeText(rendered, '原调试消息');
    rendered.stdin.write('\r');
    await settle(10);
    expect(frameText(rendered)).toContain('原调试消息');
    expect(recordsOf(fake).some(record => record.kind === 'draft')).toBe(false);
    await typeText(rendered, '后来草稿');
    await new Promise(resolve => setTimeout(resolve, 300));
    rendered.stdin.write('\r');
    await settle();
    expect(fake.sent).toHaveLength(1);
    accept({ kind: 'accepted', submissionId: fake.sent[0]!.submissionId, replayed: false });
    await settle(10);
    expect(recordsOf(fake).find(record => record.kind === 'draft')?.draft.text).toBe('后来草稿');
    expect(frameText(rendered)).toContain('后来草稿');
    rendered.unmount();
  });

  test('同批文字与 Enter 提交完整草稿，连续 Enter 采用并执行 slash 命令', async () => {
    const fake = fakeHarness();
    const { rendered } = await renderConversation(fake);
    rendered.stdin.write('你');
    rendered.stdin.write('好');
    rendered.stdin.write('\r');
    await settle(10);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.content).toBe('你好');
    rendered.stdin.write('/stop');
    rendered.stdin.write('\r');
    rendered.stdin.write('\r');
    await settle(10);
    expect(fake.counters.stops).toBe(1);
    expect(fake.sent).toHaveLength(1);
  });

  test('分离失败后晚到的 accepted 不按新 revision 补清：并发写入方的草稿仍在', async () => {
    let accept!: (result: DebugSendResult) => void;
    const fake = fakeHarness({ send: () => new Promise(resolve => { accept = resolve; }) });
    const base = fake.harness.inputStore;
    const target: UiInputTarget = { kind: 'debug-message', debugDirectoryId: 'debug-dir-1', coordinatorSessionId: SESSION };
    // 另一个窗口在提交快照落盘的同一时刻改写了同一目标的草稿：本次分离的 CAS 必然失配。
    const inputStore: UiInputStore = {
      read: (key) => base.read(key),
      list: (namespace) => base.list(namespace),
      remove: (input) => base.remove(input),
      write: (input) => {
        const written = base.write(input);
        if (written.kind === 'saved' && input.record.kind === 'submission') {
          const current = base.read(targetDraftKey(target));
          if (current.kind === 'record') {
            base.write({
              key: targetDraftKey(target), expectedRevision: current.revision,
              record: { kind: 'draft', target, draft: { text: '并发草稿', cursor: 4, pasteBlocks: [] } },
            });
          }
        }
        return written;
      },
    };
    const rendered = render(createElement(DebugApp, {
      harness: { ...fake.harness, inputStore }, terminalWidth: 100, onExit: vi.fn(),
    }));
    await settle();
    rendered.stdin.write('n'); await settle();
    rendered.stdin.write('\r'); await settle(6);
    rendered.stdin.write('\r'); await settle(6);

    await typeText(rendered, '原调试消息');
    await new Promise(resolve => setTimeout(resolve, 300));
    rendered.stdin.write('\r');
    await settle(10);
    expect(fake.sent).toHaveLength(1);
    accept({ kind: 'accepted', submissionId: fake.sent[0]!.submissionId, replayed: false });
    await settle(10);

    // 受理只结清自己的提交快照：分离失败的并发草稿原样留给显式恢复。
    expect(recordsOf(fake).find(record => record.kind === 'draft')?.draft.text).toBe('并发草稿');
    rendered.unmount();
  });
  test('核验已受理的未知提交释放等待位，Ctrl+P 打开可执行目录且保留草稿', async () => {
    let unknown = true;
    const fake = fakeHarness({ send: input => unknown
      ? { kind: 'unknown', submissionId: input.submissionId, reason: 'response lost' }
      : { kind: 'accepted', submissionId: input.submissionId, replayed: false } });
    const { rendered } = await renderConversation(fake);
    await typeText(rendered, 'original');
    rendered.stdin.write('\r');
    await settle(8);
    await clearLine(rendered);
    await typeText(rendered, '/inputs');
    rendered.stdin.write('\r'); await settle(4);
    rendered.stdin.write('\r'); await settle(6);
    for (let step = 0; step < 4 && fake.submissionQueries.length === 0; step += 1) {
      rendered.stdin.write('v'); await settle(6);
      if (fake.submissionQueries.length === 0) { rendered.stdin.write('\u001b[B'); await settle(2); }
    }
    expect(recordsOf(fake).filter(record => record.kind === 'submission')).toHaveLength(0);
    expect(fake.sent).toHaveLength(1);
    rendered.stdin.write('\u001b'); await new Promise(resolve => setTimeout(resolve, 40));
    await clearLine(rendered);
    await typeText(rendered, 'new');
    rendered.stdin.write('\u0010'); await settle(6);
    expect(frameText(rendered)).toContain('Command Palette');
    await typeText(rendered, 'retry');
    expect(frameText(rendered)).toContain('恢复停止轮次');
    expect(frameText(rendered)).not.toContain('输入记录');
    rendered.stdin.write('\u001b'); await new Promise(resolve => setTimeout(resolve, 40));
    unknown = false;
    rendered.stdin.write('\r'); await settle(8);
    expect(fake.sent).toHaveLength(2);
    expect(fake.sent[1]?.content).toBe('new');
  });
  test('Scenario: 显式选择会话与模型后才进入对话，载入过程不自动发送', async () => {
    const fake = fakeHarness();
    const rendered = render(createElement(DebugApp, { harness: fake.harness, terminalWidth: 100, onExit: vi.fn() }));
    await settle();
    expect(frameText(rendered)).toContain('新建或继续调试会话');

    rendered.stdin.write('\r');
    await settle(6);
    expect(frameText(rendered)).toContain('选择模型（会话固定该配置）');
    expect(fake.sent).toHaveLength(0);

    rendered.stdin.write('\r');
    await settle(6);
    expect(frameText(rendered)).toContain('调试 /tmp/debug-project');
    expect(fake.sent).toHaveLength(0);
  });

  test('Scenario: 打开被拒绝时给出结构化原因且不进入对话', async () => {
    const fake = fakeHarness();
    const rendered = render(createElement(DebugApp, { harness: fake.harness, terminalWidth: 100, onExit: vi.fn() }));
    await settle();
    rendered.stdin.write('n');
    await settle();
    rendered.stdin.write('\u001b[B');
    await settle(2);
    rendered.stdin.write('\r');
    await settle(6);
    expect(frameText(rendered)).toContain('model_unknown');
    expect(fake.sent).toHaveLength(0);
  });

  test('Scenario: 发送成功后草稿与提交快照都结清，transcript 进入对话视图', async () => {
    const fake = fakeHarness();
    const { rendered } = await renderConversation(fake);
    await typeText(rendered, 'hello');
    rendered.stdin.write('\r');
    await settle(8);

    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.content).toBe('hello');
    expect(recordsOf(fake)).toHaveLength(0);
  });

  test('Scenario: 结果未知时保留原输入与原提交身份，第二次发送被单活跃 lane 拒绝', async () => {
    const fake = fakeHarness({ send: () => ({ kind: 'unknown', submissionId: 'ignored', reason: 'transport_lost: 响应丢失' }) });
    const { rendered } = await renderConversation(fake);
    await typeText(rendered, 'keep-me');
    rendered.stdin.write('\r');
    await settle(8);

    expect(fake.sent).toHaveLength(1);
    const submissionId = fake.sent[0]?.submissionId ?? '';
    expect(frameText(rendered)).toContain('keep-me');
    expect(frameText(rendered)).toContain('unknown');

    rendered.stdin.write('\r');
    await settle(8);
    // 未核验前不再发起第二次调用；原输入与原身份都还在。
    expect(fake.sent).toHaveLength(1);
    const submission = recordsOf(fake).find((record) => record.kind === 'submission');
    expect(submission?.kind === 'submission' ? submission.submissionId : null).toBe(submissionId);
    expect(frameText(rendered)).toContain('keep-me');
  });

  test('Scenario: 恢复待核验提交只核验不自动重发，显式重发沿用原 submissionId', async () => {
    const fake = fakeHarness({ submissionStatus: { kind: 'not-found' }, send: () => ({ kind: 'unknown', submissionId: 'ignored', reason: 'transport_lost: 响应丢失' }) });
    const first = await renderConversation(fake);
    await typeText(first.rendered, 'retry-me');
    first.rendered.stdin.write('\r');
    await settle(8);
    const originalId = fake.sent[0]?.submissionId;
    first.rendered.unmount();

    // 重挂载：载入既有草稿与待核验提交都不得自动发送。
    const again = await renderConversation(fake);
    expect(fake.sent).toHaveLength(1);
    expect(frameText(again.rendered)).toContain('待核验提交');

    await clearLine(again.rendered);
    await typeText(again.rendered, '/inputs');
    again.rendered.stdin.write('\r');   // 采用候选
    await settle(4);
    again.rendered.stdin.write('\r');   // 执行 /inputs
    await settle(6);
    expect(frameText(again.rendered)).toContain('输入记录管理');
    // 逐条选中，直到恢复的是那条待核验提交：恢复只核验，不重发。
    for (let step = 0; step < 4 && fake.submissionQueries.length === 0; step += 1) {
      again.rendered.stdin.write('r');
      await settle(6);
      if (fake.submissionQueries.length === 0) {
        again.rendered.stdin.write('\u001b[B');
        await settle(2);
      }
    }
    expect(fake.sent).toHaveLength(1);
    expect(fake.submissionQueries).toEqual([originalId]);
    expect(frameText(again.rendered)).toContain('retry-me');

    // 单活跃 lane 仍被那条记录占着：显式删除后才能重发，身份仍是原 submissionId。
    again.rendered.stdin.write('d');
    await settle(3);
    again.rendered.stdin.write('y');
    await settle(6);
    expect(recordsOf(fake).filter((record) => record.kind === 'submission')).toHaveLength(0);

    again.rendered.stdin.write('\u001b');   // 关闭输入记录管理（Ink 会把单独 ESC 挂起再回放）
    await new Promise((resolve) => setTimeout(resolve, 40));
    await settle(3);
    again.rendered.stdin.write('\r');      // 显式重发
    await settle(8);
    expect(fake.sent).toHaveLength(2);
    expect(fake.sent[1]?.submissionId).toBe(originalId);
    expect(fake.sent[1]?.content).toBe('retry-me');
  });

  test('Scenario: 已停止的轮次仍落盘消息并显示恢复入口，模型恢复由宿主决定', async () => {
    const fake = fakeHarness({ turn: { kind: 'halted', failure: { code: 'execution_failed', message: '内部错误' } } });
    const blocked = await renderConversation(fake);
    expect(frameText(blocked.rendered)).toContain('已停止');

    await typeText(blocked.rendered, 'blocked');
    blocked.rendered.stdin.write('\r');
    await settle(8);
    // 界面不拦发送：草稿与提交都落盘，是否运行模型由宿主按轮次状态决定。
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.content).toBe('blocked');
    expect(frameText(blocked.rendered)).toContain('/retry');
    blocked.rendered.unmount();

    const controls = await renderConversation(fake);
    await typeText(controls.rendered, '/stop');
    controls.rendered.stdin.write('\r');   // 采用候选
    await settle(4);
    expect(fake.counters.stops).toBe(0);
    controls.rendered.stdin.write('\r');   // 执行
    await settle(6);
    expect(fake.counters.stops).toBe(1);

    await typeText(controls.rendered, '/retry');
    controls.rendered.stdin.write('\r');
    await settle(4);
    controls.rendered.stdin.write('\r');
    await settle(6);
    expect(fake.counters.retries).toBe(1);
  });

  test('Scenario: slash 候选先采用再执行——Enter 只填入命令，第二次 Enter 才执行', async () => {
    const fake = fakeHarness();
    const { rendered } = await renderConversation(fake);
    await typeText(rendered, '/stop');
    expect(frameText(rendered)).toContain('/stop');
    rendered.stdin.write('\r');
    await settle(4);
    expect(fake.counters.stops).toBe(0);

    rendered.stdin.write('\r');
    await settle(6);
    expect(fake.counters.stops).toBe(1);
  });

  test('Scenario: 未知 slash 命令只提示，不发送也不清空输入', async () => {
    const fake = fakeHarness();
    const { rendered } = await renderConversation(fake);
    await typeText(rendered, '/nope');
    rendered.stdin.write('\r');
    await settle(6);
    expect(frameText(rendered)).toContain('unknown_command');
    expect(fake.sent).toHaveLength(0);
    expect(frameText(rendered)).toContain('/nope');
  });

  test('Scenario: 多行正文与折叠粘贴都留在草稿里，Enter 才提交', async () => {
    const fake = fakeHarness();
    const { rendered } = await renderConversation(fake);
    await typeText(rendered, 'line-1');
    rendered.stdin.write('\u001b\r');
    await settle(2);
    await typeText(rendered, 'line-2');
    expect(fake.sent).toHaveLength(0);

    rendered.stdin.write('\r');
    await settle(8);
    expect(fake.sent[0]?.content).toContain('line-1');
    expect(fake.sent[0]?.content).toContain('line-2');
  });

  test('Scenario: Ctrl+C 先发出退出意图再退出前台', async () => {
    const fake = fakeHarness();
    const { rendered, onExit } = await renderConversation(fake);
    rendered.stdin.write('\u0003');
    await settle(6);
    expect(fake.counters.exitIntents).toBe(1);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  test('Scenario: 可继续既有会话，列表显示其固定模型', async () => {
    const fake = fakeHarness({ sessions: ['debug-session-0009'] });
    const rendered = render(createElement(DebugApp, { harness: fake.harness, terminalWidth: 100, onExit: vi.fn() }));
    await settle();
    expect(frameText(rendered)).toContain('debug-session-0000'.slice(0, 8));
    rendered.stdin.write('\u001b[B');
    await settle(2);
    rendered.stdin.write('\r');
    await settle(6);
    expect(frameText(rendered)).toContain('openai-chat · gpt-x');
  });

  test('Scenario: 空库按 p 打开共享编辑器，配置模型后仍须明确选择才打开会话', async () => {
    const fake = fakeHarness({ blank: true });
    const rendered = render(createElement(DebugApp, { harness: fake.harness, terminalWidth: 100, onExit: vi.fn() }));
    await settle();
    rendered.stdin.write('p');
    await settle();
    expect(frameText(rendered)).toContain('已保存 Provider 连接');

    // 空库：跳到「＋ 新建连接」→ 选 Provider → 填 key 并保存连接。
    rendered.stdin.write('\u001b[B'); await settle(2);
    rendered.stdin.write('\u001b[B'); await settle(2);
    rendered.stdin.write('\r'); await settle(4);
    rendered.stdin.write('\u001b[B'); await settle(2);
    rendered.stdin.write('\r'); await settle(4);
    rendered.stdin.write('\u001b[B'); await settle(2);
    rendered.stdin.write('\u001b[B'); await settle(2);
    await typeText(rendered, 'sk-fixture-key');
    // key 始终隐藏：保存前就已经是遮罩。
    expect(frameText(rendered)).not.toContain('sk-fixture-key');
    rendered.stdin.write('\r'); await settle(6);
    expect(fake.saves.connections).toHaveLength(1);
    expect(fake.saves.connections[0]).toMatchObject({ label: 'OpenAI', providerId: 'openai', providerIntegration: 'openai-chat', newSecret: 'sk-fixture-key' });

    rendered.stdin.write('\u001b[B'); await settle(2);
    rendered.stdin.write('\r'); await settle(6);
    expect(fake.saves.models).toEqual([{ expectedRevision: 1, connectionRef: 'conn-new', model: 'gpt-fixture' }]);

    // 有可信 effort 取值：先明确选 effort，再打开会话。
    rendered.stdin.write('\u001b[C'); await settle(2);
    rendered.stdin.write('\r'); await settle(2);
    rendered.stdin.write('\u001b[C'); await settle(2);
    rendered.stdin.write('\r'); await settle(6);
    expect(fake.opens).toHaveLength(0);
    expect(frameText(rendered)).toContain('选择模型（会话固定该配置）');
    rendered.stdin.write('\r'); await settle(6);
    expect(fake.opens).toEqual([{ kind: 'new', modelRef: 'model-new', effort: 'low' }]);
    expect(frameText(rendered)).toContain('调试 /tmp/debug-project');
    expect(fake.sent).toHaveLength(0);
  });

  test('Scenario: 空模型库时 Esc 退出配置不保存任何连接', async () => {
    const fake = fakeHarness({ blank: true });
    const rendered = render(createElement(DebugApp, { harness: fake.harness, terminalWidth: 100, onExit: vi.fn() }));
    await settle();
    rendered.stdin.write('p');
    await settle();
    rendered.stdin.write('\u001b');
    await new Promise((resolve) => setTimeout(resolve, 60));
    await settle(4);
    expect(fake.saves.connections).toHaveLength(0);
    expect(fake.opens).toHaveLength(0);
    expect(frameText(rendered)).toContain('新建或继续调试会话');
  });

  test('Scenario: capability failure refuses session and never starts a conversation loop', async () => {
    const fake = fakeHarness({ openRejected: true });
    const rendered = render(createElement(DebugApp, { harness: fake.harness, terminalWidth: 100, onExit: vi.fn() }));
    await settle();
    rendered.stdin.write('n'); await settle();
    rendered.stdin.write('\r'); await settle(6);
    expect(fake.opens).toEqual([{ kind: 'new', modelRef: 'model-a' }]);
    expect(fake.sent).toHaveLength(0);
    expect(frameText(rendered)).toContain('capability_missing');
  });
});
