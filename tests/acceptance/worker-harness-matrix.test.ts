/**
 * IP-04：已批准原生模型选择的隔离真实验收矩阵。
 *
 * 只有显式设置 ORCA_COMPANION_REAL_ACCEPTANCE=1 才运行；未开启时整个文件只留一条 skip 记录，
 * 不建目录、不读凭据、不访问 Orca。可用 ORCA_COMPANION_REAL_ACCEPTANCE_HARNESSES /
 * _ROLES 把本次运行收窄到子集（例如只跑 claude 的 planner 做冒烟）。
 *
 *   ORCA_COMPANION_REAL_ACCEPTANCE=1 pnpm exec vitest run --maxWorkers=1 --testTimeout=1800000 tests/acceptance/worker-harness-matrix.test.ts
 *
 * 每个 harness 依次跑 planner → implementation → validator → finalizer，再用原精确身份对
 * implementation 会话做一次 resume，另测 Validator 同会话续接与真实 Recovery Utility；混合角色仅测共存，不代表 Controller 闭环。全部结论写入
 * artifacts/next-worker-harness-adapters 的独立摘要证据；现场默认保留，交由用户显式回收。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import * as hermesAdapter from '../../src/adapters/agents/hermes-harness.js';
import type { ExecutionBackend } from '../../src/application/ports/execution-backend.js';
import { buildExecutionScope } from '../../src/application/ports/execution-backend.js';
import type { CoordinationScopeId, CoordinatorSessionId, RuntimeIncarnationId } from '../../src/application/dto/identity.js';

import type { WorkerHarness } from '../../src/application/ports/worker-harness.js';
import { workerHarnessRegistry } from '../../src/bootstrap/worker-harness.js';
import { qualificationFromAcceptance } from '../../src/adapters/agents/worker-harness-qualifications.js';
import { deriveWorkerSupportLevel } from '../../src/domain/worker-harness-support.js';
import {
  ACCEPTANCE_DIAGNOSTICS,
  HARNESS_MATRIX,
  AcceptanceBlocker,
  assistantTextFromRecord,
  assertIsolatedWorkspace,
  createAcceptanceFixture,
  createAcceptanceTerminal,
  globalConfigChanges,
  prepareAcceptanceWorker,
  installAcceptanceCandidates,
  modelEvidenceFromAssistant,
  transcriptRecords,
  permissionDeniedFromToolRecord,
  qwenRecoverySourcesVerified,
  readPermissionDeniedEvidence,
  resolveAcceptancePlan,
  resumeRole,
  roleSpec,
  runRecoveryUtility,
  runRole,
  launchPreparedTerminal,
  SETTLED_SUCCESS_STATES,
  writeAcceptanceEvidence,
  type AcceptanceFixture,
  type AcceptanceHarnessId,
  type HarnessBinding,
  type LaunchOutcome,
  type RoleRun,
  type AcceptanceEvidence,
} from '../support/worker-harness-acceptance.js';

const PLAN = resolveAcceptancePlan();
const STARTED_AT = new Date().toISOString();
const EVIDENCE_DIR = resolve(fileURLToPath(new URL('../../', import.meta.url)), 'artifacts', 'next-worker-harness-adapters');
const HARNESS_TESTS_TIMEOUT_MS = 1_800_000;

const HARNESS_EVIDENCE: Record<string, unknown>[] = [];
let setupBlocker: string | null = null;

test('公开 JSON export 与 JSONL 保留同源 assistant 证据', () => {
  const messages = [{ info: { role: 'user' }, parts: [{ type: 'text', text: 'requested' }] },
    { info: { role: 'assistant', providerID: 'minimax-cn-coding-plan', modelID: 'MiniMax-M3.1-Flash-Preview' }, parts: [{ type: 'text', text: 'actual' }] }];
  for (const text of [JSON.stringify({ info: { id: 'session' }, messages }, null, 2), messages.map((message) => JSON.stringify(message)).join('\n')]) {
    const records = transcriptRecords(text);
    expect(records.map(assistantTextFromRecord).filter(Boolean)).toEqual(['actual']);
    expect(records.map(modelEvidenceFromAssistant).filter(Boolean)).toEqual(['minimax-cn-coding-plan/MiniMax-M3.1-Flash-Preview']);
  }
});

test.each([
  [{ type: 'model_change', model: 'configured-only' }, null],
  [{ type: 'message', message: { role: 'user', model: 'self-reported' } }, null],
  [{ type: 'assistant', message: { role: 'assistant', model: 'claude-model' } }, 'claude-model'],
  [{ type: 'message', message: { role: 'assistant', model: 'pi-model' } }, 'pi-model'],
  [{ type: 'message', model: 'minimax-cn/MiniMax-M3.1-Flash-Preview', usage: { inputTokens: 20, outputTokens: 4 }, message: { role: 'assistant', content: [] } }, 'minimax-cn/MiniMax-M3.1-Flash-Preview'],
  [{ type: 'message', model: 'requested-model', message: { role: 'user' } }, null],
  [{ type: 'message', model: 'configured-model' }, null],
  [{ type: 'assistant', model: 'MiniMax-M3.1-Flash-Preview', message: { role: 'model', parts: [] }, usageMetadata: {} }, 'MiniMax-M3.1-Flash-Preview'],
  [{ type: 'message', role: 'assistant', message: {}, providerData: { model: 'MiniMax-M3.1-Flash-Preview', requestModelId: 'requested-only', usage: {} } }, 'MiniMax-M3.1-Flash-Preview'],
  [{ type: 'message', role: 'user', providerData: { model: 'requested-only' } }, null],
  [{ type: 'message', role: 'assistant', providerData: { requestModelId: 'requested-only' } }, null],
  [{ type: 'assistant', model: { providerID: 'opencode-provider', id: 'actual-model' } }, 'opencode-provider/actual-model'],
  [{ info: { role: 'assistant', providerID: 'opencode-provider', modelID: 'actual-model' }, parts: [] }, 'opencode-provider/actual-model'],
  [{ info: { role: 'user', providerID: 'opencode-provider', modelID: 'requested-model' }, parts: [] }, null],
])('模型证据只读取真实 assistant 记录 %#', (record, expected) => {
  expect(modelEvidenceFromAssistant(record)).toBe(expected);
});

test.each([
  [{ type: 'message', message: { role: 'user', content: 'requested-token' } }, ''],
  [{ type: 'assistant', message: { content: [{ type: 'tool_use', text: 'tool-token' }, { type: 'text', text: 'actual-answer' }] } }, 'actual-answer'],
  [{ type: 'assistant', parts: [{ type: 'text', text: 'public-api-answer' }] }, 'public-api-answer'],
  [{ type: 'assistant', message: { role: 'model', parts: [{ text: 'private-thought', thought: true }, { text: 'qwen-answer' }] } }, 'qwen-answer'],
  [{ type: 'message', role: 'assistant', message: { usage: {} }, content: [{ type: 'output_text', text: 'codebuddy-answer' }] }, 'codebuddy-answer'],
  [{ type: 'message', role: 'user', content: [{ type: 'output_text', text: 'requested-only' }] }, ''],
  [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'public-api-answer' }] }, 'public-api-answer'],
  [{ type: 'agent.message.appended', message: { message: { role: 'assistant', content: [{ type: 'text', text: 'kimi-answer' }] }, meta: { source: 'llm' } } }, 'kimi-answer'],
  [{ type: 'agent.message.appended', message: { message: { role: 'user', content: [{ type: 'text', text: 'requested-only' }] }, meta: { source: 'input' } } }, ''],
])('结果证据只读取 assistant 文本 %#', (record, expected) => {
  expect(assistantTextFromRecord(record)).toBe(expected);
});

test.each([
  [{ type: 'message', message: { role: 'user', content: [{ type: 'tool_result', content: [{ type: 'text', text: '{"permissionDenied":true,"path":"/fixture/probe","code":"EROFS"}' }] }] } }, true],
  [{ type: 'message', message: { role: 'assistant', content: [{ type: 'tool_result', content: [{ type: 'text', text: '{"permissionDenied":true,"path":"/fixture/probe","code":"EROFS"}' }] }] } }, false],
  [{ type: 'function_call_result', output: { type: 'text', text: '{"permissionDenied":true,"path":"/fixture/probe","code":"EROFS"}' } }, true],
  [{ type: 'tool_result', toolCallResult: { resultDisplay: { output: '{"permissionDenied":true,"path":"/fixture/probe","code":"EACCES"}' } } }, true],
  [{ type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: 'call-1', result: { output: '{"permissionDenied":true,"path":"/fixture/probe","code":"EROFS"}' } } }, true],
  [{ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '{"permissionDenied":true,"path":"/fixture/probe","code":"EROFS"}' }] } }, false],
  [{ type: 'function_call_result', output: { text: '{"permissionDenied":true,"path":"/other/probe","code":"EROFS"}' } }, false],
  [{ type: 'function_call_result', output: { text: '{"permissionDenied":true,"path":"/fixture/probe","code":"ENOENT"}' } }, false],
])('拒写证据必须来自精确工具结果及权限错误 %#', (record, accepted) => {
  expect(permissionDeniedFromToolRecord(record, '/fixture/probe', 'line:4') !== null).toBe(accepted);
});

test.each([true, false])('Antigravity 拒写证据需要配对原生 shell 事件 %s', (paired) => {
  const previous = { step_index: 1, type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', tool_calls: [{ name: paired ? 'run_command' : 'view_file' }] };
  const output = { step_index: 2, type: 'GENERIC', source: 'MODEL', status: 'DONE', content: '{"permissionDenied":true,"path":"/fixture/probe","code":"EROFS"}' };
  expect(permissionDeniedFromToolRecord(output, '/fixture/probe', 'step:2', previous) !== null).toBe(paired);
  expect(permissionDeniedFromToolRecord(output, '/fixture/probe', 'step:2')).toBeNull();
});

test('Kilo pretty JSON export 的拒写证据来自真实 tool 完成输出，assistant 自报不作证明', () => {
  const output = '{"permissionDenied":true,"path":"/fixture/probe","code":"EROFS"}';
  const exportOf = (parts: unknown[]): string => JSON.stringify({ info: { id: 'ses_fixture', directory: '/fixture' },
    messages: [{ info: { id: 'msg_1', role: 'assistant' }, parts }] }, null, 2);
  const directory = mkdtempSync(join(tmpdir(), 'kilo-export-'));
  try {
    const write = (name: string, text: string): string => {
      const file = join(directory, name);
      writeFileSync(file, text);
      return file;
    };
    const toolRef = write('tool.json', exportOf([{ type: 'tool', state: { status: 'completed', output } }]));
    expect(readPermissionDeniedEvidence(toolRef, '/fixture/probe'))
      .toEqual({ path: '/fixture/probe', code: 'EROFS', eventRef: 'line:1' });
    expect(readPermissionDeniedEvidence(write('assistant.json',
      exportOf([{ type: 'text', text: output }])), '/fixture/probe')).toBeNull();
    expect(readPermissionDeniedEvidence(write('running.json',
      exportOf([{ type: 'tool', state: { status: 'running', output } }])), '/fixture/probe')).toBeNull();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('JSONL 损坏行不能连接 Antigravity 工具调用和拒写输出', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tool-proof-'));
  const file = join(directory, 'transcript.jsonl');
  const call = { step_index: 1, type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', tool_calls: [{ name: 'run_command' }] };
  const result = { step_index: 2, type: 'GENERIC', source: 'MODEL', status: 'DONE', content: '{"permissionDenied":true,"path":"/fixture/probe","code":"EROFS"}' };
  try {
    for (const gap of ['', 'broken\n']) {
      writeFileSync(file, JSON.stringify(call) + '\n' + gap + JSON.stringify(result));
      expect(readPermissionDeniedEvidence(file, '/fixture/probe') !== null).toBe(gap === '');
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('配置 baseline 识别新增、删除和变更，只返回路径', () => {
  expect(globalConfigChanges(new Map([['unchanged', '1'], ['removed', '2'], ['changed', '3']]),
    new Map([['unchanged', '1'], ['added', '4'], ['changed', '5']]))).toEqual(['removed', 'changed', 'added']);
});

test.each(['planner', 'implementation', 'validator', 'finalizer'] as const)('各 harness 的 %s 指令与验收使用独立工件', (role) => {
  const paths = ['command-code', 'qwen-code'].map((harness) => {
    const expected = roleSpec(harness, role);
    expect(expected.artifactPath).toBe(join('.companion', 'roles', harness + '-' + role + '.txt'));
    expect(expected.spec).toContain('Create the file ' + expected.artifactPath + ' containing exactly: ' + expected.artifactBody);
    return expected.artifactPath;
  });
  expect(new Set(paths).size).toBe(paths.length);
});

test.each(['native-event', 'ordinal:23', 'other-event'])('Qwen Recovery 引用必须指向实际含标记的 assistant event %s', (sourceRef) => {
  const records = [{ uuid: 'native-event', type: 'assistant', message: { role: 'model', parts: [{ text: 'pending marker-42' }] } },
    { uuid: 'other-event', type: 'user', message: { role: 'user', parts: [{ text: 'marker-42' }] } }];
  expect(qwenRecoverySourcesVerified(records, {
    coverage: 'complete', readableRange: { transcriptRef: '/fixture', fromEventRef: 'native-event', toEventRef: 'other-event' },
    gaps: [], lastCompleteEventRef: 'other-event', sourceRefs: [sourceRef], unknowns: [],
    openActions: [{ actionRef: 'follow-up', description: 'recall marker-42', sourceRef }],
  }, 'marker-42')).toBe(sourceRef === 'native-event');
});

test('真实计划只使用原生模型绑定与明确 Orca 命令，默认路径无 env 前置', () => {
  const plan = resolveAcceptancePlan({ ORCA_COMPANION_REAL_ACCEPTANCE: '1', ORCA_CLI_COMMAND: '/fixture/orca-ide' });
  expect(plan).toMatchObject({ kind: 'run', orcaExecutable: '/fixture/orca-ide' });
  expect(plan).not.toHaveProperty('envFile');
  expect(plan).not.toHaveProperty('baseUrl');
  expect(resolveAcceptancePlan({})).toMatchObject({ kind: 'skip' });
  const another = resolveAcceptancePlan({ ORCA_COMPANION_REAL_ACCEPTANCE: '1', ORCA_CLI_COMMAND: '/fixture/orca-ide' });
  if (plan.kind === 'run' && another.kind === 'run') expect(plan.identity).not.toBe(another.identity);
  if (process.platform === 'linux') {
    expect(resolveAcceptancePlan({ ORCA_COMPANION_REAL_ACCEPTANCE: '1' })).toMatchObject({ orcaExecutable: 'orca-ide' });
  }
  for (const binding of HARNESS_MATRIX.filter((entry) => ['claude', 'opencode', 'pi', 'omp'].includes(entry.harness))) {
    expect(binding.expectedModel).toBe('MiniMax-M3.1-Flash-Preview');
    expect(binding.modelSelection.model.split('/').at(-1)).toBe(binding.expectedModel);
  }
  expect(bindingFor('pi').modelSelection.model).toBe('minimax-cn/MiniMax-M3.1-Flash-Preview');
});

test('真实等级缺省 complete，可收窄到 basic/enhanced，未知取值与越级角色立即拒绝', () => {
  const base = { ORCA_COMPANION_REAL_ACCEPTANCE: '1', ORCA_CLI_COMMAND: '/fixture/orca-ide' };
  expect(resolveAcceptancePlan(base)).toMatchObject({ kind: 'run', level: 'complete', roles: ['planner', 'implementation', 'validator', 'finalizer'] });
  expect(resolveAcceptancePlan({ ...base, ORCA_COMPANION_REAL_ACCEPTANCE_LEVEL: 'basic' }))
    .toMatchObject({ kind: 'run', level: 'basic', roles: ['planner', 'implementation'] });
  expect(resolveAcceptancePlan({ ...base, ORCA_COMPANION_REAL_ACCEPTANCE_LEVEL: 'enhanced', ORCA_COMPANION_REAL_ACCEPTANCE_ROLES: 'planner,finalizer' }))
    .toMatchObject({ kind: 'run', level: 'enhanced', roles: ['planner', 'finalizer'] });
  expect(() => resolveAcceptancePlan({ ...base, ORCA_COMPANION_REAL_ACCEPTANCE_LEVEL: 'full' })).toThrow(/complete/);
  expect(() => resolveAcceptancePlan({ ...base, ORCA_COMPANION_REAL_ACCEPTANCE_LEVEL: 'basic', ORCA_COMPANION_REAL_ACCEPTANCE_ROLES: 'validator' }))
    .toThrow(/validator/);
  // 开关未开启时等级不参与校验：只返回 skip，不产生任何其它可观察动作。
  expect(resolveAcceptancePlan({ ORCA_COMPANION_REAL_ACCEPTANCE_LEVEL: 'full' })).toMatchObject({ kind: 'skip' });
});

test('候选仅在显式资格计划临时登记，并恢复原注册表', () => {
  const before = new Map(workerHarnessRegistry);
  installAcceptanceCandidates(resolveAcceptancePlan({}))();
  expect(new Map(workerHarnessRegistry)).toEqual(before);
  const plan = resolveAcceptancePlan({ ORCA_COMPANION_REAL_ACCEPTANCE: '1', ORCA_CLI_COMMAND: '/fixture/orca-ide',
    ORCA_COMPANION_REAL_ACCEPTANCE_HARNESSES: 'command-code,qwen-code' });
  const restore = installAcceptanceCandidates(plan);
  try {
    for (const id of ['command-code', 'qwen-code']) expect(workerHarnessRegistry.get(id)?.id).toBe(id);
  } finally { restore(); }
  expect(new Map(workerHarnessRegistry)).toEqual(before);
});

const TEST_SCOPE = buildExecutionScope({
  coordinationScopeId: 'fixture-scope' as CoordinationScopeId,
  coordinatorSessionId: 'fixture-session' as CoordinatorSessionId,
  runtimeIncarnationId: 'fixture-runtime' as RuntimeIncarnationId,
  fencingGeneration: 1, backendIdentityRef: 'fixture', operationId: 'fixture-create',
  target: { kind: 'worker-task', id: 'fixture-task' }, expectedRevision: 0, timeoutMs: 1000,
  authority: { kind: 'route_planning' },
});

test('prepared terminal 只采用创建回执句柄，不复用同名的第一个存活终端', async () => {
  const mutate = vi.fn<ExecutionBackend['mutate']>().mockResolvedValue({
    kind: 'accepted', operation: { operationId: 'fixture-create', target: TEST_SCOPE.target },
    value: { terminal: { handle: 'exact-created' } },
  });
  const query = vi.fn<ExecutionBackend['query']>().mockResolvedValue({
    kind: 'accepted', value: { wait: { handle: 'exact-created', condition: 'tui-idle', status: 'running', satisfied: true }, truncated: false, omittedHostIds: [], terminals: [
      { handle: 'unrelated-live', title: 'same-title', connected: true, writable: true },
      { handle: 'exact-created', title: 'same-title', connected: true, writable: true },
    ] },
  });
  const prepared = await prepareAcceptanceWorker({
    backend: { mutate, query }, worktreePath: '/fixture', scope: TEST_SCOPE,
    strategy: { kind: 'prepared_terminal', harness: 'fixture', activation: 'none', title: 'same-title',
      prepare: () => Promise.resolve({ title: 'same-title', command: 'fixture-command' }) },
  });
  expect(prepared).toMatchObject({ kind: 'ready', worker: { terminal: 'exact-created' }, preparedTerminal: { handle: 'exact-created' } });
  expect(mutate).toHaveBeenCalledTimes(1);
});

test.each(['missing', 'unknown'] as const)('terminal 创建 %s 时阻塞且不查询其他终端或重发', async (kind) => {
  const mutate = vi.fn<ExecutionBackend['mutate']>().mockResolvedValue(kind === 'missing'
    ? { kind: 'accepted', operation: { operationId: 'fixture-create', target: TEST_SCOPE.target }, value: { id: 'not-a-handle' } }
    : { kind: 'unknown', operation: { operationId: 'fixture-create', target: TEST_SCOPE.target }, reason: 'response_lost' });
  const query = vi.fn<ExecutionBackend['query']>();
  await expect(createAcceptanceTerminal({ mutate, query }, { operation: 'terminal-create', worktree: 'path:/fixture' }, TEST_SCOPE))
    .rejects.toMatchObject({ code: kind === 'missing' ? 'terminal_receipt_unavailable' : 'terminal_create_unknown' });
  expect(mutate).toHaveBeenCalledTimes(1);
  expect(query).not.toHaveBeenCalled();
});

/** 基础级只用真实 Orca 执行绑定结算：不等待原生报告，原生字段如实为 null。 */
function basicFixture(workerState: string): AcceptanceFixture {
  const terminalHandle = 'exact-created';
  const mutate = vi.fn<ExecutionBackend['mutate']>().mockImplementation((mutation) => Promise.resolve(
    mutation.operation === 'task-create'
      ? { kind: 'accepted', operation: { operationId: 'fixture-create', target: TEST_SCOPE.target }, value: { task: { id: 'task-basic' } } }
      : mutation.operation === 'terminal-create'
        ? { kind: 'accepted', operation: { operationId: 'fixture-create', target: TEST_SCOPE.target }, value: { terminal: { handle: terminalHandle } } }
        : { kind: 'accepted', operation: { operationId: 'fixture-create', target: TEST_SCOPE.target }, value: { dispatchId: 'dispatch-basic' } }));
  const query = vi.fn<ExecutionBackend['query']>().mockImplementation((request) => Promise.resolve(
    request.operation === 'terminal-wait'
      ? { kind: 'accepted', value: { wait: { handle: terminalHandle, condition: 'tui-idle', status: 'running', satisfied: true } } }
      : request.operation === 'worker-show'
        ? { kind: 'accepted', value: { exactWorker: true, agentTerminalHandle: terminalHandle, workerState } }
        : request.operation === 'worker-read'
          ? { kind: 'accepted', value: { text: 'HARNESS-kilo-planner-OK' } }
          : { kind: 'accepted', value: { truncated: false, omittedHostIds: [], terminals: [{ handle: terminalHandle, title: 'same-title', connected: true, writable: true }] } }));
  return {
    root: '/fixture/root', projectDir: '/fixture/project', backend: { mutate, query }, runId: 'run-basic',
    coordinatorTerminalHandle: terminalHandle, identity: 'fixture-identity', level: 'basic', configBefore: new Map(),
    scopeFor: () => TEST_SCOPE, dispose: () => Promise.resolve(),
  };
}

/** 单元夹具不启动真实 harness：跑完恢复可观察标记，不污染「默认开关」断言。 */
async function fakeLaunch(workerState: string, launchId: string): Promise<LaunchOutcome> {
  const launched = ACCEPTANCE_DIAGNOSTICS.harnessLaunched;
  try {
    return await launchPreparedTerminal({
      fixture: basicFixture(workerState), binding: bindingFor('kilo'), role: 'planner', launchId,
      strategy: BASIC_STRATEGY, stateRoot: '/fixture/state', reporterPath: '/fixture/state/reporter.json', reportPath: '/fixture/state/report.json',
    });
  } finally {
    ACCEPTANCE_DIAGNOSTICS.harnessLaunched = launched;
  }
}

const BASIC_STRATEGY = {
  kind: 'prepared_terminal' as const, harness: 'kilo', activation: 'none' as const, title: 'same-title',
  prepare: () => Promise.resolve({ title: 'same-title', command: 'fixture-command', stateRoot: '/fixture/state' }),
};

test('基础级按真实 Worker 成功态与结果结算，原生字段保持 null', async () => {
  const outcome = await fakeLaunch('succeeded', 'unit:basic');
  expect(outcome).toMatchObject({
    kind: 'ran',
    worker: {
      taskId: 'task-basic', dispatchId: 'dispatch-basic', terminalHandle: 'exact-created', terminalState: 'succeeded',
      sessionId: null, transcriptRef: null, coverage: null, readOnlyVerified: null, modelEvidence: null,
      output: 'HARNESS-kilo-planner-OK',
    },
  });
});

test.each(['failed', 'cancelled', 'completed', 'done'])('基础级只承认 succeeded：%s 终态阻塞且保留已知身份', async (workerState) => {
  const outcome = await fakeLaunch(workerState, 'unit:basic-' + workerState);
  expect(outcome).toMatchObject({ kind: 'blocked', code: 'worker_not_succeeded', taskId: 'task-basic', dispatchId: 'dispatch-basic', terminalHandle: 'exact-created' });
}, 15_000);
/** 增强级只用精确原生 Session：即使没有 recovery 能力组，也要读出输出与拒写证据。 */
test.each(['fixture-native', 'hermes'] as const)('增强级从 %s 的精确原生来源读取最终结果', async (harness) => {
  const directory = mkdtempSync(join(tmpdir(), 'enhanced-native-'));
  const transcript = join(directory, 'transcript.json');
  const reportPath = join(directory, 'session-report.json');
  const probePath = join(directory, 'role-write-probe');
  const assistant = { type: 'message', message: { role: 'assistant', model: 'fixture-model', content: [{ type: 'text', text: 'enhanced answer' }] } };
  const denied = { type: 'function_call_result', output: { type: 'text', text: JSON.stringify({ permissionDenied: true, path: probePath, code: 'EROFS' }) } };
  writeFileSync(transcript, JSON.stringify({ info: { id: 'ses-enhanced' }, messages: [assistant, denied] }), 'utf8');
  writeFileSync(reportPath, JSON.stringify({ sessionId: 'ses-enhanced', transcriptPath: transcript, cwd: '/fixture/project', observedAt: '2026-10-14T00:00:00.000Z', harness }), 'utf8');
  const registry = workerHarnessRegistry as Map<string, WorkerHarness>;
  const previous = registry.get(harness);
  let materialReads = 0;
  let coverageReads = 0;
  const material = harness !== 'hermes' ? null : vi.spyOn(hermesAdapter, 'prepareHermesRecoveryMaterial').mockImplementation(() => {
    // 模拟 export 在结算后继续追加：首次范围已变，随后最终 assistant 才出现。
    if (++materialReads === 1) return Promise.resolve(null);
    const path = hermesAdapter.hermesRecoveryMaterialPath(directory, transcript);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, materialReads === 2 ? JSON.stringify({ role: 'assistant', content: 'pending' }) + '\n'
      : [assistant, denied].map((record) => JSON.stringify(record)).join('\n') + '\n');
    return Promise.resolve(['fixture material']);
  });
  const fake: WorkerHarness = {
    id: harness,
    prepareLaunch: () => ({ kind: 'prepared_terminal', harness, activation: 'none', title: 'same-title', prepare: () => Promise.resolve({ title: 'same-title', command: 'fixture-command', stateRoot: directory }) }),
    queryModels: () => Promise.resolve({ kind: 'unavailable', code: 'fixture', message: 'fixture' }),
    sessionPaths: () => ({ stateRoot: directory, reporterPath: join(directory, 'reporter.json'), reportPath }),
    installReporter: () => undefined,
    capabilities: { nativeSession: {
      proveSession: () => Promise.resolve({ kind: 'proven', proof: { providerSessionId: 'ses-enhanced', transcriptRef: transcript, observedAt: '2026-10-14T00:00:00.000Z' } }),
      readTranscriptIdentity: () => Promise.resolve({ providerSessionId: 'ses-enhanced' }),
    }, ...(harness !== 'hermes' ? {} : { recovery: {
      inspectTranscript: () => Promise.resolve(++coverageReads === 1
        ? { kind: 'transcript_unavailable' as const, reason: 'native snapshot is still being written' }
        : { kind: 'covered' as const, evidence: {
        coverage: 'partial' as const, readableRange: { transcriptRef: transcript, fromEventRef: 'message:1', toEventRef: 'message:2' },
        lastCompleteEventRef: 'message:2', gaps: [],
      } }),
      recoveryInstructions: () => [],
    } }) },
  };
  registry.set(harness, fake);
  const launched = ACCEPTANCE_DIAGNOSTICS.harnessLaunched;
  try {
    const binding: HarnessBinding = { harness, modelSelection: { model: 'fixture-model', effort: null, effortCapability: null, catalogSource: null }, expectedModel: 'fixture-model' };
    const outcome = await launchPreparedTerminal({
      fixture: { ...basicFixture('succeeded'), level: 'enhanced' }, binding, role: 'planner', launchId: 'unit:enhanced',
      strategy: fake.prepareLaunch({ launchId: 'unit:enhanced', modelSelection: binding.modelSelection, sandboxMode: 'workspace-write' }),
      stateRoot: directory, reporterPath: join(directory, 'reporter.json'), reportPath, readOnlyProbePath: probePath,
      expectedAssistantText: 'enhanced answer',
    });
    expect(outcome).toMatchObject({ kind: 'ran', worker: { sessionId: 'ses-enhanced', transcriptRef: transcript, coverage: harness === 'hermes' ? 'partial' : null, readOnlyVerified: true, modelEvidence: 'fixture-model' } });
    if (outcome.kind === 'ran') expect(outcome.worker.output).toContain('enhanced answer');
  } finally {
    ACCEPTANCE_DIAGNOSTICS.harnessLaunched = launched;
    material?.mockRestore();
    if (previous === undefined) registry.delete(harness); else registry.set(harness, previous);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('同一轮次写入独立证据，不覆盖已有文件', () => {
  const directory = mkdtempSync(join(tmpdir(), 'worker-harness-evidence-'));
  const evidence: AcceptanceEvidence = {
    schema: 'worker-harness-acceptance/1', startedAt: STARTED_AT, finishedAt: STARTED_AT,
    baseDir: '/fixture', identity: 'fixture', orcaExecutable: '/fixture/orca-ide', fixtureRoot: '/fixture/root',
    runId: 'fixture-run', coordinatorTerminalHandle: 'exact-created', setupBlocker: null, harnesses: [],
  };
  try {
    const first = writeAcceptanceEvidence(directory, evidence);
    const second = writeAcceptanceEvidence(directory, { ...evidence, setupBlocker: 'fixture-blocker' });
    expect(first).not.toBe(second);
    expect(JSON.parse(readFileSync(first, 'utf8'))).toMatchObject({ setupBlocker: null });
    expect(JSON.parse(readFileSync(second, 'utf8'))).toMatchObject({ setupBlocker: 'fixture-blocker' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function bindingFor(harness: AcceptanceHarnessId): HarnessBinding {
  const binding = HARNESS_MATRIX.find((candidate) => candidate.harness === harness);
  if (binding === undefined) throw new Error('矩阵缺少绑定：' + harness);
  return binding;
}

function pick<T>(list: readonly T[], index: number): T {
  const value = list[index];
  if (value === undefined) throw new Error('缺少可用的 harness 选择');
  return value;
}

function roleEvidence(run: RoleRun): Record<string, unknown> {
  return {
    role: run.role,
    kind: run.kind,
    launchId: run.launchId,
    taskId: run.taskId,
    dispatchId: run.dispatchId,
    sessionId: run.sessionId,
    transcriptRef: run.transcriptRef,
    stateRoot: run.stateRoot,
    reporterPath: run.reporterPath,
    coverage: run.coverage,
    terminalState: run.terminalState,
    artifactOk: run.artifactOk,
    readOnlyVerified: run.readOnlyVerified,
    terminalHandle: run.terminalHandle,
    modelEvidence: run.modelEvidence,
    blocker: run.blocker,
  };
}

/** 跑一个 harness 的 p-i-v-f + resume，并把（无论成功失败）证据入列。 */
async function runHarnessMatrix(fixture: AcceptanceFixture, harness: AcceptanceHarnessId): Promise<void> {
  const binding = bindingFor(harness);
  const blockers: string[] = [];
  if (!workerHarnessRegistry.has(harness)) {
    blockers.push('Worker Harness 未注册：' + harness);
  }
  const roles: RoleRun[] = [];
  for (const role of PLAN.kind === 'run' ? PLAN.roles : []) {
    const run = await runRole({ fixture, binding, role, launchId: 'ip04:' + harness + ':' + role });
    roles.push(run);
    process.stdout.write(`[ip04] ${harness}/${role}: ${run.kind} state=${run.terminalState ?? '-'} artifact=${run.artifactOk ?? '-'} coverage=${run.coverage ?? '-'} blocker=${run.blocker?.code ?? '-'}\n`);
    if (run.blocker !== null) blockers.push(role + '：' + run.blocker.code + ' ' + run.blocker.message);
  }
  const level = fixture.level;
  const implementation = roles.find((run) => run.role === 'implementation');
  const resume = level === 'basic' || implementation === undefined
    ? null
    : await resumeRole({ fixture, binding, original: implementation, resumeLaunchId: 'ip04:' + harness + ':resume' });
  if (resume?.blocker != null) blockers.push('resume：' + resume.blocker.code + ' ' + resume.blocker.message);
  if (resume !== null) process.stdout.write(`[ip04] ${harness}/resume: ${resume.kind} sameSession=${resume.sameSession} coverage=${resume.coverage ?? '-'} blocker=${resume.blocker?.code ?? '-'}\n`);
  const validator = roles.find((run) => run.role === 'validator');
  const recovery = level !== 'complete' || validator === undefined ? null : await runRecoveryUtility({
    fixture, binding, original: validator, launchId: 'ip04:' + harness + ':recovery-utility',
  });
  if (recovery?.blocker != null) blockers.push('recovery：' + recovery.blocker.code + ' ' + recovery.blocker.message);
  if (recovery !== null) process.stdout.write(`[ip04] ${harness}/recovery: ${recovery.kind} state=${recovery.utility?.terminalState ?? '-'} readonly=${recovery.readOnlyVerified} source=${recovery.sourceBehaviorVerified} blocker=${recovery.blocker?.code ?? '-'}\n`);
  const validatorContinuation = level === 'basic' || validator === undefined ? null : await resumeRole({
    fixture, binding, original: validator, resumeLaunchId: 'ip04:' + harness + ':validator-continuation',
  });
  if (validatorContinuation?.blocker != null) blockers.push('validator-continuation：' + validatorContinuation.blocker.code + ' ' + validatorContinuation.blocker.message);
  if (validatorContinuation !== null) process.stdout.write(`[ip04] ${harness}/validator-continuation: ${validatorContinuation.kind} sameSession=${validatorContinuation.sameSession} context=${validatorContinuation.contextPreserved ?? '-'} blocker=${validatorContinuation.blocker?.code ?? '-'}\n`);

  const entry = {
    harness,
    level,
    modelSelection: binding.modelSelection,
    expectedModel: binding.expectedModel,
    roles: roles.map(roleEvidence),
    resume,
    validatorContinuation,
    recovery: recovery === null ? null : { ...recovery, utility: recovery.utility === null ? null : {
      taskId: recovery.utility.taskId, dispatchId: recovery.utility.dispatchId, sessionId: recovery.utility.sessionId,
      transcriptRef: recovery.utility.transcriptRef, coverage: recovery.utility.coverage,
      modelEvidence: recovery.utility.modelEvidence, terminalState: recovery.utility.terminalState,
    } },
    blockers,
  };
  // 逐能力事实与派生等级只来自 qualificationFromAcceptance；mixed Controller 由独立证据决定，不在这里自动标注。
  const qualification = qualificationFromAcceptance({ harnesses: [entry] }, 'report:ip04/' + fixture.identity)
    .find((candidate) => candidate.harness === harness) ?? null;
  HARNESS_EVIDENCE.push({ ...entry, qualification, derivedLevel: qualification === null ? null : deriveWorkerSupportLevel(qualification) });

  // 等级条件只按目标等级断言；模型回显与 usage 任何等级都不作门禁，仅随证据展示。
  const finalizer = roles.find((run) => run.role === 'finalizer');
  for (const run of roles) {
    expect(run.blocker, harness + '/' + run.role + ' blocker').toBeNull();
    expect(run.kind, harness + '/' + run.role).toBe('ran');
    expect(run.taskId, harness + '/' + run.role + ' task').not.toBeNull();
    expect(run.dispatchId, harness + '/' + run.role + ' dispatch').not.toBeNull();
    expect(run.terminalHandle, harness + '/' + run.role + ' terminal').not.toBeNull();
    expect(SETTLED_SUCCESS_STATES.has(run.terminalState ?? ''), harness + '/' + run.role + ' 成功终态').toBe(true);
    expect(run.artifactOk, harness + '/' + run.role + ' artifact').toBe(true);
    if (level === 'basic') {
      // 基础级只用真实 Orca 执行绑定：原生字段如实为 null，不用 terminal 身份冒充。
      expect(run.sessionId, harness + '/' + run.role + ' 无原生 session').toBeNull();
      expect(run.transcriptRef, harness + '/' + run.role + ' 无 transcript').toBeNull();
      expect(run.coverage, harness + '/' + run.role + ' 无 coverage').toBeNull();
      expect(run.readOnlyVerified, harness + '/' + run.role + ' 无只读探针').toBeNull();
      expect(run.modelEvidence, harness + '/' + run.role + ' 无模型证据').toBeNull();
    } else {
      expect(run.sessionId, harness + '/' + run.role + ' 精确 session').not.toBeNull();
      expect(run.transcriptRef, harness + '/' + run.role + ' 精确 transcript').not.toBeNull();
    }
    if (level === 'complete') expect(run.coverage, harness + '/' + run.role + ' coverage').toBe('complete');
  }
  if (level !== 'basic') {
    // 可写 Finalizer 不再跑拒写探针：它写入独立工件；只读核验只留给 Recovery Utility。
    expect(finalizer?.readOnlyVerified, harness + ' finalizer 无拒写探针').toBeNull();
    if (implementation !== undefined) {
      expect(resume?.blocker, harness + ' resume blocker').toBeNull();
      expect(resume?.kind, harness + ' resume').toBe('ran');
      expect(resume?.sameSession, harness + ' resume 必须续同一条 session').toBe(true);
    }
    if (validator !== undefined) {
      expect(validatorContinuation?.blocker).toBeNull();
      expect(validatorContinuation?.sameSession).toBe(true);
      expect(validatorContinuation?.dispatchId).not.toBe(validator.dispatchId);
      expect(validatorContinuation?.contextPreserved, 'Validator 必须保留原会话标记').toBe(true);
    }
  }
  if (level === 'complete' && validator !== undefined) {
    expect(recovery?.blocker, harness + ' recovery blocker').toBeNull();
    expect(recovery?.kind).toBe('ran');
    expect(recovery?.sourceBehaviorVerified, 'Utility 必须从精确原会话提取标记与事件来源').toBe(true);
    expect(recovery?.readOnlyVerified, 'Utility 写入被拒绝且未产生文件').toBe(true);
  }
}

/** 未开启时本文件不产生任何真实调用；这条断言本身就是「默认跳过」的可观察形式。 */
test.skipIf(PLAN.kind !== 'skip')('未开启开关时整个真实验收被跳过且不读凭据/不访问 Orca', () => {
  expect(PLAN.kind).toBe('skip');
  expect(ACCEPTANCE_DIAGNOSTICS.credentialsRead).toBe(false);
  expect(ACCEPTANCE_DIAGNOSTICS.orcaMutated).toBe(false);
  expect(ACCEPTANCE_DIAGNOSTICS.harnessLaunched).toBe(false);
});

test('隔离边界自检拒绝 Companion 自身仓库、其上级目录与不存在的路径', () => {
  const companion = resolve(fileURLToPath(new URL('../../', import.meta.url)));
  expect(() => assertIsolatedWorkspace(companion, new Set(['project-x']))).toThrow(/自身仓库/);
  expect(() => assertIsolatedWorkspace(resolve(companion, '..'), new Set(['project-x']))).toThrow(/上级目录/);
  expect(() => assertIsolatedWorkspace(join(companion, 'does-not-exist'), new Set(['project-x']))).toThrow(/不是存在的目录/);
  // 只含允许项的真实目录放行；混入其它内容必须失败。
  expect(() => assertIsolatedWorkspace(join(companion, 'references'), new Set(['orca']))).not.toThrow();
  expect(() => assertIsolatedWorkspace(join(companion, 'references'), new Set(['other']))).toThrow(/混入/);
});

describe.skipIf(PLAN.kind !== 'run')('IP-04 原生 harness 真实隔离矩阵', () => {
  let fixture: AcceptanceFixture | null = null;
  let restoreCandidates = (): void => undefined;

  beforeAll(async () => {
    if (PLAN.kind !== 'run') return;
    restoreCandidates = installAcceptanceCandidates(PLAN);
    try {
      fixture = await createAcceptanceFixture(PLAN);
    } catch (error) {
      setupBlocker = error instanceof AcceptanceBlocker ? error.code + ' ' + error.message : String(error);
    }
  }, 300_000);

  afterAll(async () => {
    try {
      await fixture?.dispose();
    } finally {
      restoreCandidates();
      if (PLAN.kind === 'run') {
        writeAcceptanceEvidence(EVIDENCE_DIR, {
          schema: 'worker-harness-acceptance/1', startedAt: STARTED_AT, finishedAt: new Date().toISOString(),
          baseDir: PLAN.baseDir, identity: PLAN.identity, orcaExecutable: PLAN.orcaExecutable,
          fixtureRoot: fixture?.root ?? null, runId: fixture?.runId ?? null,
          coordinatorTerminalHandle: fixture?.coordinatorTerminalHandle ?? null, setupBlocker,
          harnesses: HARNESS_EVIDENCE,
        });
      }
      fixture = null;
    }
  }, 300_000);

  // 混合 Controller 是完整级的独立证据，不由本矩阵自动标注任何 harness 的等级。
  const mixedEnabled = PLAN.kind === 'run' && PLAN.level === 'complete' && PLAN.harnesses.length >= 3;

  for (const harness of PLAN.kind === 'run' ? PLAN.harnesses : []) {
    test(harness + ' p-i-v-f + resume/recovery', async () => {
      if (setupBlocker !== null) {
        throw new Error('真实夹具未建立：' + setupBlocker);
      }
      if (fixture === null) throw new Error('真实夹具缺失');
      await runHarnessMatrix(fixture, harness);
    }, HARNESS_TESTS_TIMEOUT_MS);
  }

  test.skipIf(!mixedEnabled)('混合角色：跨 harness 的 planner → implementation → validator 同 Run 共存', async () => {
    if (setupBlocker !== null) throw new Error('真实夹具未建立：' + setupBlocker);
    if (fixture === null) throw new Error('真实夹具缺失');
    const available = PLAN.kind === 'run' ? PLAN.harnesses.filter((harness) => workerHarnessRegistry.has(harness)) : [];
    if (available.length < 3) {
      throw new Error('混合角色需要至少三个已注册 harness，当前：' + available.join(', '));
    }
    const finalizerHarness = available.find((harness) => harness === 'omp') ?? pick(available, Math.min(3, available.length - 1));
    const assignment: readonly { readonly role: 'planner' | 'implementation' | 'validator' | 'finalizer'; readonly harness: AcceptanceHarnessId }[] = [
      { role: 'planner', harness: pick(available, 0) },
      { role: 'implementation', harness: pick(available, 1) },
      { role: 'validator', harness: pick(available, 2) },
      { role: 'finalizer', harness: finalizerHarness },
    ];
    const runs: RoleRun[] = [];
    for (const entry of assignment) {
      runs.push(await runRole({ fixture, binding: bindingFor(entry.harness), role: entry.role, launchId: 'ip04:mixed:' + entry.harness + ':' + entry.role }));
    }
    HARNESS_EVIDENCE.push({
      harness: 'mixed',
      assignment: assignment.map((entry) => entry.harness + ':' + entry.role),
      roles: runs.map(roleEvidence),
      blockers: runs.filter((run) => run.blocker !== null).map((run) => run.role + '：' + (run.blocker?.code ?? '') + ' ' + (run.blocker?.message ?? '')),
    });
    for (const run of runs) {
      expect(run.blocker, 'mixed ' + run.role).toBeNull();
      expect(run.kind, 'mixed ' + run.role).toBe('ran');
      expect(run.coverage, 'mixed ' + run.role + ' coverage').toBe('complete');
      expect(run.artifactOk, 'mixed ' + run.role + ' artifact').toBe(true);
    }
  }, HARNESS_TESTS_TIMEOUT_MS);

  test('汇总证据并确认没有未结阻塞', () => {
    expect(setupBlocker).toBeNull();
    for (const harness of PLAN.kind === 'run' ? PLAN.harnesses : []) {
      const entry = HARNESS_EVIDENCE.find((candidate) => candidate['harness'] === harness);
      expect(entry, harness + ' 缺少证据').toBeDefined();
      expect(entry?.['blockers'], harness + ' 存在阻塞').toEqual([]);
      // 每个 harness 都必须记录逐能力事实与派生等级；空事实只等于 unavailable。
      expect(entry?.['qualification'], harness + ' 缺少资格事实').not.toBeNull();
      expect(entry?.['derivedLevel'], harness + ' 缺少派生等级').not.toBeNull();
    }
  });
});
