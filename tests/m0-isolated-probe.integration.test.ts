import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import type { DeliveryMessage, OperationOutcome } from '../src/application/dto/operation-outcome.js';
import type { ExecutionScope } from '../src/application/ports/execution-backend.js';
import { ackDelivery, readDeliveryBatch } from '../src/adapters/orca-cli/delivery-reader.js';
import { readRecord } from '../src/adapters/orca-cli/operation-catalog.js';
import { createOrcaExecutionBackend } from '../src/adapters/orca-cli/orca-backend.js';
import { runProcess } from '../src/adapters/orca-cli/process-runner.js';
import { toChildEnvironment } from '../src/interfaces/cli/main.js';

/**
 * IP-11：M0 隔离真实控制闭环探针。
 *
 * 默认跳过，只在 `ORCA_M0_PROBE=1` 时运行。探针自行 `mktemp` 一次性仓库、创建专用协调终端与自建 Run，
 * 不触碰主项目、不重启全局 Orca runtime、不读取或影响无关的既有终端与 workload。
 * 结束后保留现场供检查；清理需要另行授权。
 */

const PROBE_ENABLED = process.env['ORCA_M0_PROBE'] === '1';
const EXPECTED_WORKER_MODEL = 'minimax-cn/MiniMax-M3';
const COORDINATOR_REF = 'probe-coordinator';
const COMPANION_REPO = process.cwd();

/** 派发前必须存在的显式 Worker 模型绑定；缺失或不是 MiniMax-M3 即在派发前失败。 */
export function requireWorkerModel(env: Readonly<Record<string, string | undefined>>): string {
  const model = env['ORCA_M0_PROBE_MODEL'];
  if (model === undefined || model.length === 0) {
    throw new Error(
      `探针必须在派发前显式绑定 Worker Profile：设置 ORCA_M0_PROBE_MODEL=${EXPECTED_WORKER_MODEL}`,
    );
  }
  if (model !== EXPECTED_WORKER_MODEL) {
    throw new Error(`探针只允许 ${EXPECTED_WORKER_MODEL}，收到 ${model}`);
  }
  return model;
}

/** 隔离边界自检：目标必须在系统临时目录下，且不是 Companion 主项目本身。 */
export function assertIsolatedTarget(repoDir: string, companionRepo: string): void {
  const tempRoot = tmpdir();
  if (!repoDir.startsWith(`${tempRoot}${path.sep}`)) {
    throw new Error(`探针目标 ${repoDir} 不在 ${tempRoot} 下，拒绝越界执行`);
  }
  if (repoDir === companionRepo || companionRepo.startsWith(`${repoDir}${path.sep}`)) {
    throw new Error(`探针目标 ${repoDir} 覆盖 Companion 主项目，拒绝越界执行`);
  }
}

function probeScope(operationId: string, targetId: string, timeoutMs: number): ExecutionScope {
  return {
    coordinationScopeId: 'm0-probe-scope',
    coordinatorSessionId: 'm0-probe-session',
    runtimeIncarnationId: 'm0-probe-incarnation',
    fencingGeneration: 1,
    backendIdentityRef: COORDINATOR_REF,
    operationId,
    target: { kind: 'probe', id: targetId },
    expectedRevision: 0,
    timeoutMs,
    authority: { kind: 'route_planning' },
  };
}

function accepted<T>(outcome: OperationOutcome<T>): Extract<OperationOutcome<T>, { kind: 'accepted' }> {
  if (outcome.kind !== 'accepted') {
    throw new Error(`期望 accepted，实际 ${outcome.kind}: ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

function payloadOf(message: DeliveryMessage | undefined): Record<string, unknown> {
  const parsed: unknown = message?.payload === null || message?.payload === undefined ? {} : JSON.parse(message.payload);
  return readRecord(parsed) ?? {};
}

test('缺少显式 Worker 模型绑定时在派发前失败', () => {
  expect(() => requireWorkerModel({})).toThrow(/MiniMax-M3/);
  expect(() => requireWorkerModel({ ORCA_M0_PROBE_MODEL: 'gpt-5.6-sol' })).toThrow(/只允许/);
  expect(requireWorkerModel({ ORCA_M0_PROBE_MODEL: EXPECTED_WORKER_MODEL })).toBe(EXPECTED_WORKER_MODEL);
});

test('隔离边界自检拒绝临时目录之外或指向主项目的目标', () => {
  const inside = path.join(tmpdir(), 'orca-companion-m0-probe.example');
  expect(() => {
    assertIsolatedTarget(inside, COMPANION_REPO);
  }).not.toThrow();
  expect(() => {
    assertIsolatedTarget(COMPANION_REPO, COMPANION_REPO);
  }).toThrow(/越界/);
  expect(() => {
    assertIsolatedTarget(path.dirname(COMPANION_REPO), COMPANION_REPO);
  }).toThrow(/越界/);
});

describe.skipIf(!PROBE_ENABLED)('M0 隔离真实控制闭环', () => {
  test('协调身份、单 Worker 闭环、确认后不重放与重连不重复派发', async () => {
    const workerModel = requireWorkerModel(process.env);
    const repoDir = mkdtempSync(path.join(tmpdir(), 'orca-companion-m0-probe.'));
    assertIsolatedTarget(repoDir, COMPANION_REPO);

    const env = toChildEnvironment(process.env);
    // 句柄在 runtime 作用域内解析一次，之后只经不透明引用使用。
    const identity: { handle: string | undefined } = { handle: undefined };
    const backend = createOrcaExecutionBackend({
      cwd: repoDir,
      env,
      resolveIdentityHandle: (ref) => (ref === COORDINATOR_REF ? identity.handle : undefined),
    });

    // 1. 一次性隔离仓库：无 remote、无 commit，只有探针夹具。
    const git = async (args: readonly string[]) => {
      const result = await runProcess({
        executable: 'git',
        args: [...args],
        cwd: repoDir,
        env,
        timeoutMs: 30_000,
      });
      expect(result.kind).toBe('completed');
      return result;
    };
    await git(['init', '-b', 'main']);
    writeFileSync(path.join(repoDir, 'README.md'), '# M0 isolated probe\n', 'utf8');
    writeFileSync(path.join(repoDir, 'probe-input.txt'), 'pending\n', 'utf8');

    // 隔离夹具注册：这是探针自己的现场搭建，不属于控制闭环；
    // M0 的 operation catalog 只登记控制闭环命令，且 Orca 没有公开的 repo remove。
    const registered = await runProcess({
      executable: 'orca',
      args: ['repo', 'add', '--path', repoDir, '--json'],
      cwd: repoDir,
      env,
      timeoutMs: 60_000,
    });
    expect(registered.kind).toBe('completed');

    // 2. 专用协调终端：用 worktree 选择器 + 存活核验取得句柄，不从 create 结果猜字段。
    const created = await backend.mutate(
      {
        operation: 'terminal-create',
        worktree: `path:${repoDir}`,
        title: 'M0 probe coordinator',
        command: process.env['SHELL'] ?? 'sh',
      },
      probeScope('probe-terminal-create', repoDir, 60_000),
    );
    accepted(created);

    const listed = await backend.query({ operation: 'terminal-list', worktree: `path:${repoDir}` });
    expect(listed.kind).toBe('accepted');
    if (listed.kind !== 'accepted') {
      return;
    }
    const terminals = listed.value as {
      readonly terminals: readonly { readonly handle: string; readonly connected: boolean; readonly writable: boolean }[];
    };
    const live = terminals.terminals.find((terminal) => terminal.connected && terminal.writable);
    expect(live).toBeDefined();
    identity.handle = live?.handle;
    expect(identity.handle).toBeDefined();

    // 3. 专用 Run：绑定型命令必须接受这个 CLI 自建终端。
    const runCreated = await backend.mutate(
      { operation: 'run-create', objective: 'Orca Companion M0 isolated control-loop probe (m0-orca-control-baseline)' },
      probeScope('probe-run-create', repoDir, 60_000),
    );
    accepted(runCreated);

    const current = await backend.query({ operation: 'run-current', backendIdentityRef: COORDINATOR_REF });
    expect(current.kind).toBe('accepted');
    if (current.kind !== 'accepted') {
      return;
    }
    const run = (current.value as { readonly run: { readonly runId: string } | null }).run;
    expect(run).not.toBeNull();
    const runId = run?.runId ?? '';
    expect(runId.length).toBeGreaterThan(0);

    // 4. 唯一 Task 与唯一受监督 Worker；模型在派发前已显式绑定。
    const taskSpec = [
      'You are the single M0 probe worker in a throwaway repository.',
      `Work only inside ${repoDir}.`,
      'Do not commit, push, publish, deploy, install dependencies, or use the network.',
      'Change probe-input.txt to contain the exact text "probe-ok" (single trailing newline).',
      'Write probe-report.json with {"status":"ok","model":"' + workerModel + '"} and nothing else.',
      'When done, report the absolute path of probe-report.json.',
    ].join(' ');

    const taskCreated = await backend.mutate(
      {
        operation: 'task-create',
        spec: taskSpec,
        runId,
        taskTitle: 'M0 isolated probe worker',
        displayName: 'M0 probe worker',
      },
      probeScope('probe-task-create', repoDir, 60_000),
    );
    const taskOutcome = accepted(taskCreated);
    // task-create 没有登记 parser；只在上层需要的字段上校验，其余保留原始结果。
    const taskRecord = readRecord(taskOutcome.value);
    const taskContainer = taskRecord === undefined ? undefined : readRecord(taskRecord['task']);
    const resolvedTaskId = typeof taskContainer?.['id'] === 'string' ? taskContainer['id'] : undefined;
    expect(resolvedTaskId).toBeDefined();
    if (resolvedTaskId === undefined) {
      return;
    }

    const started = accepted(
      await backend.mutate(
        {
          operation: 'worker-start',
          taskId: resolvedTaskId,
          agent: 'codex',
          model: workerModel,
          worktree: `path:${repoDir}`,
          runId,
          timeoutMs: 180_000,
        },
        probeScope('probe-worker-start', resolvedTaskId, 240_000),
      ),
    );
    const receipt = started.value as { readonly state: string; readonly dispatchId: string | null };
    expect(receipt.state).toBe('ready');

    // 5. 等待唯一 worker_done 并校验 task/dispatch 归属。
    let deliveryMessage: DeliveryMessage | undefined;
    let dispatchId = receipt.dispatchId;
    for (let attempt = 0; attempt < 6 && deliveryMessage === undefined; attempt += 1) {
      const batch = await readDeliveryBatch(backend, {
        backendIdentityRef: COORDINATOR_REF,
        runId,
        wait: true,
        types: ['worker_done', 'escalation', 'question'],
        timeoutMs: 60_000,
        readMode: 'default',
      });
      expect(batch.kind).toBe('accepted');
      if (batch.kind !== 'accepted') {
        return;
      }
      deliveryMessage = batch.value.messages.find((message) => message.type === 'worker_done');
      if (deliveryMessage !== undefined) {
        // 有消息可处理时必须有稳定 Delivery identity，否则不能确认。
        const delivery = batch.value.delivery;
        expect(delivery).not.toBeNull();
        if (delivery === null) {
          return;
        }
        const payload = payloadOf(deliveryMessage);
        expect(payload['taskId']).toBe(resolvedTaskId);
        dispatchId = typeof payload['dispatchId'] === 'string' ? payload['dispatchId'] : dispatchId;
        // 处理完结果后才确认。
        const ack = await ackDelivery(
          backend,
          probeScope('probe-delivery-ack', resolvedTaskId, 60_000),
          delivery,
        );
        expect(ack.kind).toBe('accepted');
      }
    }
    expect(deliveryMessage).toBeDefined();

    // Worker 的产出可独立核对。
    const report = await runProcess({
      executable: 'cat',
      args: [path.join(repoDir, 'probe-report.json')],
      cwd: repoDir,
      env,
      timeoutMs: 10_000,
    });
    expect(report.kind).toBe('completed');
    if (report.kind === 'completed') {
      expect(report.stdout.text).toContain('"status"');
    }

    // 6. 重连：无进程内状态的新调用找回同一 Run、Task、Dispatch，且没有第二个 Dispatch。
    const fresh = createOrcaExecutionBackend({
      cwd: repoDir,
      env,
      resolveIdentityHandle: (ref) => (ref === COORDINATOR_REF ? identity.handle : undefined),
    });
    const rebound = accepted(
      await fresh.mutate(
        { operation: 'run-use', runId },
        probeScope('probe-run-use', runId, 60_000),
      ),
    );
    expect(rebound.value).toBeDefined();

    const workers = await fresh.query({ operation: 'worker-list', runId });
    expect(workers.kind).toBe('accepted');
    if (workers.kind !== 'accepted') {
      return;
    }
    const entries = (workers.value as { readonly workers: readonly { readonly dispatchId: string | null }[] }).workers;
    expect(entries).toHaveLength(1);
    if (dispatchId !== null && dispatchId !== undefined) {
      expect(entries[0]?.dispatchId).toBe(dispatchId);
    }

    // 确认后不再重放同一批次。
    const replay = await readDeliveryBatch(backend, { backendIdentityRef: COORDINATOR_REF, runId, readMode: 'peek' });
    expect(replay.kind).toBe('accepted');
    if (replay.kind === 'accepted') {
      expect(replay.value.messages).toEqual([]);
    }
  }, 900_000);
});
