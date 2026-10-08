/**
 * doctor 的模型核验接线（IP-03 / D03）。
 *
 * 只断言探针层能观察到的行为：有没有装配模型核验、核验失败时是不是如实报不可用。不断言具体模型
 * 名字或探针文案 —— 那属于实现细节。这里也不启动 Orca：模型接线与 Orca 无关，跑真实 Orca 只会让
 * 这层断言依赖外部进程。
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { createOrcaDoctorProbe } from '../../src/bootstrap/doctor.js';
import { coordinatorConfigurationFixture } from '../support/model-configurations.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function repositoryWithConfig(contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'doctor-model-'));
  directories.push(directory);
  writeFileSync(join(directory, 'orca-companion.json'), contents, 'utf8');
  return directory;
}

function fakeClaude(): { readonly bin: string; readonly env: Record<string, string> } {
  const directory = mkdtempSync(join(tmpdir(), 'doctor-fake-harness-'));
  directories.push(directory);
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const executable = join(bin, 'claude');
  writeFileSync(executable, [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then echo "2.1.291 (Claude Code)"; exit 0; fi',
    'if [ "$1" = "-p" ]; then',
    '  read -r request',
    `  printf '%s\\n' '${JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'companion-worker-model-catalog',
        response: { models: [{ value: 'minimax', resolvedModel: 'MiniMax-M3', supportsEffort: false }] },
      },
    })}'`,
    '  exit 0',
    'fi',
    'exit 1',
    '',
  ].join('\n'), 'utf8');
  chmodSync(executable, 0o755);
  return { bin, env: { PATH: `${bin}:${process.env['PATH'] ?? ''}` } };
}

const VALID_CONFIG = {
  schemaVersion: 5,
  revision: 0,
  coordinatorModels: [
    coordinatorConfigurationFixture('probe-model'),
  ],
  defaultCoordinatorModelRef: 'probe-model',
  providerConnections: [coordinatorConfigurationFixture().providerConnection],
  models: [{ modelRef: coordinatorConfigurationFixture().modelRef, connectionRef: coordinatorConfigurationFixture().providerConnection.connectionRef, model: coordinatorConfigurationFixture().model, effortCapability: null }],
  tracker: { kind: 'github', routeMapIssueNumber: 1 },
  planning: { maxMutations: 0 },
  context: { maxInputTokens: 1000 },
  // `execution` 是 strictObject：一旦出现就必须齐备 harness 与 codexSandbox，省略整个键才是「纯规划」。
  execution: { harness: 'codex', codexSandbox: 'workspace-write', workerProfiles: [], workerProfileRefs: {} },
};

/** 以对象展开改字段：JSON 字符串上的 replace 依赖引号风格，改一次格式就会静默失配。 */
function configWith(overrides: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({ ...VALID_CONFIG, ...overrides });
}

test('项目没有配置时：doctor 不装配模型核验，也不因此判定失败', () => {
  const empty = mkdtempSync(join(tmpdir(), 'doctor-model-empty-'));
  directories.push(empty);
  const probe = createOrcaDoctorProbe({ cwd: empty, env: {} });

  // 「配置了就必查」：没有可核验的配置就不假装核验过，而不是报一个误导性的失败。
  expect(probe.readCoordinatorModel).toBeUndefined();
});

test('项目没有配置时：不假装核验过任何只读角色引用的 harness', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'doctor-model-empty-'));
  directories.push(empty);
  const probe = createOrcaDoctorProbe({ cwd: empty, env: {} });

  // 没有配置引用任何角色，就不存在「本应核验哪个 harness」：如实返回空结论，而不是拿默认 harness 顶替。
  await expect(probe.readReadOnlyWorkers!()).resolves.toEqual({ ok: true, value: [] });
});

test('配置的 API Key 不可用：报不可用，而不是通过', async () => {
  const repository = repositoryWithConfig(configWith({}));
  const probe = createOrcaDoctorProbe({ cwd: repository, env: {} });

  const result = await probe.readCoordinatorModel!();
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.status).toBe('capability-missing');
    expect(result.detail).toContain('凭据');
  }
});

test('配置已加载但没有 Finalizer profile：只读 Worker 报不可用，不给看起来通过的结论', async () => {
  const repository = repositoryWithConfig(configWith({}));
  const probe = createOrcaDoctorProbe({ cwd: repository, env: {} });

  // 配置已进入执行形态却没有 Finalizer 绑定：退化探针会把「没核验模型」说成通过。
  const result = await probe.readReadOnlyWorkers!();
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.status).toBe('capability-missing');
  }
});

test('项目配置写坏：仍装配核验并报不可用，不回落成「没有配置」', async () => {
  const repository = repositoryWithConfig('{ 这不是合法 JSON');
  const probe = createOrcaDoctorProbe({ cwd: repository, env: {} });

  // 写坏与缺失是两种事实：只有缺失才允许跳过。
  expect(probe.readCoordinatorModel).toBeDefined();
  const result = await probe.readCoordinatorModel!();
  expect(result.ok).toBe(false);
});

test('只读角色查询 Worker 原生目录并保留受限启动探针结论', async () => {
  const harness = fakeClaude();
  const repository = repositoryWithConfig(
    configWith({
      execution: {
        harness: 'claude',
        codexSandbox: 'workspace-write',
        workerProfiles: [
          {
            profileRef: 'profile-finalizer',
            role: 'finalizer',
            harness: 'claude',
            modelSelection: {
              model: 'MiniMax-M3',
              effort: null,
              effortCapability: null,
              catalogSource: 'claude:2.1.291:control-list-models',
            },
          },
        ],
        workerProfileRefs: { finalizer: 'profile-finalizer' },
      },
    }),
  );
  const probe = createOrcaDoctorProbe({ cwd: repository, env: harness.env });

  const result = await probe.readReadOnlyWorkers!();
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value[0]).toMatchObject({ harness: 'claude', profileRef: 'profile-finalizer' });
    expect(result.value[0]?.detail).toContain('原生模型目录可用（1 项）');
  }
});
