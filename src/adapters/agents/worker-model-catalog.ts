/**
 * 原生模型目录的有界查询（Owner: `remove-worker-credential-management`，IP-02 / Task 2.3）。
 *
 * Worker 的模型与 effort 能力由 harness 自身拥有。Companion 只经各 harness 的公开一次性命令或
 * 控制协议读取目录：codex `debug models`、claude stream-json `list_models`（无 prompt）、
 * opencode `models --standalone`、pi 公开 availability/thinking API、omp `models --json`。查询不读认证/登录
 * 文件、不生成原生 provider 配置、不写用户 harness 配置，也不发送任何模型 prompt，只把非秘密的候选
 * 与来源标识返回给宿主。
 *
 * effort 能力只取 harness 明确给出的档位：codex 的 `supported_reasoning_levels`、claude 的
 * `supportedEffortLevels`、omp 的 `thinking`。只报告 thinking 布尔或完全不报档位的 harness
 * （opencode）一律返回 `null`；pi 只取公开 API 的实际档位，绝不从布尔或推测补齐。查询失败只把该 harness 标为不可用，
 * 由调用方决定是否允许未验证的手填 native exact ID。
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  runProcess,
  type OutputLimits,
  type ProcessRequest,
  type ProcessRunner,
} from '../orca-cli/process-runner.js';
import type { WorkerHarnessId } from '../../domain/model-configuration.js';
import { workerEffortCapabilitySchema } from '../../domain/model-configuration.js';
import type {
  WorkerModelCatalogQuery,
  WorkerModelCatalogResult,
} from '../../application/ports/worker-harness.js';

export const WORKER_MODEL_CATALOG_TIMEOUT_MS = 30_000;
export const WORKER_MODEL_CATALOG_MAX_MODELS = 4096;

const VERSION_TIMEOUT_MS = 10_000;
const CATALOG_LIMITS: OutputLimits = { maxBytes: 1024 * 1024, maxLines: 20_000 };
const VERSION_LIMITS: OutputLimits = { maxBytes: 64 * 1024, maxLines: 20 };

/** 稳定的控制请求 ID：同一查询的重放得到同一 request_id，便于宿主缓存来源，而不是每次随机。 */
const CATALOG_CONTROL_REQUEST_ID = 'companion-worker-model-catalog';

const EXECUTABLES: Readonly<Record<WorkerHarnessId, string>> = {
  codex: 'codex',
  claude: 'claude',
  opencode: 'opencode',
  pi: 'pi',
  omp: 'omp',
};

type CatalogEntry = {
  readonly model: string;
  /** 原生明确给出的 effort 档位；`null` 表示该 harness 未报告档位，不表示支持全部。 */
  readonly effortValues: readonly string[] | null;
};

type CatalogCommand = {
  readonly args: readonly string[];
  /** 来源标识的固定后缀，与 harness 版本共同构成稳定的 catalog source。 */
  readonly provenance: string;
  /** 控制协议需要的一次性有界 stdin；其余命令省略。 */
  readonly stdin?: string;
  readonly parse: (stdout: string) => readonly CatalogEntry[] | null;
};

/** 可注入的接缝：测试替换 runner 与可执行文件，生产用真实进程边界。 */
export type WorkerModelCatalogDeps = {
  readonly runner?: ProcessRunner;
  readonly executables?: Partial<Record<WorkerHarnessId, string>>;
};

export type WorkerModelCatalogOptions = WorkerModelCatalogQuery &
  WorkerModelCatalogDeps & { readonly harness: WorkerHarnessId };

/**
 * 有界查询某 harness 的原生可用模型目录。
 *
 * 结果 `source` 稳定结合 harness、实际可执行版本与命令来源；`models` 只含非秘密的候选与显式
 * effort 档位。任一环节不可核验都返回 `unavailable`，不猜测、不回落其它 harness。
 */
export async function queryWorkerModels(options: WorkerModelCatalogOptions): Promise<WorkerModelCatalogResult> {
  if (options.signal?.aborted) return unavailable('catalog_query_cancelled', `${options.harness} 目录查询被取消`);
  const runner = options.runner ?? runProcess;
  const executable = options.executables?.[options.harness] ?? EXECUTABLES[options.harness];
  const env = options.env ?? environmentStrings(process.env);
  // 单次查询只有一个总预算：版本请求的 10s 计入其中，目录请求只用剩余额度，避免叠加成 40s。
  const deadline = Date.now() + WORKER_MODEL_CATALOG_TIMEOUT_MS;

  const version = await readVersion(runner, {
    executable,
    cwd: options.cwd,
    env,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (options.signal?.aborted) return unavailable('catalog_query_cancelled', `${options.harness} 目录查询被取消`);
  if (version === null) {
    return unavailable('harness_version_unreadable', `无法核验 ${options.harness} 可执行文件版本`);
  }
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    return unavailable('catalog_query_timeout', `${options.harness} 目录查询超时`);
  }

  const command = catalogCommand(options.harness, executable, env);
  if (command === null) return unavailable('catalog_api_unavailable', 'pi 公开模型 API 不可用');
  const result = await runner(catalogRequest({
    executable: options.harness === 'pi' ? process.execPath : executable,
    command,
    cwd: options.cwd,
    env,
    timeoutMs: remainingMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }));

  if (result.kind === 'unavailable') {
    return unavailable('harness_spawn_failed', `无法启动 ${options.harness}`);
  }
  if (result.kind === 'unknown') {
    return result.reason === 'timeout'
      ? unavailable('catalog_query_timeout', `${options.harness} 目录查询超时`)
      : unavailable('catalog_query_cancelled', `${options.harness} 目录查询被取消`);
  }
  if (result.stdout.truncated) {
    return unavailable('catalog_output_truncated', `${options.harness} 目录输出超过有界上限，无法核验`);
  }
  if (result.exitCode !== 0) return unavailable('catalog_query_failed', `${options.harness} 目录查询退出码 ${result.exitCode}`);

  const entries = command.parse(result.stdout.text);
  if (entries === null) {
    return unavailable('catalog_output_unrecognized', `${options.harness} 目录输出无法核验`);
  }
  if (entries.length === 0) {
    return unavailable('catalog_empty', `${options.harness} 没有返回可用的原生模型`);
  }
  if (entries.length > WORKER_MODEL_CATALOG_MAX_MODELS) {
    return unavailable(
      'catalog_too_large',
      `${options.harness} 目录超过 ${WORKER_MODEL_CATALOG_MAX_MODELS} 项上限`,
    );
  }

  const source = `${options.harness}:${version}:${command.provenance}`;
  if (entries.some((entry) => entry.model.trim().length === 0 || entry.model.length > 2048
    || (entry.effortValues !== null && !workerEffortCapabilitySchema.safeParse({ values: entry.effortValues, source }).success))) {
    return unavailable('catalog_output_unrecognized', `${options.harness} 目录输出无法核验`);
  }
  return {
    kind: 'available',
    source,
    models: entries.map((entry) => ({
      model: entry.model,
      effortCapability: entry.effortValues === null
        ? null
        : { values: [...entry.effortValues], source },
    })),
  };
}

/**
 * 把某个 harness 固定到端口方法上：bootstrap 注册表只写一行 `queryModels: workerModelQuery('codex')`。
 */
export function workerModelQuery(
  harness: WorkerHarnessId,
  deps: WorkerModelCatalogDeps = {},
): (input: WorkerModelCatalogQuery) => Promise<WorkerModelCatalogResult> {
  return (input) => queryWorkerModels({ harness, ...deps, ...input });
}

function catalogCommand(harness: WorkerHarnessId, executable: string, env: Readonly<Record<string, string>>): CatalogCommand | null {
  switch (harness) {
    case 'codex':
      return { args: ['debug', 'models'], provenance: 'debug-models', parse: parseCodexCatalog };
    case 'claude':
      return {
        args: ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose'],
        provenance: 'control-list-models',
        stdin: JSON.stringify({
          type: 'control_request',
          request_id: CATALOG_CONTROL_REQUEST_ID,
          request: { subtype: 'list_models' },
        }) + '\n',
        parse: parseClaudeCatalog,
      };
    case 'opencode':
      return { args: ['models', '--standalone'], provenance: 'models-standalone', parse: parseModelTableCatalog };
    case 'pi':
      return piCatalogCommand(executable, env);
    case 'omp':
      return { args: ['models', '--json'], provenance: 'models-json', parse: parseOmpCatalog };
  }
}

/** Resolve only public package exports from the installed CLI; authentication remains inside pi. */
function piCatalogCommand(executable: string, env: Readonly<Record<string, string>>): CatalogCommand | null {
  try {
    const binary = isAbsolute(executable) ? executable : (env['PATH'] ?? '').split(':')
      .map((directory) => join(directory, executable)).find((path) => existsSync(path));
    if (binary === undefined) return null;
    let root = dirname(realpathSync(binary));
    while (!existsSync(join(root, 'package.json'))) {
      const parent = dirname(root);
      if (parent === root) return null;
      root = parent;
    }
    const entry = (directory: string, subpath: string): string | null => {
      const manifest: unknown = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
      if (!isRecord(manifest) || !isRecord(manifest['exports'])) return null;
      const exported = manifest['exports'][subpath];
      const path = typeof exported === 'string' ? exported : isRecord(exported) ? exported['import'] : undefined;
      return typeof path === 'string' ? pathToFileURL(join(directory, path)).href : null;
    };
    const sdk = entry(root, '.');
    let dependencyRoot = root;
    let thinking: string | null = null;
    while (thinking === null) {
      const candidate = join(dependencyRoot, 'node_modules', '@earendil-works', 'pi-ai');
      if (existsSync(join(candidate, 'package.json'))) thinking = entry(candidate, './compat');
      const parent = dirname(dependencyRoot);
      if (parent === dependencyRoot) break;
      dependencyRoot = parent;
    }
    if (sdk === null || thinking === null) return null;
    return {
      args: ['--input-type=module', '-e',
        `const { ModelRuntime } = await import(${JSON.stringify(sdk)});\n` +
        `const { getSupportedThinkingLevels } = await import(${JSON.stringify(thinking)});\n` +
        'const runtime = await ModelRuntime.create({ allowModelNetwork: false });\n' +
        'const models = await runtime.getAvailable();\n' +
        'process.stdout.write(JSON.stringify({ models: models.map(model => ({ selector: model.provider + "/" + model.id, thinking: model.reasoning ? getSupportedThinkingLevels(model) : null })) }));'],
      provenance: 'availability-thinking-api',
      parse: parseOmpCatalog,
    };
  } catch { return null; }
}

function catalogRequest(input: {
  readonly executable: string;
  readonly command: CatalogCommand;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): ProcessRequest {
  return {
    executable: input.executable,
    args: input.command.args,
    cwd: input.cwd,
    env: input.env,
    timeoutMs: input.timeoutMs,
    limits: CATALOG_LIMITS,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.command.stdin === undefined ? {} : { stdin: input.command.stdin }),
  };
}

/** 版本只用于构成稳定的 catalog source；读不到就 fail closed，不用猜测的版本冒充来源。 */
async function readVersion(
  runner: ProcessRunner,
  input: {
    readonly executable: string;
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
  },
): Promise<string | null> {
  const request: ProcessRequest = {
    executable: input.executable,
    args: ['--version'],
    cwd: input.cwd,
    env: input.env,
    timeoutMs: VERSION_TIMEOUT_MS,
    limits: VERSION_LIMITS,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
  const result = await runner(request);
  if (result.kind !== 'completed' || result.exitCode !== 0 || result.stdout.truncated) return null;
  const line = result.stdout.text.split('\n').map((entry) => entry.trim()).find((entry) => entry.length > 0);
  if (line === undefined) return null;
  return /\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.]+)?/u.exec(line)?.[0] ?? null;
}

// ---------------------------------------------------------------------------------------------
// 逐 harness 解析
// ---------------------------------------------------------------------------------------------

/** codex `debug models`：默认（refresh）目录已按账号过滤，隐藏项与显式不可用项再剔一次。 */
function parseCodexCatalog(stdout: string): readonly CatalogEntry[] | null {
  const root = safeJson(stdout);
  if (!isRecord(root)) return null;
  const models = root['models'];
  if (!Array.isArray(models)) return null;
  const entries: CatalogEntry[] = [];
  for (const raw of models) {
    if (!isRecord(raw)) continue;
    const slug = raw['slug'];
    if (typeof slug !== 'string' || slug.length === 0) continue;
    if (raw['visibility'] === 'hide') continue;
    if (raw['is_available'] === false || raw['available'] === false) continue;
    entries.push({ model: slug, effortValues: effortValuesOf(raw['supported_reasoning_levels'], 'effort') });
  }
  return dedupeEntries(entries);
}

/** claude stream-json control protocol：只认与本次稳定 request_id 匹配的 list_models 成功响应。 */
function parseClaudeCatalog(stdout: string): readonly CatalogEntry[] | null {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const parsed = safeJson(trimmed);
    if (!isRecord(parsed) || parsed['type'] !== 'control_response') continue;
    const envelope = parsed['response'];
    if (!isRecord(envelope) || envelope['request_id'] !== CATALOG_CONTROL_REQUEST_ID) continue;
    if (envelope['subtype'] !== 'success') return null;
    return claudeEntries(envelope['response']);
  }
  return null;
}

function claudeEntries(body: unknown): readonly CatalogEntry[] | null {
  if (!isRecord(body)) return null;
  const models = body['models'];
  if (!Array.isArray(models)) return null;
  const entries: CatalogEntry[] = [];
  for (const raw of models) {
    if (!isRecord(raw)) continue;
    const model = raw['resolvedModel'];
    if (typeof model !== 'string' || model.length === 0) continue;
    const levels = raw['supportsEffort'] === false ? null : stringList(raw['supportedEffortLevels']);
    entries.push({ model, effortValues: levels });
  }
  return dedupeEntries(entries);
}

/** omp `models --json`：`selector` 是 provider/id；档位只认实际 `thinking` 数组。 */
function parseOmpCatalog(stdout: string): readonly CatalogEntry[] | null {
  const root = safeJson(stdout);
  if (!isRecord(root)) return null;
  const models = root['models'];
  if (!Array.isArray(models)) return null;
  const entries: CatalogEntry[] = [];
  for (const raw of models) {
    if (!isRecord(raw)) continue;
    const kind = raw['kind'];
    if (kind !== undefined && kind !== 'chat') continue;
    const selector = raw['selector'];
    if (typeof selector !== 'string' || selector.length === 0) continue;
    entries.push({ model: selector, effortValues: stringList(raw['thinking']) });
  }
  return dedupeEntries(entries);
}

/** OpenCode 的公开列表只含 provider/model，因此 effort 一律为 null。 */
function parseModelTableCatalog(stdout: string): readonly CatalogEntry[] | null {
  const lines = stdout
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  const header = lines[0];
  if (header === undefined) return [];
  const headerColumns = splitColumns(header);
  if (headerColumns[0] !== 'provider' || headerColumns[1] !== 'model') return null;
  const entries: CatalogEntry[] = [];
  for (const line of lines.slice(1)) {
    const columns = splitColumns(line);
    const provider = columns[0];
    const model = columns[1];
    if (provider === undefined || model === undefined || provider.length === 0 || model.length === 0) return null;
    entries.push({ model: `${provider}/${model}`, effortValues: null });
  }
  return dedupeEntries(entries);
}

function splitColumns(line: string): readonly string[] {
  return line.trim().split(/\s{2,}/u);
}

// ---------------------------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------------------------

function effortValuesOf(list: unknown, key: string): readonly string[] | null {
  if (!Array.isArray(list)) return null;
  const values: string[] = [];
  for (const item of list) {
    const value = isRecord(item) ? item[key] : undefined;
    if (typeof value === 'string' && value.length > 0) values.push(value);
  }
  const unique = [...new Set(values)];
  return unique.length === 0 ? null : unique;
}

function stringList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const values = (value as readonly unknown[]).filter((item): item is string => typeof item === 'string' && item.length > 0);
  const unique = [...new Set(values)];
  return unique.length === 0 ? null : unique;
}

function dedupeEntries(entries: readonly CatalogEntry[]): readonly CatalogEntry[] {
  const seen = new Set<string>();
  const result: CatalogEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.model)) continue;
    seen.add(entry.model);
    result.push(entry);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** 原生进程只继承调用方显式给出的环境，不落任何整份环境变量或秘密。 */
function environmentStrings(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') result[key] = value;
  }
  return result;
}

function unavailable(code: string, message: string): WorkerModelCatalogResult {
  return { kind: 'unavailable', code, message };
}
