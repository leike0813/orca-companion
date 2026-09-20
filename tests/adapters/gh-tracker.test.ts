import { expect, test } from 'vitest';

import type { ProcessRequest, ProcessResult, ProcessRunner } from '../../src/adapters/orca-cli/process-runner.js';
import {
  assignIssue,
  createGhTracker,
  readIssue,
  updateIssueBody,
  type GhTrackerOptions,
} from '../../src/adapters/tracker/gh-tracker.js';
import type { EntityRef } from '../../src/application/dto/identity.js';

const TICKET: EntityRef<string> = { kind: 'decision-ticket', id: '42' };
const SECRET = 'ghp_do_not_leak';

type Recording = {
  readonly runner: ProcessRunner;
  readonly calls: ProcessRequest[];
};

/** 记录型假 runner：按调用顺序回放登记好的进程结果，绝不真的调用 `gh`。 */
function recordingRunner(responses: readonly ProcessResult[]): Recording {
  const calls: ProcessRequest[] = [];
  const runner: ProcessRunner = (request) => {
    calls.push(request);
    const response = responses[calls.length - 1];
    if (response === undefined) {
      throw new Error(`假 runner 收到第 ${calls.length} 次调用，但没有登记响应`);
    }
    return Promise.resolve(response);
  };
  return { runner, calls };
}

function trackerOptions(runner: ProcessRunner): GhTrackerOptions {
  return { cwd: '/repo', env: { PATH: '/usr/bin', GH_TOKEN: SECRET }, runner };
}

function completed(
  stdout: string,
  options: { readonly exitCode?: number; readonly stderr?: string; readonly stdoutTruncated?: boolean } = {},
): ProcessResult {
  return {
    kind: 'completed',
    exitCode: options.exitCode ?? 0,
    stdout: { text: stdout, truncated: options.stdoutTruncated ?? false },
    stderr: { text: options.stderr ?? '', truncated: false },
  };
}

function issueJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ number: 42, title: '标题', body: '正文', state: 'OPEN', assignees: [], ...overrides });
}

const SPAWN_FAILED: ProcessResult = {
  kind: 'unavailable',
  code: 'process_spawn_failed',
  message: 'spawn gh ENOENT',
};

function timedOut(): ProcessResult {
  return {
    kind: 'unknown',
    reason: 'timeout',
    stdout: { text: '', truncated: false },
    stderr: { text: '', truncated: false },
  };
}

// ---------------------------------------------------------------------------
// readIssue
// ---------------------------------------------------------------------------

test('readIssue 解析 gh 的 JSON，把 OPEN 映射成 open 并沿用传入的 ref', async () => {
  const { runner, calls } = recordingRunner([
    completed(issueJson({ state: 'OPEN', assignees: [{ login: 'alice' }, { login: 'bob' }] })),
  ]);

  const outcome = await readIssue(trackerOptions(runner), TICKET);

  expect(calls).toHaveLength(1);
  expect(calls[0]?.executable).toBe('gh');
  expect(calls[0]?.args).toEqual(['issue', 'view', '42', '--json', 'number,title,body,state,assignees']);
  expect(outcome.kind).toBe('read');
  if (outcome.kind === 'read') {
    expect(outcome.issue.ref).toEqual(TICKET);
    expect(outcome.issue.state).toBe('open');
    expect(outcome.issue.title).toBe('标题');
    expect(outcome.issue.body).toBe('正文');
    expect(outcome.issue.assignees).toEqual(['alice', 'bob']);
  }
});

test('readIssue 把 CLOSED 映射成 closed', async () => {
  const { runner } = recordingRunner([completed(issueJson({ state: 'CLOSED' }))]);

  const outcome = await readIssue(trackerOptions(runner), TICKET);

  expect(outcome.kind).toBe('read');
  if (outcome.kind === 'read') {
    expect(outcome.issue.state).toBe('closed');
  }
});

test('readIssue 在缺字段、未知 state 或 assignees 形状不对时 fail closed', async () => {
  const payloads: readonly Record<string, unknown>[] = [
    { number: 42, title: 't', state: 'OPEN', assignees: [] }, // 缺 body
    { number: 42, title: 't', body: 'b', state: 'MERGED', assignees: [] }, // 未知 state
    { number: 42, title: 't', body: 'b', state: 'OPEN', assignees: [{ name: 'x' }] }, // 缺 login
    { number: 42, title: 't', body: 'b', state: 'OPEN', assignees: ['alice'] }, // 元素不是对象
    { number: 0, title: 't', body: 'b', state: 'OPEN', assignees: [] }, // number 不是正整数
    { number: 42, title: 't', body: 'b', state: 'OPEN' }, // 缺 assignees
  ];

  for (const payload of payloads) {
    const { runner } = recordingRunner([completed(JSON.stringify(payload))]);
    const outcome = await readIssue(trackerOptions(runner), TICKET);
    expect(outcome.kind).toBe('unknown');
  }
});

test('readIssue 在标准输出不是对象或不是 JSON 时返回 unknown', async () => {
  for (const stdout of ['[]', 'not json']) {
    const { runner } = recordingRunner([completed(stdout)]);
    const outcome = await readIssue(trackerOptions(runner), TICKET);
    expect(outcome.kind).toBe('unknown');
  }
});

test('readIssue 在 stderr 说明 issue 不存在时返回 not_found', async () => {
  const stderrs = ["GraphQL: Could not resolve to an issue or pull request with the term '42'.", 'issue NOT FOUND'];

  for (const stderr of stderrs) {
    const { runner } = recordingRunner([completed('', { exitCode: 1, stderr })]);
    const outcome = await readIssue(trackerOptions(runner), TICKET);
    expect(outcome.kind).toBe('not_found');
  }
});

test('readIssue 在进程没能启动时返回 unavailable，且不泄露 env 值', async () => {
  const { runner } = recordingRunner([SPAWN_FAILED]);

  const outcome = await readIssue(trackerOptions(runner), TICKET);

  expect(outcome.kind).toBe('unavailable');
  if (outcome.kind === 'unavailable') {
    expect(outcome.message).not.toContain(SECRET);
  }
});

test('readIssue 在授权错误时返回 unavailable', async () => {
  const { runner } = recordingRunner([completed('', { exitCode: 1, stderr: 'gh: authentication required' })]);

  const outcome = await readIssue(trackerOptions(runner), TICKET);

  expect(outcome.kind).toBe('unavailable');
});

test('readIssue 在其它非零退出时返回 unavailable', async () => {
  const { runner } = recordingRunner([completed('', { exitCode: 1, stderr: 'unexpected gh failure' })]);

  const outcome = await readIssue(trackerOptions(runner), TICKET);

  expect(outcome.kind).toBe('unavailable');
});

test('readIssue 在超时时返回 unknown', async () => {
  const { runner } = recordingRunner([timedOut()]);

  const outcome = await readIssue(trackerOptions(runner), TICKET);

  expect(outcome.kind).toBe('unknown');
  if (outcome.kind === 'unknown') {
    expect(outcome.reason).toContain('timeout');
  }
});

test('readIssue 在标准输出被截断时返回 unknown', async () => {
  const { runner } = recordingRunner([completed(issueJson(), { stdoutTruncated: true })]);

  const outcome = await readIssue(trackerOptions(runner), TICKET);

  expect(outcome.kind).toBe('unknown');
});

test('readIssue 遇到未登记的引用类型时不发出任何命令', async () => {
  const { runner, calls } = recordingRunner([completed(issueJson())]);

  const outcome = await readIssue(trackerOptions(runner), { kind: 'work-package', id: 'wp-1' });

  expect(outcome.kind).toBe('unknown');
  expect(calls).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// updateIssueBody
// ---------------------------------------------------------------------------

test('updateIssueBody 把正文作为独立参数传入并接受 exit 0', async () => {
  const { runner, calls } = recordingRunner([completed('')]);

  const outcome = await updateIssueBody(trackerOptions(runner), { ref: TICKET, body: '地图正文' });

  expect(outcome.kind).toBe('accepted');
  expect(calls[0]?.args).toEqual(['issue', 'edit', '42', '--body', '地图正文']);
});

test('updateIssueBody 能从 stdout 解析出请求 id 时就带上 requestId', async () => {
  const { runner } = recordingRunner([completed('{"id":"req-9"}')]);

  const outcome = await updateIssueBody(trackerOptions(runner), { ref: TICKET, body: 'b' });

  expect(outcome).toEqual({ kind: 'accepted', requestId: 'req-9' });
});

test('updateIssueBody 在 stdout 无法解析请求 id 时仍返回 accepted', async () => {
  const { runner } = recordingRunner([completed('written')]);

  const outcome = await updateIssueBody(trackerOptions(runner), { ref: TICKET, body: 'b' });

  // 不带 requestId 的 accepted 恰好是这个对象；多出字段会 fail。
  expect(outcome).toEqual({ kind: 'accepted' });
});

test('updateIssueBody 在进程没能启动时返回 rejected，可证明没有副作用', async () => {
  const { runner } = recordingRunner([SPAWN_FAILED]);

  const outcome = await updateIssueBody(trackerOptions(runner), { ref: TICKET, body: 'b' });

  expect(outcome.kind).toBe('rejected');
  if (outcome.kind === 'rejected') {
    expect(outcome.code).toBe('spawn_failed');
  }
});

test('updateIssueBody 在授权错误时返回 rejected，且不泄露 env 值', async () => {
  const { runner } = recordingRunner([completed('', { exitCode: 1, stderr: 'HTTP 403: permission denied' })]);

  const outcome = await updateIssueBody(trackerOptions(runner), { ref: TICKET, body: 'b' });

  expect(outcome.kind).toBe('rejected');
  if (outcome.kind === 'rejected') {
    expect(outcome.code).toBe('unauthorized');
    expect(outcome.message).not.toContain(SECRET);
  }
});

test('updateIssueBody 在其它非零退出时返回 unknown', async () => {
  const { runner } = recordingRunner([completed('', { exitCode: 1, stderr: 'unexpected gh failure' })]);

  const outcome = await updateIssueBody(trackerOptions(runner), { ref: TICKET, body: 'b' });

  expect(outcome.kind).toBe('unknown');
});

test('updateIssueBody 在超时时返回 unknown', async () => {
  const { runner } = recordingRunner([timedOut()]);

  const outcome = await updateIssueBody(trackerOptions(runner), { ref: TICKET, body: 'b' });

  expect(outcome.kind).toBe('unknown');
  if (outcome.kind === 'unknown') {
    expect(outcome.reason).toContain('timeout');
  }
});

// ---------------------------------------------------------------------------
// assignIssue
// ---------------------------------------------------------------------------

test('assignIssue 设置 assignee 时发一条 --add-assignee 命令', async () => {
  const { runner, calls } = recordingRunner([completed('')]);

  const outcome = await assignIssue(trackerOptions(runner), { ref: TICKET, assignee: 'alice' });

  expect(outcome.kind).toBe('accepted');
  expect(calls).toHaveLength(1);
  expect(calls[0]?.args).toEqual(['issue', 'edit', '42', '--add-assignee', 'alice']);
});

test('assignIssue 清除时先读取再对每个 assignee 各发一条 --remove-assignee', async () => {
  const { runner, calls } = recordingRunner([
    completed(issueJson({ assignees: [{ login: 'alice' }, { login: 'bob' }] })),
    completed(''),
    completed(''),
  ]);

  const outcome = await assignIssue(trackerOptions(runner), { ref: TICKET, assignee: null });

  expect(outcome.kind).toBe('accepted');
  expect(calls[0]?.args).toContain('view');
  expect(calls[1]?.args).toEqual(['issue', 'edit', '42', '--remove-assignee', 'alice']);
  expect(calls[2]?.args).toEqual(['issue', 'edit', '42', '--remove-assignee', 'bob']);
});

test('assignIssue 在 assignees 已为空时不发写入命令', async () => {
  const { runner, calls } = recordingRunner([completed(issueJson({ assignees: [] }))]);

  const outcome = await assignIssue(trackerOptions(runner), { ref: TICKET, assignee: null });

  expect(outcome.kind).toBe('accepted');
  expect(calls).toHaveLength(1);
  expect(calls.some((call) => call.args.includes('edit'))).toBe(false);
});

test('assignIssue 在部分移除成功后失败时返回 unknown', async () => {
  const { runner, calls } = recordingRunner([
    completed(issueJson({ assignees: [{ login: 'alice' }, { login: 'bob' }] })),
    completed(''),
    completed('', { exitCode: 1, stderr: 'unexpected gh failure' }),
  ]);

  const outcome = await assignIssue(trackerOptions(runner), { ref: TICKET, assignee: null });

  expect(outcome.kind).toBe('unknown');
  expect(calls).toHaveLength(3);
});

test('assignIssue 在第一个移除就失败且无副作用时按分类返回 rejected', async () => {
  const { runner } = recordingRunner([
    completed(issueJson({ assignees: [{ login: 'alice' }] })),
    SPAWN_FAILED,
  ]);

  const outcome = await assignIssue(trackerOptions(runner), { ref: TICKET, assignee: null });

  expect(outcome.kind).toBe('rejected');
  if (outcome.kind === 'rejected') {
    expect(outcome.code).toBe('spawn_failed');
  }
});

test('assignIssue 清除时若票据不存在则不发出写入命令', async () => {
  const { runner, calls } = recordingRunner([completed('', { exitCode: 1, stderr: 'not found' })]);

  const outcome = await assignIssue(trackerOptions(runner), { ref: TICKET, assignee: null });

  expect(outcome.kind).toBe('unknown');
  expect(calls).toHaveLength(1);
  expect(calls.some((call) => call.args.includes('edit'))).toBe(false);
});

test('assignIssue 遇到未登记的引用类型时不发出任何命令', async () => {
  const { runner, calls } = recordingRunner([completed('')]);

  const outcome = await assignIssue(trackerOptions(runner), { ref: { kind: 'work-package', id: 'wp-1' }, assignee: 'alice' });

  expect(outcome.kind).toBe('rejected');
  expect(calls).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// createGhTracker
// ---------------------------------------------------------------------------

test('createGhTracker 组合三个底层函数', async () => {
  const { runner, calls } = recordingRunner([completed(issueJson()), completed(''), completed('')]);

  const gateway = createGhTracker(trackerOptions(runner));
  const read = await gateway.readIssue(TICKET);
  const written = await gateway.updateIssueBody({ ref: TICKET, body: 'b' });
  const assigned = await gateway.assignIssue({ ref: TICKET, assignee: 'alice' });

  expect(read.kind).toBe('read');
  expect(written.kind).toBe('accepted');
  expect(assigned.kind).toBe('accepted');
  expect(calls[0]?.args).toContain('view');
  expect(calls[1]?.args).toContain('--body');
  expect(calls[2]?.args).toContain('--add-assignee');
});
