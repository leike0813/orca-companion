import process from 'node:process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout, clearTimeout } from 'node:timers';
import { createElement } from 'react';
import { render } from 'ink';

const scenarios = ['planning', 'execution', 'blocked', 'empty', 'long-cjk', 'answer', 'disabled', 'alignment', 'alignment-planning', 'history', 'streaming'];
// 只打印用法并以 0 退出：让「命令存在且可自述」成为可核验事实，不进入 TTY 分支。
if (process.argv[2] === '--help' || process.argv[2] === '-h') {
  process.stdout.write([
    '用法：pnpm ui:preview [--preview-flag] [场景] [变体]',
    '',
    '场景：' + scenarios.join(' | '),
    '  --prototype            连续聊天原型',
    '  --graph-prototype      执行图原型（可追加 large 或 adaptive）',
    '  --composer-prototype   输入原型（可追加 inline 或 above）',
    '  --status-prototype     选项原型（可追加 current、fixed 或 custom）',
    '  --dialog-prototype     弹窗原型（场景限 planning/execution/blocked/answer/idle）',
    '  --project-prototype    项目面板原型（可追加 tabs、sections 或 menu）',
    '  --help                 打印本用法',
    '',
    '需要 stdin 与 stdout 均为 TTY；未列出的入口场景以其自身说明为准。',
  ].join('\n') + '\n');
  process.exit(0);
}

const alignmentPreview = ['alignment', 'alignment-planning'].includes(process.argv[2]);
const pendingPreview = process.env.ORCA_COMPANION_PENDING_INTERACTIONS === '1';
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
const adaptiveGraph = alignmentPreview || projectPrototype || (graphPrototype && process.argv[4] === 'adaptive');
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
      compaction: scenario === 'disabled' ? { status: 'context_exhausted', path: null,
        reason: '隔离预览：上下文预算耗尽', stillOverBudget: 1 } : null, planningHandoffs: [],
    };
    const graphPrototypeSnapshots = graphPrototype || projectPrototype || alignmentPreview ? Object.fromEntries(
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
    const statusPrototypeSnapshots = statusPrototype || projectPrototype || alignmentPreview ? Object.fromEntries(
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
    const projectPrototypeSnapshots = projectPrototype || alignmentPreview ? Object.fromEntries(
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
    // The full-map fixture mounts production TuiApp; only its ports are isolated fakes.
    const previewDialogs = sharedDialogs || alignmentPreview;
    if (alignmentPreview) {
      Object.assign(snapshot, projectPrototypeSnapshots[scenario === 'alignment-planning' ? 'answer' : 'blocked']);
      snapshot.planningHandoffs = [{ proposalId: 'fixture-planning-handoff', sourceSessionId: 'session-long-中文规划-2026', targetSessionId: 'session-b',
        phase: 'prepared', capsuleRef: 'fixture-capsule', mapRevision: snapshot.mapRevision, planRevision: 1, proposalRevision: 1 }];
      snapshot.handoffs = [{ handoffId: 'fixture-execution-handoff', sourceSessionId: 'session-b', targetSessionId: 'session-long-中文规划-2026',
        phase: 'reviewed', graphGeneration: snapshot.graph.generation, expectedRevision: snapshot.revision,
        responsibilitySet: ['execution_coordination_lease', 'pending_interactions', 'worker_lifecycle_events'] }];
    }
    const rejected = { kind: 'rejected', code: 'preview_read_only', message: '预览只读：没有连接真实项目' };
    const { openUiInputStore } = await import('../dist/src/adapters/storage/ui-input-store.js');
    const previewInputs = openUiInputStore({ databasePath: ':memory:' });
    if (previewInputs.kind !== 'opened') throw new Error(previewInputs.message);
    const { openCheckpointStore } = await import('../dist/src/adapters/storage/checkpoint-store.js');
    const { readTranscriptPage } = await import('../dist/src/application/coordinator/history.js');
    const { createTranscriptPreviewStore } = await import('../dist/src/adapters/storage/transcript-preview-store.js');
    const previewStore = createTranscriptPreviewStore();
    const history = openCheckpointStore({ databasePath: ':memory:' });
    if (history?.kind === 'failed') throw new Error(history.message);
    if (history?.kind === 'opened' && scenario === 'history') {
      history.store.saveCheckpoint({ schemaVersion: 2, coordinatorSessionId: 'session-a', graphPosition: 'suspend',
        committedMessages: [], committedModelSteps: [], wakeBatches: [], lastCompactionOutcome: null });
      for (let index = 0; index < 320; index += 1) {
        const content = index === 0 ? '历史起点 0 · 请从第一条开始阅读。'
          : index === 319 ? '历史终点 319 · 全部原文可按页阅读。'
          : index === 150 ? '巨型正文 中文abc🙂\n'.repeat(12000) : `历史条目 ${index} · 中文abc混排与分页。`;
        const saved = history.store.appendMessage('session-a', { entryId: `history-${index}`, stepId: `history-${index}`,
          role: index % 2 === 0 ? 'user' : 'assistant', content });
        if (saved.kind === 'failed') throw new Error(saved.message);
      }
    }
    if (history.kind === 'opened' && scenario !== 'history') {
      for (const session of snapshot.sessions) {
        const saved = history.store.saveCheckpoint({ schemaVersion: 2, coordinatorSessionId: session.coordinatorSessionId, graphPosition: 'suspend',
          committedMessages: transcript.messages.map((message, index) => ({ ...message, entryId: `preview-${index}`, stepId: message.stepId ?? `preview-step-${index}`,
            ...(message.role === 'tool' ? { toolCallId: `preview-call-${index}`, toolName: message.content.split('\n')[0], content: message.content.split('\n').slice(1).join('\n') } : {}) })),
          committedModelSteps: [], wakeBatches: [], lastCompactionOutcome: null });
        if (saved.kind === 'failed') throw new Error(saved.message);
      }
    }
    if (process.env.ORCA_COMPANION_HISTORY_INSPECTION === '1') {
      const messages = [{ entryId: 'inspect-user', stepId: 'inspect-user', role: 'user', content: '历史输入 中文🙂 原文' }];
      for (let n = 0; n < 130; n++) {
        const call = { callId: 'inspect-call-' + n, name: 'read_route_map', operationId: 'inspect-operation-' + n, mapOperationId: null,
          activityKind: 'query', args: { query: n === 0 ? '参数边界 中文KELVINK' : '查询 ' + n, payload: n === 0 ? 'x'.repeat(1048576) : n } };
        messages.push({ entryId: 'inspect-step-' + n, stepId: 'inspect-step-' + n, role: 'assistant', content: '', toolCalls: [call] });
        messages.push({ entryId: 'inspect-result-' + n, stepId: 'inspect-step-' + n, role: 'tool', toolCallId: call.callId,
          toolName: call.name, content: JSON.stringify(n === 70 ? { kind: 'rejected', code: 'fixture_rejected', message: '范围拒绝' } : { kind: 'ok', value: '结果边界 ' + n }) });
      }
      messages.push({ entryId: 'inspect-break', stepId: 'inspect-break', role: 'assistant', content: '活动详情与查找 · 参数、结果均从原记录读取。' });
      messages.push({ entryId: 'inspect-action', stepId: 'inspect-action', role: 'assistant', content: '', toolCalls: [{ callId: 'inspect-action-call',
        name: 'update_route_map', args: { section: 'destination' }, operationId: 'inspect-action-op', mapOperationId: null, activityKind: 'action' }] });
      messages.push({ entryId: 'inspect-last-user', stepId: 'inspect-last-user', role: 'user', content: '最新输入 保留光标与草稿' });
      for (const session of snapshot.sessions) {
      const saved = history.store.saveCheckpoint({ schemaVersion: 2, coordinatorSessionId: session.coordinatorSessionId, graphPosition: 'suspend',
        committedMessages: messages, committedModelSteps: messages.filter(entry => entry.toolCalls).map(entry => ({ stepId: entry.stepId, entryId: entry.entryId,
          committedAt: 1, messages: [{ role: 'assistant', content: entry.content, toolCalls: entry.toolCalls }], toolCalls: entry.toolCalls, usage: null })),
        wakeBatches: [], lastCompactionOutcome: null });
      if (saved.kind !== 'saved') throw new Error(saved.message);
      const observed = history.store.recordToolObservation({ coordinatorSessionId: session.coordinatorSessionId, entryId: 'inspect-action', stepId: 'inspect-action',
        callId: 'inspect-action-call', operationId: 'inspect-action-op', kind: 'unknown', reason: '预览模拟响应丢失' });
      if (observed.kind !== 'saved') throw new Error(observed.message);
      }
    }
    while (!history.store.prepareHistoryInspection().ready) await new Promise(resolve => setTimeout(resolve, 0));
    const { scanHistory } = await import('../dist/src/application/coordinator/history-search.js');
    const { openCoordinationStore } = await import('../dist/src/adapters/storage/coordination-store.js');
    const { createUserQuestion, answerPendingInteraction } = await import('../dist/src/application/coordination/pending-interaction.js');
    const branch = pendingPreview ? openCoordinationStore({ databasePath: ':memory:' }) : null;
    if (branch !== null && branch.kind !== 'opened') throw new Error(branch.message);
    const questionListeners = new Set();
    const scope = snapshot.coordinationScopeId;
    const writer = session => ({ coordinatorSessionId: session, runtimeIncarnationId: 'preview-' + session, fencingGeneration: 1 });
    const questionQuery = input => {
      const result = branch.store.query({ ...input, coordinationScopeId: scope });
      if (result.kind === 'rejected') throw new Error(result.code + ': ' + result.message);
      return result;
    };
    if (branch?.kind === 'opened') {
      const store = branch.store;
      let result = store.transact({ kind: 'create-scope', coordinationScopeId: scope, expectedRevision: 0, writer: writer('session-a'),
        mode: 'route_planning', controlState: 'active', planningCycleId: 'preview-cycle', fullBranchRef: 'refs/heads/preview', canonicalWorktreePath: process.cwd() });
      if (result.kind !== 'committed') throw new Error(result.message);
      const transact = command => {
        const revision = questionQuery({ kind: 'scope' }).scope.revision;
        const result = store.transact({ ...command, coordinationScopeId: scope, expectedRevision: revision });
        if (result.kind !== 'committed') throw new Error(result.message);
      };
      snapshot.sessions = ['session-a', 'session-b'].map((id, index) => ({ ...snapshot.sessions[0], coordinatorSessionId: id,
        coordinatorModelConfigurationRef: index === 0 ? 'config-a' : 'config-b', planningResponsible: index === 0 }));
      for (const session of snapshot.sessions) {
        const id = session.coordinatorSessionId;
        transact({ kind: 'register-session', writer: { ...writer('session-a'), fencingGeneration: id === 'session-a' ? 0 : 1 }, coordinatorSessionId: id,
          coordinatorModelConfigurationRef: session.coordinatorModelConfigurationRef, lifecycleState: 'registered' });
        transact({ kind: 'acquire-runtime-lease', writer: { ...writer(id), fencingGeneration: 0 }, ttlMs: 3600000 });
        const messages = [{ entryId: 'intro-' + id, stepId: 'intro-' + id, role: 'user', content: '请核验待答联动，保留中文草稿与阅读位置。' }];
        for (let n = 0; n < (id === 'session-a' ? 2 : 24); n++) {
          const operationId = 'pending-' + id + '-' + n;
          const question = { text: id === 'session-a' ? n === 0 ? '已经回答的问题：完整回答仍在原提问处。' : '当前会话问题：请确认本批验收范围。'
            : `跨会话问题 ${n + 1}：请确认中文路径、输入和恢复验收。`,
            options: [{ label: '继续', description: '完成本批验证' }, { label: '稍后' }] };
          const created = createUserQuestion({ store, coordinationScopeId: scope, writer: writer(id), operationId, question });
          if (created.kind !== 'recorded') throw new Error(created.message ?? created.reason);
          const call = { callId: 'call-' + operationId, name: 'ask_user', operationId, mapOperationId: null, activityKind: 'action', args: question };
          messages.push({ entryId: 'entry-' + operationId, stepId: operationId, role: 'assistant', content: '', toolCalls: [call] });
          messages.push({ entryId: 'result-' + operationId, stepId: operationId, role: 'tool', toolName: 'ask_user', toolCallId: call.callId,
            content: JSON.stringify({ kind: 'ok', value: { interactionId: created.interaction.interactionId } }) });
          if (id === 'session-a' && n === 0) {
            result = answerPendingInteraction({ store, coordinationScopeId: scope, writer: writer(id), interactionId: created.interaction.interactionId,
              expectedRevision: created.interaction.expectedRevision, submissionId: 'initial-answer', answer: '确认通过，问答正文由原记录保存。\n中文🙂与选项均完整保留。' });
            if (result.kind !== 'answered') throw new Error(result.message);
          }
        }
        result = history.store.saveCheckpoint({ schemaVersion: 2, coordinatorSessionId: id, graphPosition: 'suspend', committedMessages: messages,
          committedModelSteps: messages.filter(entry => entry.toolCalls).map(entry => ({ stepId: entry.stepId, entryId: entry.entryId, committedAt: 1,
            messages: [{ role: 'assistant', content: entry.content, toolCalls: entry.toolCalls }], toolCalls: entry.toolCalls, usage: null })), wakeBatches: [], lastCompactionOutcome: null });
        if (result.kind !== 'saved') throw new Error(result.message);
      }
      while (!history.store.prepareHistoryInspection().ready) await new Promise(resolve => setTimeout(resolve, 0));
    }
    snapshot.openInteractionCount = snapshot.interactions.filter(item => item.state === 'open').length;
    const fixtureRef=(kind,id)=>({kind,coordinationScopeId:snapshot.coordinationScopeId,...(kind==='planning-handoff'?{proposalId:id,revision:1,phase:'prepared'}:{handoffId:id,revision:0,phase:'reviewed'})});
    // 预览用的角色模型目录：候选、effort 能力来源与不可用原因都是显式夹具，不是生产事实。
    const previewEffort=(values,source)=>values.length===0?null:{values,source,optionPath:'modelReasoningEffort'};
    const previewModels=previewDialogs
      ? [
        {ref:'config-a',provider:'openai',model:'示例模型 A',effort:previewEffort(['low','medium','high'],'fixture:capability-a')},
        {ref:'config-b',provider:'openai',model:'示例模型 B',effort:previewEffort(['low','medium'],'fixture:capability-b')},
        {ref:'config-rejected',provider:'anthropic',model:'示例模型 C',effort:previewEffort(['medium','high'],'fixture:capability-c')},
        {ref:'config-basic',provider:'example',model:'示例模型 D',effort:previewEffort([],'fixture:capability-d')},
      ]
      : [
        {ref:'config-a',provider:'preview',model:'preview-model-a',effort:previewEffort(['low','medium','high'],'fixture:capability-a')},
        {ref:'config-b',provider:'preview',model:'preview-model-b',effort:previewEffort(['low','medium'],'fixture:capability-b')},
      ];
    const previewCandidate=(model)=>({candidateRef:model.ref,connectionRef:'fixture-connection',provider:model.provider,model:model.model,effortCapability:model.effort});
    const previewModelOptions=previewModels.map(model=>({configurationRef:model.ref,model:model.model,provider:model.provider,effortCapability:model.effort}));
    const previewBoundRole=(role,label,group,modelRef,effort)=>({
      role,label,group,
      current:modelRef===null?null:{candidateRef:modelRef,provider:previewModels.find(m=>m.ref===modelRef)?.provider??'',model:previewModels.find(m=>m.ref===modelRef)?.model??'',effort},
      candidates:previewModels.map(previewCandidate),
      availability:{available:true,reason:null},
    });
    const previewUnavailableRole=(role,label,group,reason)=>({role,label,group,current:null,candidates:[],availability:{available:false,reason}});
    const previewModelRoles=[
      previewBoundRole('coordinator','Coordinator','current','config-a','high'),
      previewUnavailableRole('planning_utility','Utility','planning','规划 Utility 没有生产生命周期：本版本不派发该角色'),
      previewBoundRole('planner','Planner','execution','config-a','high'),
      previewUnavailableRole('specification_validator','Spec Validator','execution','Specification Validator 没有生产生命周期：规格准入只做确定性结构检查'),
      previewBoundRole('implementation','Implementation','execution','config-a','high'),
      previewBoundRole('validator','Validator','execution','config-a','high'),
      previewBoundRole('finalizer','Finalizer','execution','config-a','high'),
      previewBoundRole('recovery_utility','Recovery Utility','execution','config-b','medium'),
    ];
    const previewConnection={connectionRef:'fixture-connection',label:'主连接',providerIntegration:'openai',
      // 非秘密选项里不出现任何 key 或占位秘密；凭据只以 opaque 引用存在。
      modelOptions:{},credential:{kind:'managed',credentialRef:'fixture-credential',optionPath:'apiKey'},
      codex:{providerId:'openai',baseUrl:'https://api.openai.com/v1',wireApi:'responses'}};
    const previewCapability={values:['low','medium','high'],source:'fixture:capability-a',optionPath:'modelReasoningEffort'};
    const previewModelSettingsSnapshot={
      revision:7,
      roles:[
        {role:'coordinator',bindingRef:'config-a',connectionRef:'fixture-connection',connectionLabel:'主连接',providerIntegration:'openai',model:'示例模型 A',effort:'high',effortCapability:previewCapability,harness:null},
        {role:'planner',bindingRef:'profile-planner',connectionRef:'fixture-connection',connectionLabel:'主连接',providerIntegration:'openai',model:'示例模型 A',effort:'high',effortCapability:previewCapability,harness:'codex'},
        {role:'implementation',bindingRef:'profile-implementation',connectionRef:'fixture-connection',connectionLabel:'主连接',providerIntegration:'openai',model:'示例模型 A',effort:'high',effortCapability:previewCapability,harness:'codex'},
        {role:'validator',bindingRef:'profile-validator',connectionRef:'fixture-connection',connectionLabel:'主连接',providerIntegration:'openai',model:'示例模型 A',effort:'high',effortCapability:previewCapability,harness:'codex'},
        {role:'finalizer',bindingRef:'profile-finalizer',connectionRef:'fixture-connection',connectionLabel:'主连接',providerIntegration:'openai',model:'示例模型 A',effort:'high',effortCapability:previewCapability,harness:'codex'},
        {role:'recovery_utility',bindingRef:'profile-recovery',connectionRef:'fixture-connection',connectionLabel:'主连接',providerIntegration:'openai',model:'示例模型 B',effort:'medium',effortCapability:{values:['low','medium'],source:'fixture:capability-b',optionPath:'modelReasoningEffort'},harness:'codex'},
      ],
      connections:[previewConnection],
      models:previewModels.map(model=>({modelRef:model.ref,connectionRef:'fixture-connection',model:model.model,effortCapability:model.effort})),
      coordinatorConfigurations:previewModels.map(model=>({configurationRef:model.ref,model:model.model,effort:model.ref==='config-a'?'high':null})),
    };
    const ports = {
      commandStatus: async ref=>({kind:'accepted',revision:null,summary:'隔离 fixture 核验',resultRef:ref}),
      reading: {
        interactions: async (session, interactionIds) => branch?.kind === 'opened'
          ? questionQuery({ kind: 'interaction-summaries', coordinatorSessionId: session, interactionIds }).interactions : [],
        inspection: {
          snapshot: async session => history.store.readHistoryInspection(session),
          calls: async query => history.store.readHistoryCalls(query),
          users: async query => history.store.readUserHistoryPage(query),
          search: (query, signal) => scanHistory(ports.reading, query, signal),
        },
        history: async (query) => history.store.readHistoryPage(query),
        body: async (query) => {
          if (query.source.kind === 'preview') return previewStore.body(query);
          if (query.source.kind === 'interaction') {
            if (branch?.kind !== 'opened') return null;
            const result = branch.store.query({ kind: 'interaction-body', coordinationScopeId: scope, coordinatorSessionId: query.coordinatorSessionId,
              interactionId: query.source.interactionId, part: query.source.part, contentRevision: query.source.contentRevision, offset: query.offset, maxBytes: query.maxBytes });
            if (result.kind === 'rejected') {
              if (result.code === 'invalid_utf8_offset') throw new (await import('../dist/src/application/coordinator/history.js')).HistoryBoundaryError(result.message);
              throw new Error(result.message);
            }
            return result.body === null ? null : { source: query.source, ...result.body };
          }
          if (query.source.kind === 'arguments') return history.store.readHistoryArguments({ coordinatorSessionId: query.coordinatorSessionId,
            entryId: query.source.entryId, stepId: query.source.stepId, callId: query.source.callId, contentRevision: 1, offset: query.offset, maxBytes: query.maxBytes });
          const range = history.store.readHistoryBody({ coordinatorSessionId: query.coordinatorSessionId, entryId: query.source.entryId,
            contentRevision: 1, offset: query.offset, maxBytes: query.maxBytes });
          return range === null ? null : { source: query.source, offset: range.offset, end: range.end, byteLength: range.byteLength, text: range.text };
        },
        previews: async (sessionId) => previewStore.list(sessionId), pin: previewStore.pin, subscribe: previewStore.subscribe,
      },
      questions: async (input) => branch?.kind === 'opened' ? questionQuery(input) : input.kind === 'pending-interactions'
        ? { kind: 'pending-interactions', interactions: snapshot.interactions.filter((item) => input.coordinatorSessionId === undefined || item.ownerCoordinatorSessionId === input.coordinatorSessionId), nextCursor: null }
        : { kind: 'pending-interaction', interaction: snapshot.interactions.find((item) => item.interactionId === input.interactionId && item.ownerCoordinatorSessionId === input.coordinatorSessionId)
          ? { ...snapshot.interactions.find((item) => item.interactionId === input.interactionId), answerRef: null, answerText: null, question: { text: '请确认中文路径与完整输入验收范围。', options: [{ label: '继续', description: '完成本批验收' }, { label: '稍后' }] } } : null },
      inputStore: previewInputs.store,
      submissionStatus: async () => ({ kind: 'unverifiable', reason: '预览不读取真实提交记录' }),
      snapshot: async (selectedSessionId) => {
        if (branch?.kind === 'opened') {
          const overview = questionQuery({ kind: 'presentation-snapshot', ...(selectedSessionId === null ? {} : { coordinatorSessionId: selectedSessionId }) }).snapshot.interactionOverview;
          snapshot.interactions = overview.items; snapshot.openInteractionCount = overview.openCount;
          snapshot.sessions = snapshot.sessions.map(session => ({ ...session, openInteractionCount: overview.sessionCounts.find(count => count.coordinatorSessionId === session.coordinatorSessionId)?.openCount ?? 0 }));
        }
        return { kind: 'snapshot', snapshot: { ...snapshot, selectedSessionId } };
      },
      transcript: async (coordinatorSessionId, cursor) => {
        try { return { kind: 'transcript', transcript: history?.kind === 'opened'
          ? readTranscriptPage(history.store, coordinatorSessionId, cursor) : { ...transcript, coordinatorSessionId } }; }
        catch (error) { return { kind: 'failed', code: 'history_unreadable', message: String(error) }; }
      },
      execute: async (intent) => {
        if (branch?.kind === 'opened' && intent.kind === 'answer-pending-interaction') {
          const result = answerPendingInteraction({ store: branch.store, coordinationScopeId: scope, writer: writer(intent.coordinatorSessionId),
            interactionId: intent.interactionId, expectedRevision: intent.expectedRevision, submissionId: intent.submissionId, answer: intent.answer });
          if (result.kind === 'rejected') return result;
          for (const listener of questionListeners) listener({ eventId: 'answer-' + intent.submissionId, kind: 'interaction-resolved', coordinationScopeId: scope,
            coordinatorSessionId: intent.coordinatorSessionId, interactionId: intent.interactionId });
          return { kind: 'accepted', revision: result.revision, summary: '隔离预览回答已保存' };
        }
        return previewDialogs ? intent.kind === 'switch-model-configuration' && intent.nextConfigurationRef === 'config-rejected'
        ? { kind: 'rejected', code: 'fixture_model_rejected', message: '候选配置验证失败；当前配置保留' }
        : { kind: 'accepted', revision: 7, summary: `模拟意图已记录：${intent.kind}；未执行真实操作` } : rejected;
      },
      subscribe: (listener) => {
        questionListeners.add(listener);
        if (!alignmentPreview) return () => {};
        const timer = setTimeout(() => {
          for (let index = 0; index < 4; index++) listener({ eventId: 'fixture-event-'+index, kind: 'scope-control-changed',
            coordinationScopeId: snapshot.coordinationScopeId, coordinatorSessionId: null, controlState: snapshot.controlState, revision: snapshot.revision });
        }, 100);
        return () => { clearTimeout(timer); questionListeners.delete(listener); };
      },
      scopeSetup: {
        resolveHome: async () => ({ kind: 'restore', coordinationScopeId: snapshot.coordinationScopeId }),
        verify: async () => [],
        proposal: async () => ({ coordinationScopeId: snapshot.coordinationScopeId, coordinatorSessionId: 'session-a', coordinatorModelConfigurationRef: 'config-a', planningCycleId: 'cycle-1', repositoryPath: process.cwd(), canonicalWorktree: process.cwd(), trackerRef: 'preview' }),
        initialize: async () => rejected,
        bindLegacyIdentity: async () => rejected,
      },
      modelCatalog: { load: async () => ({ options: previewModelOptions, currentConfigurationRef: 'config-a', switchable: true, switchBlockReason: null,
        configurationRevision: 7, roles: previewModelRoles }) },
      // 预览宿主：保存只追加记录并返回新引用，授权替换仍由 executionAuthorization 审阅后批准。
      modelSettings: previewDialogs ? {
        load: async () => ({ kind: 'loaded', snapshot: previewModelSettingsSnapshot }),
        save: async (input) => ({ kind: 'saved', revision: previewModelSettingsSnapshot.revision + 1,
          configurationRef: input.role === 'coordinator' ? 'config-saved' : null,
          profileRef: input.role === 'coordinator' ? null : 'profile-saved' }),
        apply: async (input) => ({ kind: 'saved', revision: previewModelSettingsSnapshot.revision + 1,
          configurationRef: input.role === 'coordinator' ? 'config-saved' : null,
          profileRef: input.role === 'coordinator' ? null : 'profile-saved' }),
      } : undefined,
      handoff: { read: async id=>snapshot.planningHandoffs.find(p=>p.proposalId===id)??null,
        prepareProposal: async () => previewDialogs ? { kind: 'accepted', revision: 7, summary: '模拟交接提案已准备',resultRef:fixtureRef('planning-handoff','fixture-planning-handoff') } : rejected,
        cutover: async () => previewDialogs ? { kind: 'accepted', revision: 7, summary: '模拟规划交接已记录；Target 等待下一条消息' } : rejected,
        cancel: async () => previewDialogs ? { kind: 'accepted', revision: 7, summary: '模拟规划交接提案已取消' } : rejected },
      executionHandoff: { read: async id=>snapshot.handoffs.find(p=>p.handoffId===id)??null,
        prepare: async () => previewDialogs ? { kind: 'accepted', revision: 7, summary: '模拟执行交接已准备',resultRef:fixtureRef('execution-handoff','fixture-execution-handoff') } : rejected,
        review: async () => rejected, cutover: async () => previewDialogs ? { kind: 'accepted', revision: 7, summary: '模拟执行交接已记录；Target 等待下一条消息' } : rejected,
        cancel: async () => previewDialogs ? { kind: 'accepted', revision: 7, summary: '模拟执行交接提案已取消' } : rejected },
      executionAuthorization: { review: async () => previewDialogs ? { kind: 'review', review: {
        sections:[{id:'overview',label:'概览',fields:[{label:'项目',value:snapshot.coordinationScopeId},{label:'图',value:snapshot.graph.graphId},{label:'工作包',value:'20'},{label:'门禁',value:'通过'}]},{id:'permissions',label:'权限',fields:[{label:'工作区',value:'仅隔离 worktree'},{label:'发布/部署',value:'无授权'}]},{id:'budget',label:'预算',fields:[{label:'并发',value:'1'},{label:'实现/验证',value:'每包 2 次'}]},{id:'workspace',label:'工作范围',fields:Array.from({length:8},(_,i)=>({label:'工作包 '+(i+1),value:'src/中文长路径/交互与终端验收/'+(i+1)}))},{id:'complete',label:'完整清单',fields:[{label:'fingerprint',value:'fixture-manifest-52'},{label:'Scope revision',value:'7'},{label:'Git',value:'main/origin 唯一 ref'}]}].map(section=>({...section,fields:section.fields.map(field=>({...field,group:{overview:'执行计划',permissions:'允许的操作',budget:'执行上限',workspace:'隔离工作范围',complete:'批准绑定的完整内容'}[section.id]}))})),
        fingerprint: 'fixture-manifest-52', scopeRevision: 7,
        candidate: { graphId: snapshot.graph.graphId, generation: 1, version: 3, baselineHead: 'fixture-baseline-52', workPackageCount: 20 },
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
        approve: async () => previewDialogs ? { kind: 'accepted', revision: 8, summary: '模拟授权批准已记录；未启动执行协调' } : rejected },
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
    const previewAbort = new globalThis.AbortController();
    let previewLoop = Promise.resolve();
    if (scenario === 'streaming') {
      const { BaseChatModel } = await import('@langchain/core/language_models/chat_models');
      const { AIMessageChunk } = await import('@langchain/core/messages');
      const { ChatGenerationChunk } = await import('@langchain/core/outputs');
      const { buildCoordinatorGraph } = await import('../dist/src/workflow/coordinator/graph.js');
      const { projectActionableWork } = await import('../dist/src/application/coordinator/actionable-work.js');
      class PreviewModel extends BaseChatModel {
        _llmType() { return 'isolated-preview'; }
        _generate() { throw new Error('preview uses stream'); }
        bindTools() { return this; }
        async *_streamResponseChunks(_messages, options) {
          for (let index = 0; index < 100; index++) {
            if (options.signal?.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
            const text = index === 0 ? '# 流式中文阅读\n\n**稳定前缀**与尚未提交的正文。\n\n'
              : '读取原文范围 '.repeat(160) + `\n流式段落 ${index} · 中文🙂abc\n`;
            yield new ChatGenerationChunk({ text, message: new AIMessageChunk(text) });
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        }
      }
      const graph = buildCoordinatorGraph({ model: new PreviewModel({}), checkpointer: history.store.checkpointer,
        sessionRecords: history.store, assertFencing: () => ({ kind: 'valid', lease: {} }), newStepId: () => 'preview-stream-step',
        buildMessages: async () => ({ messages: [], note: 'isolated preview' }),
        streamObserver: event => previewStore.observe(event, history.store.readHistoryPage({ coordinatorSessionId: 'session-a' }).entries.at(-1)?.sequence ?? 0),
      });
      const work = projectActionableWork({ coordinatorSessionId: 'session-a', controlState: 'active', admitted: [],
        observations: [{ source: { sourceKind: 'delivery', sourceId: 'preview-source', revision: 1 }, classification: 'worker_question',
          summary: '流式阅读', ownerCoordinatorSessionId: 'session-a' }] });
      previewLoop = new Promise(resolve => setTimeout(resolve, 500)).then(() => graph.invoke({ coordinatorSessionId: 'session-a', remainingWork: work.items,
        deferredWork: 0, pendingToolCalls: 0 }, { configurable: { thread_id: 'preview-stream' }, signal: previewAbort.signal })).catch(error => {
          if (!previewAbort.signal.aborted) process.stderr.write(String(error));
        });
    }
    try {
      await app.waitUntilExit();
    } finally {
      previewAbort.abort();
      await previewLoop;
      previewStore.close();
      previewInputs.store.close();
      if (history?.kind === 'opened') history.store.close();
      if (branch?.kind === 'opened') branch.store.close();
    }
  } catch (error) {
    process.stderr.write(`无法启动 TUI 预览：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
