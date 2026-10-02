import process from 'node:process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createElement } from 'react';
import { render } from 'ink';

const scenarios = ['planning', 'execution', 'blocked', 'empty', 'long-cjk', 'answer'];
const prototype = process.argv[2] === '--prototype';
const graphPrototype = process.argv[2] === '--graph-prototype';
const composerPrototype = process.argv[2] === '--composer-prototype';
const statusPrototype = process.argv[2] === '--status-prototype';
const dialogPrototype = process.argv[2] === '--dialog-prototype';
const sharedDialogs = dialogPrototype || statusPrototype;
const projectPrototype = process.argv[2] === '--project-prototype' || sharedDialogs;
const projectVariant = projectPrototype ? sharedDialogs ? 'tabs' : process.argv[4] ?? 'tabs' : null;
const requestedComposerVariant = composerPrototype ? process.argv[4] ?? 'above' : null;
const composerVariant = requestedComposerVariant === 'inside' ? 'inline' : requestedComposerVariant === 'above' ? 'review' : requestedComposerVariant;
const statusVariant = statusPrototype ? process.argv[4] ?? 'custom' : null;
const largeGraph = graphPrototype && process.argv[4] === 'large';
const adaptiveGraph = projectPrototype || (graphPrototype && process.argv[4] === 'adaptive');
const previewFlag = prototype || graphPrototype || composerPrototype || statusPrototype || projectPrototype;
const allowedScenarios = statusPrototype || projectPrototype ? ['planning', 'execution', 'blocked', 'answer', 'idle'] : composerPrototype ? ['slash', 'typing', 'long', 'images', 'answer'] : graphPrototype ? ['planning', 'execution', 'blocked'] : scenarios;
const scenario = process.argv[previewFlag ? 3 : 2] ?? (composerPrototype ? 'slash' : graphPrototype ? 'execution' : 'planning');
if (process.argv.length > (graphPrototype || composerPrototype || statusPrototype || projectPrototype ? 5 : previewFlag ? 4 : 3) || !allowedScenarios.includes(scenario) || (dialogPrototype && process.argv[4] !== undefined && process.argv[4] !== 'preview') || (projectPrototype && !['tabs', 'sections', 'menu'].includes(projectVariant)) || (statusPrototype && !['current', 'fixed', 'custom'].includes(statusVariant)) || (graphPrototype && process.argv[4] !== undefined && !largeGraph && !adaptiveGraph) || (composerPrototype && !['inline', 'review'].includes(composerVariant))) {
  process.stderr.write(`场景必须是：${allowedScenarios.join(', ')}${graphPrototype ? '；可追加 large 或 adaptive' : composerPrototype ? '；slash 可追加 inside 或 above' : statusPrototype ? '；可追加 current、fixed 或 custom' : dialogPrototype ? '' : projectPrototype ? '；可追加 tabs、sections 或 menu' : ''}\n`);
  process.exitCode = 2;
} else if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write('TUI 预览需要 stdin 和 stdout 均为 TTY\n');
  process.exitCode = 2;
} else {
  try {
    // 只导入 UI 构建产物。此脚本不装配生产 bootstrap、Controller 或外部 adapter。
    const { TuiApp } = await import('../dist/src/interfaces/tui/app.js');
    const { defaultStatusPreferences, statusPreferenceSchema } = await import('../dist/src/interfaces/tui/statusline-prototype.js');
    // Scratch user preferences for this prototype only; never a business checkpoint.
    const statusPreferencePath = process.env.ORCA_STATUS_PROTOTYPE_CONFIG
      ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'orca-companion', 'prototypes', 'statusline.json');
    let statusPreferences = defaultStatusPreferences;
    if (statusPrototype) {
      try { statusPreferences = statusPreferenceSchema.parse(JSON.parse(await readFile(statusPreferencePath, 'utf8'))); }
      catch (error) {
        if (error?.code !== 'ENOENT') process.stderr.write('原型状态栏偏好不可读，使用默认设置；保存可重设\n');
      }
    }
    const saveStatusPreferences = async (preferences) => {
      const validated = statusPreferenceSchema.parse(preferences);
      await mkdir(dirname(statusPreferencePath), { recursive: true });
      const temporary = statusPreferencePath + '.' + process.pid + '.tmp';
      await writeFile(temporary, JSON.stringify(validated, null, 2) + '\n', { mode: 0o600 });
      await rename(temporary, statusPreferencePath);
    };
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
      blockers: [], interactions: scenario === 'answer' ? [{ interactionId: 'preview-question', ownerCoordinatorSessionId: 'session-a',
        subjectRef: { kind: 'coordinator-session', id: 'session-a' }, expectedRevision: 7, state: 'open' }] : [], handoffs: [], recoveries: [],
      graphEvolution: { generations: [], revisionHolds: [], reconciliations: [], lineages: [], adoptions: [] },
      maintenance: null,
      graphTopologies: scenario === 'empty' ? [] : [graph],
      compaction: null, planningHandoffs: [],
    };
    const graphPrototypeSnapshots = graphPrototype || projectPrototype ? Object.fromEntries(
      ['planning', 'execution', 'blocked'].map((phase) => {
        const planning = phase === 'planning';
        const blocked = phase === 'blocked';
        const topology = {
          graphId: 'graph-prototype', graphVersion: 3, generation: 1,
          nodes: adaptiveGraph ? [
            ['项目基线', []],
            ['应用契约', [1]], ['TUI 基础', [1]], ['Orca 适配', [1]],
            ['命令入口', [2]], ['会话恢复', [2]], ['Transcript', [3]], ['执行图侧栏', [3]], ['运行后端', [4]],
            ['规划闭环', [5, 6]], ['Agent 循环', [6, 9]], ['Composer', [6, 7]], ['Graph Inspector', [8, 9]], ['对账', [9]],
            ['协调执行', [10, 11, 12]], ['图交互', [12, 13]], ['故障恢复', [11, 14]],
            ['Git 集成', [15, 17]], ['全链路验收', [16, 17, 18]], ['交付检查', [19]],
          ].map(([title, parents], index) => ({
            workPackageId: `wp-${index + 1}`, title,
            dependsOn: parents.map((number) => `wp-${number}`),
            scopeEnvelope: { include: ['src'], exclude: [] },
          })) : largeGraph ? [
            { workPackageId: 'wp-1', title: '项目基线', dependsOn: [], scopeEnvelope: { include: ['src/domain'], exclude: [] } },
            { workPackageId: 'wp-2', title: '会话契约', dependsOn: ['wp-1'], scopeEnvelope: { include: ['src/application'], exclude: [] } },
            { workPackageId: 'wp-3', title: 'TUI 基础', dependsOn: ['wp-1'], scopeEnvelope: { include: ['src/interfaces/tui'], exclude: [] } },
            { workPackageId: 'wp-4', title: '后端适配', dependsOn: ['wp-1'], scopeEnvelope: { include: ['src/adapters'], exclude: [] } },
            { workPackageId: 'wp-5', title: '命令入口', dependsOn: ['wp-2'], scopeEnvelope: { include: ['src/application'], exclude: [] } },
            { workPackageId: 'wp-6', title: '对话与输入', dependsOn: ['wp-2', 'wp-3'], scopeEnvelope: { include: ['src/interfaces/tui'], exclude: [] } },
            { workPackageId: 'wp-7', title: '图形侧栏', dependsOn: ['wp-3'], scopeEnvelope: { include: ['src/interfaces/tui'], exclude: [] } },
            { workPackageId: 'wp-8', title: '执行契约', dependsOn: ['wp-4'], scopeEnvelope: { include: ['src/application'], exclude: [] } },
            { workPackageId: 'wp-9', title: '协调闭环', dependsOn: ['wp-5', 'wp-6', 'wp-8'], scopeEnvelope: { include: ['src/workflow'], exclude: [] } },
            { workPackageId: 'wp-10', title: '图检查器', dependsOn: ['wp-7', 'wp-8'], scopeEnvelope: { include: ['src/interfaces/tui'], exclude: [] } },
            { workPackageId: 'wp-11', title: '全链路验收', dependsOn: ['wp-9', 'wp-10'], scopeEnvelope: { include: ['tests'], exclude: [] } },
            { workPackageId: 'wp-12', title: '交付检查', dependsOn: ['wp-11'], scopeEnvelope: { include: ['docs'], exclude: [] } },
          ] : [
            { workPackageId: 'wp-1', title: '项目基线', dependsOn: [], scopeEnvelope: { include: ['src/domain'], exclude: [] } },
            { workPackageId: 'wp-2', title: '对话主区', dependsOn: ['wp-1'], scopeEnvelope: { include: ['src/interfaces/tui'], exclude: [] } },
            { workPackageId: 'wp-3', title: '侧栏依赖图', dependsOn: ['wp-1'], scopeEnvelope: { include: ['src/interfaces/tui'], exclude: [] } },
            { workPackageId: 'wp-4', title: '命令入口', dependsOn: ['wp-2'], scopeEnvelope: { include: ['src/interfaces/tui'], exclude: [] } },
            { workPackageId: 'wp-5', title: '状态反馈', dependsOn: ['wp-2'], scopeEnvelope: { include: ['src/interfaces/tui'], exclude: [] } },
            { workPackageId: 'wp-6', title: '综合验收', dependsOn: ['wp-3', 'wp-4', 'wp-5'], scopeEnvelope: { include: ['tests/tui'], exclude: [] } },
            { workPackageId: 'wp-7', title: '交付检查', dependsOn: ['wp-6'], scopeEnvelope: { include: ['docs'], exclude: [] } },
          ],
          readiness: { generationStatus: planning ? 'candidate' : 'active', authorizationBound: !planning },
        };
        const entry = (workPackageId, state, overrides = {}) => ({
          workPackageId, state, role: null, attemptId: null, liveness: null,
          worktreePath: null, baselineHead: null, validation: null, integration: null,
          derivedFrom: projectPrototype && !planning ? [`fixture:${workPackageId}:${state}`] : [], blockerRefs: [], ...overrides,
        });
        const frontier = planning ? [] : adaptiveGraph ? topology.nodes.map((node, index) => {
          const number = index + 1;
          if (number <= 9) return entry(node.workPackageId, 'accepted');
          if (number === 12) return entry(node.workPackageId, blocked ? 'reconciling' : 'implementing', {
            role: 'implementation', attemptId: 'attempt-12', liveness: blocked ? 'unverifiable' : 'live',
            worktreePath: '/tmp/worktrees/wp-12', baselineHead: 'head-12',
            blockerRefs: blocked ? ['reconciliation_pending'] : [],
          });
          if (number === 13) return entry(node.workPackageId, 'blocked', {
            role: 'implementation', attemptId: 'attempt-13', liveness: 'unverifiable',
            blockerRefs: ['worker_status_unverifiable'],
          });
          return entry(node.workPackageId, 'waiting');
        }) : largeGraph ? [
          entry('wp-1', 'accepted'),
          entry('wp-2', 'accepted'),
          entry('wp-3', 'accepted'),
          entry('wp-4', 'accepted'),
          entry('wp-5', 'waiting'),
          entry('wp-6', blocked ? 'reconciling' : 'implementing', {
            role: 'implementation', attemptId: 'attempt-6', liveness: blocked ? 'unverifiable' : 'live',
            worktreePath: '/tmp/worktrees/wp-6', baselineHead: 'head-6',
            blockerRefs: blocked ? ['reconciliation_pending'] : [],
          }),
          entry('wp-7', 'waiting'),
          entry('wp-8', 'blocked', { liveness: 'unverifiable', blockerRefs: ['worker_status_unverifiable'] }),
          entry('wp-9', 'waiting'),
          entry('wp-10', 'waiting'),
          entry('wp-11', 'waiting'),
          entry('wp-12', 'waiting'),
        ] : [
          entry('wp-1', 'accepted'),
          entry('wp-2', 'accepted'),
          entry('wp-3', blocked ? 'reconciling' : 'implementing', {
            role: 'implementation', attemptId: 'attempt-3', liveness: blocked ? 'unverifiable' : 'live',
            worktreePath: '/tmp/worktrees/wp-3', baselineHead: 'head-3',
            blockerRefs: blocked ? ['reconciliation_pending'] : [],
          }),
          entry('wp-4', 'waiting'),
          entry('wp-5', 'blocked', { liveness: 'unverifiable', blockerRefs: ['worker_status_unverifiable'] }),
          entry('wp-6', 'waiting'),
          entry('wp-7', 'waiting'),
        ];
        const blockers = planning ? [] : [
          ...(blocked ? [{ source: 'injected', code: 'reconciliation_pending', message: `${adaptiveGraph ? 'wp-12' : largeGraph ? 'wp-6' : 'wp-3'} 等待原操作对账` }] : []),
          { source: 'injected', code: 'worker_status_unverifiable', message: `${adaptiveGraph ? 'wp-13' : largeGraph ? 'wp-8' : 'wp-5'} Worker 状态待核验` },
        ];
        return [phase, {
          ...snapshot,
          coordinationScopeId: 'scope-graph-preview',
          revision: blocked ? 12 : planning ? 8 : 11,
          mode: planning ? 'route_planning' : 'execution_coordination',
          controlState: blocked ? 'blocked' : 'active',
          graph: { graphId: topology.graphId, graphVersion: topology.graphVersion, generation: topology.generation },
          graphTopologies: [topology],
          authorization: planning ? null : { authorizationId: 'auth-graph', version: 1 },
          executionLeaseHolderSessionId: planning ? null : 'session-a',
          frontier, blockers,
          executionReconciliation: {
            pending: blocked, unresolvedIntentCount: blocked ? 1 : 0,
            activeWorkerCount: blocked || planning ? 0 : 1,
            reasons: blocked ? ['等待原操作对账'] : [],
          },
          finalizer: { ...snapshot.finalizer, gate: { ready: false, blockers: ['unfinished-work-packages'] } },
        }];
      }),
    ) : null;
    const transcript = {
      coordinatorSessionId: 'session-a',
      messages: scenario === 'empty' ? [] : [
        { role: 'user', content: scenario === 'long-cjk' ? `${cjk}，src/非常长的中文目录/多层路径/项目文件.ts，继续检查布局与裁切。`.repeat(3) : cjk, stepId: null },
        { role: 'assistant', content: 'Coordinator 会先读地图，再确认依赖与范围。', stepId: 'step-1' },
        { role: 'tool', content: 'search\n命中 3 个文件', stepId: 'step-2' },
      ],
      nextCursor: null,
    };
    const prototypeTranscript = scenario === 'empty' ? transcript : {
      ...transcript,
      messages: [
        { role: 'user', content: '先梳理现有决策，再告诉我执行前还缺什么。', stepId: null },
        { role: 'assistant', content: '我会先核对路线地图和未完成票据，再看哪些依赖还没有关闭。', stepId: 'step-earlier-1' },
        { role: 'tool', content: 'read_map\n路线地图 #37 · revision 3\n开放决策票据 2 项 · 待确认依赖 1 条', stepId: 'step-earlier-2' },
        { role: 'assistant', content: '地图已更新。当前还需要确认原型验收结果，才能固定第一批实现范围。', stepId: 'step-earlier-3' },
        { role: 'user', content: '依赖图里哪一步会挡住后面的实现？', stepId: null },
        { role: 'assistant', content: '我再看一次图的拓扑和当前阻塞。重点是先让日常对话路径可用，再决定侧栏里的图要显示到什么层级。', stepId: 'step-earlier-4' },
        { role: 'tool', content: 'read_graph\nwp-1  对话阅读与输入 · ready\nwp-2  侧栏拓扑表达 · waits for wp-1\nblocker  原型验收待确认', stepId: 'step-earlier-5' },
        { role: 'assistant', content: 'wp-2 等待 wp-1 的原型结论；当前真正挡路的是主工作区的阅读和输入方案。侧栏拓扑可以继续设计，但无需先实现。', stepId: 'step-earlier-6' },
        { role: 'user', content: scenario === 'long-cjk' ? transcript.messages[0].content : '请看一下主工作区：对话、工具输出和输入区应当一眼分得开。', stepId: null },
        { role: 'assistant', content: '我先检查 transcript 组件与现有主题，再把工具调用展开后会看到的内容放到原型里。', stepId: 'step-1' },
        { role: 'tool', content: 'rg -n Transcript src/interfaces/tui\nsrc/interfaces/tui/components/transcript.tsx:28: export function Transcript\nsrc/interfaces/tui/theme.ts:4: export const tuiColors\nsrc/interfaces/tui/screens/workspace.tsx:80: export function bodyWidth\n3 个位置命中 · 退出码 0', stepId: 'step-2' },
        { role: 'assistant', content: '主区按时间连续阅读。用户输入用青色边线定位，回复保留完整段落；工具默认只占一行，展开后原位显示有限输出。侧栏继续展示工作状态和依赖。', stepId: 'step-3' },
      ],
    };
    const composerPrototypeSnapshot = composerPrototype ? {
      ...snapshot,
      selectedSessionId: 'session-a',
      sessions: [
        { ...snapshot.sessions[0], openInteractionCount: 1 },
        { ...snapshot.sessions[0], coordinatorSessionId: 'session-b', coordinatorModelConfigurationRef: 'config-b', openInteractionCount: 0, planningResponsible: false },
      ],
      interactions: [{
        interactionId: 'interaction-preview-47', ownerCoordinatorSessionId: 'session-a',
        subjectRef: { kind: 'ticket', id: 'composer-question' }, expectedRevision: 12, state: 'open',
      }],
    } : null;
    const statusPrototypeSnapshots = statusPrototype || projectPrototype ? Object.fromEntries(
      ['planning', 'execution', 'blocked', 'answer', 'idle'].map((phase) => {
        const executing = phase === 'execution' || phase === 'blocked';
        const blocked = phase === 'blocked';
        return [phase, {
          ...snapshot,
          coordinationScopeId: 'scope-long-cjk-中文项目-2026-路线图-主工作区',
          mode: executing ? 'execution_coordination' : 'route_planning',
          controlState: blocked ? 'blocked' : 'active',
          graph: phase === 'idle' ? null : { graphId: 'graph-long-中文路线图', graphVersion: 3, generation: executing ? 2 : 1 },
          graphTopologies: phase === 'idle' ? [] : [{ ...graph, graphId: 'graph-long-中文路线图', graphVersion: 3, generation: executing ? 2 : 1,
            readiness: { generationStatus: executing ? 'active' : 'candidate', authorizationBound: executing } }],
          authorization: executing ? { authorizationId: 'auth-preview-long-id-2026', version: 2 } : null,
          executionLeaseHolderSessionId: blocked ? 'session-b' : executing ? 'session-long-中文规划-2026' : null,
          selectedSessionId: 'session-long-中文规划-2026',
          sessions: [
            { ...snapshot.sessions[0], coordinatorSessionId: 'session-long-中文规划-2026',
              holdsExecutionLease: executing && !blocked, openInteractionCount: phase === 'answer' || blocked ? 2 : 0 },
            { ...snapshot.sessions[0], coordinatorSessionId: 'session-b', planningResponsible: false,
              holdsExecutionLease: blocked, openInteractionCount: phase === 'answer' || blocked ? 1 : 0 },
          ],
          budgets: executing ? [{ budgetKey: 'work-packages', approvedLimitRef: 'authorization-v2', consumed: 3 }] : [],
          frontier: executing ? [{ workPackageId: 'wp-1', state: blocked ? 'reconciling' : 'implementing', role: 'implementation',
            attemptId: 'attempt-1', liveness: blocked ? 'unverifiable' : 'live', worktreePath: '/tmp/worktrees/wp-1',
            baselineHead: 'head-1', validation: null, integration: null, derivedFrom: [], blockerRefs: blocked ? ['reconciliation_pending'] : [] }] : [],
          finalizer: { ...snapshot.finalizer, gate: { ready: false, blockers: executing ? ['unfinished-work-packages'] : ['no-work-packages'] } },
          executionReconciliation: { pending: blocked, unresolvedIntentCount: blocked ? 1 : 0,
            activeWorkerCount: executing && !blocked ? 1 : 0, reasons: blocked ? ['等待原操作对账'] : [] },
          blockers: blocked ? [{ source: 'injected', code: 'reconciliation_pending', message: '原操作结果尚未核验' }] : [],
          interactions: phase === 'answer' || blocked ? [
            { interactionId: 'interaction-48', ownerCoordinatorSessionId: 'session-long-中文规划-2026',
              subjectRef: { kind: 'ticket', id: '48' }, expectedRevision: 7, state: 'open' },
            { interactionId: 'interaction-48-second', ownerCoordinatorSessionId: 'session-long-中文规划-2026',
              subjectRef: { kind: 'ticket', id: '48' }, expectedRevision: 8, state: 'open' },
            { interactionId: 'interaction-other', ownerCoordinatorSessionId: 'session-b',
              subjectRef: { kind: 'ticket', id: '49' }, expectedRevision: 9, state: 'open' },
          ] : [],
          maintenance: blocked ? { stopped: true, cyclesRun: 3, stopReason: 'reconciliation_pending' } : null,
          compaction: blocked ? { status: 'compaction_degraded', path: null, reason: '上下文不足', stillOverBudget: 100 } : null,
        }];
      }),
    ) : null;
    // Project, statusline and graph comparisons share these same bounded fixtures.
    const projectPrototypeSnapshots = projectPrototype ? Object.fromEntries(
      Object.entries(statusPrototypeSnapshots).map(([phase, chrome]) => {
        const execution = graphPrototypeSnapshots[phase === 'blocked' ? 'blocked' : phase === 'execution' ? 'execution' : 'planning'];
        return [phase, {
          ...chrome,
          graph: phase === 'idle' ? null : execution.graph,
          graphTopologies: phase === 'idle' ? [] : execution.graphTopologies,
          frontier: execution.frontier,
          blockers: phase === 'execution' || phase === 'blocked' ? execution.blockers : [],
          workers: execution.frontier.filter((entry) => entry.role !== null).map((entry) => ({
            dispatchId: `dispatch-${entry.workPackageId}`, workerTaskId: `task-${entry.workPackageId}`,
            workPackageId: entry.workPackageId, role: entry.role, liveness: entry.liveness,
          })),
        }];
      }),
    ) : null;
    const rejected = { kind: 'rejected', code: 'preview_read_only', message: '预览只读：没有连接真实项目' };
    const { openUiInputStore } = await import('../dist/src/adapters/storage/ui-input-store.js');
    const previewInputs = openUiInputStore({ databasePath: ':memory:' });
    if (previewInputs.kind !== 'opened') throw new Error(previewInputs.message);
    const ports = {
      questions: async (input) => input.kind === 'pending-interactions'
        ? { kind: 'pending-interactions', interactions: snapshot.interactions.filter((item) => item.ownerCoordinatorSessionId === input.coordinatorSessionId), nextCursor: null }
        : { kind: 'pending-interaction', interaction: snapshot.interactions.find((item) => item.interactionId === input.interactionId && item.ownerCoordinatorSessionId === input.coordinatorSessionId)
          ? { ...snapshot.interactions.find((item) => item.interactionId === input.interactionId), question: { text: '请确认中文路径与完整输入验收范围。', options: [{ label: '继续', description: '完成本批验收' }, { label: '稍后' }] } } : null },
      inputStore: previewInputs.store,
      submissionStatus: async () => ({ kind: 'unverifiable', reason: '预览不读取真实提交记录' }),
      snapshot: async (selectedSessionId) => ({ kind: 'snapshot', snapshot: { ...snapshot, selectedSessionId } }),
      transcript: async () => ({ kind: 'transcript', transcript }),
      execute: async (intent) => sharedDialogs ? intent.kind === 'switch-model-configuration' && intent.nextConfigurationRef === 'config-rejected'
        ? { kind: 'rejected', code: 'fixture_model_rejected', message: '候选配置验证失败；当前配置保留' }
        : { kind: 'accepted', revision: 7, summary: `模拟意图已记录：${intent.kind}；未执行真实操作` } : rejected,
      subscribe: () => () => {},
      scopeSetup: {
        resolveHome: async () => ({ kind: 'restore', coordinationScopeId: snapshot.coordinationScopeId }),
        verify: async () => [],
        proposal: async () => ({ coordinationScopeId: snapshot.coordinationScopeId, coordinatorSessionId: 'session-a', coordinatorModelConfigurationRef: 'config-a', planningCycleId: 'cycle-1', repositoryPath: process.cwd(), canonicalWorktree: process.cwd(), trackerRef: 'preview' }),
        initialize: async () => rejected,
        bindLegacyIdentity: async () => rejected,
      },
      modelCatalog: { load: async () => ({ options: [{ configurationRef: 'config-a', model: sharedDialogs ? '示例模型 A' : 'preview-model-a' }, { configurationRef: 'config-b', model: sharedDialogs ? '示例模型 B' : 'preview-model-b' },
        ...(sharedDialogs ? [{ configurationRef: 'config-rejected', model: '演示宿主拒绝的候选模型' }, { configurationRef: 'config-basic', model: '不支持 effort 的示例模型' }] : [])], currentConfigurationRef: 'config-a', switchable: true, switchBlockReason: null }) },
      handoff: { prepareProposal: async () => sharedDialogs ? { kind: 'accepted', revision: 7, summary: '模拟交接提案已准备' } : rejected,
        cutover: async () => sharedDialogs ? { kind: 'accepted', revision: 7, summary: '模拟规划交接已记录；Target 等待下一条消息' } : rejected,
        cancel: async () => sharedDialogs ? { kind: 'accepted', revision: 7, summary: '模拟规划交接提案已取消' } : rejected },
      executionHandoff: { prepare: async () => sharedDialogs ? { kind: 'accepted', revision: 7, summary: '模拟执行交接已准备' } : rejected,
        review: async () => rejected, cutover: async () => sharedDialogs ? { kind: 'accepted', revision: 7, summary: '模拟执行交接已记录；Target 等待下一条消息' } : rejected,
        cancel: async () => sharedDialogs ? { kind: 'accepted', revision: 7, summary: '模拟执行交接提案已取消' } : rejected },
      executionAuthorization: { review: async () => sharedDialogs ? { kind: 'review', review: {
        fingerprint: 'fixture-manifest-52', scopeRevision: 7,
        candidate: { graphId: 'graph-preview-20', generation: 1, version: 3, baselineHead: 'fixture-baseline-52', workPackageCount: 20 },
        manifestRows: [
          { label: '目标项目', value: 'scope-long-cjk-中文项目-2026-路线图-主工作区' },
          { label: '权限', value: '仅隔离工作区；无发布、部署或历史改写' },
          { label: '预算', value: '8 个 active Work Package；每包 2 次实现、2 次验证修复；并发 1（示例）' },
          { label: 'Git', value: 'Validator 接受后允许普通 commit、集成及推送唯一获批 ref' },
          { label: '依赖', value: '仅授权范围内的项目依赖操作' },
          { label: '风险', value: '中断恢复仍须对账；不可核验 Worker 不重复派发' },
          ...Array.from({ length: 8 }, (_, index) => ({ label: `工作范围 ${index + 1}`, value: `src/中文长路径/交互与终端验收/工作包-${index + 1}；测试和证据随交接提交` })),
        ], gate: { ready: true, blockers: [] },
      } } : { kind: 'rejected', code: rejected.code, message: rejected.message },
        approve: async () => sharedDialogs ? { kind: 'accepted', revision: 8, summary: '模拟授权批准已记录；未启动执行协调' } : rejected },
    };
    let app;
    const element = projectPrototype
      ? createElement((await import('../dist/src/interfaces/tui/project-panel-prototype.js')).ProjectPanelPrototype, {
          snapshots: projectPrototypeSnapshots,
          transcript: { ...prototypeTranscript, coordinatorSessionId: 'session-long-中文规划-2026' },
          otherTranscript: { coordinatorSessionId: 'session-b', nextCursor: null, messages: [
            { role: 'user', content: '请整理输入与执行图的规划依赖。', stepId: null },
            { role: 'assistant', content: '依赖已整理。请确认先处理输入还是执行图。', stepId: 'fixture-session-b' },
          ] },
          initialScene: scenario,
          initialVariant: projectVariant, terminalWidth: process.stdout.columns ?? 80,
          ...(statusPrototype ? { initialStatusVariant: statusVariant, initialStatusPreferences: statusPreferences, saveStatusPreferences } : {}),
          ...(sharedDialogs ? { dialogPorts: Object.fromEntries(['planning', 'execution', 'blocked', 'answer', 'idle'].map((phase) => [phase, {
            ...ports,
            modelCatalog: { load: async () => ({ ...await ports.modelCatalog.load(), switchable: phase !== 'execution' && phase !== 'blocked',
              switchBlockReason: phase === 'execution' || phase === 'blocked' ? '当前会话未挂起或存在在途模型操作' : null }) },
          }])) } : {}),
          onExit: () => app.unmount(),
        })
      : graphPrototype
      ? createElement((await import('../dist/src/interfaces/tui/graph-sidebar-prototype.js')).GraphSidebarPrototype, {
          snapshots: graphPrototypeSnapshots, scenario, terminalWidth: process.stdout.columns ?? 80, large: largeGraph, adaptive: adaptiveGraph,
          onExit: () => app.unmount(),
        })
      : composerPrototype
        ? createElement((await import('../dist/src/interfaces/tui/composer-prototype.js')).ComposerPrototype, {
            snapshot: composerPrototypeSnapshot, transcript: prototypeTranscript, scene: scenario, initialVariant: composerVariant,
            terminalWidth: process.stdout.columns ?? 80, onExit: () => app.unmount(),
          })
      : prototype
        ? createElement((await import('../dist/src/interfaces/tui/workspace-prototype.js')).WorkspacePrototype, {
            snapshot, transcript: prototypeTranscript, terminalWidth: process.stdout.columns ?? 80,
            scenario, onExit: () => app.unmount(),
          })
        : createElement(TuiApp, { ports, terminalWidth: process.stdout.columns ?? 80, initialScopeId: null, onExit: () => app.unmount() });
    app = render(element, { exitOnCtrlC: false, interactive: true });
    try {
      await app.waitUntilExit();
    } finally {
      previewInputs.store.close();
    }
  } catch (error) {
    process.stderr.write(`无法启动 TUI 预览：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
