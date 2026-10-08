import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { createLedgerLabConfigurationHost, requireLedgerLabConfiguration } from '../../src/bootstrap/ledger-lab.js';
import type { CredentialStore } from '../../src/application/ports/credential-store.js';
import type { ProviderCatalog } from '../../src/application/configuration/provider-catalog.js';
import { MODEL_PROFILE_ROLES } from '../../src/domain/model-configuration.js';
import type { ModelProfileRole } from '../../src/domain/model-configuration.js';

let root = '';
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'orca-ledger-lab-config-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const ref = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function fakeCredentials() {
  let revision = 0;
  let nextRef = 1;
  const secrets: string[] = [];
  const store: CredentialStore = {
    metadata: () => ({ kind: 'metadata', revision, refs: secrets.map((_, i) => ref(i + 1)) }),
    read: (credentialRef) => secrets[Number(credentialRef.slice(-12)) - 1] === undefined
      ? { kind: 'rejected', code: 'credential_missing', message: '凭据不存在' }
      : { kind: 'resolved', secret: secrets[Number(credentialRef.slice(-12)) - 1]! },
    save: ({ secret }) => {
      const credentialRef = ref(nextRef++);
      secrets.push(secret);
      revision += 1;
      return { kind: 'saved', revision, credentialRef };
    },
  };
  return { store, secrets };
}

function saveInput(modelRef: string) {
  return {
    coordinator: { modelRef, effort: null },
    workers: MODEL_PROFILE_ROLES.map((role: ModelProfileRole) => ({
      role,
      harness: 'codex',
      modelSelection: { model: `worker-${role}`, effort: null, effortCapability: null, catalogSource: null },
    })),
    maxMutations: 5,
    maxInputTokens: 16_000,
  };
}

function host(configPath: string, credentials: CredentialStore) {
  const catalog: ProviderCatalog = {
    presets: () => [],
    candidates: () => ({ models: [], source: 'catalog', catalogVersion: 'fixture', expired: false }),
    discover: () => Promise.resolve({ models: [], source: 'catalog', catalogVersion: 'fixture', expired: false }),
    refresh: () => Promise.resolve({ kind: 'unchanged', catalogVersion: 'fixture' }),
  };
  return createLedgerLabConfigurationHost({
    configPath,
    env: { XDG_CONFIG_HOME: dirname(configPath) },
    credentials,
    catalog,
    verifyWorkerSelection: () => null,
  });
}

async function modelRef(settings: ReturnType<typeof host>, model = 'gpt-4.1-mini') {
  const library = settings.providerLibrary;
  let loaded = library.load();
  if (loaded.kind !== 'loaded') throw new Error(`provider library unavailable: ${loaded.message}`);
  let connectionRef = loaded.connections[0]?.connectionRef;
  if (!connectionRef) {
    const connection = await library.saveConnection({ expectedRevision: loaded.revision, label: 'Fixture provider', providerId: 'custom',
      providerIntegration: 'openai-chat', baseUrl: 'https://api.fixture.invalid/v1', newSecret: 'sk-ledger-lab-test-secret' });
    if (connection.kind !== 'saved') throw new Error(connection.message);
    connectionRef = connection.connection.connectionRef;
    loaded = library.load();
  }
  if (loaded.kind !== 'loaded') throw new Error(`provider library unavailable: ${loaded.message}`);
  const saved = library.saveModel({ expectedRevision: loaded.revision, connectionRef, model });
  if (saved.kind !== 'saved') throw new Error(saved.message);
  return saved.model.modelRef;
}

test('首次保存创建完整 schema 5 配置并选中 Coordinator 凭据引用', async () => {
  const { store: credentials } = fakeCredentials();
  const settings = host(join(root, 'orca-companion.json'), credentials);

  const saved = settings.save(saveInput(await modelRef(settings)));

  expect(saved.schemaVersion).toBe(5);
  expect(saved.revision).toBe(1);
  expect(saved.defaultCoordinatorModelRef).toBe(saved.coordinatorModels.at(-1)?.configurationRef);
  expect(saved.coordinatorModels.at(-1)?.credentialRefs).toEqual([ref(1)]);
  expect(saved.execution.workerProfiles.map(({ role }) => role)).toEqual(MODEL_PROFILE_ROLES);
  expect(Object.keys(saved.execution.workerProfileRefs).sort()).toEqual([...MODEL_PROFILE_ROLES].sort());
  expect(requireLedgerLabConfiguration(saved)).toEqual(saved);
});

test('重新配置保留不可变历史且整次操作只推进一次 revision', async () => {
  const { store: credentials } = fakeCredentials();
  const settings = host(join(root, 'orca-companion.json'), credentials);
  const first = settings.save(saveInput(await modelRef(settings)));

  const second = settings.save(saveInput(await modelRef(settings, 'gpt-4.1-mini-next')));

  expect(second.revision).toBe(first.revision + 1);
  expect(second.coordinatorModels.slice(0, -1)).toEqual(first.coordinatorModels);
  expect(second.execution.workerProfiles.slice(0, MODEL_PROFILE_ROLES.length)).toEqual(first.execution.workerProfiles);
  expect(second.coordinatorModels.at(-1)?.configurationRef).not.toBe(first.defaultCoordinatorModelRef);
  expect(second.execution.workerProfiles).toHaveLength(first.execution.workerProfiles.length + MODEL_PROFILE_ROLES.length);
});

test('Coordinator API Key 只进入用户凭据库，不进入项目配置', async () => {
  const configPath = join(root, 'orca-companion.json');
  const { store: credentials, secrets } = fakeCredentials();
  const settings = host(configPath, credentials);

  settings.save(saveInput(await modelRef(settings)));
  expect(secrets).toEqual(['sk-ledger-lab-test-secret']);
  expect(readFileSync(configPath, 'utf8')).not.toContain('sk-ledger-lab-test-secret');
});

test('缺少任一 Worker role 时配置不满足 ledger-lab 要求', async () => {
  const settings = host(join(root, 'orca-companion.json'), fakeCredentials().store);
  const saved = settings.save(saveInput(await modelRef(settings)));
  const incomplete = {
    ...saved,
    execution: {
      ...saved.execution,
      workerProfileRefs: Object.fromEntries(Object.entries(saved.execution.workerProfileRefs).filter(([role]) => role !== 'validator')),
    },
  };

  expect(() => requireLedgerLabConfiguration(incomplete)).toThrow(/validator/);
});

test('向导读到的配置变旧时拒绝覆盖其他进程的新配置', async () => {
  const configPath = join(root, 'orca-companion.json');
  const credentials = fakeCredentials().store;
  const settings = host(configPath, credentials);
  settings.save(saveInput(await modelRef(settings)));
  settings.read();
  const concurrentHost = host(configPath, credentials);
  const concurrent = concurrentHost.save(saveInput(await modelRef(concurrentHost, 'gpt-4.1-mini-next')));

  expect(() => settings.save(saveInput(concurrent.models[0]!.modelRef))).toThrow();
  expect(settings.read()).toMatchObject({ kind: 'read', config: concurrent });
});
