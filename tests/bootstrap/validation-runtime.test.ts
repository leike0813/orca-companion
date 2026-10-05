/**
 * Validator 步骤通道的生产装配测试（Owner: `m2-wire-execution-runtime`）。
 *
 * 用宿主驱动的 `observe`/`advance` 连接真实 `runValidation` 与 `createValidatorStepRunner`，验证：
 * 失败→许可修复→复验→通过→结束的完整 ask/reply 序列、回复动作编码、异 Attempt 消息忽略与会话中止。
 */

import { expect, test } from 'vitest';

import type { DispatchId, WorkPackageId, WorkerTaskId } from '../../src/application/dto/identity.js';
import type { DeliveryMessage } from '../../src/application/dto/operation-outcome.js';
import {
  runValidation,
  type RunValidationInput,
} from '../../src/application/run-validation.js';
import { createValidatorStepRunner } from '../../src/adapters/agents/validator-runner.js';
import {
  createValidatorHarnessSession,
  observeValidatorStepMessage,
  validatorVerificationInstructions,
  type ValidatorReplySendRequest,
  type ValidatorStepRouting,
} from '../../src/bootstrap/validation-runtime.js';
import type { RoleAuthorities } from '../../src/domain/planning/execution-authorization.js';
import type { ScopeEnvelope } from '../../src/domain/planning/execution-graph.js';
import type { SessionBinding } from '../../src/domain/task-contract.js';

const WP = 'wp-1' as WorkPackageId;
const TASK = 'worker-task-1' as WorkerTaskId;
const DISPATCH = 'dispatch-1' as DispatchId;
const ATTEMPT = 'attempt-1';

const AUTHORITY: RoleAuthorities = {
  planner: false,
  implementation: true,
  validator: true,
  finalizer: true,
  gitIntegration: false,
  dependencyChanges: false,
};

const SCOPE_ENVELOPE: ScopeEnvelope = { include: ['src'], exclude: [] };

const SESSION: SessionBinding = {
  harness: 'codex',
  role: 'validator',
  workerTaskId: TASK,
  dispatchId: DISPATCH,
  attemptId: ATTEMPT,
  providerSessionId: 'provider-session-1',
  transcriptRef: '/tmp/transcript.jsonl',
  observedAt: '2026-01-01T00:00:00.000Z',
};

const ROUTING: ValidatorStepRouting = {
  workPackageId: WP,
  workerTaskId: TASK,
  dispatchId: DISPATCH,
  validationAttemptId: ATTEMPT,
  sessionBinding: SESSION,
  runId: 'run-1',
};

function question(body: unknown, overrides: Partial<DeliveryMessage> = {}): DeliveryMessage {
  return {
    messageId: 'msg-1',
    runId: 'run-1',
    deliveryContract: 'current_delivery',
    fromHandle: 'dispatch:dispatch-1',
    toHandle: 'run:run-1',
    type: 'question',
    subject: 'Question',
    priority: 'normal',
    body: JSON.stringify(body),
    payload: JSON.stringify({ taskId: TASK, dispatchId: DISPATCH }),
    ...overrides,
  };
}

function identity(step: Record<string, unknown>): Record<string, unknown> {
  return { schemaVersion: 1, kind: 'validator_step', workerTaskId: TASK, dispatchId: DISPATCH, attemptId: ATTEMPT, ...step };
}

function evidence(): Record<string, unknown> {
  return { kind: 'command', coveredPaths: ['src'], command: 'pnpm test', summary: 'ok', outcome: 'passed' };
}

test.each([false, true])('完整 ask/reply 序列与原序恢复（预先回读=%s）', async (replayed) => {
  const messages = [
    question(identity({
      step: 'verify',
      outcome: 'failed',
      summary: '发现缺陷',
      evidence: [evidence()],
      repairIntent: { changedPaths: ['src/a.ts'], requiresDesignChange: false, requiresDependencyChange: false },
    }), { messageId: 'msg-1' }),
    question(identity({ step: 'repair_applied', changedPaths: ['src/a.ts'], note: '已修复' }), { messageId: 'msg-2' }),
    question(identity({
      step: 'verify',
      outcome: 'passed',
      summary: '复验通过',
      evidence: [{ kind: 'command', coveredPaths: ['src/a.ts'], command: 'pnpm test', summary: 'ok', outcome: 'passed' }],
      repairIntent: null,
    }), { messageId: 'msg-3' }),
  ];

  const sent: ValidatorReplySendRequest[] = [];
  let next = 0;
  const controller = createValidatorHarnessSession({
    routing: ROUTING,
    sendReply: (request) => {
      sent.push(request);
      // 收到一次许可后，把下一条报告投递进来，模拟宿主 pump 的下一 tick。
      const pending = messages[next];
      if (!replayed && pending !== undefined) {
        next += 1;
        const observation = controller.observe(pending);
        if (observation !== null) {
          controller.advance(observation);
        }
      }
      return Promise.resolve({ kind: 'sent' });
    },
  });

  // 首条报告在 runValidation 等待前先投递（宿主先读到 question 才启动验证）。
  const first = controller.observe(messages[0]!);
  expect(first).not.toBeNull();
  controller.advance(first!);
  if (replayed) {
    for (const message of messages.slice(1)) controller.advance(controller.observe(message)!);
  }
  next = 1;

  const runStep = createValidatorStepRunner({
    bindSession: () => Promise.resolve(SESSION),
    session: controller.session,
  });
  const input: RunValidationInput = {
    runStep,
    implementerRole: 'implementation',
    validatorRole: 'validator',
    authority: AUTHORITY,
    workPackageId: WP,
    workerTaskId: TASK,
    dispatchId: DISPATCH,
    validationAttemptId: ATTEMPT as never,
    sessionBinding: SESSION,
    scopeEnvelope: SCOPE_ENVELOPE,
    repairBudget: { limit: 2, consumed: 0 },
    implementationBudget: { limit: 2, consumed: 1 },
    evidence: [],
    maxSteps: 5,
    admitStep: () => Promise.resolve({ kind: 'admitted' }),
  };

  const result = await runValidation(input);
  expect(result.kind).toBe('validated');
  // 许可序列：先放行修复，再放行复验。
  expect(sent.map((request) => request.action)).toEqual(['repair', 'verify']);
  expect(sent[0]!.repairIntent?.changedPaths).toEqual(['src/a.ts']);
  expect(sent[0]!.operationId).toBe('validator-reply:msg-1:repair');

  // runValidation 返回后由宿主结束：最后一条 question 收到 finish。
  const concluded = await controller.conclude(result);
  expect(concluded.kind).toBe('sent');
  expect(sent.map((request) => request.action)).toEqual(['repair', 'verify', 'finish']);
  const finish = JSON.parse(sent[2]!.body) as { action: string; stepId: string };
  expect(finish.action).toBe('finish');
  expect(finish.stepId).toBe('validator-step:msg-3');
});

test('异 Attempt 或非 question 的消息被忽略，不占用步骤通道', () => {
  const good = observeValidatorStepMessage(
    question(identity({ step: 'verify', outcome: 'passed', summary: 'x', evidence: [evidence()], repairIntent: null }), { messageId: 'm' }),
    ROUTING,
  );
  expect('record' in good).toBe(true);
  const wrongAttempt = observeValidatorStepMessage(
    question(identity({ step: 'verify', attemptId: 'other', outcome: 'passed', summary: 'x', evidence: [evidence()], repairIntent: null }), { messageId: 'm' }),
    ROUTING,
  );
  expect(wrongAttempt).toMatchObject({ kind: 'ignored' });
  const notQuestion = observeValidatorStepMessage(
    question(identity({ step: 'verify', outcome: 'passed', summary: 'x', evidence: [evidence()], repairIntent: null }), { messageId: 'm', type: 'worker_done' }),
    ROUTING,
  );
  expect(notQuestion).toMatchObject({ kind: 'ignored' });
});

test('中止信号使等待中的 runStep 会话丢失', async () => {
  const abort = new AbortController();
  const controller = createValidatorHarnessSession({
    routing: ROUTING,
    sendReply: () => Promise.resolve({ kind: 'sent' }),
    signal: abort.signal,
  });
  const pending = controller.session.runStep({
    kind: 'verify',
    sessionBinding: SESSION,
    workPackageId: WP,
    workerTaskId: TASK,
    dispatchId: DISPATCH,
    validationAttemptId: ATTEMPT as never,
    repairIntent: null,
  });
  abort.abort();
  await expect(pending).resolves.toMatchObject({ kind: 'session_lost' });
});

test('Validator 指令写清 ask 报告形状与获批范围', () => {
  const instructions = validatorVerificationInstructions({
    scopeEnvelope: SCOPE_ENVELOPE,
    repairBudget: { limit: 2, consumed: 1 },
    workerTaskId: TASK,
    dispatchId: DISPATCH,
    attemptId: ATTEMPT,
  });
  const text = instructions.join('\n');
  expect(text).toContain('orca orchestration ask');
  expect(text).toContain('validator_step');
  expect(text).toContain('repairIntent');
  expect(text).toContain('"src"');
  expect(text).toContain('剩余修复预算为 1');
});
