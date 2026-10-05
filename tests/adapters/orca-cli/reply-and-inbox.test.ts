/**
 * 受控 reply 与有界 inbox 的 transport 契约测试（Owner: `m2-wire-execution-runtime`）。
 *
 * 覆盖：`orchestration reply` 的 argv 与 question 回执解析、确定失败与截断的三值处置；
 * `orchestration inbox` 的精确 terminal + 1..20 有界页，绝不跨 terminal 或全库读取。
 */

import { expect, test } from 'vitest';

import type { ExecutionMutation, ExecutionQuery, ExecutionScope } from '../../../src/application/ports/execution-backend.js';
import { createOrcaExecutionBackend } from '../../../src/adapters/orca-cli/orca-backend.js';
import {
  INBOX_PAGE_MAX,
  isMessageInboxPage,
  parseMessageInbox,
  parseReplyReceipt,
} from '../../../src/adapters/orca-cli/operation-catalog.js';
import type { ProcessRequest, ProcessResult, ProcessRunner } from '../../../src/adapters/orca-cli/process-runner.js';

function recordingTransport(responses: readonly ProcessResult[]): { runner: ProcessRunner; calls: ProcessRequest[] } {
  const calls: ProcessRequest[] = [];
  const runner: ProcessRunner = (request) => {
    calls.push(request);
    const response = responses[calls.length - 1];
    if (response === undefined) throw new Error('假 transport 没有登记响应');
    return Promise.resolve(response);
  };
  return { runner, calls };
}

function completed(stdout: string, exitCode = 0): ProcessResult {
  return { kind: 'completed', exitCode, stdout: { text: stdout, truncated: false }, stderr: { text: '', truncated: false } };
}

function okResult(result: unknown): ProcessResult {
  return completed(JSON.stringify({ id: 'req-1', ok: true, result, _meta: { runtimeId: 'runtime-1' } }));
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

function executionScope(): ExecutionScope {
  return {
    coordinationScopeId: 'scope-1',
    coordinatorSessionId: 'session-1',
    runtimeIncarnationId: 'incarnation-1',
    fencingGeneration: 1,
    backendIdentityRef: 'identity-ref',
    operationId: 'op-1',
    target: { kind: 'worker-message', id: 'msg-1' },
    expectedRevision: 4,
    timeoutMs: 5_000,
    authority: { kind: 'execution_coordination', graphGeneration: 1, authorizationId: 'auth-1', runId: 'run-1', consumerGeneration: 1 },
  };
}

test('reply 只按精确 message 身份构造 argv，并解析 question 回执', async () => {
  const { runner, calls } = recordingTransport([
    okResult({ message: { id: 'ans-1' }, question: { status: 'answered', message_id: 'msg-1' }, duplicate: false }),
  ]);
  const backend = backendWith(runner);
  const outcome = await backend.mutate(
    { operation: 'reply', messageId: 'msg-1', body: '{"action":"verify"}', runId: 'run-1' } satisfies ExecutionMutation,
    executionScope(),
  );
  expect(calls[0]?.args).toEqual([
    'orchestration', 'reply', '--id', 'msg-1', '--body', '{"action":"verify"}', '--json', '--from', 'handle:identity-ref', '--run', 'run-1',
  ]);
  expect(outcome).toMatchObject({
    kind: 'accepted',
    value: { messageId: 'ans-1', questionMessageId: 'msg-1', questionStatus: 'answered', duplicate: false },
  });
});

test('reply 回执里 question 未生效或缺字段一律 fail closed', () => {
  expect(parseReplyReceipt({ message: { id: 'ans-1' }, question: { status: 'pending', message_id: 'msg-1' } }).ok).toBe(false);
  expect(parseReplyReceipt({ question: { status: 'answered', message_id: 'msg-1' } }).ok).toBe(false);
  const direct = parseReplyReceipt({ message: { id: 'ans-2' } });
  expect(direct.ok && direct.value.questionStatus).toBe('not_a_question');
});

test('reply 输出截断时按 unknown 处理，不当作已答复', async () => {
  const { runner } = recordingTransport([
    { kind: 'completed', exitCode: 0, stdout: { text: '{"id":"r"', truncated: true }, stderr: { text: '', truncated: false } },
  ]);
  const outcome = await backendWith(runner).mutate(
    { operation: 'reply', messageId: 'msg-1', body: 'x' } satisfies ExecutionMutation,
    executionScope(),
  );
  expect(outcome.kind).toBe('unknown');
});

test('message-inbox 必须精确 terminal 且 limit 落在 1..20', async () => {
  const { runner, calls } = recordingTransport([okResult({ messages: [], count: 0 })]);
  const backend = backendWith(runner);
  const query: ExecutionQuery = { operation: 'message-inbox', backendIdentityRef: 'identity-ref', limit: INBOX_PAGE_MAX };
  const page = await backend.query(query);
  expect(calls[0]?.args).toEqual(['orchestration', 'inbox', '--json', '--terminal', 'handle:identity-ref', '--limit', String(INBOX_PAGE_MAX)]);
  expect(page).toMatchObject({ kind: 'accepted', value: { messages: [], count: 0 } });

  const tooBig = await backend.query({ operation: 'message-inbox', backendIdentityRef: 'identity-ref', limit: INBOX_PAGE_MAX + 1 });
  expect(tooBig).toMatchObject({ kind: 'rejected' });
});

test('message-inbox 缺少身份即拒绝，不跨 terminal 读取', async () => {
  const { runner, calls } = recordingTransport([okResult({ messages: [], count: 0 })]);
  const outcome = await backendWith(runner).query({ operation: 'message-inbox' } as unknown as ExecutionQuery);
  expect(outcome).toMatchObject({ kind: 'rejected', code: 'identity_unavailable' });
  expect(calls).toHaveLength(0);
});

test('inbox 原始 message 复用 Delivery 消息字段规范', () => {
  const parsed = parseMessageInbox({
    messages: [
      {
        id: 'msg-9',
        run_id: 'run-1',
        delivery_contract: 'current_delivery',
        from_handle: 'dispatch:dispatch-1',
        to_handle: 'run:run-1',
        type: 'question',
        subject: 'Question',
        priority: 'normal',
        body: 'hi',
        payload: '{}',
      },
    ],
    count: 1,
  });
  expect(parsed.ok && isMessageInboxPage(parsed.value)).toBe(true);
  if (parsed.ok) {
    expect(parsed.value.messages[0]).toMatchObject({ messageId: 'msg-9', fromHandle: 'dispatch:dispatch-1', runId: 'run-1', body: 'hi' });
  }
});
