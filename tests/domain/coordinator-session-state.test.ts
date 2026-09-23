import { expect, test } from 'vitest';

import type { CoordinatorSessionId } from '../../src/application/dto/identity.js';
import {
  CHECKPOINT_THREAD_PREFIX,
  COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
  LEGACY_SESSION_STATE_SCHEMA_VERSION,
  assistantEntryId,
  parseCoordinatorSessionState,
  threadIdFor,
  toolOperationId,
  userEntryId,
  userStepId,
  type CommittedModelStep,
  type CoordinatorSessionState,
} from '../../src/domain/coordinator/session-state.js';

const SESSION_A = 'session-a' as CoordinatorSessionId;
const SESSION_B = 'session-b' as CoordinatorSessionId;

const STEP: CommittedModelStep = {
  stepId: 'step-1',
  entryId: assistantEntryId('step-1'),
  committedAt: 1_000,
  messages: [{ role: 'assistant', content: '已登记一条 Decision Ticket' }],
  toolCalls: [],
  usage: { inputTokens: 120, outputTokens: 18, totalTokens: 138 },
};

function baseState(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schemaVersion: COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
    coordinatorSessionId: SESSION_A,
    committedMessages: [
      {
        entryId: userEntryId('submission-1'),
        stepId: userStepId('submission-1'),
        role: 'user',
        content: '开始规划',
      },
      {
        entryId: assistantEntryId('step-1'),
        stepId: 'step-1',
        role: 'assistant',
        content: '已登记一条 Decision Ticket',
      },
    ],
    graphPosition: 'model',
    committedModelSteps: [STEP],
    wakeBatches: [],
    lastCompactionOutcome: null,
    ...overrides,
  };
}

/** 前驱版本（v1）写下的 payload：消息与 step 严格一一对应，消息没有 entryId。 */
function legacyState(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schemaVersion: LEGACY_SESSION_STATE_SCHEMA_VERSION,
    coordinatorSessionId: SESSION_A,
    committedMessages: [{ role: 'assistant', content: '已登记一条 Decision Ticket' }],
    graphPosition: 'model',
    committedModelSteps: [
      {
        stepId: 'step-1',
        committedAt: 1_000,
        messages: [{ role: 'assistant', content: '已登记一条 Decision Ticket' }],
        usage: null,
      },
    ],
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

  // 凭据藏在被原样保存的 tool args 里：闭集字段查不到它，序列化检查必须抓到。
  const nestedCredential = parseCoordinatorSessionState(
    baseState({
      committedMessages: [
        {
          entryId: assistantEntryId('step-1'),
          stepId: 'step-1',
          role: 'assistant',
          content: '先读地图',
          toolCalls: [
            {
              callId: 'call-1',
              name: 'read_map',
              args: { accessToken: 'x' },
              operationId: 'op-1',
              mapOperationId: null,
            },
          ],
        },
      ],
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

test('v1 payload 升级到 v2：entry 与 step 一一对应，身份由 stepId 派生', () => {
  const parsed = parseCoordinatorSessionState(legacyState());

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    return;
  }
  expect(parsed.value.schemaVersion).toBe(COORDINATOR_SESSION_STATE_SCHEMA_VERSION);
  expect(parsed.value.lastCompactionOutcome).toBeNull();
  expect(parsed.value.committedMessages).toHaveLength(1);
  expect(parsed.value.committedModelSteps).toHaveLength(1);

  const step = parsed.value.committedModelSteps[0];
  const entry = parsed.value.committedMessages[0];
  expect(entry?.role).toBe('assistant');
  expect(entry?.stepId).toBe(step?.stepId);
  expect(entry?.entryId).toBe(step?.entryId);
  expect(step?.toolCalls).toEqual([]);
});

test('v1 升级保留全部历史：多条 step 各自的 entry 顺序不变', () => {
  const parsed = parseCoordinatorSessionState(
    legacyState({
      committedMessages: [
        { role: 'assistant', content: '第一步' },
        { role: 'assistant', content: '第二步' },
      ],
      committedModelSteps: [
        { stepId: 'step-1', committedAt: 1_000, messages: [{ role: 'assistant', content: '第一步' }], usage: null },
        { stepId: 'step-2', committedAt: 2_000, messages: [{ role: 'assistant', content: '第二步' }], usage: null },
      ],
    }),
  );

  expect(parsed.ok).toBe(true);
  if (parsed.ok) {
    expect(parsed.value.committedMessages.map((entry) => entry.stepId)).toEqual(['step-1', 'step-2']);
    expect(parsed.value.committedMessages.map((entry) => entry.entryId)).toEqual([
      assistantEntryId('step-1'),
      assistantEntryId('step-2'),
    ]);
  }
});

test('v1 消息数与 step 数不一致时拒绝升级，而不是丢历史或猜顺序', () => {
  const parsed = parseCoordinatorSessionState(
    legacyState({
      committedMessages: [
        { role: 'assistant', content: '第一步' },
        { role: 'assistant', content: '第二步' },
      ],
    }),
  );

  expect(parsed.ok).toBe(false);
  if (!parsed.ok) {
    expect(parsed.field).toBe('sessionState.committedMessages');
  }
});

test('v1 assistant 消息上的 tool_calls 升级出确定性的 OperationId', () => {
  const legacy = legacyState({
    committedMessages: [
      {
        role: 'assistant',
        content: '先读地图',
        toolCalls: [{ id: 'call-1', name: 'read_map', args: { path: 'a' } }],
      },
    ],
    committedModelSteps: [
      { stepId: 'step-1', committedAt: 1_000, messages: [{ role: 'assistant', content: '先读地图' }], usage: null },
    ],
  });

  const first = parseCoordinatorSessionState(legacy);
  const second = parseCoordinatorSessionState(legacy);
  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  if (!first.ok || !second.ok) {
    return;
  }

  const call = first.value.committedModelSteps[0]?.toolCalls[0];
  expect(call?.callId).toBe('call-1');
  expect(call?.operationId).toBe(toolOperationId('step-1', 'call-1'));
  // 从未发起过的 v1 调用没有第二次副作用记录需要沿用。
  expect(call?.mapOperationId).toBeNull();
  // 同一条记录重放两次得到同一组身份：升级本身必须确定。
  expect(second.value.committedModelSteps[0]?.toolCalls).toEqual(first.value.committedModelSteps[0]?.toolCalls);
  expect(second.value.committedMessages).toEqual(first.value.committedMessages);
});
