import { expect, test } from 'vitest';

import type { OperationOutcome, OperationRef } from '../src/application/dto/operation-outcome.js';
import type {
  ExecutionMutation,
  ExecutionQuery,
  ExecutionScope,
} from '../src/application/ports/execution-backend.js';
import {
  classifyOrcaFailure,
  failureCategoryOf,
  type OrcaFailureClassification,
} from '../src/adapters/orca-cli/error-classification.js';
import {
  createOrcaExecutionBackend,
} from '../src/adapters/orca-cli/orca-backend.js';
import { reconcileOperation } from '../src/application/ports/execution-backend.js';
import {
  parseWorkerShow,
  parseWorkerStartReceipt,
} from '../src/adapters/orca-cli/operation-catalog.js';
import type { ProcessRequest, ProcessResult, ProcessRunner } from '../src/adapters/orca-cli/process-runner.js';

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

function envelope(
  body: Record<string, unknown>,
  options: { requestId?: string; runtimeId?: string | null } = {},
): string {
  const runtimeId = options.runtimeId === undefined ? 'runtime-1' : options.runtimeId;
  return JSON.stringify({
    id: options.requestId ?? 'req-1',
    ...body,
    _meta: { runtimeId },
  });
}

function okResult(result: unknown, options?: { requestId?: string; runtimeId?: string | null }): ProcessResult {
  return completed(envelope({ ok: true, result }, options));
}

function errorResult(
  code: string,
  message = code,
  options?: { requestId?: string; runtimeId?: string | null },
): ProcessResult {
  return completed(envelope({ ok: false, error: { code, message } }, options), 1);
}

function executionScope(overrides: Partial<ExecutionScope> = {}): ExecutionScope {
  return {
    coordinationScopeId: 'scope-1',
    coordinatorSessionId: 'session-1',
    runtimeIncarnationId: 'incarnation-1',
    fencingGeneration: 1,
    backendIdentityRef: 'identity-ref',
    operationId: 'operation-1',
    target: { kind: 'dispatch', id: 'dispatch-1' },
    expectedRevision: 4,
    timeoutMs: 5_000,
    authority: { kind: 'route_planning' },
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

function unknownOutcome(outcome: OperationOutcome<unknown>): Extract<OperationOutcome<unknown>, { kind: 'unknown' }> {
  expect(outcome.kind).toBe('unknown');
  if (outcome.kind !== 'unknown') {
    throw new Error('expected unknown outcome');
  }
  return outcome;
}

function acceptedOutcome(outcome: OperationOutcome<unknown>): Extract<OperationOutcome<unknown>, { kind: 'accepted' }> {
  expect(outcome.kind).toBe('accepted');
  if (outcome.kind !== 'accepted') {
    throw new Error('expected accepted outcome');
  }
  return outcome;
}

const stopWorker: ExecutionMutation = { operation: 'worker-stop', dispatchId: 'dispatch-1' };
const updateTask: ExecutionMutation = {
  operation: 'task-update',
  taskId: 'task-1',
  status: 'completed',
};

test('未声明的操作在构造 argv 之前被拒绝，且不产生任何进程调用', async () => {
  const { runner, calls } = recordingTransport([]);
  const backend = backendWith(runner);

  const outcome = await backend.mutate(
    { operation: 'orchestration-reset' } as unknown as ExecutionMutation,
    executionScope(),
  );

  expect(outcome.kind).toBe('rejected');
  if (outcome.kind !== 'rejected') {
    return;
  }
  expect(outcome.code).toBe('undeclared_operation');
  expect(calls).toHaveLength(0);
});

test('查询入口不接受变更操作，变更入口也不接受查询操作', async () => {
  const { runner, calls } = recordingTransport([]);
  const backend = backendWith(runner);

  const asQuery = await backend.query({ operation: 'worker-stop', dispatchId: 'dispatch-1' } as unknown as ExecutionQuery);
  const asMutation = await backend.mutate(
    { operation: 'status' } as unknown as ExecutionMutation,
    executionScope(),
  );

  expect(asQuery.kind).toBe('rejected');
  expect(asMutation.kind).toBe('rejected');
  if (asQuery.kind === 'rejected') {
    expect(asQuery.code).toBe('operation_kind_mismatch');
  }
  if (asMutation.kind === 'rejected') {
    expect(asMutation.code).toBe('operation_kind_mismatch');
  }
  expect(calls).toHaveLength(0);
});

test('缺失或不完整的 ExecutionScope 不发起变更', async () => {
  const { runner, calls } = recordingTransport([]);
  const backend = backendWith(runner);

  const missing = await backend.mutate(stopWorker, undefined as unknown as ExecutionScope);
  const forged = await backend.mutate(stopWorker, { ...executionScope(), operationId: '' });

  expect(missing.kind).toBe('rejected');
  expect(forged.kind).toBe('rejected');
  if (missing.kind === 'rejected') {
    expect(missing.code).toBe('invalid_scope');
  }
  if (forged.kind === 'rejected') {
    expect(forged.code).toBe('invalid_scope');
  }
  expect(calls).toHaveLength(0);
});

test('环境目标无法确定时拒绝，且不猜测身份', async () => {
  const { runner, calls } = recordingTransport([]);
  const backend = createOrcaExecutionBackend({
    cwd: process.cwd(),
    env: {},
    runner,
    resolveIdentityHandle: () => undefined,
  });

  const outcome = await backend.mutate(updateTask, executionScope());

  expect(outcome.kind).toBe('rejected');
  if (outcome.kind === 'rejected') {
    expect(outcome.code).toBe('identity_unavailable');
  }
  expect(calls).toHaveLength(0);
});

test('身份来自 controller 的 scope，argv 使用解析出的 handle', async () => {
  const { runner, calls } = recordingTransport([okResult({ state: 'stopping' })]);
  const backend = backendWith(runner);

  await backend.mutate(updateTask, executionScope({ backendIdentityRef: 'coordinator-identity' }));

  expect(calls).toHaveLength(1);
  const args = calls[0]?.args ?? [];
  expect(args).toContain('--from');
  expect(args[args.indexOf('--from') + 1]).toBe('handle:coordinator-identity');
});

test('Worker 生命周期命令不注入当前 CLI 不支持的 --from，worker-list 只使用公开参数', async () => {
  const transport = recordingTransport([okResult({ state: 'stopping' }), okResult({ workers: [] })]);
  const backend = backendWith(transport.runner);

  await backend.mutate(stopWorker, executionScope());
  await backend.query({ operation: 'worker-list', runId: 'run-1', terminalState: 'active' });

  expect(transport.calls[0]?.args).toEqual([
    'orchestration',
    'worker-stop',
    '--dispatch',
    'dispatch-1',
    '--json',
  ]);
  expect(transport.calls[1]?.args).toEqual([
    'orchestration',
    'worker-list',
    '--json',
    '--run',
    'run-1',
    '--terminal-state',
    'active',
  ]);
});

test('运行时边界拒绝缺失字段、非法枚举和伪造 authority，且不启动进程', async () => {
  const { runner, calls } = recordingTransport([]);
  const backend = backendWith(runner);

  const missingField = await backend.mutate(
    { operation: 'worker-stop' } as unknown as ExecutionMutation,
    executionScope(),
  );
  const invalidEnum = await backend.query({
    operation: 'terminal-wait',
    terminal: 'term-1',
    waitFor: 'forever',
    timeoutMs: 100,
  } as unknown as ExecutionQuery);
  const forgedAuthority = await backend.mutate(updateTask, executionScope({
    authority: {
      kind: 'execution_coordination',
      graphGeneration: -1,
      authorizationId: '',
      runId: 'run-1',
      consumerGeneration: 1.5,
    },
  }));

  expect(missingField).toMatchObject({ kind: 'rejected', code: 'invalid_input' });
  expect(invalidEnum).toMatchObject({ kind: 'rejected', code: 'invalid_input' });
  expect(forgedAuthority).toMatchObject({ kind: 'rejected', code: 'invalid_scope' });
  expect(calls).toHaveLength(0);
});

test('身份无关的操作不因缺少句柄被拒，也不携带身份参数', async () => {
  // 建立专用终端时调用方还没有任何句柄：这类操作登记为 identity: 'none'。
  const mutation = recordingTransport([okResult({ terminal: { handle: 'term_new' } })]);
  const mutationBackend = createOrcaExecutionBackend({
    cwd: process.cwd(),
    env: {},
    runner: mutation.runner,
    resolveIdentityHandle: () => undefined,
  });

  const outcome = acceptedOutcome(
    await mutationBackend.mutate(
      { operation: 'terminal-create', worktree: 'path:/tmp/isolated-probe', title: 'probe coordinator' },
      executionScope(),
    ),
  );

  expect(outcome.value).toBeDefined();
  expect(mutation.calls).toHaveLength(1);
  const args = mutation.calls[0]?.args ?? [];
  expect(args).not.toContain('--from');
  expect(args).not.toContain('--terminal');

  const query = recordingTransport([completed('1.4.198')]);
  const queryBackend = createOrcaExecutionBackend({
    cwd: process.cwd(),
    env: {},
    runner: query.runner,
    resolveIdentityHandle: () => undefined,
  });
  expect(await queryBackend.query({ operation: 'version' })).toEqual({ kind: 'accepted', value: '1.4.198' });
});

test('确定失败仍然是 accepted，并保留原错误码与后端请求 id', async () => {
  const { runner } = recordingTransport([
    errorResult('task_not_startable', 'task is not startable', { requestId: 'req-start-1' }),
  ]);
  const backend = backendWith(runner);

  const accepted = acceptedOutcome(await backend.mutate(stopWorker, executionScope()));

  expect(accepted.value).toEqual({
    ok: false,
    code: 'task_not_startable',
    message: 'task is not startable',
  });
  expect(accepted.operation.operationId).toBe('operation-1');
  expect(accepted.operation.backendRequestId).toBe('req-start-1');
  expect(accepted.operation.target).toEqual({ kind: 'dispatch', id: 'dispatch-1' });
});

test.each(['start_unknown', 'stop_unknown', 'outcome_unknown', 'release_unknown', 'release_pending'])(
  '不确定状态 %s 分类为 unknown 并携带可用于对账的 OperationRef',
  async (code) => {
    const { runner } = recordingTransport([errorResult(code, `${code} reported`)]);
    const backend = backendWith(runner);

    const outcome = unknownOutcome(await backend.mutate(stopWorker, executionScope()));

    expect(outcome.reason).toContain(code);
    expect(outcome.operation.operationId).toBe('operation-1');
    expect(outcome.operation.backendRequestId).toBe('req-1');
  },
);

test('传输类故障按「是否抵达 runtime」区分 unknown 与可证明无副作用的拒绝', async () => {
  const reached = recordingTransport([errorResult('runtime_unavailable', 'runtime down')]);
  const notReached = recordingTransport([
    errorResult('runtime_unavailable', 'runtime down', { runtimeId: null }),
  ]);

  const unknown = unknownOutcome(await backendWith(reached.runner).mutate(stopWorker, executionScope()));
  expect(unknown.reason).toContain('runtime_unavailable');

  const rejected = await backendWith(notReached.runner).mutate(stopWorker, executionScope());
  expect(rejected.kind).toBe('rejected');
  if (rejected.kind === 'rejected') {
    expect(rejected.code).toBe('runtime_unavailable');
    expect(failureCategoryOf(rejected.code)).toBe('backend_unreachable');
  }
});

test('未登记的错误码 fail closed 为 unknown，不读作确定失败', async () => {
  const { runner } = recordingTransport([errorResult('brand_new_failure', 'unknown to us')]);
  const backend = backendWith(runner);

  const outcome = unknownOutcome(await backend.mutate(stopWorker, executionScope()));

  expect(outcome.reason).toContain('brand_new_failure');
});

test('进程已运行但结果读不出来时是 unknown，而不是确定失败', async () => {
  const { runner } = recordingTransport([completed('{ not json')]);
  const backend = backendWith(runner);

  const outcome = unknownOutcome(await backend.mutate(stopWorker, executionScope()));

  expect(outcome.reason).toContain('unparsable_output');
});

test('进程没能启动时是 rejected：请求从未离开 transport', async () => {
  const { runner } = recordingTransport([
    { kind: 'unavailable', code: 'process_spawn_failed', message: 'spawn orca ENOENT' },
  ]);
  const backend = backendWith(runner);

  const outcome = await backend.mutate(stopWorker, executionScope());

  expect(outcome.kind).toBe('rejected');
  if (outcome.kind === 'rejected') {
    expect(outcome.code).toBe('process_spawn_failed');
    expect(failureCategoryOf(outcome.code)).toBe('backend_unreachable');
  }
});

test('失败类别区分输入不合法、阶段不允许、scope 错误与能力缺失', () => {
  const cases: readonly (readonly [string, OrcaFailureClassification])[] = [
    ['invalid_argument', { disposition: 'accepted', category: 'invalid_input' }],
    ['stable_pane_required', { disposition: 'accepted', category: 'phase_not_allowed' }],
    ['run_not_found', { disposition: 'accepted', category: 'scope_error' }],
    ['stale_dispatch', { disposition: 'accepted', category: 'stale_attempt' }],
    ['method_not_found', { disposition: 'accepted', category: 'capability_missing' }],
  ];

  for (const [code, expected] of cases) {
    expect(classifyOrcaFailure({ code, reachedRuntime: true })).toEqual(expected);
  }
});

test('对账沿用原 OperationId 与后端请求 id，收据 completed 才视为已结', async () => {
  const { runner, calls } = recordingTransport([
    errorResult('runtime_timeout', 'timed out'),
    okResult({ requestId: 'req-1', state: 'completed', interpretation: 'request recorded' }),
  ]);
  const backend = backendWith(runner);

  const outcome = unknownOutcome(await backend.mutate(stopWorker, executionScope()));
  const reconciled = await reconcileOperation(backend, outcome.operation);

  expect(reconciled.kind).toBe('settled');
  expect(calls).toHaveLength(2);
  const reconcileArgs = calls[1]?.args ?? [];
  expect(reconcileArgs).toContain('request-show');
  expect(reconcileArgs[reconcileArgs.indexOf('--request') + 1]).toBe('req-1');
});

test.each(['pending', 'absent'])('对账得到 %s 时阻塞该通路且不重放 mutation', async (state) => {
  const { runner, calls } = recordingTransport([
    errorResult('start_unknown', 'unknown start'),
    okResult({ requestId: 'req-1', state, interpretation: 'not proof' }),
  ]);
  const backend = backendWith(runner);

  const outcome = unknownOutcome(await backend.mutate(stopWorker, executionScope()));
  const reconciled = await reconcileOperation(backend, outcome.operation);

  expect(reconciled.kind).toBe('blocked');
  if (reconciled.kind === 'blocked') {
    expect(reconciled.reason).toBe(state);
    expect(reconciled.operation.operationId).toBe('operation-1');
  }
  // 只有一次 mutation，加上一次只读对账。
  expect(calls).toHaveLength(2);
  expect(calls.filter((call) => call.args.includes('worker-stop'))).toHaveLength(1);
});

test('缺少后端请求 id 时对账直接阻塞，不发起第二次请求', async () => {
  const { runner, calls } = recordingTransport([]);
  const backend = backendWith(runner);
  const operation: OperationRef = { operationId: 'operation-1', target: { kind: 'dispatch', id: 'dispatch-1' } };

  const reconciled = await reconcileOperation(backend, operation);

  expect(reconciled).toEqual({ kind: 'blocked', operation, reason: 'no_backend_request_id' });
  expect(calls).toHaveLength(0);
});

test('查询成功时返回已校验结果，查询失败时是 rejected 而不是 unknown', async () => {
  const healthy = recordingTransport([
    okResult({
      runtime: {
        state: 'ready',
        reachable: true,
        runtimeId: 'runtime-1',
        capabilities: ['orchestration.contract.v1'],
      },
    }),
  ]);
  const accepted = await backendWith(healthy.runner).query({ operation: 'status' });
  expect(accepted.kind).toBe('accepted');
  if (accepted.kind === 'accepted') {
    expect(accepted.value).toEqual({
      state: 'ready',
      reachable: true,
      runtimeId: 'runtime-1',
      appVersion: null,
      capabilities: ['orchestration.contract.v1'],
    });
  }

  const broken = recordingTransport([okResult({ runtime: { state: 'ready' } })]);  const missingField = await backendWith(broken.runner).query({ operation: 'status' });
  expect(missingField.kind).toBe('rejected');
  if (missingField.kind === 'rejected') {
    expect(missingField.code).toBe('invalid_response');
  }

  const timedOut = recordingTransport([
    { kind: 'unknown', reason: 'timeout', stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } },
  ]);
  const queryTimeout = await backendWith(timedOut.runner).query({ operation: 'status' });
  expect(queryTimeout.kind).toBe('rejected');
  if (queryTimeout.kind === 'rejected') {
    expect(queryTimeout.code).toBe('process_timeout');
  }
});

test('保活行判定只认结构化的 _keepalive，不做子串匹配', async () => {
  const { isOrcaKeepaliveLine } = await import('../src/adapters/orca-cli/orca-backend.js');
  expect(isOrcaKeepaliveLine('{"_keepalive":true,"sequence":1}\n')).toBe(true);
  expect(isOrcaKeepaliveLine('warning: _keepalive mentioned in plain text\n')).toBe(false);
  expect(isOrcaKeepaliveLine('not json\n')).toBe(false);
});

test('解析器对齐公开 CLI 回执形状，未知状态 fail closed', () => {
  // worker-start 的已知字段在 result 顶层，`stage` 只在失败路径以 `failedStage` 出现。
  expect(
    parseWorkerStartReceipt({
      runId: 'run_1',
      taskId: 'task_1',
      dispatchId: 'ctx_1',
      state: 'ready',
      effects: [],
      residualResources: [],
    }),
  ).toEqual({
    ok: true,
    value: { state: 'ready', stage: null, runId: 'run_1', taskId: 'task_1', dispatchId: 'ctx_1' },
  });

  const failed = parseWorkerStartReceipt({ state: 'failed', failedStage: 'terminal_readiness', taskId: 'task_1' });
  expect(failed.ok && failed.value.stage).toBe('terminal_readiness');
  expect(parseWorkerStartReceipt({ state: 'brand_new_state' }).ok).toBe(false);
  expect(parseWorkerStartReceipt({ dispatchId: 'ctx_1' }).ok).toBe(false);

  const show = parseWorkerShow({
    dispatch: { id: 'ctx_1', task_id: 'task_1', run_id: 'run_1', status: 'completed' },
    worker: { dispatch_id: 'ctx_1', state: 'succeeded', stage: 'settled', agent_terminal_handle: 'term_worker' },
    observation: { status: 'live', exactWorker: true, agentWait: null },
  });
  expect(show.ok).toBe(true);
  if (show.ok) {
    expect(show.value).toMatchObject({
      dispatchId: 'ctx_1',
      taskId: 'task_1',
      dispatchStatus: 'completed',
      workerState: 'succeeded',
      workerStage: 'settled',
      agentTerminalHandle: 'term_worker',
      observationStatus: 'live',
      exactWorker: true,
    });
  }

  // dispatch 可以为 null；缺少 worker 的必填 state 才是 fail closed 的情况。
  const noDispatch = parseWorkerShow({ dispatch: null, worker: { state: 'ready' } });
  expect(noDispatch.ok && noDispatch.value.dispatchId).toBeNull();
  expect(parseWorkerShow({ dispatch: null }).ok).toBe(false);
});
