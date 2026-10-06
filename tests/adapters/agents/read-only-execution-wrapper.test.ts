/**
 * IP-09 的行为测试：跨 harness 只读包装器与真实能力探针。
 *
 * 探针的价值是「只读边界由**生产 launcher + 生产 descriptor** 下的真实受限命令证明」，因此这里核对
 * 两件事：argv 只由唯一工厂生成（含 launcher 内嵌源码与工厂同源），以及探针真的按四项证据分类——
 * 宿主可写、受限命令读得到、仓库/Git/sibling coordination.sqlite 写入被拒且状态根可写、宿主回读未变。
 * 探针发出的命令是生产公开 launcher 命令，payload 依次为哨兵与 `harness --version`。
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

import { expect, test } from 'vitest';

import {
  READ_ONLY_EXECUTION_WRAPPER_SOURCE,
  assertReadOnlyExecutionWrapperAvailable,
  describeHarnessReadOnlyCapability,
  probeHarnessReadOnlyWorker,
  probeReadOnlyExecution,
  readOnlyExecutionArguments,
  type ReadOnlyExecutionInput,
} from '../../../src/adapters/agents/read-only-execution-wrapper.js';
import {
  CODEX_MODEL_DESCRIPTOR_FILENAME,
  CODEX_MODEL_LAUNCHER_FILENAME,
  codexModelLaunchCommand,
} from '../../../src/adapters/agents/codex-model-launcher.js';
import { modelConfigurationFixture } from '../../support/model-configurations.js';
import type { WorkerModelConfiguration } from '../../../src/domain/model-configuration.js';
import type {
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
} from '../../../src/adapters/orca-cli/process-runner.js';

function completed(exitCode: number, stdout = '', stderr = ''): ProcessResult {
  return {
    kind: 'completed',
    exitCode,
    stdout: { text: stdout, truncated: false },
    stderr: { text: stderr, truncated: false },
  };
}

const SAMPLE: ReadOnlyExecutionInput = {
  workspace: '/work/ws',
  stateRoot: '/work/private/state',
  executable: '/usr/bin/node',
  args: ['-e', 'run()'],
};

test('只读 argv 只由唯一工厂生成，且顺序把状态根绑在 tmpfs 之后', () => {
  expect(readOnlyExecutionArguments(SAMPLE)).toEqual([
    '--die-with-parent',
    '--new-session',
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    '--bind', '/work/private/state', '/work/private/state',
    '--chdir', '/work/ws',
    '--', '/usr/bin/node', '-e', 'run()',
  ]);
  // reporter 目录在状态根之外时给一个精确的第二挂载点，且不放开它的 sibling。
  const withReporter = readOnlyExecutionArguments({ ...SAMPLE, reportDirectory: '/work/private/reporters' });
  expect(withReporter.join(' ')).toContain('--bind /work/private/reporters /work/private/reporters');
  expect(withReporter).not.toEqual(readOnlyExecutionArguments(SAMPLE));
});

test('workspace 落在 /tmp 或 /run 之下时放弃对应 tmpfs，保住路径可见', () => {
  const underTmp = readOnlyExecutionArguments({ ...SAMPLE, workspace: '/tmp/project/ws' });
  expect(underTmp.join(' ')).not.toContain('--tmpfs /tmp');
  expect(underTmp.join(' ')).not.toContain('--tmpfs /run');

  const underRun = readOnlyExecutionArguments({ ...SAMPLE, stateRoot: '/run/user/1000/state' });
  expect(underRun.join(' ')).not.toContain('--tmpfs /run');
  expect(underRun.join(' ')).toContain('--tmpfs /tmp');

  const both = readOnlyExecutionArguments({ ...SAMPLE, workspace: '/tmp/a', reportDirectory: '/run/user/1/r' });
  expect(both.join(' ')).not.toContain('--tmpfs');
});

test('launcher 内嵌源码与工厂同源：求值后逐字等价', () => {
  const embedded = runInNewContext(
    `${READ_ONLY_EXECUTION_WRAPPER_SOURCE}\nreadOnlyExecutionArguments`,
  ) as (input: ReadOnlyExecutionInput) => readonly string[];

  expect(embedded(SAMPLE)).toEqual(readOnlyExecutionArguments(SAMPLE));
  expect(embedded({ ...SAMPLE, reportDirectory: '/work/private/reporters' })).toEqual(
    readOnlyExecutionArguments({ ...SAMPLE, reportDirectory: '/work/private/reporters' }),
  );
});

type Descriptor = {
  readonly version: number;
  readonly codexHome: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly credential: { readonly kind: string };
  readonly environment?: Readonly<Record<string, string>>;
  readonly readOnly?: { readonly workspace: string; readonly stateRoot: string; readonly reportDirectory?: string };
};

/** 探针发出的命令就是生产公开 launcher 命令：node <launcher> <descriptor>。 */
function descriptorOf(request: ProcessRequest): { readonly launcherPath: string; readonly descriptorPath: string; readonly descriptor: Descriptor } {
  const [launcherPath, descriptorPath] = request.args;
  if (launcherPath === undefined || descriptorPath === undefined) {
    throw new Error('探针没有按公开 launcher 命令发出两个路径参数');
  }
  return { launcherPath, descriptorPath, descriptor: JSON.parse(readFileSync(descriptorPath, 'utf8')) as Descriptor };
}

/** 哨兵运行的四个路径在 descriptor.args 末尾；与生产 descriptor 的字段顺序一致。 */
function sentinelPathsOf(descriptor: Descriptor): { readonly sentinel: string; readonly stateFile: string } {
  const tail = descriptor.args.slice(-4);
  if (tail.length !== 4) {
    throw new Error('哨兵 payload 没有收到四个路径');
  }
  const [sentinel, , , stateFile] = tail as [string, string, string, string];
  return { sentinel, stateFile };
}

type FakeLauncher = {
  readonly runner: ProcessRunner;
  readonly requests: ProcessRequest[];
  readonly descriptors: Descriptor[];
  /** 运行当时读到的 launcher 脚本正文；临时目录在探针收尾后会被清理，必须当场记下。 */
  readonly launcherSources: string[];
};

/** fake 生产 launcher：读真实 descriptor，按 payload 是哨兵还是 harness 给出结果。 */
function fakeLauncher(
  overrides: Partial<Record<'workspace' | 'coordination' | 'git' | 'stateRoot', string>> = {},
): FakeLauncher {
  const requests: ProcessRequest[] = [];
  const descriptors: Descriptor[] = [];
  const launcherSources: string[] = [];
  return {
    requests,
    descriptors,
    launcherSources,
    runner: (request) => {
      requests.push(request);
      const { launcherPath, descriptor } = descriptorOf(request);
      descriptors.push(descriptor);
      if (launcherSources.length === 0) {
        launcherSources.push(readFileSync(launcherPath, 'utf8'));
      }
      if (descriptor.executable !== process.execPath) {
        return Promise.resolve(completed(0, `${descriptor.executable} 2.1.289\n`));
      }
      const { sentinel, stateFile } = sentinelPathsOf(descriptor);
      const outcome = {
        sentinel: readFileSync(sentinel, 'utf8').trim(),
        workspace: overrides.workspace ?? 'EROFS',
        coordination: overrides.coordination ?? 'EROFS',
        git: overrides.git ?? 'EROFS',
        stateRoot: overrides.stateRoot ?? 'allowed',
      };
      if (outcome.stateRoot === 'allowed') {
        writeFileSync(stateFile, '{}\n', 'utf8');
      }
      return Promise.resolve(completed(0, JSON.stringify(outcome)));
    },
  };
}

test('探针经生产 launcher + 生产 descriptor 运行，四项证据齐全时结论为可用', async () => {
  const launcher = fakeLauncher();

  const result = await probeReadOnlyExecution({ env: { PATH: '/usr/bin' }, runner: launcher.runner, timeoutMs: 5_000 });

  expect(result.kind).toBe('available');
  expect(result.stage).toBe('host-verify');
  expect(result.profile).toBe('bwrap-read-only');

  // 命令就是生产公开 launcher 命令。
  const request = launcher.requests[0];
  expect(request?.executable).toBe(process.execPath);
  const [launcherPath, descriptorPath] = (request?.args ?? []) as [string, string];
  const descriptor = launcher.descriptors[0]!;
  expect([request?.executable, ...(request?.args ?? [])]).toEqual([
    process.execPath,
    launcherPath,
    descriptorPath,
  ]);
  expect(launcherPath).toBe(join(descriptor.codexHome, CODEX_MODEL_LAUNCHER_FILENAME));
  expect(descriptorPath).toBe(join(descriptor.codexHome, CODEX_MODEL_DESCRIPTOR_FILENAME));
  expect(codexModelLaunchCommand({ launcherPath, descriptorPath, nodeExecutable: process.execPath })).toContain(launcherPath);

  // descriptor 与生产同 shape：readOnly 原字段、harness_login（不读 key）、隔离环境。
  expect(typeof descriptor.readOnly?.workspace).toBe('string');
  expect(descriptor.readOnly?.stateRoot).toBe(descriptor.codexHome);
  expect(descriptor.credential).toEqual({ kind: 'harness_login' });
  expect(descriptor.environment?.['HOME']).toBe(descriptor.readOnly?.stateRoot);
  expect(JSON.stringify(descriptor)).not.toContain('credentialRef');

  // launcher 脚本内嵌的包装器源码与工厂同源（SSOT）：同一段 argv 逻辑。
  expect(launcher.launcherSources[0]).toContain(READ_ONLY_EXECUTION_WRAPPER_SOURCE.trim());
});

test('仓库文件写入竟然成功时立即判为不可用', async () => {
  const result = await probeReadOnlyExecution({
    env: { PATH: '/usr/bin' },
    runner: fakeLauncher({ workspace: 'allowed' }).runner,
    timeoutMs: 5_000,
  });

  expect(result.kind).toBe('unavailable');
  expect(result.stage).toBe('sandbox-write');
  expect(result.diagnostics.join(' ')).toContain('只读边界未被强制');
});

test.each(['coordination', 'git'] as const)('sibling %s 写入未被拒绝时判为不可用', async (target) => {
  const result = await probeReadOnlyExecution({
    env: { PATH: '/usr/bin' },
    runner: fakeLauncher({ [target]: 'allowed' }).runner,
    timeoutMs: 5_000,
  });

  expect(result.kind).toBe('unavailable');
  expect(result.stage).toBe('sandbox-write');
});

test('精确状态根写不进去时判为不可用，不给「只读可用」的假结论', async () => {
  const result = await probeReadOnlyExecution({
    env: { PATH: '/usr/bin' },
    runner: fakeLauncher({ stateRoot: 'EROFS' }).runner,
    timeoutMs: 5_000,
  });

  expect(result.kind).toBe('unavailable');
  expect(result.stage).toBe('sandbox-write');
  expect(result.diagnostics.join(' ')).toContain('精确状态根');
});

test('受限命令超时或 launcher 启动失败时不得报告可用', async () => {
  const timeout: ProcessRunner = () =>
    Promise.resolve({ kind: 'unknown', reason: 'timeout', stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } });
  const timedOut = await probeReadOnlyExecution({ env: { PATH: '/usr/bin' }, runner: timeout, timeoutMs: 5_000 });
  expect(timedOut.kind).toBe('unknown');
  expect(timedOut.stage).toBe('sandbox-read');

  const missing: ProcessRunner = () =>
    Promise.resolve({ kind: 'unavailable', code: 'process_spawn_failed', message: 'spawn node ENOENT' });
  const unavailable = await probeReadOnlyExecution({ env: { PATH: '/usr/bin' }, runner: missing, timeoutMs: 5_000 });
  expect(unavailable.kind).toBe('unavailable');
  expect(unavailable.stage).toBe('sandbox-read');
});

/** native 只读角色的绑定：连接声明 claude 原生 provider。 */
function nativeConfiguration(harness: 'claude' | 'opencode' | 'pi' | 'omp' = 'claude'): WorkerModelConfiguration {
  const base = modelConfigurationFixture();
  return {
    ...base,
    connection: { ...base.connection, codex: null, nativeWorker: { harness, providerId: 'minimax' } },
  };
}

test('通用探针按 binding 的 harness 选实现：native 两次都走同一生产 descriptor，codex 走 Codex profile', async () => {
  const launcher = fakeLauncher();
  const nativeResult = await probeHarnessReadOnlyWorker(nativeConfiguration('claude'), {
    env: { PATH: '/usr/bin' },
    runner: launcher.runner,
    timeoutMs: 5_000,
  });
  expect(nativeResult.kind).toBe('available');
  expect(nativeResult.harness).toBe('claude');
  expect(nativeResult.harnessVersion).toBe('2.1.289');
  expect(nativeResult.codexVersion).toBe('2.1.289');
  // 两次运行都是生产 launcher 命令，且共用同一个 descriptor 目录（同一状态根）。
  expect(launcher.descriptors).toHaveLength(2);
  expect(launcher.descriptors[0]?.executable).toBe(process.execPath);
  expect(launcher.descriptors[1]?.executable).toBe('claude');
  expect(launcher.descriptors[1]?.args).toEqual(['--version']);
  expect(launcher.descriptors[0]?.codexHome).toBe(launcher.descriptors[1]?.codexHome);
  expect(launcher.descriptors[1]?.readOnly).toEqual(launcher.descriptors[0]?.readOnly);
  expect(describeHarnessReadOnlyCapability(nativeResult)).toContain('claude');

  const codexResult = await probeHarnessReadOnlyWorker(modelConfigurationFixture(), {
    env: { PATH: '/usr/bin' },
    runner: fakeLauncher().runner,
    timeoutMs: 5_000,
  });
  expect(codexResult.harness).toBe('codex');
});

test('native 连接不合法时按未知处理，不拿 bwrap 结果冒充该 harness 的能力', async () => {
  const base = modelConfigurationFixture();
  const broken: WorkerModelConfiguration = {
    ...base,
    connection: { ...base.connection, codex: null, nativeWorker: { harness: 'claude', providerId: '' } },
  };
  const launcher = fakeLauncher();

  const result = await probeHarnessReadOnlyWorker(broken, {
    env: { PATH: '/usr/bin' },
    runner: launcher.runner,
    timeoutMs: 5_000,
  });

  expect(result.kind).toBe('unknown');
  expect(result.harness).toBeNull();
  expect(launcher.requests).toEqual([]);
});

test('harness 在同一生产 descriptor 下拿不到版本时判为不可用', async () => {
  const requests: ProcessRequest[] = [];
  const runner: ProcessRunner = (request) => {
    requests.push(request);
    const { descriptor } = descriptorOf(request);
    if (descriptor.executable !== process.execPath) {
      return Promise.resolve(completed(1, '', 'no version'));
    }
    const { sentinel, stateFile } = sentinelPathsOf(descriptor);
    writeFileSync(stateFile, '{}\n', 'utf8');
    return Promise.resolve(
      completed(0, JSON.stringify({ sentinel: readFileSync(sentinel, 'utf8').trim(), workspace: 'EROFS', coordination: 'EROFS', git: 'EROFS', stateRoot: 'allowed' })),
    );
  };

  const result = await probeHarnessReadOnlyWorker(nativeConfiguration('claude'), {
    env: { PATH: '/usr/bin' },
    runner,
    timeoutMs: 5_000,
  });

  expect(result.kind).toBe('unavailable');
  expect(result.stage).toBe('codex-version');
  expect(result.harness).toBe('claude');
  expect(result.diagnostics.join(' ')).toContain('生产 descriptor');
});

test('生产前置核验在包装器不可用时抛错，可用时静默通过', async () => {
  await expect(
    assertReadOnlyExecutionWrapperAvailable({ env: { PATH: '/usr/bin' }, runner: fakeLauncher().runner, timeoutMs: 5_000 }),
  ).resolves.toBeUndefined();
  await expect(
    assertReadOnlyExecutionWrapperAvailable({
      env: { PATH: '/usr/bin' },
      runner: fakeLauncher({ workspace: 'allowed' }).runner,
      timeoutMs: 5_000,
    }),
  ).rejects.toThrow(/只读包装器不可用/u);
});

const bwrapUsable = spawnSync('bwrap', ['--version'], { encoding: 'utf8' }).status === 0;

/** 注入的 harness：把参数原样转交给 Node，用来证明包装器能经生产 descriptor 拉起任意可执行文件。 */
function fakeHarness(directory: string): string {
  const path = join(directory, 'claude');
  writeFileSync(path, `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, 'utf8');
  chmodSync(path, 0o755);
  return path;
}

test.skipIf(!bwrapUsable)('真实 bwrap：经生产 launcher/descriptor 的哨兵与注入 harness 都成立', async () => {
  await expect(assertReadOnlyExecutionWrapperAvailable()).resolves.toBeUndefined();
  const bin = mkdtempSync(join(tmpdir(), 'orca-wrapper-bin-'));
  const harness = fakeHarness(bin);

  const result = await probeHarnessReadOnlyWorker(nativeConfiguration('claude'), {
    harnessExecutable: harness,
    env: { PATH: process.env['PATH'] ?? '' },
    timeoutMs: 30_000,
  });

  expect(result.kind).toBe('available');
  expect(result.stage).toBe('host-verify');
  expect(result.harness).toBe('claude');
  expect(result.harnessVersion).not.toBeNull();
  expect(result.diagnostics.filter((line) => line.includes('清理失败'))).toEqual([]);
  // 探针不在项目树里留临时现场。
  expect(existsSync(harness)).toBe(true);
  rmSync(bin, { recursive: true, force: true });
});
