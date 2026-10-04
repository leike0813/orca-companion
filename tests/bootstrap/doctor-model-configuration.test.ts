/**
 * doctor 的模型核验接线（IP-03 / D03）。
 *
 * 只断言探针层能观察到的行为：有没有装配模型核验、核验失败时是不是如实报不可用。不断言具体模型
 * 名字或探针文案 —— 那属于实现细节。这里也不启动 Orca：模型接线与 Orca 无关，跑真实 Orca 只会让
 * 这层断言依赖外部进程。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { createOrcaDoctorProbe } from '../../src/bootstrap/doctor.js';

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

const VALID_CONFIG = {
  schemaVersion: 2,
  revision: 0,
  coordinatorModels: [
    {
      configurationRef: 'probe-model',
      providerIntegration: '@example/missing-integration#Absent',
      model: 'probe-model',
      modelOptions: {},
      credentialRefs: [],
      nativeWindowOwnerRef: null,
    },
  ],
  defaultCoordinatorModelRef: 'probe-model',
  providerConnections: [],
  models: [],
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

test('配置的 provider 集成不可用：报不可用，而不是通过', async () => {
  const repository = repositoryWithConfig(configWith({}));
  const probe = createOrcaDoctorProbe({ cwd: repository, env: {} });

  const result = await probe.readCoordinatorModel!();
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.status).toBe('capability-missing');
    // 只断言结构化状态与「点名了是哪个集成不可用」：不锁定完整文案。
    expect(result.detail).toContain('@example/missing-integration');
  }
});

test('配置已加载但没有 Finalizer profile：只读 Worker 报不可用，不给看起来通过的结论', async () => {
  const repository = repositoryWithConfig(configWith({}));
  const probe = createOrcaDoctorProbe({ cwd: repository, env: {} });

  // 配置已进入执行形态却没有 Finalizer 绑定：退化探针会把「没核验模型」说成通过。
  const result = await probe.readReadOnlyWorker!();
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
