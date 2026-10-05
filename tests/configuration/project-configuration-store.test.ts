/**
 * IP-02 的行为测试：项目配置存储的短锁 CAS 与原子替换。
 *
 * 固定四组可观察事实：缺失与无效分别可诊断；保存推进 revision 并写回可被正常加载的 v2 文件；
 * 并发写者不会互相覆盖（锁忙与 revision 冲突都是拒绝）；语义无效的候选与既有无效文件都不会被
 * 静默改写。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { loadProjectConfig, projectConfigPath, type ProjectConfig } from '../../src/application/configuration/project-config.js';
import {
  MAX_PROJECT_CONFIG_BYTES,
  FileProjectConfigurationStore,
} from '../../src/adapters/storage/project-configuration-store.js';
import type {
  ProjectConfigurationFailure,
} from '../../src/application/ports/project-configuration-store.js';

const INTEGRATION = '@langchain/openai#ChatOpenAI';

const effortCapability = () => ({
  values: ['low', 'high'],
  source: 'model-card',
  optionPath: 'reasoningEffort',
});

const connection = (connectionRef = 'openai-conn') => ({
  connectionRef,
  label: 'OpenAI',
  providerIntegration: INTEGRATION,
  modelOptions: {},
  credential: { kind: 'harness_login' as const },
  codex: null,
});

const baseConfig = (revision = 0): ProjectConfig =>
  ({
    schemaVersion: 3,
    revision,
    providerConnections: [connection()],
    models: [],
    coordinatorModels: [
      {
        configurationRef: 'planning-default',
        providerIntegration: INTEGRATION,
        model: 'gpt-4.1-mini',
        modelOptions: {},
        credentialRefs: [],
        nativeWindowOwnerRef: null,
        providerConnection: connection(),
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
        maxActiveWorkPackages: 3,
        maxWorkPackages: 8,
        integrationReconciliations: 2,
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

let root = '';
let worktree = '';
let configPath = '';
let store: FileProjectConfigurationStore;

function failure(result: unknown): ProjectConfigurationFailure {
  if (typeof result !== 'object' || result === null || !('kind' in result) || result.kind !== 'failed') {
    throw new Error(`expected a failed result, got ${JSON.stringify(result)}`);
  }
  return result as ProjectConfigurationFailure;
}

function writeExisting(config: unknown): void {
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-project-store-'));
  worktree = join(root, 'worktree');
  mkdirSync(worktree);
  configPath = projectConfigPath(worktree);
  store = new FileProjectConfigurationStore({ configPath });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test('缺失与内容无效分别报告，读取不做任何隐式创建', () => {
  expect(store.read()).toEqual({ kind: 'absent' });

  writeFileSync(configPath, '{ not json', 'utf8');
  expect(store.read()).toMatchObject({ kind: 'failed', code: 'invalid' });

  writeExisting({ ...baseConfig(0), schemaVersion: 1 });
  expect(store.read()).toMatchObject({ kind: 'failed', code: 'invalid' });
});

test('保存推进 revision，写回的文件仍是可正常加载的 schema 3 项目配置', () => {
  const saved = store.save({ expectedRevision: 0, next: baseConfig(1) });

  expect(saved.kind).toBe('saved');
  if (saved.kind !== 'saved') {
    return;
  }
  expect(saved.revision).toBe(1);
  expect(saved.config.revision).toBe(1);

  const loaded = loadProjectConfig({ worktreePath: worktree });
  expect(loaded.kind).toBe('loaded');
  if (loaded.kind !== 'loaded') {
    return;
  }
  expect(loaded.config.revision).toBe(1);
  expect(loaded.defaultConfiguration.configurationRef).toBe('planning-default');

  const second = store.save({ expectedRevision: 1, next: baseConfig(2) });
  expect(second).toMatchObject({ kind: 'saved', revision: 2 });
  expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({ revision: 2 });
});

test('并行额度 1/2/3/5 可保存，零、负数、小数与溢出被拒绝', () => {
  const withConcurrency = (value: number): ProjectConfig => {
    const base = baseConfig(1);
    return {
      ...base,
      execution: {
        ...base.execution,
        limits: { ...base.execution.limits, maxActiveWorkPackages: value },
      },
    };
  };

  for (const value of [1, 2, 3, 5]) {
    expect(store.save({ expectedRevision: 0, next: withConcurrency(value) })).toMatchObject({
      kind: 'saved',
      revision: 1,
    });
    rmSync(configPath, { force: true });
  }

  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(store.save({ expectedRevision: 0, next: withConcurrency(value) })).toMatchObject({
      kind: 'failed',
      code: 'invalid',
    });
  }
});

test('revision 冲突与锁忙都拒绝，且不覆盖较新的配置', () => {
  writeExisting(baseConfig(4));

  const stale = failure(store.save({ expectedRevision: 3, next: baseConfig(4) }));
  expect(stale).toMatchObject({ kind: 'failed', code: 'conflict' });
  expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({ revision: 4 });

  writeFileSync(`${configPath}.lock`, '');
  const busy = failure(store.save({ expectedRevision: 4, next: baseConfig(5) }));
  expect(busy).toMatchObject({ kind: 'failed', code: 'lock_busy' });
  expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({ revision: 4 });
});

test('候选不连续或语义无效时连文件都不该被改动', () => {
  writeExisting(baseConfig(1));

  const nonContinuous = failure(store.save({ expectedRevision: 1, next: baseConfig(7) }));
  expect(nonContinuous).toMatchObject({ kind: 'failed', code: 'invalid' });

  let invalidEffort = structuredClone(baseConfig(2));
  invalidEffort = {
    ...invalidEffort,
    coordinatorModels: [
      {
        ...invalidEffort.coordinatorModels[0]!,
        effort: 'extreme',
        effortCapability: effortCapability(),
      },
    ],
  };
  const rejected = failure(store.save({ expectedRevision: 1, next: invalidEffort }));
  expect(rejected).toMatchObject({ kind: 'failed', code: 'invalid' });
  expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({ revision: 1 });
});

test('既有文件无法解析时拒绝保存，不替用户重写', () => {
  writeFileSync(configPath, '{ not json', 'utf8');

  const result = failure(store.save({ expectedRevision: 0, next: baseConfig(1) }));

  expect(result).toMatchObject({ kind: 'failed', code: 'invalid' });
  expect(readFileSync(configPath, 'utf8')).toBe('{ not json');
});

test('同引用改写既有记录被拒绝，追加新记录仍然允许', () => {
  writeExisting(baseConfig(1));
  const existing = baseConfig(1);
  const drifted = connection('openai-conn');
  const rewritten = {
    ...existing,
    revision: 2,
    providerConnections: [{ ...drifted, label: '另一个供应商' }],
    // 快照一起改：这里要挡住的只能是「同引用改写」，不是交叉引用不一致。
    coordinatorModels: [
      { ...existing.coordinatorModels[0]!, providerConnection: { ...drifted, label: '另一个供应商' } },
    ],
  };

  const refused = failure(store.save({ expectedRevision: 1, next: rewritten }));
  expect(refused).toMatchObject({ kind: 'failed', code: 'invalid' });
  expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({ revision: 1 });

  const appended = {
    ...existing,
    revision: 2,
    providerConnections: [...existing.providerConnections, connection('second-conn')],
    coordinatorModels: [
      ...existing.coordinatorModels,
      {
        configurationRef: 'second',
        providerIntegration: INTEGRATION,
        model: 'gpt-4.1',
        modelOptions: {},
        credentialRefs: [],
        nativeWindowOwnerRef: null,
        providerConnection: connection('second-conn'),
      },
    ],
    defaultCoordinatorModelRef: 'second',
  };
  expect(store.save({ expectedRevision: 1, next: appended })).toMatchObject({ kind: 'saved', revision: 2 });
});

test('记录与快照只比较内容，键序不同不算改写', () => {
  writeExisting(baseConfig(1));
  const record = baseConfig(1).providerConnections[0]!;
  const reorderedRecord = {
    codex: record.codex,
    credential: record.credential,
    modelOptions: record.modelOptions,
    providerIntegration: record.providerIntegration,
    label: record.label,
    connectionRef: record.connectionRef,
  };
  const existing = baseConfig(1);
  const reordered = {
    ...existing,
    revision: 2,
    providerConnections: [reorderedRecord],
    coordinatorModels: [
      {
        ...existing.coordinatorModels[0]!,
        providerConnection: {
          connectionRef: record.connectionRef,
          label: record.label,
          providerIntegration: record.providerIntegration,
          modelOptions: record.modelOptions,
          credential: record.credential,
          codex: record.codex,
        },
      },
    ],
  };

  expect(store.save({ expectedRevision: 1, next: reordered })).toMatchObject({ kind: 'saved', revision: 2 });
});

test('保存后锁文件不残留，下一次保存仍可进行', () => {
  expect(store.save({ expectedRevision: 0, next: baseConfig(1) })).toMatchObject({ kind: 'saved' });

  expect(() => readFileSync(`${configPath}.lock`, 'utf8')).toThrow();
  expect(store.save({ expectedRevision: 1, next: baseConfig(2) })).toMatchObject({ kind: 'saved' });
});

test('无法序列化的候选按拒绝返回，不向调用方抛异常', () => {
  writeExisting(baseConfig(1));
  const cyclic: Record<string, unknown> = { ...baseConfig(2) };
  cyclic['self'] = cyclic;
  const next = cyclic as unknown as ProjectConfig;

  let result: unknown = null;
  expect(() => {
    result = store.save({ expectedRevision: 1, next });
  }).not.toThrow();

  expect(failure(result)).toMatchObject({
    kind: 'failed',
    code: 'invalid',
  });
  expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({ revision: 1 });
});

test('格式化后的配置超限时保存前拒绝并保留原文件', () => {
  const current = baseConfig(1);
  writeExisting(current);
  const original = readFileSync(configPath, 'utf8');
  const modelOptions = { values: Array.from({ length: 50_000 }, (_, index) => index) };
  const addedConnection = { ...connection('large-connection'), modelOptions };
  const next: ProjectConfig = {
    ...current,
    revision: 2,
    providerConnections: [...current.providerConnections, addedConnection],
    models: [
      {
        modelRef: 'large-model',
        connectionRef: addedConnection.connectionRef,
        model: 'large-model',
        effortCapability: null,
      },
    ],
    coordinatorModels: [
      ...current.coordinatorModels,
      {
        configurationRef: 'large-model-configuration',
        providerIntegration: INTEGRATION,
        model: 'large-model',
        modelOptions,
        credentialRefs: [],
        nativeWindowOwnerRef: null,
        providerConnection: addedConnection,
        modelRef: 'large-model',
        effortCapability: null,
      },
    ],
  };

  expect(Buffer.byteLength(JSON.stringify(next), 'utf8')).toBeLessThan(MAX_PROJECT_CONFIG_BYTES);
  expect(Buffer.byteLength(`${JSON.stringify(next, null, 2)}\n`, 'utf8')).toBeGreaterThan(
    MAX_PROJECT_CONFIG_BYTES,
  );
  expect(store.save({ expectedRevision: 1, next })).toMatchObject({ kind: 'failed', code: 'invalid' });
  expect(readFileSync(configPath, 'utf8')).toBe(original);
});
