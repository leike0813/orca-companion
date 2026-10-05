/**
 * IP-03 / D06：secretless Codex 启动（Owner: `complete-tui-model-configuration`）。
 *
 * 这里是**唯一**的模型配置生成器：把不可变的 `WorkerModelConfiguration` 变成 Codex 进程真正收到
 * 的 provider/model/effort/options 设置，以及一条不含任何秘密的公开启动命令。普通 Worker、只读
 * Finalizer、Utility Worker 与只读能力探针全部经由这里，因此「探针通过」始终说明正式会话也会拿到
 * 同一份设置。
 *
 * 秘密边界（硬约束）：API key 只经子进程环境变量进入 Codex。key 绝不进入 descriptor、`config.toml`、
 * 终端命令、argv、checkpoint 或任何持久记录。managed 凭据通过自定义 provider 的 `env_key` +
 * `requires_openai_auth=false` 注入并显式**不**链接 `auth.json`，避免既有 Harness 认证抢优先级；
 * `harness_login` 则保留原 `auth.json` 绑定。
 *
 * 公开终端命令只含 `node`、launcher 脚本路径与 descriptor 路径；launcher 脚本自包含（只用 Node
 * 内建模块），因此不假设任何打包/安装路径，也不 import Companion 的编译产物。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import {
  CREDENTIAL_STORE_SCHEMA_VERSION,
  MAX_CREDENTIAL_ENTRIES,
  MAX_CREDENTIAL_STORE_BYTES,
  credentialStorePath,
} from '../storage/credential-store.js';

import { scanModelOptionFields, workerModelConfigurationSchema, type WorkerModelConfiguration } from '../../domain/model-configuration.js';

/** 隔离 CODEX_HOME 内的 launcher 脚本文件名。 */
export const CODEX_MODEL_LAUNCHER_FILENAME = 'codex-model-launcher.mjs';

/** 隔离 CODEX_HOME 内的非秘密 descriptor 文件名。 */
export const CODEX_MODEL_DESCRIPTOR_FILENAME = 'codex-model-launch.json';

/** descriptor 版本；结构变化时递增，旧 descriptor 一律 fail closed。 */
export const CODEX_MODEL_DESCRIPTOR_VERSION = 1;

/** Codex session 身份（UUID 或 session name）的安全形态；不匹配的一律拒绝，不拼进 argv。 */
export const SAFE_CODEX_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * managed 凭据注入 child env 时使用的环境变量「名称」（不是值）。名称本身不是秘密，可以写进
 * descriptor 与 `config.toml`；真正的 key 只在 launcher 运行时从凭据文件读出并放进子进程环境。
 */
export const CODEX_MANAGED_CREDENTIAL_ENV = 'COMPANION_CODEX_MANAGED_KEY';

/** Codex 读取 reasoning effort 的固定配置键。 */
const CODEX_EFFORT_KEY = 'model_reasoning_effort';

/** Codex 读取当前 provider 的固定配置键。 */
const CODEX_PROVIDER_KEY = 'model_provider';

/**
 * 模型配置不得触碰的键。
 *
 * 沙箱、审批、权限 profile、hook 与 transcript 报告绑定由宿主按已批准 Manifest 决定，绝不能被
 * 模型配置里的 modelOptions 悄悄放宽。Codex 对 CLI flag 与 -c 同名键的优先级不作为契约，因此
 * 这里不用「参数顺序」当安全机制，而是在生成阶段直接拒绝这些键：拒绝比静默丢弃更早暴露配置错误。
 */
const RESERVED_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'sandbox_mode',
  'sandbox_workspace_write',
  'approval_policy',
  'approvals_reviewer',
  'default_permissions',
  'permissions',
  'profile',
  'hooks',
  'model',
  'model_provider',
  'model_providers',
  'model_reasoning_effort',
]);

function assertOptionsAreNotReserved(options: Readonly<Record<string, unknown>>): void {
  for (const key of Object.keys(options)) {
    const head = key.split('.')[0] ?? key;
    if (RESERVED_CONFIG_KEYS.has(key) || RESERVED_CONFIG_KEYS.has(head)) {
      throw new Error('模型配置不能设置宿主保留的 Codex 配置项：' + key);
    }
  }
}

export type CodexManagedCredentialDescriptor = {
  readonly kind: 'managed';
  /** 不可变引用；不是 secret。 */
  readonly credentialRef: string;
  /** 承载 secret 的环境变量名称；不是 secret 值。 */
  readonly envKey: string;
  /** 用户级 CredentialStore 文件位置；launcher 运行时据此读取 secret。 */
  readonly storePath: string;
};

export type CodexHarnessLoginCredentialDescriptor = { readonly kind: 'harness_login' };

export type CodexModelCredentialDescriptor =
  | CodexManagedCredentialDescriptor
  | CodexHarnessLoginCredentialDescriptor;

/** 完全不含秘密的启动描述符；launcher 脚本据此拼出 argv/env 并拉起 Codex。 */
export type CodexModelLaunchDescriptor = {
  readonly version: number;
  /** 隔离的 CODEX_HOME。 */
  readonly codexHome: string;
  /** Codex 可执行文件名（默认 `codex`，测试可指向 fake）。 */
  readonly executable: string;
  /** 传给 Codex 的完整 argv（不含任何 secret）。 */
  readonly args: readonly string[];
  readonly credential: CodexModelCredentialDescriptor;
};

/** 把一个模型选项值编码成可被 `codex -c key=value` 解析的 TOML 字面量。 */
/** TOML basic string：与 JSON 字符串在转义上兼容，足以覆盖模型选项里的非秘密文本。 */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * 把 JSON 兼容的非秘密值编码成 TOML 字面量。
 *
 * 不能用 `JSON.stringify`：TOML inline table 是 `{ a = 1 }` 而不是 `{"a":1}`，写成 JSON 会让
 * Codex 的 `-c` 解析失败并**静默**退回成原始字符串，配置错误就此不可见。数组与对象都递归编码，
 * 只接受 JSON 兼容子集（string / number / boolean / null / 数组 / 普通对象）；遇到函数、Symbol 等
 * 一律返回 null，由调用方拒绝而不是写出无法解析的参数。
 */
function encodeTomlValue(value: unknown, depth: number): string | null {
  if (depth > 8) return null;
  if (typeof value === 'string') return tomlString(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (value === null) return null;
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (const item of value) {
      // TOML 1.0 不支持 null 元素，因此 null 元素直接拒绝整项，而不是写出无法解析的数组。
      if (item === null) return null;
      const encoded = encodeTomlValue(item, depth + 1);
      if (encoded === null) return null;
      items.push(encoded);
    }
    return '[' + items.join(', ') + ']';
  }
  if (typeof value === 'object') {
    const entries: string[] = [];
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      // 嵌套 null/undefined 同样不静默丢弃：整个值判为不可编码，由调用方拒绝启动。
      if (item === null || item === undefined) return null;
      const encoded = encodeTomlValue(item, depth + 1);
      if (encoded === null) return null;
      entries.push(tomlString(key) + ' = ' + encoded);
    }
    return '{ ' + entries.join(', ') + ' }';
  }
  return null;
}

export function codexConfigValue(value: unknown): string | null {
  return encodeTomlValue(value, 0);
}

/**
 * 把一组非秘密模型选项展开成有序 `-c key=value` 参数。
 *
 * 不可编码的值一律抛错而不是跳过：用户审阅并保存过的选项如果在启动时被静默丢弃，配置看起来
 * 生效了其实没有，那正是最坏的失败形态。TOML 没有 null 类型，因此 null/NaN/函数/含 null 的
 * 数组等都没有确定的 Codex 语义，只能拒绝。
 */
function optionArguments(options: Readonly<Record<string, unknown>>): readonly string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(options)) {
    const encoded = codexConfigValue(value);
    if (encoded === null) {
      throw new Error('Codex 模型选项无法编码为 TOML，已拒绝启动：' + key);
    }
    args.push('-c', `${key}=${encoded}`);
  }
  return args;
}

function providerArguments(
  configuration: Readonly<WorkerModelConfiguration>,
  envKey: string,
): readonly string[] {
  const codex = configuration.connection.codex;
  if (codex === null) return [];
  const id = codex.providerId;
  const args = [
    '-c', `${CODEX_PROVIDER_KEY}=${id}`,
    '-c', `model_providers.${id}.name=${JSON.stringify(configuration.connection.label)}`,
    '-c', `model_providers.${id}.base_url=${JSON.stringify(codex.baseUrl)}`,
    '-c', `model_providers.${id}.wire_api=${codex.wireApi}`,
  ];
  if (configuration.connection.credential.kind === 'managed') {
    // 显式声明 env_key 并关闭 OpenAI 认证，使 managed key 成为唯一凭据来源；auth.json 不再链接。
    args.push('-c', `model_providers.${id}.env_key=${envKey}`);
    args.push('-c', `model_providers.${id}.requires_openai_auth=false`);
  }
  return args;
}

/**
 * 由模型配置生成 provider/model/effort/options 的全部 `-c` 参数，供 Worker 与 sandbox 共用。
 *
 * 顺序有安全含义：用户选项在前，固定身份（provider/model/effort）与凭据（env_key）在后，因此一个
 * `modelOptions` 不能改掉凭据来源或冒用固定模型。effort 只有在配置显式给出时才注入。
 */
export function codexModelArguments(configuration: Readonly<WorkerModelConfiguration>): readonly string[] {
  assertLaunchableModelConfiguration(configuration);
  return [
    ...optionArguments(configuration.connection.modelOptions),
    ...optionArguments(configuration.modelOptions),
    '-c', `model=${JSON.stringify(configuration.model)}`,
    ...providerArguments(configuration, CODEX_MANAGED_CREDENTIAL_ENV),
    ...(configuration.effort === null ? [] : ['-c', `${CODEX_EFFORT_KEY}=${JSON.stringify(configuration.effort)}`]),
  ];
}

/**
 * 启动前的全部模型配置门禁，与 argv 生成共用同一套判断。
 *
 * 单独导出是为了让 `createCodexWorkerLaunch` 在**写任何盘**之前先跑一遍：被拒绝的启动不该留下
 * 状态根、descriptor 或 config.toml，否则「没启动成功」却留下可被误用的现场。
 */
export function assertLaunchableModelConfiguration(configuration: Readonly<WorkerModelConfiguration>): void {
  if (scanModelOptionFields(configuration, 'configuration', true).kind !== 'clean'
    || !workerModelConfigurationSchema.safeParse(configuration).success) {
    throw new Error('Codex 模型配置含秘密或无效设置，拒绝启动');
  }
  if (configuration.effort !== null && configuration.effortCapability === null) {
    throw new Error('Codex 模型配置设置了 effort 却没有可信能力来源，拒绝启动');
  }
  const credential = configuration.connection.credential;
  if (credential.kind === 'managed' && configuration.connection.codex === null) {
    // managed 凭据只能经自定义 provider 的 env_key 注入；没有 codex provider 时无处安放，必须 fail closed。
    throw new Error('Codex managed 凭据必须绑定自定义 codex provider（connection.codex）');
  }
  assertOptionsAreNotReserved(configuration.connection.modelOptions);
  assertOptionsAreNotReserved(configuration.modelOptions);
  // 选项必须能编码成 TOML；不可编码同样在写盘前拒绝，不留到生成 argv 时才发现。
  for (const options of [configuration.connection.modelOptions, configuration.modelOptions]) {
    for (const [key, value] of Object.entries(options)) {
      if (codexConfigValue(value) === null) {
        throw new Error('Codex 模型选项无法编码为 TOML，已拒绝启动：' + key);
      }
    }
  }
}

export function buildCodexModelLaunchDescriptor(input: {
  readonly modelConfiguration: Readonly<WorkerModelConfiguration>;
  readonly codexHome: string;
  readonly baseArguments: readonly string[];
  readonly sandboxArguments: readonly string[];
  readonly credentialStorePath?: string;
  readonly executable?: string;
  /**
   * 已有 session 的精确身份；给出时启动命令变成 `codex resume <session-id> ...`。
   *
   * 只接受安全形态：session 身份来自可证明的 Session Binding，不是模型或调用方自由填写的值。
   */
  readonly resumeSessionId?: string;
}): CodexModelLaunchDescriptor {
  const { modelConfiguration } = input;
  if (!isAbsolute(input.codexHome)) {
    throw new Error(`Codex 隔离 CODEX_HOME 必须是绝对路径：${input.codexHome}`);
  }
  const credential = modelConfiguration.connection.credential;
  const managed = credential.kind === 'managed' ? credential : null;
  if (input.resumeSessionId !== undefined && !SAFE_CODEX_SESSION_ID.test(input.resumeSessionId)) {
    throw new Error('Codex resume session ID 形态非法，拒绝启动');
  }
  const args = [
    ...(input.resumeSessionId === undefined ? [] : ['resume', input.resumeSessionId]),
    ...input.baseArguments,
    ...input.sandboxArguments,
    ...codexModelArguments(modelConfiguration),
  ];
  if (managed !== null && args.some((arg) => arg.includes(managed.credentialRef))) {
    // 防御：credentialRef 是身份不是秘密，绝不能被写进 argv。
    throw new Error('Codex 启动参数意外包含凭据引用，拒绝启动');
  }
  return {
    version: CODEX_MODEL_DESCRIPTOR_VERSION,
    codexHome: input.codexHome,
    executable: input.executable ?? 'codex',
    args,
    credential: managed === null
      ? { kind: 'harness_login' }
      : {
          kind: 'managed',
          credentialRef: managed.credentialRef,
          envKey: CODEX_MANAGED_CREDENTIAL_ENV,
          storePath: input.credentialStorePath ?? credentialStorePath(),
        },
  };
}

/**
 * 自包含 launcher 脚本正文。
 *
 * 只用 Node 内建模块，不 import Companion 编译产物，因此与安装/打包路径无关。运行时职责只有三件：
 * 读 descriptor、（managed 时）从凭据文件取出 secret 注入子进程环境、透传信号与退出码拉起 Codex。
 * secret 只存在于内存与子进程环境，不写日志、不进 argv。
 */
function launcherSource(): string {
  // 权限/体积/结构上限直接取自 CredentialStore adapter：launcher 不另立一套数字，改一处即同步。
  return `import { spawn } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const STORE_SCHEMA_VERSION = __SCHEMA__;
const MAX_STORE_BYTES = __MAXBYTES__;
const MAX_STORE_ENTRIES = __MAXENTRIES__;
const GROUP_AND_OTHER_BITS = 0o077;

const descriptorPath = process.argv[2];
if (typeof descriptorPath !== 'string' || descriptorPath.length === 0) {
  process.stderr.write('companion codex launcher: missing descriptor path\\n');
  process.exit(2);
}

function fail(message) {
  process.stderr.write('companion codex launcher: ' + message + '\\n');
  process.exit(2);
}

let descriptor;
try {
  descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
} catch {
  fail('cannot read model launch descriptor');
}
if (
  typeof descriptor !== 'object' ||
  descriptor === null ||
  typeof descriptor.codexHome !== 'string' ||
  typeof descriptor.executable !== 'string' ||
  !Array.isArray(descriptor.args) ||
  typeof descriptor.credential !== 'object' ||
  descriptor.credential === null
) {
  fail('invalid model launch descriptor');
}

const env = Object.assign({}, process.env, { CODEX_HOME: descriptor.codexHome });
const credential = descriptor.credential;
if (credential.kind === 'managed') {
  // 复用 CredentialStore 的权限/体积/结构边界：目录与文件都必须 owner-only，文件不得是符号链接，
  // 体积有上限，schemaVersion 精确匹配，revision 合法，entry 引用唯一。任一不满足都在启动
  // 子进程之前 fail closed，且只报告固定 code，不回显路径内容或任何 secret 片段。
  // 返回带 ok 判别的结果：错误码本身是字符串，不能靠 typeof 区分，否则失败码会被当成 secret。
  function readManagedSecret() {
    let fileStat;
    let dirStat;
    try {
      fileStat = lstatSync(credential.storePath);
      dirStat = lstatSync(dirname(credential.storePath));
    } catch {
      return { ok: false, code: 'credential_store_unreadable' };
    }
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) return { ok: false, code: 'credential_store_invalid' };
    if ((fileStat.mode & GROUP_AND_OTHER_BITS) !== 0) return { ok: false, code: 'credential_permission_denied' };
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return { ok: false, code: 'credential_store_invalid' };
    if ((dirStat.mode & GROUP_AND_OTHER_BITS) !== 0) return { ok: false, code: 'credential_permission_denied' };
    if (fileStat.size > MAX_STORE_BYTES) return { ok: false, code: 'credential_store_too_large' };
    let store;
    try {
      store = JSON.parse(readFileSync(credential.storePath, 'utf8'));
    } catch {
      return { ok: false, code: 'credential_store_invalid' };
    }
    if (typeof store !== 'object' || store === null) return { ok: false, code: 'credential_store_invalid' };
    if (store.schemaVersion !== STORE_SCHEMA_VERSION) return { ok: false, code: 'credential_store_invalid' };
    if (!Number.isSafeInteger(store.revision) || store.revision < 0) return { ok: false, code: 'credential_store_invalid' };
    if (!Array.isArray(store.entries) || store.entries.length > MAX_STORE_ENTRIES) {
      return { ok: false, code: 'credential_store_invalid' };
    }
    const seen = new Set();
    for (const entry of store.entries) {
      if (typeof entry !== 'object' || entry === null) return { ok: false, code: 'credential_store_invalid' };
      if (typeof entry.credentialRef !== 'string' || typeof entry.secret !== 'string') {
        return { ok: false, code: 'credential_store_invalid' };
      }
      if (seen.has(entry.credentialRef)) return { ok: false, code: 'credential_store_invalid' };
      seen.add(entry.credentialRef);
    }
    const found = store.entries.find((entry) => entry.credentialRef === credential.credentialRef);
    if (found === undefined || found.secret.length === 0) return { ok: false, code: 'credential_missing' };
    return { ok: true, secret: found.secret };
  }

  const resolved = readManagedSecret();
  if (resolved.ok !== true) {
    fail('managed credential rejected: ' + resolved.code);
  }
  env[credential.envKey] = resolved.secret;
}

const child = spawn(descriptor.executable, descriptor.args, { env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}
child.on('error', (error) => {
  const reason = error && typeof error.code === 'string' ? error.code : 'spawn_failed';
  process.stderr.write('companion codex launcher: cannot start codex (' + reason + ')\\n');
  process.exit(1);
});
child.on('close', (code, signal) => {
  if (typeof code === 'number') process.exit(code);
  process.exit(signal ? 1 : 0);
});
`;
}

/** 安装 launcher 脚本（内容不变则不重写），返回脚本路径。 */
export function installCodexModelLauncher(codexHome: string): string {
  const launcherPath = join(codexHome, CODEX_MODEL_LAUNCHER_FILENAME);
  const source = launcherSource()
    .split('__SCHEMA__').join(String(CREDENTIAL_STORE_SCHEMA_VERSION))
    .split('__MAXBYTES__').join(String(MAX_CREDENTIAL_STORE_BYTES))
    .split('__MAXENTRIES__').join(String(MAX_CREDENTIAL_ENTRIES));
  if (!existsSync(launcherPath) || readFileSync(launcherPath, 'utf8') !== source) {
    writeFileSync(launcherPath, source, 'utf8');
  }
  return launcherPath;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** 写出 descriptor 与 launcher，返回两条路径。descriptor 只含非秘密设置。 */
export function writeCodexModelLaunch(input: {
  readonly codexHome: string;
  readonly descriptor: CodexModelLaunchDescriptor;
}): { readonly descriptorPath: string; readonly launcherPath: string } {
  const descriptorPath = join(input.codexHome, CODEX_MODEL_DESCRIPTOR_FILENAME);
  writeFileSync(descriptorPath, `${JSON.stringify(input.descriptor, null, 2)}\n`, 'utf8');
  const launcherPath = installCodexModelLauncher(input.codexHome);
  return { descriptorPath, launcherPath };
}

/** 公开启动命令：只有 node、launcher 与 descriptor；不含 key、模型或任何秘密。 */
export function codexModelLaunchCommand(input: {
  readonly launcherPath: string;
  readonly descriptorPath: string;
  readonly nodeExecutable?: string;
}): string {
  const node = input.nodeExecutable ?? 'node';
  return [node, shellQuote(input.launcherPath), shellQuote(input.descriptorPath)].join(' ');
}
