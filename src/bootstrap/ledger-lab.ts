import { randomUUID } from 'node:crypto';
import { JsonCredentialStore } from '../adapters/storage/credential-store.js';
import { FileProjectConfigurationStore } from '../adapters/storage/project-configuration-store.js';
import { FileProviderLibraryStore } from '../adapters/storage/provider-library-store.js';
import { createProviderCatalog } from '../adapters/agents/provider-catalog.js';
import { createModelSettingsService, type SaveWorkerModelSettingsInput, type WorkerSelectionVerifier } from '../application/configuration/model-settings.js';
import { createProviderLibrary } from '../application/configuration/provider-library.js';
import type { ProviderCatalog } from '../application/configuration/provider-catalog.js';
import { currentWorkerProfile, parseProjectConfig, type ProjectConfig } from '../application/configuration/project-config.js';
import type { CredentialStore } from '../application/ports/credential-store.js';
import type { ProjectConfigurationReadResult, ProjectConfigurationStore } from '../application/ports/project-configuration-store.js';
import { MODEL_PROFILE_ROLES, type ProviderConnection } from '../domain/model-configuration.js';
import { coordinatorModelConfigurationSchema } from '../application/coordinator/model-config-switch.js';

export function requireLedgerLabConfiguration(raw: unknown): ProjectConfig {
  const parsed = parseProjectConfig(raw);
  if (!parsed.ok) throw new Error(`配置无效：${parsed.field}`);
  for (const role of MODEL_PROFILE_ROLES) {
    if (currentWorkerProfile(parsed.value, role) === null) throw new Error(`缺少 Worker 配置：${role}`);
  }
  return parsed.value;
}

/** 同一向导进程的保存和 doctor 共用此凭据实例。 */
export function createLedgerLabConfigurationHost(options: {
  readonly configPath: string;
  readonly env: Readonly<Record<string, string>>;
  readonly credentials?: CredentialStore;
  readonly catalog?: ProviderCatalog;
  readonly verifyWorkerSelection: WorkerSelectionVerifier;
}) {
  const credentials = options.credentials ?? new JsonCredentialStore({ environment: options.env });
  const catalog = options.catalog ?? createProviderCatalog({ credentials, environment: options.env });
  const providerLibrary = createProviderLibrary({ store: new FileProviderLibraryStore({ environment: options.env }), credentials, catalog });
  const store = new FileProjectConfigurationStore({ configPath: options.configPath });
  let observed: ProjectConfigurationReadResult | null = null;
  return {
    credentials,
    providerLibrary,
    providerCatalog: catalog,
    read: () => { observed = store.read(); return observed; },
    save(input: {
      readonly coordinator: { readonly modelRef: string; readonly effort?: string | null };
      readonly workers: readonly Omit<SaveWorkerModelSettingsInput, 'expectedRevision'>[];
      readonly maxMutations: number;
      readonly maxInputTokens: number;
    }): ProjectConfig {
      const original = observed ?? store.read();
      observed = null;
      if (original.kind === 'failed') throw new Error(original.message);
      let current: ProjectConfig;
      if (original.kind === 'read') current = original.config;
      else {
        const selected = providerLibrary.resolveModel(input.coordinator.modelRef);
        if (selected.kind !== 'resolved') throw new Error('Coordinator 模型不存在于用户级 Provider Library');
        const configurationRef = randomUUID();
        const connection: ProviderConnection = selected.connection;
        const configuration = coordinatorModelConfigurationSchema.safeParse({
          configurationRef, providerIntegration: connection.providerIntegration, model: selected.model.model,
          credentialRefs: [connection.credential.credentialRef], nativeWindowOwnerRef: null,
          providerConnection: connection, modelRef: selected.model.modelRef,
          effortCapability: selected.model.effortCapability, effort: input.coordinator.effort ?? null,
        });
        if (!configuration.success) throw new Error('Coordinator 模型配置无效');
        const initial = parseProjectConfig({
          schemaVersion: 5, revision: 0, providerConnections: [connection], models: [selected.model],
          coordinatorModels: [configuration.data], defaultCoordinatorModelRef: configurationRef,
          tracker: { kind: 'github', routeMapIssueNumber: 1 }, planning: { maxMutations: input.maxMutations },
          context: { maxInputTokens: input.maxInputTokens },
          execution: { codexSandbox: 'workspace-write', workerProfiles: [], workerProfileRefs: {} },
        });
        if (!initial.ok) throw new Error(`配置无效：${initial.field}`);
        current = initial.value;
      }
      const expectedRevision = current.revision;
      const memoryStore: ProjectConfigurationStore = {
        read: () => ({ kind: 'read', config: current }),
        save: ({ expectedRevision: revision, next }) => {
          if (revision !== current.revision) return { kind: 'failed', code: 'conflict', message: '配置发生冲突' };
          current = next;
          return { kind: 'saved', revision: next.revision, config: next };
        },
      };
      const service = createModelSettingsService({ projectStore: memoryStore, credentials, library: providerLibrary, verifyWorkerSelection: options.verifyWorkerSelection });
      if (original.kind === 'read') {
        const coordinator = service.save({ ...input.coordinator, role: 'coordinator', expectedRevision: current.revision });
        if (coordinator.kind === 'rejected' || coordinator.configurationRef === null) throw new Error(coordinator.kind === 'rejected' ? coordinator.message : 'Coordinator 配置未保存');
        current = { ...current, defaultCoordinatorModelRef: coordinator.configurationRef };
      }
      for (const worker of input.workers) {
        const result = service.save({ ...worker, expectedRevision: current.revision });
        if (result.kind === 'rejected') throw new Error(result.message);
      }
      current = requireLedgerLabConfiguration({ ...current, revision: expectedRevision + 1,
        planning: { maxMutations: input.maxMutations }, context: { ...current.context, maxInputTokens: input.maxInputTokens } });
      const saved = store.save({ expectedRevision, next: current });
      if (saved.kind === 'failed') throw new Error(saved.message);
      return saved.config;
    },
  };
}
