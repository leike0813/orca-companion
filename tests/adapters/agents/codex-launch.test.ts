import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'vitest';

import {
  CODEX_UTILITY_PERMISSION_PROFILE,
  CODEX_UTILITY_PROFILE_CONFIG_TOML,
  createCodexWorkerLaunch,
  installCodexSessionStartReporter,
} from '../../../src/adapters/agents/codex-launch.js';

const roots: string[] = [];

test('SessionStart reporter 可执行并写出完整的一行身份报告', () => {
  const root = mkdtempSync(join(tmpdir(), 'companion-codex-reporter-'));
  roots.push(root);
  const reporterPath = join(root, 'reporter.mjs');
  const reportPath = join(root, 'report.jsonl');
  installCodexSessionStartReporter({ reporterPath, reportPath });
  const event = { session_id: 'session-1', transcript_path: '/tmp/session-1.jsonl', cwd: '/tmp/worktree' };
  const stdout = execFileSync(process.execPath, [reporterPath], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    env: { ...process.env, CODEX_HOME: '/tmp/codex-home' },
  });
  expect(JSON.parse(stdout)).toEqual({});
  const report = JSON.parse(readFileSync(reportPath, 'utf8').trim()) as Record<string, unknown>;
  expect(report).toMatchObject({
    sessionId: event.session_id,
    transcriptPath: event.transcript_path,
    codexHome: '/tmp/codex-home',
    cwd: event.cwd,
  });
  expect(Number.isFinite(Date.parse(String(report['observedAt'])))).toBe(true);
});

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
  // 只读语义由 profile 保证；Landlock 不是只读的退路，启动参数不再带它。
  expect(prepared.command).not.toContain('use_legacy_landlock');
  expect(prepared.command).not.toContain('--sandbox read-only');
  expect(profile).toBe(CODEX_UTILITY_PROFILE_CONFIG_TOML);
  expect(profile).toContain('extends = ":read-only"');
  expect(profile).toContain('[permissions.utility-readonly-local-control.network]');
  expect(profile).toContain('enabled = true');
});

test('来源配置的 legacy sandbox 键与只读 profile 混用时启动失败关闭', () => {
  const root = mkdtempSync(join(tmpdir(), 'companion-codex-utility-conflict-'));
  roots.push(root);
  const sourceHome = join(root, 'source-codex-home');
  const worktree = join(root, 'worktree');
  mkdirSync(sourceHome, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(sourceHome, 'config.toml'), 'sandbox_mode = "workspace-write"\n', 'utf8');

  const strategy = createCodexWorkerLaunch({
    launchId: 'utility:attempt-conflict',
    model: 'minimax-cn/MiniMax-M3',
    sandboxMode: 'read-only-local-control',
    sourceCodexHome: sourceHome,
  });

  expect(() => strategy.prepare({ worktreePath: worktree })).toThrow(/legacy sandbox/u);
});

test('只读 Finalizer 的状态根与 reporter 留在 canonical worktree 之外', async () => {
  const root = mkdtempSync(join(tmpdir(), 'companion-codex-finalizer-launch-'));
  roots.push(root);
  const sourceHome = join(root, 'source-codex-home');
  const worktree = join(root, 'worktree');
  const privateState = join(root, 'git-common-dir', 'companion');
  mkdirSync(sourceHome, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(sourceHome, 'config.toml'), 'model = "minimax-cn/MiniMax-M3"\n', 'utf8');
  const reporter = join(privateState, 'session-start.mjs');
  mkdirSync(privateState, { recursive: true });
  writeFileSync(reporter, '', 'utf8');

  const strategy = createCodexWorkerLaunch({
    launchId: 'finalizer:delivery-1',
    model: 'minimax-cn/MiniMax-M3',
    sandboxMode: 'read-only',
    sourceCodexHome: sourceHome,
    sessionStartReporterPath: reporter,
    stateRoot: privateState,
  });
  const prepared = await strategy.prepare({ worktreePath: worktree });

  expect(prepared.stateRoot.startsWith(privateState)).toBe(true);
  expect(prepared.command).toContain('--sandbox read-only');
  expect(readFileSync(join(prepared.stateRoot, 'hooks.json'), 'utf8')).toContain(reporter);
  // 只读检查的工作区里不得出现任何 Companion 状态：否则前后工作区比较会把自己的状态当成变化。
  expect(existsSync(join(worktree, '.companion'))).toBe(false);
});

test('状态根必须是绝对路径', () => {
  const strategy = createCodexWorkerLaunch({
    launchId: 'finalizer:delivery-1',
    model: 'minimax-cn/MiniMax-M3',
    sandboxMode: 'read-only',
    stateRoot: './relative-companion',
  });
  expect(() => strategy.prepare({ worktreePath: '/tmp/worktree' })).toThrow(/绝对路径/u);
});
