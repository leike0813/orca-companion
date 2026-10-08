import type { ModelDefinition, ProviderConnection } from '../../domain/model-configuration.js';

export type ProviderLibraryRecord = { readonly schemaVersion: 1; readonly revision: number; readonly connections: readonly ProviderConnection[]; readonly models: readonly ModelDefinition[] };
export type ProviderLibraryStoreResult = { readonly kind: 'loaded'; readonly library: ProviderLibraryRecord } | { readonly kind: 'rejected'; readonly code: string; readonly message: string };
export interface ProviderLibraryStore {
  load(): ProviderLibraryStoreResult;
  save(input: { readonly expectedRevision: number; readonly next: ProviderLibraryRecord }): ProviderLibraryStoreResult;
}
