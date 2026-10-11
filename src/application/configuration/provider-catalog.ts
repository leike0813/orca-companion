import type { EffortCapability, ModelInputModality, ProviderConnection, ProviderProtocol } from '../../domain/model-configuration.js';

export type ProviderPreset = { readonly id: string; readonly label: string; readonly protocol: ProviderProtocol; readonly baseUrl: string | null; readonly discovery: boolean };
/** 目录候选的精确元数据；`contextWindow` 与 `inputModalities` 缺省或 null 表示该目录未声明。 */
export type CatalogModel = { readonly id: string; readonly label: string; readonly providerId: string; readonly protocol: ProviderProtocol; readonly effortCapability: EffortCapability | null; readonly contextWindow: number | null; readonly inputModalities?: readonly ModelInputModality[] | null | undefined };
export type ProviderCatalogResult = { readonly models: readonly CatalogModel[]; readonly source: 'discovery' | 'last-known-good' | 'catalog'; readonly catalogVersion: string; readonly expired: boolean };
export interface ProviderCatalog {
  presets(): readonly ProviderPreset[];
  candidates(connection: ProviderConnection): ProviderCatalogResult;
  discover(connection: ProviderConnection, options?: { signal?: AbortSignal }): Promise<ProviderCatalogResult>;
  refresh(options?: { signal?: AbortSignal }): Promise<{ kind: 'updated' | 'unchanged' | 'failed'; catalogVersion: string }>;
}
