/**
 * SSOT 规则：prepared-terminal intent 的可核验句柄判定（worker-launch.knownTerminalHandleFor）。
 *
 * 固定 fail-closed 边界：只有「intent 记录不存在」或「已确定拒绝」才是 none；查询不可读、pending/blocked、
 * 或 accepted 却缺 handle 一律 evidence_missing，缺证据不能当作可新建。
 */

import { describe, expect, test } from 'vitest';

import type { OperationIntent } from '../../src/application/dto/operation-intent.js';
import type { CoordinationScopeId, OperationId } from '../../src/application/dto/identity.js';
import type { BranchCoordinationStore } from '../../src/application/ports/branch-coordination-store.js';
import {
  activatePreparedWorker,
  knownTerminalHandleFor,
  type PreparedTerminalBinding,
  type WorkerLaunchMutationResult,
} from '../../src/application/worker-launch.js';
import type { ExecutionBackend } from '../../src/application/ports/execution-backend.js';

const SCOPE = 'scope-1' as CoordinationScopeId;
const OPERATION = 'op:terminal' as OperationId;

function intent(overrides: Partial<OperationIntent> = {}): OperationIntent {
  return {
    coordinationScopeId: SCOPE,
    operationId: OPERATION,
    target: { kind: 'worker-task', id: 'task-1' },
    operationCategory: 'worker-terminal-prepare',
    laneKey: 'lane',
    expectedRevision: 1,
    expectedHead: null,
    initiatedBy: { coordinatorSessionId: 'session-1' as never, runtimeIncarnationId: 'inc-1' as never },
    state: 'settled',
    outcomeClass: 'accepted',
    backendRequestId: null,
    blockingReason: null,
    createdAt: 1,
    settledAt: 2,
    terminalHandle: null,
    ...overrides,
  };
}

function storeWith(result: { readonly kind: 'intent'; readonly intent: OperationIntent | null } | { readonly kind: 'rejected' }): BranchCoordinationStore {
  return {
    query: () =>
      result.kind === 'rejected'
        ? { kind: 'rejected', code: 'unreadable', message: '读取不可用' }
        : { kind: 'intent', intent: result.intent },
  } as unknown as BranchCoordinationStore;
}

describe('knownTerminalHandleFor', () => {
  test('查询非 intent 结果时 fail closed 为 evidence_missing', () => {
    expect(knownTerminalHandleFor(storeWith({ kind: 'rejected' }), SCOPE, OPERATION)).toEqual({
      kind: 'evidence_missing',
    });
  });

  test('记录不存在与已确定拒绝都是 none（可新建新 ID）', () => {
    expect(knownTerminalHandleFor(storeWith({ kind: 'intent', intent: null }), SCOPE, OPERATION)).toEqual({
      kind: 'none',
    });
    expect(
      knownTerminalHandleFor(
        storeWith({ kind: 'intent', intent: intent({ outcomeClass: 'rejected' }) }),
        SCOPE,
        OPERATION,
      ),
    ).toEqual({ kind: 'none' });
  });

  test('已接受且带 handle 返回 known', () => {
    expect(
      knownTerminalHandleFor(
        storeWith({ kind: 'intent', intent: intent({ terminalHandle: 'terminal-1' }) }),
        SCOPE,
        OPERATION,
      ),
    ).toEqual({ kind: 'known', handle: 'terminal-1' });
  });

  test('accepted 缺 handle、pending、blocked 一律 evidence_missing', () => {
    for (const overrides of [
      { terminalHandle: null },
      { state: 'pending' as const, outcomeClass: null },
      { state: 'blocked' as const, outcomeClass: null, blockingReason: '等待对账' },
    ]) {
      expect(
        knownTerminalHandleFor(storeWith({ kind: 'intent', intent: intent(overrides) }), SCOPE, OPERATION),
      ).toEqual({ kind: 'evidence_missing' });
    }
  });
});

const preparedTerminal = (activation: PreparedTerminalBinding['activation']): PreparedTerminalBinding => ({
  handle: 'terminal-1',
  title: 'title',
  worktreeSelector: 'path:/tmp/wt',
  activation,
});

/** activate 不应再读取屏幕或终端：一旦被调用即失败。 */
const readForbiddenBackend = (): ExecutionBackend =>
  ({
    query: () => {
      throw new Error('activatePreparedWorker 不应读取终端');
    },
  }) as unknown as ExecutionBackend;

describe('activatePreparedWorker', () => {
  test('submit_draft 不依赖 draft 字段：始终补发一次 Enter', async () => {
    const calls: { readonly operation: string; readonly terminal: string }[] = [];
    const outcome: WorkerLaunchMutationResult = { kind: 'accepted', terminalHandle: 'terminal-1' };
    const result = await activatePreparedWorker({
      backend: readForbiddenBackend(),
      terminal: preparedTerminal('submit_draft'),
      submitTerminal: (mutation) => {
        calls.push(mutation);
        return Promise.resolve(outcome);
      },
    });
    expect(calls).toEqual([{ operation: 'terminal-submit', terminal: 'terminal-1' }]);
    expect(result).toEqual(outcome);
  });

  test('none 或没有 prepared terminal 时不发提交', async () => {
    for (const terminal of [null, preparedTerminal('none')]) {
      let called = 0;
      const result = await activatePreparedWorker({
        backend: readForbiddenBackend(),
        terminal,
        submitTerminal: () => {
          called += 1;
          return Promise.resolve({ kind: 'accepted' });
        },
      });
      expect(called).toBe(0);
      expect(result).toEqual({ kind: 'accepted' });
    }
  });

  test('caller 的 rejected / unknown 原样透传', async () => {
    for (const outcome of [
      { kind: 'rejected', code: 'terminal_submit_rejected', message: '拒绝' },
      { kind: 'unknown', operationId: 'op:submit' as OperationId, reason: '传输超时' },
    ] as readonly WorkerLaunchMutationResult[]) {
      const result = await activatePreparedWorker({
        backend: readForbiddenBackend(),
        terminal: preparedTerminal('submit_draft'),
        submitTerminal: () => Promise.resolve(outcome),
      });
      expect(result).toEqual(outcome);
    }
  });
});
