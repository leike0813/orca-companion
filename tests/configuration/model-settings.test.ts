import { expect, test } from 'vitest';
import { createModelSettingsService } from '../../src/application/configuration/model-settings.js';
import type { ProviderLibrary } from '../../src/application/configuration/provider-library.js';
import type { ProjectConfig } from '../../src/application/configuration/project-config.js';
import type { CredentialStore } from '../../src/application/ports/credential-store.js';
import type { ProjectConfigurationStore } from '../../src/application/ports/project-configuration-store.js';
import type { ProviderConnection, ModelDefinition } from '../../src/domain/model-configuration.js';
import { modelSelectionFixture } from '../support/model-configurations.js';

const credentialRef = '11111111-1111-4111-8111-111111111111';
const connection: ProviderConnection = { connectionRef: 'conn-ref', label: 'Test', providerId: 'custom', providerIntegration: 'openai-chat', baseUrl: 'https://example.test/v1', credential: { kind: 'managed', credentialRef } };
const model: ModelDefinition = { modelRef: 'model-ref', connectionRef: connection.connectionRef, model: 'test-model', effortCapability: { values: ['low', 'high'], source: 'test', optionPath: 'reasoningEffort' } };
const oldConnection: ProviderConnection = { ...connection, connectionRef: 'old-connection', credential: { kind: 'managed', credentialRef: '22222222-2222-4222-8222-222222222222' } };
const oldModel: ModelDefinition = { modelRef: 'old-model-ref', connectionRef: oldConnection.connectionRef, model: 'old-model', effortCapability: null };
const baseConfig = (): ProjectConfig => ({ schemaVersion: 5, revision: 0, providerConnections: [oldConnection], models: [oldModel], coordinatorModels: [{ configurationRef: 'old-config', providerIntegration: 'openai-chat', model: 'old-model', credentialRefs: [oldConnection.credential.credentialRef], nativeWindowOwnerRef: null, providerConnection: oldConnection, modelRef: oldModel.modelRef, effortCapability: null, effort: null }], defaultCoordinatorModelRef: 'old-config', tracker: { kind: 'github', routeMapIssueNumber: 1 }, planning: { maxMutations: 3 }, context: { maxInputTokens: 1000, maxReadBytes: 4096 }, output: { maxResponseBytes: 65536 }, execution: { harness: 'codex', workerProfiles: [], workerProfileRefs: {}, codexSandbox: 'workspace-write', permissions: { planner: true, implementation: true, validator: true, finalizer: true, gitIntegration: true, dependencyChanges: false }, limits: { maxActiveWorkPackages: 3, maxWorkPackages: 8, integrationReconciliations: 2, implementationAttempts: 2, validatorRepairs: 2, graphRevisions: 2, specificationRevisions: 2, maxRecoveriesPerWorkerAttempt: 1 }, git: { remotes: [], refs: [] }, dependency: { allowDependencyChanges: false, registry: null }, acceptedRisks: [] } });

class ProjectStore implements ProjectConfigurationStore {
  value = baseConfig();
  read() { return { kind: 'read' as const, config: this.value }; }
  save({ expectedRevision, next }: { expectedRevision: number; next: ProjectConfig }) {
    if (expectedRevision !== this.value.revision) return { kind: 'failed' as const, code: 'conflict' as const, message: 'conflict' };
    this.value = next;
    return { kind: 'saved' as const, revision: next.revision, config: next };
  }
}
class Credentials implements CredentialStore {
  reads: string[] = [];
  metadata() { return { kind: 'metadata' as const, revision: 0, refs: [credentialRef] }; }
  read(ref: string) { this.reads.push(ref); return ref === credentialRef ? { kind: 'resolved' as const, secret: 'secret' } : { kind: 'rejected' as const, code: 'credential_missing', message: 'missing' }; }
  save() { return { kind: 'rejected' as const, code: 'unused', message: 'unused' }; }
}
const library: Pick<ProviderLibrary, 'resolveModel'> = { resolveModel: (ref) => ref === model.modelRef ? { kind: 'resolved', connection, model } : { kind: 'rejected', code: 'model_missing', message: 'missing' } };

test('Coordinator 只凭 library modelRef 保存完整不可变快照并回读 credential', () => {
  const projectStore = new ProjectStore();
  const credentials = new Credentials();
  const service = createModelSettingsService({ projectStore, credentials, library });
  const result = service.save({ expectedRevision: 0, role: 'coordinator', modelRef: model.modelRef, effort: 'high' });
  expect(result).toMatchObject({ kind: 'saved', revision: 1 });
  expect(credentials.reads).toEqual([credentialRef]);
  expect(projectStore.value.providerConnections).toEqual([oldConnection, connection]);
  expect(projectStore.value.models).toEqual([oldModel, model]);
  expect(projectStore.value.coordinatorModels[1]).toMatchObject({ providerIntegration: 'openai-chat', model: 'test-model', credentialRefs: [credentialRef], modelRef: model.modelRef, effort: 'high' });
  expect(projectStore.value.defaultCoordinatorModelRef).toBe('old-config');
});

test('Coordinator 严格拒绝自由 provider 字段、未知 modelRef、无效 effort 或缺失凭据', () => {
  const projectStore = new ProjectStore();
  const credentials = new Credentials();
  const service = createModelSettingsService({ projectStore, credentials, library });
  expect(service.save({ expectedRevision: 0, role: 'coordinator', modelRef: model.modelRef, newSecret: 'x' } as never)).toMatchObject({ kind: 'rejected', code: 'invalid_input' });
  expect(service.save({ expectedRevision: 0, role: 'coordinator', modelRef: 'unknown' })).toMatchObject({ kind: 'rejected' });
  expect(service.save({ expectedRevision: 0, role: 'coordinator', modelRef: model.modelRef, effort: 'extreme' })).toMatchObject({ kind: 'rejected' });
  expect(projectStore.value.revision).toBe(0);
});

test('Worker 保存不访问 CredentialStore，且仍只收 harness modelSelection', () => {
  const projectStore = new ProjectStore();
  const credentials = new Credentials();
  const service = createModelSettingsService({ projectStore, credentials, library });
  const result = service.save({ expectedRevision: 0, role: 'planner', modelSelection: modelSelectionFixture() });
  expect(result.kind).toBe('saved');
  if (result.kind !== 'saved') return;
  expect(typeof result.profileRef).toBe('string');
  expect(credentials.reads).toEqual([]);
  expect(projectStore.value.execution.workerProfiles).toHaveLength(1);
});

test('复用连接和模型只追加配置快照，历史 effort 保持不变', () => {
  const projectStore = new ProjectStore();
  const secondModel = { ...model, modelRef: 'second-model-ref', model: 'second-model' };
  const service = createModelSettingsService({
    projectStore,
    credentials: new Credentials(),
    library: { resolveModel: ref => ({ kind: 'resolved', connection, model: ref === secondModel.modelRef ? secondModel : model }) },
  });
  expect(service.save({ expectedRevision: 0, role: 'coordinator', modelRef: model.modelRef, effort: 'high' }).kind).toBe('saved');
  const firstSnapshot = projectStore.value.coordinatorModels[1];
  expect(service.save({ expectedRevision: 1, role: 'coordinator', modelRef: model.modelRef, effort: 'low' }).kind).toBe('saved');
  expect(service.save({ expectedRevision: 2, role: 'coordinator', modelRef: secondModel.modelRef }).kind).toBe('saved');
  expect(projectStore.value.providerConnections).toHaveLength(2);
  expect(projectStore.value.models).toHaveLength(3);
  expect(projectStore.value.coordinatorModels).toHaveLength(4);
  expect(projectStore.value.coordinatorModels[1]).toEqual(firstSnapshot);
  expect(firstSnapshot?.effort).toBe('high');
});
