import type { EffortCapability, ProviderConnection, ProviderProtocol } from '../../domain/model-configuration.js';

export type ProviderPreset = { readonly id: string; readonly label: string; readonly protocol: ProviderProtocol; readonly baseUrl: string | null; readonly discovery: boolean };
export type CatalogModel = { readonly id: string; readonly label: string; readonly providerId: string; readonly protocol: ProviderProtocol; readonly effortCapability: EffortCapability | null; readonly contextWindow: number | null };
export type ProviderCatalogResult = { readonly models: readonly CatalogModel[]; readonly source: 'discovery' | 'last-known-good' | 'catalog'; readonly catalogVersion: string; readonly expired: boolean };
export interface ProviderCatalog {
  presets(): readonly ProviderPreset[];
  candidates(connection: ProviderConnection): ProviderCatalogResult;
  discover(connection: ProviderConnection, options?: { signal?: AbortSignal }): Promise<ProviderCatalogResult>;
  refresh(options?: { signal?: AbortSignal }): Promise<{ kind: 'updated' | 'unchanged' | 'failed'; catalogVersion: string }>;
}
