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

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
  createExecutionRecoveryFacts,
} from '../../src/bootstrap/execution-runtime.js';
import { workPackageComment } from '../../src/application/materialize-work-package.js';
import {
  READ_ONLY_WORKER_UNAVAILABLE,
} from '../support/read-only-worker-probe.js';
import type { ReadOnlyWorkerProbe } from '../../src/adapters/agents/codex-read-only-probe.js';
import {
  capsuleRefOf,
  readRecoveryCapsuleBody,
  writeRecoveryCapsuleBody,
  type RecoveryCapsule,
  type TranscriptCoverageEvidence,
} from '../../src/application/recovery/recovery-capsule.js';
import { beginIntent } from '../../src/application/coordination/intent-service.js';
import type { ExecutionBackend, ExecutionScope } from '../../src/application/ports/execution-backend.js';
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

test.each(['payload', 'body'] as const)('Capsule 提取：受限派发、按 Orca 身份读回 %s 报告并交回 Delivery 身份', { timeout: 30_000 }, async (location) => {
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
                body: location === 'body' ? JSON.stringify(CAPSULE) : 'capsule 见 payload',
                payload: JSON.stringify({
                  taskId: CAPSULE_TASK,
                  dispatchId: CAPSULE_DISPATCH,
                  ...(location === 'payload' ? CAPSULE : { outcome: 'succeeded' }),
                }),
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
  // 生产 spec 根身份不变（`specMatchesEnvelope` 的对账字段），并携带含可信 coverage 证据的可读指令。
  const spec = created?.kind === 'mutate' && created.operation.operation === 'task-create'
    ? (JSON.parse(created.operation.spec) as {
        readonly taskKind?: string;
        readonly workPackageId?: string;
        readonly sourceSegmentId?: string;
        readonly instructions?: readonly string[];
      })
    : {};
  expect(spec.taskKind).toBe('recovery-capsule-extraction');
  expect(spec.workPackageId).toBe(RECOVERY_WORK_PACKAGE);
  expect(spec.sourceSegmentId).toBe(SEGMENT);
  expect(spec.instructions?.join('\n')).toContain(JSON.stringify(EVIDENCE));
});

test.each(['coverage', 'task', 'dispatch'] as const)('Capsule 的 %s 不匹配时拒绝接纳', { timeout: 30_000 }, async (mismatch) => {
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
                body: JSON.stringify(mismatch === 'coverage' ? { ...CAPSULE, coverage: 'partial' } : CAPSULE),
                payload: JSON.stringify({
                  taskId: mismatch === 'task' ? 'other-task' : CAPSULE_TASK,
                  dispatchId: mismatch === 'dispatch' ? 'old-dispatch' : CAPSULE_DISPATCH,
                }),
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
    reportTimeoutMs: 0,
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

test('已有未决意图时先按原身份对账：能力结论不改写 lane 的未知状态', { timeout: 30_000 }, async () => {
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
  scratch = mkdtempSync(join(tmpdir(), 'capsule-gate-'));
  const worktree = join(scratch, 'worktree');
  mkdirSync(worktree, { recursive: true });
  const transcript = writeOrdinalTranscript(scratch);
  const scope = harness.store.query({ kind: 'scope', coordinationScopeId: RECOVERY_SCOPE });
  if (scope.kind !== 'scope' || scope.scope === null) {
    throw new Error('Scope 不存在');
  }
  // 上一次派发留下的未决意图：它的对账结论只能来自原来的 OperationId 与 Orca 事实。
  const begun = beginIntent(harness.store, {
    coordinationScopeId: RECOVERY_SCOPE,
    operationId: `op:capsule:${encodeURIComponent(SEGMENT)}:task` as OperationId,
    target: { kind: 'worker-task', id: RECOVERY_WORKER_TASK },
    operationCategory: 'worker-dispatch',
    writer: harness.writer,
    expectedRevision: scope.scope.revision,
  });
  expect(begun.kind).toBe('registered');
  let probeCalls = 0;
  const backend = fakeRecoveryBackend({
    query: (input) => {
      if (input.operation === 'worktree-list') {
        return {
          kind: 'accepted',
          value: {
            worktrees: [
              { worktreeId: 'worktree-capsule', path: worktree, comment: workPackageComment(RECOVERY_WORK_PACKAGE) },
            ],
            totalCount: 1,
            truncated: false,
            hostScope: { hostIds: ['host-1'], omittedHostIds: [] },
          },
        };
      }
      if (input.operation === 'task-list') {
        return { kind: 'accepted', value: { tasks: [] } };
      }
      return undefined;
    },
  });

  const outcome = await capsuleFacts({
    backend: backend.backend,
    companionStateRoot: join(scratch, 'state'),
    probe: () => {
      probeCalls += 1;
      return Promise.resolve(READ_ONLY_WORKER_UNAVAILABLE);
    },
  }).extractCapsule(extractRequest(transcript.path));

  // 意图存在即不是「全新派发」：不探测能力，也不新建 mutation，结论停在原 lane 的阻塞上。
  expect(probeCalls).toBe(0);
  expect(outcome.kind).toBe('failed');
  if (outcome.kind === 'failed') {
    expect(outcome.reason).not.toContain('read_only_worker_unavailable');
  }
  expect(backend.mutations()).toEqual([]);
});

/* -------------------------------------------------------------------------- */
/* 只读能力不可用时的 Capsule 失败关闭（change: `m2-repair-read-only-worker-sandbox`） */
/* -------------------------------------------------------------------------- */

/**
 * 宿主装配的 Capsule 提取（`createExecutionRecoveryFacts` → `extractCapsule`）在**新派发**之前核验
 * 本机只读 Worker 能力：不可用时不进入报告等待、不建 Task/Dispatch、不消耗 Recovery 预算；已经有派发
 * 或意图时按原身份继续对账，能力结论不改写既有事实。
 */

/** 一份可被 host 读出完整 coverage 的 rollout：事件引用按 `ordinal` 派生。 */
function writeOrdinalTranscript(directory: string): { readonly path: string; readonly ref: () => string } {
  const path = join(directory, 'rollout-ordinal.jsonl');
  writeFileSync(
    path,
    [1, 2, 3]
      .map((ordinal) => `${JSON.stringify({ ordinal, type: 'event', payload: { ordinal } })}\n`)
      .join(''),
    'utf8',
  );
  // 宿主自己会对同一个路径做 realpath：报告里的 transcriptRef 必须与它逐字节相同。
  return { path, ref: () => realpathSync(path) };
}

function capsuleFacts(input: {
  readonly backend: ExecutionBackend;
  readonly companionStateRoot: string;
  readonly probe: ReadOnlyWorkerProbe;
}) {
  return createExecutionRecoveryFacts({
    store: () => harness!.store,
    backend: input.backend,
    coordinationScopeId: RECOVERY_SCOPE,
    canonicalWorktree: harness!.directory,
    execution: {
      backendIdentityRef: 'identity-capsule',
      graphGeneration: 1,
      authorizationId: RECOVERY_AUTHORIZATION,
      runId: 'run-capsule',
      consumerGeneration: 1,
      timeoutMs: 1_000,
    },
    workerHarness: 'codex',
    workerModel: 'worker-model',
    codexSandbox: 'workspace-write',
    companionStateRoot: input.companionStateRoot,
    writer: harness!.writer,
    env: {},
    clock: () => Date.now(),
    bindingWindowMs: 50,
    readOnlyWorkerProbe: input.probe,
  });
}

function extractRequest(transcriptRef: string) {
  return {
    coordinationScopeId: RECOVERY_SCOPE,
    role: 'implementation' as const,
    workPackageId: RECOVERY_WORK_PACKAGE,
    workerTaskId: RECOVERY_WORKER_TASK,
    attemptId: 'attempt-capsule-1',
    segmentId: SEGMENT,
    transcriptRef,
  };
}

test('Capsule 派发前能力不可用：零 Orca mutation、不消耗恢复预算，只留可诊断 blocker', { timeout: 30_000 }, async () => {
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
  scratch = mkdtempSync(join(tmpdir(), 'capsule-gate-'));
  const worktree = join(scratch, 'worktree');
  mkdirSync(worktree, { recursive: true });
  const transcript = writeOrdinalTranscript(scratch);
  let probeCalls = 0;
  const backend = fakeRecoveryBackend({
    query: (input) => {
      if (input.operation === 'worktree-list') {
        return {
          kind: 'accepted',
          value: {
            worktrees: [
              { worktreeId: 'worktree-capsule', path: worktree, comment: workPackageComment(RECOVERY_WORK_PACKAGE) },
            ],
            totalCount: 1,
            truncated: false,
            hostScope: { hostIds: ['host-1'], omittedHostIds: [] },
          },
        };
      }
      if (input.operation === 'task-list') {
        return { kind: 'accepted', value: { tasks: [] } };
      }
      return undefined;
    },
  });

  const outcome = await capsuleFacts({
    backend: backend.backend,
    companionStateRoot: join(scratch, 'state'),
    probe: () => {
      probeCalls += 1;
      return Promise.resolve(READ_ONLY_WORKER_UNAVAILABLE);
    },
  }).extractCapsule(extractRequest(transcript.path));

  expect(probeCalls).toBe(1);
  expect(outcome.kind).toBe('failed');
  if (outcome.kind !== 'failed') {
    return;
  }
  // 失败原因是稳定的能力 token 与阶段，而不是 120 秒报告超时。
  expect(outcome.reason).toContain('read_only_worker_unavailable');
  expect(outcome.reason).toContain('sandbox-read');
  expect(outcome.reason).not.toContain('超时');
  // 零新派发：没有建 Task、没有启 Worker、没有确认任何 Delivery。
  expect(backend.mutations()).toEqual([]);
});

test('已有派发时能力结论不改写身份：按原 Dispatch 读回 Capsule，不重复探测', { timeout: 30_000 }, async () => {
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
  scratch = mkdtempSync(join(tmpdir(), 'capsule-gate-'));
  const worktree = join(scratch, 'worktree');
  mkdirSync(worktree, { recursive: true });
  const transcript = writeOrdinalTranscript(scratch);
  const existing = buildUtilityWorkerEnvelope({
    workPackageId: RECOVERY_WORK_PACKAGE,
    sourceWorkerTaskId: RECOVERY_WORKER_TASK,
    sourceSegmentId: SEGMENT,
    transcriptRef: TRANSCRIPT,
  });
  let probeCalls = 0;
  const backend = fakeRecoveryBackend({
    query: (input) => {
      if (input.operation === 'worktree-list') {
        return {
          kind: 'accepted',
          value: {
            worktrees: [
              { worktreeId: 'worktree-capsule', path: worktree, comment: workPackageComment(RECOVERY_WORK_PACKAGE) },
            ],
            totalCount: 1,
            truncated: false,
            hostScope: { hostIds: ['host-1'], omittedHostIds: [] },
          },
        };
      }
      if (input.operation === 'task-list') {
        return { kind: 'accepted', value: { tasks: [{ id: CAPSULE_TASK, spec: JSON.stringify(existing) }] } };
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
                payload: JSON.stringify({
                  taskId: CAPSULE_TASK,
                  dispatchId: CAPSULE_DISPATCH,
                  coverage: 'complete',
                  readableRange: { transcriptRef: transcript.ref(), fromEventRef: 'ordinal:1', toEventRef: 'ordinal:3' },
                  gaps: [],
                  lastCompleteEventRef: 'ordinal:3',
                  openActions: [],
                  sourceRefs: [],
                  unknowns: [],
                }),
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

  const outcome = await capsuleFacts({
    backend: backend.backend,
    companionStateRoot: join(scratch, 'state'),
    probe: () => {
      probeCalls += 1;
      return Promise.resolve(READ_ONLY_WORKER_UNAVAILABLE);
    },
  }).extractCapsule(extractRequest(transcript.path));

  // 既有派发就是权威事实：不探测、不新建，结论仍从原 Dispatch 的报告读出。
  expect(probeCalls).toBe(0);
  expect(outcome.kind).toBe('extracted');
  expect(backend.mutations().filter((mutation) => mutation.operation === 'task-create')).toEqual([]);
});
