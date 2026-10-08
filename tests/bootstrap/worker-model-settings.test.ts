import { describe, expect, it } from 'vitest';

import type { WorkerHarness, WorkerHarnessRegistry, WorkerModelCatalogResult } from '../../src/application/ports/worker-harness.js';
import { createWorkerModelSettingsCatalog } from '../../src/bootstrap/worker-model-settings.js';

function registry(queryModels: WorkerHarness['queryModels']): WorkerHarnessRegistry {
  const harness = { id: 'codex', queryModels } as WorkerHarness;
  return new Map([['codex', harness]]);
}

function available(model: string, source = 'codex:test'): WorkerModelCatalogResult {
  return {
    kind: 'available',
    source,
    models: [{
      model,
      effortCapability: { values: ['low', 'high'], source },
    }],
  };
}

describe('worker model settings catalog', () => {
  it('verifies models and effort only from a successful native catalog query', async () => {
    const catalog = createWorkerModelSettingsCatalog({
      cwd: () => '/repo',
      env: {},
      registry: registry(() => Promise.resolve(available('native-model'))),
    });

    expect(catalog.verify({ harness: 'codex', model: 'native-model' })).toBeNull();
    const result = await catalog.query({ harness: 'codex' });

    expect(result.kind).toBe('available');
    expect(catalog.verify({ harness: 'codex', model: 'native-model' })).toEqual({
      catalogSource: 'codex:test',
      effortCapability: { values: ['low', 'high'], source: 'codex:test' },
    });
  });

  it('clears trusted provenance when a refresh fails or is cancelled', async () => {
    let fail = false;
    const catalog = createWorkerModelSettingsCatalog({
      cwd: () => '/repo',
      env: {},
      registry: registry(({ signal }) => Promise.resolve(
        signal?.aborted
          ? { kind: 'unavailable', code: 'cancelled', message: 'cancelled' }
          : fail
            ? { kind: 'unavailable', code: 'failed', message: 'failed' }
            : available('native-model'),
      )),
    });

    await catalog.query({ harness: 'codex' });
    fail = true;
    await catalog.query({ harness: 'codex' });
    expect(catalog.verify({ harness: 'codex', model: 'native-model' })).toBeNull();

    fail = false;
    await catalog.query({ harness: 'codex' });
    const controller = new AbortController();
    controller.abort();
    const cancelled = await catalog.query({ harness: 'codex', signal: controller.signal });
    expect(cancelled).toMatchObject({ kind: 'unavailable', code: 'catalog_query_cancelled' });
    expect(catalog.verify({ harness: 'codex', model: 'native-model' })).toBeNull();
  });

  it('does not let a late query replace the newer catalog result', async () => {
    const resolvers: ((value: WorkerModelCatalogResult) => void)[] = [];
    const catalog = createWorkerModelSettingsCatalog({
      cwd: () => '/repo',
      env: {},
      registry: registry(() => new Promise((resolve) => {
        resolvers.push(resolve);
      })),
    });

    const oldQuery = catalog.query({ harness: 'codex' });
    const newQuery = catalog.query({ harness: 'codex' });
    resolvers[0]?.(available('old-model', 'old-source'));
    await oldQuery;
    resolvers[1]?.(available('new-model', 'new-source'));
    await newQuery;

    expect(catalog.verify({ harness: 'codex', model: 'old-model' })).toBeNull();
    expect(catalog.verify({ harness: 'codex', model: 'new-model' })).toEqual({
      catalogSource: 'new-source',
      effortCapability: { values: ['low', 'high'], source: 'new-source' },
    });
  });
});
