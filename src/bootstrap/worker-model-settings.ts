import type { WorkerSelectionVerification } from '../application/configuration/model-settings.js';
import type { WorkerModelCatalogResult, WorkerHarnessRegistry } from '../application/ports/worker-harness.js';
import { resolveWorkerHarness } from '../application/ports/worker-harness.js';
import { workerHarnessRegistry } from './worker-harness.js';
import type { WorkerHarnessId } from '../domain/model-configuration.js';
import { WORKER_HARNESS_IDS } from '../domain/model-configuration.js';

export function createWorkerModelSettingsCatalog(options: {
  readonly cwd: () => string;
  readonly env: Readonly<Record<string, string>>;
  readonly registry?: WorkerHarnessRegistry;
}) {
  const registry = options.registry ?? workerHarnessRegistry;
  const catalog = new Map<WorkerHarnessId, Extract<WorkerModelCatalogResult, { kind: 'available' }>>();
  const queries = new Map<WorkerHarnessId, object>();

  const query = async (input: {
    readonly harness: WorkerHarnessId;
    readonly signal?: AbortSignal;
  }): Promise<WorkerModelCatalogResult> => {
    const token = {};
    queries.set(input.harness, token);
    catalog.delete(input.harness);
    const resolved = resolveWorkerHarness(registry, input.harness);
    if (resolved.kind === 'rejected') {
      catalog.delete(input.harness);
      return { kind: 'unavailable', code: resolved.code, message: resolved.message };
    }
    const result = await resolved.harness.queryModels({
      cwd: options.cwd(),
      env: options.env,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (input.signal?.aborted || queries.get(input.harness) !== token) {
      return { kind: 'unavailable', code: 'catalog_query_cancelled', message: '目录查询已取消' };
    }
    if (result.kind !== 'available') {
      catalog.delete(input.harness);
      return { kind: 'unavailable', code: result.code, message: result.message };
    }
    catalog.set(input.harness, result);
    return { kind: 'available', source: result.source, models: result.models };
  };

  const verify = (input: { readonly harness: string; readonly model: string }): WorkerSelectionVerification | null => {
    if (!(WORKER_HARNESS_IDS as readonly string[]).includes(input.harness)) return null;
    const entry = catalog.get(input.harness as WorkerHarnessId);
    if (entry === undefined) return null;
    const found = entry.models.find((candidate) => candidate.model === input.model);
    return found === undefined ? null : { catalogSource: entry.source, effortCapability: found.effortCapability };
  };

  return { query, verify, get: (harness: WorkerHarnessId) => catalog.get(harness) ?? null };
}
