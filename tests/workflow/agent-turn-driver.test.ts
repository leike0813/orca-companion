import { expect, test } from 'vitest';

import type { CoordinatorSessionId } from '../../src/application/dto/identity.js';
import type {
  AgentTurnFailure,
  AgentTurnExecution,
  AgentTurnPort,
  AgentTurnResult,
  AgentTurnState,
} from '../../src/application/ports/agent-turn.js';
import type { CheckpointWriteResult } from '../../src/application/coordinator/runtime-guard.js';
import { AgentTurnDriver } from '../../src/workflow/coordinator/turn-driver.js';

const SESSION = 'session-a' as CoordinatorSessionId;

/** 内存 port：durable 状态就是最后一次成功写入的值，因此可以跨实例模拟重启。 */
function memoryPort(initial: AgentTurnState = { kind: 'idle' }) {
  const durable = { value: initial };
  const writes: AgentTurnState[] = [];
  let failOn: string | null = null;
  let throwing = false;
  const port: AgentTurnPort = {
    readTurnState: () => {
      if (throwing) throw new Error('database is closed');
      return durable.value;
    },
    writeTurnState: (_id, state): CheckpointWriteResult => {
      writes.push(state);
      if (throwing) throw new Error('database is closed');
      if (failOn === state.kind) return { kind: 'failed', message: 'turn write failed' };
      durable.value = state;
      return { kind: 'saved' };
    },
  };
  return {
    port,
    writes,
    durable: () => durable.value,
    failOn: (kind: string | null) => { failOn = kind; },
    close: () => { throwing = true; },
  };
}

function driverOf(port: AgentTurnPort, execute: (signal: AbortSignal) => Promise<AgentTurnResult>, isClosing?: () => boolean) {
  return new AgentTurnDriver({
    coordinatorSessionId: SESSION,
    turns: port,
    execute,
    ...(isClosing === undefined ? {} : { isClosing }),
  });
}

const completed: AgentTurnResult = { kind: 'completed' };
const ok: AgentTurnExecution = () => Promise.resolve(completed);
const counting = (onCall: () => void): AgentTurnExecution => () => {
  onCall();
  return Promise.resolve(completed);
};
const halting = (failure: AgentTurnFailure): AgentTurnExecution => () => Promise.resolve({ kind: 'halted', failure });

test('observers see a durable running turn and its settled state', async () => {
  const store = memoryPort(), gate = Promise.withResolvers<AgentTurnResult>(), states: AgentTurnState[] = [];
  const driver = new AgentTurnDriver({ coordinatorSessionId: SESSION, turns: store.port,
    execute: () => gate.promise, onStateChange: state => states.push(state) });
  const running = driver.run();
  expect(store.durable().kind).toBe('running');
  expect(states.at(-1)?.kind).toBe('running');
  gate.resolve(completed);
  await running;
  expect(states.at(-1)?.kind).toBe('idle');
  expect(driver.state.kind).toBe('idle');
});

test('并发恢复仅一个核验结果可以放行，迟到结果不能覆盖新轮次故障', async () => {
  const store = memoryPort({ kind: 'halted', failure: { code: 'stopped', message: '停止' } });
  const driver = driverOf(store.port, halting({ code: 'execution_failed', message: '新的故障' }));
  const first = Promise.withResolvers<boolean>();
  const late = Promise.withResolvers<boolean>();
  const a = driver.retry(() => first.promise);
  const b = driver.retry(() => late.promise);
  first.resolve(true);
  expect((await a).kind).toBe('cleared');
  await driver.run();
  late.resolve(true);
  expect((await b).kind).toBe('rejected');
  expect(store.durable()).toMatchObject({ kind: 'halted', failure: { code: 'execution_failed' } });
});

test('恢复核验等待期间的新停止或退出不能被迟到的核验结果清除', async () => {
  for (const exiting of [false, true]) {
    const store = memoryPort({ kind: 'halted', failure: { code: 'stopped', message: '停止' } });
    let closing = false;
    const driver = driverOf(store.port, ok, () => closing);
    const gate = Promise.withResolvers<boolean>();
    const retry = driver.retry(() => gate.promise);
    if (exiting) closing = true;
    else driver.stop();
    gate.resolve(true);
    expect((await retry).kind).toBe('rejected');
    expect(driver.halted).toBe(true);
    expect(store.durable().kind).toBe('halted');
  }
});

test('持久化失败时不发出任何请求：running 落盘失败后本进程停止', async () => {
  const store = memoryPort();
  store.failOn('running');
  let requests = 0;
  const driver = driverOf(store.port, counting(() => { requests += 1; }));

  const outcome = await driver.run();

  expect(requests).toBe(0);
  expect(outcome.kind).toBe('stopped');
  expect(outcome.kind === 'stopped' && outcome.failure.code).toBe('state_unavailable');
  expect(driver.halted).toBe(true);
});

test('重新打开读到 halted 或未结束的 running 时不自动跑，必须明确 retry', async () => {
  const haltedStore = memoryPort({ kind: 'halted', failure: { code: 'execution_failed', message: '提交失败' } });
  let haltedRequests = 0;
  const halted = driverOf(haltedStore.port, counting(() => { haltedRequests += 1; }));
  expect(await halted.run()).toMatchObject({ kind: 'stopped' });
  expect(haltedRequests).toBe(0);

  const runningStore = memoryPort({ kind: 'running' });
  let runningRequests = 0;
  const interrupted = driverOf(runningStore.port, counting(() => { runningRequests += 1; }));
  expect(interrupted.halted).toBe(true);
  expect(await interrupted.run()).toMatchObject({ kind: 'stopped', failure: { code: 'interrupted' } });
  expect(runningRequests).toBe(0);

  expect((await interrupted.retry(() => true)).kind).toBe('cleared');
  expect(await interrupted.run()).toEqual({ kind: 'completed' });
  expect(runningRequests).toBe(1);
});

test('retry 的核验回调不通过时保持停止，且不写回状态', async () => {
  const store = memoryPort({ kind: 'halted', failure: { code: 'stopped', message: '用户停止' } });
  const driver = driverOf(store.port, ok);
  const writesBefore = store.writes.length;

  const rejected = await driver.retry(() => false);

  expect(rejected).toMatchObject({ kind: 'rejected', failure: { code: 'recovery_rejected' } });
  expect(driver.halted).toBe(true);
  expect(store.writes.length).toBe(writesBefore);
  expect((await driver.retry(() => { throw new Error('lease lost'); })).kind).toBe('rejected');
  expect(driver.halted).toBe(true);
});

test('执行抛错与宿主停止都落为 halted，同一实例不再自动跑', async () => {
  const store = memoryPort();
  let requests = 0;
  const driver = driverOf(store.port, () => {
    requests += 1;
    return Promise.reject(new Error('provider stream broke'));
  });

  const outcome = await driver.run();

  expect(outcome).toMatchObject({ kind: 'stopped', failure: { code: 'execution_failed' } });
  expect(store.durable()).toMatchObject({ kind: 'halted', failure: { code: 'execution_failed' } });
  expect(await driver.run()).toMatchObject({ kind: 'stopped' });
  expect(requests).toBe(1);
});

test('宿主把图结局映射为 halted 时按结构化原因落盘', async () => {
  const store = memoryPort();
  const driver = driverOf(store.port, halting({ code: 'halted_by_host', message: '图停在 tools 节点' }));

  expect(await driver.run()).toMatchObject({ kind: 'stopped', failure: { code: 'halted_by_host' } });
  expect(store.durable()).toEqual({ kind: 'halted', failure: { code: 'halted_by_host', message: '图停在 tools 节点' } });
});

test('正常结束写 idle；idle 落盘失败时不留下可自动再跑的状态', async () => {
  const store = memoryPort();
  const driver = driverOf(store.port, ok);
  expect(await driver.run()).toEqual({ kind: 'completed' });
  expect(store.durable()).toEqual({ kind: 'idle' });

  const failing = memoryPort();
  failing.failOn('idle');
  const stopped = driverOf(failing.port, ok);
  expect(await stopped.run()).toMatchObject({ kind: 'stopped', failure: { code: 'state_unavailable' } });
  expect(failing.durable()).toEqual({ kind: 'running' });
  expect(stopped.halted).toBe(true);
});

test('stop 同步 abort 在途请求并落为 halted；退出期间不再写存储', async () => {
  const store = memoryPort();
  let aborted = false;
  const gate: { release: (() => void) | null } = { release: null };
  const driver = driverOf(store.port, (signal) => new Promise<AgentTurnResult>((resolve) => {
    signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    gate.release = () => resolve(completed);
  }));

  const run = driver.run();
  await Promise.resolve();
  const failure = driver.stop();

  expect(failure.code).toBe('stopped');
  expect(aborted).toBe(true);
  expect(store.durable()).toEqual({ kind: 'halted', failure });
  gate.release?.();
  await run;

  const closing = memoryPort({ kind: 'idle' });
  const exitDriver = driverOf(closing.port, ok, () => true);
  exitDriver.stop();
  expect(closing.writes).toEqual([]);
  expect(exitDriver.halted).toBe(true);
});

test('同一实例只允许一个活跃轮次：排队的 run 不绕过停止检查', async () => {
  const store = memoryPort();
  let requests = 0;
  const pending: { release: (() => void) | null } = { release: null };
  const driver = driverOf(store.port, () => {
    requests += 1;
    if (requests > 1) return Promise.resolve(completed);
    return new Promise<AgentTurnResult>((resolve) => { pending.release = () => resolve(completed); });
  });

  const first = driver.run();
  await Promise.resolve();
  const queued = await driver.run();
  pending.release?.();
  expect(await first).toEqual({ kind: 'completed' });

  expect(queued.kind).toBe('stopped');
  expect(requests).toBe(1);
  // 第一轮之后仍可用：活跃标志只约束并发，不变成持久停止。
  expect(await driver.run()).toEqual({ kind: 'completed' });
});

test('请求期间 stop 之后 execute 正常返回也不落 idle', async () => {
  const store = memoryPort();
  const pending: { release: (() => void) | null } = { release: null };
  const driver = driverOf(store.port, () => new Promise<AgentTurnResult>((resolve) => {
    pending.release = () => resolve(completed);
  }));

  const run = driver.run();
  await Promise.resolve();
  driver.stop();
  pending.release?.();

  expect(await run).toMatchObject({ kind: 'stopped', failure: { code: 'stopped' } });
  expect(store.durable()).toMatchObject({ kind: 'halted', failure: { code: 'stopped' } });
});

test('退出期间既不执行也不写存储', async () => {
  const store = memoryPort();
  let requests = 0;
  const driver = driverOf(store.port, counting(() => { requests += 1; }), () => true);

  expect(await driver.run()).toMatchObject({ kind: 'stopped', failure: { code: 'state_unavailable' } });
  expect(requests).toBe(0);
  expect(store.writes).toEqual([]);
});

test('run 与 state 重读持久状态：别的进程留下的 halted/running 都按停止处理', async () => {
  const store = memoryPort();
  let requests = 0;
  const driver = driverOf(store.port, counting(() => { requests += 1; }));

  store.port.writeTurnState(SESSION, { kind: 'halted', failure: { code: 'halted_by_host', message: '别的进程已停止' } });
  expect(await driver.run()).toMatchObject({ kind: 'stopped', failure: { code: 'halted_by_host' } });

  expect(requests).toBe(0);

  const reopened = memoryPort({ kind: 'running' });
  const interrupted = driverOf(reopened.port, counting(() => { requests += 1; }));
  expect(interrupted.state).toMatchObject({ kind: 'halted', failure: { code: 'interrupted' } });
  expect(await interrupted.run()).toMatchObject({ kind: 'stopped', failure: { code: 'interrupted' } });
  expect(requests).toBe(0);
});

test('默认不把 provider 原始错误消息写进持久状态', async () => {
  const store = memoryPort();
  const driver = driverOf(store.port, () => Promise.reject(new Error('sk-live-SECRET leaked in upstream message')));

  const outcome = await driver.run();

  expect(outcome.kind === 'stopped' && outcome.failure).toEqual({ code: 'execution_failed', message: 'Error' });
  expect(JSON.stringify(store.durable())).not.toContain('SECRET');
});

test('宿主已有的 modelAbort 桥接后同步中止轮次；损坏的持久行按停止处理', async () => {
  const store = memoryPort();
  const controller = new AbortController();
  let aborted = false;
  const driver = new AgentTurnDriver({
    coordinatorSessionId: SESSION,
    turns: store.port,
    bridgeSignal: controller.signal,
    execute: (signal) => new Promise<AgentTurnResult>((resolve) => {
      signal.addEventListener('abort', () => { aborted = true; resolve({ kind: 'completed' }); }, { once: true });
    }),
  });
  void driver.run();
  await Promise.resolve();
  controller.abort();
  expect(aborted).toBe(true);
  expect(driver.state).toMatchObject({ kind: 'halted', failure: { code: 'stopped' } });

  const corrupt = memoryPort();
  corrupt.close();
  const unreadable = driverOf(corrupt.port, ok);
  expect(unreadable.state).toMatchObject({ kind: 'halted', failure: { code: 'state_unavailable' } });
});

test('失败原因带上限，宿主给出的长诊断不会放大持久记录', async () => {
  const store = memoryPort();
  const long: AgentTurnFailure = { code: 'execution_failed', message: 'x'.repeat(5_000) };
  const driver = driverOf(store.port, halting(long));

  const outcome = await driver.run();

  expect(outcome.kind === 'stopped' && outcome.failure.message.length).toBe(512);
  const durable = store.durable();
  expect(durable.kind === 'halted' && durable.failure.message.length).toBe(512);
});
