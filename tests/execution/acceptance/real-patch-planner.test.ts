/**
 * `m1-evolve-execution-graph` 验收层：真实 Graph Patch Planner（IP-10，D13）。
 *
 * 分类路由与提交点可以 fake 覆盖，但「含糊的图变化请求能被真实 Planner 正确结构化，并且该结构能被
 * Controller Admission 归一化为一条 Graph Revision」只有真实调用能证明。本文件因此：
 *
 * 1. 在一次性 Git 项目中建立 Orca Run、Task 与 Codex Planner Dispatch，绑定 MiniMax-M3 Responses provider；
 * 2. 通过 SessionStart 证明 exact provider transcript，等待该 Dispatch 的 worker_done Delivery；
 * 3. 检查草案的 exact `baseGraphVersion` 和后代处置，再经 Admission 与唯一提交点追加。
 *
 * 只有显式选择隔离工作区与专用身份后才运行：
 *
 * ```sh
 * ORCA_COMPANION_REAL_HARNESS=1 \
 * ORCA_COMPANION_REAL_REPO=<isolated-workspace> \
 * ORCA_COMPANION_REAL_IDENTITY=<dedicated-identity> \
 * pnpm test -- tests/execution/acceptance/real-patch-planner.test.ts --no-file-parallelism
 * ```
 *
 * 端点与凭据沿用 `.env.smoke` 的 `COORDINATOR_SMOKE_OPENAI_*` 与 `COORDINATOR_SMOKE_API_KEY`（可用
 * `ORCA_COMPANION_REAL_ENV_FILE` 换一份文件），因此与其它 real-harness 用例共用同一套配置；模型默认
 * `MiniMax-M3`，可用 `ORCA_COMPANION_REAL_PLANNER_MODEL` 覆盖。凭据仅由隔离状态根内的 provider helper
 * 从忽略的 env 文件读取，不写入 Git、Codex 配置或 Orca Task。
 *
 * 前置条件：隔离工作区是一个**干净的一次性** Git 仓库（没有 Companion 状态目录），使用专用身份；
 * 用例会向 Orca 注册该项目、建立 Run 和终端，结束时关闭本次终端。
 *
 * 未显式开启时整个文件只留一条 skip 记录：不解析端点、不加载 provider、不打开数据库、不发起真实调用。
 * 真实调用一律只在隔离工作区与专用身份中进行：不触碰用户主项目、不重启全局 Orca runtime、不改上游。
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

import { createCodexWorkerLaunch } from '../../../src/adapters/agents/codex-launch.js';
import { proveCodexTranscript, type CodexSessionStartReport } from '../../../src/adapters/agents/codex-transcript.js';
import { createOrcaExecutionBackend } from '../../../src/adapters/orca-cli/orca-backend.js';
import { ackDelivery, readDeliveryBatch } from '../../../src/adapters/orca-cli/delivery-reader.js';
import { runProcess } from '../../../src/adapters/orca-cli/process-runner.js';
import { openCoordinationStore, type CoordinationStore } from '../../../src/adapters/storage/coordination-store.js';
import { acquireExecutionLease, acquireRuntimeLease } from '../../../src/application/coordination/lease-service.js';
import { settleDelivery } from '../../../src/application/delivery/process-delivery.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  DispatchId,
  GraphGeneration,
  OperationId,
  PlanningCycleId,
  RuntimeIncarnationId,
  WorkPackageId,
  WorkerTaskId,
} from '../../../src/application/dto/identity.js';
import type { ExecutionAuthorizationRecord } from '../../../src/domain/planning/execution-authorization.js';
import type { SpecBinding } from '../../../src/domain/task-contract.js';
import { initializeCoordinationScope } from '../../../src/application/planning/initialize-scope.js';
import { graphIdFor } from '../../../src/application/planning/graph-generation.js';
import { buildExecutionScope, type ExecutionBackend, type ExecutionScope } from '../../../src/application/ports/execution-backend.js';
import { activatePreparedWorker, prepareWorkerLaunch, verifyPreparedWorker } from '../../../src/application/worker-launch.js';
import { loadCurrentGraph, recordInitialGraph } from '../../../src/application/planning/graph-history.js';
import {
  admitGraphRevision,
  applyGraphRevision,
} from '../../../src/application/execution/graph-patch-service.js';
import {
  graphPatchPlannerInstruction,
  type GraphPatchPlannerRequest,
} from '../../../src/application/execution/graph-patch-planner.js';
import {
  COMPANION_STATE_DIRECTORY,
  coordinationDatabasePath,
  resolveGitCommonDir,
} from '../../../src/bootstrap/composition.js';
import {
  defaultExecutionWorkPackages,
  executionManifest,
  EXECUTION_AUTHORIZATION_ID,
  EXECUTION_MAP_REVISION,
  EXECUTION_PLAN_REVISION,
} from '../../support/execution-harness.js';
import { toChildEnvironment } from '../../../src/interfaces/cli/main.js';

const COMPANION_REPOSITORY = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const REAL_SWITCH = 'ORCA_COMPANION_REAL_HARNESS';
const WORKSPACE_VAR = 'ORCA_COMPANION_REAL_REPO';
const IDENTITY_VAR = 'ORCA_COMPANION_REAL_IDENTITY';
const INTEGRATION_VAR = 'ORCA_COMPANION_REAL_PLANNER_INTEGRATION';
const MODEL_VAR = 'ORCA_COMPANION_REAL_PLANNER_MODEL';
const BASE_URL_VAR = 'ORCA_COMPANION_REAL_PLANNER_BASE_URL';
const DEFAULT_INTEGRATION = '@langchain/openai#ChatOpenAI';
const DEFAULT_MODEL = 'MiniMax-M3';

/**
 * Smoke 端点配置：`.env.smoke` 里的 `COORDINATOR_SMOKE_OPENAI_*` 与共享 key 直接复用，因此真实
 * Planner 调用与其它 real-harness 用例走同一份凭据来源，不需要另配一套环境变量。
 */
const ENV_FILE_VAR = 'ORCA_COMPANION_REAL_ENV_FILE';
const DEFAULT_ENV_FILE = join(COMPANION_REPOSITORY, '.env.smoke');
const SMOKE_BASE_URL_VAR = 'COORDINATOR_SMOKE_OPENAI_BASE_URL';
const SMOKE_MODEL_VAR = 'COORDINATOR_SMOKE_OPENAI_MODEL';
const SMOKE_SHARED_KEY_VAR = 'COORDINATOR_SMOKE_API_KEY';

/** 只把缺失的键写进 `process.env`：真实环境优先，文件不覆盖已存在的变量。 */
function mergeEnvFile(path: string): number {
  if (!existsSync(path)) {
    return 0;
  }
  let applied = 0;
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const separator = line.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).replace(/^export\s+/, '').trim();
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (key.length > 0 && value.length > 0 && process.env[key] === undefined) {
      process.env[key] = value;
      applied += 1;
    }
  }
  return applied;
}

/** OpenAI SDK 自己拼 `/chat/completions`，因此 base URL 必须自带 `/v1`。 */
function withV1(raw: string): string {
  const base = raw.replace(/\/+$/, '');
  return base.endsWith('/v1') ? base : `${base}/v1`;
}

type Gate =
  | {
      readonly kind: 'run';
      readonly workspace: string;
      readonly identity: string;
      readonly integration: string;
      readonly model: string;
      readonly baseUrl: string;
    }
  | { readonly kind: 'skip'; readonly reason: string };

function gate(): Gate {
  if (process.env[REAL_SWITCH] !== '1') {
    return { kind: 'skip', reason: `${REAL_SWITCH} 未显式开启` };
  }
  const workspace = process.env[WORKSPACE_VAR];
  if (workspace === undefined || workspace.length === 0) {
    return { kind: 'skip', reason: `${WORKSPACE_VAR} 未显式选择隔离工作区` };
  }
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
    return { kind: 'skip', reason: `${WORKSPACE_VAR} 指向的不是已存在的目录` };
  }
  if (resolve(workspace) === COMPANION_REPOSITORY) {
    return { kind: 'skip', reason: '隔离工作区不得是 Companion 自身仓库' };
  }
  if (!existsSync(join(workspace, '.git'))) {
    return { kind: 'skip', reason: `${WORKSPACE_VAR} 不是 Git 仓库` };
  }
  const identity = process.env[IDENTITY_VAR];
  if (identity === undefined || identity.length === 0) {
    return { kind: 'skip', reason: `${IDENTITY_VAR} 未显式选择专用身份` };
  }

  mergeEnvFile(process.env[ENV_FILE_VAR] ?? DEFAULT_ENV_FILE);
  const sharedKey = process.env[SMOKE_SHARED_KEY_VAR];
  if (sharedKey !== undefined && sharedKey.length > 0 && process.env['OPENAI_API_KEY'] === undefined) {
    process.env['OPENAI_API_KEY'] = sharedKey;
  }
  const baseUrl = process.env[BASE_URL_VAR] ?? process.env[SMOKE_BASE_URL_VAR];
  if (baseUrl === undefined || baseUrl.length === 0) {
    return { kind: 'skip', reason: `${BASE_URL_VAR} 或 ${SMOKE_BASE_URL_VAR} 未配置 Planner 端点` };
  }
  return {
    kind: 'run',
    workspace: resolve(workspace),
    identity,
    integration: process.env[INTEGRATION_VAR] ?? DEFAULT_INTEGRATION,
    model: process.env[MODEL_VAR] ?? process.env[SMOKE_MODEL_VAR] ?? DEFAULT_MODEL,
    baseUrl: withV1(baseUrl),
  };
}

/**
 * 从真实模型输出里取出**第一个可解析的 JSON 对象**。
 *
 * 模型经常在 JSON 前后附带散文，或返回多个对象（草案 + 说明）；用「第一个 `{` 到最后一个 `}`」会拼出
 * 非法 JSON。这里按花括号配对逐个候选尝试解析，只取第一个成功的对象，其余内容一律不解释。
 */
function firstJsonObject(body: string): unknown {
  for (let start = body.indexOf('{'); start !== -1; start = body.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < body.length; index += 1) {
      const char = body[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        if (inString) {
          escaped = true;
        }
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) {
        continue;
      }
      if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(body.slice(start, index + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return undefined;
}

function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  for (const candidate of fenced?.[1] === undefined ? [text] : [fenced[1], text]) {
    const parsed = firstJsonObject(candidate);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  throw new Error(`真实 Planner 没有返回可解析的 JSON 对象；响应片段：${text.slice(0, 400)}`);
}

const COORDINATOR_REF = 'real-graph-patch-coordinator';

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}

function stringField(value: unknown, key: string): string | null {
  const field = record(value)?.[key];
  return typeof field === 'string' && field.length > 0 ? field : null;
}

async function registerIsolatedRepo(workspace: string): Promise<void> {
  const result = await runProcess({
    executable: 'orca', args: ['repo', 'add', '--path', workspace, '--json'], cwd: workspace,
    env: toChildEnvironment(process.env), timeoutMs: 60_000,
    limits: { maxBytes: 128 * 1024, maxLines: 2_000 },
  });
  if (result.kind !== 'completed' || result.exitCode !== 0) {
    throw new Error('无法将隔离项目注册给 Orca');
  }
}

async function createRealWorkerRuntime(workspace: string, identity: string): Promise<{
  readonly backend: ExecutionBackend;
  readonly runId: string;
  readonly coordinatorHandle: string;
  readonly scopeFor: (operationId: string, target: { kind: string; id: string }) => ExecutionScope;
}> {
  await registerIsolatedRepo(workspace);
  const binding: { handle: string | undefined } = { handle: undefined };
  const backend = createOrcaExecutionBackend({
    cwd: workspace,
    env: toChildEnvironment(process.env),
    resolveIdentityHandle: (ref) => ref === COORDINATOR_REF ? binding.handle : undefined,
  });
  let runId = '';
  const scopeFor = (operationId: string, target: { kind: string; id: string }): ExecutionScope => buildExecutionScope({
    coordinationScopeId: `${identity}:scope` as CoordinationScopeId,
    coordinatorSessionId: `${identity}:session` as CoordinatorSessionId,
    runtimeIncarnationId: `${identity}:inc` as RuntimeIncarnationId,
    fencingGeneration: 1,
    backendIdentityRef: COORDINATOR_REF,
    operationId,
    target,
    expectedRevision: 0,
    timeoutMs: 300_000,
    authority: runId.length === 0 ? { kind: 'route_planning' } : {
      kind: 'execution_coordination', graphGeneration: 1,
      authorizationId: EXECUTION_AUTHORIZATION_ID, runId, consumerGeneration: 1,
    },
  });
  const terminalTitle = `${identity}:coordinator`;
  const created = await backend.mutate({
    operation: 'terminal-create', worktree: `path:${workspace}`, title: terminalTitle,
    command: process.env['SHELL'] ?? 'sh',
  }, scopeFor(`${identity}:terminal-create`, { kind: 'work-package', id: 'setup' }));
  if (created.kind !== 'accepted') throw new Error(`无法创建专用协调终端：${created.kind}`);
  const listed = await backend.query({ operation: 'terminal-list', worktree: `path:${workspace}` });
  const terminals = listed.kind === 'accepted' ? record(listed.value)?.['terminals'] : null;
  const entries: readonly unknown[] = Array.isArray(terminals) ? terminals : [];
  const terminal = entries.find((entry) => record(entry)?.['title'] === terminalTitle && record(entry)?.['connected'] === true);
  const handle = stringField(terminal, 'handle');
  if (handle === null) throw new Error('无法读回专用协调终端身份');
  binding.handle = handle;
  const createdRun = await backend.mutate({
    operation: 'run-create', objective: 'isolated Graph Patch Planner Worker verification',
  }, scopeFor(`${identity}:run-create`, { kind: 'work-package', id: 'setup' }));
  if (createdRun.kind !== 'accepted') throw new Error(`无法创建专用 Run：${createdRun.kind}`);
  const current = await backend.query({ operation: 'run-current', backendIdentityRef: COORDINATOR_REF });
  runId = current.kind === 'accepted' ? stringField(record(current.value)?.['run'], 'runId') ?? '' : '';
  if (runId.length === 0) throw new Error('无法读回专用 Run 身份');
  return { backend, runId, coordinatorHandle: handle, scopeFor };
}

type RealRuntime = Awaited<ReturnType<typeof createRealWorkerRuntime>>;

function transcriptToolSummary(path: string): { complete: boolean; emptyToolCalls: number } {
  let complete = false;
  let emptyToolCalls = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.length === 0) continue;
    let event: Record<string, unknown> | null;
    try { event = record(JSON.parse(line) as unknown); } catch { continue; }
    const payload = record(event?.['payload']);
    if (event?.['type'] === 'event_msg' && payload?.['type'] === 'task_complete') complete = true;
    if (event?.['type'] === 'response_item' && payload?.['type'] === 'function_call' && payload['arguments'] === '') emptyToolCalls += 1;
  }
  return { complete, emptyToolCalls };
}

async function runGraphPatchPlannerWorker(
  runtime: RealRuntime,
  workspace: string,
  identity: string,
  model: string,
  baseUrl: string,
  envFile: string,
  request: GraphPatchPlannerRequest,
  active: { dispatchId: string | null; terminalHandle: string | null },
): Promise<{ draft: unknown; taskId: string; dispatchId: string; deliveryId: string; attemptId: string }> {
  const reporterDir = join(workspace, '.companion');
  mkdirSync(reporterDir, { recursive: true });
  const reportPath = join(reporterDir, 'session-start.jsonl');
  const reporterPath = join(reporterDir, 'session-start.mjs');
  writeFileSync(reporterPath, [
    "import { appendFileSync } from 'node:fs';",
    "let input = ''; for await (const chunk of process.stdin) input += chunk;",
    'const event = JSON.parse(input);',
    `appendFileSync(${JSON.stringify(reportPath)}, JSON.stringify({`,
    'sessionId: event.session_id ?? null, transcriptPath: event.transcript_path ?? null,',
    'codexHome: process.env.CODEX_HOME ?? null, cwd: event.cwd ?? null,',
    'observedAt: new Date().toISOString() }) + "\\n");',
    'process.stdout.write("{}\\n");',
  ].join('\n'));

  const attemptId = `${identity}:attempt-1`;
  const spec = `${graphPatchPlannerInstruction(request)}\n\nSend the complete JSON draft as the worker_done body with outcome succeeded using the injected Orca dispatch instructions. Do not merely print it. The Controller owns the Attempt identity; do not add or replace identity fields.`;
  const created = await runtime.backend.mutate({
    operation: 'task-create', spec, runId: runtime.runId, taskTitle: `${identity} Graph Patch Planner`,
  }, runtime.scopeFor(`${identity}:planner-task`, { kind: 'work-package', id: 'wp-b' }));
  if (created.kind !== 'accepted') throw new Error(`Planner Task 创建失败：${created.kind}`);
  const taskId = stringField(record(created.value)?.['task'], 'id');
  if (taskId === null) throw new Error('Planner Task 回执缺少 id');

  const tokenHelper = join(reporterDir, 'provider-token.mjs');
  writeFileSync(tokenHelper, [
    "import { readFileSync } from 'node:fs';",
    'const line = readFileSync(process.argv[2], "utf8").split("\\n").find((entry) => entry.startsWith("COORDINATOR_SMOKE_API_KEY="));',
    'if (!line) process.exit(1);',
    'const value = line.slice(line.indexOf("=") + 1).trim();',
    'if (!value) process.exit(1);',
    'process.stdout.write(value);',
  ].join('\n'));
  const sourceCodexHome = join(reporterDir, 'codex-source');
  mkdirSync(sourceCodexHome, { recursive: true });
  writeFileSync(join(sourceCodexHome, 'config.toml'), [
    'disable_response_storage = true',
    'model_reasoning_effort = "low"',
    '',
    '[features]',
    'hooks = true',
    '',
    '[model_providers.companion_minimax]',
    'name = "MiniMax"',
    `base_url = ${JSON.stringify(baseUrl)}`,
    'wire_api = "responses"',
    '',
    '[model_providers.companion_minimax.auth]',
    'command = "node"',
    `args = [${JSON.stringify(tokenHelper)}, ${JSON.stringify(envFile)}]`,
    '',
  ].join('\n'));
  const baseStrategy = createCodexWorkerLaunch({
    launchId: `${identity}:graph-patch-planner`, model, sandboxMode: 'read-only-local-control',
    sessionStartReporterPath: reporterPath,
    sourceCodexHome,
  });
  const strategy = {
    ...baseStrategy,
    prepare: async (context: { worktreePath: string }) => {
      const prepared = await baseStrategy.prepare(context);
      return { ...prepared, command: `${prepared.command} -c model_provider=companion_minimax` };
    },
  };
  const prepared = await prepareWorkerLaunch({
    backend: runtime.backend, strategy, worktreeId: `path:${workspace}`, worktreePath: workspace,
    timeoutMs: 300_000,
    createTerminal: async (mutation) => {
      const outcome = await runtime.backend.mutate(mutation, runtime.scopeFor(`${identity}:planner-terminal`, { kind: 'worker-task', id: taskId }));
      return outcome.kind === 'accepted' ? { kind: 'accepted' } : outcome.kind === 'rejected'
        ? outcome : { kind: 'unknown', operationId: `${identity}:planner-terminal` as OperationId, reason: outcome.reason };
    },
  });
  if (prepared.kind !== 'ready' || prepared.preparedTerminal === null) throw new Error(`Planner terminal 准备失败：${prepared.kind}`);
  active.terminalHandle = prepared.preparedTerminal.handle;
  const dispatchStartedAt = new Date().toISOString();
  const started = await runtime.backend.mutate({
    operation: 'worker-start', taskId, ...prepared.worker, worktree: `path:${workspace}`,
    runId: runtime.runId, timeoutMs: 300_000,
  }, runtime.scopeFor(`${identity}:planner-worker-start`, { kind: 'worker-task', id: taskId }));
  if (started.kind !== 'accepted') throw new Error(`Planner Worker 启动失败：${started.kind}`);
  const dispatchId = stringField(started.value, 'dispatchId');
  if (dispatchId === null) throw new Error('Planner Worker 回执缺少 DispatchId');
  active.dispatchId = dispatchId;
  const activated = await activatePreparedWorker({
    backend: runtime.backend, terminal: prepared.preparedTerminal,
    submitTerminal: async (mutation) => {
      const outcome = await runtime.backend.mutate(mutation, runtime.scopeFor(`${identity}:planner-submit`, { kind: 'worker-task', id: taskId }));
      return outcome.kind === 'accepted' ? { kind: 'accepted' } : outcome.kind === 'rejected'
        ? outcome : { kind: 'unknown', operationId: `${identity}:planner-submit` as OperationId, reason: outcome.reason };
    },
  });
  if (activated.kind !== 'accepted') throw new Error(`Planner 输入提交失败：${activated.kind}`);
  const adoption = await verifyPreparedWorker(runtime.backend, dispatchId, prepared.preparedTerminal);
  if (adoption !== null) throw new Error('无法证明 Planner Dispatch 接管了 exact terminal');

  const bindingDeadline = Date.now() + 120_000;
  let report: CodexSessionStartReport | null = null;
  while (Date.now() < bindingDeadline) {
    if (existsSync(reportPath)) {
      const line = readFileSync(reportPath, 'utf8').split('\n').find(Boolean);
      if (line !== undefined) { report = JSON.parse(line) as CodexSessionStartReport; break; }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  if (report === null) throw new Error('Planner SessionStart 没有上报 exact transcript');
  const proof = proveCodexTranscript({
    report, workspace, dispatchStartedAt, bindingDeadlineAt: new Date().toISOString(),
  });
  if (proof.kind !== 'proven') throw new Error(`Planner Session Binding 无法证明：${proof.reason}`);

  const deadline = Date.now() + 360_000;
  let completeObservedAt: number | null = null;
  while (Date.now() < deadline) {
    const batch = await readDeliveryBatch(runtime.backend, {
      backendIdentityRef: COORDINATOR_REF, runId: runtime.runId, wait: true,
      types: ['worker_done', 'escalation', 'question'], timeoutMs: Math.min(60_000, deadline - Date.now()),
      readMode: 'default',
    });
    if (batch.kind !== 'accepted') throw new Error(`读取 Planner Delivery 失败：${batch.code}`);
    const message = batch.value.messages.find((entry) => {
      const payload = entry.payload === null ? null : record(JSON.parse(entry.payload));
      return payload?.['taskId'] === taskId && payload['dispatchId'] === dispatchId;
    });
    if (message !== undefined) {
      if (message.type !== 'worker_done' || message.body === null) throw new Error(`Planner 返回 ${message.type}，没有补丁草案`);
      if (batch.value.delivery === null) throw new Error('Planner Delivery 缺少可确认 identity');
      return {
        draft: extractJsonObject(message.body),
        taskId,
        dispatchId,
        deliveryId: batch.value.delivery.deliveryId,
        attemptId,
      };
    }
    if (batch.value.delivery !== null) {
      const acked = await ackDelivery(runtime.backend, runtime.scopeFor(`${identity}:prelude-ack:${batch.value.delivery.deliveryId}`, { kind: 'delivery', id: batch.value.delivery.deliveryId }), batch.value.delivery);
      if (acked.kind !== 'accepted') throw new Error('无法确认 Planner 前序 Delivery');
    }
    const transcript = transcriptToolSummary(proof.proof.transcriptRef);
    if (transcript.complete) completeObservedAt ??= Date.now();
    if (completeObservedAt !== null && Date.now() - completeObservedAt > 5_000) {
      throw new Error(`Planner Session 已结束但没有 worker_done；空参数工具调用 ${transcript.emptyToolCalls} 次`);
    }
  }
  const summary = transcriptToolSummary(proof.proof.transcriptRef);
  throw new Error(`等待真实 Graph Patch Planner Worker 超时；空参数工具调用 ${summary.emptyToolCalls} 次`);
}

const resolved = gate();

if (resolved.kind === 'skip') {
  test.skip(`真实 Graph Patch Planner 场景未运行：${resolved.reason}`, () => {});
} else {
  test(
    '真实 Planner 产出结构化补丁草案，声明 exact baseGraphVersion 并逐一处置未接受后代',
    async () => {
      const commonDir = await resolveGitCommonDir({
        repositoryPath: resolved.workspace,
        env: process.env as Record<string, string>,
      });
      if (commonDir.kind === 'failed') {
        throw new Error(`无法解析隔离工作区的 Git common dir：${commonDir.message}`);
      }
      // 一次性隔离工作区：这里必须是干净的，既有的 Companion 状态会让本次场景失去意义。
      const stateDir = join(commonDir.path, COMPANION_STATE_DIRECTORY);
      expect(existsSync(stateDir)).toBe(false);

      const runtime = await createRealWorkerRuntime(resolved.workspace, resolved.identity);
      const active = { dispatchId: null as string | null, terminalHandle: null as string | null };

      const opened = openCoordinationStore({ databasePath: coordinationDatabasePath(commonDir.path) });
      if (opened.kind !== 'opened') {
        throw new Error(`无法打开隔离工作区的 coordination store：${opened.message}`);
      }
      const store = opened.store;
      try {
        const scopeId = `${resolved.identity}:scope` as CoordinationScopeId;
        const sessionId = `${resolved.identity}:session` as CoordinatorSessionId;
        const initialized = initializeCoordinationScope({
          store,
          coordinationScopeId: scopeId,
          coordinatorSessionId: sessionId,
          coordinatorModelConfigurationRef: `${resolved.integration}#${resolved.model}`,
          planningCycleId: `${resolved.identity}:cycle-1` as PlanningCycleId,
        });
        if (initialized.kind !== 'initialized') {
          throw new Error(`无法初始化 Scope：${initialized.code} ${initialized.message}`);
        }
        const acquired = acquireRuntimeLease(store, {
          coordinationScopeId: scopeId,
          coordinatorSessionId: sessionId,
          runtimeIncarnationId: `${resolved.identity}:inc` as RuntimeIncarnationId,
          fencingGeneration: 0,
          ttlMs: 600_000,
        });
        if (acquired.kind !== 'acquired') {
          throw new Error(
            `无法取得 Runtime Lease：${
              acquired.kind === 'rejected'
                ? `${acquired.rejection.code} ${acquired.rejection.message}`
                : '该 Session 的 Runtime Lease 仍由当前 incarnation 持有'
            }`,
          );
        }
        const writer = {
          coordinatorSessionId: sessionId,
          runtimeIncarnationId: `${resolved.identity}:inc` as RuntimeIncarnationId,
          fencingGeneration: acquired.lease.fencingGeneration,
        };

        const graphId = graphIdFor(scopeId, 1 as GraphGeneration);
        const recorded = recordInitialGraph({
          store,
          coordinationScopeId: scopeId,
          writer,
          graph: {
            graphId,
            generation: 1 as GraphGeneration,
            concurrencyLimit: 1,
            workPackages: defaultExecutionWorkPackages(),
          },
          mapRevision: EXECUTION_MAP_REVISION,
          planRevision: EXECUTION_PLAN_REVISION,
          orcaRunId: runtime.runId,
        });
        if (recorded.kind !== 'recorded') {
          throw new Error(`无法记录初始图：${recorded.failure.code}`);
        }
        const manifest = executionManifest({
          graphId,
          generation: 1 as GraphGeneration,
          orcaRunId: runtime.runId,
          coordinationScopeId: scopeId,
          planningCycleId: `${resolved.identity}:cycle-1` as PlanningCycleId,
        });
        const authorized = store.transact({
          kind: 'record-authorization',
          coordinationScopeId: scopeId,
          expectedRevision: currentRevision(store, scopeId),
          writer,
          authorizationId: EXECUTION_AUTHORIZATION_ID,
          authorizationVersion: 1,
          manifestVersion: 1,
          fingerprint: 'fingerprint-real-planner',
          approvalRef: `${resolved.identity}:approval`,
          manifest,
        });
        if (authorized.kind === 'rejected') {
          throw new Error(`无法记录授权：${authorized.message}`);
        }
        // 已接受的图修订只能由 Execution Coordination Lease 持有者推进：场景因此进入执行协调态。
        const executionLease = acquireExecutionLease(store, {
          coordinationScopeId: scopeId,
          coordinatorSessionId: sessionId,
          runtimeIncarnationId: `${resolved.identity}:inc` as RuntimeIncarnationId,
          fencingGeneration: writer.fencingGeneration,
        });
        if (executionLease.kind === 'rejected') {
          throw new Error(`无法取得 Execution Coordination Lease：${executionLease.rejection.message}`);
        }

        const loaded = loadCurrentGraph({ store, coordinationScopeId: scopeId, graphId });
        if (loaded.kind !== 'loaded') {
          throw new Error('无法读取当前图');
        }
        const current = loaded.version;
        const request: GraphPatchPlannerRequest = {
          coordinationScopeId: scopeId,
          graphId,
          baseGraphVersion: current.version,
          patchId: `${resolved.identity}:patch-1`,
          operationId: `${resolved.identity}:op-1` as OperationId,
          changeRequest: {
            workPackageId: 'wp-b' as WorkPackageId,
            infrastructureFailure: 'unknown',
            changesDependencies: 'no',
            changesScopeEnvelope: 'no',
            changesObjective: 'unknown',
            contractContentOnly: 'no',
            goalOrGlobalConstraintChanged: 'no',
            userRequestedReplanning: 'no',
            requiresUserChoice: 'no',
          },
          affectedWorkPackageIds: ['wp-b' as WorkPackageId],
          unacceptedDescendantIds: ['wp-c' as WorkPackageId],
          currentGraph: current.graph,
        };

        const worker = await runGraphPatchPlannerWorker(
          runtime, resolved.workspace, resolved.identity,
          resolved.model, resolved.baseUrl,
          process.env[ENV_FILE_VAR] ?? DEFAULT_ENV_FILE,
          request, active,
        );
        const plannerSpecBinding = {
          provider: 'openspec',
          relativePath: 'openspec/changes/m1-evolve-execution-graph/specs/execution/graph-patching/spec.md',
          contentDigest: `${request.patchId}:planner`,
          providerVersion: 'real-harness',
          contractRevision: current.version,
          trackingRevision: current.version,
        } satisfies SpecBinding;
        const attribution = {
          runId: runtime.runId,
          consumerGeneration: 1,
          graphGeneration: 1,
          authorizationId: EXECUTION_AUTHORIZATION_ID,
          workerTaskId: worker.taskId as WorkerTaskId,
          dispatchId: worker.dispatchId as DispatchId,
          attemptId: worker.attemptId,
          role: 'planner' as const,
          specBinding: plannerSpecBinding,
          worktreeId: `path:${resolved.workspace}`,
        };
        const settled = await settleDelivery({
          store,
          backend: runtime.backend,
          coordinationScopeId: scopeId,
          writer,
          expectedRevision: currentRevision(store, scopeId),
          backendIdentityRef: COORDINATOR_REF,
          graphGeneration: 1,
          authorizationId: EXECUTION_AUTHORIZATION_ID,
          runId: runtime.runId,
          consumerGeneration: 1,
          timeoutMs: 300_000,
          orcaTaskId: worker.taskId,
          delivery: {
            deliveryId: worker.deliveryId,
            claimed: attribution,
            acceptedResult: { kind: 'graph_patch', draft: worker.draft },
          },
          trusted: {
            ...attribution,
            authority: manifest.permissions,
            scopeEnvelope: { include: ['src'], exclude: [] },
            changedPaths: [],
          },
          operationIds: {
            acceptResult: `${resolved.identity}:planner-accept-result` as OperationId,
            ack: `${resolved.identity}:planner-delivery-ack` as OperationId,
          },
        });
        if (settled.kind !== 'settled') {
          throw new Error(`Planner Delivery 未形成 Accepted Worker Result：${settled.kind}`);
        }
        const draft = worker.draft as Record<string, unknown>;
        expect(worker.taskId.length).toBeGreaterThan(0);
        expect(worker.dispatchId.length).toBeGreaterThan(0);
        expect(worker.attemptId.length).toBeGreaterThan(0);

        // 真实 Planner 必须自己声明 exact baseGraphVersion 并处置每一个未接受后代。
        expect(Number(draft['baseGraphVersion'])).toBe(current.version);
        const dispositions = Array.isArray(draft['descendants']) ? draft['descendants'] : [];
        expect(
          dispositions.map((entry) => (entry as { readonly workPackageId?: unknown }).workPackageId),
        ).toContain('wp-c');

        const admitted = admitGraphRevision({
          draft: { payload: draft, operationId: request.operationId, patchId: request.patchId },
          current,
          limits: executionManifest({ graphId, generation: 1 as GraphGeneration }).limits,
          authorization: readAuthorization(store, scopeId),
          acceptedWorkPackageIds: ['wp-a' as WorkPackageId],
          dispatchedWorkPackageIds: [],
        });
        if (admitted.kind === 'rejected') {
          // 真实 Planner 的草案必须能直接喂给确定性编译器；被拒绝时把逐条原因和草案原文一起抛出，
          // 否则一次失败只留下一句「rejected」，无法判断是提示词问题还是模型能力问题。
          throw new Error(
            `Admission 拒绝了真实 Planner 的草案：${admitted.errors
              .map((entry) => `${entry.code}(${entry.workPackageId ?? '-'}): ${entry.message}`)
              .join(' | ')}；草案：${JSON.stringify(draft).slice(0, 800)}`,
          );
        }
        const applied = applyGraphRevision({
          store,
          coordinationScopeId: scopeId,
          writer,
          revision: admitted.revision,
          current,
          authorizationId: EXECUTION_AUTHORIZATION_ID,
          baselines: new Map([...admitted.revision.revisedWorkPackageIds, ...admitted.revision.specificationRevisionRequiredWorkPackageIds].map((id) => [id, null])),
        });
        if (applied.kind === 'rejected') {
          throw new Error(`提交真实 Planner 的修订被拒绝：${applied.failure.code} ${applied.failure.message}`);
        }
        expect(applied.version.version).toBe(current.version + 1);
        expect(applied.version.patchId).toBe(request.patchId);
      } finally {
        store.close();
        if (active.terminalHandle !== null) {
          await runtime.backend.mutate({ operation: 'terminal-close', terminal: active.terminalHandle }, runtime.scopeFor(`${resolved.identity}:planner-terminal-close`, { kind: 'worker-dispatch', id: active.dispatchId ?? 'planner' }));
        }
        if (active.dispatchId !== null) {
          await runtime.backend.mutate({ operation: 'worker-stop', dispatchId: active.dispatchId }, runtime.scopeFor(`${resolved.identity}:planner-stop`, { kind: 'worker-dispatch', id: active.dispatchId }));
          await runtime.backend.mutate({ operation: 'worker-release', dispatchId: active.dispatchId }, runtime.scopeFor(`${resolved.identity}:planner-release`, { kind: 'worker-dispatch', id: active.dispatchId }));
        }
        await runtime.backend.mutate({ operation: 'terminal-close', terminal: runtime.coordinatorHandle }, runtime.scopeFor(`${resolved.identity}:coordinator-close`, { kind: 'work-package', id: 'setup' }));
      }
    },
    600_000,
  );
}

function currentRevision(store: CoordinationStore, scopeId: CoordinationScopeId): number {
  const read = store.query({ kind: 'scope', coordinationScopeId: scopeId });
  if (read.kind !== 'scope' || read.scope === null) {
    throw new Error('无法读取 Scope revision');
  }
  return read.scope.revision;
}

function readAuthorization(store: CoordinationStore, scopeId: CoordinationScopeId): ExecutionAuthorizationRecord {
  const read = store.query({
    kind: 'authorization',
    coordinationScopeId: scopeId,
    authorizationId: EXECUTION_AUTHORIZATION_ID,
  });
  if (read.kind !== 'authorization' || read.authorization === null) {
    throw new Error('无法读取授权记录');
  }
  return read.authorization;
}
