import { expect, test } from 'vitest';
import { createProviderLibrary } from '../../src/application/configuration/provider-library.js';
import type { ProviderCatalog } from '../../src/application/configuration/provider-catalog.js';
import type { CredentialStore } from '../../src/application/ports/credential-store.js';
import type { ProviderLibraryRecord, ProviderLibraryStore } from '../../src/application/ports/provider-library-store.js';

const ref = '11111111-1111-4111-8111-111111111111';
class Store implements ProviderLibraryStore {
  value: ProviderLibraryRecord = { schemaVersion: 1, revision: 0, connections: [], models: [] };
  load() { return { kind: 'loaded' as const, library: this.value }; }
  save({ expectedRevision, next }: { expectedRevision: number; next: ProviderLibraryRecord }) {
    if (expectedRevision !== this.value.revision) return { kind: 'rejected' as const, code: 'revision_conflict', message: 'conflict' };
    this.value = next;
    return { kind: 'loaded' as const, library: next };
  }
}
const credentials: CredentialStore = {
  metadata: () => ({ kind: 'metadata', revision: 0, refs: [] }),
  save: () => ({ kind: 'saved', revision: 1, credentialRef: ref }),
  read: (credentialRef) => credentialRef === ref ? { kind: 'resolved', secret: 'api-secret' } : { kind: 'rejected', code: 'credential_missing', message: 'missing' },
};
const catalog: ProviderCatalog = {
  presets: () => [{ id: 'openai', label: 'OpenAI', protocol: 'openai-chat', baseUrl: 'https://api.openai.com/v1', discovery: true }],
  candidates: () => ({ models: [{ id: 'gpt-test', label: 'GPT Test', providerId: 'openai', protocol: 'openai-chat', effortCapability: null, contextWindow: 1000 }], source: 'catalog', catalogVersion: 'v1', expired: false }),
  discover: async () => { await Promise.resolve(); throw new Error('offline'); },
  refresh: async () => { await Promise.resolve(); return { kind: 'unchanged', catalogVersion: 'v1' }; },
};

test('save persists a connection despite discovery failure; model metadata requires exact trusted candidate', async () => {
  const store = new Store();
  const library = createProviderLibrary({ store, credentials, catalog });
  const connection = await library.saveConnection({ expectedRevision: 0, label: 'OpenAI', providerId: 'openai', providerIntegration: 'openai-chat', baseUrl: 'https://api.openai.com/v1', newSecret: 'api-secret' });
  expect(connection).toMatchObject({ kind: 'saved', revision: 1 });
  if (connection.kind !== 'saved') return;
  expect(JSON.stringify(library.load())).not.toContain('api-secret');
  const saved = library.saveModel({ expectedRevision: 1, connectionRef: connection.connection.connectionRef, model: 'gpt-test' });
  expect(saved).toMatchObject({ kind: 'saved', revision: 2, model: { effortCapability: null } });
  expect(library.resolveModel(saved.kind === 'saved' ? saved.model.modelRef : '')).toMatchObject({ kind: 'resolved' });
});

test('custom protocols and endpoint secrets are validated before credential writes', async () => {
  const store = new Store();
  let writes = 0;
  const guardedCredentials = { ...credentials, save: (...args: Parameters<CredentialStore['save']>) => { writes += 1; return credentials.save(...args); } };
  const library = createProviderLibrary({ store, credentials: guardedCredentials, catalog });
  expect(await library.saveConnection({ expectedRevision: 0, label: 'x', providerId: 'custom', providerIntegration: 'google-gemini', baseUrl: 'https://example.test', newSecret: 'x' })).toMatchObject({ kind: 'rejected' });
  expect(await library.saveConnection({ expectedRevision: 0, label: 'x', providerId: 'custom', providerIntegration: 'openai-chat', baseUrl: 'https://example.test?api_key=secret', newSecret: 'x' })).toMatchObject({ kind: 'rejected' });
  expect(await library.saveConnection({ expectedRevision: 0, label: 'x'.repeat(2049), providerId: 'custom', providerIntegration: 'openai-chat', baseUrl: 'https://example.test', newSecret: 'x' })).toMatchObject({ kind: 'rejected' });
  expect(await library.saveConnection({ expectedRevision: 0, label: 'x', providerId: 'custom', providerIntegration: 'openai-chat', baseUrl: 'https://example.test', credentialRef: 'invalid-ref' })).toMatchObject({ kind: 'rejected' });
  expect(await library.saveConnection({ expectedRevision: 0, label: 'x', providerId: 'custom', providerIntegration: 'openai-chat', baseUrl: 'https://example.test', newSecret: 123 } as never)).toMatchObject({ kind: 'rejected' });
  expect(writes).toBe(0);
});
