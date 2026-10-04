/**
 * IP-02 的行为测试：ModelSettingsService 的不可变保存顺序。
 *
 * 固定四组可观察事实：编辑只追加新引用、旧记录与当前选择保持原样（保存不等于应用）；有 key 时凭据
 * 先保存并回读、项目引用后写；项目保存失败保留输入且不谎称生效；冲突与无效候选在任何凭据写入之前
 * 就被拒绝。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import {
  createModelSettingsService,
  modelSettingsSnapshot,
  type SaveModelSettingsInput,
} from '../../src/application/configuration/model-settings.js';
import {
  loadProjectConfig,
  projectConfigPath,
  type ProjectConfig,
} from '../../src/application/configuration/project-config.js';
import type {
  CredentialMetadataResult,
  CredentialReadResult,
  CredentialSaveResult,
  CredentialStore,
} from '../../src/application/ports/credential-store.js';
import type {
  ProjectConfigurationReadResult,
  ProjectConfigurationSaveResult,
  ProjectConfigurationStore,
} from '../../src/application/ports/project-configuration-store.js';
import { FileProjectConfigurationStore } from '../../src/adapters/storage/project-configuration-store.js';

const INTEGRATION = '@langchain/openai#ChatOpenAI';
const SECRET = 'sk-orca-model-settings-secret';

/** 引用必须是 CredentialStore 实际会发出的 uuid，夹具因此也按同一形状生成。 */
const credentialRef = (ordinal: number): string =>
  `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`;

const FIRST_CREDENTIAL_REF = credentialRef(1);
const EXISTING_CREDENTIAL_REF = '11111111-1111-4111-8111-111111111111';
const MISSING_CREDENTIAL_REF = '22222222-2222-4222-8222-222222222222';

const effortCapability = () => ({
  values: ['low', 'high'],
  source: 'model-card',
  optionPath: 'reasoningEffort',
});

/** 纯规划项目：只有一条不带可信来源的旧 Coordinator 配置，revision 为 0。 */
const baseConfig = (): ProjectConfig =>
  ({
    schemaVersion: 2,
    revision: 0,
    providerConnections: [],
    models: [],
    coordinatorModels: [
      {
        configurationRef: 'planning-default',
        providerIntegration: INTEGRATION,
        model: 'gpt-4.1-mini',
        modelOptions: {},
        credentialRefs: [],
        nativeWindowOwnerRef: null,
      },
    ],
    defaultCoordinatorModelRef: 'planning-default',
    tracker: { kind: 'github', routeMapIssueNumber: 42 },
    planning: { maxMutations: 3 },
    context: { maxInputTokens: 120_000, maxReadBytes: 4_096 },
    output: { maxResponseBytes: 65_536 },
    execution: {
      harness: 'codex',
      workerProfiles: [],
      workerProfileRefs: {},
      codexSandbox: 'workspace-write',
      permissions: {
        planner: true,
        implementation: true,
        validator: true,
        finalizer: true,
        gitIntegration: true,
        dependencyChanges: false,
      },
      limits: {
        maxActiveWorkPackages: 8,
        concurrencyLimit: 1,
        implementationAttempts: 2,
        validatorRepairs: 2,
        graphRevisions: 2,
        specificationRevisions: 2,
        maxRecoveriesPerWorkerAttempt: 1,
      },
      git: { remotes: [], refs: [] },
      dependency: { allowDependencyChanges: false, registry: null },
      acceptedRisks: [],
    },
  });

const managedConnection = () => ({
  label: 'OpenAI',
  providerIntegration: INTEGRATION,
  modelOptions: { temperature: 0 },
  credential: { kind: 'managed' as const, credentialRef: null, optionPath: 'apiKey' },
  codex: null,
});

const coordinatorInput = (overrides: Partial<SaveModelSettingsInput> = {}): SaveModelSettingsInput => ({
  expectedRevision: 0,
  role: 'coordinator',
  connection: managedConnection(),
  model: 'gpt-4.1-mini',
  modelOptions: { temperature: 0 },
  effortCapability: effortCapability(),
  effort: 'high',
  newSecret: SECRET,
  ...overrides,
});

/** 复用用户级凭据库里已有引用的编辑：本次不提供新 key。 */
const existingCredentialInput = (credentialRef: string): SaveModelSettingsInput => ({
  expectedRevision: 0,
  role: 'coordinator',
  connection: {
    ...managedConnection(),
    credential: { kind: 'managed', credentialRef, optionPath: 'apiKey' },
  },
  model: 'gpt-4.1-mini',
  modelOptions: { temperature: 0 },
  effortCapability: effortCapability(),
  effort: 'high',
});

class FakeCredentialStore implements CredentialStore {
  readonly log: string[];

  private revisionValue = 0;

  private entries = new Map<string, string>();

  private nextRef = 1;

  failSave = false;

  constructor(log: string[] = []) {
    this.log = log;
  }

  metadata(): CredentialMetadataResult {
    this.log.push('credentials.metadata');
    return { kind: 'metadata', revision: this.revisionValue, refs: [...this.entries.keys()] };
  }

  read(credentialRef: string): CredentialReadResult {
    this.log.push('credentials.read');
    const secret = this.entries.get(credentialRef);
    if (secret === undefined) {
      return { kind: 'rejected', code: 'credential_missing', message: '凭据不存在' };
    }
    return { kind: 'resolved', secret };
  }

  save(input: { readonly expectedRevision: number; readonly secret: string }): CredentialSaveResult {
    this.log.push('credentials.save');
    if (this.failSave || input.expectedRevision !== this.revisionValue) {
      return { kind: 'rejected', code: 'revision_conflict', message: '凭据已被其他编辑修改' };
    }
    const minted = credentialRef(this.nextRef);
    this.nextRef += 1;
    this.revisionValue += 1;
    this.entries.set(minted, input.secret);
    return { kind: 'saved', revision: this.revisionValue, credentialRef: minted };
  }

  savedSecrets(): string[] {
    return [...this.entries.values()];
  }

  seed(credentialRef: string, secret: string): void {
    this.entries.set(credentialRef, secret);
  }
}

class FakeProjectStore implements ProjectConfigurationStore {
  readonly log: string[];

  private current: ProjectConfig | null;

  failSave = false;

  constructor(current: ProjectConfig | null, log: string[] = []) {
    this.current = current;
    this.log = log;
  }

  read(): ProjectConfigurationReadResult {
    this.log.push('project.read');
    return this.current === null ? { kind: 'absent' } : { kind: 'read', config: this.current };
  }

  save(input: {
    readonly expectedRevision: number;
    readonly next: ProjectConfig;
  }): ProjectConfigurationSaveResult {
    this.log.push('project.save');
    if (this.failSave) {
      return { kind: 'failed', code: 'write_failed', message: '磁盘写入失败' };
    }
    const revision = this.current?.revision ?? 0;
    if (revision !== input.expectedRevision) {
      return { kind: 'failed', code: 'conflict', message: '项目配置已被其他编辑修改' };
    }
    this.current = input.next;
    return { kind: 'saved', revision: input.next.revision, config: input.next };
  }

  config(): ProjectConfig {
    if (this.current === null) {
      throw new Error('expected a stored configuration');
    }
    return this.current;
  }
}

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-model-settings-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test('Coordinator 保存追加新记录并推进 revision，但不改当前选择', () => {
  const log: string[] = [];
  const project = new FakeProjectStore(baseConfig(), log);
  const credentials = new FakeCredentialStore(log);
  const service = createModelSettingsService({ projectStore: project, credentials });

  const result = service.save(coordinatorInput());

  expect(result).toMatchObject({ kind: 'saved', revision: 1 });
  if (result.kind !== 'saved') {
    return;
  }
  expect(result.profileRef).toBeNull();
  expect(result.configurationRef).not.toBeNull();

  const saved = project.config();
  expect(saved.revision).toBe(1);
  // 旧配置仍在，默认引用不动：保存不是应用。
  expect(saved.coordinatorModels.map((entry) => entry.configurationRef)).toEqual([
    'planning-default',
    result.configurationRef,
  ]);
  expect(saved.defaultCoordinatorModelRef).toBe('planning-default');
  expect(saved.providerConnections).toHaveLength(1);
  expect(saved.models).toHaveLength(1);

  const added = saved.coordinatorModels[1]!;
  expect(added.effort).toBe('high');
  expect(added.credentialRefs).toEqual([FIRST_CREDENTIAL_REF]);
  expect(added.providerConnection?.connectionRef).toBe(saved.models[0]?.connectionRef);

  // 先 key 后引用：凭据保存并回读之后才写项目。
  expect(credentials.log).toEqual([
    'project.read',
    'credentials.metadata',
    'credentials.save',
    'credentials.read',
    'project.save',
  ]);
  expect(credentials.savedSecrets()).toEqual([SECRET]);
});

test('项目里只有凭据引用，密钥不出现在配置内容中', () => {
  const worktree = join(root, 'worktree');
  mkdirSync(worktree);
  const configPath = projectConfigPath(worktree);
  writeFileSync(configPath, JSON.stringify(baseConfig(), null, 2), 'utf8');
  const project = new FileProjectConfigurationStore({ configPath });
  const service = createModelSettingsService({ projectStore: project, credentials: new FakeCredentialStore() });

  expect(service.save(coordinatorInput({ expectedRevision: 0 }))).toMatchObject({ kind: 'saved' });

  const text = readFileSync(configPath, 'utf8');
  expect(text).not.toContain(SECRET);
  expect(text).toContain(FIRST_CREDENTIAL_REF);
  expect(loadProjectConfig({ worktreePath: worktree })).toMatchObject({ kind: 'loaded' });
});

test('Worker 角色保存生成 profile 并更新角色选择，旧 profile 保留为历史', () => {
  const project = new FakeProjectStore(baseConfig());
  const credentials = new FakeCredentialStore();
  const service = createModelSettingsService({ projectStore: project, credentials });

  const first = service.save(
    coordinatorInput({ role: 'planner', expectedRevision: 0 }),
  );
  expect(first).toMatchObject({ kind: 'saved', revision: 1 });
  if (first.kind !== 'saved' || first.profileRef === null) {
    return;
  }
  expect(first.configurationRef).toBeNull();
  expect(project.config().execution.workerProfileRefs).toEqual({ planner: first.profileRef });
  expect(project.config().execution.workerProfiles[0]?.harness).toBe('codex');
  expect(project.config().coordinatorModels).toHaveLength(1);

  const second = service.save(
    coordinatorInput({
      role: 'planner',
      expectedRevision: 1,
      effort: 'low',
    }),
  );
  expect(second).toMatchObject({ kind: 'saved', revision: 2 });
  if (second.kind !== 'saved') {
    return;
  }
  // 旧 profile 不被替换：已批准的授权仍能按原引用读回。
  expect(project.config().execution.workerProfiles.map((entry) => entry.profileRef)).toEqual([
    first.profileRef,
    second.profileRef,
  ]);
  expect(project.config().execution.workerProfileRefs.planner).toBe(second.profileRef);
});

test('项目保存失败时凭据可能成为孤立项，但配置不变且不谎称生效', () => {
  const project = new FakeProjectStore(baseConfig());
  const credentials = new FakeCredentialStore();
  const service = createModelSettingsService({ projectStore: project, credentials });
  project.failSave = true;

  const result = service.save(coordinatorInput());

  expect(result).toMatchObject({ kind: 'rejected', code: 'save_failed' });
  expect(project.config().revision).toBe(0);
  expect(project.config().providerConnections).toEqual([]);
  expect(credentials.savedSecrets()).toEqual([SECRET]);
});

test('revision 冲突与无效候选在任何凭据写入之前被拒绝', () => {
  const project = new FakeProjectStore({ ...baseConfig(), revision: 5 });
  const credentials = new FakeCredentialStore();
  const service = createModelSettingsService({ projectStore: project, credentials });

  expect(service.save(coordinatorInput({ expectedRevision: 4 }))).toMatchObject({
    kind: 'rejected',
    code: 'conflict',
  });
  expect(credentials.savedSecrets()).toEqual([]);

  const secretInOptions = new FakeProjectStore(baseConfig());
  const isolatedCredentials = new FakeCredentialStore();
  const guarded = createModelSettingsService({
    projectStore: secretInOptions,
    credentials: isolatedCredentials,
  });
  expect(
    guarded.save(coordinatorInput({ modelOptions: { apiKey: SECRET } })),
  ).toMatchObject({ kind: 'rejected', code: 'invalid_input' });
  expect(isolatedCredentials.savedSecrets()).toEqual([]);
  expect(secretInOptions.config().revision).toBe(0);
});

test('harness_login 不接受新 key：凭据库与项目配置都不被写', () => {
  const project = new FakeProjectStore(baseConfig());
  const credentials = new FakeCredentialStore();
  const service = createModelSettingsService({ projectStore: project, credentials });
  const harnessLogin = {
    ...managedConnection(),
    credential: { kind: 'harness_login' as const },
  };

  for (const role of ['coordinator', 'planner'] as const) {
    expect(service.save(coordinatorInput({ role, connection: harnessLogin }))).toMatchObject({
      kind: 'rejected',
      code: 'invalid_input',
    });
  }

  // 拒绝发生在任何凭据写入之前：写下来的 key 不会成为凭据库里永不使用的孤立项。
  expect(credentials.log).toEqual([]);
  expect(credentials.savedSecrets()).toEqual([]);
  expect(project.log).toEqual(['project.read', 'project.read']);
  expect(project.config().revision).toBe(0);
  expect(project.config().providerConnections).toEqual([]);
});

test('候选无法落盘时不写凭据，孤立 key 不会先于拒绝出现', () => {
  const project = new FakeProjectStore(baseConfig());
  const credentials = new FakeCredentialStore();
  const service = createModelSettingsService({ projectStore: project, credentials });

  // effort 超出能力范围：预检即可判定，不需要先知道凭据引用。
  expect(service.save(coordinatorInput({ effort: 'extreme' }))).toMatchObject({
    kind: 'rejected',
    code: 'invalid_input',
  });
  // 凭据注入路径本身不合法：同样在预检阶段拒绝。
  expect(
    service.save(
      coordinatorInput({
        connection: {
          ...managedConnection(),
          credential: { kind: 'managed', credentialRef: null, optionPath: '__proto__' },
        },
      }),
    ),
  ).toMatchObject({ kind: 'rejected', code: 'invalid_input' });

  expect(credentials.log).toEqual([]);
  expect(credentials.savedSecrets()).toEqual([]);
  // 两次尝试都只读到项目配置，从未走到保存。
  expect(project.log).toEqual(['project.read', 'project.read']);
  expect(project.config().revision).toBe(0);
});

test('循环候选按拒绝返回，不抛异常也不写凭据', () => {
  const project = new FakeProjectStore(baseConfig());
  const credentials = new FakeCredentialStore();
  const service = createModelSettingsService({ projectStore: project, credentials });
  const modelOptions: Record<string, unknown> = { temperature: 0 };
  modelOptions['self'] = modelOptions;

  let result: unknown = null;
  expect(() => {
    result = service.save(coordinatorInput({ modelOptions }));
  }).not.toThrow();

  expect(result).toMatchObject({ kind: 'rejected', code: 'invalid_input' });
  expect(credentials.log).toEqual([]);
  expect(project.config().revision).toBe(0);
});

test('复用既有凭据引用必须当场证明可解析，解析不了就不改配置', () => {
  const project = new FakeProjectStore(baseConfig());
  const credentials = new FakeCredentialStore();
  const service = createModelSettingsService({ projectStore: project, credentials });

  const unresolved = service.save(existingCredentialInput(MISSING_CREDENTIAL_REF));

  expect(unresolved).toMatchObject({ kind: 'rejected', code: 'credential_unresolved' });
  expect(credentials.log).toEqual(['credentials.read']);
  expect(project.log).toEqual(['project.read']);
  expect(project.config().revision).toBe(0);

  credentials.seed(EXISTING_CREDENTIAL_REF, 'sk-existing');
  const saved = service.save(existingCredentialInput(EXISTING_CREDENTIAL_REF));

  expect(saved).toMatchObject({ kind: 'saved', revision: 1 });
  // 复用既有引用只读不写，凭据库里不会多出第二条记录。
  expect(credentials.log).toEqual(['credentials.read', 'credentials.read']);
  expect(credentials.savedSecrets()).toEqual(['sk-existing']);
  expect(project.config().coordinatorModels[1]?.credentialRefs).toEqual([EXISTING_CREDENTIAL_REF]);
});
test('凭据 store 拒绝时项目配置完全不被触碰', () => {
  const project = new FakeProjectStore(baseConfig());
  const credentials = new FakeCredentialStore();
  credentials.failSave = true;
  const service = createModelSettingsService({ projectStore: project, credentials });

  expect(service.save(coordinatorInput())).toMatchObject({ kind: 'rejected', code: 'credential_failed' });
  expect(project.log).toEqual(['project.read']);
  expect(project.config().revision).toBe(0);
});

test('快照是非秘密投影：未配置角色显式为空，保存不改变当前绑定', () => {
  const project = new FakeProjectStore(baseConfig());
  const service = createModelSettingsService({
    projectStore: project,
    credentials: new FakeCredentialStore(),
  });

  const before = modelSettingsSnapshot(project.config());
  expect(before.revision).toBe(0);
  expect(before.roles.map((role) => role.role)).toEqual([
    'coordinator',
    'planner',
    'implementation',
    'validator',
    'finalizer',
    'recovery_utility',
  ]);
  expect(before.roles[0]).toMatchObject({
    bindingRef: 'planning-default',
    model: 'gpt-4.1-mini',
    effort: null,
    effortCapability: null,
    connectionRef: null,
  });
  expect(before.roles[1]).toMatchObject({ bindingRef: null, model: null, harness: null });
  expect(JSON.stringify(before)).not.toContain(SECRET);

  const result = service.save(coordinatorInput());
  expect(result.kind).toBe('saved');

  const after = modelSettingsSnapshot(project.config());
  expect(after.revision).toBe(1);
  expect(after.coordinatorConfigurations).toHaveLength(2);
  // 当前绑定仍是旧配置：用户还没有显式应用。
  expect(after.roles[0]?.bindingRef).toBe('planning-default');
  expect(after.roles[0]?.effortCapability).toBeNull();
  expect(JSON.stringify(after)).not.toContain(SECRET);
});
