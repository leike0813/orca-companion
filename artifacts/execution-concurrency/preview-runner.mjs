import process from 'node:process';
import { Buffer } from 'node:buffer';
import { createElement } from 'react';
import { render } from 'ink';

/**
 * 多包并发 + 执行并发设置的隔离假画面宿主（IP-05 呈现验收用）。
 *
 * 它挂载生产 TuiApp，只替换端口与快照：没有任何 Orca 调用、没有 Worker、没有模型、没有网络，也不
 * 读写项目配置或凭据。快照里的两个活动 Work Package 与批准额度都是显式夹具，按需求仿真，不是真实
 * 运行证据。
 */

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write('并发设置预览需要 stdin 与 stdout 均为 TTY\n');
  process.exit(2);
}

const { TuiApp } = await import('../../dist/src/interfaces/tui/app.js');
const { openUiInputStore } = await import('../../dist/src/adapters/storage/ui-input-store.js');

const inputStore = openUiInputStore({ databasePath: ':memory:' });
if (inputStore.kind !== 'opened') throw new Error('preview input store: ' + inputStore.message);

const icons = process.env.ORCA_COMPANION_TUI_ICONS === 'ascii' ? 'ascii' : 'nerd';
const scope = 'scope-concurrency-preview';
const sessionId = 'session-a';

const messages = [
  { role: 'user', content: '请确认两个工作包可以同时推进，并检查执行并发设置入口。', stepId: null },
  { role: 'assistant', content: '已按批准额度 5 并行派发 wp-2 与 wp-3：二者同 base、互不依赖。', stepId: 'preview-1' },
  { role: 'tool', content: 'advance_execution\nactive: wp-2, wp-3 \u00b7 并行\u22645', stepId: 'preview-2' },
];

const body = new Map(messages.map((message, index) => ['preview-' + index, message.content]));
const entries = messages.map((message, index) => ({
  entryId: 'preview-' + index,
  stepId: message.stepId ?? 'preview-' + index,
  role: message.role,
  sequence: index + 1,
  contentRevision: 1,
  byteLength: Buffer.byteLength(message.content),
  toolName: message.role === 'tool' ? 'advance_execution' : null,
}));
const empty = { entries: [], hasMore: false };
const reading = {
  history: async () => ({ ...empty, entries }),
  body: async (query) => {
    if (query.source.kind !== 'history') return null;
    const text = body.get(query.source.entryId);
    if (text === undefined) return null;
    const bytes = Buffer.from(text);
    const end = Math.min(bytes.length, query.offset + query.maxBytes);
    let safeEnd = end;
    while (safeEnd > query.offset && safeEnd < bytes.length && (bytes[safeEnd] & 0xc0) === 0x80) safeEnd--;
    const chunk = bytes.subarray(query.offset, safeEnd).toString('utf8');
    return { source: query.source, offset: query.offset, end: query.offset + Buffer.byteLength(chunk), byteLength: bytes.length, text: chunk };
  },
  previews: async () => [], pin: () => () => {}, subscribe: () => () => {},
  inspection: {
    snapshot: async () => ({ ready: true, upperSequence: entries.length, oldestSequence: 1 }),
    calls: async () => ({ calls: [], hasMore: false }),
    users: async () => ({ entries: [], hasMore: false }),
    search: async () => ({ hits: [], complete: true }),
  },
};

const node = (workPackageId, title, dependsOn) => ({ workPackageId, title, dependsOn, scopeEnvelope: { include: ['README.md'], exclude: [] } });
const topology = {
  graphId: 'graph-cc', graphVersion: 2, generation: 1,
  nodes: [node('wp-1', 'README 标题与说明', []), node('wp-2', 'NOTES 基础说明', []), node('wp-3', 'CHANGELOG 说明', [])],
  readiness: { generationStatus: 'active', authorizationBound: true },
};
const entry = (workPackageId, state, overrides = {}) => ({
  workPackageId, state, role: null, attemptId: null, liveness: null,
  worktreePath: null, baselineHead: null, validation: null, integration: null,
  derivedFrom: ['fixture:' + workPackageId + ':' + state], blockerRefs: [], ...overrides,
});
const frontier = [
  entry('wp-1', 'accepted'),
  entry('wp-2', 'implementing', { role: 'implementation', attemptId: 'attempt-2', liveness: 'live', worktreePath: '/tmp/orca-companion-preview/wp-2', baselineHead: 'head-base' }),
  entry('wp-3', 'implementing', { role: 'implementation', attemptId: 'attempt-3', liveness: 'live', worktreePath: '/tmp/orca-companion-preview/wp-3', baselineHead: 'head-base' }),
];
const budgets = {
  workPackages: { status: 'available', consumed: 3, limit: 8, subject: 'graph-cc', approvedLimitRef: 'auth-cc' },
  implementationAttempts: { status: 'available', consumed: 1, limit: 2, subject: 'wp-2', approvedLimitRef: 'auth-cc' },
  recovery: { status: 'available', consumed: 0, limit: 1, subject: 'attempt-2', approvedLimitRef: 'auth-cc' },
};
const snapshot = {
  coordinationScopeId: scope, revision: 11, mode: 'execution_coordination', controlState: 'active',
  planningCycleId: 'cycle-1', mapRevision: 3, graph: { graphId: 'graph-cc', graphVersion: 2, generation: 1 },
  authorization: { authorizationId: 'auth-cc', version: 1 }, executionLeaseHolderSessionId: sessionId, selectedSessionId: sessionId,
  sessions: [{ coordinatorSessionId: sessionId, coordinatorModelConfigurationRef: 'config-a', lifecycleState: 'active',
    holdsRuntimeLease: true, holdsExecutionLease: true, planningResponsible: true, openInteractionCount: 0 }],
  budgets: [], frontier,
  workers: [
    { dispatchId: 'dispatch-wp-2', workerTaskId: 'task-wp-2', workPackageId: 'wp-2', role: 'implementation', liveness: 'live' },
    { dispatchId: 'dispatch-wp-3', workerTaskId: 'task-wp-3', workPackageId: 'wp-3', role: 'implementation', liveness: 'live' },
  ],
  activeWorkPackageIds: ['wp-2', 'wp-3'],
  blockers: [], interactions: [], openInteractionCount: 0, handoffs: [], recoveries: [],
  executionReconciliation: { pending: false, unresolvedIntentCount: 0, activeWorkerCount: 2, reasons: [] },
  finalizer: { gate: { ready: false, blockers: ['unfinished-work-packages'] }, coversWorkPackageIds: [],
    worktreePath: null, readOnlyProfile: 'unenforceable', integrationFrozen: 'unknown', workspace: null, evidenceRefs: [], verdict: null },
  graphEvolution: { generations: [], revisionHolds: [], reconciliations: [], lineages: [], adoptions: [] },
  maintenance: null, graphTopologies: [topology], planningHandoffs: [], compaction: null,
  projectPresentation: {
    identity: { repository: '示例仓库', fullBranchRef: 'refs/heads/main' },
    session: { id: sessionId, model: '示例模型 A', provider: '示例 provider', effort: { status: 'configured', value: 'high' } },
    ticket: null,
    activeWorkPackages: [{ id: 'wp-2', title: 'NOTES 基础说明' }, { id: 'wp-3', title: 'CHANGELOG 说明' }],
    context: { status: 'available', used: 62000, capacity: 100000, observationId: 'fixture-exact-context',
      coordinatorSessionId: sessionId, modelConfigurationRef: 'config-a', effectiveInputRevision: 1 },
    acceptance: { graphId: 'graph-cc', generation: 1, version: 2, validatedCount: 1, totalCount: 3 },
    budgets,
  },
};

const preferences = {
  schemaVersion: 1, revision: 3, iconMode: icons,
  statusline: { modelFormat: 'model', contextFormat: 'used', progressFormat: 'count',
    budgetKey: 'work-packages', fields: ['graph', 'work-package', 'progress', 'budget'] },
};

const rejected = async () => ({ kind: 'rejected', code: 'preview_read_only', message: '隔离假画面只读：未连接真实项目' });

const ports = {
  commandStatus: async (resultRef) => ({ kind: 'accepted', revision: null, summary: '隔离假画面', resultRef }),
  reading,
  inputStore: inputStore.store,
  submissionStatus: async () => ({ kind: 'unverifiable', reason: '隔离假画面没有提交记录' }),
  snapshot: async (selectedSessionId) => ({ kind: 'snapshot', snapshot: { ...snapshot, selectedSessionId } }),
  transcript: async (coordinatorSessionId) => ({ kind: 'transcript', transcript: { coordinatorSessionId, messages, nextCursor: null } }),
  execute: rejected,
  subscribe: () => () => {},
  scopeSetup: { resolveHome: async () => ({ kind: 'restore', coordinationScopeId: scope }), verify: async () => [],
    proposal: async () => ({}), initialize: rejected, bindLegacyIdentity: rejected },
  modelCatalog: { load: async () => ({ options: [], currentConfigurationRef: 'config-a', switchable: false,
    switchBlockReason: '隔离假画面不提供模型切换', configurationRevision: 1, roles: [] }) },
  handoff: { read: async () => null, prepareProposal: rejected, cutover: rejected, cancel: rejected },
  executionHandoff: { read: async () => null, prepare: rejected, review: rejected, cutover: rejected, cancel: rejected },
  executionAuthorization: {
    review: async () => ({ kind: 'review', review: {
      fingerprint: 'fixture-fingerprint', scopeRevision: snapshot.revision,
      candidate: { graphId: 'graph-cc', generation: 1, version: 2, baselineHead: 'fixture-head', workPackageCount: 3 },
      manifestRows: [
        { label: 'Limits', value: '并行\u22645 工作包\u22648 实现\u00d72 修复\u00d72 集成复验\u00d72 图修订\u00d72 规格修订\u00d72 恢复\u00d71' },
        { label: 'Worker Sandbox', value: 'danger-full-access（隔离假画面）' },
      ],
      sections: [], gate: { ready: true, blockers: [] } } }),
    approve: rejected,
  },
  preferences: { load: async () => ({ kind: 'loaded', preferences, writable: true, notice: null }),
    save: async (request) => ({ kind: 'saved', preferences: { ...preferences, revision: preferences.revision + 1,
      ...(request.patch.kind === 'icons' ? { iconMode: request.patch.iconMode } : { statusline: request.patch.statusline }) } }) },
  executionSettings: {
    load: async () => ({ kind: 'loaded', settings: { revision: 7, defaultMaxActiveWorkPackages: 3, approvedMaxActiveWorkPackages: 5 } }),
    save: async (request) => ({ kind: 'saved', revision: request.expectedRevision + 1, defaultMaxActiveWorkPackages: request.maxActiveWorkPackages }),
  },
};

let app;
app = render(createElement(TuiApp, { ports, terminalWidth: process.stdout.columns ?? 80, initialScopeId: scope, onExit: () => app.unmount() }),
  { exitOnCtrlC: false, interactive: true });
process.on('SIGTERM', () => { app.unmount(); process.exit(0); });
