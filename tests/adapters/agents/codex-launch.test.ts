import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'vitest';

import {
  CODEX_UTILITY_PERMISSION_PROFILE,
  createCodexWorkerLaunch,
} from '../../../src/adapters/agents/codex-launch.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Codex prepared-terminal 只写 worktree 内隔离状态，并固定 trust bypass', async () => {
  const root = mkdtempSync(join(tmpdir(), 'companion-codex-launch-'));
  roots.push(root);
  const sourceHome = join(root, 'source-codex-home');
  const worktree = join(root, 'worktree');
  const sourceConfig = 'model = "minimax-cn/MiniMax-M3"\n';
  mkdirSync(sourceHome, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(sourceHome, 'config.toml'), sourceConfig, 'utf8');
  writeFileSync(join(sourceHome, 'auth.json'), '{"test":true}\n', 'utf8');
  const reporter = join(worktree, '.companion', 'session-start.mjs');
  mkdirSync(join(worktree, '.companion'), { recursive: true });
  writeFileSync(reporter, '', 'utf8');

  const strategy = createCodexWorkerLaunch({
    launchId: 'validator:attempt-1',
    model: 'minimax-cn/MiniMax-M3',
    sandboxMode: 'workspace-write',
    sourceCodexHome: sourceHome,
    sessionStartReporterPath: reporter,
  });
  const prepared = await strategy.prepare({ worktreePath: worktree });

  expect(strategy.kind).toBe('prepared_terminal');
  expect(prepared.title).toMatch(/^orca-companion:codex:/);
  expect(prepared.command).toContain('--dangerously-bypass-hook-trust');
  expect(prepared.command).toContain('--ask-for-approval never --sandbox workspace-write');
  expect(prepared.command).toContain('CODEX_HOME=');
  expect(readFileSync(join(sourceHome, 'config.toml'), 'utf8')).toBe(sourceConfig);
  expect(readFileSync(join(prepared.stateRoot, 'config.toml'), 'utf8')).toContain(
    `[projects.${JSON.stringify(worktree)}]`,
  );
  expect(existsSync(join(prepared.stateRoot, 'auth.json'))).toBe(true);
  expect(readlinkSync(join(prepared.stateRoot, 'auth.json'))).toBe(join(sourceHome, 'auth.json'));
  expect(readFileSync(join(prepared.stateRoot, 'hooks.json'), 'utf8')).toContain(reporter);
});

test('Utility Codex 使用只读文件系统与本机控制通道 profile', async () => {
  const root = mkdtempSync(join(tmpdir(), 'companion-codex-utility-launch-'));
  roots.push(root);
  const sourceHome = join(root, 'source-codex-home');
  const worktree = join(root, 'worktree');
  mkdirSync(sourceHome, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(sourceHome, 'config.toml'), 'model = "minimax-cn/MiniMax-M3"\n', 'utf8');

  const strategy = createCodexWorkerLaunch({
    launchId: 'utility:attempt-1',
    model: 'minimax-cn/MiniMax-M3',
    sandboxMode: 'read-only-local-control',
    sourceCodexHome: sourceHome,
  });
  const prepared = await strategy.prepare({ worktreePath: worktree });
  const profile = readFileSync(
    join(prepared.stateRoot, `${CODEX_UTILITY_PERMISSION_PROFILE}.config.toml`),
    'utf8',
  );

  expect(prepared.command).toContain(`--profile ${CODEX_UTILITY_PERMISSION_PROFILE}`);
  expect(prepared.command).toContain('--enable use_legacy_landlock');
  expect(prepared.command).not.toContain('--sandbox read-only');
  expect(profile).toContain('extends = ":read-only"');
  expect(profile).toContain('[permissions.utility-readonly-local-control.network]');
  expect(profile).toContain('enabled = true');
});
