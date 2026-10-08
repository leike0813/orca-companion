import { randomUUID } from 'node:crypto';
import { modelDefinitionSchema, providerBaseUrlSchema, providerConnectionSchema, type ModelDefinition, type ProviderConnection } from '../../domain/model-configuration.js';
import type { CredentialStore } from '../ports/credential-store.js';
import type { ProviderLibraryStore } from '../ports/provider-library-store.js';
import type { ProviderCatalog } from './provider-catalog.js';

type Rejected = { readonly kind: 'rejected'; readonly code: string; readonly message: string };
type Loaded = { readonly kind: 'loaded'; readonly revision: number; readonly connections: readonly ProviderConnection[]; readonly models: readonly ModelDefinition[] };
export type ProviderLibrary = {
  load(): Loaded | Rejected;
  saveConnection(input: { expectedRevision: number; label: string; providerId: string; providerIntegration: ProviderConnection['providerIntegration']; baseUrl: string; credentialRef?: string; newSecret?: string }): Promise<{ kind: 'saved'; revision: number; connection: ProviderConnection } | Rejected>;
  saveModel(input: { expectedRevision: number; connectionRef: string; model: string }): { kind: 'saved'; revision: number; model: ModelDefinition } | Rejected;
  resolveModel(modelRef: string): { kind: 'resolved'; connection: ProviderConnection; model: ModelDefinition } | Rejected;
};
export type ProviderLibraryService = ProviderLibrary;
const rejected = (code: string, message = 'Provider library request rejected'): Rejected => ({ kind: 'rejected', code, message });

export function createProviderLibrary(dependencies: { store: ProviderLibraryStore; credentials: CredentialStore; catalog: ProviderCatalog }): ProviderLibrary {
  const { store, credentials, catalog } = dependencies;
  function read(): { kind: 'loaded'; library: import('../ports/provider-library-store.js').ProviderLibraryRecord } | Rejected {
    const result = store.load();
    if (result.kind === 'rejected' && result.code === 'missing') return { kind: 'loaded', library: { schemaVersion: 1, revision: 0, connections: [], models: [] } };
    return result.kind === 'loaded' ? result : rejected(result.code, result.message);
  }
  function load(): Loaded | Rejected {
    const current = read();
    return current.kind === 'loaded' ? { kind: 'loaded', revision: current.library.revision, connections: current.library.connections, models: current.library.models } : rejected(current.code, current.message);
  }
  async function saveConnection(input: Parameters<ProviderLibrary['saveConnection']>[0]) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return rejected('invalid_input');
    if (Object.keys(input).some((key) => !['expectedRevision', 'label', 'providerId', 'providerIntegration', 'baseUrl', 'credentialRef', 'newSecret'].includes(key))) return rejected('invalid_input');
    const current = read();
    if (current.kind !== 'loaded') return rejected(current.code, current.message);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) return rejected('invalid_input');
    if (input.expectedRevision !== current.library.revision) return rejected('conflict');
    const preset = catalog.presets().find((item) => item.id === input.providerId);
    if (preset === undefined && input.providerId !== 'custom') return rejected('invalid_provider');
    if (preset !== undefined && (preset.protocol !== input.providerIntegration || (preset.baseUrl !== null && preset.baseUrl !== input.baseUrl))) return rejected('invalid_provider');
    if (preset === undefined && input.providerIntegration === 'google-gemini') return rejected('invalid_provider');
    if (typeof input.label !== 'string' || typeof input.providerId !== 'string' || typeof input.baseUrl !== 'string' || typeof input.providerIntegration !== 'string' || typeof input.expectedRevision !== 'number') return rejected('invalid_input');
    if (input.newSecret !== undefined && (typeof input.newSecret !== 'string' || input.newSecret.length === 0) || (input.newSecret === undefined) === (input.credentialRef === undefined)) return rejected('invalid_input');
    const requestedCredentialRef = input.credentialRef ?? '00000000-0000-4000-8000-000000000000';
    const preflight = providerConnectionSchema.safeParse({ connectionRef: randomUUID(), label: input.label.trim(), providerId: input.providerId, providerIntegration: input.providerIntegration, baseUrl: input.baseUrl, credential: { kind: 'managed', credentialRef: requestedCredentialRef } });
    if (!preflight.success || !providerBaseUrlSchema.safeParse(input.baseUrl).success) return rejected('invalid_input');
    if (preset !== undefined && preset.protocol !== preflight.data.providerIntegration) return rejected('invalid_provider');
    let credentialRef = input.credentialRef;
    if (input.newSecret !== undefined) {
      const metadata = credentials.metadata();
      if (metadata.kind === 'rejected') return rejected('credential_failed', metadata.message);
      const saved = credentials.save({ expectedRevision: metadata.revision, secret: input.newSecret });
      if (saved.kind === 'rejected') return rejected('credential_failed', saved.message);
      credentialRef = saved.credentialRef;
    }
    const resolved = credentials.read(credentialRef!);
    if (resolved.kind === 'rejected') return rejected('credential_unresolved', resolved.message);
    const parsed = providerConnectionSchema.safeParse({ ...preflight.data, credential: { kind: 'managed', credentialRef } });
    if (!parsed.success) return rejected('invalid_input');
    const saved = store.save({ expectedRevision: current.library.revision, next: { ...current.library, revision: current.library.revision + 1, connections: [...current.library.connections, parsed.data] } });
    if (saved.kind !== 'loaded') return rejected(saved.code, saved.message);
    try { await catalog.discover(parsed.data); } catch { /* 发现是 best-effort；连接已持久保存。 */ }
    return { kind: 'saved' as const, revision: saved.library.revision, connection: parsed.data };
  }
  function saveModel(input: Parameters<ProviderLibrary['saveModel']>[0]) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return rejected('invalid_input');
    if (Object.keys(input).some((key) => !['expectedRevision', 'connectionRef', 'model'].includes(key))) return rejected('invalid_input');
    const current = read();
    if (current.kind !== 'loaded') return rejected(current.code, current.message);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) return rejected('invalid_input');
    if (input.expectedRevision !== current.library.revision) return rejected('conflict');
    const connection = current.library.connections.find((item) => item.connectionRef === input.connectionRef);
    if (connection === undefined || typeof input.model !== 'string' || input.model.trim() === '') return rejected('invalid_input');
    const candidates = catalog.candidates(connection).models;
    const candidate = candidates.find((item) => item.id === input.model);
    const model = modelDefinitionSchema.safeParse({ modelRef: randomUUID(), connectionRef: connection.connectionRef, model: input.model, effortCapability: candidate !== undefined && candidate.protocol === connection.providerIntegration && candidate.providerId === connection.providerId ? candidate.effortCapability : null });
    if (!model.success) return rejected('invalid_input');
    const saved = store.save({ expectedRevision: current.library.revision, next: { ...current.library, revision: current.library.revision + 1, models: [...current.library.models, model.data] } });
    return saved.kind === 'loaded' ? { kind: 'saved' as const, revision: saved.library.revision, model: model.data } : rejected(saved.code, saved.message);
  }
  function resolveModel(modelRef: string) {
    const current = read();
    if (current.kind !== 'loaded') return rejected(current.code, current.message);
    const model = current.library.models.find((item) => item.modelRef === modelRef);
    const connection = model === undefined ? undefined : current.library.connections.find((item) => item.connectionRef === model.connectionRef);
    return model !== undefined && connection !== undefined ? { kind: 'resolved' as const, model, connection } : rejected('model_missing');
  }
  return { load, saveConnection, saveModel, resolveModel };
}
