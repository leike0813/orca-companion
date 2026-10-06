/**
 * 角色模型选择、独立 effort 与连接编辑（IP-06，tui/planning-workspace 前三个场景）。
 *
 * 断言可观察行为：分区与不可用原因、候选按 provider/model 去重、effort 只来自可信能力来源、
 * 默认动作为返回、保存与应用分离、Worker 角色必须经过完整 Manifest 审阅，以及 key 遮罩与
 * 关闭/保存后的内存擦除。不断言整屏 snapshot 或内部调用顺序。
 */

import { describe, expect, test } from 'vitest';
import { createElement } from 'react';

import {
  ModelPicker,
  RoleModelMenu,
  dedupeRoleCandidates,
  effortValues,
  effortWindow,
  modelRoleAdmission,
  modelRoleSummary,
  modelRoles,
} from '../../src/interfaces/tui/components/model-picker.js';
import {
  ModelSettingsEditor,
  SECRET_MASK,
  editModelSettingsField,
  formatModelOptions,
  modelSettingsDraft,
  parseModelOptions,
  visibleModelSettingsFields,
} from '../../src/interfaces/tui/components/model-settings-editor.js';
import { MODEL_SETTINGS_FIELDS, type ModelRoleMenuState, type ModelSettingsEdit } from '../../src/interfaces/tui/state.js';
import { displayWidth, truncateToDisplayWidth } from '../../src/interfaces/tui/render/width.js';
import type { ModelCatalog, ModelRoleView, ModelSettingsSnapshotView } from '../../src/interfaces/tui/ports.js';
import {
  FAKE_MODEL_SETTINGS_SNAPSHOT,
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
const LEFT = '\u001b[D';
const TAB = '\t';
const ESC = '\u001b';

async function press(rendered: RenderedTui, input: string): Promise<void> {
  rendered.stdin.write(input);
  await settle(2);
}

/** 裸 ESC 不会被 PTY 立即解析成完整按键，退回路径需要比普通按键多一次事件循环。 */
async function pressEscape(rendered: RenderedTui): Promise<void> {
  rendered.stdin.write(ESC);
  await new Promise<void>((resolve) => setTimeout(resolve, 60));
  await settle(4);
}

const CAPABILITY = {
  values: ['low', 'medium', 'high'],
  source: 'fixture:capability-a',
  optionPath: 'modelReasoningEffort',
};

function role(overrides: Partial<ModelRoleView> = {}): ModelRoleView {
  return {
    role: 'planner',
    label: 'Planner',
    group: 'execution',
    current: { candidateRef: 'model-a', provider: 'openai', model: 'A', effort: 'high' },
    candidates: [{ candidateRef: 'model-a', connectionRef: 'connection-a', provider: 'openai', model: 'A', effortCapability: CAPABILITY }],
    availability: { available: true, reason: null },
    ...overrides,
  };
}

const COORDINATOR = role({
  role: 'coordinator',
  label: 'Coordinator',
  group: 'current',
  current: { candidateRef: 'config-a', provider: 'openai', model: 'A', effort: 'high' },
  candidates: [{ candidateRef: 'config-a', connectionRef: 'connection-a', provider: 'openai', model: 'A', effortCapability: CAPABILITY }],
});

const CATALOG: ModelCatalog = {
  options: [{ configurationRef: 'config-a', model: 'A', provider: 'openai', effortCapability: CAPABILITY }],
  currentConfigurationRef: 'config-a',
  switchable: true,
  switchBlockReason: null,
  configurationRevision: 7,
  roles: [
    COORDINATOR,
    { role: 'planning_utility', label: 'Utility', group: 'planning', current: null, candidates: [], availability: { available: false, reason: '规划 Utility 没有生产生命周期' } },
    role(),
    { role: 'specification_validator', label: 'Spec Validator', group: 'execution', current: null, candidates: [], availability: { available: false, reason: 'Specification Validator 没有生产生命周期' } },
  ],
};

function renderPicker(catalog: ModelCatalog = CATALOG): string {
  return frameText(renderComponent(
    createElement(ModelPicker, { catalog, rejection: null, onOpenRole: () => undefined, availableWidth: 110, rows: 20 }),
  ));
}

function renderMenu(view: ModelRoleView, menu: ModelRoleMenuState, rows = 24, availableWidth = 110): string {
  return frameText(renderComponent(
    createElement(RoleModelMenu, {
      role: view,
      menu,
      query: '',
      admissionReason: null,
      notice: null,
      onAction: () => undefined,
      availableWidth,
      rows,
    }),
  ));
}

describe('角色模型配置页', () => {
  test('按定稿三区列出角色，未实现角色显示原因而不是被隐藏', () => {
    const frame = renderPicker();
    expect(frame).toContain('Model Picker · 模型配置');
    expect(frame).toContain('当前会话');
    expect(frame).toContain('Planning · 路线规划');
    expect(frame).toContain('Execution · 执行协调');
    expect(frame).toContain('openai / A / high');
    expect(frame).toContain('Spec Validator');
    const unavailable = modelRoles(CATALOG).find((entry) => entry.role === 'specification_validator');
    expect(modelRoleAdmission(unavailable as ModelRoleView, CATALOG).reason).toBe(
      'Specification Validator 没有生产生命周期',
    );
  });

  test('宿主未提供 roles 时仍按定稿顺序列出全部角色，其余明确不可用', () => {
    const roles = modelRoles({
      options: [{ configurationRef: 'config-a', model: 'A' }],
      currentConfigurationRef: 'config-a',
      switchable: true,
      switchBlockReason: null,
    });
    expect(roles.map((entry) => entry.role)).toEqual([
      'coordinator',
      'planning_utility',
      'planner',
      'specification_validator',
      'implementation',
      'validator',
      'finalizer',
      'recovery_utility',
    ]);
    expect(roles[0]?.availability.available).toBe(true);
    expect(roles[1]?.availability.reason).toBe('角色模型配置尚未接通');
  });

  test('effort 为 null 时区分「未设置」与「不支持」', () => {
    const supported = role({
      current: { candidateRef: 'model-a', provider: 'openai', model: 'A', effort: null },
    });
    expect(modelRoleSummary(supported)).toBe('openai / A / 未设置 effort');
    const unsupported = role({
      current: { candidateRef: 'model-d', provider: 'example', model: 'D', effort: null },
      candidates: [{ candidateRef: 'model-d', connectionRef: 'c1', provider: 'example', model: 'D', effortCapability: null }],
    });
    expect(modelRoleSummary(unsupported)).toBe('example / D / 不支持 effort');
  });

  test('同一 provider/model 只出现一条候选，effort 不复制候选', () => {
    const duplicated = role({
      candidates: [
        { candidateRef: 'model-a', connectionRef: 'c1', provider: 'openai', model: 'A', effortCapability: CAPABILITY },
        { candidateRef: 'model-a-2', connectionRef: 'c1', provider: 'openai', model: 'A', effortCapability: CAPABILITY },
        { candidateRef: 'model-b', connectionRef: 'c1', provider: 'openai', model: 'B', effortCapability: null },
      ],
    });
    expect(dedupeRoleCandidates(duplicated.candidates).map((candidate) => candidate.model)).toEqual(['A', 'B']);
    expect(dedupeRoleCandidates(duplicated.candidates)[0]?.candidateRef).toBe('model-a-2');
    const frame = renderMenu(duplicated, {
      role: 'planner',
      selectedCandidateRef: 'model-a',
      focus: 'effort',
      action: 0,
      effort: 'high',
    });
    expect(frame.match(/openai \/ A/gu)?.length).toBe(1);
    expect(frame).toContain('[low]');
    expect(frame).toContain('[high]');
    expect(frame).toContain('fixture:capability-a');
    expect(frame).toContain('当前区域：Effort · high');
  });

  test('没有可信能力来源的候选按 effort 不适用保存，而不是伪造 effort', () => {
    const withoutCapability = role({
      current: null,
      candidates: [{ candidateRef: 'model-d', connectionRef: 'c1', provider: 'example', model: 'D', effortCapability: null }],
    });
    expect(effortValues(withoutCapability.candidates[0] ?? null)).toEqual([]);
    const frame = renderMenu(withoutCapability, {
      role: 'planner',
      selectedCandidateRef: 'model-d',
      focus: 'list',
      action: 0,
      effort: null,
    });
    expect(frame).toContain('不适用');
    expect(frame).toContain('当前区域：模型列表 · effort 不适用');
    // 没有可信来源时 effort 恒为 null，这是领域允许的取值，因此应用入口保持可用。
    expect(frame).toContain('应用选择');
    expect(frame).not.toContain('[low]');
  });

  test('有可信能力来源但尚未选择 effort 时不允许应用', () => {
    const frame = renderMenu(role(), {
      role: 'planner',
      selectedCandidateRef: 'model-a',
      focus: 'list',
      action: 1,
      effort: null,
    });
    expect(frame).toContain('请选择该模型支持的 effort');
    expect(frame).toContain('当前不可确认');
  });

  test('动作行默认停在返回', () => {
    const frame = renderMenu(role(), {
      role: 'planner',
      selectedCandidateRef: 'model-a',
      focus: 'actions',
      action: 0,
      effort: 'high',
    });
    expect(frame).toContain('当前区域：操作按钮 · 返回');
  });

  test('16 个长取值在 50 列仍是单行，且选中值可见', () => {
    const longValues = Array.from(
      { length: 16 },
      (_, index) => 'effort-level-' + String(index).padStart(2, '0'),
    );
    const many = role({
      current: null,
      candidates: [
        {
          candidateRef: 'model-many',
          connectionRef: 'c1',
          provider: 'example',
          model: 'Many',
          effortCapability: {
            values: longValues,
            source: 'a-very-long-capability-source-name',
            optionPath: 'effort',
          },
        },
      ],
    });
    const window = effortWindow(longValues, longValues[12] ?? null, 42, true);
    expect(window.values).toContain(longValues[12]);
    const chipWidth = window.values.reduce(
      (sum, value) => sum + displayWidth(' [' + truncateToDisplayWidth(value, window.labelWidth) + '] '),
      0,
    );
    expect(chipWidth + 7).toBeLessThanOrEqual(42);
    const frame = renderMenu(
      many,
      { role: 'planner', selectedCandidateRef: 'model-many', focus: 'effort', action: 0, effort: longValues[12] ?? null },
      33,
      50,
   );
    // 只数 effort 取值行：区域提示行有 Effort 但无 chip，动作行有 chip 但无 Effort。
    const chipLines = frame
      .split(String.fromCharCode(10))
      .filter((line) => line.includes('Effort') && line.includes('] '));
    expect(chipLines).toHaveLength(1);
    expect(frame).toContain('当前区域：Effort · ' + (longValues[12] ?? ''));
  });
});

const baseEdit: ModelSettingsEdit = {
  role: 'coordinator',
  label: '主连接',
  providerIntegration: 'openai',
  model: 'model-a',
  options: '',
  codexProviderId: '',
  codexBaseUrl: '',
  codexWireApi: '',
  credentialKind: 'harness_login',
  credentialRef: '',
  credentialOptionPath: '',
  effortSource: '',
  effortValues: '',
  effortOptionPath: '',
  secret: '',
};

const editWith = (overrides: Partial<ModelSettingsEdit>): ModelSettingsEdit => ({ ...baseEdit, ...overrides });

describe('连接编辑', () => {
  test('非秘密选项按行解析并可往返', () => {
    const parsed = parseModelOptions('# 注释\nmaxTokens = 2000\nname = "示例"\nempty = ""');
    expect(parsed).toEqual({ kind: 'ok', options: {
      maxTokens: 2000,
      name: '示例',
      empty: '',
    } });
    expect(parseModelOptions(formatModelOptions({ maxTokens: 2000, name: '示例' }))).toEqual({ kind: 'ok', options: {
      maxTokens: 2000,
      name: '示例',
    } });
  });

  test('字符串往返后仍是字符串，不会被读成数字', () => {
    const text = formatModelOptions({ port: '123', flag: 'true' });
    const parsed = parseModelOptions(text);
    expect(parsed.kind).toBe('ok');
    if (parsed.kind === 'ok') {
      expect(parsed.options).toEqual({ port: '123', flag: 'true' });
      expect(typeof parsed.options.port).toBe('string');
    }
  });

  test('无法解析的选项行被结构化拒绝，而不是静默丢弃', () => {
    const draft = modelSettingsDraft(editWith({ options: 'maxTokens = 2000\n这不是选项' }), 7);
    expect(draft.kind).toBe('invalid');
    if (draft.kind === 'invalid') {
      expect(draft.field).toBe('options');
      expect(draft.message).toContain('第 2 行');
    }
    const unquoted = modelSettingsDraft(editWith({ options: 'name = 示例' }), 7);
    expect(unquoted.kind).toBe('invalid');
  });

  test('effort 能力必须三项齐全，缺一不可保存', () => {
    const partial = modelSettingsDraft(editWith({ effortSource: 'fixture:capability-a' }), 7);
    expect(partial.kind).toBe('invalid');
    if (partial.kind === 'invalid') {
      expect(partial.field).toBe('effortSource');
    }
    const duplicated = modelSettingsDraft(
      editWith({ effortSource: 'fixture:capability-a', effortValues: 'low,low', effortOptionPath: 'modelReasoningEffort' }),
      7,
    );
    expect(duplicated.kind).toBe('invalid');
  });

  test('完整的连接候选按应用层合同提交，秘密只走 newSecret', () => {
    const draft = modelSettingsDraft(
      editWith({
        codexProviderId: 'openai',
        codexBaseUrl: 'https://api.openai.com/v1',
        codexWireApi: 'responses',
        credentialKind: 'managed',
        credentialRef: '11111111-1111-4111-8111-111111111111',
        credentialOptionPath: 'apiKey',
        effortSource: 'fixture:capability-a',
        effortValues: 'low, medium, high',
        effortOptionPath: 'modelReasoningEffort',
        options: 'maxTokens = 2000',
        secret: 'sk-example',
      }),
      7,
    );
    expect(draft.kind).toBe('ok');
    if (draft.kind !== 'ok') {
      return;
    }
    expect(draft.input.expectedRevision).toBe(7);
    expect(draft.input.connection.codex).toEqual({
      providerId: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      wireApi: 'responses',
    });
    expect(draft.input.connection.credential).toEqual({
      kind: 'managed',
      credentialRef: '11111111-1111-4111-8111-111111111111',
      optionPath: 'apiKey',
    });
    expect(draft.input.effortCapability).toEqual(CAPABILITY);
    expect(draft.input.modelOptions).toEqual({ maxTokens: 2000 });
    expect(draft.input.newSecret).toBe('sk-example');
  });

  test('codex 三项必须一致，缺一即拒绝而不是静默丢弃', () => {
    expect(modelSettingsDraft(editWith({ codexWireApi: 'responses' }), 7).kind).toBe('invalid');
    expect(modelSettingsDraft(editWith({ codexProviderId: 'openai' }), 7).kind).toBe('invalid');
  });

  test('managed 凭据必须指明 SDK 字段路径', () => {
    const draft = modelSettingsDraft(
      editWith({ credentialKind: 'managed', credentialRef: '11111111-1111-4111-8111-111111111111' }),
      7,
    );
    expect(draft.kind).toBe('invalid');
    if (draft.kind === 'invalid') {
      expect(draft.field).toBe('credentialOptionPath');
    }
  });

  test('选项区用 Shift+Enter 换行，Enter 仍然直接保存', () => {
    const shifted = { return: true, shift: true, meta: false } as never;
    const next = editModelSettingsField(editWith({ options: 'a = 1' }), 'options', '', shifted);
    expect(next.options).toBe('a = 1' + String.fromCharCode(10));
    // 普通 Enter 不插入换行——它由容器转成交给保存用例。
    const plain = editModelSettingsField(editWith({ options: 'a = 1' }), 'options', '', {
      return: true,
      shift: false,
      meta: false,
    } as never);
    expect(plain.options).toBe('a = 1');
  });

  test('没有生产生命周期的角色不能保存配置', () => {
    const draft = modelSettingsDraft(editWith({ role: 'planning_utility' }), 7);
    expect(draft.kind).toBe('invalid');
    if (draft.kind === 'invalid') {
      expect(draft.message).toContain('没有生产生命周期');
    }
  });

  test('编辑器字段覆盖完整 provider 连接，key 字段始终遮罩', () => {
    for (const field of [
      'codexProviderId',
      'codexBaseUrl',
      'codexWireApi',
      'credentialKind',
      'credentialOptionPath',
      'effortSource',
      'effortValues',
      'effortOptionPath',
    ]) {
      expect(MODEL_SETTINGS_FIELDS).toContain(field);
    }
    expect(SECRET_MASK).not.toMatch(/[A-Za-z0-9]/u);
  });

  test('Harness 登录隐藏 key 字段，managed 保留 13 个字段；切回登录立即清除内存 key', () => {
    expect(visibleModelSettingsFields('harness_login')).toHaveLength(12);
    expect(visibleModelSettingsFields('harness_login')).not.toContain('secret');
    expect(visibleModelSettingsFields('managed')).toHaveLength(13);
    expect(visibleModelSettingsFields('managed')).toContain('secret');

    const toManaged = editModelSettingsField(editWith({ credentialKind: 'harness_login' }), 'credentialKind', '', {
      leftArrow: false,
      rightArrow: true,
    } as never);
    expect(toManaged.credentialKind).toBe('managed');
    const withSecret = { ...toManaged, secret: 'sk-temporary' };
    const toHarnessLogin = editModelSettingsField(withSecret, 'credentialKind', '', {
      leftArrow: true,
      rightArrow: false,
    } as never);
    expect(toHarnessLogin.credentialKind).toBe('harness_login');
    expect(toHarnessLogin.secret).toBe('');
  });

  test('编辑器按凭据来源显示字段，managed key 只显示固定遮罩', () => {
    const harnessLogin = frameText(renderComponent(createElement(ModelSettingsEditor, {
      edit: editWith({ credentialKind: 'harness_login', secret: 'sk-never-render' }),
      field: 'label',
      notice: null,
      failing: false,
      availableWidth: 100,
    })));
    expect(harnessLogin).toContain('Harness 提供');
    expect(harnessLogin).not.toMatch(/│\s+›\s+API Key/u);
    expect(harnessLogin).not.toContain('sk-never-render');

    const managed = frameText(renderComponent(createElement(ModelSettingsEditor, {
      edit: editWith({ credentialKind: 'managed', secret: 'sk-never-render' }),
      field: 'secret',
      notice: null,
      failing: false,
      availableWidth: 100,
    })));
    expect(managed).toContain('API Key');
    expect(managed).toContain(SECRET_MASK);
    expect(managed).not.toContain('sk-never-render');
  });
});

const APPLY_ROLES: readonly ModelRoleView[] = [COORDINATOR, role()];

const APPLY_CATALOG: ModelCatalog = {
  ...CATALOG,
  roles: APPLY_ROLES,
};

function fakeCatalogOptions() {
  return {
    roles: APPLY_ROLES,
    options: APPLY_CATALOG.options,
    currentConfigurationRef: 'config-a',
    configurationRevision: 7,
  };
}

/** 走到 API Key 字段并输入一串可识别的假 key。可见字段随角色与 harness 变化，按激活标记定位。 */
async function typeSecret(rendered: RenderedTui, secret: string): Promise<void> {
  for (let index = 0; index < MODEL_SETTINGS_FIELDS.length; index += 1) {
    if (/›\s+API Key/u.test(frameText(rendered))) {
      break;
    }
    await press(rendered, DOWN);
  }
  await press(rendered, secret);
}

describe('保存与应用分离', () => {
  test('保存只追加不可变记录，不代表应用', async () => {
    const fake = createFakePorts({ modelCatalog: fakeCatalogOptions(), modelSettings: {} });
    const rendered = renderTui(fake.ports);
    await settle();
    await chooseCommand(rendered, 'model-settings');
    await settle();
    expect(frameText(rendered)).toContain('模型连接设置');
    await press(rendered, ENTER);
    await settle(4);

    expect(fake.calls.filter((call) => call.name === 'modelSettings.save')).toHaveLength(1);
    // 保存本身既不切换 Coordinator，也不打开授权审阅。
    expect(fake.executeIntents.filter((intent) => intent.kind === 'switch-model-configuration')).toHaveLength(0);
    expect(fake.calls.filter((call) => call.name === 'executionAuthorization.review')).toHaveLength(0);
    // 编辑器逐层关闭，并在工作区提示「尚未应用」——保存不等于应用。
    expect(frameText(rendered)).not.toContain('目标角色：');
    expect(frameText(rendered)).toContain('尚未应用');
    rendered.unmount();
  });

  test('保存失败保留编辑并显示结构化原因', async () => {
    const fake = createFakePorts({
      modelCatalog: fakeCatalogOptions(),
      modelSettings: {
        save: () => Promise.resolve({ kind: 'rejected', code: 'conflict', message: '项目配置已被其他编辑修改' }),
      },
    });
    const rendered = renderTui(fake.ports);
    await settle();
    await chooseCommand(rendered, 'model-settings');
    await settle();
    await press(rendered, ENTER);
    await settle(4);

    const frame = frameText(rendered);
    expect(frame).toContain('模型连接设置');
    expect(frame).toContain('conflict');
    rendered.unmount();
  });

  test('Worker 角色应用后打开完整 Manifest 审阅，不自动批准', async () => {
    const planner = role();
    const latestPlanner = {
      ...planner,
      candidates: [
        ...planner.candidates,
        { ...planner.candidates[0]!, candidateRef: 'model-a-latest', connectionRef: 'new-connection' },
      ],
    };
    const fake = createFakePorts({
      modelCatalog: { ...fakeCatalogOptions(), roles: [COORDINATOR, latestPlanner] },
      modelSettings: {},
      authorizationReview: makeAuthorizationReview(),
    });
    const rendered = renderTui(fake.ports);
    await settle();
    await chooseCommand(rendered, 'model-picker');
    expect(frameText(rendered)).toContain('Planner');
    // 下移到 Planner，进入候选菜单，切到动作区并选中「应用选择」。
    await press(rendered, DOWN);
    await press(rendered, ENTER);
    expect(frameText(rendered)).toContain('选择模型');
    await press(rendered, TAB);
    await press(rendered, TAB);
    expect(frameText(rendered)).toContain('当前区域：操作按钮');
    await press(rendered, RIGHT);
    await press(rendered, ENTER);
    await settle(6);

    const applied = fake.calls.filter((call) => call.name === 'modelSettings.apply');
    expect(applied).toHaveLength(1);
    expect(applied[0]?.detail).toMatchObject({ role: 'planner', modelRef: 'model-a-latest', effort: 'high' });
    expect(frameText(rendered)).toContain('Execution Authorization Review');
    // 批准是独立的显式动作：到达审阅页不等于已批准。
    expect(fake.calls.filter((call) => call.name === 'executionAuthorization.approve')).toHaveLength(0);
    rendered.unmount();
  });

  test('审阅失败时保留当前候选选择与焦点，可直接重试', async () => {
    let failReview = true;
    const fake = createFakePorts({
      modelCatalog: fakeCatalogOptions(),
      modelSettings: {},
      authorizationReview: makeAuthorizationReview(),
    });
    const ports = {
      ...fake.ports,
      executionAuthorization: {
        ...fake.ports.executionAuthorization,
        review: () => {
          if (failReview) {
            failReview = false;
            return Promise.reject(new Error('transport down'));
          }
          return fake.ports.executionAuthorization.review();
        },
      },
    };
    const rendered = renderTui(ports);
    await settle();
    await chooseCommand(rendered, 'model-picker');
    await press(rendered, DOWN);
    await press(rendered, ENTER);
    await press(rendered, TAB);
    await press(rendered, TAB);
    await press(rendered, RIGHT);
    await press(rendered, ENTER);
    await settle(6);

    // profile 已保存，但审阅没拿到：候选菜单留在原地，提示可重试。
    expect(fake.calls.filter((call) => call.name === 'modelSettings.apply')).toHaveLength(1);
    expect(frameText(rendered)).toContain('选择模型');
    expect(frameText(rendered)).toContain('审阅未完成');
    expect(frameText(rendered)).not.toContain('Execution Authorization Review');

    // 再次应用即可重试，不需要重新选一遍候选。
    await press(rendered, ENTER);
    await settle(6);
    expect(frameText(rendered)).toContain('Execution Authorization Review');
    rendered.unmount();
  });

  test('离开模型页后迟到的审阅失败不覆盖新页面', async () => {
    const gate: { reject: (() => void) | null } = { reject: null };
    const fake = createFakePorts({ modelCatalog: fakeCatalogOptions(), modelSettings: {} });
    const ports = {
      ...fake.ports,
      executionAuthorization: {
        ...fake.ports.executionAuthorization,
        review: () => new Promise<Awaited<ReturnType<typeof fake.ports.executionAuthorization.review>>>((_resolve, reject) => {
          gate.reject = () => reject(new Error('transport down'));
        }),
      },
    };
    const rendered = renderTui(ports);
    await settle();
    await chooseCommand(rendered, 'model-picker');
    await press(rendered, DOWN);
    await press(rendered, ENTER);
    await press(rendered, TAB);
    await press(rendered, TAB);
    await press(rendered, RIGHT);
    await press(rendered, ENTER);
    await settle(4);
    expect(gate.reject).not.toBeNull();
    await pressEscape(rendered);
    await pressEscape(rendered);
    await chooseCommand(rendered, 'model-picker');
    gate.reject?.();
    await settle(6);
    expect(frameText(rendered)).toContain('Model Picker');
    expect(frameText(rendered)).not.toContain('authorization_unreadable');
    expect(fake.calls.filter((call) => call.name === 'executionAuthorization.approve')).toHaveLength(0);
    rendered.unmount();
  });

  test('离开编辑器时抹除内存中的 key，输入存储中也不留痕迹', async () => {
    const fake = createFakePorts({ modelCatalog: fakeCatalogOptions(), modelSettings: {} });
    const rendered = renderTui(fake.ports);
    await settle();
    await chooseCommand(rendered, 'model-settings');
    await settle();
    await typeSecret(rendered, 'sk-should-never-persist');
    expect(frameText(rendered)).toContain(SECRET_MASK);
    expect(frameText(rendered)).not.toContain('sk-should-never-persist');

    await pressEscape(rendered);
    expect(frameText(rendered)).not.toContain('目标角色：');
    expect(frameText(rendered)).not.toContain(SECRET_MASK);
    rendered.unmount();
  });

  test('保存成功后 key 被抹除，画面上不再出现遮罩', async () => {
    const fake = createFakePorts({ modelCatalog: fakeCatalogOptions(), modelSettings: {} });
    const rendered = renderTui(fake.ports);
    await settle();
    await chooseCommand(rendered, 'model-settings');
    await settle();
    await typeSecret(rendered, 'sk-another-secret');
    await press(rendered, ENTER);
    await settle(6);

    const frame = frameText(rendered);
    expect(frame).not.toContain('sk-another-secret');
    expect(frame).not.toContain(SECRET_MASK);
    rendered.unmount();
  });

  test('迟到的载入结果不写进已经关闭或重新打开的弹窗', async () => {
    const gate: { release: (() => void) | null } = { release: null };
    const fake = createFakePorts({
      modelCatalog: fakeCatalogOptions(),
      modelSettings: {
        load: () =>
          new Promise((resolve) => {
            gate.release = () => {
              resolve({ kind: 'loaded', snapshot: FAKE_MODEL_SETTINGS_SNAPSHOT });
            };
          }),
      },
    });
    const rendered = renderTui(fake.ports);
    await settle();
    await chooseCommand(rendered, 'model-settings');
    await settle();
    await press(rendered, ESC);
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    await settle(4);
    gate.release?.();
    await settle(6);

    expect(frameText(rendered)).not.toContain('目标角色：');
    rendered.unmount();
  });

  test('选项区可以输入多行而不误触发保存', async () => {
    const fake = createFakePorts({ modelCatalog: fakeCatalogOptions(), modelSettings: {} });
    const rendered = renderTui(fake.ports);
    await settle();
    await chooseCommand(rendered, 'model-settings');
    await settle();
    // 走到「非秘密选项」字段。
    for (let index = 0; index < 3; index += 1) {
      await press(rendered, DOWN);
    }
    await press(rendered, 'maxTokens = 2000');
    await press(rendered, '\u001b[13;2u');
    await press(rendered, 'name = "示例"');
    // 换行不提交：编辑器仍然打开。
    expect(frameText(rendered)).toContain('目标角色：');

    // 换行没有触发保存：提交后一次 save 也没有发生。
    await press(rendered, ENTER);
    await settle(4);
    expect(fake.calls.filter((call) => call.name === 'modelSettings.save')).toHaveLength(1);
    const saved = fake.calls.find((call) => call.name === 'modelSettings.save');
    expect((saved?.detail as { modelOptions: Record<string, unknown> }).modelOptions).toEqual({
      maxTokens: 2000,
      name: '示例',
    });
    rendered.unmount();
  });

  test('保存请求在途时不重复提交，也不冻结编辑', async () => {
    const gate: { release: (() => void) | null } = { release: null };
    let gated = false;
    const fake = createFakePorts({
      modelCatalog: fakeCatalogOptions(),
      modelSettings: {
        save: () => {
          // 只有第一次挂起，用来观察在途期间的重复提交与继续编辑。
          if (gated) {
            return Promise.resolve({ kind: 'saved', revision: 9, configurationRef: 'config-saved-2', profileRef: null });
          }
          gated = true;
          return new Promise((resolve) => {
            gate.release = () => {
              resolve({ kind: 'saved', revision: 8, configurationRef: 'config-saved', profileRef: null });
            };
          });
        },
      },
    });
    const rendered = renderTui(fake.ports);
    await settle();
    await chooseCommand(rendered, 'model-settings');
    await settle();
    await press(rendered, ENTER);
    await settle(2);
    // 在途期间再按 Enter：被闸门挡住，不会第二次提交。
    await press(rendered, ENTER);
    await settle(2);
    // 同时继续编辑，键盘仍然可用。
    await press(rendered, 'x');
    expect(frameText(rendered)).toContain('目标角色：');

    gate.release?.();
    await settle(6);
    expect(fake.calls.filter((call) => call.name === 'modelSettings.save')).toHaveLength(1);
    // 后续编辑原样保留，保存基准推进到结果 revision，不需要关闭重开。
    expect(frameText(rendered)).toContain('目标角色：');
    expect(frameText(rendered)).toContain('保存基准已更新为 revision 8');
    // 再次提交用的是推进后的 revision，且此刻没有请求在途。
    await press(rendered, ENTER);
    await settle(6);
    const saves = fake.calls.filter((call) => call.name === 'modelSettings.save');
    expect(saves).toHaveLength(2);
    expect((saves[1]?.detail as { expectedRevision: number }).expectedRevision).toBe(8);
    // 这次没有后续编辑，保存成功后正常关闭并提示尚未应用。
    expect(frameText(rendered)).not.toContain('目标角色：');
    expect(frameText(rendered)).toContain('尚未应用');
    rendered.unmount();
  });

  test('应用请求在途时不重复提交', async () => {
    const gate: { release: (() => void) | null } = { release: null };
    const fake = createFakePorts({
      modelCatalog: fakeCatalogOptions(),
      modelSettings: {
        apply: () =>
          new Promise((resolve) => {
            gate.release = () => {
              resolve({ kind: 'saved', revision: 8, configurationRef: null, profileRef: 'profile-saved' });
            };
          }),
      },
      authorizationReview: makeAuthorizationReview(),
    });
    const rendered = renderTui(fake.ports);
    await settle();
    await chooseCommand(rendered, 'model-picker');
    await press(rendered, DOWN);
    await press(rendered, ENTER);
    await press(rendered, TAB);
    await press(rendered, TAB);
    await press(rendered, RIGHT);
    await press(rendered, ENTER);
    await settle(2);
    await press(rendered, ENTER);
    await settle(2);
    expect(fake.calls.filter((call) => call.name === 'modelSettings.apply')).toHaveLength(1);

    gate.release?.();
    await settle(6);
    expect(frameText(rendered)).toContain('Execution Authorization Review');
    expect(fake.calls.filter((call) => call.name === 'executionAuthorization.approve')).toHaveLength(0);
    rendered.unmount();
  });
});

describe('逐角色 harness 与原生连接编辑', () => {
  const nativeEdit = (overrides: Partial<ModelSettingsEdit> = {}): ModelSettingsEdit => editWith({
    role: 'planner',
    harness: 'claude',
    nativeProviderId: 'anthropic',
    nativeBaseUrl: 'https://api.anthropic.com',
    nativeApi: 'anthropic-messages',
    credentialKind: 'managed',
    credentialRef: '11111111-1111-4111-8111-111111111111',
    credentialOptionPath: 'apiKey',
    ...overrides,
  });

  test('codex 之外的 harness 组装原生连接，codex 连接让位', () => {
    const draft = modelSettingsDraft(nativeEdit(), 7);
    expect(draft.kind).toBe('ok');
    if (draft.kind !== 'ok') return;
    expect(draft.input.harness).toBe('claude');
    expect(draft.input.connection.codex).toBeNull();
    expect(draft.input.connection.nativeWorker).toEqual({
      harness: 'claude',
      providerId: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      api: 'anthropic-messages',
    });
  });

  test('原生连接缺 providerId、managed 缺 baseUrl/api、api 超范围都拒绝', () => {
    expect(modelSettingsDraft(nativeEdit({ nativeProviderId: '' }), 7)).toMatchObject({
      kind: 'invalid',
      field: 'nativeProviderId',
    });
    expect(modelSettingsDraft(nativeEdit({ nativeBaseUrl: '', nativeApi: '' }), 7)).toMatchObject({
      kind: 'invalid',
      field: 'nativeBaseUrl',
    });
    // claude 只支持 anthropic-messages：选了别的接口族必须显式拒绝。
    expect(modelSettingsDraft(nativeEdit({ nativeApi: 'openai-completions' }), 7)).toMatchObject({
      kind: 'invalid',
      field: 'nativeApi',
    });
  });

  test('harness_login 可缺省 baseUrl/api，但仍需要 providerId', () => {
    const draft = modelSettingsDraft(
      nativeEdit({
        credentialKind: 'harness_login',
        credentialRef: '',
        credentialOptionPath: '',
        nativeBaseUrl: '',
        nativeApi: '',
      }),
      7,
    );
    expect(draft.kind).toBe('ok');
    if (draft.kind !== 'ok') return;
    expect(draft.input.connection.nativeWorker).toEqual({ harness: 'claude', providerId: 'anthropic' });
  });

  test('未注册的显式 harness 被拒绝', () => {
    expect(modelSettingsDraft(nativeEdit({ harness: 'kilo' }), 7)).toMatchObject({
      kind: 'invalid',
      field: 'harness',
    });
  });

  test('harness 缺省仍按 codex 处理，Coordinator 不组装原生连接', () => {
    const codex = modelSettingsDraft(
      editWith({
        role: 'planner',
        codexProviderId: 'openai',
        codexBaseUrl: 'https://api.openai.com/v1',
        codexWireApi: 'responses',
      }),
      7,
    );
    expect(codex.kind).toBe('ok');
    if (codex.kind !== 'ok') return;
    expect(codex.input.harness).toBeUndefined();
    expect(codex.input.connection.codex).not.toBeNull();
    expect(codex.input.connection.nativeWorker).toBeUndefined();

    // Coordinator 即使带着 native 字段也不走原生分支：它始终是 LangChain/codex。
    const coordinator = modelSettingsDraft(nativeEdit({ role: 'coordinator' }), 7);
    expect(coordinator.kind).toBe('ok');
    if (coordinator.kind !== 'ok') return;
    expect(coordinator.input.harness).toBeUndefined();
    expect(coordinator.input.connection.nativeWorker).toBeUndefined();
  });

  test('可见字段按角色与 harness 收窄，缺省仍是 codex', () => {
    const coordinator = visibleModelSettingsFields('managed', { role: 'coordinator', harness: 'claude' });
    expect(coordinator).not.toContain('harness');
    expect(coordinator).not.toContain('nativeProviderId');
    expect(coordinator).toContain('codexProviderId');

    const codexWorker = visibleModelSettingsFields('managed', { role: 'planner', harness: 'codex' });
    expect(codexWorker).toContain('harness');
    expect(codexWorker).toContain('codexProviderId');
    expect(codexWorker).not.toContain('nativeProviderId');

    const nativeWorker = visibleModelSettingsFields('managed', { role: 'planner', harness: 'claude' });
    expect(nativeWorker).toContain('harness');
    expect(nativeWorker).toContain('nativeProviderId');
    expect(nativeWorker).not.toContain('codexProviderId');

    // 旧调用方式（无 edit）保持 codex 行为，字段数量不变。
    expect(visibleModelSettingsFields('managed')).toHaveLength(13);
    expect(visibleModelSettingsFields('harness_login')).toHaveLength(12);
  });

  test('harness 与 native api 用左右键循环', () => {
    const toClaude = editModelSettingsField(editWith({ harness: 'codex' }), 'harness', '', {
      leftArrow: false,
      rightArrow: true,
    } as never);
    expect(toClaude.harness).toBe('claude');
    const toCodex = editModelSettingsField(editWith({ harness: 'claude' }), 'harness', '', {
      leftArrow: true,
      rightArrow: false,
    } as never);
    expect(toCodex.harness).toBe('codex');
    const nextApi = editModelSettingsField(editWith({ nativeApi: 'anthropic-messages' }), 'nativeApi', '', {
      leftArrow: false,
      rightArrow: true,
    } as never);
    expect(nextApi.nativeApi).toBe('openai-completions');
    // claude 只支持 anthropic-messages：循环列表不许提供会被拒绝的取值。
    const claudeApi = editModelSettingsField(
      editWith({ harness: 'claude', nativeApi: 'anthropic-messages' }),
      'nativeApi',
      '',
      { leftArrow: false, rightArrow: true } as never,
    );
    expect(claudeApi.nativeApi).toBe('anthropic-messages');
  });
});

/* -------------------------------------------------------------------------- */
/* 真实 App 集成（IP-12 模型子页）                                             */
/* -------------------------------------------------------------------------- */

const NATIVE_PLANNER: ModelRoleView = {
  role: 'planner',
  label: 'Planner',
  group: 'execution',
  current: { candidateRef: 'model-native', provider: 'anthropic', model: 'claude-native', effort: null },
  candidates: [
    { candidateRef: 'model-native', connectionRef: 'connection-native', provider: 'anthropic', model: 'claude-native', effortCapability: null },
  ],
  availability: { available: true, reason: null },
};

/** 既有原生角色：连接带 nativeWorker，角色 harness 为 claude。 */
const NATIVE_SNAPSHOT: ModelSettingsSnapshotView = {
  revision: 9,
  roles: [
    {
      role: 'coordinator',
      bindingRef: 'config-a',
      connectionRef: 'connection-a',
      connectionLabel: '主连接',
      providerIntegration: 'openai',
      model: 'model-a',
      effort: null,
      effortCapability: null,
      harness: null,
    },
    {
      role: 'planner',
      bindingRef: 'profile-native',
      connectionRef: 'connection-native',
      connectionLabel: 'Anthropic',
      providerIntegration: 'claude#native',
      model: 'claude-native',
      effort: null,
      effortCapability: null,
      harness: 'claude',
    },
  ],
  connections: [
    {
      connectionRef: 'connection-a',
      label: '主连接',
      providerIntegration: 'openai',
      modelOptions: {},
      credential: { kind: 'managed', credentialRef: '11111111-1111-4111-8111-111111111111', optionPath: 'apiKey' },
      codex: { providerId: 'openai', baseUrl: 'https://api.openai.com/v1', wireApi: 'responses' },
    },
    {
      connectionRef: 'connection-native',
      label: 'Anthropic',
      providerIntegration: 'claude#native',
      modelOptions: {},
      credential: { kind: 'managed', credentialRef: '11111111-1111-4111-8111-111111111111', optionPath: 'apiKey' },
      codex: null,
      nativeWorker: { harness: 'claude', providerId: 'anthropic', baseUrl: 'https://api.anthropic.com', api: 'anthropic-messages' },
    },
  ],
  models: [{ modelRef: 'model-native', connectionRef: 'connection-native', model: 'claude-native', effortCapability: null }],
  coordinatorConfigurations: [{ configurationRef: 'config-a', model: 'model-a', effort: null }],
};

const nativeCatalog = () => ({
  options: [],
  currentConfigurationRef: null,
  switchable: true,
  switchBlockReason: null,
  configurationRevision: 9,
  roles: [NATIVE_PLANNER],
});

/** 一直下移，直到目标字段成为激活行；字段集合随角色与 harness 变化。 */
async function pressDownUntilActive(rendered: RenderedTui, label: string): Promise<void> {
  for (let index = 0; index < MODEL_SETTINGS_FIELDS.length; index += 1) {
    if (new RegExp('›\\s+' + label, 'u').test(frameText(rendered))) {
      return;
    }
    await press(rendered, DOWN);
  }
}

describe('真实 App 的角色连接子页', () => {
  test('既有原生角色回填 harness 与原生字段，保存不再改回 codex', async () => {
    const fake = createFakePorts({
      modelCatalog: nativeCatalog(),
      modelSettings: { load: () => Promise.resolve({ kind: 'loaded', snapshot: NATIVE_SNAPSHOT }) },
    });
    const rendered = renderTui(fake.ports);
    await settle();
    // 角色 catalog 由 Model Picker 载入；e 直接编辑高亮角色的连接。
    await chooseCommand(rendered, 'model-picker');
    await settle();
    await press(rendered, 'e');
    await settle();

    // 导航必须能走到原生字段：字段集合与渲染一致，否则这些行不可达。
    await pressDownUntilActive(rendered, 'native providerId');
    const frame = frameText(rendered);
    expect(frame).toContain('目标角色：planner');
    expect(frame).toContain('Harness');
    expect(frame).toContain('claude');
    expect(frame).toContain('native providerId');
    expect(frame).toContain('anthropic');
    // 原生角色不该再出现 codex 连接字段。
    expect(frame).not.toContain('Codex providerId');

    await press(rendered, ENTER);
    await settle(6);
    const saved = fake.calls.find((call) => call.name === 'modelSettings.save');
    expect(saved?.detail).toMatchObject({
      role: 'planner',
      harness: 'claude',
      connection: {
        codex: null,
        nativeWorker: {
          harness: 'claude',
          providerId: 'anthropic',
          baseUrl: 'https://api.anthropic.com',
          api: 'anthropic-messages',
        },
      },
    });
    rendered.unmount();
  });

  test('切到 codex 后可见字段与保存一起改走 codex 连接', async () => {
    const fake = createFakePorts({
      modelCatalog: nativeCatalog(),
      modelSettings: { load: () => Promise.resolve({ kind: 'loaded', snapshot: NATIVE_SNAPSHOT }) },
    });
    const rendered = renderTui(fake.ports);
    await settle();
    await chooseCommand(rendered, 'model-picker');
    await settle();
    await press(rendered, 'e');
    await settle();

    await pressDownUntilActive(rendered, 'Harness');
    await press(rendered, LEFT);
    await settle(2);

    const frame = frameText(rendered);
    expect(frame).toContain('Codex providerId');
    expect(frame).not.toContain('native providerId');

    await press(rendered, ENTER);
    await settle(6);
    const saved = fake.calls.find((call) => call.name === 'modelSettings.save');
    expect(saved?.detail).toMatchObject({ role: 'planner', harness: 'codex', connection: { codex: null } });
    expect((saved?.detail as { connection: Record<string, unknown> }).connection.nativeWorker).toBeUndefined();
    rendered.unmount();
  });
});
