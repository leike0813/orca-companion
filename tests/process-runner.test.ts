import { expect, test } from 'vitest';

import { isOrcaKeepaliveLine } from '../src/adapters/orca-cli/orca-backend.js';
import { runProcess } from '../src/adapters/orca-cli/process-runner.js';

function nodeRequest(script: string, extraArgs: readonly string[] = []) {
  return {
    executable: process.execPath,
    args: ['-e', script, ...extraArgs],
    cwd: process.cwd(),
    env: { PATH: process.env['PATH'] ?? '' },
    timeoutMs: 10_000,
  };
}

test('参数按单个数组元素原样传递，不经 shell 解释', async () => {
  // 每个元素都带空格、引号或 shell 元字符；shell 拼接会让它们被替换或拆分。
  const args = ['a b', "it's", '"; rm -rf /nonexistent', '$HOME', '`id`', '*', 'line\nbreak'];
  const result = await runProcess(
    nodeRequest('process.stdout.write(JSON.stringify(process.argv.slice(1)))', args),
  );

  expect(result.kind).toBe('completed');
  if (result.kind !== 'completed') {
    return;
  }
  expect(JSON.parse(result.stdout.text)).toEqual(args);
});

test('标准输出与保活噪声分离，噪声不计入上限与截断判定', async () => {
  const script = [
    'for (let i = 0; i < 20; i += 1)',
    '  process.stderr.write(JSON.stringify({ _keepalive: true, sequence: i }) + "\\n");',
    'process.stdout.write("{}");',
  ].join('');
  // 20 条保活行远超 64 字节；它们必须在计数之前被丢弃，否则会误报截断。
  const result = await runProcess({
    ...nodeRequest(script),
    limits: { maxBytes: 64, maxLines: 4 },
    dropStderrLine: isOrcaKeepaliveLine,
  });

  expect(result.kind).toBe('completed');
  if (result.kind !== 'completed') {
    return;
  }
  expect(result.stdout.text).toBe('{}');
  expect(result.stdout.truncated).toBe(false);
  expect(result.stderr.text).toBe('');
  expect(result.stderr.truncated).toBe(false);
});

test('输出超过上限时有界截断并显式标记', async () => {
  const script = 'for (let i = 0; i < 500; i += 1) console.log("line-" + i);';
  const result = await runProcess({
    ...nodeRequest(script),
    limits: { maxBytes: 4096, maxLines: 5 },
  });

  expect(result.kind).toBe('completed');
  if (result.kind !== 'completed') {
    return;
  }
  expect(result.stdout.truncated).toBe(true);
  expect(result.stdout.text.length).toBeLessThanOrEqual(4096);
  expect(result.stdout.text.split('\n').filter((line) => line.length > 0).length).toBeLessThanOrEqual(5);
});

test('非零退出保留退出码与结构化错误载荷', async () => {
  const payload = { ok: false, error: { code: 'invalid_argument', message: 'bad input' } };
  const script = `process.stdout.write(${JSON.stringify(JSON.stringify(payload))}); process.exit(3);`;
  const result = await runProcess(nodeRequest(script));

  expect(result.kind).toBe('completed');
  if (result.kind !== 'completed') {
    return;
  }
  expect(result.exitCode).toBe(3);
  expect(JSON.parse(result.stdout.text)).toEqual(payload);
});

test('可执行文件无法启动时归类为不可达，而不是输入不合法', async () => {
  const result = await runProcess({
    ...nodeRequest('process.exit(0)'),
    executable: '/nonexistent/orca-companion-probe',
    args: [],
  });

  expect(result.kind).toBe('unavailable');
  if (result.kind !== 'unavailable') {
    return;
  }
  expect(result.code).toBe('process_spawn_failed');
});

test('超时终止子进程并报告结果未知', async () => {
  const result = await runProcess({ ...nodeRequest('setTimeout(() => {}, 60000);'), timeoutMs: 200 });

  expect(result.kind).toBe('unknown');
  if (result.kind !== 'unknown') {
    return;
  }
  expect(result.reason).toBe('timeout');
});

test('取消终止子进程并报告结果未知', async () => {
  const controller = new AbortController();
  const pending = runProcess({
    ...nodeRequest('setTimeout(() => {}, 60000);'),
    timeoutMs: 30_000,
    signal: controller.signal,
  });
  setTimeout(() => {
    controller.abort();
  }, 100);

  const result = await pending;
  expect(result.kind).toBe('unknown');
  if (result.kind !== 'unknown') {
    return;
  }
  expect(result.reason).toBe('cancelled');
});
