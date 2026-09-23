/**
 * IP-6 / MOD-05：`orca-companion` 顶层 CLI 入口。
 *
 * 识别 `[repository-path]`（前台 TUI）、`status [--json]`、`doctor`；`run`/`resume`/`tui` 明确不存在。
 * 入口不要求 TTY、不直接调用 adapter（只消费 Bootstrap 注入的能力），也不在查询时续租或对账。
 * 机器输出只写标准输出，诊断只写标准错误。
 *
 * TUI 路径在 `src/bootstrap/tui-entry.ts` 里检查 TTY，并在通过后才动态加载 Ink：本模块不 import
 * Ink/React，因此无 TTY 时 stdout 不会出现渲染帧。
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createOrcaDoctorProbe, type DoctorProbe } from '../../bootstrap/doctor.js';
import {
  openRepositoryCoordinationStore,
  type CoordinationStoreOpenResult,
} from '../../bootstrap/composition.js';
import { runTuiEntry, type TuiEntryEnvironment } from '../../bootstrap/tui-entry.js';
import { CLI_USAGE, parseCliArguments, renderRejection } from './argv.js';
import { defaultCliIO, runDoctorCommand, type CliIO } from './doctor-command.js';
import { runStatus } from './status-command.js';

export const USAGE = CLI_USAGE;

export type CliEnvironment = {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly executable?: string;
  /** 进程级 TTY 事实；缺省按「无 TTY」处理，避免在测试或 CI 里假装交互。 */
  readonly stdinIsTty?: boolean;
  readonly stdoutIsTty?: boolean;
  readonly columns?: number;
};

export type CliDependencies = {
  readonly createDoctorProbe?: (environment: CliEnvironment) => DoctorProbe;
  readonly openCoordinationStore?: (environment: CliEnvironment) => Promise<CoordinationStoreOpenResult>;
  /** 覆盖点：测试注入 fake 端口与渲染器；生产走 `runTuiEntry`。 */
  readonly runTui?: (environment: TuiEntryEnvironment, io: CliIO) => Promise<number>;
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
  const invocation = parseCliArguments(argv);
  switch (invocation.kind) {
    case 'doctor': {
      const createProbe = dependencies.createDoctorProbe ?? createOrcaDoctorProbe;
      return await runDoctorCommand(createProbe(environment), io);
    }
    case 'status': {
      const openStore =
        dependencies.openCoordinationStore ??
        ((target: CliEnvironment) =>
          // status 是只读操作：只读打开，不做 migration、不创建目录、不产生写入。
          openRepositoryCoordinationStore({ repositoryPath: target.cwd, env: target.env, readOnly: true }));
      return await runStatus({
        openStore: () => openStore(environment),
        json: invocation.json,
        io,
      });
    }
    case 'help':
      io.writeStdout(`${USAGE}\n`);
      return 0;
    case 'version':
      io.writeStdout('0.0.0\n');
      return 0;
    case 'rejected':
      io.writeStderr(renderRejection(invocation));
      return 2;
    case 'tui': {
      const tuiEnvironment: TuiEntryEnvironment = {
        cwd: invocation.repositoryPath ?? environment.cwd,
        env: environment.env,
        stdinIsTty: environment.stdinIsTty === true,
        stdoutIsTty: environment.stdoutIsTty === true,
        columns: environment.columns ?? 80,
      };
      if (dependencies.runTui !== undefined) {
        return await dependencies.runTui(tuiEnvironment, io);
      }
      return await runTuiEntry(tuiEnvironment, io);
    }
  }
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
    stdinIsTty: process.stdin.isTTY === true,
    stdoutIsTty: process.stdout.isTTY === true,
    columns: process.stdout.columns ?? 80,
  });
}
