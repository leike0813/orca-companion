import process from 'node:process';
import { Buffer } from 'node:buffer';
import { createElement } from 'react';
import { render } from 'ink';
import { createGraphBasisPreviewPorts } from './preview-ports.mjs';

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write('graph-basis preview requires a PTY\n');
  process.exit(2);
}
if (!process.env.ORCA_COMPANION_PREVIEW_CONFIG_HOME) throw new Error('isolated preview config home is required');

// This synthetic selection exercises the historical retirement explanation. It is not a live graph fact.
if (process.env.ORCA_COMPANION_PREVIEW_RETIRED_HISTORY === '1') {
  const { initialTuiState } = await import('../../dist/src/interfaces/tui/state.js');
  initialTuiState.inspectorSelection = 'wp-d';
}
const { TuiApp } = await import('../../dist/src/interfaces/tui/app.js');
const { openUiInputStore } = await import('../../dist/src/adapters/storage/ui-input-store.js');
const fixture = await createGraphBasisPreviewPorts();
const { snapshot, graphBasis, projectStatus, scope } = fixture;
const input = openUiInputStore({ databasePath: ':memory:' });
if (input.kind !== 'opened') throw new Error(`preview input store: ${input.message}`);

const messages = [
  { role: 'user', content: '请检查这次图历史与执行依据入口，保留已有对话和返回层级。', stepId: null },
  { role: 'assistant', content: '我会先核对当前图，再打开全代际目录和原始依据。', stepId: 'preview-assistant-1' },
  { role: 'tool', content: 'read_graph\n当前代际 G2 · 2 个工作包 · 来源由 schema 17 store 提供', stepId: 'preview-tool-1' },
  { role: 'assistant', content: '历史图只展示所选版本记录；依据正文按原来源分页读取。', stepId: 'preview-assistant-2' },
];
const body = new Map(messages.map((message, index) => [`preview-${index}`, message.content]));
const entries = messages.map((message, index) => ({ entryId: `preview-${index}`, stepId: message.stepId ?? `preview-${index}`,
  role: message.role, sequence: index + 1, contentRevision: 1, byteLength: Buffer.byteLength(message.content), toolName: null }));
const empty = { entries: [], hasMore: false };
const reading = {
  history: async query => query.direction === 'newer' ? { ...empty, entries } : { ...empty, entries },
  body: async query => {
    if (query.source.kind !== 'history') return null;
    const text = body.get(query.source.entryId);
    if (text === undefined) return null;
    const bytes = Buffer.from(text), end = Math.min(bytes.length, query.offset + query.maxBytes);
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

const rejected = async () => ({ kind: 'rejected', code: 'preview_read_only', message: '隔离预览只读' });
const ports = {
  commandStatus: async resultRef => ({ kind: 'accepted', revision: null, summary: '隔离预览', resultRef }),
  reading,
  inputStore: input.store,
  submissionStatus: async () => ({ kind: 'unverifiable', reason: '隔离预览没有提交记录' }),
  snapshot: async selectedSessionId => ({ kind: 'snapshot', snapshot: { ...snapshot, selectedSessionId,
    projectPresentation: projectStatus.presentation(snapshot, selectedSessionId) } }),
  transcript: async coordinatorSessionId => ({ kind: 'transcript', transcript: { coordinatorSessionId, messages, nextCursor: null } }),
  execute: rejected, subscribe: () => () => {},
  scopeSetup: { resolveHome: async () => ({ kind: 'restore', coordinationScopeId: scope }), verify: async () => [],
    proposal: async () => ({}), initialize: rejected, bindLegacyIdentity: rejected },
  modelCatalog: { load: async () => ({ options: [], currentConfigurationRef: 'config-a', switchable: false,
    switchBlockReason: '隔离画面不提供模型切换', configurationRevision: 1, roles: [] }) },
  handoff: { read: async () => null, prepareProposal: rejected, cutover: rejected, cancel: rejected },
  executionHandoff: { read: async () => null, prepare: rejected, review: rejected, cutover: rejected, cancel: rejected },
  executionAuthorization: { review: async () => ({ kind: 'review', review: { fingerprint: 'fixture-fingerprint', scopeRevision: snapshot.revision,
    candidate: { graphId: snapshot.graph.graphId, generation: snapshot.graph.generation, version: snapshot.graph.graphVersion, baselineHead: 'fixture-head', workPackageCount: 2 },
    manifestRows: [{ label: '来源', value: '隔离 preview fixture' }, { label: 'Worker profiles', value: '示例配置；未启动 Worker' }],
    sections: [{ id: 'overview', label: '概览', rows: [{ label: '执行计划', value: 'fixture graph' }] }, { id: 'permissions', label: '权限', rows: [{ label: '范围', value: '隔离示例' }] }, { id: 'budget', label: '预算', rows: [{ label: '上限', value: 'fixture only' }] }, { id: 'workspace', label: '工作区', rows: [{ label: '目录', value: '临时 fixture' }] }, { id: 'complete', label: '完整清单', rows: [] }], gate: { ready: false, blockers: ['fixture 不可批准'] } } }), approve: rejected },
  projectDetails: projectStatus.ports.projectDetails,
  preferences: projectStatus.ports.preferences,
  graphBasis,
};

const app = render(createElement(TuiApp, { ports, terminalWidth: process.stdout.columns ?? 80,
  initialScopeId: scope, onExit: () => app.unmount() }), { exitOnCtrlC: false, interactive: true });
process.on('SIGTERM', () => { app.unmount(); fixture.close(); process.exit(0); });
