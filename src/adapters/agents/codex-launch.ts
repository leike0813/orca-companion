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
  readonly sandboxMode: 'read-only' | 'workspace-write' | 'read-only-local-control';
  readonly sourceCodexHome?: string;
  /** Adapter 自己安装的 SessionStart reporter；必须位于当前 Worker worktree 内。 */
  readonly sessionStartReporterPath?: string;
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
      const stateRoot = join(worktreePath, '.companion', 'codex', digest);
      assertInsideWorktree(worktreePath, stateRoot);
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
        assertInsideWorktree(worktreePath, input.sessionStartReporterPath);
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
