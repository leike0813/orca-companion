import { expect, test } from 'vitest';

import type { CoordinatorSessionId } from '../../src/application/dto/identity.js';
import {
  CHECKPOINT_THREAD_PREFIX,
  COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
  parseCoordinatorSessionState,
  threadIdFor,
  type CommittedModelStep,
  type CoordinatorSessionState,
} from '../../src/domain/coordinator/session-state.js';

const SESSION_A = 'session-a' as CoordinatorSessionId;
const SESSION_B = 'session-b' as CoordinatorSessionId;

const STEP: CommittedModelStep = {
  stepId: 'step-1',
  committedAt: 1_000,
  messages: [{ role: 'assistant', content: '已登记一条 Decision Ticket' }],
  usage: { inputTokens: 120, outputTokens: 18, totalTokens: 138 },
};

function baseState(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schemaVersion: COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
    coordinatorSessionId: SESSION_A,
    committedMessages: [{ role: 'user', content: '开始规划' }],
    graphPosition: 'model',
    committedModelSteps: [STEP],
    wakeBatches: [],
    ...overrides,
  };
}

test('Session ID 到 checkpoint thread 的映射是确定且单射的', () => {
  expect(threadIdFor(SESSION_A)).toBe(threadIdFor(SESSION_A));
  expect(threadIdFor(SESSION_A)).toBe(`${CHECKPOINT_THREAD_PREFIX}${SESSION_A}`);
  expect(threadIdFor(SESSION_A)).not.toBe(threadIdFor(SESSION_B));
});

test('两个 Session 的线程标识不同，因此写一个不会改变另一个的可读状态', () => {
  const threadA = threadIdFor(SESSION_A);
  const threadB = threadIdFor(SESSION_B);

  expect(threadA).not.toBe(threadB);
  expect(threadA.startsWith(threadB)).toBe(false);
  expect(threadB.startsWith(threadA)).toBe(false);
});

test('合法会话状态通过校验并保留已提交 step', () => {
  const parsed = parseCoordinatorSessionState(baseState());

  expect(parsed.ok).toBe(true);
  if (parsed.ok) {
    const state: CoordinatorSessionState = parsed.value;
    expect(state.coordinatorSessionId).toBe(SESSION_A);
    expect(state.committedModelSteps).toHaveLength(1);
    expect(state.committedModelSteps[0]?.stepId).toBe('step-1');
    expect(state.graphPosition).toBe('model');
  }
});

test('凭据字段的候选状态被拒绝', () => {
  const withTopLevelCredential = parseCoordinatorSessionState(baseState({ apiKey: 'sk-live-123' }));
  expect(withTopLevelCredential.ok).toBe(false);
  if (!withTopLevelCredential.ok) {
    expect(withTopLevelCredential.field).toContain('apiKey');
  }

  const nestedCredential = parseCoordinatorSessionState(
    baseState({
      committedMessages: [{ role: 'system', providerCredential: { accessToken: 'x' } }],
    }),
  );
  expect(nestedCredential.ok).toBe(false);
  if (!nestedCredential.ok) {
    expect(nestedCredential.field).toContain('accessToken');
  }
});

test('外部权威事实不能写进会话状态', () => {
  for (const field of ['routeMap', 'orcaRun', 'gitHead', 'receipt']) {
    const parsed = parseCoordinatorSessionState(baseState({ [field]: { id: 'x' } }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.field).toContain(field);
    }
  }
});

test('schema 版本不符即拒绝，不猜测旧形状', () => {
  const parsed = parseCoordinatorSessionState(baseState({ schemaVersion: 99 }));
  expect(parsed.ok).toBe(false);
  if (!parsed.ok) {
    expect(parsed.field).toBe('sessionState.schemaVersion');
  }
});

test('不可 JSON 序列化的内容被拒绝', () => {
  const parsed = parseCoordinatorSessionState(baseState({ committedMessages: [{ run: () => undefined }] }));
  expect(parsed.ok).toBe(false);
});

test('未完整提交的空响应不能成为已提交 model step', () => {
  const parsed = parseCoordinatorSessionState(
    baseState({ committedModelSteps: [{ ...STEP, messages: [] }] }),
  );
  expect(parsed.ok).toBe(false);
  if (!parsed.ok) {
    expect(parsed.field).toContain('messages');
  }
});

test('同一个 WakeBatchId 不能在会话历史中重复注入', () => {
  const batch = {
    wakeBatchId: 'wake-1',
    coordinationScopeId: 'scope-1',
    coordinatorSessionId: SESSION_A,
    sourceRevisions: [{ sourceKind: 'delivery', sourceId: 'd-1', revision: 4 }],
    actionableWork: [],
  };
  const parsed = parseCoordinatorSessionState(baseState({ wakeBatches: [batch, batch] }));

  expect(parsed.ok).toBe(false);
  if (!parsed.ok) {
    expect(parsed.field).toBe('sessionState.wakeBatches');
  }
});

test('Wake Batch 不能写入另一个 Session 的 checkpoint', () => {
  const parsed = parseCoordinatorSessionState(baseState({
    wakeBatches: [{
      wakeBatchId: 'wake-1',
      coordinationScopeId: 'scope-1',
      coordinatorSessionId: SESSION_B,
      sourceRevisions: [{ sourceKind: 'delivery', sourceId: 'd-1', revision: 4 }],
      actionableWork: [],
    }],
  }));

  expect(parsed.ok).toBe(false);
  if (!parsed.ok) {
    expect(parsed.field).toContain('coordinatorSessionId');
  }
});

test('两类压缩产物分开保存且互不损坏', () => {
  const parsed = parseCoordinatorSessionState(
    baseState({
      contextMaterial: {
        nativeWindowOwner: {
          ownerRef: 'provider:minimax-m3:generation-2',
          items: [{ itemId: 'enc-1', position: 0, mediaType: 'application/octet-stream', opaque: { blob: 'AAAA' } }],
        },
        capsule: null,
      },
    }),
  );

  expect(parsed.ok).toBe(true);
  if (parsed.ok) {
    expect(parsed.value.contextMaterial?.nativeWindowOwner?.items).toHaveLength(1);
    expect(parsed.value.contextMaterial?.capsule).toBeNull();
  }

  const declined = parseCoordinatorSessionState(
    baseState({
      contextMaterial: {
        nativeWindowOwner: null,
        capsule: {
          kind: 'derived_context_capsule',
          capsuleId: 'capsule-1',
          replacedFromStepId: 'step-1',
          replacedToStepId: 'step-9',
          text: '早先的九步摘要',
        },
      },
    }),
  );

  expect(declined.ok).toBe(true);
  if (declined.ok) {
    expect(declined.value.contextMaterial?.nativeWindowOwner).toBeNull();
    expect(declined.value.contextMaterial?.capsule?.kind).toBe('derived_context_capsule');
  }
});

test('Capsule 缺少派生视图标记即拒绝，避免被当作业务权威', () => {
  const parsed = parseCoordinatorSessionState(
    baseState({
      contextMaterial: {
        nativeWindowOwner: null,
        capsule: {
          capsuleId: 'capsule-1',
          replacedFromStepId: 'step-1',
          replacedToStepId: 'step-2',
          text: '无标记',
        },
      },
    }),
  );

  expect(parsed.ok).toBe(false);
});
