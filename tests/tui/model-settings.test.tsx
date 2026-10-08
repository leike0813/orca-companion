/** Model settings user flows through the production TUI and fake ports. */

import { describe, expect, test, vi } from 'vitest';
import { createElement } from 'react';

import {
  ModelSettingsEditor,
  SECRET_MASK,
} from '../../src/interfaces/tui/components/model-settings-editor.js';
import { EMPTY_MODEL_SETTINGS_EDIT } from '../../src/interfaces/tui/state.js';
import type { ProviderConnection } from '../../src/domain/model-configuration.js';
import type { ModelSettingsPort } from '../../src/interfaces/tui/ports.js';
import type { ModelRoleView } from '../../src/interfaces/tui/ports.js';
import {
  chooseCommand,
  createFakePorts,
  FAKE_MODEL_SETTINGS_SNAPSHOT,
  frameText,
  makeAuthorizationReview,
  renderComponent,
  renderTui,
  settle,
  type RenderedTui,
} from './harness.js';

const ENTER = '\r';
const DOWN = '\u001b[B';
const RIGHT = '\u001b[C';
const ESC = '\u001b';
const CAPABILITY = { values: ['low', 'high'], source: 'native-catalog' };

async function press(rendered: RenderedTui, input: string): Promise<void> {
  rendered.stdin.write(input);
  await settle(3);
}

async function pressEscape(rendered: RenderedTui): Promise<void> {
  rendered.stdin.write(ESC);
  await new Promise<void>((resolve) => setTimeout(resolve, 60));
  await settle(4);
}

const connection: ProviderConnection = {
  connectionRef: 'connection-a', label: 'Primary', providerId: 'openai', providerIntegration: 'openai-chat',
  baseUrl: 'https://api.openai.com/v1', credential: { kind: 'managed', credentialRef: '11111111-1111-4111-8111-111111111111' },
};
const catalogModel = { id: 'gpt-test', label: 'GPT Test', providerId: 'openai', protocol: 'openai-chat' as const, effortCapability: null, contextWindow: null };
function providerPort(overrides: Partial<ModelSettingsPort> = {}): ModelSettingsPort {
  let revision = 1;
  const library: NonNullable<ModelSettingsPort['library']> = {
    load: () => ({ kind: 'loaded', revision, connections: [connection], models: [] }),
    saveConnection: (input) => Promise.resolve({ kind: 'saved', revision: ++revision, connection: { ...connection, label: input.label } }),
    saveModel: (input) => ({ kind: 'saved', revision: ++revision, model: { modelRef: 'model-ref-a', connectionRef: input.connectionRef, model: input.model, effortCapability: null } }),
    resolveModel: () => ({ kind: 'rejected', code: 'missing', message: 'missing' }),
  };
  const catalog: NonNullable<ModelSettingsPort['catalog']> = {
    presets: () => [{ id: 'openai', label: 'OpenAI', protocol: 'openai-chat', baseUrl: 'https://api.openai.com/v1', discovery: true }],
    candidates: () => ({ models: [catalogModel], source: 'catalog', catalogVersion: 'fixture', expired: false }),
    discover: () => Promise.resolve({ models: [catalogModel], source: 'discovery', catalogVersion: 'fixture', expired: false }),
    refresh: () => Promise.resolve({ kind: 'unchanged', catalogVersion: 'fixture' }),
  };
  return { load: () => Promise.resolve({ kind: 'failed', code: 'config_absent', message: 'missing project' }), save: () => Promise.resolve({ kind: 'saved', revision: 2, configurationRef: 'configuration-a', profileRef: null }), apply: () => Promise.resolve({ kind: 'saved', revision: 2, configurationRef: 'configuration-a', profileRef: null }), library, catalog, ...overrides };
}

const PLANNER: ModelRoleView = {
  role: 'planner',
  label: 'Planner',
  group: 'execution',
  current: null,
  candidates: [],
  availability: { available: true, reason: null },
};

async function openPlannerMenu(rendered: RenderedTui): Promise<void> {
  await chooseCommand(rendered, 'model-picker');
  await press(rendered, DOWN);
  await press(rendered, DOWN);
  await press(rendered, 'e');
  await settle(4);
}

describe('Coordinator Provider library', () => {
  test('连接编辑隐藏 API key，并且不展示 SDK module/JSON/auth/path 字段', () => {
    const edit = { ...EMPTY_MODEL_SETTINGS_EDIT, stage: 'connection' as const, connectionRef: connection.connectionRef, credentialRef: connection.credential.credentialRef, providerId: 'openai', providerIntegration: 'openai-chat' as const, label: 'Primary', baseUrl: connection.baseUrl, secret: 'sk-never-render' };
    const frame = frameText(renderComponent(createElement(ModelSettingsEditor, {
      edit,
      notice: null,
      failing: false,
      availableWidth: 100,
    })));
    expect(frame).toContain('API Key');
    expect(frame).toContain(SECRET_MASK);
    expect(frame).not.toContain('sk-never-render');
    expect(frame).not.toMatch(/module|options JSON|auth type|optionPath/iu);
  });

  test('Home 可保存共享模型并显式初始化项目；缺少配置不会阻塞 library', async () => {
    const modelSettings = providerPort({ initializeProject: (input) => Promise.resolve({ kind: 'saved', revision: 1, configurationRef: `config-${input.routeMapIssueNumber}`, profileRef: null }) });
    const fake = createFakePorts({ modelSettings, home: { kind: 'wizard' } });
    const rendered = renderTui(fake.ports);
    await settle();
    await press(rendered, 'p');
    await settle(5);
    expect(frameText(rendered)).toContain('Primary');
    await press(rendered, ENTER); // select existing connection without re-entering its key
    expect(frameText(rendered)).toContain('GPT Test');
    await press(rendered, DOWN);
    await press(rendered, DOWN); // manual exact ID row
    await press(rendered, 'custom/model-v1');
    await press(rendered, DOWN);
    await press(rendered, ENTER);
    expect(frameText(rendered)).toContain('初始化项目配置');
    await press(rendered, DOWN); // initialize row
    await press(rendered, ENTER);
    await press(rendered, '42');
    await press(rendered, ENTER);
    expect(fake.calls.some((call) => call.name === 'modelSettings.load')).toBe(false);
    expect(frameText(rendered)).not.toContain('sk-');
    rendered.unmount();
  });

  test('连接保存的迟到成功保留新编辑，下一次保存使用新的库 revision', async () => {
    const settings = providerPort();
    const library = settings.library!;
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof library.saveConnection>>>();
    let revision = 1;
    const saveConnection = vi.fn<typeof library.saveConnection>(() => pending.promise);
    const fake = createFakePorts({ home: { kind: 'wizard' }, modelSettings: {
      ...settings, library: { ...library, load: () => ({ kind: 'loaded', revision, connections: [connection], models: [] }), saveConnection },
    } });
    const rendered = renderTui(fake.ports);
    try {
      await settle();
      await press(rendered, 'p');
      await press(rendered, DOWN);
      await press(rendered, ENTER); // edit the saved connection
      await press(rendered, ENTER); // save while retaining its key
      expect(saveConnection).toHaveBeenCalledTimes(1);
      await press(rendered, '-new-edit');
      revision = 2;
      pending.resolve({ kind: 'saved', revision, connection });
      await settle(5);
      expect(frameText(rendered)).toContain('Primary-new-edit');
      await press(rendered, ENTER);
      expect(saveConnection.mock.calls.at(-1)?.[0]).toMatchObject({ label: 'Primary-new-edit', expectedRevision: 2 });
    } finally { rendered.unmount(); }
  });

  test.each(['saved', 'rejected', 'throw'] as const)('项目模型保存 %s 时仍保留等待期间的新输入', async (outcome) => {
    const pending = Promise.withResolvers<Awaited<ReturnType<ModelSettingsPort['save']>>>();
    const save = vi.fn(() => pending.promise);
    const fake = createFakePorts({ modelSettings: providerPort({
      load: () => Promise.resolve({ kind: 'loaded', snapshot: { ...FAKE_MODEL_SETTINGS_SNAPSHOT, roles: [], connections: [connection] } }),
      save,
    }) });
    const rendered = renderTui(fake.ports);
    try {
      await settle();
      await chooseCommand(rendered, 'model-settings');
      await press(rendered, ENTER);
      await press(rendered, DOWN);
      await press(rendered, ENTER); // save the catalog model
      expect(save).toHaveBeenCalledTimes(1);
      await press(rendered, 'new/model');
      if (outcome === 'throw') pending.reject(new Error('offline'));
      else pending.resolve(outcome === 'saved'
        ? { kind: 'saved', revision: 8, configurationRef: 'configuration-a', profileRef: null }
        : { kind: 'rejected', code: 'conflict', message: 'conflict' });
      await settle(5);
      expect(frameText(rendered)).toContain('new/model');
      expect(fake.calls.some(call => call.name === 'modelSettings.apply')).toBe(false);
    } finally { rendered.unmount(); }
  });

  test('项目初始化的迟到成功保留后来编辑的 issue number', async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<ModelSettingsPort['save']>>>();
    const initializeProject = vi.fn(() => pending.promise);
    const fake = createFakePorts({ home: { kind: 'wizard' }, modelSettings: providerPort({ initializeProject }) });
    const rendered = renderTui(fake.ports);
    try {
      await settle();
      await press(rendered, 'p');
      await press(rendered, ENTER);
      await press(rendered, DOWN);
      await press(rendered, ENTER); // save a model in the user library
      await press(rendered, DOWN);
      await press(rendered, DOWN);
      await press(rendered, DOWN);
      await press(rendered, ENTER); // initialize project
      await press(rendered, '42');
      await press(rendered, ENTER);
      expect(initializeProject).toHaveBeenCalledTimes(1);
      await press(rendered, '1');
      pending.resolve({ kind: 'saved', revision: 1, configurationRef: 'configuration-a', profileRef: null });
      await settle(5);
      expect(frameText(rendered)).toContain('421');
    } finally { rendered.unmount(); }
  });
});

describe('Worker 原生模型目录', () => {
  test('切换 harness 会取消旧查询；目录候选以可信来源应用并进入授权审阅', async () => {
    let codexSignal: AbortSignal | undefined;
    const fake = createFakePorts({
      modelCatalog: {
        roles: [PLANNER],
        configurationRevision: 9,
      },
      workerModels: ({ harness, signal }) => {
        if (harness === 'codex') {
          codexSignal = signal;
          return new Promise(() => undefined);
        }
        return Promise.resolve({
          kind: 'available',
          source: 'claude:list_models',
          models: [{ model: 'claude-sonnet', effortCapability: CAPABILITY }],
        });
      },
      modelSettings: {},
      authorizationReview: makeAuthorizationReview(),
    });
    const rendered = renderTui(fake.ports);
    await settle();
    await openPlannerMenu(rendered);
    expect(fake.calls.filter((call) => call.name === 'modelCatalog.queryWorkerModels').map((call) => call.detail))
      .toContain('codex');

    await press(rendered, RIGHT);
    await settle(5);
    expect(codexSignal?.aborted).toBe(true);
    expect(frameText(rendered)).toContain('claude-sonnet');

    await press(rendered, ENTER); // harness -> model list
    await press(rendered, '\t'); // effort
    await press(rendered, RIGHT); // choose a supported effort
    await press(rendered, '\t'); // actions
    await press(rendered, RIGHT); // apply
    await press(rendered, ENTER);
    await settle(8);

    expect(fake.calls.find((call) => call.name === 'modelSettings.apply')?.detail).toMatchObject({
      role: 'planner',
      harness: 'claude',
      expectedRevision: 9,
      modelSelection: {
        model: 'claude-sonnet',
        effort: 'low',
        effortCapability: CAPABILITY,
        catalogSource: 'claude:list_models',
      },
    });
    expect(frameText(rendered)).toContain('Execution Authorization Review');
    rendered.unmount();
  });

  test('目录不可用时可手填 exact ID，且不生成 effort 或来源', async () => {
    const fake = createFakePorts({
      modelCatalog: { roles: [PLANNER], configurationRevision: 4 },
      workerModels: () => Promise.resolve({ kind: 'unavailable', code: 'catalog_unavailable', message: 'offline' }),
      modelSettings: {},
      authorizationReview: makeAuthorizationReview(),
    });
    const rendered = renderTui(fake.ports);
    await settle();
    await openPlannerMenu(rendered);
    await settle(4);
    await press(rendered, ENTER);
    await press(rendered, 'vendor/exact-model-id');
    await press(rendered, ENTER); // move to actions
    await press(rendered, RIGHT); // apply
    await press(rendered, ENTER);
    await settle(8);

    expect(fake.calls.find((call) => call.name === 'modelSettings.apply')?.detail).toMatchObject({
      role: 'planner',
      harness: 'codex',
      modelSelection: {
        model: 'vendor/exact-model-id',
        effort: null,
        effortCapability: null,
        catalogSource: null,
      },
    });
    rendered.unmount();
  });

  test('关菜单后中止查询，迟到候选不进入后续菜单', async () => {
    let signal: AbortSignal | undefined;
    let release: ((value: { kind: 'available'; source: string; models: { model: string; effortCapability: null }[] }) => void) | undefined;
    const fake = createFakePorts({
      modelCatalog: { roles: [PLANNER], configurationRevision: 2 },
      modelSettings: {},
      workerModels: ({ signal: querySignal }) => {
        signal = querySignal;
        return new Promise((resolve) => { release = resolve; });
      },
    });
    const rendered = renderTui(fake.ports);
    await settle();
    await openPlannerMenu(rendered);
    expect(fake.calls.filter((call) => call.name === 'modelCatalog.queryWorkerModels'), frameText(rendered)).toHaveLength(1);
    await pressEscape(rendered);
    expect(signal?.aborted).toBe(true);
    release?.({ kind: 'available', source: 'late', models: [{ model: 'late-model', effortCapability: null }] });
    await settle(6);
    expect(frameText(rendered)).not.toContain('late-model');
    await press(rendered, 'e');
    await settle(4);
    rendered.unmount();
    expect(signal?.aborted).toBe(true);
  });
});
