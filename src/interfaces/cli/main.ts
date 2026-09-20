/**
 * IP-6 / MOD-05：`orca-companion` 顶层 CLI 入口。
 *
 * 目前提供 `doctor` 与只读的 `status`；TUI 属于 M2，这里明确拒绝而不是假装支持。
 * 入口不要求 TTY、不加载 Ink/React、不直接调用 adapter（只消费 Bootstrap 注入的能力），
 * 也不在查询时续租或对账。机器输出只写标准输出，诊断只写标准错误。
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createOrcaDoctorProbe, type DoctorProbe } from '../../bootstrap/doctor.js';
import {
  openRepositoryCoordinationStore,
  type CoordinationStoreOpenResult,
} from '../../bootstrap/composition.js';
import { defaultCliIO, runDoctorCommand, type CliIO } from './doctor-command.js';
import { runStatus } from './status-command.js';

export const USAGE = [
  '用法:',
  '  orca-companion doctor                          核验 Orca 环境与 M0 必需能力（无 TTY 可运行）',
  '  orca-companion status [--json]                 只读输出当前 Coordination Scope 状态',
].join('\n');

export type CliEnvironment = {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly executable?: string;
};

export type CliDependencies = {
  readonly createDoctorProbe?: (environment: CliEnvironment) => DoctorProbe;
  readonly openCoordinationStore?: (environment: CliEnvironment) => Promise<CoordinationStoreOpenResult>;
};

/**
 * 身份声明类环境变量不会隐式继承：身份只能经 `ExecutionScope.backendIdentityRef` 显式传入，
 * 否则宿主终端会悄悄变成调用者身份。
 */
export const IDENTITY_ENVIRONMENT_KEYS: readonly string[] = [
  'ORCA_TERMINAL_HANDLE',
  'ORCA_PANE_KEY',
  'ORCA_TAB_ID',
];

export function toChildEnvironment(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || IDENTITY_ENVIRONMENT_KEYS.includes(key)) {
      continue;
    }
    result[key] = value;
  }
  return result;
}

export async function main(
  argv: readonly string[],
  environment: CliEnvironment,
  io: CliIO = defaultCliIO,
  dependencies: CliDependencies = {},
): Promise<number> {
  const [command] = argv;
  if (command === 'doctor') {
    const createProbe = dependencies.createDoctorProbe ?? createOrcaDoctorProbe;
    return await runDoctorCommand(createProbe(environment), io);
  }
  if (command === 'status') {
    const parsed = parseStatusArguments(argv.slice(1));
    if (!parsed.ok) {
      io.writeStderr(`${parsed.message}\n${USAGE}\n`);
      return 2;
    }
    const openStore =
      dependencies.openCoordinationStore ??
      ((target: CliEnvironment) =>
        // status 是只读操作：只读打开，不做 migration、不创建目录、不产生写入。
        openRepositoryCoordinationStore({ repositoryPath: target.cwd, env: target.env, readOnly: true }));
    return await runStatus({
      openStore: () => openStore(environment),
      json: parsed.json,
      io,
    });
  }
  if (command === 'help' || command === '--help' || command === '-h') {
    io.writeStdout(`${USAGE}\n`);
    return 0;
  }
  if (command === '--version') {
    io.writeStdout('0.0.0\n');
    return 0;
  }
  io.writeStderr(
    command === undefined
      ? `orca-companion 目前只提供 doctor 与 status；前台 TUI 属于 M2。\n${USAGE}\n`
      : `未知或尚未提供的子命令: ${command}\n${USAGE}\n`,
  );
  return 2;
}

type StatusArguments =
  | { readonly ok: true; readonly json: boolean }
  | { readonly ok: false; readonly message: string };

function parseStatusArguments(argv: readonly string[]): StatusArguments {
  const unsupported = argv.find((argument) => argument !== '--json');
  if (unsupported !== undefined) {
    return { ok: false, message: `status 不支持参数: ${unsupported}` };
  }
  return { ok: true, json: argv.includes('--json') };
}

function isDirectInvocation(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  process.exitCode = await main(process.argv.slice(2), {
    cwd: process.cwd(),
    env: toChildEnvironment(process.env),
  });
}
