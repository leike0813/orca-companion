import { randomUUID } from 'node:crypto';
import { JsonCredentialStore } from '../adapters/storage/credential-store.js';
import { FileProjectConfigurationStore } from '../adapters/storage/project-configuration-store.js';
import { createModelSettingsService, type SaveCoordinatorModelSettingsInput, type SaveWorkerModelSettingsInput, type WorkerSelectionVerifier } from '../application/configuration/model-settings.js';
import { currentWorkerProfile, parseProjectConfig, type ProjectConfig } from '../application/configuration/project-config.js';
import type { CredentialStore } from '../application/ports/credential-store.js';
import type { ProjectConfigurationReadResult, ProjectConfigurationStore } from '../application/ports/project-configuration-store.js';
import { MODEL_PROFILE_ROLES } from '../domain/model-configuration.js';

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
  readonly verifyWorkerSelection: WorkerSelectionVerifier;
}) {
  const credentials = options.credentials ?? new JsonCredentialStore({ environment: options.env });
  const store = new FileProjectConfigurationStore({ configPath: options.configPath });
  let observed: ProjectConfigurationReadResult | null = null;
  return {
    credentials,
    read: () => { observed = store.read(); return observed; },
    save(input: {
      readonly coordinator: Omit<SaveCoordinatorModelSettingsInput, 'role' | 'expectedRevision'>;
      readonly workers: readonly Omit<SaveWorkerModelSettingsInput, 'expectedRevision'>[];
      readonly maxMutations: number;
      readonly maxInputTokens: number;
    }): ProjectConfig {
      const original = observed ?? store.read();
      observed = null;
      if (original.kind === 'failed') throw new Error(original.message);
      const seedRef = randomUUID();
      const seed = parseProjectConfig({
        schemaVersion: 4, revision: 0,
        coordinatorModels: [{ configurationRef: seedRef, providerIntegration: input.coordinator.connection.providerIntegration,
          model: input.coordinator.model, modelOptions: {}, credentialRefs: [], nativeWindowOwnerRef: null }],
        defaultCoordinatorModelRef: seedRef, tracker: { kind: 'github', routeMapIssueNumber: 1 },
        planning: { maxMutations: input.maxMutations }, context: { maxInputTokens: input.maxInputTokens },
      });
      if (!seed.ok) throw new Error(`配置无效：${seed.field}`);
      let current = original.kind === 'read' ? original.config : seed.value;
      const expectedRevision = current.revision;
      const memoryStore: ProjectConfigurationStore = {
        read: () => ({ kind: 'read', config: current }),
        save: ({ expectedRevision: revision, next }) => {
          if (revision !== current.revision) return { kind: 'failed', code: 'conflict', message: '配置发生冲突' };
          current = next;
          return { kind: 'saved', revision: next.revision, config: next };
        },
      };
      const service = createModelSettingsService({ projectStore: memoryStore, credentials, verifyWorkerSelection: options.verifyWorkerSelection });
      const coordinator = service.save({ ...input.coordinator, role: 'coordinator', expectedRevision: current.revision });
      if (coordinator.kind === 'rejected' || coordinator.configurationRef === null) {
        throw new Error(coordinator.kind === 'rejected' ? coordinator.message : 'Coordinator 配置未保存');
      }
      current = { ...current, defaultCoordinatorModelRef: coordinator.configurationRef,
        coordinatorModels: current.coordinatorModels.filter((entry) => entry.configurationRef !== seedRef) };
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
