import process from 'node:process';
import { createElement } from 'react';
import { render } from 'ink';

const scenarios = ['planning', 'execution', 'blocked', 'empty', 'long-cjk'];
const scenario = process.argv[2] ?? 'planning';
if (process.argv.length > 3 || !scenarios.includes(scenario)) {
  process.stderr.write(`场景必须是：${scenarios.join(', ')}\n`);
  process.exitCode = 2;
} else if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write('TUI 预览需要 stdin 和 stdout 均为 TTY\n');
  process.exitCode = 2;
} else {
  try {
    // 只导入 UI 构建产物。此脚本不装配生产 bootstrap、Controller 或外部 adapter。
    const { TuiApp } = await import('../dist/src/interfaces/tui/app.js');
    const cjk = '请规划第一版路线图：中文abc混排内容需要按显示宽度换行';
    const graph = {
      graphId: 'graph-1', graphVersion: 2, generation: 1,
      nodes: [
        { workPackageId: 'wp-1', title: '第一个工作包', dependsOn: [], scopeEnvelope: { include: ['src/a.ts'], exclude: [] } },
        { workPackageId: 'wp-2', title: '长中文路径和日志验收', dependsOn: ['wp-1'], scopeEnvelope: { include: ['src/路径/中文文件名.ts'], exclude: [] } },
      ],
      readiness: { generationStatus: 'candidate', authorizationBound: false },
    };
    const snapshot = {
      coordinationScopeId: 'scope-preview', revision: 7,
      mode: scenario === 'execution' ? 'execution_coordination' : 'route_planning',
      controlState: scenario === 'blocked' ? 'blocked' : 'active',
      planningCycleId: 'cycle-1', mapRevision: 3,
      graph: scenario === 'empty' ? null : { graphId: graph.graphId, graphVersion: graph.graphVersion, generation: graph.generation },
      authorization: scenario === 'execution' ? { authorizationId: 'auth-1', version: 1 } : null,
      executionLeaseHolderSessionId: scenario === 'execution' ? 'session-a' : null,
      selectedSessionId: null,
      sessions: [{ coordinatorSessionId: 'session-a', coordinatorModelConfigurationRef: 'config-a', lifecycleState: 'active', holdsRuntimeLease: false, holdsExecutionLease: scenario === 'execution', planningResponsible: true, openInteractionCount: 0 }],
      budgets: [],
      frontier: scenario === 'execution' ? [{ workPackageId: 'wp-1', state: 'implementing', role: 'implementation', attemptId: 'attempt-1', liveness: 'live', worktreePath: '/tmp/worktrees/wp-1', baselineHead: 'head-1', validation: null, integration: null, derivedFrom: [], blockerRefs: [] }] : [],
      workers: [],
      finalizer: { gate: { ready: false, blockers: ['no-work-packages'] }, coversWorkPackageIds: [], worktreePath: null, readOnlyProfile: 'unverified', integrationFrozen: 'unknown', workspace: null, evidenceRefs: [], verdict: null },
      executionReconciliation: { pending: scenario === 'blocked', unresolvedIntentCount: scenario === 'blocked' ? 1 : 0, activeWorkerCount: scenario === 'execution' ? 1 : 0, reasons: scenario === 'blocked' ? ['等待原操作对账'] : [] },
      blockers: [], interactions: [], handoffs: [], recoveries: [],
      graphEvolution: { generations: [], revisionHolds: [], reconciliations: [], lineages: [], adoptions: [] },
      maintenance: null,
      graphTopologies: scenario === 'empty' ? [] : [graph],
      compaction: null, planningHandoffs: [],
    };
    const transcript = {
      coordinatorSessionId: 'session-a',
      messages: scenario === 'empty' ? [] : [
        { role: 'user', content: scenario === 'long-cjk' ? `${cjk}，src/非常长的中文目录/多层路径/项目文件.ts，继续检查布局与裁切。`.repeat(3) : cjk, stepId: null },
        { role: 'assistant', content: 'Coordinator 会先读地图，再确认依赖与范围。', stepId: 'step-1' },
        { role: 'tool', content: 'search\n命中 3 个文件', stepId: 'step-2' },
      ],
      nextCursor: null,
    };
    const rejected = { kind: 'rejected', code: 'preview_read_only', message: '预览只读：没有连接真实项目' };
    const ports = {
      snapshot: async (selectedSessionId) => ({ kind: 'snapshot', snapshot: { ...snapshot, selectedSessionId } }),
      transcript: async () => ({ kind: 'transcript', transcript }),
      execute: async () => rejected,
      subscribe: () => () => {},
      scopeSetup: {
        resolveHome: async () => ({ kind: 'restore', coordinationScopeId: snapshot.coordinationScopeId }),
        verify: async () => [],
        proposal: async () => ({ coordinationScopeId: snapshot.coordinationScopeId, coordinatorSessionId: 'session-a', coordinatorModelConfigurationRef: 'config-a', planningCycleId: 'cycle-1', repositoryPath: process.cwd(), canonicalWorktree: process.cwd(), trackerRef: 'preview' }),
        initialize: async () => rejected,
        bindLegacyIdentity: async () => rejected,
      },
      modelCatalog: { load: async () => ({ options: [{ configurationRef: 'config-a', model: 'preview-model-a' }, { configurationRef: 'config-b', model: 'preview-model-b' }], currentConfigurationRef: 'config-a', switchable: true, switchBlockReason: null }) },
      handoff: { prepareProposal: async () => rejected, cutover: async () => rejected, cancel: async () => rejected },
      executionHandoff: { prepare: async () => rejected, review: async () => rejected, cutover: async () => rejected, cancel: async () => rejected },
      executionAuthorization: { review: async () => ({ kind: 'rejected', code: rejected.code, message: rejected.message }), approve: async () => rejected },
    };
    let app;
    app = render(createElement(TuiApp, { ports, terminalWidth: process.stdout.columns ?? 80, initialScopeId: null, onExit: () => app.unmount() }), { exitOnCtrlC: false, interactive: true });
    await app.waitUntilExit();
  } catch (error) {
    process.stderr.write(`无法启动 TUI 预览：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
