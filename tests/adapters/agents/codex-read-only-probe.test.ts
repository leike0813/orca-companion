/**
 * IP-01 的行为测试：本机只读 Worker 能力探针（change: `m2-repair-read-only-worker-sandbox`）。
 *
 * 探针的价值是「只读边界由真实受限命令证明」，因此这里用 fake 子进程精确构造四类事实：
 * 受限命令跑不起来（本机现状）、超时或结果不可核验、写入被拒且内容未变（可用）、写入竟然成功
 * （边界失效）。每个用例都核对探针真的按生产同源的 profile 与参数调用 Codex，而不是另造一份权限事实。
 */

import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import {
  CODEX_UTILITY_PROFILE_ARGS,
  CODEX_UTILITY_PROFILE_CONFIG_FILE,
  CODEX_UTILITY_PROFILE_CONFIG_TOML,
} from '../../../src/adapters/agents/codex-launch.js';
import { codexModelArguments } from '../../../src/adapters/agents/codex-model-launcher.js';
import { modelConfigurationFixture } from '../../support/model-configurations.js';
import type { WorkerModelConfiguration } from '../../../src/domain/model-configuration.js';
import {
  describeReadOnlyWorkerCapability,
  probeReadOnlyWorker,
  readOnlyWorkerUnavailableReason,
} from '../../../src/adapters/agents/codex-read-only-probe.js';
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

/** 探针自己写入的哨兵路径：它是 `codex sandbox … -- <cmd> <path>` 的最后一个参数。 */
function sentinelOf(request: ProcessRequest): string {
  const path = request.args.at(-1);
  if (path === undefined) {
    throw new Error('探针没有把哨兵路径作为位置参数传入');
  }
  return path;
}

type FakeCodex = {
  readonly runner: ProcessRunner;
  readonly requests: readonly ProcessRequest[];
  /** 受限调用发生时隔离 CODEX_HOME 里的 profile 正文；探针收尾会删掉临时目录，因此必须当场记下。 */
  readonly profileInCodexHome: { value: string };
  /** 同一时刻隔离 CODEX_HOME 里由来源 HOME 复制来的 `config.toml`；没有来源配置时为空串。 */
  readonly baseConfigInCodexHome: { value: string };
};

/** fake Codex：`--version` 与受限命令分别按用例给出的行为应答，并记录每一次调用供断言。 */
function fakeCodex(input: {
  readonly version?: ProcessResult | undefined;
  readonly read: (request: ProcessRequest, sentinelPath: string) => ProcessResult;
  readonly write: (request: ProcessRequest, sentinelPath: string) => ProcessResult;
}): FakeCodex {
  const requests: ProcessRequest[] = [];
  const profileInCodexHome = { value: '' };
  const baseConfigInCodexHome = { value: '' };
  return {
    requests,
    profileInCodexHome,
    baseConfigInCodexHome,
    runner: (request) => {
      requests.push(request);
      if (request.args.includes('--version')) {
        return Promise.resolve(input.version ?? completed(0, 'codex-cli 0.156.1\n'));
      }
      if (profileInCodexHome.value.length === 0) {
        const codexHome = String(request.env['CODEX_HOME']);
        profileInCodexHome.value = readFileSync(join(codexHome, CODEX_UTILITY_PROFILE_CONFIG_FILE), 'utf8');
        const baseConfig = join(codexHome, 'config.toml');
        baseConfigInCodexHome.value = existsSync(baseConfig) ? readFileSync(baseConfig, 'utf8') : '';
      }
      return Promise.resolve(
        request.args.includes(process.execPath) ? input.write(request, sentinelOf(request)) : input.read(request, sentinelOf(request)),
      );
    },
  };
}

async function probeWith(codex: FakeCodex) {
  return await probeReadOnlyWorker({ env: { PATH: '/usr/bin' }, runner: codex.runner, timeoutMs: 5_000 });
}

/** 写一份来源 Codex HOME；返回它的路径。冲突用例只需其中的 `config.toml`。 */
function sourceHome(configToml: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'orca-probe-source-home-'));
  writeFileSync(join(directory, 'config.toml'), configToml, 'utf8');
  return directory;
}

/** 探针发出的受限命令调用；用来核对权限事实与调用顺序。 */
function sandboxCalls(codex: FakeCodex): readonly ProcessRequest[] {
  return codex.requests.filter((request) => request.args.includes('sandbox'));
}

test('受限命令可读且拒写时结论为可用，并按生产同源的 profile 调用', async () => {
  const codex = fakeCodex({
    read: (_request, sentinelPath) => completed(0, readFileSync(sentinelPath, 'utf8')),
    write: () => completed(1, 'EROFS'),
  });

  const result = await probeWith(codex);

  expect(result.kind).toBe('available');
  expect(result.stage).toBe('host-verify');
  expect(result.codexVersion).toBe('0.156.1');
  expect(result.profile).toBe('utility-readonly-local-control');
  expect(readOnlyWorkerUnavailableReason(result)).toBeNull();
  expect(describeReadOnlyWorkerCapability(result)).toContain('可用');

  // 只读权限事实只有一份：探针用共享常量，且绝不带任何沙箱后端开关。
  const calls = sandboxCalls(codex);
  expect(calls.length).toBe(2);
  for (const call of calls) {
    expect(call.args.slice(0, 5)).toEqual([
      'sandbox',
      '--profile',
      'utility-readonly-local-control',
      '--permission-profile',
      'utility-readonly-local-control',
    ]);
    expect(call.args.join(' ')).not.toContain('use_legacy_landlock');
  }
  // 探针用的是它自己建立的隔离 CODEX_HOME，profile 正文与生产启动完全一致。
  const codexHome = String(calls[0]?.env['CODEX_HOME']);
  expect(codexHome).not.toBe('/usr/bin');
  expect(codex.profileInCodexHome.value).toBe(CODEX_UTILITY_PROFILE_CONFIG_TOML);
  expect(CODEX_UTILITY_PROFILE_ARGS.join(' ')).toBe('--profile utility-readonly-local-control');
});

test('会话能启动但受限命令不能执行时结论为不可用，并保留失败阶段与诊断', async () => {
  const codex = fakeCodex({
    // 本机现状：受限命令在沙箱构建阶段就失败，读取与写入都没有执行。
    read: () =>
      completed(1, '', 'error building bubblewrap command: cannot establish app-server socket mount isolation\n'),
    write: () => completed(1),
  });

  const result = await probeWith(codex);

  expect(result.kind).toBe('unavailable');
  expect(result.stage).toBe('sandbox-read');
  expect(result.codexVersion).toBe('0.156.1');
  expect(result.diagnostics.join(' ')).toContain('cannot establish app-server socket mount isolation');
  const reason = readOnlyWorkerUnavailableReason(result);
  expect(reason).toContain('read_only_worker_unavailable');
  expect(reason).toContain('sandbox-read');
  // 只有读取那一次受限调用发生过：命令没跑起来时不会继续做写入探针。
  expect(sandboxCalls(codex).length).toBe(1);
});

test('受限命令超时或读回内容不符时不得报告可用', async () => {
  const timedOut = fakeCodex({
    read: () => ({
      kind: 'unknown',
      reason: 'timeout',
      stdout: { text: '', truncated: false },
      stderr: { text: '', truncated: false },
    }),
    write: () => completed(1),
  });
  const timedOutResult = await probeWith(timedOut);
  expect(timedOutResult.kind).toBe('unknown');
  expect(timedOutResult.stage).toBe('sandbox-read');

  const mismatched = fakeCodex({
    read: () => completed(0, 'not-the-sentinel\n'),
    write: () => completed(1),
  });
  const mismatchedResult = await probeWith(mismatched);
  expect(mismatchedResult.kind).toBe('unavailable');
  expect(mismatchedResult.stage).toBe('sandbox-read');
});

test('写入竟然成功时立即判为不可用，不自动改用更宽的权限', async () => {
  const codex = fakeCodex({
    read: (_request, sentinelPath) => completed(0, readFileSync(sentinelPath, 'utf8')),
    // 沙箱没有强制只读：写入真的落盘，而且命令自己认为成功。
    write: (_request, sentinelPath) => completed(0, readFileSync(sentinelPath, 'utf8')),
  });

  const result = await probeWith(codex);

  expect(result.kind).toBe('unavailable');
  expect(result.stage).toBe('sandbox-write');
  expect(result.diagnostics.join(' ')).toContain('只读边界未被强制');
});

test('写入退出码非零但内容已变化时不得报告可用', async () => {
  const codex = fakeCodex({
    read: (_request, sentinelPath) => completed(0, readFileSync(sentinelPath, 'utf8')),
    write: (_request, sentinelPath) => {
      appendFileSync(sentinelPath, 'injected\n', 'utf8');
      return completed(1, '', 'shell 报了错，但文件其实被改了\n');
    },
  });

  const result = await probeWith(codex);

  expect(result.kind).toBe('unavailable');
  expect(result.stage).toBe('host-verify');
});

test('读不到 Codex 版本时结论为未知，且不把版本失败当作能力可用', async () => {
  const codex = fakeCodex({
    version: completed(1, '', 'codex: command not found\n'),
    read: () => completed(0),
    write: () => completed(1),
  });

  const result = await probeWith(codex);

  expect(result.kind).toBe('unknown');
  expect(result.stage).toBe('codex-version');
  expect(result.codexVersion).toBeNull();
  expect(readOnlyWorkerUnavailableReason(result)).toContain('read_only_worker_unavailable');
});

test.each([
  completed(1, '', 'error building bubblewrap command'),
  completed(1, 'ENOENT'),
  completed(1, 'ENOSPC'),
])('写入命令失败但没有权限拒绝证据时不得报告可用：%j', async (writeResult) => {
  const codex = fakeCodex({
    read: (_request, sentinelPath) => completed(0, readFileSync(sentinelPath, 'utf8')),
    write: () => writeResult,
  });

  const result = await probeWith(codex);
  expect(result.kind).toBe('unknown');
  expect(result.stage).toBe('sandbox-write');
});

test('探针不留下临时目录，也不触碰项目文件', async () => {
  const codex = fakeCodex({
    read: (_request, sentinelPath) => completed(0, readFileSync(sentinelPath, 'utf8')),
    write: () => completed(1, 'EROFS'),
  });

  const result = await probeWith(codex);

  expect(result.kind).toBe('available');
  const codexHome = String(sandboxCalls(codex)[0]?.env['CODEX_HOME']);
  expect(codexHome.startsWith(tmpdir())).toBe(true);
  expect(existsSync(codexHome)).toBe(false);
});

test('来源配置混用 legacy sandbox 键时按生产 launch 的同一规则判为未知，不误报可用', async () => {
  const home = sourceHome('sandbox_mode = "workspace-write"\n');
  const codex = fakeCodex({
    read: (_request, sentinelPath) => completed(0, readFileSync(sentinelPath, 'utf8')),
    write: () => completed(1, 'EROFS'),
  });

  // 生产 `createCodexWorkerLaunch` 会为同一份来源配置抛错，探针必须同样拒绝宣称可用。
  const result = await probeReadOnlyWorker({
    env: { PATH: '/usr/bin' },
    runner: codex.runner,
    timeoutMs: 5_000,
    sourceCodexHome: home,
  });

  expect(result.kind).toBe('unknown');
  expect(result.stage).toBe('host-sentinel');
  expect(readOnlyWorkerUnavailableReason(result)).toContain('read_only_worker_unavailable');
  // 冲突在生产 launch 之前就被拦下：一次受限命令都不发。
  expect(sandboxCalls(codex)).toEqual([]);
});

test('来源配置合法时探针把它复制进隔离 HOME，与生产 launch 同源加载', async () => {
  const home = sourceHome('[projects."/tmp/x"]\ntrust_level = "trusted"\n');
  const codex = fakeCodex({
    read: (_request, sentinelPath) => completed(0, readFileSync(sentinelPath, 'utf8')),
    write: () => completed(1, 'EROFS'),
  });

  const result = await probeReadOnlyWorker({
    env: { PATH: '/usr/bin' },
    runner: codex.runner,
    timeoutMs: 5_000,
    sourceCodexHome: home,
  });

  expect(result.kind).toBe('available');
  expect(codex.baseConfigInCodexHome.value).toBe('[projects."/tmp/x"]\ntrust_level = "trusted"\n');
  // 探针无模型调用，因此不建立 auth 链接：隔离 HOME 里只有配置与 profile。
  expect(existsSync(join(String(sandboxCalls(codex)[0]?.env['CODEX_HOME']), 'auth.json'))).toBe(false);
});

test('只读探针与正式启动共用同一个模型配置生成器，且不解析凭据', async () => {
  const base = modelConfigurationFixture();
  const modelConfiguration: WorkerModelConfiguration = {
    ...base,
    effort: 'high',
    effortCapability: { values: ['low', 'high'], source: 'codex', optionPath: 'effort' },
    modelOptions: { model_verbosity: 'low' },
  };
  const codex = fakeCodex({
    read: (_request, sentinelPath) => completed(0, readFileSync(sentinelPath, 'utf8')),
    write: () => completed(1, 'EROFS'),
  });

  const result = await probeReadOnlyWorker({
    env: { PATH: '/usr/bin' },
    runner: codex.runner,
    timeoutMs: 5_000,
    modelConfiguration,
  });

  expect(result.kind).toBe('available');
  const expected = codexModelArguments(modelConfiguration).join(' ');
  const calls = sandboxCalls(codex);
  expect(calls.length).toBe(2);
  for (const call of calls) {
    // 探针与正式启动逐字共享同一组 provider/model/effort/options 参数。
    expect(call.args.join(' ')).toContain(expected);
    expect(call.args).not.toContain('--model');
    expect(call.args).toContain(`model=${JSON.stringify(modelConfiguration.model)}`);
    expect(call.args.join(' ')).toContain('model_reasoning_effort="high"');
  }
  // 探针不调用模型，因此不接受任何凭据注入路径。
  const allArgs = calls.map((call) => call.args.join(' ')).join(' ');
  expect(allArgs).not.toContain('env_key');
  expect(allArgs).not.toContain('requires_openai_auth');
});
