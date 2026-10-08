import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProviderCatalog } from '../../src/adapters/agents/provider-catalog.js';
import type { ProviderConnection } from '../../src/domain/model-configuration.js';

const dirs: string[] = [];
function setup(fetch: typeof globalThis.fetch, now = () => 1_000) {
  const root = mkdtempSync(join(tmpdir(), 'provider-catalog-')); dirs.push(root);
  return createProviderCatalog({ environment: { XDG_CACHE_HOME: root }, now, fetch, credentials: { read: () => ({ kind: 'resolved', secret: 'secret' }) } });
}
const connection: ProviderConnection = { connectionRef: 'conn-a', label: 'Test', providerId: 'custom', providerIntegration: 'openai-chat', baseUrl: 'https://example.test/v1', credential: { kind: 'managed', credentialRef: 'cred-a' } };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('provider catalog', () => {
  it('uses nonempty endpoint discovery as the only candidate source', async () => {
    let requested = '';
    const catalog = setup((input) => { requested = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url; return Promise.resolve(json({ data: [{ id: 'private-model' }] })); });
    const result = await catalog.discover(connection);
    expect(requested).toBe('https://example.test/v1/models');
    expect(result).toMatchObject({ source: 'discovery', models: [{ id: 'private-model', effortCapability: null, contextWindow: null }] });
  });

  it('falls back to same-key last-known-good on empty or failed discovery', async () => {
    let body: unknown = { data: [{ id: 'seen-model' }] };
    const catalog = setup(() => Promise.resolve(json(body)));
    await catalog.discover(connection);
    body = { data: [] };
    expect(await catalog.discover(connection)).toMatchObject({ source: 'last-known-good', models: [{ id: 'seen-model' }] });
    const other = { ...connection, connectionRef: 'conn-b' };
    const otherCandidates = catalog.candidates(other);
    expect(otherCandidates.source).toBe('catalog');
    expect(otherCandidates.models.some((model) => model.id === 'seen-model')).toBe(false);
  });

  it('keeps release baseline presets and exposes only protocol-compatible custom models', () => {
    const catalog = setup(() => Promise.reject(new Error('offline')));
    expect(catalog.presets().length).toBeGreaterThan(10);
    const candidates = catalog.candidates(connection);
    expect(candidates.source).toBe('catalog');
    expect(candidates.models.every((model) => model.protocol === 'openai-chat')).toBe(true);
    expect(catalog.presets().some((preset) => preset.id === 'anthropic' && preset.protocol === 'anthropic-messages')).toBe(true);
  });

  it('invalidates LKG on changed catalog content, retains it on unchanged refresh and persists both across restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'provider-version-')); dirs.push(root);
    let publicId = 'catalog-a';
    const fetcher: typeof fetch = input => Promise.resolve((typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).includes('models.dev')
      ? json({ fixture: { name: 'Fixture', npm: '@ai-sdk/openai-compatible', env: ['FIXTURE_API_KEY'], api: 'https://fixture.test/v1', models: { [publicId]: { name: publicId, limit: { context: 1000 } } } } })
      : json({ data: [{ id: 'seen-model' }] }));
    const options = { environment: { XDG_CACHE_HOME: root }, fetch: fetcher, credentials: { read: () => ({ kind: 'resolved' as const, secret: 'secret' }) } };
    let catalog = createProviderCatalog(options);
    await catalog.discover(connection);
    expect(catalog.candidates(connection).source).toBe('last-known-good');
    expect((await catalog.refresh()).kind).toBe('updated');
    expect(catalog.candidates(connection).source).toBe('catalog');
    await catalog.discover(connection);
    expect((await catalog.refresh()).kind).toBe('unchanged');
    expect(catalog.candidates(connection).source).toBe('last-known-good');
    catalog = createProviderCatalog(options);
    expect(catalog.candidates(connection).models.map(model => model.id)).toEqual(['seen-model']);
    publicId = 'catalog-b';
    await catalog.refresh();
    expect(catalog.candidates(connection).models.map(model => model.id)).toContain('catalog-b');
    const cachePath = join(root, 'orca-companion', 'provider-catalog.json');
    const saved = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, unknown>;
    saved['baselineVersion'] = 'previous-release';
    writeFileSync(cachePath, JSON.stringify(saved));
    expect(createProviderCatalog(options).candidates(connection).catalogVersion).not.toBe(catalog.candidates(connection).catalogVersion);
  });

  it('a catalog update during discovery cannot mark an old response current', async () => {
    let finish: ((value: Response) => void) | undefined;
    const catalog = setup(async input => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).includes('models.dev')
      ? json({ fixture: { npm: '@ai-sdk/openai-compatible', env: ['KEY_API_KEY'], api: 'https://fixture.test/v1', models: { fresh: { name: 'Fresh' } } } })
      : new Promise<Response>(resolve => { finish = resolve; }));
    const pending = catalog.discover(connection);
    await catalog.refresh();
    finish!(json({ data: [{ id: 'late-model' }] }));
    expect((await pending).source).toBe('catalog');
    expect(catalog.candidates(connection).models.some(model => model.id === 'late-model')).toBe(false);
  });

  it('no discovery service uses catalog without credential or network access; cancelled queries stay local', async () => {
    let calls = 0;
    const catalog = setup(() => { calls++; return Promise.resolve(json({ data: [] })); });
    await catalog.discover({ ...connection, providerId: 'cohere', baseUrl: 'https://api.cohere.ai/compatibility/v1' });
    const controller = new AbortController(); controller.abort();
    await catalog.discover(connection, { signal: controller.signal });
    expect(await catalog.refresh({ signal: controller.signal })).toMatchObject({ kind: 'failed' });
    expect(calls).toBe(0);
  });
});
