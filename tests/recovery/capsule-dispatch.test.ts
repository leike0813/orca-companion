/**
 * IP-04 的行为测试：Recovery Capsule 的**提取接线**（change: `m2-wire-execution-runtime`）。
 *
 * 覆盖三件事，全部走生产路径（真实 store、真实受限 Utility Worker 派发、fake Orca/transport）：
 *
 * - 派发：`dispatchCapsuleWorker` 用 `recovery-capsule-extraction` 信封派发 Task 与 Worker，并用只读
 *   沙箱启动策略；
 * - 读回：Capsule 报告走 Delivery 传输原语读回，按 Orca 身份配对消息、按 host 证据校验 coverage，
 *   并且**只在整批都属于本次派发时**交回 Delivery 身份（由调用方落盘后确认）；
 * - 正文：按 `capsuleRef` 确定性落点写入 Companion 私有状态根，能回读、能识别损坏。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'vitest';

import {
  buildUtilityWorkerEnvelope,
  dispatchCapsuleWorker,
} from '../../src/adapters/agents/utility-worker.js';
import {
  createCodexWorkerLaunch,
  installCodexSessionStartReporter,
} from '../../src/adapters/agents/codex-launch.js';
import {
  capsuleLaunchIdOf,
  codexSessionPathsUnder,
} from '../../src/bootstrap/execution-runtime.js';
import {
  capsuleRefOf,
  readRecoveryCapsuleBody,
  writeRecoveryCapsuleBody,
  type RecoveryCapsule,
  type TranscriptCoverageEvidence,
} from '../../src/application/recovery/recovery-capsule.js';
import type { ExecutionScope } from '../../src/application/ports/execution-backend.js';
import type { OperationOutcome } from '../../src/application/dto/operation-outcome.js';
import {
  RECOVERY_AUTHORIZATION,
  RECOVERY_SCOPE,
  RECOVERY_WORK_PACKAGE,
  RECOVERY_WORKER_TASK,
  createRecoveryHarness,
  fakeRecoveryBackend,
  type RecoveryHarness,
} from '../support/recovery-harness.js';
import type { OperationId, SessionSegmentId } from '../../src/application/dto/identity.js';

const SEGMENT = 'segment:capsule-dispatch:1' as SessionSegmentId;
const TRANSCRIPT = 'transcript:capsule-dispatch:1';
const CAPSULE_TASK = 'task-capsule-1';
const CAPSULE_DISPATCH = 'dispatch-capsule-1';
const SESSION_ID = 'session-capsule-codex';

let harness: RecoveryHarness | null = null;
let scratch = '';

afterEach(() => {
  harness?.close();
  harness = null;
  if (scratch.length > 0) {
    rmSync(scratch, { recursive: true, force: true });
    scratch = '';
  }
});

/** host 侧独立读到的覆盖证据：Worker 报告的这些字段必须逐项等于它。 */
const EVIDENCE: TranscriptCoverageEvidence = {
  coverage: 'complete',
  readableRange: {
    transcriptRef: TRANSCRIPT,
    fromEventRef: 'event-1',
    toEventRef: 'event-9',
  },
  gaps: [],
  lastCompleteEventRef: 'event-9',
};

const CAPSULE: RecoveryCapsule = {
  coverage: 'complete',
  readableRange: EVIDENCE.readableRange,
  gaps: [],
  lastCompleteEventRef: 'event-9',
  openActions: [{ actionRef: 'action-1', description: '已写规格，未提交', sourceRef: 'event-8' }],
  sourceRefs: ['event-1', 'event-9'],
  unknowns: [],
};

function accepted(scope: ExecutionScope, value: unknown): OperationOutcome<unknown> {
  // 回执身份必须与本次 intent 一致：store 会逐项核对 OperationId 与 target。
  return {
    kind: 'accepted',
    operation: { operationId: scope.operationId, target: scope.target },
    value,
  };
}

/** 与生产实现同源的工作区/报告准备：只写报告与 transcript，不做任何事实伪造。 */
function prepareCodexSession(input: {
  readonly stateRoot: string;
  readonly launchId: string;
  readonly worktree: string;
}): { readonly reportPath: string; readonly transcriptPath: string; readonly codexHome: string } {
  const paths = codexSessionPathsUnder(input.stateRoot, input.launchId);
  installCodexSessionStartReporter(paths);
  const codexHome = join(paths.stateRoot, 'codex-home');
  const sessions = join(codexHome, 'sessions', '2026', '09', '25');
  mkdirSync(sessions, { recursive: true });
  const transcriptPath = join(sessions, `rollout-2026-09-25T00-00-00-${SESSION_ID}.jsonl`);
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({ timestamp: '2026-09-25T00:00:00.000Z', ordinal: 0, type: 'session_meta', payload: { id: SESSION_ID, cwd: input.worktree } })}\n`,
    'utf8',
  );
  mkdirSync(paths.reportPath.slice(0, paths.reportPath.lastIndexOf('/')), { recursive: true });
  return { reportPath: paths.reportPath, transcriptPath, codexHome };
}

test('Capsule 提取：受限 Utility Worker 派发、按 Orca 身份读回报告并交回 Delivery 身份', { timeout: 30_000 }, async () => {
  harness = createRecoveryHarness();
  harness.recordSourceSegment({
    segmentId: SEGMENT,
    dispatchId: 'ctx-capsule-source',
    attemptId: 'attempt-capsule-1',
    sessionBindingId: 'binding-capsule-1',
    lastTranscriptRef: TRANSCRIPT,
    transcriptReferenceable: true,
    verifiable: true,
  });
  scratch = mkdtempSync(join(tmpdir(), 'capsule-dispatch-'));
  const worktree = join(scratch, 'worktree');
  mkdirSync(worktree, { recursive: true });
  const stateRoot = join(scratch, 'state');
  const launchId = capsuleLaunchIdOf(SEGMENT);
  const report = prepareCodexSession({ stateRoot, launchId, worktree });
  const launch = createCodexWorkerLaunch({
    launchId,
    model: 'worker-model',
    sandboxMode: 'read-only',
    stateRoot,
    sessionStartReporterPath: codexSessionPathsUnder(stateRoot, launchId).reporterPath,
  });

  let started = 0;
  const backend = fakeRecoveryBackend({
    mutate: (input, scope) => {
      if (input.operation === 'task-create') {
        return accepted(scope, { id: CAPSULE_TASK, spec: input.spec ?? '' });
      }
      if (input.operation === 'terminal-create') {
        return accepted(scope, { handle: 'terminal-capsule' });
      }
      if (input.operation === 'worker-start') {
        started += 1;
        // 真实 Codex 进程启动时会写出 SessionStart 报告：这里按同一形状补上，绑定才有事实可依。
        writeFileSync(
          report.reportPath,
          `${JSON.stringify({
            sessionId: SESSION_ID,
            transcriptPath: report.transcriptPath,
            codexHome: report.codexHome,
            cwd: worktree,
            observedAt: new Date().toISOString(),
          })}\n`,
          'utf8',
        );
        return accepted(scope, { taskId: CAPSULE_TASK, dispatchId: CAPSULE_DISPATCH, state: 'ready' });
      }
      return undefined;
    },
    query: (input) => {
      if (input.operation === 'task-list') {
        // 没有已派发的同一个 Utility Worker：走新建派发路径（装置默认的 `{}` 也让该查询读不出任务）。
        return { kind: 'accepted', value: { tasks: [] } };
      }
      if (input.operation === 'terminal-list') {
        // prepared terminal 的核验要求完整列举：不完整时生产实现会拒绝猜测。
        return {
          kind: 'accepted',
          value: {
            terminals: [
              { handle: 'terminal-capsule', connected: true, writable: true, title: launch.title },
            ],
            omittedHostIds: [],
            truncated: false,
          },
        };
      }
      if (input.operation === 'worker-show') {
        return {
          kind: 'accepted',
          value: { exactWorker: true, agentTerminalHandle: 'terminal-capsule', workerState: 'running' },
        };
      }
      if (input.operation === 'delivery-read') {
        return {
          kind: 'accepted',
          value: {
            delivery: { deliveryId: 'delivery-capsule', runId: 'run-capsule' },
            messages: [
              {
                messageId: 'message-capsule',
                runId: 'run-capsule',
                deliveryContract: 'current_delivery',
                fromHandle: 'terminal-capsule',
                toHandle: 'coordinator',
                type: 'worker_done',
                subject: 'Recovery Capsule',
                priority: null,
                body: 'capsule 见 payload',
                // 报告在载荷顶层：Capsule 字段与 Orca 身份同层，解析器按字段名读取。
                payload: JSON.stringify({ taskId: CAPSULE_TASK, dispatchId: CAPSULE_DISPATCH, ...CAPSULE }),
              },
            ],
            timedOut: false,
            cancelled: false,
          },
        };
      }
      return undefined;
    },
  });

  const outcome = await dispatchCapsuleWorker({
    store: harness.store,
    backend: backend.backend,
    writer: harness.writer,
    coordinationScopeId: RECOVERY_SCOPE,
    envelope: buildUtilityWorkerEnvelope({
      workPackageId: RECOVERY_WORK_PACKAGE,
      sourceWorkerTaskId: RECOVERY_WORKER_TASK,
      sourceSegmentId: SEGMENT,
      transcriptRef: TRANSCRIPT,
    }),
    execution: {
      backendIdentityRef: 'identity-capsule',
      graphGeneration: 1,
      authorizationId: RECOVERY_AUTHORIZATION,
      runId: 'run-capsule',
      consumerGeneration: 1,
      timeoutMs: 1_000,
    },
    workerLaunch: createCodexWorkerLaunch({
      launchId,
      model: 'worker-model',
      sandboxMode: 'read-only',
      stateRoot,
      sessionStartReporterPath: codexSessionPathsUnder(stateRoot, launchId).reporterPath,
    }),
    worktree: `path:${worktree}`,
    operationIds: {
      task: 'op:capsule:task' as OperationId,
      workerPrepare: 'op:capsule:prepare' as OperationId,
      workerStart: 'op:capsule:start' as OperationId,
      workerActivate: 'op:capsule:activate' as OperationId,
    },
    observeSession: ({ dispatchId }) => {
      // 绑定输入由用例给出：绑定规则本身由 session-binding 的用例覆盖，这里只提供可信事实。
      return Promise.resolve({
        harness: 'codex',
        role: 'planner',
        workerTaskId: RECOVERY_WORKER_TASK,
        dispatchId: dispatchId as never,
        attemptId: 'attempt-capsule-1',
        providerSessionId: SESSION_ID,
        transcriptRef: report.transcriptPath,
        observedAt: new Date().toISOString(),
      });
    },
    evidence: EVIDENCE,
    reportTimeoutMs: 5_000,
  });

  expect(started).toBe(1);
  expect(outcome.kind).toBe('extracted');
  if (outcome.kind !== 'extracted') {
    return;
  }
  expect(outcome.capsule.coverage).toBe('complete');
  // 整批都属于本次派发：交回 Delivery 身份，由调用方落盘后再确认。
  expect(outcome.delivery).toEqual({ deliveryId: 'delivery-capsule', runId: 'run-capsule' });
  // 信封是 Capsule 提取，且派发走的是只读沙箱。
  const created = backend.calls.find(
    (call) => call.kind === 'mutate' && call.operation.operation === 'task-create',
  );
  expect(created?.kind === 'mutate' && created.operation.operation === 'task-create' ? created.operation.spec : '').toContain(
    'recovery-capsule-extraction',
  );
});

test('Capsule 报告无法解析时返回失败，不把不完整结论当 Capsule', { timeout: 30_000 }, async () => {
  harness = createRecoveryHarness();
  harness.recordSourceSegment({
    segmentId: SEGMENT,
    dispatchId: 'ctx-capsule-source',
    attemptId: 'attempt-capsule-1',
    sessionBindingId: 'binding-capsule-1',
    lastTranscriptRef: TRANSCRIPT,
    transcriptReferenceable: true,
    verifiable: true,
  });
  scratch = mkdtempSync(join(tmpdir(), 'capsule-dispatch-'));
  const worktree = join(scratch, 'worktree');
  mkdirSync(worktree, { recursive: true });
  const stateRoot = join(scratch, 'state');
  const launchId = capsuleLaunchIdOf(SEGMENT);
  const report = prepareCodexSession({ stateRoot, launchId, worktree });

  const backend = fakeRecoveryBackend({
    mutate: (input, scope) => {
      if (input.operation === 'task-create') {
        return accepted(scope, { id: CAPSULE_TASK, spec: input.spec ?? '' });
      }
      if (input.operation === 'terminal-create') {
        return accepted(scope, { handle: 'terminal-capsule' });
      }
      if (input.operation === 'worker-start') {
        writeFileSync(
          report.reportPath,
          `${JSON.stringify({
            sessionId: SESSION_ID,
            transcriptPath: report.transcriptPath,
            codexHome: report.codexHome,
            cwd: worktree,
            observedAt: new Date().toISOString(),
          })}\n`,
          'utf8',
        );
        return accepted(scope, { taskId: CAPSULE_TASK, dispatchId: CAPSULE_DISPATCH, state: 'ready' });
      }
      return undefined;
    },
    query: (input) => {
      if (input.operation === 'terminal-list') {
        // prepared terminal 的核验要求完整列举：不完整时生产实现会拒绝猜测。
        return {
          kind: 'accepted',
          value: {
            terminals: [{ handle: 'terminal-capsule', connected: true, writable: true, title: null }],
            omittedHostIds: [],
            truncated: false,
          },
        };
      }
      if (input.operation === 'worker-show') {
        return {
          kind: 'accepted',
          value: { exactWorker: true, agentTerminalHandle: 'terminal-capsule', workerState: 'running' },
        };
      }
      if (input.operation === 'delivery-read') {
        return {
          kind: 'accepted',
          value: {
            delivery: { deliveryId: 'delivery-capsule', runId: 'run-capsule' },
            messages: [
              {
                messageId: 'message-capsule',
                runId: 'run-capsule',
                deliveryContract: 'current_delivery',
                fromHandle: 'terminal-capsule',
                toHandle: 'coordinator',
                type: 'worker_done',
                subject: 'Recovery Capsule',
                priority: null,
                // coverage 与 host 证据不一致：必须拒绝，不能降级。
                body: JSON.stringify({ ...CAPSULE, coverage: 'partial' }),
                payload: JSON.stringify({ taskId: CAPSULE_TASK, dispatchId: CAPSULE_DISPATCH }),
              },
            ],
            timedOut: false,
            cancelled: false,
          },
        };
      }
      return undefined;
    },
  });

  const outcome = await dispatchCapsuleWorker({
    store: harness.store,
    backend: backend.backend,
    writer: harness.writer,
    coordinationScopeId: RECOVERY_SCOPE,
    envelope: buildUtilityWorkerEnvelope({
      workPackageId: RECOVERY_WORK_PACKAGE,
      sourceWorkerTaskId: RECOVERY_WORKER_TASK,
      sourceSegmentId: SEGMENT,
      transcriptRef: TRANSCRIPT,
    }),
    execution: {
      backendIdentityRef: 'identity-capsule',
      graphGeneration: 1,
      authorizationId: RECOVERY_AUTHORIZATION,
      runId: 'run-capsule',
      consumerGeneration: 1,
      timeoutMs: 1_000,
    },
    workerLaunch: createCodexWorkerLaunch({
      launchId,
      model: 'worker-model',
      sandboxMode: 'read-only',
      stateRoot,
      sessionStartReporterPath: codexSessionPathsUnder(stateRoot, launchId).reporterPath,
    }),
    worktree: `path:${worktree}`,
    operationIds: {
      task: 'op:capsule:task' as OperationId,
      workerPrepare: 'op:capsule:prepare' as OperationId,
      workerStart: 'op:capsule:start' as OperationId,
      workerActivate: 'op:capsule:activate' as OperationId,
    },
    observeSession: () => Promise.resolve(null),
    evidence: EVIDENCE,
    reportTimeoutMs: 5_000,
  });

  expect(outcome.kind).toBe('failed');
});

test('Capsule 正文按引用确定性落盘：可回读、损坏即视为不可读', () => {
  scratch = mkdtempSync(join(tmpdir(), 'capsule-body-'));
  const ref = capsuleRefOf('recovery:scope:segment:1');
  const first = writeRecoveryCapsuleBody({ stateRoot: scratch, capsuleRef: ref, capsule: CAPSULE });
  expect(first.ok).toBe(true);
  expect(readRecoveryCapsuleBody({ stateRoot: scratch, capsuleRef: ref })).toEqual(CAPSULE);
  // 同一引用重复写入落在同一路径（重放不会产生第二份正文）。
  const again = writeRecoveryCapsuleBody({ stateRoot: scratch, capsuleRef: ref, capsule: CAPSULE });
  expect(again.ok && first.ok ? again.path === first.path : false).toBe(true);
  // 损坏的正文按不可读处理，绝不返回半截结论。
  if (first.ok) {
    writeFileSync(first.path, '{"coverage":"complete"', 'utf8');
  }
  expect(readRecoveryCapsuleBody({ stateRoot: scratch, capsuleRef: ref })).toBeNull();
});

test('重启后续办：按信封内容回读已派发的 Worker，不再新建 Task/Worker', { timeout: 30_000 }, async () => {
  // 重放时 OperationId 已收尾、回执也不在了：身份只能从 Orca 列举事实回读。
  harness = createRecoveryHarness();
  harness.recordSourceSegment({
    segmentId: SEGMENT,
    dispatchId: 'ctx-capsule-source',
    attemptId: 'attempt-capsule-1',
    sessionBindingId: 'binding-capsule-1',
    lastTranscriptRef: TRANSCRIPT,
    transcriptReferenceable: true,
    verifiable: true,
  });
  scratch = mkdtempSync(join(tmpdir(), 'capsule-dispatch-'));
  const worktree = join(scratch, 'worktree');
  mkdirSync(worktree, { recursive: true });
  const stateRoot = join(scratch, 'state');
  const launchId = capsuleLaunchIdOf(SEGMENT);
  const launch = createCodexWorkerLaunch({
    launchId,
    model: 'worker-model',
    sandboxMode: 'read-only',
    stateRoot,
    sessionStartReporterPath: codexSessionPathsUnder(stateRoot, launchId).reporterPath,
  });
  const envelope = buildUtilityWorkerEnvelope({
    workPackageId: RECOVERY_WORK_PACKAGE,
    sourceWorkerTaskId: RECOVERY_WORKER_TASK,
    sourceSegmentId: SEGMENT,
    transcriptRef: TRANSCRIPT,
  });
  const backend = fakeRecoveryBackend({
    query: (input) => {
      if (input.operation === 'task-list') {
        return {
          kind: 'accepted',
          value: { tasks: [{ id: CAPSULE_TASK, spec: JSON.stringify(envelope) }] },
        };
      }
      if (input.operation === 'worker-list') {
        return {
          kind: 'accepted',
          value: { workers: [{ taskId: CAPSULE_TASK, dispatchId: CAPSULE_DISPATCH, workerState: 'succeeded' }] },
        };
      }
      if (input.operation === 'delivery-read') {
        return {
          kind: 'accepted',
          value: {
            delivery: { deliveryId: 'delivery-capsule', runId: 'run-capsule' },
            messages: [
              {
                messageId: 'message-capsule',
                runId: 'run-capsule',
                deliveryContract: 'current_delivery',
                fromHandle: 'terminal-capsule',
                toHandle: 'coordinator',
                type: 'worker_done',
                subject: 'Recovery Capsule',
                priority: null,
                body: 'capsule 见 payload',
                payload: JSON.stringify({ taskId: CAPSULE_TASK, dispatchId: CAPSULE_DISPATCH, ...CAPSULE }),
              },
            ],
            timedOut: false,
            cancelled: false,
          },
        };
      }
      return undefined;
    },
  });

  const outcome = await dispatchCapsuleWorker({
    store: harness.store,
    backend: backend.backend,
    writer: harness.writer,
    coordinationScopeId: RECOVERY_SCOPE,
    envelope,
    execution: {
      backendIdentityRef: 'identity-capsule',
      graphGeneration: 1,
      authorizationId: RECOVERY_AUTHORIZATION,
      runId: 'run-capsule',
      consumerGeneration: 1,
      timeoutMs: 1_000,
    },
    workerLaunch: launch,
    worktree: `path:${worktree}`,
    operationIds: {
      task: 'op:capsule:task' as OperationId,
      workerPrepare: 'op:capsule:prepare' as OperationId,
      workerStart: 'op:capsule:start' as OperationId,
      workerActivate: 'op:capsule:activate' as OperationId,
    },
    observeSession: () => Promise.resolve(null),
    evidence: EVIDENCE,
    reportTimeoutMs: 5_000,
  });

  expect(outcome.kind).toBe('extracted');
  if (outcome.kind !== 'extracted') {
    return;
  }
  expect(outcome.delivery).toEqual({ deliveryId: 'delivery-capsule', runId: 'run-capsule' });
  // 关键：没有新建任何 Task / Worker —— 续办复用 Orca 里已经存在的那次派发。
  expect(backend.mutations()).toEqual([]);
});
