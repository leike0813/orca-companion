/**
 * ledger-lab 只读采集器（schema 1）。
 *
 * 只做两件事：以只读方式查询被测仓库的 coordination store，以及调用公开的 Orca backend 查询通道。
 * 不写被测仓库、不创建 Scope/Controller/SQLite、不派发、不 ack、不调用任何 mutation，也不直接读
 * Orca 数据库。产物落盘由调用方 CLI 负责，本模块只返回一个 sample 对象。
 *
 * 采集纪律：
 * - store 只走已登记的只读 query kind，每个数组最多 1000 条；超限或读失败一律记 errors 并把
 *   sources.store.status 标成 unavailable，绝不返回看起来「没有记录」的空数组；
 * - 图目录用 graph-version-index 分页（每页 20，最多 5 页 / 100 版本），再逐条 graph-version 精确读；
 * - Scope 在采样前后各读一次，revision 不一致即 consistent=false；
 * - consistent 只断言 store 观测窗口内 Scope revision 稳定：采集器在关闭 store 之后才做 Orca 与 Git
 *   观察，因此 sample 不是跨源同一时刻的一致快照，consistent 不能跨源解释；
 * - Orca 只对已知 Run 各做一次 worker-list 封闭查询，保留完整 result，不把 ready 改写成 live，
 *   也不按 created 时间推断并行；
 * - Git 只读 `rev-parse HEAD` 与 `status --porcelain`；
 * - backend 的进程环境显式剥离 ORCA_* 可信身份，不接受宿主环境的隐式继承。
 */
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { URL } from 'node:url';

export const COLLECTOR_SCHEMA_VERSION = 1;
export const COLLECTOR_ID = 'ledger-lab-collector@1';
/** 单个数组记录上限；超出即失败，不静默截断成「空」。 */
export const MAX_RECORDS = 1000;
/** 图版本目录分页上限：5 页 × 20 = 100 个版本。 */
export const MAX_GRAPH_PAGES = 5;
export const GRAPH_PAGE_SIZE = 20;
/** Git 与 transport 的字节上限。 */
export const MAX_TRANSPORT_BYTES = 64 * 1024;
/** 公开 backend 单次查询的输出上限与超时，经 OrcaExecutionBackendOptions 显式传入。 */
export const BACKEND_OUTPUT_LIMITS = Object.freeze({ maxBytes: MAX_TRANSPORT_BYTES, maxLines: 20_000 });
export const BACKEND_QUERY_TIMEOUT_MS = 30_000;

const MAX_VERSION_INDEX = MAX_GRAPH_PAGES * GRAPH_PAGE_SIZE;
const ORCA_IDENTITY_ENV = /^ORCA_(?:TERMINAL|WORKER|TASK|RUN)(?:_|$)/u;
const DEFAULT_DIST = Object.freeze({
  composition: '../../dist/src/bootstrap/composition.js',
  backend: '../../dist/src/adapters/orca-cli/orca-backend.js',
  status: '../../dist/src/interfaces/cli/status-command.js',
});

let sampleSequence = 0;

const describeError = (error) => (error instanceof Error ? error.message : String(error));

function isoOf(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('now() 返回了无效时间');
  }
  return date.toISOString();
}

/** 剥离宿主注入的 ORCA_* 可信身份；其余变量原样保留。 */
export function trustedOrcaEnvironment(base = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(base ?? {})) {
    if (value === undefined || ORCA_IDENTITY_ENV.test(key)) {
      continue;
    }
    env[key] = value;
  }
  return env;
}

async function loadOptionalModule(relative) {
  try {
    return { ok: true, module: await import(new URL(relative, import.meta.url).href) };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

function rejectedError(result, kind) {
  if (result === undefined || result === null) {
    return { code: 'no_result', message: kind + ': store.query 未返回结果' };
  }
  if (result.kind === 'rejected') {
    return {
      code: typeof result.code === 'string' ? result.code : 'rejected',
      message: kind + ': ' + (typeof result.message === 'string' ? result.message : '被拒绝'),
    };
  }
  return { code: 'unexpected_result', message: kind + ': 期望 ' + kind + '，得到 ' + String(result.kind) };
}

/**
 * 精确读一条：kind 不符、rejected 或字段缺失都记 error，不把缺失当成空。
 *
 * 允许字段本身是 null（scope / version / record 等按生产类型可空），但结果里根本没有这个字段属于
 * 契约不符，必须报错而不是静默返回 null。
 */
function readOne(store, scopeId, kind, field, errors, extra = {}) {
  let result;
  try {
    result = store.query({ kind, coordinationScopeId: scopeId, ...extra });
  } catch (error) {
    errors.push({ code: 'query_threw', message: kind + ': ' + describeError(error) });
    return { ok: false, value: null };
  }
  if (result === undefined || result === null || result.kind !== kind) {
    errors.push(rejectedError(result, kind));
    return { ok: false, value: null };
  }
  if (!Object.hasOwn(result, field)) {
    errors.push({ code: 'missing_field', message: kind + ': 结果缺少 ' + field });
    return { ok: false, value: null };
  }
  return { ok: true, value: result[field] };
}

/** 读一个数组：非数组、超限或失败都记 error 并返回可用的部分。 */
function readList(store, scopeId, kind, field, errors, extra = {}) {
  const read = readOne(store, scopeId, kind, field, errors, extra);
  if (!read.ok) {
    return { ok: false, value: [] };
  }
  if (!Array.isArray(read.value)) {
    errors.push({ code: 'unexpected_result', message: kind + ': ' + field + ' 不是数组' });
    return { ok: false, value: [] };
  }
  if (read.value.length > MAX_RECORDS) {
    errors.push({
      code: 'too_many_records',
      message: kind + ': ' + String(read.value.length) + ' 条超过上限 ' + String(MAX_RECORDS) + '，结果被截断',
    });
    return { ok: false, value: read.value.slice(0, MAX_RECORDS) };
  }
  return { ok: true, value: read.value };
}

/** 图版本目录：keyset 分页，最多 5 页 / 100 版本，超出即失败。 */
function readGraphIndex(store, scopeId, errors) {
  const items = [];
  let cursor = null;
  let pages = 0;
  for (;;) {
    let result;
    try {
      result = store.query({
        kind: 'graph-version-index',
        coordinationScopeId: scopeId,
        ...(cursor === null ? {} : { after: cursor }),
      });
    } catch (error) {
      errors.push({ code: 'query_threw', message: 'graph-version-index: ' + describeError(error) });
      return { ok: false, items: [] };
    }
    if (result === undefined || result === null || result.kind !== 'graph-version-index') {
      errors.push(rejectedError(result, 'graph-version-index'));
      return { ok: false, items };
    }
    if (!Array.isArray(result.items)) {
      errors.push({ code: 'unexpected_result', message: 'graph-version-index: items 不是数组' });
      return { ok: false, items };
    }
    pages += 1;
    items.push(...result.items);
    if (items.length > MAX_VERSION_INDEX) {
      errors.push({
        code: 'version_index_truncated',
        message: 'graph-version-index: 超过 ' + String(MAX_VERSION_INDEX) + ' 个版本，目录被截断',
      });
      return { ok: false, items: items.slice(0, MAX_VERSION_INDEX) };
    }
    if (result.nextCursor === null || result.nextCursor === undefined) {
      return { ok: true, items };
    }
    if (pages >= MAX_GRAPH_PAGES) {
      errors.push({
        code: 'version_index_truncated',
        message: 'graph-version-index: 已达 ' + String(MAX_GRAPH_PAGES) + ' 页仍有下一页，目录被截断',
      });
      return { ok: false, items };
    }
    cursor = result.nextCursor;
  }
}

/** 待答问题分页读；上限按 MAX_RECORDS 收口。 */
function readInteractions(store, scopeId, errors) {
  const items = [];
  let after = null;
  for (;;) {
    let result;
    try {
      result = store.query({
        kind: 'pending-interactions',
        coordinationScopeId: scopeId,
        ...(after === null ? {} : { after }),
      });
    } catch (error) {
      errors.push({ code: 'query_threw', message: 'pending-interactions: ' + describeError(error) });
      return { ok: false, items };
    }
    if (result === undefined || result === null || result.kind !== 'pending-interactions') {
      errors.push(rejectedError(result, 'pending-interactions'));
      return { ok: false, items };
    }
    if (!Array.isArray(result.interactions)) {
      errors.push({ code: 'unexpected_result', message: 'pending-interactions: interactions 不是数组' });
      return { ok: false, items };
    }
    items.push(...result.interactions);
    if (items.length > MAX_RECORDS) {
      errors.push({
        code: 'too_many_records',
        message: 'pending-interactions: 超过上限 ' + String(MAX_RECORDS) + '，结果被截断',
      });
      return { ok: false, items: items.slice(0, MAX_RECORDS) };
    }
    if (result.nextCursor === null || result.nextCursor === undefined) {
      return { ok: true, items };
    }
    after = result.nextCursor;
  }
}

/** 从 accepted 的 worker-list payload 取出 workers 数组；取不到返回 null。 */
function readWorkerList(result) {
  if (
    result === undefined ||
    result === null ||
    result.kind !== 'accepted' ||
    typeof result.value !== 'object' ||
    result.value === null ||
    !Array.isArray(result.value.workers)
  ) {
    return null;
  }
  return result.value.workers;
}

/**
 * workers 是否显式声明了完整覆盖。
 *
 * 生产 adapter 的 worker-list 只解析出 workers 数组，没有 coverage 元数据，因此真实样本这里恒为
 * false：被拒绝、unknown、截断，或只是 accepted 而没有覆盖标识，都不算证明完整。只有 payload 明确
 * 带 coverage 为 complete 才置 true。complete 是强证据，缺失时由验收方按 INCONCLUSIVE 处理；即便
 * complete 为 true 也不承诺没有更多 Worker，只证明这份 payload 自证覆盖完整。workers 本身与
 * complete 无关，始终保留可用的正证据。
 */
function isCompleteWorkerList(result, workers) {
  return (
    workers !== null &&
    result.value.coverage === 'complete' &&
    result.value.truncated !== true &&
    (result.value.nextCursor ?? null) === null
  );
}

function runGit(repositoryPath, args) {
  try {
    const result = spawnSync('git', args, {
      cwd: repositoryPath,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: MAX_TRANSPORT_BYTES,
      windowsHide: true,
    });
    if (result.error !== undefined && result.error !== null) {
      return { ok: false, message: describeError(result.error) };
    }
    if (result.status !== 0) {
      const detail = (result.stderr ?? '').trim();
      return { ok: false, message: detail.length > 0 ? detail : 'git ' + args.join(' ') + ' 退出码 ' + String(result.status) };
    }
    return { ok: true, stdout: result.stdout ?? '' };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

/** Git 观察：只读 HEAD 与 porcelain 状态，绝不在目标仓库执行写操作。 */
function readGit(repositoryPath) {
  const errors = [];
  const head = runGit(repositoryPath, ['rev-parse', 'HEAD']);
  const porcelain = runGit(repositoryPath, ['--no-optional-locks', 'status', '--porcelain']);
  if (!head.ok) {
    errors.push({ code: 'git_head_failed', message: 'rev-parse HEAD: ' + head.message });
  }
  if (!porcelain.ok) {
    errors.push({ code: 'git_status_failed', message: 'status --porcelain: ' + porcelain.message });
  }
  const headValue = head.ok ? (head.stdout.trim().split('\n')[0] ?? '') || null : null;
  const dirtyPaths = porcelain.ok
    ? porcelain.stdout
        .split(/\r?\n/u)
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0)
    : [];
  return {
    status: head.ok && porcelain.ok ? 'available' : 'unavailable',
    head: headValue,
    dirtyPaths,
    errors,
  };
}

/**
 * 采集一个只读 sample。
 *
 * @param {{
 *   repositoryPath: string,
 *   coordinationScopeId: string,
 *   store?: { query: (request: object) => object },
 *   backend?: { query: (input: object) => Promise<object> },
 *   statusBuilder?: (store: object, coordinationScopeId: string) => object,
 *   now?: () => Date | number | string,
 *   env?: Record<string, string | undefined>,
 *   collectorId?: string,
 * }} options
 */
export async function collectSample(options = {}) {
  const repositoryPath = options.repositoryPath;
  const coordinationScopeId = options.coordinationScopeId;
  if (typeof repositoryPath !== 'string' || repositoryPath.length === 0) {
    throw new Error('collectSample 需要 repositoryPath');
  }
  if (typeof coordinationScopeId !== 'string' || coordinationScopeId.length === 0) {
    throw new Error('collectSample 需要 coordinationScopeId');
  }
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const startedAt = isoOf(now());

  const storeErrors = [];
  const orcaErrors = [];
  let store = options.store ?? null;
  let closeOpenedStore = null;
  let storeUnavailable = null;

  if (store === null) {
    const loaded = await loadOptionalModule(DEFAULT_DIST.composition);
    if (!loaded.ok) {
      storeUnavailable = '无法加载 dist/src/bootstrap/composition.js：' + loaded.message;
    } else if (typeof loaded.module.openRepositoryCoordinationStore !== 'function') {
      storeUnavailable = 'dist 中的 composition 模块缺少 openRepositoryCoordinationStore';
    } else {
      let opened;
      try {
        opened = await loaded.module.openRepositoryCoordinationStore({ repositoryPath, readOnly: true });
      } catch (error) {
        opened = { kind: 'failed', message: describeError(error) };
      }
      if (opened !== null && opened !== undefined && opened.kind === 'opened' && opened.store !== undefined) {
        store = opened.store;
        closeOpenedStore = typeof opened.close === 'function' ? opened.close.bind(opened) : null;
      } else {
        storeUnavailable = 'openRepositoryCoordinationStore 失败：' + (opened?.message ?? '未知原因');
      }
    }
  }
  if (storeUnavailable !== null) {
    storeErrors.push({ code: 'store_unavailable', message: storeUnavailable });
  }

  let status = null;
  let generations = [];
  let graphs = [];
  let patches = [];
  let bindings = [];
  let segments = [];
  let settlements = [];
  let recoveries = [];
  let holds = [];
  let reconciliations = [];
  let adoptions = [];
  let lineages = [];
  let intents = [];
  let budgets = [];
  let verdicts = [];
  let authorizations = [];
  let handoffs = [];
  let planningHandoffs = [];
  let interactions = [];
  let leases = [];
  let scope = null;
  let consistent = false;

  try {
    if (store !== null) {
      const scopeBefore = readOne(store, coordinationScopeId, 'scope', 'scope', storeErrors);
      scope = scopeBefore.ok ? scopeBefore.value : null;
      if (scopeBefore.ok && scopeBefore.value === null) {
        storeErrors.push({ code: 'scope_missing', message: 'coordinationScopeId ' + coordinationScopeId + ' 不存在' });
      }

      generations = readList(store, coordinationScopeId, 'graph-generations', 'generations', storeErrors).value;
      const graphIndex = readGraphIndex(store, coordinationScopeId, storeErrors);
      for (const metadata of graphIndex.items) {
        const graphId = metadata?.graphId;
        const graphVersion = metadata?.version;
        if (typeof graphId !== 'string' || typeof graphVersion !== 'number') {
          storeErrors.push({ code: 'invalid_version_metadata', message: 'graph-version-index: 缺少 graphId 或 version' });
          continue;
        }
        const read = readOne(store, coordinationScopeId, 'graph-version', 'version', storeErrors, { graphId, graphVersion });
        if (read.ok && read.value !== null) {
          graphs.push(read.value);
        } else if (read.ok) {
          storeErrors.push({
            code: 'graph_version_missing',
            message: 'graph-version: 目录列出 ' + graphId + '@v' + String(graphVersion) + ' 但精确读取为空',
          });
        }
      }
      for (const record of graphs) {
        if (record.recordKind !== 'accepted_revision' || record.patchId === null || record.patchId === undefined) {
          continue;
        }
        const read = readOne(store, coordinationScopeId, 'graph-patch-record', 'record', storeErrors, {
          graphId: record.graphId,
          graphVersion: record.version,
        });
        if (read.ok && read.value !== null) {
          patches.push(read.value);
        } else if (read.ok) {
          storeErrors.push({
            code: 'graph_patch_missing',
            message: 'graph-patch-record: accepted revision ' + String(record.graphId) + '@v' + String(record.version) + ' 缺少补丁记录',
          });
        }
      }
      bindings = readList(store, coordinationScopeId, 'materialization-bindings', 'bindings', storeErrors).value;
      segments = readList(store, coordinationScopeId, 'session-segments', 'segments', storeErrors).value;
      settlements = readList(store, coordinationScopeId, 'delivery-settlements', 'settlements', storeErrors).value;
      recoveries = readList(store, coordinationScopeId, 'recoveries', 'recoveries', storeErrors).value;
      holds = readList(store, coordinationScopeId, 'revision-holds', 'holds', storeErrors).value;
      reconciliations = readList(store, coordinationScopeId, 'baseline-reconciliations', 'reconciliations', storeErrors).value;
      adoptions = readList(store, coordinationScopeId, 'baseline-adoptions', 'adoptions', storeErrors).value;
      lineages = readList(store, coordinationScopeId, 'work-package-lineages', 'lineages', storeErrors).value;
      intents = readList(store, coordinationScopeId, 'intents', 'intents', storeErrors).value;
      budgets = readList(store, coordinationScopeId, 'budget-counters', 'counters', storeErrors).value;
      verdicts = readList(store, coordinationScopeId, 'delivery-verdicts', 'verdicts', storeErrors).value;
      authorizations = readList(store, coordinationScopeId, 'authorizations', 'authorizations', storeErrors).value;
      handoffs = readList(store, coordinationScopeId, 'execution-handoffs', 'handoffs', storeErrors).value;
      planningHandoffs = readList(store, coordinationScopeId, 'planning-handoffs', 'handoffs', storeErrors).value;
      leases = readList(store, coordinationScopeId, 'leases', 'leases', storeErrors).value;
      interactions = readInteractions(store, coordinationScopeId, storeErrors).items;

      let statusBuilder = typeof options.statusBuilder === 'function' ? options.statusBuilder : null;
      if (statusBuilder === null) {
        const loaded = await loadOptionalModule(DEFAULT_DIST.status);
        if (loaded.ok && typeof loaded.module.buildStatusSnapshot === 'function') {
          statusBuilder = loaded.module.buildStatusSnapshot;
        } else {
          storeErrors.push({
            code: 'status_unavailable',
            message: '无法加载 buildStatusSnapshot：' + (loaded.ok ? '缺少导出' : loaded.message),
          });
        }
      }
      if (statusBuilder !== null) {
        try {
          const built = statusBuilder(store, coordinationScopeId);
          if (built !== null && built !== undefined && built.kind === 'snapshot') {
            status = built.snapshot ?? null;
          } else {
            storeErrors.push({ code: 'status_failed', message: built?.message ?? '状态投影失败' });
          }
        } catch (error) {
          storeErrors.push({ code: 'status_threw', message: describeError(error) });
        }
      }

      const scopeAfter = readOne(store, coordinationScopeId, 'scope', 'scope', storeErrors);
      if (scope === null && scopeAfter.ok) {
        scope = scopeAfter.value;
      }
      const beforeRevision = scopeBefore.ok && scopeBefore.value !== null ? scopeBefore.value.revision : null;
      const afterRevision = scopeAfter.ok && scopeAfter.value !== null ? scopeAfter.value.revision : null;
      if (storeUnavailable !== null || beforeRevision === null || afterRevision === null) {
        consistent = false;
      } else if (beforeRevision !== afterRevision) {
        consistent = false;
        storeErrors.push({
          code: 'scope_revision_changed',
          message: 'Scope ' + coordinationScopeId + ' 采样期间 revision 从 ' + String(beforeRevision) + ' 变为 ' + String(afterRevision),
        });
      } else {
        consistent = true;
      }
    }
  } finally {
    if (closeOpenedStore !== null) {
      try {
        closeOpenedStore();
      } catch {
        // 关闭失败不影响已采集的事实。
      }
    }
  }

  const runIds = [];
  for (const generation of generations) {
    const runId = generation?.orcaRunId;
    if (typeof runId === 'string' && runId.length > 0 && !runIds.includes(runId)) {
      runIds.push(runId);
    }
  }
  let backend = options.backend ?? null;
  if (backend === null) {
    const loaded = await loadOptionalModule(DEFAULT_DIST.backend);
    if (loaded.ok && typeof loaded.module.createOrcaExecutionBackend === 'function') {
      try {
        backend = loaded.module.createOrcaExecutionBackend({
          cwd: repositoryPath,
          env: trustedOrcaEnvironment(options.env ?? process.env),
          defaultTimeoutMs: BACKEND_QUERY_TIMEOUT_MS,
          limits: { maxBytes: BACKEND_OUTPUT_LIMITS.maxBytes, maxLines: BACKEND_OUTPUT_LIMITS.maxLines },
        });
      } catch (error) {
        orcaErrors.push({ code: 'backend_failed', message: describeError(error) });
        backend = null;
      }
    } else {
      orcaErrors.push({
        code: 'backend_unavailable',
        message: '无法加载 createOrcaExecutionBackend：' + (loaded.ok ? '缺少导出' : loaded.message),
      });
      backend = null;
    }
  }
  const runs = [];
  for (const runId of runIds) {
    if (backend === null) {
      break;
    }
    let result;
    try {
      result = await backend.query({ operation: 'worker-list', runId });
    } catch (error) {
      orcaErrors.push({ code: 'worker_list_threw', message: 'worker-list ' + runId + ': ' + describeError(error) });
      runs.push({ runId, complete: false, workers: null, result: null });
      continue;
    }
    if (result === undefined || result === null || result.kind !== 'accepted') {
      const code = result !== null && result !== undefined && typeof result.code === 'string' ? result.code : 'worker_list_rejected';
      const message = result !== null && result !== undefined && typeof result.message === 'string' ? result.message : 'worker-list 未返回可用的 accepted 结果';
      orcaErrors.push({ code, message: 'worker-list ' + runId + ': ' + message });
    }
    const workers = readWorkerList(result);
    const complete = isCompleteWorkerList(result, workers);
    runs.push({
      runId,
      complete,
      workers,
      result,
    });
  }
  const orcaStatus = backend === null || orcaErrors.length > 0 ? 'unavailable' : 'available';

  const git = readGit(repositoryPath);

  sampleSequence += 1;
  const observedAt = isoOf(now());
  const collectorId = typeof options.collectorId === 'string' && options.collectorId.length > 0 ? options.collectorId : COLLECTOR_ID;
  const sampleId = collectorId + '#' + String(sampleSequence) + '@' + observedAt;
  const storeStatus = storeErrors.length === 0 ? 'available' : 'unavailable';

  return {
    schemaVersion: COLLECTOR_SCHEMA_VERSION,
    kind: 'sample',
    sampleId,
    collectorId,
    repositoryPath,
    coordinationScopeId,
    startedAt,
    observedAt,
    sources: {
      store: { status: storeStatus, consistent, errors: storeErrors },
      orca: { status: orcaStatus, runs, errors: orcaErrors },
      git: { status: git.status, head: git.head, dirtyPaths: git.dirtyPaths },
    },
    snapshot: {
      scope,
      generations,
      graphs,
      patches,
      bindings,
      segments,
      settlements,
      recoveries,
      holds,
      reconciliations,
      adoptions,
      lineages,
      intents,
      budgets,
      verdicts,
      authorizations,
      handoffs,
      planningHandoffs,
      interactions,
      leases,
      status,
    },
  };
}
