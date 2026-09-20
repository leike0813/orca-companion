/**
 * Orca transport 新增工作的契约测试
 * （change: `m1-admit-work-package-specifications`，Owner: IP-A6）。
 *
 * 覆盖 Requirement「Dispatch Candidate 物化恰好一个角色级 Orca Task」的 transport 部分：
 * - worktree 建立与列举登记在封闭 operation 目录内，argv 构造可核验；
 * - `worker-start` 走已登记的 `--task` 路径，绝不使用未安装版本支持的 `--spec`；
 * - Orca 记录的确定失败把拒绝码与提示原样透传给调用方。
 */

import { expect, test } from 'vitest';

import type { OperationOutcome } from '../../../src/application/dto/operation-outcome.js';
import type {
  ExecutionMutation,
  ExecutionScope,
} from '../../../src/application/ports/execution-backend.js';
import { createOrcaExecutionBackend } from '../../../src/adapters/orca-cli/orca-backend.js';
import {
  isRegisteredOrcaOperation,
  parseWorktreeCreation,
  parseWorktreeList,
} from '../../../src/adapters/orca-cli/operation-catalog.js';
import type { ProcessRequest, ProcessResult, ProcessRunner } from '../../../src/adapters/orca-cli/process-runner.js';

type Recording = {
  readonly runner: ProcessRunner;
  readonly calls: ProcessRequest[];
};

function recordingTransport(responses: readonly ProcessResult[]): Recording {
  const calls: ProcessRequest[] = [];
  const runner: ProcessRunner = (request) => {
    calls.push(request);
    const response = responses[calls.length - 1];
    if (response === undefined) {
      throw new Error(`假 transport 收到第 ${calls.length} 次调用，但没有登记响应`);
    }
    return Promise.resolve(response);
  };
  return { runner, calls };
}

function completed(stdout: string, exitCode = 0): ProcessResult {
  return {
    kind: 'completed',
    exitCode,
    stdout: { text: stdout, truncated: false },
    stderr: { text: '', truncated: false },
  };
}

function envelope(body: Record<string, unknown>, requestId = 'req-1'): string {
  return JSON.stringify({ id: requestId, ...body, _meta: { runtimeId: 'runtime-1' } });
}

function okResult(result: unknown, requestId = 'req-1'): ProcessResult {
  return completed(envelope({ ok: true, result }, requestId));
}

function errorResult(code: string, message: string, data?: unknown): ProcessResult {
  return completed(
    envelope({ ok: false, error: { code, message, ...(data === undefined ? {} : { data }) } }),
    1,
  );
}

function executionScope(overrides: Partial<ExecutionScope> = {}): ExecutionScope {
  return {
    coordinationScopeId: 'scope-1',
    coordinatorSessionId: 'session-1',
    runtimeIncarnationId: 'incarnation-1',
    fencingGeneration: 1,
    backendIdentityRef: 'identity-ref',
    operationId: 'op-1',
    target: { kind: 'work-package', id: 'wp-1' },
    expectedRevision: 4,
    timeoutMs: 5_000,
    authority: {
      kind: 'execution_coordination',
      graphGeneration: 1,
      authorizationId: 'auth-1',
      runId: 'run-1',
      consumerGeneration: 1,
    },
    ...overrides,
  };
}

function backendWith(runner: ProcessRunner) {
  return createOrcaExecutionBackend({
    executable: 'orca',
    cwd: process.cwd(),
    env: {},
    runner,
    resolveIdentityHandle: (ref) => `handle:${ref}`,
  });
}

test('worktree 建立与列举都登记在封闭 operation 目录内', () => {
  expect(isRegisteredOrcaOperation('worktree-create')).toBe(true);
  expect(isRegisteredOrcaOperation('worktree-list')).toBe(true);
});

test('worktree 建立的 argv 与回执解析可核验', async () => {
  const { runner, calls } = recordingTransport([
    okResult({
      id: 'wt-1',
      path: '/tmp/worktrees/wp-1',
      branch: 'refs/heads/docs/wp-1',
      head: 'abcdef0123456789abcdef0123456789abcdef01',
      isMainWorktree: false,
      displayName: 'wp-1',
    }),
  ]);
  const backend = backendWith(runner);

  const outcome = await backend.mutate(
    {
      operation: 'worktree-create',
      repo: 'path:/work/repo',
      name: 'wp-wp-1',
      baseBranch: 'refs/heads/main',
      comment: 'workPackageId=wp-1',
    } satisfies ExecutionMutation,
    executionScope(),
  );

  expect(calls).toHaveLength(1);
  expect(calls[0]?.args).toEqual([
    'worktree',
    'create',
    '--repo',
    'path:/work/repo',
    '--name',
    'wp-wp-1',
    '--json',
    '--base-branch',
    'refs/heads/main',
    '--comment',
    'workPackageId=wp-1',
  ]);
  expect(outcome.kind).toBe('accepted');
  if (outcome.kind === 'accepted') {
    expect(outcome.value).toEqual({ worktreeId: 'wt-1' });
  }
});

test('worktree 列举返回可核验的摘要，缺字段则 fail closed', async () => {
  const { runner, calls } = recordingTransport([
    okResult({
      worktrees: [
        {
          id: 'repo-1::/tmp/worktrees/wp-1',
          path: '/tmp/worktrees/wp-1',
          branch: 'refs/heads/docs/wp-1',
          head: 'abcdef0123456789abcdef0123456789abcdef01',
          displayName: 'wp-1',
          comment: 'workPackageId=wp-1',
          isMainWorktree: false,
        },
        { id: 'repo-1::/work/repo', path: '/work/repo', isMainWorktree: true },
      ],
      totalCount: 2,
      truncated: false,
      hostScope: { hostIds: ['local'], omittedHostIds: [] },
    }),
    okResult({
      worktrees: [{ path: '/tmp/no-id' }],
      totalCount: 1,
      truncated: false,
      hostScope: { hostIds: ['local'], omittedHostIds: [] },
    }),
  ]);
  const backend = backendWith(runner);

  const listed = await backend.query({ operation: 'worktree-list', repo: 'path:/work/repo' });
  const missingId = await backend.query({ operation: 'worktree-list' });

  expect(calls[0]?.args).toEqual(['worktree', 'list', '--json', '--repo', 'path:/work/repo']);
  expect(calls[1]?.args).toEqual(['worktree', 'list', '--json']);
  expect(listed.kind).toBe('accepted');
  if (listed.kind === 'accepted') {
    expect(listed.value).toEqual({
      worktrees: [
        {
          worktreeId: 'repo-1::/tmp/worktrees/wp-1',
          path: '/tmp/worktrees/wp-1',
          branch: 'refs/heads/docs/wp-1',
          head: 'abcdef0123456789abcdef0123456789abcdef01',
          displayName: 'wp-1',
          comment: 'workPackageId=wp-1',
          isMainWorktree: false,
        },
        {
          worktreeId: 'repo-1::/work/repo',
          path: '/work/repo',
          branch: null,
          head: null,
          displayName: null,
          comment: null,
          isMainWorktree: true,
        },
      ],
      totalCount: 2,
      truncated: false,
      hostScope: { hostIds: ['local'], omittedHostIds: [] },
    });
  }
  expect(missingId.kind).toBe('rejected');
  if (missingId.kind === 'rejected') {
    expect(missingId.code).toBe('invalid_response');
  }
});

test('worker-start 走 --task 路径，绝不使用 --spec', async () => {
  const { runner, calls } = recordingTransport([
    okResult({ runId: 'run-1', taskId: 'task-1', dispatchId: 'dispatch-1', state: 'ready' }),
  ]);
  const backend = backendWith(runner);

  const outcome = await backend.mutate(
    {
      operation: 'worker-start',
      taskId: 'task-1',
      agent: 'codex',
      model: 'minimax-cn/MiniMax-M3',
      worktree: 'repo-1::/tmp/worktrees/wp-1',
    } satisfies ExecutionMutation,
    executionScope(),
  );

  expect(calls[0]?.args).toContain('--task');
  expect(calls[0]?.args).toContain('task-1');
  expect(calls[0]?.args).not.toContain('--spec');
  expect(outcome.kind).toBe('accepted');
  if (outcome.kind === 'accepted') {
    expect(outcome.value).toMatchObject({ taskId: 'task-1', dispatchId: 'dispatch-1', state: 'ready' });
  }
});

test('Orca 记录的确定失败把拒绝码与提示原样透传', async () => {
  const nextSteps = '先执行 orca orchestration task-update --status ready 再重试';
  const { runner } = recordingTransport([errorResult('task_not_startable', nextSteps)]);
  const backend = backendWith(runner);

  const outcome: OperationOutcome<unknown> = await backend.mutate(
    { operation: 'worker-start', taskId: 'task-1', agent: 'codex' } satisfies ExecutionMutation,
    executionScope(),
  );

  expect(outcome.kind).toBe('accepted');
  if (outcome.kind !== 'accepted') {
    return;
  }
  // 确定失败仍是 accepted：Orca 已记录结果，但结果是拒绝。
  expect(outcome.value).toEqual({ ok: false, code: 'task_not_startable', message: nextSteps });
});

test('worktree 建立回执缺 id 时按 unknown 处理，不猜身份', async () => {
  const { runner } = recordingTransport([okResult({ path: '/tmp/worktrees/wp-1' })]);
  const backend = backendWith(runner);

  const outcome = await backend.mutate(
    { operation: 'worktree-create', repo: 'path:/work/repo', name: 'wp-wp-1' } satisfies ExecutionMutation,
    executionScope(),
  );

  expect(outcome.kind).toBe('unknown');
});

test('worktree 回执解析器拒绝缺 id 或非对象的负载', () => {
  expect(parseWorktreeCreation({ id: '' }).ok).toBe(false);
  expect(parseWorktreeCreation({}).ok).toBe(false);
  expect(parseWorktreeCreation('nope').ok).toBe(false);
  expect(parseWorktreeCreation({ id: 'wt-1' })).toEqual({ ok: true, value: { worktreeId: 'wt-1' } });

  expect(parseWorktreeList({}).ok).toBe(false);
  expect(parseWorktreeList({ worktrees: 'nope' }).ok).toBe(false);
  expect(parseWorktreeList({ worktrees: [] }).ok).toBe(false);
  expect(parseWorktreeList({ worktrees: [], totalCount: 0, truncated: false })).toEqual({
    ok: true,
    value: { worktrees: [], totalCount: 0, truncated: false, hostScope: null },
  });
});
