/**
 * `m1-wire-foreground-planning-runtime` D1 的行为测试：版本化项目配置。
 *
 * 这里固定三件可观察事实：合法配置能把默认 Coordinator Model Configuration 解析出来；配置缺失、
 * 内容无效与引用不存在分别给出可诊断拒绝；已知密钥字段名在配置边界即被拒绝。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import {
  configurationByRef,
  loadProjectConfig,
  parseProjectConfig,
  PROJECT_CONFIG_FILENAME,
  projectConfigPath,
} from '../../src/bootstrap/project-config.js';

let directory = '';
let worktree = '';

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-project-config-'));
  worktree = join(directory, 'worktree');
  mkdirSync(worktree);
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function model(configurationRef: string) {
  return {
    configurationRef,
    providerIntegration: '@langchain/openai#ChatOpenAI',
    model: 'gpt-4.1-mini',
    modelOptions: { temperature: 0 },
    credentialRefs: ['openai-default'],
    nativeWindowOwnerRef: null,
  };
}

function validConfig() {
  return {
    schemaVersion: 1,
    coordinatorModels: [model('planning-default'), model('planning-spare')],
    defaultCoordinatorModelRef: 'planning-default',
    tracker: { kind: 'github', routeMapIssueNumber: 42 },
    planning: { maxMutations: 3 },
    context: { maxInputTokens: 120_000 },
  };
}

function write(raw: unknown): void {
  writeFileSync(projectConfigPath(worktree), JSON.stringify(raw), 'utf8');
}

test('合法配置从 canonical worktree 加载并解析默认引用', () => {
  write(validConfig());

  const loaded = loadProjectConfig({ worktreePath: worktree });

  expect(loaded.kind).toBe('loaded');
  if (loaded.kind !== 'loaded') {
    return;
  }
  expect(loaded.path).toBe(join(worktree, PROJECT_CONFIG_FILENAME));
  expect(loaded.defaultConfiguration.configurationRef).toBe('planning-default');
  expect(loaded.config.tracker).toEqual({ kind: 'github', routeMapIssueNumber: 42 });
  expect(loaded.config.planning.maxMutations).toBe(3);
  expect(loaded.config.context.maxInputTokens).toBe(120_000);
  expect(configurationByRef(loaded.config, 'planning-spare')?.model).toBe('gpt-4.1-mini');
  expect(configurationByRef(loaded.config, 'missing')).toBeNull();
});

test('配置缺失是可诊断拒绝，不隐式创建配置', () => {
  const loaded = loadProjectConfig({ worktreePath: worktree });

  expect(loaded).toMatchObject({ kind: 'failed', code: 'missing' });
});

test('非法 JSON 与不可读分别拒绝', () => {
  writeFileSync(projectConfigPath(worktree), '{ not json', 'utf8');
  expect(loadProjectConfig({ worktreePath: worktree })).toMatchObject({ kind: 'failed', code: 'invalid' });

  const directoryAsFile = join(directory, 'as-directory');
  mkdirSync(directoryAsFile);
  const unreadable = loadProjectConfig({
    worktreePath: directoryAsFile,
    readFile: () => {
      const error = new Error('EACCES: permission denied') as Error & { code?: string };
      error.code = 'EACCES';
      throw error;
    },
  });
  expect(unreadable).toMatchObject({ kind: 'failed', code: 'unreadable' });
});

test('schema 版本、未声明字段与越界取值都指向具体字段', () => {
  const wrongVersion = parseProjectConfig({ ...validConfig(), schemaVersion: 2 });
  expect(wrongVersion).toMatchObject({ ok: false, field: 'projectConfig' });

  const unknownField = parseProjectConfig({ ...validConfig(), extra: true });
  expect(unknownField.ok).toBe(false);

  const zeroMutations = parseProjectConfig({
    ...validConfig(),
    planning: { maxMutations: 0 },
  });
  expect(zeroMutations.ok).toBe(true);

  const negativeMutations = parseProjectConfig({
    ...validConfig(),
    planning: { maxMutations: -1 },
  });
  expect(negativeMutations.ok).toBe(false);

  const badIssueNumber = parseProjectConfig({
    ...validConfig(),
    tracker: { kind: 'github', routeMapIssueNumber: 0 },
  });
  expect(badIssueNumber.ok).toBe(false);

  const badBudget = parseProjectConfig({
    ...validConfig(),
    context: { maxInputTokens: 0 },
  });
  expect(badBudget.ok).toBe(false);
});

test('默认引用必须存在，且 configurationRef 唯一', () => {
  const dangling = parseProjectConfig({ ...validConfig(), defaultCoordinatorModelRef: 'nope' });
  expect(dangling).toMatchObject({ ok: false, field: 'projectConfig.defaultCoordinatorModelRef' });

  const duplicated = parseProjectConfig({
    ...validConfig(),
    coordinatorModels: [model('same'), model('same')],
    defaultCoordinatorModelRef: 'same',
  });
  expect(duplicated).toMatchObject({ ok: false, field: 'projectConfig.coordinatorModels' });
});

test('凭据只以引用出现：已知密钥字段名在配置边界被拒绝', () => {
  const nested = parseProjectConfig({
    ...validConfig(),
    coordinatorModels: [
      {
        ...model('planning-default'),
        modelOptions: { headers: { Authorization: 'Bearer secret' } },
      },
    ],
  });
  expect(nested).toMatchObject({ ok: false });
  if (nested.ok) {
    return;
  }
  expect(nested.field).toContain('coordinatorModels.0.modelOptions.headers.Authorization');

  const topLevel = parseProjectConfig({ ...validConfig(), apiKey: 'sk-live' });
  expect(topLevel).toMatchObject({ ok: false, field: 'projectConfig.apiKey' });

  const valid = parseProjectConfig(validConfig());
  expect(valid.ok).toBe(true);
});
