import { execFileSync } from 'node:child_process';
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
  const unsafe = store.load();
  expect(unsafe).toMatchObject({ kind: 'rejected', code: 'permission_denied' });
  if (unsafe.kind !== 'rejected') throw new Error('expected unsafe permissions to be rejected');
  expect(unsafe.message).toContain(directory);
  expect(unsafe.message).toContain('0755');
  expect(unsafe.message).toContain('0700');
  expect(unsafe.message).toContain('chmod 700');
  expect(statSync(directory).mode & 0o777).toBe(0o755);
  chmodSync(directory, 0o700);
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, revision: 0, connections: [], models: [], secret: 'x' }), { mode: 0o600 });
  expect(store.load()).toMatchObject({ kind: 'rejected', code: 'store_invalid' });
  rmSync(path);
  writeFileSync(join(root, 'target.json'), '{}', { mode: 0o600 });
  symlinkSync(join(root, 'target.json'), path);
  expect(store.load()).toMatchObject({ kind: 'rejected', code: 'store_invalid' });
});

test('file permissions and an occupied lock identify the resource without changing it', () => {
  root = mkdtempSync(join(tmpdir(), 'orca-provider-library-'));
  const directory = join(root, "orca's library");
  mkdirSync(directory, { mode: 0o700 });
  const path = join(directory, 'providers.json');
  const store = new FileProviderLibraryStore({ path });
  const library: ProviderLibraryRecord = { schemaVersion: 1, revision: 0, connections: [], models: [] };
  writeFileSync(path, JSON.stringify(library), { mode: 0o600 });
  chmodSync(path, 0o644);
  const unsafe = store.load();
  expect(unsafe).toMatchObject({ kind: 'rejected', code: 'permission_denied' });
  if (unsafe.kind !== 'rejected') throw new Error('expected unsafe permissions to be rejected');
  expect(unsafe.message).toContain(path);
  expect(unsafe.message).toContain('0644');
  expect(unsafe.message).toContain('0600');
  expect(statSync(path).mode & 0o777).toBe(0o644);
  const commandOffset = unsafe.message.indexOf('chmod ');
  expect(commandOffset).toBeGreaterThanOrEqual(0);
  execFileSync('/bin/sh', ['-c', unsafe.message.slice(commandOffset)]);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  writeFileSync(`${path}.lock`, '', { mode: 0o600 });
  const locked = store.save({ expectedRevision: 0, next: { ...library, revision: 1 } });
  expect(locked).toMatchObject({ kind: 'rejected', code: 'lock_busy' });
  if (locked.kind !== 'rejected') throw new Error('expected an occupied lock to be rejected');
  expect(locked.message).toContain(`${path}.lock`);
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(library);
  expect(existsSync(`${path}.lock`)).toBe(true);
});
