/**
 * `remove-worker-credential-management` IP-01 的行为测试：schema 4 项目配置。
 *
 * 固定四组可观察事实：schema 4 配置能把默认 Coordinator Model Configuration 解析出来；旧 schema 与
 * 未知引用被明确拒绝；Coordinator 交叉引用与快照必须自洽、effort 不得凭空出现；Worker Profile 只带
 * 已注册 harness 与自洽的 modelSelection；已知密钥字段名在配置边界即被拒绝。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import {
  configurationByRef,
  currentWorkerProfile,
  loadProjectConfig,
  parseProjectConfig,
  PROJECT_CONFIG_FILENAME,
  PROJECT_CONFIG_SCHEMA_VERSION,
  projectConfigPath,
} from '../../src/bootstrap/project-config.js';
import { CONTEXT_READ_BYTES, MODEL_RESPONSE_BYTES } from '../../src/application/coordinator/history.js';

let directory = '';
let worktree = '';

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-project-config-'));
  worktree = join(directory, 'worktree');
  mkdirSync(worktree);
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const INTEGRATION = '@langchain/openai#ChatOpenAI';

/** 凭据引用与 CredentialStore 同形：只承认 uuid，配置里不出现任何自由文本引用。 */
const CREDENTIAL_REF = '11111111-1111-4111-8111-111111111111';

const effortCapability = () => ({
  values: ['low', 'high'],
  source: 'model-card',
  optionPath: 'reasoningEffort',
});

const connection = (connectionRef = 'openai-conn') => ({
  connectionRef,
  label: 'OpenAI',
  providerIntegration: INTEGRATION,
  modelOptions: { temperature: 0 },
  credential: { kind: 'managed' as const, credentialRef: CREDENTIAL_REF, optionPath: 'apiKey' },
});

const modelDefinition = (modelRef = 'gpt-4.1-mini', connectionRef = 'openai-conn') => ({
  modelRef,
  connectionRef,
  model: 'gpt-4.1-mini',
  effortCapability: effortCapability(),
});

/** 旧形状：没有连接/模型引用，表达「没有可信能力来源」。 */
const legacyCoordinatorModel = (configurationRef = 'planning-default') => ({
  configurationRef,
  providerIntegration: INTEGRATION,
  model: 'gpt-4.1-mini',
  modelOptions: { temperature: 0 },
  credentialRefs: [CREDENTIAL_REF],
  nativeWindowOwnerRef: null,
});

const boundCoordinatorModel = (configurationRef = 'planning-default') => ({
  ...legacyCoordinatorModel(configurationRef),
  providerConnection: connection(),
  modelRef: 'gpt-4.1-mini',
  effortCapability: effortCapability(),
  effort: 'high',
});

const workerProfile = (profileRef = 'planner-profile', role = 'planner') => ({
  profileRef,
  role,
  harness: 'codex',
  modelSelection: {
    model: 'gpt-4.1-mini',
    effort: null,
    effortCapability: null,
    catalogSource: null,
  },
});

/** `execution` 一旦出现就必须自带沙箱模式与已接受风险；其余缺省项由归一化补齐。 */
const executionBlock = (extra: Record<string, unknown> = {}) => ({
  harness: 'codex',
  codexSandbox: 'workspace-write',
  acceptedRisks: [],
  ...extra,
});

const validConfig = () => ({
  schemaVersion: PROJECT_CONFIG_SCHEMA_VERSION,
  providerConnections: [connection()],
  models: [modelDefinition()],
  coordinatorModels: [boundCoordinatorModel()],
  defaultCoordinatorModelRef: 'planning-default',
  tracker: { kind: 'github', routeMapIssueNumber: 42 },
  planning: { maxMutations: 3 },
  context: { maxInputTokens: 120_000 },
});

function write(raw: unknown): void {
  writeFileSync(projectConfigPath(worktree), JSON.stringify(raw), 'utf8');
}

test('合法 schema 4 配置从 canonical worktree 加载并解析默认引用', () => {
  write(validConfig());

  const loaded = loadProjectConfig({ worktreePath: worktree });

  expect(loaded.kind).toBe('loaded');
  if (loaded.kind !== 'loaded') {
    return;
  }
  expect(loaded.path).toBe(join(worktree, PROJECT_CONFIG_FILENAME));
  expect(loaded.defaultConfiguration.configurationRef).toBe('planning-default');
  expect(loaded.defaultConfiguration.effort).toBe('high');
  expect(loaded.config.tracker).toEqual({ kind: 'github', routeMapIssueNumber: 42 });
  expect(loaded.config.planning.maxMutations).toBe(3);
  expect(loaded.config.context.maxReadBytes).toBe(CONTEXT_READ_BYTES);
  expect(loaded.config.output.maxResponseBytes).toBe(MODEL_RESPONSE_BYTES);
  expect(configurationByRef(loaded.config, 'missing')).toBeNull();
});

test.each(['codex', 'nativeWorker'] as const)('Worker-only 连接字段出现即拒绝：%s', (field) => {
  const workerOnly = field === 'codex'
    ? { providerId: 'configured-provider', baseUrl: 'https://api.example/v1', wireApi: 'responses' }
    : { harness: 'claude', providerId: 'minimax' };
  const provider = { ...connection(), [field]: workerOnly };
  // 闭合 schema 直接拒绝 Worker-only 字段；Coordinator 的 credential 合同不变，同一份 fixture 仍合法。
  expect(parseProjectConfig({
    ...validConfig(),
    providerConnections: [provider],
    coordinatorModels: [{ ...boundCoordinatorModel(), providerConnection: provider }],
  }).ok).toBe(false);
  expect(parseProjectConfig(validConfig()).ok).toBe(true);
});

test.each([
  'https://user:password@api.example/v1',
  'https://user@api.example/v1',
  'https://api.example/v1?api_key=fixture-secret',
  'https://api.example/v1?access_token=fixture-secret',
  'https://api.example/v1?X-API-Key=fixture-secret',
])('Coordinator 模型选项里的 URL 携带凭据时在持久化边界拒绝：%s', (baseUrl) => {
  expect(parseProjectConfig({
    ...validConfig(),
    coordinatorModels: [{ ...boundCoordinatorModel(), modelOptions: { configuration: { baseURL: baseUrl } } }],
  }).ok).toBe(false);
});

test('Coordinator 模型选项保留不含凭据的 URL 查询参数', () => {
  expect(parseProjectConfig({
    ...validConfig(),
    coordinatorModels: [{
      ...boundCoordinatorModel(),
      modelOptions: { configuration: { baseURL: 'https://api.example/v1?api-version=2026-01' } },
    }],
  }).ok).toBe(true);
});

test('模型设置字段可缺省：纯规划项目不需要 Worker 配置', () => {
  write({
    schemaVersion: PROJECT_CONFIG_SCHEMA_VERSION,
    coordinatorModels: [legacyCoordinatorModel()],
    defaultCoordinatorModelRef: 'planning-default',
    tracker: { kind: 'github', routeMapIssueNumber: 42 },
    planning: { maxMutations: 3 },
    context: { maxInputTokens: 120_000 },
  });

  const parsed = parseProjectConfig({
    schemaVersion: PROJECT_CONFIG_SCHEMA_VERSION,
    coordinatorModels: [legacyCoordinatorModel()],
    defaultCoordinatorModelRef: 'planning-default',
    tracker: { kind: 'github', routeMapIssueNumber: 42 },
    planning: { maxMutations: 3 },
    context: { maxInputTokens: 120_000 },
  });

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    return;
  }
  expect(parsed.value.revision).toBe(0);
  expect(parsed.value.providerConnections).toEqual([]);
  expect(parsed.value.models).toEqual([]);
  expect(parsed.value.execution.workerProfiles).toEqual([]);
  expect(parsed.value.execution.workerProfileRefs).toEqual({});
  expect(currentWorkerProfile(parsed.value, 'planner')).toBeNull();
  // 旧形状的 Coordinator 配置没有 effort 来源，因此不能凭空带上 effort。
  expect(parsed.value.coordinatorModels[0]?.effort).toBeUndefined();
});

test('v1 与未知字段被拒绝，不自动重写用户项目', () => {
  const v1 = parseProjectConfig({ ...validConfig(), schemaVersion: 1 });
  expect(v1).toMatchObject({ ok: false, field: 'projectConfig' });

  // schema 3 缺 modelSelection：旧版本明确拒绝，不迁移、不改写用户文件。
  const v3 = parseProjectConfig({ ...validConfig(), schemaVersion: 3 });
  expect(v3).toMatchObject({ ok: false, field: 'projectConfig' });

  const unknownField = parseProjectConfig({ ...validConfig(), extra: true });
  expect(unknownField.ok).toBe(false);

  // workerModel 已由角色级 Worker Profile 取代，出现即拒绝而不是继续沿用。
  const removedField = parseProjectConfig({
    ...validConfig(),
    execution: { harness: 'codex', workerModel: 'minimax-cn/MiniMax-M3' },
  });
  expect(removedField.ok).toBe(false);
});

test('重复身份与未知引用都指向具体字段', () => {
  const duplicateConnection = parseProjectConfig({
    ...validConfig(),
    providerConnections: [connection(), connection()],
  });
  expect(duplicateConnection).toMatchObject({ ok: false, field: 'projectConfig.providerConnections' });

  const duplicateModel = parseProjectConfig({
    ...validConfig(),
    models: [modelDefinition(), modelDefinition()],
  });
  expect(duplicateModel).toMatchObject({ ok: false, field: 'projectConfig.models' });

  const unknownConnection = parseProjectConfig({
    ...validConfig(),
    models: [modelDefinition('gpt-4.1-mini', 'nope')],
  });
  expect(unknownConnection).toMatchObject({ ok: false });

  const danglingProfile = parseProjectConfig({
    ...validConfig(),
    execution: executionBlock({
      workerProfiles: [workerProfile()],
      workerProfileRefs: { planner: 'missing' },
    }),
  });
  expect(danglingProfile).toMatchObject({
    ok: false,
    field: 'projectConfig.execution.workerProfileRefs.planner',
  });

  const mismatchedRole = parseProjectConfig({
    ...validConfig(),
    execution: executionBlock({
      workerProfiles: [workerProfile()],
      workerProfileRefs: { validator: 'planner-profile' },
    }),
  });
  expect(mismatchedRole).toMatchObject({ ok: false });

  const danglingDefault = parseProjectConfig({ ...validConfig(), defaultCoordinatorModelRef: 'nope' });
  expect(danglingDefault).toMatchObject({ ok: false, field: 'projectConfig.defaultCoordinatorModelRef' });
});

test('快照必须与被引用记录自洽：改一边即拒绝', () => {
  const driftedModel = parseProjectConfig({
    ...validConfig(),
    coordinatorModels: [{ ...boundCoordinatorModel(), model: 'gpt-4.1' }],
  });
  expect(driftedModel).toMatchObject({ ok: false });

  const driftedEffort = parseProjectConfig({
    ...validConfig(),
    coordinatorModels: [
      {
        ...boundCoordinatorModel(),
        effortCapability: { ...effortCapability(), source: '猜测' },
      },
    ],
  });
  expect(driftedEffort).toMatchObject({ ok: false });

  const driftedConnection = parseProjectConfig({
    ...validConfig(),
    providerConnections: [connection()],
    coordinatorModels: [
      { ...boundCoordinatorModel(), providerConnection: { ...connection(), label: '另一个' } },
    ],
  });
  expect(driftedConnection).toMatchObject({ ok: false });

  const modelWithoutConnection = parseProjectConfig({
    ...validConfig(),
    coordinatorModels: [
      {
        configurationRef: 'planning-default',
        providerIntegration: INTEGRATION,
        model: 'gpt-4.1-mini',
        modelOptions: {},
        credentialRefs: ['cred-openai'],
        nativeWindowOwnerRef: null,
        modelRef: 'gpt-4.1-mini',
      },
    ],
  });
  expect(modelWithoutConnection).toMatchObject({ ok: false });
});

test('effort 必须有可信能力来源，且落在支持范围内', () => {
  const noSource = parseProjectConfig({
    ...validConfig(),
    coordinatorModels: [
      {
        configurationRef: 'planning-default',
        providerIntegration: INTEGRATION,
        model: 'gpt-4.1-mini',
        modelOptions: {},
        credentialRefs: ['cred-openai'],
        nativeWindowOwnerRef: null,
        effort: 'high',
      },
    ],
  });
  expect(noSource).toMatchObject({ ok: false });

  const unsupported = parseProjectConfig({
    ...validConfig(),
    coordinatorModels: [{ ...boundCoordinatorModel(), effort: 'extreme' }],
  });
  expect(unsupported).toMatchObject({ ok: false });

  const supported = parseProjectConfig({
    ...validConfig(),
    coordinatorModels: [{ ...boundCoordinatorModel(), effort: 'low' }],
  });
  expect(supported.ok).toBe(true);
});

test('Worker Profile 的模型引用与角色选择必须可解释', () => {
  const valid = parseProjectConfig({
    ...validConfig(),
    execution: executionBlock({
      workerProfiles: [workerProfile()],
      workerProfileRefs: { planner: 'planner-profile' },
    }),
  });
  expect(valid.ok).toBe(true);
  if (!valid.ok) {
    return;
  }
  expect(currentWorkerProfile(valid.value, 'planner')?.profileRef).toBe('planner-profile');
  expect(currentWorkerProfile(valid.value, 'validator')).toBeNull();

  const unregisteredHarness = parseProjectConfig({
    ...validConfig(),
    execution: executionBlock({
      workerProfiles: [
        {
          ...workerProfile(),
          harness: 'unregistered-harness',
        },
      ],
      workerProfileRefs: { planner: 'planner-profile' },
    }),
  });
  expect(unregisteredHarness).toMatchObject({ ok: false });

  const unknownRole = parseProjectConfig({
    ...validConfig(),
    execution: executionBlock({
      workerProfiles: [workerProfile()],
      workerProfileRefs: { reviewer: 'planner-profile' },
    }),
  });
  expect(unknownRole).toMatchObject({ ok: false });
});

test('Worker Profile 的模型选择必须自洽：伪造 effort 或缺目录来源都拒绝', () => {
  const fabricatedEffort = parseProjectConfig({
    ...validConfig(),
    execution: executionBlock({
      workerProfiles: [
        {
          ...workerProfile(),
          modelSelection: {
            model: 'MiniMax-M3',
            effort: 'extreme',
            effortCapability: { values: ['low', 'high'], source: 'native-catalog' },
            catalogSource: 'native-catalog',
          },
        },
      ],
      workerProfileRefs: { planner: 'planner-profile' },
    }),
  });
  expect(fabricatedEffort).toMatchObject({ ok: false });

  const capabilityWithoutSource = parseProjectConfig({
    ...validConfig(),
    execution: executionBlock({
      workerProfiles: [
        {
          ...workerProfile(),
          modelSelection: {
            model: 'MiniMax-M3',
            effort: null,
            effortCapability: { values: ['low', 'high'], source: 'native-catalog' },
            catalogSource: null,
          },
        },
      ],
      workerProfileRefs: { planner: 'planner-profile' },
    }),
  });
  expect(capabilityWithoutSource).toMatchObject({ ok: false });

  // 手填未验证 native exact ID：没有能力来源也没有目录来源，仍合法。
  const handFilled = parseProjectConfig({
    ...validConfig(),
    execution: executionBlock({
      workerProfiles: [
        {
          ...workerProfile(),
          modelSelection: { model: 'native-exact-id', effort: null, effortCapability: null, catalogSource: null },
        },
      ],
      workerProfileRefs: { planner: 'planner-profile' },
    }),
  });
  expect(handFilled.ok).toBe(true);
});

test('循环结构按拒绝返回，不向调用方抛异常', () => {
  const modelOptions: Record<string, unknown> = { temperature: 0 };
  modelOptions['self'] = modelOptions;

  const withModelOptions = (options: Record<string, unknown>) => ({
    ...validConfig(),
    providerConnections: [{ ...connection(), modelOptions: options }],
    coordinatorModels: [legacyCoordinatorModel()],
    defaultCoordinatorModelRef: 'planning-default',
  });
  // 同一份配置去掉回指就完全合法，拒绝确实来自循环而不是别的规则。
  expect(parseProjectConfig(withModelOptions({ temperature: 0 }))).toMatchObject({ ok: true });

  let result: unknown = null;
  expect(() => {
    result = parseProjectConfig(withModelOptions(modelOptions));
  }).not.toThrow();

  expect(result).toMatchObject({ ok: false, field: 'projectConfig' });
});

test('配置缺失、非法 JSON 与不可读分别拒绝', () => {
  expect(loadProjectConfig({ worktreePath: worktree })).toMatchObject({ kind: 'failed', code: 'missing' });

  writeFileSync(projectConfigPath(worktree), '{ not json', 'utf8');
  expect(loadProjectConfig({ worktreePath: worktree })).toMatchObject({ kind: 'failed', code: 'invalid' });

  const unreadable = loadProjectConfig({
    worktreePath: directory,
    readFile: () => {
      const error = new Error('EACCES: permission denied') as Error & { code?: string };
      error.code = 'EACCES';
      throw error;
    },
  });
  expect(unreadable).toMatchObject({ kind: 'failed', code: 'unreadable' });
});

test('预算越界与 tracker/planning 非法取值被拒绝', () => {
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
    expect(
      parseProjectConfig({ ...validConfig(), context: { maxInputTokens: 120_000, maxReadBytes: value } }).ok,
    ).toBe(false);
    expect(parseProjectConfig({ ...validConfig(), output: { maxResponseBytes: value } }).ok).toBe(false);
  }
  expect(parseProjectConfig({ ...validConfig(), planning: { maxMutations: 0 } }).ok).toBe(true);
  expect(parseProjectConfig({ ...validConfig(), planning: { maxMutations: -1 } }).ok).toBe(false);
  expect(
    parseProjectConfig({ ...validConfig(), tracker: { kind: 'github', routeMapIssueNumber: 0 } }).ok,
  ).toBe(false);
});

test('凭据只以引用出现：已知密钥字段名在配置边界被拒绝', () => {
  const nested = parseProjectConfig({
    ...validConfig(),
    coordinatorModels: [
      { ...boundCoordinatorModel(), modelOptions: { headers: { Authorization: 'Bearer secret' } } },
    ],
  });
  expect(nested).toMatchObject({ ok: false });
  if (nested.ok) {
    return;
  }
  expect(nested.field).toContain('coordinatorModels.0.modelOptions.headers.Authorization');

  const plaintextCredentialRef = 'sk-live-secret';
  const plaintextConnection = {
    ...connection(),
    credential: { kind: 'managed' as const, credentialRef: plaintextCredentialRef, optionPath: 'apiKey' },
  };
  const plaintextReference = parseProjectConfig({
    ...validConfig(),
    providerConnections: [plaintextConnection],
    coordinatorModels: [
      {
        ...boundCoordinatorModel(),
        credentialRefs: [plaintextCredentialRef],
        providerConnection: plaintextConnection,
      },
    ],
  });
  expect(plaintextReference).toMatchObject({ ok: false });

  const topLevel = parseProjectConfig({ ...validConfig(), apiKey: 'sk-live' });
  // 闭合 schema 直接拒绝未声明的顶层字段，密钥在配置里没有落脚点。
  expect(topLevel).toMatchObject({ ok: false, field: 'projectConfig' });
});

test('模型选项的凭据键名按常见拼法拒绝，规模类选项与引用字段不受影响', () => {
  const withOptions = (options: Record<string, unknown>) => ({
    ...validConfig(),
    coordinatorModels: [{ ...boundCoordinatorModel(), modelOptions: options }],
  });

  for (const key of ['api_key', 'bearer_token', 'client_secret', 'x-api-key', 'OPENAI_API_KEY']) {
    expect(parseProjectConfig(withOptions({ [key]: 'sk-live-value' })).ok).toBe(false);
  }
  // `token` 只在自身就是凭据名时才算命中：规模与预算类选项必须照常可用。
  expect(parseProjectConfig(withOptions({ maxTokens: 4096, tokenBudget: 1000, max_tokens: 4096 })).ok).toBe(true);
  expect(parseProjectConfig(withOptions({ credentialRef: 'cred-openai' })).ok).toBe(true);
  expect(parseProjectConfig(withOptions({ headers: [{ api_key: 'value' }] })).ok).toBe(false);
  const shared = { maxTokens: 4096 };
  expect(parseProjectConfig(withOptions({ first: shared, second: shared })).ok).toBe(true);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(parseProjectConfig(withOptions(cyclic)).ok).toBe(false);
});
