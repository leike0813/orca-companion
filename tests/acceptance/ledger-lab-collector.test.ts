import { describe, expect, it } from 'vitest';
import process from 'node:process';

/**
 * ledger-lab 只读采集器的行为测试。
 *
 * 只注入 mock store / backend / statusBuilder，绝不触碰真实 Orca 或模型；Git 观察走进程内只读命令。
 * 采集器是 .mjs，因此用变量化动态 import + 接口断言加载，避免 TS 找不到声明文件（TS7016）。
 */

type Request = Record<string, unknown>;

type CollectorError = { code: string; message: string };
type SampleRun = { runId: string; complete: boolean; workers: Request[] | null; result: unknown };
type Sample = {
  schemaVersion: number;
  kind: string;
  sampleId: string;
  collectorId: string;
  repositoryPath: string;
  coordinationScopeId: string;
  startedAt: string;
  observedAt: string;
  sources: {
    store: { status: string; consistent: boolean; errors: CollectorError[] };
    orca: { status: string; runs: SampleRun[]; errors: CollectorError[] };
    git: { status: string; head: string | null; dirtyPaths: string[] };
  };
  snapshot: {
    scope: Request | null;
    generations: Request[];
    graphs: Request[];
    patches: Request[];
    bindings: Request[];
    segments: Request[];
    settlements: Request[];
    recoveries: Request[];
    holds: Request[];
    reconciliations: Request[];
    adoptions: Request[];
    lineages: Request[];
    intents: Request[];
    budgets: Request[];
    verdicts: Request[];
    authorizations: Request[];
    handoffs: Request[];
    planningHandoffs: Request[];
    interactions: Request[];
    leases: Request[];
    status: Request | null;
  };
};

type StoreLike = { query(request: Request): unknown };
type BackendLike = { query(input: Request): Promise<unknown>; mutate(...args: never[]): never };
type CollectOptions = {
  repositoryPath: string;
  coordinationScopeId: string;
  store?: StoreLike;
  backend?: BackendLike;
  statusBuilder?: (store: StoreLike, coordinationScopeId: string) => unknown;
  now?: () => Date | number | string;
  env?: Record<string, string | undefined>;
  collectorId?: string;
};
type CollectorModule = {
  collectSample(options: CollectOptions): Promise<Sample>;
  COLLECTOR_ID: string;
  MAX_RECORDS: number;
  MAX_GRAPH_PAGES: number;
  trustedOrcaEnvironment(base: Record<string, string | undefined>): Record<string, string>;
};

const collectorHref = new URL('../../artifacts/ledger-lab/collector.mjs', import.meta.url).href;
const collector = (await import(/* @vite-ignore */ collectorHref)) as CollectorModule;

type ProcessCheck = { id: string; status: string; message: string; evidence: string[] };
type ProcessReport = { status: string; checks: ProcessCheck[] };
type ProcessVerifierModule = {
  verifyProcess(input: { samples: Sample[]; mapping: unknown; observations: unknown; profile?: string }): ProcessReport;
};
const verifierHref = new URL('../../artifacts/ledger-lab/process-verifier.mjs', import.meta.url).href;
const verifier = (await import(/* @vite-ignore */ verifierHref)) as ProcessVerifierModule;

const SCOPE_ID = 'scope-1';
const RUN_ID = 'run-alpha';
const REPO = process.cwd();
const FIXED_NOW = (): Date => new Date('2026-01-01T00:00:00.000Z');

const scopeRecord: Request = {
  coordinationScopeId: SCOPE_ID,
  revision: 7,
  mode: 'execution_coordination',
  controlState: 'active',
  planningCycleId: 'cycle-1',
  mapRevision: 3,
  graphId: 'graph-1',
  graphVersion: 1,
  authorizationId: null,
  authorizationVersion: null,
  fullBranchRef: 'refs/heads/main',
  canonicalWorktreePath: null,
};
const generation: Request = {
  coordinationScopeId: SCOPE_ID,
  graphId: 'graph-1',
  generation: 1,
  planningCycleId: 'cycle-1',
  orcaRunId: RUN_ID,
  predecessorGraphId: null,
  baselineHead: 'baseline',
  status: 'active',
  createdAt: 1,
  updatedAt: 1,
};
const versionMetadata: Request = {
  graphId: 'graph-1',
  generation: 1,
  version: 1,
  recordKind: 'initial',
  parentVersion: null,
  patchId: null,
  mapRevision: 3,
  planRevision: 1,
  orcaRunId: RUN_ID,
  recordedAt: 1,
  generationStatus: 'active',
  current: true,
};
const graphVersion: Request = {
  graphId: 'graph-1',
  generation: 1,
  version: 1,
  recordKind: 'initial',
  parentVersion: null,
  patchId: null,
  mapRevision: 3,
  planRevision: 1,
  orcaRunId: RUN_ID,
  recordedAt: 1,
  graph: { workPackages: [] },
};

/** 采集器会读取的全部只读 query kind；出现集合之外即视为越界。 */
const READ_KINDS = new Set([
  'scope',
  'graph-generations',
  'graph-version-index',
  'graph-version',
  'graph-patch-record',
  'materialization-bindings',
  'session-segments',
  'delivery-settlements',
  'recoveries',
  'revision-holds',
  'baseline-reconciliations',
  'baseline-adoptions',
  'work-package-lineages',
  'intents',
  'budget-counters',
  'delivery-verdicts',
  'authorizations',
  'execution-handoffs',
  'planning-handoffs',
  'leases',
  'pending-interactions',
]);

const emptyList = (kind: string, field: string) => () => ({ kind, [field]: [] });

function defaultHandlers(): Record<string, (request: Request, count: number) => unknown> {
  return {
    scope: () => ({ kind: 'scope', scope: scopeRecord }),
    'graph-generations': () => ({ kind: 'graph-generations', generations: [generation] }),
    'graph-version-index': () => ({ kind: 'graph-version-index', items: [versionMetadata], nextCursor: null }),
    'graph-version': () => ({ kind: 'graph-version', version: graphVersion }),
    'graph-patch-record': () => ({ kind: 'graph-patch-record', record: null }),
    'materialization-bindings': emptyList('materialization-bindings', 'bindings'),
    'session-segments': emptyList('session-segments', 'segments'),
    'delivery-settlements': emptyList('delivery-settlements', 'settlements'),
    recoveries: emptyList('recoveries', 'recoveries'),
    'revision-holds': emptyList('revision-holds', 'holds'),
    'baseline-reconciliations': emptyList('baseline-reconciliations', 'reconciliations'),
    'baseline-adoptions': emptyList('baseline-adoptions', 'adoptions'),
    'work-package-lineages': emptyList('work-package-lineages', 'lineages'),
    intents: emptyList('intents', 'intents'),
    'budget-counters': emptyList('budget-counters', 'counters'),
    'delivery-verdicts': emptyList('delivery-verdicts', 'verdicts'),
    authorizations: emptyList('authorizations', 'authorizations'),
    'execution-handoffs': emptyList('execution-handoffs', 'handoffs'),
    'planning-handoffs': emptyList('planning-handoffs', 'handoffs'),
    leases: emptyList('leases', 'leases'),
    'pending-interactions': () => ({ kind: 'pending-interactions', interactions: [], nextCursor: null }),
  };
}

function buildStore(overrides: Record<string, (request: Request, count: number) => unknown> = {}) {
  const log: Request[] = [];
  const counts = new Map<string, number>();
  const handlers = defaultHandlers();
  const store: StoreLike = {
    query(request: Request) {
      log.push(request);
      const kind = String(request['kind']);
      const count = (counts.get(kind) ?? 0) + 1;
      counts.set(kind, count);
      const handler = overrides[kind] ?? handlers[kind];
      if (handler === undefined) {
        return { kind: 'rejected', code: 'unregistered', message: 'unregistered ' + kind };
      }
      return handler(request, count);
    },
  };
  return { store, log };
}

function buildBackend(respond: (input: Request) => unknown) {
  const calls: Request[] = [];
  const state = { mutated: false };
  const backend: BackendLike = {
    query(input: Request): Promise<unknown> {
      calls.push(input);
      return Promise.resolve(respond(input));
    },
    mutate(): never {
      state.mutated = true;
      throw new Error('采集器不得调用 backend.mutate');
    },
  };
  return { backend, calls, state };
}

const statusBuilder = (_store: StoreLike, coordinationScopeId: string): unknown => ({
  kind: 'snapshot',
  snapshot: { schemaVersion: 2, scope: { coordinationScopeId }, execution: { finalizer: { verdict: 'deliverable' } } },
});

const worker = {
  dispatchId: 'd1',
  taskId: 't1',
  runId: RUN_ID,
  workerState: 'ready',
  terminalState: 'active',
  agentTerminalHandle: null,
};

const runSample = (options: Partial<CollectOptions> = {}): Promise<Sample> =>
  collector.collectSample({ repositoryPath: REPO, coordinationScopeId: SCOPE_ID, now: FIXED_NOW, ...options });

describe('ledger-lab collector', () => {
  it('采集一个只读 sample，只使用公开只读查询', async () => {
    const { store, log } = buildStore();
    const { backend, calls, state } = buildBackend(() => ({ kind: 'accepted', value: { workers: [worker] } }));
    const sample = await runSample({ store, backend, statusBuilder });

    expect(sample.schemaVersion).toBe(1);
    expect(sample.kind).toBe('sample');
    expect(sample.collectorId).toBe(collector.COLLECTOR_ID);
    expect(sample.repositoryPath).toBe(REPO);
    expect(sample.coordinationScopeId).toBe(SCOPE_ID);
    expect(new Date(sample.startedAt).toISOString()).toBe(sample.startedAt);
    expect(new Date(sample.observedAt).toISOString()).toBe(sample.observedAt);

    expect(sample.sources.store.status).toBe('available');
    expect(sample.sources.store.consistent).toBe(true);
    expect(sample.sources.store.errors).toEqual([]);
    expect(sample.sources.git.status).toBe('available');
    expect(sample.sources.git.head).toMatch(/^[0-9a-f]{40}$/u);
    expect(Array.isArray(sample.sources.git.dirtyPaths)).toBe(true);

    expect(sample.snapshot.scope).toMatchObject({ coordinationScopeId: SCOPE_ID, revision: 7 });
    expect(sample.snapshot.generations).toHaveLength(1);
    expect(sample.snapshot.graphs).toHaveLength(1);
    expect(sample.snapshot.graphs[0]).toMatchObject({ graphId: 'graph-1', version: 1 });
    // 状态投影原样保留（含 finalizer），不裁剪字段。
    expect(sample.snapshot.status).toMatchObject({ schemaVersion: 2, execution: { finalizer: { verdict: 'deliverable' } } });

    expect(sample.sources.orca.status).toBe('available');
    expect(sample.sources.orca.errors).toEqual([]);
    expect(sample.sources.orca.runs).toHaveLength(1);
    expect(sample.sources.orca.runs[0]?.runId).toBe(RUN_ID);
    expect(sample.sources.orca.runs[0]?.workers).toEqual([worker]);

    expect(state.mutated).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ operation: 'worker-list', runId: RUN_ID });
    expect(log.length).toBeGreaterThan(10);
    for (const request of log) {
      expect(READ_KINDS.has(String(request['kind']))).toBe(true);
      expect(request['coordinationScopeId']).toBe(SCOPE_ID);
    }
  });

  it('生产 adapter 只给 workers 而无覆盖标识时 complete=false，但保留 ready 原值作为正证据', async () => {
    const { store } = buildStore();
    const { backend } = buildBackend(() => ({ kind: 'accepted', value: { workers: [worker] } }));
    const sample = await runSample({ store, backend, statusBuilder });

    // 没有 coverage 元数据，不能声称覆盖完整。
    expect(sample.sources.orca.runs[0]?.complete).toBe(false);
    // 正证据仍在，且 ready 不得被改写为 live。
    expect(sample.sources.orca.runs[0]?.workers).toEqual([worker]);
  });

  it('payload 显式声明完整覆盖时才置 complete=true', async () => {
    const { store } = buildStore();
    const { backend } = buildBackend(() => ({
      kind: 'accepted',
      value: { workers: [worker], coverage: 'complete' },
    }));
    const sample = await runSample({ store, backend, statusBuilder });

    expect(sample.sources.orca.runs[0]?.complete).toBe(true);
  });

  it('即便有 coverage 标识，truncated 或仍有下一页时 complete 仍为 false', async () => {
    const { store } = buildStore();
    const truncated = buildBackend(() => ({
      kind: 'accepted',
      value: { workers: [worker], coverage: 'complete', truncated: true },
    }));
    const first = await runSample({ store, backend: truncated.backend, statusBuilder });
    expect(first.sources.orca.runs[0]?.complete).toBe(false);

    const paged = buildBackend(() => ({
      kind: 'accepted',
      value: { workers: [worker], coverage: 'complete', nextCursor: 'page-2' },
    }));
    const second = await runSample({ store, backend: paged.backend, statusBuilder });
    expect(second.sources.orca.runs[0]?.complete).toBe(false);
  });

  it('把已知 Run 的 worker-list 结果绑定到 runId', async () => {
    const { store } = buildStore();
    const { backend, calls } = buildBackend(() => ({ kind: 'accepted', value: { workers: [] } }));
    const sample = await runSample({ store, backend, statusBuilder });

    expect(calls.map((call) => call['runId'])).toEqual([RUN_ID]);
    expect(sample.sources.orca.runs.map((run) => run.runId)).toEqual([RUN_ID]);
  });

  it('没有已知 Run 时不做 worker 查询，也不把缺口当成 Worker 缺席', async () => {
    const { store } = buildStore({ 'graph-generations': () => ({ kind: 'graph-generations', generations: [] }) });
    const { backend, calls } = buildBackend(() => ({ kind: 'accepted', value: { workers: [] } }));
    const sample = await runSample({ store, backend, statusBuilder });

    expect(sample.sources.orca.runs).toEqual([]);
    expect(calls).toEqual([]);
    expect(sample.sources.orca.status).toBe('available');
  });

  it('worker-list 被拒绝时标 unavailable 且 complete=false，不把拒绝当成缺席', async () => {
    const { store } = buildStore();
    const { backend } = buildBackend(() => ({ kind: 'rejected', code: 'unreachable', message: 'orca 不可达' }));
    const sample = await runSample({ store, backend, statusBuilder });

    expect(sample.sources.orca.status).toBe('unavailable');
    expect(sample.sources.orca.errors.some((error) => error.code === 'unreachable')).toBe(true);
    expect(sample.sources.orca.runs[0]?.complete).toBe(false);
    expect(sample.sources.orca.runs[0]?.workers).toBeNull();
    expect(sample.sources.orca.runs[0]?.result).toMatchObject({ kind: 'rejected', code: 'unreachable' });
  });

  it('backend 查询抛错时记 error 并保持 complete=false', async () => {
    const { store } = buildStore();
    const { backend } = buildBackend(() => {
      throw new Error('boom');
    });
    const sample = await runSample({ store, backend, statusBuilder });

    expect(sample.sources.orca.status).toBe('unavailable');
    expect(sample.sources.orca.runs[0]?.complete).toBe(false);
    expect(sample.sources.orca.errors.some((error) => error.code === 'worker_list_threw')).toBe(true);
  });

  it('backend 环境剥离宿主 ORCA_* 可信身份', () => {
    const env = collector.trustedOrcaEnvironment({
      PATH: '/usr/bin',
      ORCA_HOME: '/home/user/.orca',
      ORCA_TERMINAL: 'term-1',
      ORCA_WORKER: 'worker-1',
      ORCA_TASK: 'task-1',
      ORCA_RUN: 'run-1',
    });
    expect(env['PATH']).toBe('/usr/bin');
    expect(env['ORCA_HOME']).toBe('/home/user/.orca');
    expect(env['ORCA_TERMINAL']).toBeUndefined();
    expect(env['ORCA_WORKER']).toBeUndefined();
    expect(env['ORCA_TASK']).toBeUndefined();
    expect(env['ORCA_RUN']).toBeUndefined();
  });

  it('collectorId 可被覆盖，并进入 sampleId', async () => {
    const { store } = buildStore();
    const { backend } = buildBackend(() => ({ kind: 'accepted', value: { workers: [] } }));
    const sample = await runSample({ store, backend, statusBuilder, collectorId: 'custom-collector' });

    expect(sample.collectorId).toBe('custom-collector');
    expect(sample.sampleId.startsWith('custom-collector#')).toBe(true);
  });

  it('图目录读失败时标 unavailable，不返回假空', async () => {
    const { store } = buildStore({
      'graph-version-index': () => ({ kind: 'rejected', code: 'unreadable', message: '目录损坏' }),
    });
    const { backend } = buildBackend(() => ({ kind: 'accepted', value: { workers: [] } }));
    const sample = await runSample({ store, backend, statusBuilder });

    expect(sample.sources.store.status).toBe('unavailable');
    expect(sample.sources.store.errors.some((error) => error.message.includes('graph-version-index'))).toBe(true);
    expect(sample.snapshot.graphs).toEqual([]);
  });

  it('目录存在但精确图版本为空时记缺口', async () => {
    const { store } = buildStore({ 'graph-version': () => ({ kind: 'graph-version', version: null }) });
    const { backend } = buildBackend(() => ({ kind: 'accepted', value: { workers: [] } }));
    const sample = await runSample({ store, backend, statusBuilder });

    expect(sample.sources.store.status).toBe('unavailable');
    expect(sample.sources.store.errors.some((error) => error.code === 'graph_version_missing')).toBe(true);
  });

  it('图目录分页中途失败不能算通过', async () => {
    const { store } = buildStore({
      'graph-version-index': (_request, count) =>
        count === 1
          ? { kind: 'graph-version-index', items: [versionMetadata], nextCursor: { generation: 1, graphId: 'graph-1', version: 1 } }
          : { kind: 'rejected', code: 'unreadable', message: '第二页失败' },
    });
    const { backend } = buildBackend(() => ({ kind: 'accepted', value: { workers: [] } }));
    const sample = await runSample({ store, backend, statusBuilder });

    expect(sample.sources.store.status).toBe('unavailable');
    expect(sample.sources.store.errors.some((error) => error.code === 'unreadable')).toBe(true);
  });

  it('图目录超过分页上限时视为截断失败', async () => {
    const { store } = buildStore({
      'graph-version-index': () => ({
        kind: 'graph-version-index',
        items: [versionMetadata],
        nextCursor: { generation: 1, graphId: 'graph-1', version: 1 },
      }),
    });
    const { backend } = buildBackend(() => ({ kind: 'accepted', value: { workers: [] } }));
    const sample = await runSample({ store, backend, statusBuilder });

    expect(sample.sources.store.status).toBe('unavailable');
    expect(sample.sources.store.errors.some((error) => error.code === 'version_index_truncated')).toBe(true);
    expect(sample.snapshot.graphs.length).toBeLessThanOrEqual(collector.MAX_GRAPH_PAGES * 20);
  });

  it('数组查询返回非预期 kind 时不静默当空', async () => {
    const { store } = buildStore({ 'delivery-settlements': () => ({ kind: 'scope', scope: scopeRecord }) });
    const { backend } = buildBackend(() => ({ kind: 'accepted', value: { workers: [] } }));
    const sample = await runSample({ store, backend, statusBuilder });

    expect(sample.sources.store.status).toBe('unavailable');
    expect(sample.sources.store.errors.some((error) => error.code === 'unexpected_result')).toBe(true);
  });

  it('结果缺少字段时不静默当空', async () => {
    const { store } = buildStore({ scope: () => ({ kind: 'scope' }) });
    const { backend } = buildBackend(() => ({ kind: 'accepted', value: { workers: [] } }));
    const sample = await runSample({ store, backend, statusBuilder });

    expect(sample.sources.store.status).toBe('unavailable');
    expect(sample.sources.store.errors.some((error) => error.code === 'missing_field')).toBe(true);
  });

  it('数组超过记录上限时标失败而非截断成空', async () => {
    const many = Array.from({ length: collector.MAX_RECORDS + 1 }, (_value, index) => ({ index }));
    const { store } = buildStore({ intents: () => ({ kind: 'intents', intents: many }) });
    const { backend } = buildBackend(() => ({ kind: 'accepted', value: { workers: [] } }));
    const sample = await runSample({ store, backend, statusBuilder });

    expect(sample.sources.store.status).toBe('unavailable');
    expect(sample.sources.store.errors.some((error) => error.code === 'too_many_records')).toBe(true);
    expect(sample.snapshot.intents).toHaveLength(collector.MAX_RECORDS);
  });

  it('Scope revision 采样期间变化时 consistent=false', async () => {
    const { store } = buildStore({
      scope: (_request, count) => ({ kind: 'scope', scope: { ...scopeRecord, revision: count === 1 ? 7 : 9 } }),
    });
    const { backend } = buildBackend(() => ({ kind: 'accepted', value: { workers: [] } }));
    const sample = await runSample({ store, backend, statusBuilder });

    expect(sample.sources.store.consistent).toBe(false);
    expect(sample.sources.store.errors.some((error) => error.code === 'scope_revision_changed')).toBe(true);
  });

  it('Scope 不存在时标 unavailable', async () => {
    const { store } = buildStore({ scope: () => ({ kind: 'scope', scope: null }) });
    const { backend } = buildBackend(() => ({ kind: 'accepted', value: { workers: [] } }));
    const sample = await runSample({ store, backend, statusBuilder });

    expect(sample.sources.store.status).toBe('unavailable');
    expect(sample.sources.store.consistent).toBe(false);
    expect(sample.sources.store.errors.some((error) => error.code === 'scope_missing')).toBe(true);
  });

  it('状态投影失败时记 error 而不是假快照', async () => {
    const { store } = buildStore();
    const { backend } = buildBackend(() => ({ kind: 'accepted', value: { workers: [] } }));
    const sample = await runSample({ store, backend, statusBuilder: () => ({ kind: 'failed', message: '投影不可用' }) });

    expect(sample.snapshot.status).toBeNull();
    expect(sample.sources.store.errors.some((error) => error.code === 'status_failed')).toBe(true);
  });

  it('accepted revision 的补丁按 graph-patch-record 精确读取', async () => {
    const acceptedVersion = { ...graphVersion, recordKind: 'accepted_revision', version: 2, parentVersion: 1, patchId: 'patch-1' };
    const metadata = { ...versionMetadata, version: 2, recordKind: 'accepted_revision', patchId: 'patch-1' };
    const patchRecord = {
      coordinationScopeId: SCOPE_ID,
      graphId: 'graph-1',
      graphVersion: 2,
      patchId: 'patch-1',
      added: ['F'],
      revised: ['A'],
      retired: ['R'],
    };
    const { store } = buildStore({
      'graph-version-index': () => ({ kind: 'graph-version-index', items: [metadata], nextCursor: null }),
      'graph-version': () => ({ kind: 'graph-version', version: acceptedVersion }),
      'graph-patch-record': () => ({ kind: 'graph-patch-record', record: patchRecord }),
    });
    const { backend } = buildBackend(() => ({ kind: 'accepted', value: { workers: [] } }));
    const sample = await runSample({ store, backend, statusBuilder });

    expect(sample.snapshot.patches).toEqual([patchRecord]);
  });

  it('accepted revision 缺少补丁记录时记缺口而非空', async () => {
    const acceptedVersion = { ...graphVersion, recordKind: 'accepted_revision', version: 2, parentVersion: 1, patchId: 'patch-1' };
    const metadata = { ...versionMetadata, version: 2, recordKind: 'accepted_revision', patchId: 'patch-1' };
    const { store } = buildStore({
      'graph-version-index': () => ({ kind: 'graph-version-index', items: [metadata], nextCursor: null }),
      'graph-version': () => ({ kind: 'graph-version', version: acceptedVersion }),
      'graph-patch-record': () => ({ kind: 'graph-patch-record', record: null }),
    });
    const { backend } = buildBackend(() => ({ kind: 'accepted', value: { workers: [] } }));
    const sample = await runSample({ store, backend, statusBuilder });

    expect(sample.sources.store.status).toBe('unavailable');
    expect(sample.sources.store.errors.some((error) => error.code === 'graph_patch_missing')).toBe(true);
  });

  it('目标仓库不可读时 Git 标 unavailable，不创建仓库', async () => {
    const { store } = buildStore();
    const { backend } = buildBackend(() => ({ kind: 'accepted', value: { workers: [] } }));
    const sample = await collector.collectSample({
      repositoryPath: '/nonexistent/ledger-lab-dut-xyz',
      coordinationScopeId: SCOPE_ID,
      store,
      backend,
      statusBuilder,
      now: FIXED_NOW,
    });

    expect(sample.sources.git.status).toBe('unavailable');
    expect(sample.sources.git.head).toBeNull();
    expect(sample.sources.git.dirtyPaths).toEqual([]);
  });

  it('normal 样本无需 segments 即可通过 collector→verify-process 集成', async () => {
    const bindings = [
      { coordinationScopeId: SCOPE_ID, orcaTaskId: 't1', workPackageId: 'wp-stat', workerTaskId: 'wt1', attemptId: 'a1' },
      { coordinationScopeId: SCOPE_ID, orcaTaskId: 't2', workPackageId: 'wp-audit', workerTaskId: 'wt2', attemptId: 'a2' },
    ];
    const { store } = buildStore({
      'graph-version-index': () => ({ kind: 'graph-version-index', items: [], nextCursor: null }),
      'materialization-bindings': () => ({ kind: 'materialization-bindings', bindings }),
    });
    const { backend } = buildBackend(() => ({
      kind: 'accepted',
      value: {
        workers: [
          { ...worker, dispatchId: 'd1', taskId: 't1', workerState: 'running' },
          { ...worker, dispatchId: 'd2', taskId: 't2', workerState: 'running' },
        ],
      },
    }));
    const sample = await runSample({ store, backend, statusBuilder });
    expect(sample.snapshot.segments).toEqual([]);
    expect(sample.sources.store.status).toBe('available');
    expect(sample.sources.orca.runs[0]?.complete).toBe(false);
    expect(sample.sources.orca.runs[0]?.workers).toHaveLength(2);

    const mapping = {
      schemaVersion: 1,
      coordinationScopeId: SCOPE_ID,
      graphs: [
        {
          graphId: 'graph-1',
          nodes: { A: 'wp-stat', B: 'wp-audit' },
          lanes: { 'wp-stat': 'statistics', 'wp-audit': 'audit' },
        },
      ],
      controlLanes: {},
    };
    const observations = { schemaVersion: 1, coordinationScopeId: SCOPE_ID, entries: [] };
    const report = verifier.verifyProcess({ samples: [sample], mapping, observations, profile: 'main' });

    const parallel = report.checks.find((check) => check.id === 'parallel');
    const laneCapacity = report.checks.find((check) => check.id === 'lane-capacity');
    expect(parallel?.status).toBe('PASS');
    expect(laneCapacity?.status).toBe('INCONCLUSIVE');
  });
});
