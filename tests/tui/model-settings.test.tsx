/** Model settings user flows through the production TUI and fake ports. */

import { describe, expect, test } from 'vitest';
import { createElement } from 'react';

import {
  ModelSettingsEditor,
  SECRET_MASK,
  modelSettingsDraft,
} from '../../src/interfaces/tui/components/model-settings-editor.js';
import { MODEL_SETTINGS_FIELDS, type ModelSettingsEdit } from '../../src/interfaces/tui/state.js';
import type { ModelRoleView } from '../../src/interfaces/tui/ports.js';
import {
  chooseCommand,
  createFakePorts,
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

const coordinatorEdit: ModelSettingsEdit = {
  role: 'coordinator',
  label: 'Primary',
  providerIntegration: '@fixture/chat',
  model: 'coordinator-model',
  options: '',
  credentialKind: 'managed',
  credentialRef: '11111111-1111-4111-8111-111111111111',
  credentialOptionPath: 'apiKey',
  effortSource: '',
  effortValues: '',
  effortOptionPath: '',
  secret: '',
};

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

describe('Coordinator 模型设置', () => {
  test('编辑表单遮罩 key，保存输入保留 Coordinator 凭据合同', () => {
    const edit = { ...coordinatorEdit, secret: 'sk-never-render' };
    const frame = frameText(renderComponent(createElement(ModelSettingsEditor, {
      edit,
      field: 'secret',
      notice: null,
      failing: false,
      availableWidth: 100,
    })));
    expect(frame).toContain('API Key');
    expect(frame).toContain(SECRET_MASK);
    expect(frame).not.toContain('sk-never-render');

    const draft = modelSettingsDraft(edit, 12);
    expect(draft).toMatchObject({
      kind: 'ok',
      input: {
        role: 'coordinator',
        expectedRevision: 12,
        connection: {
          credential: {
            kind: 'managed',
            credentialRef: '11111111-1111-4111-8111-111111111111',
            optionPath: 'apiKey',
          },
        },
      },
    });
  });

  test('模型设置保存失败时编辑器仍可见，关闭后不再显示 key 遮罩', async () => {
    const fake = createFakePorts({
      modelSettings: {
        save: () => Promise.resolve({ kind: 'rejected', code: 'conflict', message: 'configuration changed' }),
      },
    });
    const rendered = renderTui(fake.ports);
    await settle();
    await chooseCommand(rendered, 'model-settings');
    for (let index = 0; index < MODEL_SETTINGS_FIELDS.length; index += 1) {
      if (/›\s+API Key/u.test(frameText(rendered))) break;
      await press(rendered, DOWN);
    }
    await press(rendered, 'sk-temporary');
    expect(frameText(rendered)).toContain(SECRET_MASK);
    expect(frameText(rendered)).not.toContain('sk-temporary');
    await press(rendered, ENTER);
    expect(frameText(rendered)).toContain('conflict');
    expect(fake.calls.find((call) => call.name === 'modelSettings.save')?.detail).toMatchObject({
      role: 'coordinator',
      newSecret: 'sk-temporary',
    });
    expect(frameText(rendered)).toContain(SECRET_MASK);
    await pressEscape(rendered);
    expect(frameText(rendered)).not.toContain(SECRET_MASK);
    rendered.unmount();
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
