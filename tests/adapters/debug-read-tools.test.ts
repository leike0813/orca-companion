import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { beforeEach, expect, test } from 'vitest';

import type { DebugReadResult, DebugReadServices } from '../../src/application/ports/debug-read-tools.js';
import { createDebugReadServices } from '../../src/adapters/agents/debug-read-tools.js';
import type { ProcessRequest, ProcessResult, ProcessRunner } from '../../src/adapters/orca-cli/process-runner.js';
import { createDebugTools } from '../../src/workflow/coordinator/debug-tools.js';

/**
 * IP-03 / D-05 的行为证据。
 *
 * 这些用例只断言对调用方可观察的东西：结构化拒绝码、有界输出、以及目录确实没被写过。
 * 工具文案与内部遍历顺序不属于契约，因此不做断言。
 */

function makeRoot(): string {
  // 有界的临时夹具，故意不清理：递归删除在本仓库属于禁止操作，留给系统 tmp 自己回收。
  return mkdtempSync(path.join(tmpdir(), 'ocp-debug-tools-'));
}

function expectRejected<T>(result: DebugReadResult<T>, code: string): void {
  expect(result.kind).toBe('rejected');
  if (result.kind === 'rejected') {
    expect(result.code).toBe(code);
  }
}

let root: string;
let outside: string;
let services: DebugReadServices;

beforeEach(() => {
  root = makeRoot();
  outside = makeRoot();
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src', 'alpha.ts'), 'export const alpha = 1;\nconst needle = alpha;\n');
  writeFileSync(path.join(root, 'src', 'beta.ts'), 'export const beta = 2;\n');
  writeFileSync(path.join(outside, 'secret.txt'), 'do not read me\n');
  services = createDebugReadServices({ rootDirectory: root });
});

test('根目录内的文件可以被读取并回到调用方', async () => {
  const result = await services.readFile({ path: 'src/alpha.ts' });
  expect(result.kind).toBe('accepted');
  if (result.kind === 'accepted') {
    expect(result.value.path).toBe(path.join('src', 'alpha.ts'));
    expect(result.value.content).toContain('export const alpha = 1;');
    expect(result.value.truncated).toBe(false);
  }
});

test('绝对路径、父路径与符号链接都在读取前被拒绝', async () => {
  symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'escape.txt'));
  expectRejected(await services.readFile({ path: path.join(outside, 'secret.txt') }), 'path_outside_root');
  expectRejected(await services.readFile({ path: '../' }), 'path_outside_root');
  expectRejected(await services.readFile({ path: 'escape.txt' }), 'path_outside_root');
  expectRejected(await services.listFiles({ path: '../..' }), 'path_outside_root');
  expectRejected(await services.readFile({ path: 'missing.txt' }), 'not_found');
});

test('目录不是文件读取的合法目标', async () => {
  expectRejected(await services.readFile({ path: 'src' }), 'not_a_regular_file');
  expectRejected(await services.listFiles({ path: 'src/beta.ts' }), 'not_a_directory');
});

test('单文件读取有界：超出上限的内容被显式截断', async () => {
  const small = createDebugReadServices({ rootDirectory: root, limits: { maxReadBytes: 16 } });
  const result = await small.readFile({ path: 'src/alpha.ts' });
  expect(result.kind).toBe('accepted');
  if (result.kind === 'accepted') {
    expect(result.value.truncated).toBe(true);
    expect(result.value.content.length).toBeLessThan(64);
    expect(result.value.content.startsWith('export const alp')).toBe(true);
  }
});

test('截断落在多字节字符中间时不会产生替换字符', async () => {
  // 「€」是 3 字节；把上限切在它中间，保留的部分必须仍是完整字符。
  writeFileSync(path.join(root, 'euro.txt'), 'ab€cd');
  const bounded = createDebugReadServices({ rootDirectory: root, limits: { maxReadBytes: 4 } });
  const result = await bounded.readFile({ path: 'euro.txt' });
  expect(result.kind).toBe('accepted');
  if (result.kind === 'accepted') {
    expect(result.value.content).not.toContain('\uFFFD');
    expect(result.value.content.startsWith('ab')).toBe(true);
    expect(result.value.truncated).toBe(true);
  }
});

test('截断标记本身也在输出上限内', async () => {
  writeFileSync(path.join(root, 'wide.txt'), 'y'.repeat(4096));
  for (const limit of [1, 16, 128]) {
    const bounded = createDebugReadServices({ rootDirectory: root, limits: { outputMaxBytes: limit } });
    for (const read of [await bounded.readFile({ path: 'wide.txt' }), await bounded.listFiles({})]) {
      expect(read.kind).toBe('accepted');
      if (read.kind !== 'accepted') throw new Error(read.code);
      const text = 'content' in read.value ? read.value.content : read.value.files.join('\n');
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(limit);
    }
  }
});

test('非法预算在装配期被拒绝，不会变成一次无界分配', () => {
  for (const limits of [{ maxReadBytes: 0 }, { maxScanBytes: -1 }, { outputMaxBytes: Number.NaN }, { timeoutMs: Number.POSITIVE_INFINITY }]) {
    expect(() => createDebugReadServices({ rootDirectory: root, limits })).toThrow();
  }
});

test('搜索的跨文件读取量有总预算', async () => {
  for (let index = 0; index < 20; index += 1) {
    writeFileSync(path.join(root, 'src', `big${index}.txt`), 'x'.repeat(4096));
  }
  const bounded = createDebugReadServices({ rootDirectory: root, limits: { maxScanBytes: 8192 } });
  const result = await bounded.search({ pattern: 'x' });
  expect(result.kind).toBe('accepted');
  if (result.kind === 'accepted') {
    // 预算用尽后必须停下，而不是把剩下的文件逐个读到上限。
    expect(result.value.truncated).toBe(true);
    expect(result.value.matches.length).toBeLessThan(20);
  }
});

test('目录遍历有界：条目数与输出都不超过预算', async () => {
  for (let index = 0; index < 40; index += 1) {
    writeFileSync(path.join(root, 'src', `f${String(index)}.txt`), 'x');
  }
  const bounded = createDebugReadServices({ rootDirectory: root, limits: { maxEntries: 10 } });
  const result = await bounded.listFiles({});
  expect(result.kind).toBe('accepted');
  if (result.kind === 'accepted') {
    expect(result.value.files.length).toBeLessThanOrEqual(10);
    expect(result.value.truncated).toBe(true);
  }
});

test('遍历不跟随符号链接，也不读取它们指向的内容', async () => {
  symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
  symlinkSync(outside, path.join(root, 'linkdir'));
  const found = await services.search({ pattern: 'do not read me' });
  expect(found.kind === 'accepted' && found.value.matches).toEqual([]);
  const listed = await services.listFiles({});
  expect(listed.kind === 'accepted' && listed.value.files.some((file) => file.includes('linkdir'))).toBe(false);
});

test('目录句柄在达到扫描上限时就关闭，不等整个目录读完', async () => {
  const many = makeRoot();
  for (let index = 0; index < 200; index += 1) {
    writeFileSync(path.join(many, `f${index}.txt`), 'x');
  }
  const bounded = createDebugReadServices({ rootDirectory: many, limits: { maxEntries: 5 } });
  const result = await bounded.listFiles({});
  expect(result.kind === 'accepted' && result.value.files.length).toBe(5);
  expect(result.kind === 'accepted' && result.value.truncated).toBe(true);
});

test('超时拒绝只在子进程清理完成后返回', async () => {
  let cleanedUp = false;
  const hanging: ProcessRunner = (request) =>
    new Promise<ProcessResult>((resolve) => {
      request.signal?.addEventListener('abort', () => {
        // 真实的 runProcess 在这里终止子进程；本替身用这个标记表示「清理已经结束」。
        cleanedUp = true;
        resolve({ kind: 'unknown', reason: 'timeout', stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } });
      });
    });
  const bounded = createDebugReadServices({ rootDirectory: root, runProcess: hanging, limits: { timeoutMs: 10 } });
  const result = await bounded.gitDiff({});
  expectRejected(result, 'timeout');
  expect(cleanedUp).toBe(true);
});

test('搜索按固定字符串匹配并受命中上限约束', async () => {
  const found = await services.search({ pattern: 'needle' });
  expect(found.kind).toBe('accepted');
  if (found.kind === 'accepted') {
    expect(found.value.matches).toEqual([{ path: path.join('src', 'alpha.ts'), line: 2, text: 'const needle = alpha;' }]);
  }
  // `.` 在固定字符串下是字面量，不是通配符。
  const literal = await services.search({ pattern: '.*' });
  expect(literal.kind === 'accepted' && literal.value.matches.length).toBe(0);

  const capped = createDebugReadServices({ rootDirectory: root, limits: { maxMatches: 1 } });
  const many = await capped.search({ pattern: 'export' });
  expect(many.kind === 'accepted' && many.value.matches.length).toBe(1);
  expect(many.kind === 'accepted' && many.value.truncated).toBe(true);
});

test('取消是结构化拒绝，不是未知结果', async () => {
  const controller = new AbortController();
  controller.abort();
  expectRejected(await services.listFiles({}, { signal: controller.signal }), 'cancelled');
  expectRejected(await services.readFile({ path: 'src/alpha.ts' }, { signal: controller.signal }), 'cancelled');
  expectRejected(await services.search({ pattern: 'alpha' }, { signal: controller.signal }), 'cancelled');
});

test('非 Git 目录的 git_diff 结构化拒绝', async () => {
  expectRejected(await services.gitDiff({}), 'not_a_repository');
});

test('git_diff 使用 argv 并关闭 external diff、textconv 与 pager', async () => {
  const seen: ProcessRequest[] = [];
  const fake: ProcessRunner = (request) => {
    seen.push(request);
    return Promise.resolve<ProcessResult>({
      kind: 'completed',
      exitCode: 0,
      stdout: { text: 'diff --git a/a b/a\n', truncated: false },
      stderr: { text: '', truncated: false },
    });
  };
  const stubbed = createDebugReadServices({ rootDirectory: root, runProcess: fake });
  const result = await stubbed.gitDiff({ path: 'src/alpha.ts', staged: true });
  expect(result.kind === 'accepted' && result.value.diff).toContain('diff --git');

  const request = seen[0];
  expect(request?.executable).toBe('git');
  expect(request?.args).toEqual([
    '--no-pager',
    '--literal-pathspecs',
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    '--cached',
    '--',
    path.join('src', 'alpha.ts'),
  ]);
  expect(request?.cwd).toBe(path.resolve(root));
  expect(request?.env['GIT_PAGER']).toBe('cat');
  expect(request?.signal).toBeDefined();
});

test('git_diff 越界路径在启动子进程前被拒绝', async () => {
  symlinkSync(outside, path.join(root, 'escapedir'));
  let spawned = false;
  const fake: ProcessRunner = () => {
    spawned = true;
    return Promise.resolve<ProcessResult>({ kind: 'unavailable', code: 'process_spawn_failed', message: 'unexpected' });
  };
  const stubbed = createDebugReadServices({ rootDirectory: root, runProcess: fake });
  expectRejected(await stubbed.gitDiff({ path: '../escape' }), 'path_outside_root');
  expectRejected(await stubbed.gitDiff({ path: 'escapedir/secret.txt' }), 'path_outside_root');
  expect(spawned).toBe(false);
});

/** 仓库里的调试根目录子目录：unstaged / staged 两条路径都必须被限制在这个子目录内。 */
function makeNestedRepo(): { readonly repo: string; readonly debugRoot: string } {
  const repo = makeRoot();
  const debugRoot = path.join(repo, 'debug-root');
  mkdirSync(debugRoot);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'debug@example.test'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'debug'], { cwd: repo });
  return { repo, debugRoot };
}

test('git_diff 在仓库子目录中只返回调试根目录内的差异', async () => {
  const { repo, debugRoot } = makeNestedRepo();
  const inside = path.join(debugRoot, 'inside.txt');
  const outside = path.join(repo, 'outside.txt');
  writeFileSync(inside, 'inside\n');
  writeFileSync(outside, 'outside\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  const nested = createDebugReadServices({ rootDirectory: debugRoot });

  // `git diff --cached` 没有 pathspec 时按仓库根计算，这里必须只看到根内的文件。
  const staged = await nested.gitDiff({ staged: true });
  expect(staged.kind).toBe('accepted');
  if (staged.kind === 'accepted') {
    expect(staged.value.diff).toContain('inside.txt');
    expect(staged.value.diff).not.toContain('outside.txt');
  }

  writeFileSync(inside, 'inside changed\n');
  writeFileSync(outside, 'outside changed\n');
  const unstaged = await nested.gitDiff({});
  expect(unstaged.kind).toBe('accepted');
  if (unstaged.kind === 'accepted') {
    expect(unstaged.value.diff).toContain('inside.txt');
    expect(unstaged.value.diff).not.toContain('outside.txt');
  }
});

test('git_diff 的 pathspec 是字面文件名，含通配符字符不扩散', async () => {
  const { repo, debugRoot } = makeNestedRepo();
  writeFileSync(path.join(debugRoot, 'a*b.txt'), 'literal\n');
  writeFileSync(path.join(debugRoot, 'aXb.txt'), 'decoy\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  const nested = createDebugReadServices({ rootDirectory: debugRoot });

  const result = await nested.gitDiff({ staged: true, path: 'a*b.txt' });
  expect(result.kind).toBe('accepted');
  if (result.kind === 'accepted') {
    expect(result.value.diff).toContain('a*b.txt');
    expect(result.value.diff).not.toContain('aXb.txt');
  }
});

test('真实 Git 目录返回未提交差异', async () => {
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'debug@example.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'debug'], { cwd: root });
  writeFileSync(path.join(root, 'tracked.txt'), 'first\n');
  execFileSync('git', ['add', 'tracked.txt'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
  writeFileSync(path.join(root, 'tracked.txt'), 'second\n');

  const result = await services.gitDiff({});
  expect(result.kind).toBe('accepted');
  if (result.kind === 'accepted') {
    expect(result.value.diff).toContain('-first');
    expect(result.value.diff).toContain('+second');
  }
});

test('工具调用只读：内容与修改时间在全部调用后保持不变', async () => {
  const target = path.join(root, 'src', 'alpha.ts');
  const before = statSync(target);
  const beforeContent = readFileSync(target, 'utf8');
  const directoryBefore = statSync(root).mtimeMs;

  await services.listFiles({});
  await services.readFile({ path: 'src/alpha.ts' });
  await services.search({ pattern: 'needle' });
  await services.gitDiff({});

  expect(readFileSync(target, 'utf8')).toBe(beforeContent);
  expect(statSync(target).mtimeMs).toBe(before.mtimeMs);
  expect(statSync(root).mtimeMs).toBe(directoryBefore);
});

test('createDebugTools 把结果归一化成正式工具 outcome', async () => {
  const tools = createDebugTools(services);
  expect(tools.map((tool) => tool.name)).toEqual(['list_files', 'read_file', 'search', 'git_diff']);
  expect(tools.every((tool) => tool.mutating === false)).toBe(true);

  const readFile = tools.find((tool) => tool.name === 'read_file')!;
  const controller = new AbortController();
  const context = { operationId: 'op-1', mapOperationId: null, signal: controller.signal } as never;

  const accepted = await readFile.invoke({ path: 'src/alpha.ts' }, context);
  expect(accepted.kind).toBe('ok');
  if (accepted.kind === 'ok') {
    expect(JSON.stringify(accepted.value)).toContain('export const alpha = 1;');
  }

  const escaped = await readFile.invoke({ path: '../outside/secret.txt' }, context);
  expectRejected(escaped as DebugReadResult<unknown>, 'path_outside_root');

  controller.abort();
  const cancelled = await readFile.invoke({ path: 'src/alpha.ts' }, context);
  expectRejected(cancelled as DebugReadResult<unknown>, 'cancelled');

  const invalid = await readFile.invoke({ path: '   ' }, context);
  expect(invalid.kind === 'rejected' && invalid.code).toBe('invalid_argument');
});

test('SDK 绕过 schema 时，非对象输入与未登记字段仍然被拒绝', async () => {
  const readFile = createDebugTools(services).find((tool) => tool.name === 'read_file')!;
  const gitDiff = createDebugTools(services).find((tool) => tool.name === 'git_diff')!;
  const context = { operationId: 'op-1', mapOperationId: null } as never;
  const rejected = async (outcome: Promise<{ kind: string; code?: string }>): Promise<void> => {
    expect(await outcome.then((value) => value.kind === 'rejected' && value.code === 'invalid_argument')).toBe(true);
  };

  await rejected(readFile.invoke(null, context));
  await rejected(readFile.invoke('src/alpha.ts', context));
  await rejected(readFile.invoke(['src/alpha.ts'], context));
  await rejected(readFile.invoke({ path: 'src/alpha.ts', cwd: '/etc' }, context));
  await rejected(gitDiff.invoke({ staged: 'yes' }, context));
});
