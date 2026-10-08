import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import baseline from './provider-catalog.json' with { type: 'json' };
import { convertModelsDev, type ProviderCatalogData } from '../../application/configuration/provider-catalog-conversion.js';
import { effortCapabilitySchema, providerBaseUrlSchema, providerProtocolSchema } from '../../domain/model-configuration.js';
import type { ProviderCatalog, ProviderCatalogResult, CatalogModel } from '../../application/configuration/provider-catalog.js';
import type { CredentialStore } from '../../application/ports/credential-store.js';
import type { ProviderConnection } from '../../domain/model-configuration.js';

type Cache = { catalogVersion: string; baselineVersion: string; savedAt: number; expiresAt: number; models: CatalogModel[] };
type DiskCache = { baselineVersion: string; discoveries: Record<string, Cache>; latest: ProviderCatalogData | null };
const TTL = 24 * 60 * 60 * 1000, TIMEOUT = 10_000, MAX_BYTES = 8 * 1024 * 1024, MAX_MODELS = 10_000, MAX_PAGES = 20, MAX_CACHE_BYTES = 8 * 1024 * 1024;
const BASELINE = baseline as ProviderCatalogData;
const protocol = providerProtocolSchema;
const modelSchema = z.strictObject({ id: z.string().min(1).max(2048), label: z.string().min(1).max(2048), providerId: z.string().min(1).max(256), protocol, effortCapability: effortCapabilitySchema.nullable(), contextWindow: z.number().int().positive().safe().nullable() });
const presetSchema = z.strictObject({ id: z.string().min(1).max(256), label: z.string().min(1).max(2048), protocol, baseUrl: providerBaseUrlSchema.nullable(), discovery: z.boolean() });
const catalogSchema = z.strictObject({ version: z.string().min(1).max(128), presets: z.array(presetSchema).min(1).max(1000), models: z.array(modelSchema).min(1).max(MAX_MODELS) });
const cacheSchema = z.strictObject({ catalogVersion: z.string().min(1).max(128), baselineVersion: z.string().min(1).max(128), savedAt: z.number().finite(), expiresAt: z.number().finite(), models: z.array(modelSchema).min(1).max(MAX_MODELS) });
const diskSchema = z.strictObject({ baselineVersion: z.string().min(1).max(128), latest: catalogSchema.nullable(), discoveries: z.record(z.string().max(4096), cacheSchema).refine((entries) => Object.keys(entries).length <= 256) });
const emptyDisk = (): DiskCache => ({ baselineVersion: BASELINE.version, discoveries: Object.create(null) as Record<string, Cache>, latest: null });

export function createProviderCatalog(options: { credentials: Pick<CredentialStore, 'read'>; environment?: NodeJS.ProcessEnv; fetch?: typeof globalThis.fetch; now?: () => number }): ProviderCatalog {
  const env = options.environment ?? process.env, fetcher = options.fetch ?? globalThis.fetch, now = options.now ?? Date.now;
  const dir = resolve(env['XDG_CACHE_HOME'] && env['XDG_CACHE_HOME'].startsWith('/') ? env['XDG_CACHE_HOME'] : join(env['HOME'] ?? homedir(), '.cache'), 'orca-companion');
  let current = BASELINE, version = BASELINE.version;
  const path = join(dir, 'provider-catalog.json');
  const readCache = (): DiskCache => {
    try {
      if (statSync(path).size > MAX_CACHE_BYTES) return emptyDisk();
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      const valid = diskSchema.safeParse(parsed);
      if (!valid.success || valid.data.baselineVersion !== BASELINE.version) return emptyDisk();
      const latest = valid.data.latest;
      return { ...valid.data, latest };
    } catch { return emptyDisk(); }
  };
  const initial = readCache().latest;
  if (initial) { current = initial; version = initial.version; }
  const save = (data: DiskCache) => {
    const content = JSON.stringify(data);
    if (Buffer.byteLength(content) > MAX_CACHE_BYTES) throw new Error('provider_cache_too_large');
    mkdirSync(dir, { recursive: true, mode: 0o700 }); const temp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temp, content, { mode: 0o600, flag: 'wx' }); renameSync(temp, path);
  };
  const cacheKey = (c: ProviderConnection, catalogVersion = version) => JSON.stringify([c.connectionRef, c.credential.credentialRef, c.providerId, c.providerIntegration, c.baseUrl, catalogVersion]);
  const catalogModels = (c: ProviderConnection) => current.models.filter((model) => model.protocol === c.providerIntegration && (c.providerId === 'custom' || model.providerId === c.providerId));
  const cached = (c: ProviderConnection): ProviderCatalogResult => {
    const disk = readCache(), cache = disk.discoveries[cacheKey(c)];
    if (cache && cache.catalogVersion === version && cache.baselineVersion === BASELINE.version) return { models: cache.models, source: 'last-known-good', catalogVersion: version, expired: cache.expiresAt <= now() };
    return { models: catalogModels(c), source: 'catalog', catalogVersion: version, expired: current.presets.find(entry => entry.id === c.providerId)?.discovery !== false };
  };
  const requestJson = async (url: string, headers: Record<string, string>, signal: AbortSignal, budget: { bytes: number }): Promise<Record<string, unknown>> => {
    const response = await fetcher(url, { headers, signal, redirect: 'error' });
    if (!response.ok) throw new Error('provider_request_failed');
    const reader = response.body?.getReader(); if (!reader) throw new Error('provider_response_invalid');
    const chunks: Buffer[] = [];
    try {
      while (true) {
        if (signal.aborted) throw new Error('provider_request_aborted');
        const part = await reader.read(); if (part.done) break;
        const value: unknown = part.value;
        if (!(value instanceof Uint8Array)) throw new Error('provider_response_invalid');
        budget.bytes += value.byteLength;
        if (budget.bytes > MAX_BYTES) throw new Error('provider_response_too_large');
        chunks.push(Buffer.from(value));
      }
    } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
    const body: unknown = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('provider_response_invalid');
    return body as Record<string, unknown>;
  };
  const discoverModels = async (c: ProviderConnection, secret: string, signal: AbortSignal, budget: { bytes: number }): Promise<CatalogModel[]> => {
    const api = c.providerIntegration, base = new URL(c.baseUrl), pathName = base.pathname.replace(/\/$/, '');
    const endpoint = api === 'google-gemini' ? new URL('/v1beta/models', base) : api === 'anthropic-messages' ? new URL(`${pathName.endsWith('/v1') ? pathName : `${pathName}/v1`}/models`, base) : new URL(`${pathName}/models`, base);
    const models: CatalogModel[] = [], seen = new Set<string>(); let token: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      if (signal.aborted) throw new Error('provider_request_aborted');
      const url = new URL(endpoint);
      if (token) url.searchParams.set(api === 'google-gemini' ? 'pageToken' : api === 'anthropic-messages' ? 'after_id' : 'after', token);
      const headers = api === 'anthropic-messages' ? { 'x-api-key': secret, 'anthropic-version': '2023-06-01' } : api === 'google-gemini' ? { 'x-goog-api-key': secret } : { authorization: `Bearer ${secret}` };
      const body = await requestJson(url.toString(), headers, signal, budget);
      const rows = Array.isArray(body['data']) ? body['data'] : Array.isArray(body['models']) ? body['models'] : [];
      for (const item of rows) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('provider_response_invalid');
        const row = item as Record<string, unknown>;
        const id = typeof row['id'] === 'string' ? row['id'] : api === 'google-gemini' && typeof row['name'] === 'string' ? row['name'].replace(/^models\//, '') : '';
        if (!id || seen.has(id)) continue;
        if (models.length === MAX_MODELS) throw new Error('provider_model_limit_exceeded');
        if (api === 'google-gemini' && Array.isArray(row['supportedGenerationMethods']) && !row['supportedGenerationMethods'].includes('generateContent')) continue;
        seen.add(id);
        const trusted = current.models.find((model) => model.id === id && model.providerId === c.providerId && model.protocol === api);
        models.push(modelSchema.parse({ id, label: typeof row['displayName'] === 'string' && row['displayName'] ? row['displayName'] : trusted?.label ?? id,
          providerId: c.providerId, protocol: api, effortCapability: trusted?.effortCapability ?? null, contextWindow: trusted?.contextWindow ?? null }));
      }
      if (api === 'anthropic-messages') token = body['has_more'] === true && typeof body['last_id'] === 'string' && body['last_id'] ? body['last_id'] : undefined;
      else { const next = body['next_page_token'] ?? body['nextPageToken']; token = typeof next === 'string' && next ? next : undefined; }
      if (!token) return models;
    }
    if (token) throw new Error('provider_page_limit_exceeded');
    return models;
  };
  return {
    presets: () => current.presets,
    candidates: cached,
    async discover(c, { signal } = {}) {
      if (signal?.aborted) return cached(c);
      const preset = current.presets.find((entry) => entry.id === c.providerId && entry.protocol === c.providerIntegration);
      if (preset?.discovery === false) return cached(c);
      const cred = options.credentials.read(c.credential.credentialRef); if (cred.kind !== 'resolved') return cached(c);
      const catalogVersion = version, key = cacheKey(c, catalogVersion), controller = new AbortController();
      const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, TIMEOUT), budget = { bytes: 0 };
      try {
        const models = await discoverModels(c, cred.secret, controller.signal, budget);
        if (!models.length || controller.signal.aborted || version !== catalogVersion) return cached(c);
        const disk = readCache(), row: Cache = { catalogVersion, baselineVersion: BASELINE.version, savedAt: now(), expiresAt: now() + TTL, models };
        save({ baselineVersion: BASELINE.version, latest: disk.latest, discoveries: { ...disk.discoveries, [key]: row } });
        return { models, source: 'discovery', catalogVersion, expired: false };
      } catch { return cached(c); }
      finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    },
    async refresh({ signal } = {}) {
      if (signal?.aborted) return { kind: 'failed', catalogVersion: version };
      const controller = new AbortController(), abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, TIMEOUT);
      try {
        const raw = await requestJson('https://models.dev/api.json', {}, controller.signal, { bytes: 0 });
        const data = catalogSchema.parse(convertModelsDev(raw)), changed = data.version !== version, disk = readCache();
        const discoveries = Object.fromEntries(Object.entries(disk.discoveries).filter(([, entry]) => entry.catalogVersion === data.version && entry.baselineVersion === BASELINE.version));
        if (controller.signal.aborted) throw new Error('provider_request_aborted');
        save({ baselineVersion: BASELINE.version, latest: data, discoveries });
        current = data; version = data.version;
        return { kind: changed ? 'updated' as const : 'unchanged' as const, catalogVersion: version };
      } catch { return { kind: 'failed' as const, catalogVersion: version }; }
      finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    },
  };
}
