/**
 * owner: `remove-worker-credential-management` / IP-02 Task 2.3 的行为测试。
 *
 * 目录查询的价值是「候选与 effort 能力只来自 harness 自身公开输出」。因此这里用 fake 进程边界精确
 * 构造各 harness 的真实输出形状：codex 的可见性过滤、claude 的 control_response、omp 的实际
 * thinking 数组、opencode/pi 的固定列表格，以及超时/取消/截断/不可核验/超限等失败面。
 * 断言只看调用参数、来源标识与解析结果，不回显或保存任何原生定义全文与秘密。
 */

import { afterEach, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  WORKER_MODEL_CATALOG_MAX_MODELS,
  WORKER_MODEL_CATALOG_TIMEOUT_MS,
  queryWorkerModels,
  workerModelQuery,
} from '../../../src/adapters/agents/worker-model-catalog.js';
import type {
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
} from '../../../src/adapters/orca-cli/process-runner.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function completed(exitCode: number, stdout = '', stderr = ''): ProcessResult {
  return {
    kind: 'completed',
    exitCode,
    stdout: { text: stdout, truncated: false },
    stderr: { text: stderr, truncated: false },
  };
}

function fakeHarness(
  handle: (request: ProcessRequest) => ProcessResult | undefined,
): { readonly runner: ProcessRunner; readonly requests: ProcessRequest[] } {
  const requests: ProcessRequest[] = [];
  const runner: ProcessRunner = (request) => {
    requests.push(request);
    const result = handle(request);
    if (result === undefined) throw new Error('未预期的命令：' + [request.executable, ...request.args].join(' '));
    return Promise.resolve(result);
  };
  return { runner, requests };
}

/** 版本请求固定回同一份输出，其余请求交给 catalog 处理。 */
function withVersion(
  versionOutput: string,
  catalog: (request: ProcessRequest) => ProcessResult,
): { readonly runner: ProcessRunner; readonly requests: ProcessRequest[] } {
  return fakeHarness((request) => (request.args[0] === '--version' ? completed(0, versionOutput) : catalog(request)));
}

/** 本次目录控制请求的 stdin。 */
function catalogStdin(requests: readonly ProcessRequest[]): string | undefined {
  return requests.at(-1)?.stdin;
}

test('codex：按 visibility/可用性过滤，档位只取 supported_reasoning_levels', async () => {
  const catalog = JSON.stringify({
    models: [
      {
        slug: 'gpt-6-astra',
        visibility: 'list',
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'low' }],
      },
      { slug: 'hidden-one', visibility: 'hide', supported_reasoning_levels: [{ effort: 'low' }] },
      { slug: 'not-available', visibility: 'list', is_available: false, supported_reasoning_levels: [{ effort: 'low' }] },
      { slug: 'plain-model', visibility: 'list', supported_reasoning_levels: [] },
      { slug: '', visibility: 'list' },
    ],
  });
  const { runner, requests } = withVersion('codex-cli 0.160.0\n', () => completed(0, catalog));

  const result = await queryWorkerModels({ harness: 'codex', cwd: '/tmp', env: {}, runner });

  expect(result).toEqual({
    kind: 'available',
    source: 'codex:0.160.0:debug-models',
    models: [
      { model: 'gpt-6-astra', effortCapability: { values: ['low', 'high'], source: 'codex:0.160.0:debug-models' } },
      { model: 'plain-model', effortCapability: null },
    ],
  });
  const catalogRequest = requests.at(-1);
  expect(catalogRequest?.args).toEqual(['debug', 'models']);
  expect(catalogRequest?.timeoutMs).toBeGreaterThan(0);
  expect(catalogRequest?.timeoutMs).toBeLessThanOrEqual(WORKER_MODEL_CATALOG_TIMEOUT_MS);
  expect(catalogRequest?.limits).toEqual({ maxBytes: 1024 * 1024, maxLines: 20_000 });
});

test('单次查询只有一个总预算：version 的 10s 计入 30s，目录只用剩余额度', async () => {
  const clock = vi.spyOn(Date, 'now');
  clock.mockReturnValueOnce(1_000_000); // 计算 deadline
  clock.mockReturnValue(1_012_000); // 版本请求耗时 12s 后取剩余
  const { runner, requests } = withVersion('codex-cli 0.160.0\n', () =>
    completed(0, JSON.stringify({ models: [{ slug: 'gpt-5.6-sol', visibility: 'list' }] })));

  const result = await queryWorkerModels({ harness: 'codex', cwd: '/tmp', env: {}, runner });

  expect(result.kind).toBe('available');
  expect(requests.at(-1)?.timeoutMs).toBe(WORKER_MODEL_CATALOG_TIMEOUT_MS - 12_000);
});

test('版本请求已耗尽总预算时不再启动目录查询', async () => {
  const clock = vi.spyOn(Date, 'now');
  clock.mockReturnValueOnce(1_000_000);
  clock.mockReturnValue(1_031_000);
  const { runner, requests } = withVersion('codex-cli 0.160.0\n', () => completed(0, '{}'));

  expect(await queryWorkerModels({ harness: 'codex', cwd: '/tmp', env: {}, runner })).toEqual({
    kind: 'unavailable',
    code: 'catalog_query_timeout',
    message: 'codex 目录查询超时',
  });
  expect(requests.map((request) => request.args)).toEqual([['--version']]);
});

test('claude：只发 list_models 控制请求、不发送 prompt，并按实际 effort 元数据映射', async () => {
  const stream = [
    JSON.stringify({ type: 'system', subtype: 'hook_started' }),
    JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'companion-worker-model-catalog',
        response: {
          models: [
            { value: 'opus', resolvedModel: 'claude-opus-5', supportsEffort: true, supportedEffortLevels: ['low', 'high'] },
            { value: 'haiku', resolvedModel: 'claude-haiku-4-5', supportsEffort: false, supportedEffortLevels: ['low'] },
            { value: 'opus-dup', resolvedModel: 'claude-opus-5' },
          ],
        },
      },
    }),
  ].join('\n');
  const { runner, requests } = withVersion('2.1.291 (Claude Code)\n', () => completed(0, stream));

  const result = await queryWorkerModels({ harness: 'claude', cwd: '/tmp', env: {}, runner });

  expect(result).toEqual({
    kind: 'available',
    source: 'claude:2.1.291:control-list-models',
    models: [
      { model: 'claude-opus-5', effortCapability: { values: ['low', 'high'], source: 'claude:2.1.291:control-list-models' } },
      { model: 'claude-haiku-4-5', effortCapability: null },
    ],
  });
  expect(requests.at(-1)?.args).toEqual([
    '-p',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--verbose',
  ]);
  const stdin = catalogStdin(requests);
  expect(stdin).toContain('"subtype":"list_models"');
  expect(stdin).not.toContain('"type":"user"');
  expect(stdin).not.toContain('"role":"user"');
});

test('claude：控制响应缺失或为错误子类型即不可用，不拿其它行冒充', async () => {
  const { runner } = withVersion('2.1.291 (Claude Code)\n', () =>
    completed(0, JSON.stringify({ type: 'system', subtype: 'init' })));
  expect(await queryWorkerModels({ harness: 'claude', cwd: '/tmp', env: {}, runner })).toEqual({
    kind: 'unavailable',
    code: 'catalog_output_unrecognized',
    message: 'claude 目录输出无法核验',
  });

  const errorResponse = JSON.stringify({
    type: 'control_response',
    response: { subtype: 'error', request_id: 'companion-worker-model-catalog' },
  });
  const failing = withVersion('2.1.291 (Claude Code)\n', () => completed(0, errorResponse));
  expect(await queryWorkerModels({ harness: 'claude', cwd: '/tmp', env: {}, runner: failing.runner })).toEqual({
    kind: 'unavailable',
    code: 'catalog_output_unrecognized',
    message: 'claude 目录输出无法核验',
  });
});

test('omp：selector 作为模型标识，档位只取实际 thinking 数组', async () => {
  const catalog = JSON.stringify({
    models: [
      { provider: 'commandcode', kind: 'chat', id: 'claude-opus-5', selector: 'commandcode/claude-opus-5', reasoning: true, thinking: ['low', 'medium', 'high'] },
      { provider: 'commandcode', kind: 'chat', id: 'claude-haiku-4-5', selector: 'commandcode/claude-haiku-4-5', reasoning: false, thinking: null },
      { provider: 'commandcode', kind: 'classifier', id: 'jev-1', selector: 'commandcode/jev-1', reasoning: false, thinking: null },
    ],
  });
  const { runner, requests } = withVersion('omp/18.4.10\n', () => completed(0, catalog));

  const result = await queryWorkerModels({ harness: 'omp', cwd: '/tmp', env: {}, runner });

  expect(result).toEqual({
    kind: 'available',
    source: 'omp:18.4.10:models-json',
    models: [
      {
        model: 'commandcode/claude-opus-5',
        effortCapability: { values: ['low', 'medium', 'high'], source: 'omp:18.4.10:models-json' },
      },
      { model: 'commandcode/claude-haiku-4-5', effortCapability: null },
    ],
  });
  expect(requests.at(-1)?.args).toEqual(['models', '--json']);
});

test('opencode：固定列表格给出 provider/model，effort 一律为 null', async () => {
  const table = [
    'provider         model                              context  max-out  thinking  images',
    'commandcode      deepseek/deepseek-v4-flash         1M       65.5K    yes       no    ',
    'commandcode      claude-sonnet-5-5                 1M       65.5K    no        no    ',
    '',
  ].join('\n');
  const { runner, requests } = withVersion('2.0.21\n', () => completed(0, table));

  const result = await queryWorkerModels({ harness: 'opencode', cwd: '/tmp', env: {}, runner });

  expect(result).toEqual({
    kind: 'available',
    source: 'opencode:2.0.21:models-standalone',
    models: [
      { model: 'commandcode/deepseek/deepseek-v4-flash', effortCapability: null },
      { model: 'commandcode/claude-sonnet-5-5', effortCapability: null },
    ],
  });
  expect(requests.at(-1)?.args).toEqual(['models', '--standalone']);
});

test('pi：通过原生公开 availability/thinking API 读取真实档位，不发送 prompt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-catalog-'));
  try {
    const ai = join(root, 'node_modules', '@earendil-works', 'pi-ai');
    mkdirSync(ai, { recursive: true });
    writeFileSync(join(root, 'pi'), '');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', exports: { '.': { import: './sdk.mjs' } } }));
    writeFileSync(join(root, 'sdk.mjs'), 'export const ModelRuntime = { create: async () => ({getAvailable: async () => [{provider:"p",id:"reasoning",reasoning:true},{provider:"p",id:"plain",reasoning:false}]}) };');
    writeFileSync(join(ai, 'package.json'), JSON.stringify({ type: 'module', exports: { './compat': { import: './thinking.mjs' } } }));
    writeFileSync(join(ai, 'thinking.mjs'), 'export const getSupportedThinkingLevels = () => ["low","high"];');
    const { runProcess } = await import('../../../src/adapters/orca-cli/process-runner.js');
    const runner: ProcessRunner = (request) => request.args[0] === '--version'
      ? Promise.resolve(completed(0, '1.0.0')) : runProcess(request);
    const result = await queryWorkerModels({ harness: 'pi', cwd: root, env: {}, executables: { pi: join(root, 'pi') }, runner });
    expect(result).toMatchObject({ kind: 'available', models: [
      { model: 'p/reasoning', effortCapability: { values: ['low', 'high'] } },
      { model: 'p/plain', effortCapability: null },
    ] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('版本不可核验时 fail closed，不拿未知版本冒充来源', async () => {
  const { runner, requests } = fakeHarness((request) =>
    request.args[0] === '--version' ? completed(0, 'no version here\n') : completed(0, '{}'));
  expect(await queryWorkerModels({ harness: 'codex', cwd: '/tmp', env: {}, runner })).toEqual({
    kind: 'unavailable',
    code: 'harness_version_unreadable',
    message: '无法核验 codex 可执行文件版本',
  });
  expect(requests).toHaveLength(1);
});

test('进程是超时/取消/无法启动/输出截断失败的显式结果', async () => {
  const cases: readonly {
    readonly result: ProcessResult;
    readonly code: string;
  }[] = [
    {
      result: { kind: 'unavailable', code: 'process_spawn_failed', message: 'spawn codex ENOENT' },
      code: 'harness_spawn_failed',
    },
    {
      result: { kind: 'unknown', reason: 'timeout', stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } },
      code: 'catalog_query_timeout',
    },
    {
      result: { kind: 'unknown', reason: 'cancelled', stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } },
      code: 'catalog_query_cancelled',
    },
    {
      result: { kind: 'completed', exitCode: 0, stdout: { text: '{"models":[]}', truncated: true }, stderr: { text: '', truncated: false } },
      code: 'catalog_output_truncated',
    },
  ];
  for (const { result, code } of cases) {
    const { runner } = fakeHarness((request) => (request.args[0] === '--version' ? completed(0, 'codex-cli 0.160.0') : result));
    const outcome = await queryWorkerModels({ harness: 'codex', cwd: '/tmp', env: {}, runner });
    expect(outcome.kind).toBe('unavailable');
    expect(outcome.kind === 'unavailable' ? outcome.code : null).toBe(code);
  }
});

test('输出不可核验/空目录/超限分别给出结构化失败', async () => {
  const garbage = withVersion('codex-cli 0.160.0\n', () => completed(0, 'not json at all'));
  expect(await queryWorkerModels({ harness: 'codex', cwd: '/tmp', env: {}, runner: garbage.runner })).toEqual({
    kind: 'unavailable',
    code: 'catalog_output_unrecognized',
    message: 'codex 目录输出无法核验',
  });

  for (const output of ['', 'provider  model\n']) {
    const empty = withVersion('2.0.21\n', () => completed(0, output));
    expect(await queryWorkerModels({ harness: 'opencode', cwd: '/tmp', env: {}, runner: empty.runner })).toMatchObject({
      kind: 'unavailable', code: 'catalog_empty',
    });
  }

  const tooMany = withVersion('codex-cli 0.160.0\n', () =>
    completed(0, JSON.stringify({ models: Array.from({ length: WORKER_MODEL_CATALOG_MAX_MODELS + 1 }, (_value, index) => ({ slug: 'model-' + String(index), visibility: 'list' })) })));
  expect(await queryWorkerModels({ harness: 'codex', cwd: '/tmp', env: {}, runner: tooMany.runner })).toEqual({
    kind: 'unavailable',
    code: 'catalog_too_large',
    message: 'codex 目录超过 ' + String(WORKER_MODEL_CATALOG_MAX_MODELS) + ' 项上限',
  });
});

test('非零退出码只给固定类别消息，绝不回显原生 stderr 正文', async () => {
  const { runner } = withVersion('codex-cli 0.160.0\n', () =>
    completed(1, '', 'boom: token=SECRET\nsecond line with more detail\n'));
  expect(await queryWorkerModels({ harness: 'codex', cwd: '/tmp', env: {}, runner })).toEqual({
    kind: 'unavailable',
    code: 'catalog_query_failed',
    message: 'codex 目录查询退出码 1',
  });
});

test('查询只转发调用方给出的环境，结果与来源不含秘密', async () => {
  const env = { PATH: '/usr/bin', COMPANION_TEST_TOKEN: 's3cr3t-value' };
  const { runner, requests } = withVersion('codex-cli 0.160.0\n', () =>
    completed(0, JSON.stringify({ models: [{ slug: 'gpt-6-astra', visibility: 'list' }] })));

  const result = await queryWorkerModels({ harness: 'codex', cwd: '/tmp', env, runner });

  expect(requests.at(-1)?.env).toEqual(env);
  expect(JSON.stringify(result)).not.toContain('s3cr3t-value');
});

test('workerModelQuery 把 harness 固定到端口方法', async () => {
  const { runner, requests } = withVersion('omp/18.4.10\n', () =>
    completed(0, JSON.stringify({ models: [{ kind: 'chat', selector: 'commandcode/claude-opus-5', thinking: ['high'] }] })));
  const queryModels = workerModelQuery('omp', { runner });

  const result = await queryModels({ cwd: '/tmp', env: {} });

  expect(result.kind).toBe('available');
  expect(requests.at(-1)?.args).toEqual(['models', '--json']);
});
