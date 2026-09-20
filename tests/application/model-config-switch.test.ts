import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import {
  assertSwitchable,
  isNativeWindowCompatible,
  migrateNativeWindowToCapsule,
  switchModelConfiguration,
  type CapsuleDerivationPort,
  type CoordinatorModelConfiguration,
  type SwitchModelConfigurationRequest,
  type SwitchVerification,
} from '../../src/application/coordinator/model-config-switch.js';
import type { CoordinatorSessionId } from '../../src/application/dto/identity.js';
import { openCheckpointStore, type CheckpointStore } from '../../src/adapters/storage/checkpoint-store.js';
import {
  COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
  type CommittedModelStep,
  type CoordinatorSessionState,
  type PortableContextCapsule,
} from '../../src/domain/coordinator/session-state.js';
import {
  capsuleTextOf,
  deriveContextCapsule,
} from '../../src/workflow/coordinator/context.js';
import { SUSPENSION_GRAPH_POSITION, type SuspensionState } from '../../src/application/coordinator/suspension.js';

const SESSION = 'session-a' as CoordinatorSessionId;

let directory = '';
let store: CheckpointStore;

const deriveCapsule: CapsuleDerivationPort = (input) =>
  deriveContextCapsule({ fromStepId: input.fromStepId, toStepId: input.toStepId, steps: input.steps });

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-switch-'));
  const opened = openCheckpointStore({ databasePath: join(directory, 'checkpoints.sqlite') });
  if (opened.kind !== 'opened') {
    throw new Error(opened.message);
  }
  store = opened.store;
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

function configuration(overrides: Partial<CoordinatorModelConfiguration> = {}): CoordinatorModelConfiguration {
  return {
    configurationRef: 'coordinator-default',
    providerIntegration: '@langchain/openai#ChatOpenAI',
    model: 'MiniMax-M3',
    modelOptions: {},
    credentialRefs: ['env:MINIMAX_API_KEY'],
    nativeWindowOwnerRef: 'provider:minimax-m3:generation-2',
    ...overrides,
  };
}

function step(stepId: string, content: string): CommittedModelStep {
  return {
    stepId,
    committedAt: 1_000,
    messages: [{ role: 'assistant', content }],
    usage: null,
  };
}

function seed(state: Partial<CoordinatorSessionState> = {}): void {
  const saved = store.saveCheckpoint({
    schemaVersion: COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
    coordinatorSessionId: SESSION,
    committedMessages: [{ role: 'assistant', content: '先读地图' }],
    graphPosition: SUSPENSION_GRAPH_POSITION,
    committedModelSteps: [step('step-1', '先读地图')],
    wakeBatches: [],
    ...state,
  });
  if (saved.kind !== 'saved') {
    throw new Error(saved.message);
  }
}

const SUSPENDED: SuspensionState = {
  kind: 'suspended',
  coordinationScopeId: 'scope-1' as SuspensionState['coordinationScopeId'],
  coordinatorSessionId: SESSION,
  graphPosition: SUSPENSION_GRAPH_POSITION,
  suspendedAt: 1_000,
  reason: 'no_actionable_work',
  deferredActionableWork: 0,
};

function request(overrides: Partial<SwitchModelConfigurationRequest> = {}): SwitchModelConfigurationRequest {
  return {
    coordinatorSessionId: SESSION,
    current: configuration(),
    next: configuration({ configurationRef: 'coordinator-next', model: 'MiniMax-M4' }),
    switchability: { suspension: SUSPENDED, inFlightModelOperations: 0 },
    sessionRecords: store,
    nativeWindows: store,
    deriveCapsule,
    verify: (): Promise<SwitchVerification> => Promise.resolve({ kind: 'verified' }),
    persistConfiguration: () => ({ kind: 'saved' }),
    clearDerivedCaches: () => 3,
    ...overrides,
  };
}

test('模型循环进行中拒绝切换，配置保持不变', async () => {
  seed();
  let verified = false;

  const result = await switchModelConfiguration(
    request({
      switchability: { suspension: null, inFlightModelOperations: 0 },
      verify: () => {
        verified = true;
        return Promise.resolve({ kind: 'verified' });
      },
    }),
  );

  expect(result.kind).toBe('rejected');
  if (result.kind === 'rejected') {
    expect(result.code).toBe('not_suspended');
    expect(result.configuration.configurationRef).toBe('coordinator-default');
  }
  expect(verified).toBe(false);
});

test('存在在途模型调用时拒绝切换，不产生半切换状态', async () => {
  seed();

  const result = await switchModelConfiguration(
    request({ switchability: { suspension: SUSPENDED, inFlightModelOperations: 2 } }),
  );

  expect(result.kind).toBe('rejected');
  if (result.kind === 'rejected') {
    expect(result.code).toBe('operations_in_flight');
    expect(result.message).toContain('2');
  }
  expect(assertSwitchable({ suspension: SUSPENDED, inFlightModelOperations: 0 })).toEqual({
    kind: 'switchable',
  });
});

test('切换成功时先持久化 checkpoint，再清空旧 cache 与维护计划', async () => {
  seed();
  const order: string[] = [];

  const result = await switchModelConfiguration(
    request({
      sessionRecords: {
        loadCheckpoint: (sessionId) => {
          order.push('persist:load');
          return store.loadCheckpoint(sessionId);
        },
        saveCheckpoint: (state) => {
          order.push('persist:save');
          return store.saveCheckpoint(state);
        },
        readCommittedMessages: (sessionId) => store.readCommittedMessages(sessionId),
      },
      clearDerivedCaches: () => {
        order.push('cache:clear');
        return 3;
      },
      verify: () => {
        order.push('verify');
        return Promise.resolve({ kind: 'verified' });
      },
      persistConfiguration: () => {
        order.push('binding:save');
        return { kind: 'saved' };
      },
    }),
  );

  expect(result.kind).toBe('switched');
  if (result.kind === 'switched') {
    expect(result.configuration.configurationRef).toBe('coordinator-next');
    expect(result.clearedMaintenanceCycles).toBe(3);
  }
  expect(order).toEqual(['persist:load', 'persist:save', 'cache:clear', 'verify', 'binding:save']);
});

test('不兼容的 native window 先迁移为 Capsule，迁移成功才继续', async () => {
  seed();
  const saved = store.saveNativeWindowOwner(SESSION, {
    ownerRef: 'provider:minimax-m3:generation-2',
    items: [{ itemId: 'enc-1', position: 0, mediaType: 'application/octet-stream', opaque: { blob: 'AAAA' } }],
  });
  expect(saved.kind).toBe('saved');

  const result = await switchModelConfiguration(
    request({ next: configuration({ configurationRef: 'coordinator-next', nativeWindowOwnerRef: 'provider:minimax-m4:generation-1' }) }),
  );

  expect(result.kind).toBe('switched');
  if (result.kind === 'switched') {
    expect(result.migratedNativeWindow).toBe(true);
  }
  // 原生项已清除，Capsule 成为该区间的表示；底层原始消息仍可读回。
  expect(store.loadNativeWindowOwner(SESSION)).toBeNull();
  expect(store.loadPortableCapsule(SESSION)?.replacedFromStepId).toBe('step-1');
  expect(store.readCommittedMessages(SESSION)).toEqual([{ role: 'assistant', content: '先读地图' }]);
});

test('迁移失败时保持原配置并保持 suspended 或 blocked', async () => {
  seed();
  store.saveNativeWindowOwner(SESSION, {
    ownerRef: 'provider:minimax-m3:generation-2',
    items: [{ itemId: 'enc-1', position: 0, mediaType: 'application/octet-stream', opaque: { blob: 'AAAA' } }],
  });

  const result = await switchModelConfiguration(
    request({
      next: configuration({ configurationRef: 'coordinator-next', nativeWindowOwnerRef: 'provider:other:1' }),
      nativeWindows: {
        savePortableCapsule: () => ({ kind: 'failed', message: '磁盘只读' }),
        clearNativeWindowOwner: () => ({ kind: 'saved' }),
      },
    }),
  );

  expect(result.kind).toBe('rejected');
  if (result.kind === 'rejected') {
    expect(result.code).toBe('migration_failed');
    expect(result.configuration.configurationRef).toBe('coordinator-default');
  }
  // 原生项未被清除：迁移没有成功就不能丢掉原表示。
  expect(store.loadNativeWindowOwner(SESSION)?.ownerRef).toBe('provider:minimax-m3:generation-2');
});

test('兼容的 native window 不触发迁移', async () => {
  seed();
  store.saveNativeWindowOwner(SESSION, {
    ownerRef: 'provider:minimax-m3:generation-2',
    items: [{ itemId: 'enc-1', position: 0, mediaType: 'application/octet-stream', opaque: { blob: 'AAAA' } }],
  });

  const compatible = configuration({ configurationRef: 'coordinator-next', model: 'MiniMax-M4' });
  expect(isNativeWindowCompatible(compatible, { ownerRef: compatible.nativeWindowOwnerRef ?? '', items: [] })).toBe(true);

  const result = await switchModelConfiguration(
    request({
      next: compatible,
      nativeWindows: {
        savePortableCapsule: (): never => {
          throw new Error('不应被调用');
        },
        clearNativeWindowOwner: (): never => {
          throw new Error('不应被调用');
        },
      },
    }),
  );

  expect(result.kind).toBe('switched');
  if (result.kind === 'switched') {
    expect(result.migratedNativeWindow).toBe(false);
  }
});

test('核验失败时整次切换失败，不自动回退也不半切换', async () => {
  seed();
  let cleared = 0;

  const result = await switchModelConfiguration(
    request({
      verify: () => Promise.resolve({ kind: 'rejected', message: '缺少 tool calling' }),
      clearDerivedCaches: () => {
        cleared += 1;
        return 1;
      },
    }),
  );

  expect(result.kind).toBe('rejected');
  if (result.kind === 'rejected') {
    expect(result.code).toBe('verification_failed');
    expect(result.message).toContain('tool calling');
    expect(result.configuration.configurationRef).toBe('coordinator-default');
  }
  // 核验发生在清空之后；失败时调用方必须按原配置继续，而不是改投其他模型。
  expect(cleared).toBe(1);
});

test('新配置绑定无法持久化时不报告切换成功', async () => {
  seed();

  const result = await switchModelConfiguration(request({
    persistConfiguration: () => ({ kind: 'failed', message: 'revision stale' }),
  }));

  expect(result.kind).toBe('rejected');
  if (result.kind === 'rejected') {
    expect(result.code).toBe('persist_failed');
    expect(result.configuration.configurationRef).toBe('coordinator-default');
  }
});

test('没有可持久化会话记录时拒绝切换', async () => {
  const result = await switchModelConfiguration(request());

  expect(result.kind).toBe('rejected');
  if (result.kind === 'rejected') {
    expect(result.code).toBe('persist_failed');
  }
});

test('migrateNativeWindowToCapsule 在没有原生项时不动作', () => {
  const result = migrateNativeWindowToCapsule({
    coordinatorSessionId: SESSION,
    owner: null,
    sessionState: {
      schemaVersion: COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
      coordinatorSessionId: SESSION,
      committedMessages: [],
      graphPosition: 'start',
      committedModelSteps: [],
      wakeBatches: [],
    },
    deriveCapsule,
    checkpoints: store,
  });

  expect(result).toEqual({ kind: 'not-needed' });
});

test('没有已提交历史时无法迁移，保持阻塞而不是丢弃原生项', () => {
  const result = migrateNativeWindowToCapsule({
    coordinatorSessionId: SESSION,
    owner: { ownerRef: 'provider:x:1', items: [] },
    sessionState: {
      schemaVersion: COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
      coordinatorSessionId: SESSION,
      committedMessages: [],
      graphPosition: 'start',
      committedModelSteps: [],
      wakeBatches: [],
    },
    deriveCapsule,
    checkpoints: store,
  });

  expect(result.kind).toBe('failed');
  if (result.kind === 'failed') {
    expect(result.reason).toContain('没有可派生 Capsule');
  }
});

test('Capsule 派生输入直接使用已提交 step 与消息', () => {
  const capsule: PortableContextCapsule = deriveCapsule({
    fromStepId: 'step-1',
    toStepId: 'step-2',
    steps: [step('step-1', '一'), step('step-2', '二')],
  });

  expect(capsule.kind).toBe('derived_context_capsule');
  expect(capsule.text).toBe(capsuleTextOf('capsule:step-1..step-2', [
    { stepId: 'step-1', role: 'assistant', content: '一' },
    { stepId: 'step-2', role: 'assistant', content: '二' },
  ]));
});
