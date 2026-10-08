import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { FileProviderLibraryStore } from '../../../src/adapters/storage/provider-library-store.js';
import type { ProviderLibraryRecord } from '../../../src/application/ports/provider-library-store.js';

let root = '';
afterEach(() => { if (root !== '') rmSync(root, { recursive: true, force: true }); });

test('user library starts empty, atomically saves immutable records with owner-only permissions and CAS', () => {
  root = mkdtempSync(join(tmpdir(), 'orca-provider-library-'));
  const path = join(root, 'orca-companion', 'providers.json');
  const store = new FileProviderLibraryStore({ path });
  expect(store.load()).toMatchObject({ kind: 'rejected', code: 'missing' });
  expect(existsSync(join(root, 'orca-companion'))).toBe(false);
  const connection = { connectionRef: 'conn', label: 'Local', providerId: 'custom', providerIntegration: 'openai-chat' as const, baseUrl: 'https://example.test/v1', credential: { kind: 'managed' as const, credentialRef: '11111111-1111-4111-8111-111111111111' } };
  const first: ProviderLibraryRecord = { schemaVersion: 1, revision: 1, connections: [connection], models: [] };
  expect(store.save({ expectedRevision: 0, next: first })).toMatchObject({ kind: 'loaded', library: first });
  expect(statSync(join(root, 'orca-companion')).mode & 0o777).toBe(0o700);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(store.save({ expectedRevision: 0, next: { ...first, revision: 2 } })).toMatchObject({ kind: 'rejected', code: 'revision_conflict' });
  expect(readFileSync(path, 'utf8')).toContain('credentialRef');
});

test('symlink, unsafe directory permissions, unknown fields and rewritten history fail closed', () => {
  root = mkdtempSync(join(tmpdir(), 'orca-provider-library-'));
  const directory = join(root, 'orca-companion');
  mkdirSync(directory, { mode: 0o700 });
  chmodSync(directory, 0o755);
  const path = join(directory, 'providers.json');
  const store = new FileProviderLibraryStore({ path });
  expect(store.load()).toMatchObject({ kind: 'rejected', code: 'permission_denied' });
  chmodSync(directory, 0o700);
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, revision: 0, connections: [], models: [], secret: 'x' }), { mode: 0o600 });
  expect(store.load()).toMatchObject({ kind: 'rejected', code: 'store_invalid' });
  rmSync(path);
  writeFileSync(join(root, 'target.json'), '{}', { mode: 0o600 });
  symlinkSync(join(root, 'target.json'), path);
  expect(store.load()).toMatchObject({ kind: 'rejected', code: 'store_invalid' });
});
