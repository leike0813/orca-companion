/**
 * IP-04 的行为测试：执行并发默认额度的读取与 CAS 保存。
 *
 * 固定四组可观察事实：默认额度如实读取；保存只改默认额度并保留其余配置；非法值在写入前被拒绝；
 * 过期 revision 冲突不产生任何写入。保存不涉及批准额度——那由执行授权流程单独拥有。
 */

import { expect, test } from 'vitest';

import {
  createExecutionSettingsService,
  isValidMaxActiveWorkPackages,
} from '../../src/application/configuration/execution-settings.js';
import { parseProjectConfig, type ProjectConfig } from '../../src/application/configuration/project-config.js';
import type {
  ProjectConfigurationReadResult,
  ProjectConfigurationSaveResult,
  ProjectConfigurationStore,
} from '../../src/application/ports/project-configuration-store.js';

/** 最小可解析的 schema3 纯规划配置；执行额度取领域默认值。 */
const baseConfig = (): ProjectConfig =>
  ({
    schemaVersion: 3,
    revision: 0,
    providerConnections: [],
    models: [],
    coordinatorModels: [
      {
        configurationRef: 'planning-default',
        providerIntegration: '@langchain/openai#ChatOpenAI',
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

/** 只做 revision CAS 的内存 store；与文件实现一样在锁内重新校验候选。 */
class FakeStore implements ProjectConfigurationStore {
  private config: ProjectConfig | null;

  constructor(config: ProjectConfig | null) {
    this.config = config;
  }

  read(): ProjectConfigurationReadResult {
    return this.config === null ? { kind: 'absent' } : { kind: 'read', config: this.config };
  }

  save(input: { expectedRevision: number; next: ProjectConfig }): ProjectConfigurationSaveResult {
    const currentRevision = this.config === null ? 0 : this.config.revision;
    if (currentRevision !== input.expectedRevision) {
      return { kind: 'failed', code: 'conflict', message: 'revision 冲突' };
    }
    const parsed = parseProjectConfig(input.next);
    if (!parsed.ok) {
      return { kind: 'failed', code: 'invalid', message: `${parsed.field}: ${parsed.message}` };
    }
    this.config = parsed.value;
    return { kind: 'saved', revision: parsed.value.revision, config: parsed.value };
  }
}

test('load 返回默认额度与 revision，不涉及批准额度', () => {
  const service = createExecutionSettingsService({ projectStore: new FakeStore(baseConfig()) });
  const loaded = service.load();
  expect(loaded.kind).toBe('loaded');
  if (loaded.kind !== 'loaded') return;
  expect(loaded.defaultMaxActiveWorkPackages).toBe(3);
  expect(loaded.revision).toBe(0);
});

test('save 只改默认并行额度并保留其余配置', () => {
  const store = new FakeStore(baseConfig());
  const service = createExecutionSettingsService({ projectStore: store });
  const saved = service.save({ expectedRevision: 0, maxActiveWorkPackages: 5 });
  expect(saved).toEqual({ kind: 'saved', revision: 1, defaultMaxActiveWorkPackages: 5 });
  const after = store.read();
  expect(after.kind).toBe('read');
  if (after.kind !== 'read') return;
  expect(after.config.execution.limits.maxActiveWorkPackages).toBe(5);
  expect(after.config.execution.limits.maxWorkPackages).toBe(8);
  expect(after.config.execution.limits.integrationReconciliations).toBe(2);
  expect(after.config.defaultCoordinatorModelRef).toBe('planning-default');
});

test('非法额度在写入前被拒绝，store 不变', () => {
  const store = new FakeStore(baseConfig());
  const service = createExecutionSettingsService({ projectStore: store });
  for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    expect(isValidMaxActiveWorkPackages(value)).toBe(false);
    expect(service.save({ expectedRevision: 0, maxActiveWorkPackages: value })).toMatchObject({
      kind: 'rejected',
      code: 'invalid_input',
    });
  }
  const after = store.read();
  expect(after.kind === 'read' ? after.config.revision : null).toBe(0);
});

test('过期 revision 冲突时拒绝且不覆盖', () => {
  const store = new FakeStore(baseConfig());
  const service = createExecutionSettingsService({ projectStore: store });
  expect(service.save({ expectedRevision: 7, maxActiveWorkPackages: 4 })).toMatchObject({
    kind: 'rejected',
    code: 'conflict',
  });
  const after = store.read();
  expect(after.kind === 'read' ? after.config.execution.limits.maxActiveWorkPackages : null).toBe(3);
});
