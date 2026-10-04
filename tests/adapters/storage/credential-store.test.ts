import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import type {
  CredentialFailure,
  CredentialMetadataResult,
  CredentialReadResult,
  CredentialSaveResult,
} from '../../../src/application/ports/credential-store.js';
import {
  CREDENTIAL_STORE_SCHEMA_VERSION,
  JsonCredentialStore,
  MAX_CREDENTIAL_ENTRIES,
  MAX_CREDENTIAL_SECRET_BYTES,
  MAX_CREDENTIAL_STORE_BYTES,
  credentialStorePath,
} from '../../../src/adapters/storage/credential-store.js';

const SECRET = 'sk-orca-secret-value';

let root = '';
let storePath = '';
let store: JsonCredentialStore;

type CredentialResult = CredentialMetadataResult | CredentialReadResult | CredentialSaveResult;

function rejected(result: CredentialResult): CredentialFailure {
  if (result.kind !== 'rejected') throw new Error(`expected a rejected result, got ${result.kind}`);
  return result;
}

function saved(result: CredentialSaveResult): { revision: number; credentialRef: string } {
  if (result.kind !== 'saved') throw new Error(`expected a saved result, got ${result.kind}`);
  return { revision: result.revision, credentialRef: result.credentialRef };
}

type StoreFile = {
  schemaVersion: number;
  revision: number;
  entries: { credentialRef: string; secret: string }[];
};

function fileContents(): StoreFile {
  return JSON.parse(readFileSync(storePath, 'utf8')) as StoreFile;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-credentials-'));
  storePath = join(root, 'orca-companion', 'credentials.json');
  store = new JsonCredentialStore({ path: storePath });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test('缺失的 store 报告 revision 0 与空引用，读取按缺失拒绝', () => {
  expect(store.metadata()).toEqual({ kind: 'metadata', revision: 0, refs: [] });
  expect(rejected(store.read('00000000-0000-4000-8000-000000000000')).code).toBe('credential_missing');
});

test('路径按 XDG_CONFIG_HOME 选择，缺省时退回家目录 .config，显式 path 优先', () => {
  expect(credentialStorePath({ environment: { XDG_CONFIG_HOME: join(root, 'xdg') } })).toBe(
    join(root, 'xdg', 'orca-companion', 'credentials.json'),
  );
  expect(credentialStorePath({ environment: { XDG_CONFIG_HOME: '' }, homeDirectory: join(root, 'home') })).toBe(
    join(root, 'home', '.config', 'orca-companion', 'credentials.json'),
  );
  expect(credentialStorePath({ path: join(root, 'explicit.json') })).toBe(join(root, 'explicit.json'));
});

test('保存生成不可变引用，目录 0700、文件 0600，旧引用仍可读', () => {
  const first = saved(store.save({ expectedRevision: 0, secret: SECRET }));
  expect(first.revision).toBe(1);
  expect(store.read(first.credentialRef)).toEqual({ kind: 'resolved', secret: SECRET });

  const second = saved(store.save({ expectedRevision: 1, secret: 'sk-orca-second-value' }));
  expect(second.credentialRef).not.toBe(first.credentialRef);
  expect(second.revision).toBe(2);
  expect(store.read(first.credentialRef)).toEqual({ kind: 'resolved', secret: SECRET });
  expect(store.metadata()).toEqual({ kind: 'metadata', revision: 2, refs: [first.credentialRef, second.credentialRef] });

  expect(statSync(join(root, 'orca-companion')).mode & 0o777).toBe(0o700);
  expect(statSync(storePath).mode & 0o777).toBe(0o600);
  expect(fileContents().schemaVersion).toBe(CREDENTIAL_STORE_SCHEMA_VERSION);
});

test('并发保存按 expectedRevision 拒绝，磁盘内容不被覆盖', () => {
  const first = saved(store.save({ expectedRevision: 0, secret: SECRET }));
  expect(rejected(store.save({ expectedRevision: 0, secret: 'sk-other-writer' })).code).toBe('revision_conflict');
  expect(fileContents().revision).toBe(1);
  expect(store.read(first.credentialRef)).toEqual({ kind: 'resolved', secret: SECRET });
});

test('另一个写者持有锁时拒绝，锁释放后保存成功且不残留锁文件', () => {
  mkdirSync(join(root, 'orca-companion'), { mode: 0o700 });
  writeFileSync(`${storePath}.lock`, '', { mode: 0o600 });
  expect(rejected(store.save({ expectedRevision: 0, secret: SECRET })).code).toBe('lock_busy');
  // 读路径不参与写锁：替换是原子的，读到的始终是完整 store。
  expect(store.metadata()).toEqual({ kind: 'metadata', revision: 0, refs: [] });

  rmSync(`${storePath}.lock`);
  expect(saved(store.save({ expectedRevision: 0, secret: SECRET })).revision).toBe(1);
  expect(() => statSync(`${storePath}.lock`)).toThrow();
});

test('独立实例读到同一 revision，后写者看到最新状态', () => {
  const other = new JsonCredentialStore({ path: storePath });
  const first = saved(store.save({ expectedRevision: 0, secret: SECRET }));
  expect(other.metadata()).toEqual({ kind: 'metadata', revision: 1, refs: [first.credentialRef] });
  expect(rejected(other.save({ expectedRevision: 0, secret: 'sk-stale' })).code).toBe('revision_conflict');
  expect(saved(other.save({ expectedRevision: 1, secret: 'sk-fresh' })).revision).toBe(2);
  expect(store.metadata()).toMatchObject({ kind: 'metadata', revision: 2 });
});

test('宽松目录、宽松文件、符号链接与非普通文件一律拒绝且不改权限', () => {
  mkdirSync(join(root, 'orca-companion'), { mode: 0o755 });
  expect(rejected(store.metadata()).code).toBe('permission_denied');
  expect(rejected(store.save({ expectedRevision: 0, secret: SECRET })).code).toBe('permission_denied');
  expect(statSync(join(root, 'orca-companion')).mode & 0o777).toBe(0o755);

  chmodSync(join(root, 'orca-companion'), 0o700);
  mkdirSync(join(root, 'elsewhere'), { mode: 0o700 });
  writeFileSync(join(root, 'elsewhere', 'credentials.json'), JSON.stringify({}), { mode: 0o644 });
  symlinkSync(join(root, 'elsewhere', 'credentials.json'), storePath);
  expect(rejected(store.metadata()).code).toBe('store_invalid');
  expect(rejected(store.save({ expectedRevision: 0, secret: SECRET })).code).toBe('store_invalid');

  rmSync(storePath);
  writeFileSync(storePath, JSON.stringify({ schemaVersion: 1, revision: 0, entries: [] }), { mode: 0o644 });
  expect(rejected(store.metadata()).code).toBe('permission_denied');
  expect(statSync(storePath).mode & 0o777).toBe(0o644);
});

test('既有用户目录不 chmod，保存只创建自己的 store 目录', () => {
  const xdg = join(root, 'xdg');
  mkdirSync(xdg, { mode: 0o755 });
  const scoped = new JsonCredentialStore({ environment: { XDG_CONFIG_HOME: xdg } });
  const result = saved(scoped.save({ expectedRevision: 0, secret: SECRET }));
  expect(result.revision).toBe(1);
  expect(statSync(xdg).mode & 0o777).toBe(0o755);
  expect(statSync(join(xdg, 'orca-companion')).mode & 0o777).toBe(0o700);
});

test('损坏内容、未知 schemaVersion、重复引用与超限内容 fail closed', () => {
  mkdirSync(join(root, 'orca-companion'), { mode: 0o700 });
  const write = (contents: string) => writeFileSync(storePath, contents, { mode: 0o600 });

  write('{not json');
  expect(rejected(store.metadata()).code).toBe('store_invalid');

  write(JSON.stringify({ schemaVersion: 2, revision: 0, entries: [] }));
  expect(rejected(store.metadata()).code).toBe('store_invalid');

  const ref = '00000000-0000-4000-8000-000000000000';
  write(JSON.stringify({ schemaVersion: 1, revision: 2, entries: [{ credentialRef: ref, secret: SECRET }, { credentialRef: ref, secret: 'x' }] }));
  expect(rejected(store.metadata()).code).toBe('store_invalid');

  write(JSON.stringify({ schemaVersion: 1, revision: 0, entries: [{ credentialRef: 'not-a-uuid', secret: SECRET }] }));
  expect(rejected(store.read(ref)).code).toBe('store_invalid');

  write('x'.repeat(MAX_CREDENTIAL_STORE_BYTES + 1));
  expect(rejected(store.metadata()).code).toBe('store_too_large');
  expect(rejected(store.save({ expectedRevision: 0, secret: SECRET })).code).toBe('store_too_large');
});

test('单条超限 secret、未知引用与非法入参被拒绝', () => {
  expect(rejected(store.save({ expectedRevision: 0, secret: 'k'.repeat(MAX_CREDENTIAL_SECRET_BYTES + 1) })).code).toBe('invalid_request');
  expect(rejected(store.save({ expectedRevision: 0, secret: '' })).code).toBe('invalid_request');
  expect(rejected(store.save({ expectedRevision: -1, secret: SECRET })).code).toBe('invalid_request');
  expect(rejected(store.read('')).code).toBe('invalid_request');
  expect(rejected(store.read('00000000-0000-4000-8000-000000000000')).code).toBe('credential_missing');
  expect(() => statSync(storePath)).toThrow();
});

test('条目数上限拒绝继续追加', () => {
  mkdirSync(join(root, 'orca-companion'), { mode: 0o700 });
  const entries = Array.from({ length: MAX_CREDENTIAL_ENTRIES }, (_, index) => ({
    credentialRef: randomUUID(),
    secret: `k-${index}`,
  }));
  writeFileSync(storePath, JSON.stringify({ schemaVersion: CREDENTIAL_STORE_SCHEMA_VERSION, revision: MAX_CREDENTIAL_ENTRIES, entries }), {
    mode: 0o600,
  });
  expect(store.metadata()).toEqual({
    kind: 'metadata',
    revision: MAX_CREDENTIAL_ENTRIES,
    refs: entries.map((entry) => entry.credentialRef),
  });
  expect(rejected(store.save({ expectedRevision: MAX_CREDENTIAL_ENTRIES, secret: 'k-overflow' })).code).toBe('limit_exceeded');
  expect(fileContents().entries).toHaveLength(MAX_CREDENTIAL_ENTRIES);
});

test('失败结果与 metadata 都不含 secret', () => {
  const first = saved(store.save({ expectedRevision: 0, secret: SECRET }));
  const failures = [
    store.save({ expectedRevision: 0, secret: SECRET }),
    store.save({ expectedRevision: 0, secret: 'k'.repeat(MAX_CREDENTIAL_SECRET_BYTES + 1) }),
    store.read('00000000-0000-4000-8000-000000000000'),
    store.read(''),
  ];
  for (const failure of failures) {
    expect(JSON.stringify(rejected(failure))).not.toContain(SECRET);
  }
  expect(JSON.stringify(store.metadata())).not.toContain(SECRET);
  expect(JSON.stringify(store.metadata())).toContain(first.credentialRef);
});
