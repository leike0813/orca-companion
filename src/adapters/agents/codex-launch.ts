import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { PreparedTerminalStrategy } from '../../application/worker-launch.js';
import {
  assertLaunchableModelConfiguration,
  buildCodexModelLaunchDescriptor,
  codexModelLaunchCommand,
  writeCodexModelLaunch,
} from './codex-model-launcher.js';
import type { CredentialStore } from '../../application/ports/credential-store.js';
import type { WorkerModelConfiguration } from '../../domain/model-configuration.js';

export const CODEX_HOOK_TRUST_BYPASS_ARG = '--dangerously-bypass-hook-trust';
export const CODEX_UTILITY_PERMISSION_PROFILE = 'utility-readonly-local-control';

/**
 * Capsule Utility Worker 与只读 Finalizer 共用的唯一权限 profile 正文。
 *
 * 权限事实只能有一份：能力探针与生产启动必须生成同一段文本、同一个启动参数，否则「探针通过」就不再
 * 说明真实会话能不能跑。文件系统继承 `:read-only`，网络只为本机 Orca 控制通道开启。
 */
export const CODEX_UTILITY_PROFILE_CONFIG_TOML = [
  `default_permissions = ${JSON.stringify(CODEX_UTILITY_PERMISSION_PROFILE)}`,
  '',
  `[permissions.${CODEX_UTILITY_PERMISSION_PROFILE}]`,
  'extends = ":read-only"',
  '',
  `[permissions.${CODEX_UTILITY_PERMISSION_PROFILE}.network]`,
  'enabled = true',
  '',
].join('\n');

/** Codex 按 `$CODEX_HOME/<name>.config.toml` 分层加载 profile，因此文件名也是共享事实。 */
export const CODEX_UTILITY_PROFILE_CONFIG_FILE = `${CODEX_UTILITY_PERMISSION_PROFILE}.config.toml`;

/** 只读 profile 的启动参数；不含任何沙箱后端开关：文件系统受限策略由 Codex 自己选择可用实现。 */
export const CODEX_UTILITY_PROFILE_ARGS: readonly string[] = ['--profile', CODEX_UTILITY_PERMISSION_PROFILE];

/**
 * 来源配置里的 legacy sandbox 键会覆盖 permission profile 的只读声明，两者不能混用：混用时启动失败
 * 关闭，绝不静默退回更宽的沙箱。
 */
export function assertUtilityProfileConfigCompatible(sourceConfigText: string): void {
  if (
    /^\s*sandbox_mode\s*=/mu.test(sourceConfigText) ||
    /^\s*\[sandbox_workspace_write\]\s*$/mu.test(sourceConfigText)
  ) {
    throw new Error('Utility read-only permission profile 不能与来源配置的 legacy sandbox 设置混用');
  }
}

export type PreparedCodexTerminal = {
  readonly title: string;
  readonly command: string;
  readonly stateRoot: string;
};

/** 安装由宿主控制的 SessionStart reporter；报告仍须经 transcript proof 核验。 */
export function installCodexSessionStartReporter(paths: { readonly reporterPath: string; readonly reportPath: string }): void {
  mkdirSync(join(paths.reporterPath, '..'), { recursive: true });
  const source = [
      "import { appendFileSync } from 'node:fs';",
      "let input = '';",
      'for await (const chunk of process.stdin) input += chunk;',
      'const event = JSON.parse(input);',
      `appendFileSync(${JSON.stringify(paths.reportPath)}, JSON.stringify({`,
      'sessionId: event.session_id ?? null, transcriptPath: event.transcript_path ?? null,',
      'codexHome: process.env.CODEX_HOME ?? null, cwd: event.cwd ?? null,',
      'observedAt: new Date().toISOString() }) + "\\n");',
      'process.stdout.write("{}\\n");',
    ].join('\n');
  if (!existsSync(paths.reporterPath) || readFileSync(paths.reporterPath, 'utf8') !== source) {
    writeFileSync(paths.reporterPath, source, 'utf8');
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function assertInsideWorktree(worktreePath: string, candidate: string): void {
  const child = relative(resolve(worktreePath), resolve(candidate));
  if (child.length === 0 || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`Codex 状态根必须位于 Worker worktree 内：${candidate}`);
  }
}

/** Codex harness 的固定 prepared-terminal 策略；调用方不能注入任意 env、argv 或 command。 */
/**
 * 写出 SessionStart hook。Codex 只从 CODEX_HOME/hooks.json 读取 hook，因此准备与 resume 共用同一份正文；
 * reporter 路径必须由可信宿主提供且为绝对路径，hook 用宿主自己的 node 绝对路径，不假设 PATH。
 */
export function writeCodexSessionStartHook(input: {
  readonly codexHome: string;
  readonly reporterPath: string;
}): void {
  if (!isAbsolute(input.reporterPath)) {
    throw new Error('SessionStart reporter 必须是绝对路径：' + input.reporterPath);
  }
  writeFileSync(
    join(input.codexHome, 'hooks.json'),
    JSON.stringify({
      hooks: {
        SessionStart: [{
          // matcher 是对 SessionStart 事件 source 的正则：只覆盖 launch 与 resume 两种来源。
          matcher: 'startup|resume',
          hooks: [{
            type: 'command',
            command: shellQuote(process.execPath) + ' ' + shellQuote(input.reporterPath),
            timeout: 10,
          }],
        }],
      },
    }),
    'utf8',
  );
}

export function createCodexWorkerLaunch(input: {
  readonly launchId: string;
  /**
   * 已批准 Manifest 绑定的不可变模型配置。必填：启动只认这一份绑定，不再有绕过绑定的
   * 纯 model 字符串路径。
   */
  readonly modelConfiguration: Readonly<WorkerModelConfiguration>;
  /**
   * 宿主（Bootstrap）注入的用户级凭据 store。必填：adapter 不按路径另建实例，否则「刚保存的 key
   * 在启动路径读不到」只在运行期暴露。它只在准备阶段证明 managed key 存在，不参与 secret 传递。
   */
  readonly credentialStore: CredentialStore;
  /** 写入 descriptor 供 launcher 运行时读取的凭据文件位置；省略时按 XDG 推导。 */
  readonly credentialStorePath?: string;
  /** 测试可指向 fake codex 可执行文件。 */
  readonly codexExecutable?: string;
  readonly sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access' | 'read-only-local-control';
  readonly sourceCodexHome?: string;
  /**
   * Adapter 自己安装的 SessionStart reporter；由可信宿主提供的绝对路径。
   *
   * 隔离 worktree 里的 Worker 把 reporter 放在自己的 worktree 内；只读 Finalizer 在 canonical
   * worktree 中运行，它的 reporter 与状态根都必须落在 Git common dir 的 Companion 私有目录，否则会
   * 污染被只读检查的工作区。
   */
  readonly sessionStartReporterPath?: string;
  /**
   * 状态根的父目录；省略时放在 Worker worktree 内的 `.companion/codex/`。
   *
   * Finalizer 必须显式给出 Git common dir 下的 Companion 私有目录：它要在 canonical worktree 中
   * 只读检查项目，任何写进该 worktree 的状态文件都会同时污染工作区观察与只读约束。
   */
  readonly stateRoot?: string;
}): PreparedTerminalStrategy<PreparedCodexTerminal> {
  if (input.launchId.length === 0) {
    throw new Error('Codex launchId 必须是非空字符串');
  }
  const digest = createHash('sha256').update(input.launchId).digest('hex').slice(0, 20);
  const title = `orca-companion:codex:${digest}`;
  return {
    kind: 'prepared_terminal',
    harness: 'codex',
    activation: 'submit_draft',
    title,
    prepare: ({ worktreePath }) => {
      if (!isAbsolute(worktreePath)) {
        throw new Error(`Codex Worker worktree 必须是绝对路径：${worktreePath}`);
      }
      if (input.stateRoot !== undefined && !isAbsolute(input.stateRoot)) {
        throw new Error(`Codex 状态根必须是绝对路径：${input.stateRoot}`);
      }
      const stateRoot =
        input.stateRoot === undefined
          ? join(worktreePath, '.companion', 'codex', digest)
          : join(input.stateRoot, digest);
      if (input.stateRoot === undefined) {
        assertInsideWorktree(worktreePath, stateRoot);
      }
      // 模型配置门禁同样在写盘之前：秘密字段、非法 effort、越界保留键与不可编码选项都在这里被拒。
      assertLaunchableModelConfiguration(input.modelConfiguration);
      // 早期 fail closed 发生在任何写盘之前：缺凭据的 managed 启动不留状态目录，也不产出 descriptor。
      const managedCredential =
        input.modelConfiguration.connection.credential.kind === 'managed'
          ? input.modelConfiguration.connection.credential
          : null;
      if (managedCredential !== null) {
        // store 必须由宿主注入：缺失即拒绝，绝不按路径另建实例或跳过校验，调用方在写盘前 fail closed。
        if (input.credentialStore === undefined) {
          throw new Error('Codex managed 凭据启动必须由 Bootstrap 注入 CredentialStore');
        }
        const read = input.credentialStore.read(managedCredential.credentialRef);
        if (read.kind !== 'resolved') {
          throw new Error('Codex managed 凭据不可用：' + read.code);
        }
      }
      mkdirSync(stateRoot, { recursive: true });

      const sourceHome = resolve(input.sourceCodexHome ?? process.env['CODEX_HOME'] ?? join(homedir(), '.codex'));
      const sourceConfig = join(sourceHome, 'config.toml');
      const config = join(stateRoot, 'config.toml');
      let sourceConfigText = '';
      if (existsSync(sourceConfig)) {
        copyFileSync(sourceConfig, config);
        sourceConfigText = readFileSync(sourceConfig, 'utf8');
      } else {
        writeFileSync(config, '', 'utf8');
      }
      writeFileSync(
        config,
        `\n[projects.${JSON.stringify(resolve(worktreePath))}]\ntrust_level = "trusted"\n`,
        { encoding: 'utf8', flag: 'a' },
      );

      const sourceAuth = join(sourceHome, 'auth.json');
      const auth = join(stateRoot, 'auth.json');
      // managed 凭据只用自定义 provider 的 env_key，绝不链接 auth.json，否则既有 Harness 认证会
      // 抢在 env_key 之前生效（D06）。harness_login 与旧的直连路径保留原 auth.json 绑定。
      if (managedCredential === null && existsSync(sourceAuth)) {
        if (existsSync(auth)) {
          if (readlinkSync(auth) !== sourceAuth) {
            throw new Error(`隔离 Codex auth 链接指向意外位置：${auth}`);
          }
        } else {
          symlinkSync(sourceAuth, auth);
        }
      }

      if (input.sessionStartReporterPath !== undefined) {
        // reporter 路径只由可信宿主提供（模型与 Worker 都填不了它），因此不要求它位于 worktree 内。
        writeCodexSessionStartHook({ codexHome: stateRoot, reporterPath: input.sessionStartReporterPath });
      }

      const sandboxArguments = input.sandboxMode === 'read-only-local-control'
        ? (() => {
            assertUtilityProfileConfigCompatible(sourceConfigText);
            writeFileSync(join(stateRoot, CODEX_UTILITY_PROFILE_CONFIG_FILE), CODEX_UTILITY_PROFILE_CONFIG_TOML, 'utf8');
            return [...CODEX_UTILITY_PROFILE_ARGS];
          })()
        : ['--sandbox', input.sandboxMode];

      const descriptor = buildCodexModelLaunchDescriptor({
        modelConfiguration: input.modelConfiguration,
        codexHome: stateRoot,
        baseArguments: [CODEX_HOOK_TRUST_BYPASS_ARG, '--no-alt-screen', '--ask-for-approval', 'never'],
        sandboxArguments,
        ...(input.credentialStorePath === undefined ? {} : { credentialStorePath: input.credentialStorePath }),
        ...(input.codexExecutable === undefined ? {} : { executable: input.codexExecutable }),
      });
      const { descriptorPath, launcherPath } = writeCodexModelLaunch({ codexHome: stateRoot, descriptor });
      return Promise.resolve({ title, stateRoot, command: codexModelLaunchCommand({ launcherPath, descriptorPath }) });
    },
  };
}

/**
 * 复用原 session 的 Codex 启动策略：`codex resume <uuid>`。
 *
 * 只在原 terminal 已确认退出、且拿到原 CODEX_HOME 与精确 provider session UUID 时使用。它不安装新的
 * SessionStart reporter、不改写原 config/auth，也不另建状态根：resume 必须读到原 session。缺少任一
 * 事实都由调用方阻塞，绝不用 `--last`、最近 transcript 或按 cwd/mtime 猜一个 session。
 */
export function createCodexResumeLaunch(input: {
  readonly launchId: string;
  readonly modelConfiguration: Readonly<WorkerModelConfiguration>;
  /** 原 session 的精确身份；形态非法时 descriptor 生成阶段直接拒绝。 */
  readonly sessionId: string;
  /** 原 session 的 CODEX_HOME；必须是可信装配给出的绝对路径。 */
  readonly codexHome: string;
  /**
   * 宿主（Bootstrap）注入的用户级凭据 store。必填：adapter 不按路径另建实例；resume 同样只在准备
   * 阶段证明 managed key 存在，不参与 secret 传递。
   */
  readonly credentialStore: CredentialStore;
  readonly credentialStorePath?: string;
  readonly codexExecutable?: string;
  readonly sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access' | 'read-only-local-control';
  /**
   * resume 时安装的 SessionStart reporter 绝对路径。
   *
   * 必须给出：只有 resume 会话自己上报 WorkerTask/Dispatch/cwd/UUID，才能证明「新的续接 Dispatch 确实
   * 恢复了原 provider session」。报告与 reporter 由可信宿主放在 Companion 私有目录，不在原 CODEX_HOME。
   */
  readonly sessionStartReporterPath?: string;
}): PreparedTerminalStrategy<PreparedCodexTerminal> {
  if (input.launchId.length === 0) {
    throw new Error('Codex launchId 必须是非空字符串');
  }
  if (!isAbsolute(input.codexHome)) {
    throw new Error(`Codex resume 的 CODEX_HOME 必须是绝对路径：${input.codexHome}`);
  }
  const digest = createHash('sha256').update(input.launchId).digest('hex').slice(0, 20);
  const title = `orca-companion:codex-resume:${digest}`;
  return {
    kind: 'prepared_terminal',
    harness: 'codex',
    activation: 'submit_draft',
    title,
    prepare: ({ worktreePath }) => {
      if (!isAbsolute(worktreePath)) {
        throw new Error(`Codex Worker worktree 必须是绝对路径：${worktreePath}`);
      }
      assertLaunchableModelConfiguration(input.modelConfiguration);
      const managedCredential =
        input.modelConfiguration.connection.credential.kind === 'managed'
          ? input.modelConfiguration.connection.credential
          : null;
      if (managedCredential !== null) {
        if (input.credentialStore === undefined) {
          throw new Error('Codex managed 凭据 resume 必须由 Bootstrap 注入 CredentialStore');
        }
        const read = input.credentialStore.read(managedCredential.credentialRef);
        if (read.kind !== 'resolved') {
          throw new Error('Codex managed 凭据不可用：' + read.code);
        }
      }
      // 复用原 CODEX_HOME：resume 必须读到原 session 与既有 config/auth，不能另建状态根。
      mkdirSync(input.codexHome, { recursive: true });
      if (input.sessionStartReporterPath !== undefined) {
        writeCodexSessionStartHook({ codexHome: input.codexHome, reporterPath: input.sessionStartReporterPath });
      }
      const sandboxArguments = input.sandboxMode === 'read-only-local-control'
        ? (() => {
            const sourceConfig = join(input.codexHome, 'config.toml');
            const sourceConfigText = existsSync(sourceConfig) ? readFileSync(sourceConfig, 'utf8') : '';
            assertUtilityProfileConfigCompatible(sourceConfigText);
            writeFileSync(join(input.codexHome, CODEX_UTILITY_PROFILE_CONFIG_FILE), CODEX_UTILITY_PROFILE_CONFIG_TOML, 'utf8');
            return [...CODEX_UTILITY_PROFILE_ARGS];
          })()
        : ['--sandbox', input.sandboxMode];

      const descriptor = buildCodexModelLaunchDescriptor({
        modelConfiguration: input.modelConfiguration,
        codexHome: input.codexHome,
        baseArguments: [CODEX_HOOK_TRUST_BYPASS_ARG, '--no-daemon', '--no-alt-screen', '--ask-for-approval', 'never'],
        sandboxArguments,
        resumeSessionId: input.sessionId,
        ...(input.credentialStorePath === undefined ? {} : { credentialStorePath: input.credentialStorePath }),
        ...(input.codexExecutable === undefined ? {} : { executable: input.codexExecutable }),
      });
      const { descriptorPath, launcherPath } = writeCodexModelLaunch({ codexHome: input.codexHome, descriptor });
      return Promise.resolve({
        title,
        stateRoot: input.codexHome,
        command: codexModelLaunchCommand({ launcherPath, descriptorPath }),
      });
    },
  };
}
