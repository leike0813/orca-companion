import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { PreparedTerminalStrategy } from '../../application/worker-launch.js';

export const CODEX_HOOK_TRUST_BYPASS_ARG = '--dangerously-bypass-hook-trust';
export const CODEX_UTILITY_PERMISSION_PROFILE = 'utility-readonly-local-control';

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
export function createCodexWorkerLaunch(input: {
  readonly launchId: string;
  readonly model: string;
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
  if (input.launchId.length === 0 || input.model.length === 0) {
    throw new Error('Codex launchId 与 model 必须是非空字符串');
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
      if (existsSync(sourceAuth)) {
        if (existsSync(auth)) {
          if (readlinkSync(auth) !== sourceAuth) {
            throw new Error(`隔离 Codex auth 链接指向意外位置：${auth}`);
          }
        } else {
          symlinkSync(sourceAuth, auth);
        }
      }

      if (input.sessionStartReporterPath !== undefined) {
        if (!isAbsolute(input.sessionStartReporterPath)) {
          throw new Error(`SessionStart reporter 必须是绝对路径：${input.sessionStartReporterPath}`);
        }
        // reporter 路径只由可信宿主提供（模型与 Worker 都填不了它），因此不要求它位于 worktree 内：
        // 只读 Finalizer 的 reporter 必须留在 Git common dir 的 Companion 私有目录。
        writeFileSync(
          join(stateRoot, 'hooks.json'),
          JSON.stringify({
            hooks: {
              SessionStart: [{
                matcher: 'startup',
                hooks: [{
                  type: 'command',
                  command: `node ${shellQuote(input.sessionStartReporterPath)}`,
                  timeout: 10,
                }],
              }],
            },
          }),
          'utf8',
        );
      }

      const sandboxArguments = input.sandboxMode === 'read-only-local-control'
        ? (() => {
            if (/^\s*sandbox_mode\s*=/mu.test(sourceConfigText) || /^\s*\[sandbox_workspace_write\]\s*$/mu.test(sourceConfigText)) {
              throw new Error('Utility read-only permission profile 不能与来源配置的 legacy sandbox 设置混用');
            }
            writeFileSync(
              join(stateRoot, `${CODEX_UTILITY_PERMISSION_PROFILE}.config.toml`),
              [
                `default_permissions = ${JSON.stringify(CODEX_UTILITY_PERMISSION_PROFILE)}`,
                '',
                `[permissions.${CODEX_UTILITY_PERMISSION_PROFILE}]`,
                'extends = ":read-only"',
                '',
                `[permissions.${CODEX_UTILITY_PERMISSION_PROFILE}.network]`,
                'enabled = true',
                '',
              ].join('\n'),
              'utf8',
            );
            return ['--profile', CODEX_UTILITY_PERMISSION_PROFILE, '--enable', 'use_legacy_landlock'];
          })()
        : ['--sandbox', input.sandboxMode];

      return Promise.resolve({
        title,
        stateRoot,
        command: [
          'env',
          `CODEX_HOME=${shellQuote(stateRoot)}`,
          'codex',
          CODEX_HOOK_TRUST_BYPASS_ARG,
          '--no-alt-screen',
          '--ask-for-approval',
          'never',
          ...sandboxArguments,
          '--model',
          shellQuote(input.model),
        ].join(' '),
      });
    },
  };
}
