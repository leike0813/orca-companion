/**
 * IP-9：ControllerService 接缝的行为测试
 * （Requirement「ControllerService 统一界面层的查询、命令与事件接缝」）。
 *
 * 覆盖两个 Scenario 与 IC-11 的调用约束：
 * - 每个 command / query variant 只委派一次到对应的既有用例，结果原样透传；
 * - 过期的 Pending Interaction 回答被拒绝、零副作用，交互保持 open，普通 Session 消息不满足交互；
 * - 订阅者只收到语义事件：keepalive、stderr、poll timeout、无变化对账与诊断日志不进入事件流，
 *   取消订阅只移除该 listener；
 * - façade 不直连 store 或 Orca adapter：已有真实 store 用例可用时，走委派的入口也不会触碰它们；
 * - Scope 初始化走既有 `initializeCoordinationScope`（Scope、首个 Session 与规划责任一起建立）。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { openCoordinationStore, type CoordinationStore } from '../../src/adapters/storage/coordination-store.js';
import { acquireExecutionLease, acquireRuntimeLease } from '../../src/application/coordination/lease-service.js';
import { answerPendingInteraction } from '../../src/application/coordination/pending-interaction.js';
import { createScopeControlService } from '../../src/application/coordination/scope-control-service.js';
import {
  createControllerService,
  projectControllerSnapshot,
  toSemanticEvent,
  type AnswerPendingInteractionCommand,
  type CompactSessionCommand,
  type ControllerCommand,
  type ControllerCommandResult,
  type ControllerEventSource,
  type ControllerNotification,
  type ControllerSnapshot,
  type ControllerSnapshotReaderInput,
  type ControllerTranscriptReaderInput,
  type DelegatedOutcome,
  type ExecutionHandoffCommand,
  type InitializeScopeCommand,
  type PlanningHandoffCommand,
  type ScopeControlCommand,
  type SendSessionMessageCommand,
  type SemanticEvent,
  type SwitchModelConfigurationCommand,
} from '../../src/application/controller-service.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  DispatchId,
  GraphGeneration,
  InteractionId,
  PlanningCycleId,
  Revision,
  RuntimeIncarnationId,
  WorkerTaskId,
} from '../../src/application/dto/identity.js';
import type { ExecutionHandoffReviewFacts } from '../../src/application/handoff/execution-handoff.js';
import { initializeCoordinationScope } from '../../src/application/planning/initialize-scope.js';
import type { HandoffReviewFacts } from '../../src/application/planning/planning-handoff.js';
import type {
  BranchCoordinationStore,
  CoordinationCommand,
  CoordinationWriter,
} from '../../src/application/ports/branch-coordination-store.js';
import type { ExecutionBackend } from '../../src/application/ports/execution-backend.js';

const SCOPE = 'scope-controller' as CoordinationScopeId;
const OTHER_SCOPE = 'scope-controller-new' as CoordinationScopeId;
const SESSION = 'session-a' as CoordinatorSessionId;
const OTHER_SESSION = 'session-b' as CoordinatorSessionId;
const INC = 'inc-a' as RuntimeIncarnationId;
const CYCLE = 'cycle-1' as PlanningCycleId;

const WRITER: CoordinationWriter = {
  coordinatorSessionId: SESSION,
  runtimeIncarnationId: INC,
  fencingGeneration: 1,
};

/** 两个 handoff 命令的事实载荷必须满足既有用例的契约类型，façade 只做搬运。 */
const PLANNING_REVIEW_FACTS: HandoffReviewFacts = {
  currentMapRevision: 1,
  currentPlanRevision: 1,
  openDecisionTickets: 0,
  candidate: null,
};

const PLANNING_CUTOVER_FACTS: Omit<HandoffReviewFacts, 'openDecisionTickets'> = {
  currentMapRevision: 1,
  currentPlanRevision: 1,
  candidate: null,
};

const EXECUTION_REVIEW_FACTS: ExecutionHandoffReviewFacts = {
  scopeRevision: 1,
  currentGraphGeneration: 1 as GraphGeneration,
  targetLifecycleState: 'registered',
  sourceCheckpoint: 'recoverable',
  capsulePortable: true,
};

let directory = '';
let store: CoordinationStore;
let now = 1_000;

const clock = (): number => now;

/** 计数 store：用于断言 façade 在某些入口上零 store 访问。 */
function countingStore(inner: BranchCoordinationStore): {
  readonly store: BranchCoordinationStore;
  readonly commands: CoordinationCommand[];
  readonly reads: number;
} {
  const commands: CoordinationCommand[] = [];
  let reads = 0;
  const wrapper: BranchCoordinationStore = {
    query: (input) => {
      reads += 1;
      return inner.query(input);
    },
    transact: (input) => {
      commands.push(input);
      return inner.transact(input);
    },
  };
  return {
    store: wrapper,
    commands,
    get reads() {
      return reads;
    },
  };
}

/** Orca adapter 的替身：被 façade 直接调用即抛错，这样「零调用」是结构性断言。 */
function forbiddenBackend(): { readonly backend: ExecutionBackend; readonly calls: { query: number; mutate: number } } {
  const calls = { query: 0, mutate: 0 };
  return {
    backend: {
      query: () => {
        calls.query += 1;
        return Promise.reject(new Error('ControllerService 不得直接调用 Orca adapter'));
      },
      mutate: () => {
        calls.mutate += 1;
        return Promise.reject(new Error('ControllerService 不得直接调用 Orca adapter'));
      },
    },
    calls,
  };
}

type PortCalls = {
  readonly sessionMessages: SendSessionMessageCommand[];
  readonly compaction: CompactSessionCommand[];
  readonly modelConfiguration: SwitchModelConfigurationCommand[];
  readonly planningHandoff: PlanningHandoffCommand[];
  readonly scopeControl: ScopeControlCommand[];
  readonly pendingInteractions: AnswerPendingInteractionCommand[];
  readonly executionHandoff: ExecutionHandoffCommand[];
  readonly scopeInitialization: InitializeScopeCommand[];
  readonly snapshots: ControllerSnapshotReaderInput[];
  readonly transcript: ControllerTranscriptReaderInput[];
};

function emptyCalls(): PortCalls {
  return {
    sessionMessages: [],
    compaction: [],
    modelConfiguration: [],
    planningHandoff: [],
    scopeControl: [],
    pendingInteractions: [],
    executionHandoff: [],
    scopeInitialization: [],
    snapshots: [],
    transcript: [],
  };
}

function accepted(summary: string): DelegatedOutcome {
  return { kind: 'accepted', revision: 5, summary };
}

function fakeEventSource(): {
  readonly source: ControllerEventSource;
  emit(notification: ControllerNotification): void;
  unsubscribed(): number;
} {
  const listeners = new Set<(notification: ControllerNotification) => void>();
  let unsubscribes = 0;
  return {
    source: {
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          unsubscribes += 1;
          listeners.delete(listener);
        };
      },
    },
    emit: (notification) => {
      for (const listener of [...listeners]) {
        listener(notification);
      }
    },
    unsubscribed: () => unsubscribes,
  };
}

function readScopeRevision(): Revision {
  const scope = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
  if (scope.kind !== 'scope' || scope.scope === null) {
    throw new Error('Scope 不存在');
  }
  return scope.scope.revision;
}

function snapshotOf(coordinationScopeId: CoordinationScopeId): ControllerSnapshot {
  const result = store.query({ kind: 'snapshot', coordinationScopeId });
  if (result.kind !== 'snapshot') {
    throw new Error('无法读取 snapshot');
  }
  const counters = store.query({ kind: 'budget-counters', coordinationScopeId });
  return projectControllerSnapshot({
    snapshot: result.snapshot,
    budgets: counters.kind === 'budget-counters' ? counters.counters : [],
    graphGeneration: null,
    frontier: [],
    workers: [],
    extraBlockers: [],
    maintenance: null,
    selectedSessionId: null,
  });
}

/**
 * 组装 façade。
 *
 * `realStoreUseCases` 为真时，scope 控制、交互回答、快照与 Scope 初始化都接到计数 store 上的真实
 * 用例；其余入口仍是假 port。这样「委派入口不触碰 store」才是真的有内容。
 */
function harness(options: { readonly realStoreUseCases: boolean }): {
  readonly service: ReturnType<typeof createControllerService>;
  readonly calls: PortCalls;
  readonly counting: ReturnType<typeof countingStore>;
  readonly backend: ReturnType<typeof forbiddenBackend>;
} {
  const counting = countingStore(store);
  const backend = forbiddenBackend();
  const calls = emptyCalls();
  const useCases = options.realStoreUseCases ? counting.store : store;
  const scopeControl = createScopeControlService({
    store: useCases,
    reconciliation: () =>
      Promise.resolve({
        kind: 'reconciled',
        summary: { revision: readScopeRevision(), unresolvedLaneKeys: [] },
      }),
    workers: {
      listActiveDispatches: () => Promise.resolve({ kind: 'listed', dispatchIds: [] }),
      requestStop: () => Promise.resolve('stopped'),
    },
  });

  const service = createControllerService({
    snapshots: (input) => {
      calls.snapshots.push(input);
      return snapshotOf(SCOPE);
    },
    transcript: (input) => {
      calls.transcript.push(input);
      return { coordinatorSessionId: input.coordinatorSessionId, messages: [], nextCursor: null };
    },
    sessionMessages: (input) => {
      calls.sessionMessages.push(input);
      return Promise.resolve(accepted('session-message'));
    },
    compaction: (input) => {
      calls.compaction.push(input);
      return Promise.resolve(accepted('compacted'));
    },
    modelConfiguration: (input) => {
      calls.modelConfiguration.push(input);
      return Promise.resolve(accepted('switched'));
    },
    planningHandoff: (input) => {
      calls.planningHandoff.push(input);
      return Promise.resolve(accepted(`planning-${input.action}`));
    },
    scopeControl: async (input) => {
      calls.scopeControl.push(input);
      const result =
        input.action === 'pause'
          ? scopeControl.pause({ coordinationScopeId: input.coordinationScopeId, writer: input.writer })
          : input.action === 'cancel'
            ? await scopeControl.cancel({ coordinationScopeId: input.coordinationScopeId, writer: input.writer })
            : input.action === 'resume'
              ? await scopeControl.resume({ coordinationScopeId: input.coordinationScopeId, writer: input.writer })
              : scopeControl.exit();
      return result.kind === 'rejected'
        ? { kind: 'rejected', code: result.code, message: result.message }
        : { kind: 'accepted', revision: null, summary: result.kind };
    },
    pendingInteractions: (input) => {
      calls.pendingInteractions.push(input);
      const result = answerPendingInteraction({
        store: useCases,
        coordinationScopeId: input.coordinationScopeId,
        writer: input.writer,
        interactionId: input.interactionId,
        expectedRevision: input.expectedRevision,
        answerRef: input.answerRef,
      });
      return Promise.resolve(
        result.kind === 'answered'
          ? { kind: 'accepted' as const, revision: result.revision, summary: 'answered' }
          : { kind: 'rejected' as const, code: result.code, message: result.message },
      );
    },
    executionHandoff: (input) => {
      calls.executionHandoff.push(input);
      return Promise.resolve(accepted(`execution-${input.action}`));
    },
    scopeInitialization: (input) => {
      calls.scopeInitialization.push(input);
      const result = initializeCoordinationScope({
        store: useCases,
        coordinationScopeId: input.coordinationScopeId,
        coordinatorSessionId: input.coordinatorSessionId,
        coordinatorModelConfigurationRef: input.coordinatorModelConfigurationRef,
        planningCycleId: input.planningCycleId as PlanningCycleId,
      });
      return Promise.resolve(
        result.kind === 'initialized'
          ? { kind: 'accepted' as const, revision: result.revision, summary: 'initialized' }
          : { kind: 'rejected' as const, code: result.code, message: result.message },
      );
    },
    ...(options.realStoreUseCases ? { events: fakeEventSource().source } : {}),
  });

  return { service, calls, counting, backend };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-controller-service-'));
  now = 1_000;
  const opened = openCoordinationStore({ databasePath: join(directory, 'coordination.sqlite'), clock });
  if (opened.kind !== 'opened') {
    throw new Error(opened.message);
  }
  store = opened.store;
  const initialized = initializeCoordinationScope({
    store,
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION,
    coordinatorModelConfigurationRef: 'model-config-a',
    planningCycleId: CYCLE,
  });
  if (initialized.kind !== 'initialized') {
    throw new Error('无法创建测试 Scope');
  }
  const acquired = acquireRuntimeLease(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION,
    runtimeIncarnationId: INC,
    fencingGeneration: 0,
  });
  if (acquired.kind !== 'acquired') {
    throw new Error('无法取得 Runtime Lease');
  }
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test('每个 command variant 只委派一次到对应用例，并原样透传结果', async () => {
  const commands: readonly { readonly command: ControllerCommand; readonly expected: string }[] = [
    {
      command: { kind: 'send-session-message', coordinationScopeId: SCOPE, writer: WRITER, coordinatorSessionId: SESSION, content: '你好' },
      expected: 'sessionMessages',
    },
    {
      command: { kind: 'compact-session', coordinationScopeId: SCOPE, writer: WRITER, coordinatorSessionId: SESSION, reason: 'manual' },
      expected: 'compaction',
    },
    {
      command: { kind: 'switch-model-configuration', coordinationScopeId: SCOPE, writer: WRITER, coordinatorSessionId: SESSION, nextConfigurationRef: 'config-b' },
      expected: 'modelConfiguration',
    },
    {
      command: {
        kind: 'planning-handoff',
        action: 'prepare',
        coordinationScopeId: SCOPE,
        writer: WRITER,
        proposalId: 'proposal-1',
        targetCoordinatorSessionId: OTHER_SESSION,
        mapRevision: 1,
        planRevision: 1,
        graphId: null,
        graphVersion: null,
        capsuleRef: null,
      },
      expected: 'planningHandoff',
    },
    {
      command: { kind: 'planning-handoff', action: 'review', coordinationScopeId: SCOPE, writer: WRITER, proposalId: 'proposal-1', facts: PLANNING_REVIEW_FACTS },
      expected: 'planningHandoff',
    },
    {
      command: { kind: 'planning-handoff', action: 'cutover', coordinationScopeId: SCOPE, writer: WRITER, proposalId: 'proposal-1', facts: PLANNING_CUTOVER_FACTS },
      expected: 'planningHandoff',
    },
    {
      command: { kind: 'planning-handoff', action: 'cancel', coordinationScopeId: SCOPE, writer: WRITER, proposalId: 'proposal-1' },
      expected: 'planningHandoff',
    },
    {
      command: { kind: 'scope-control', action: 'pause', coordinationScopeId: SCOPE, writer: WRITER },
      expected: 'scopeControl',
    },
    {
      command: { kind: 'scope-control', action: 'cancel', coordinationScopeId: SCOPE, writer: WRITER },
      expected: 'scopeControl',
    },
    {
      command: { kind: 'execution-handoff', action: 'prepare', coordinationScopeId: SCOPE, writer: WRITER, handoffId: 'handoff-1', targetSessionId: OTHER_SESSION, graphGeneration: 1, capsuleRef: null },
      expected: 'executionHandoff',
    },
    {
      command: { kind: 'execution-handoff', action: 'review', coordinationScopeId: SCOPE, writer: WRITER, handoffId: 'handoff-1', facts: EXECUTION_REVIEW_FACTS },
      expected: 'executionHandoff',
    },
    {
      command: { kind: 'execution-handoff', action: 'cutover', coordinationScopeId: SCOPE, writer: WRITER, handoffId: 'handoff-1' },
      expected: 'executionHandoff',
    },
    {
      command: { kind: 'execution-handoff', action: 'cancel', coordinationScopeId: SCOPE, writer: WRITER, handoffId: 'handoff-1' },
      expected: 'executionHandoff',
    },
    {
      command: {
        kind: 'initialize-scope',
        coordinationScopeId: OTHER_SCOPE,
        coordinatorSessionId: OTHER_SESSION,
        coordinatorModelConfigurationRef: 'model-config-b',
        planningCycleId: 'cycle-2',
        writer: WRITER,
      },
      expected: 'scopeInitialization',
    },
  ];

  for (const { command, expected } of commands) {
    const { service, calls } = harness({ realStoreUseCases: true });
    const result = await service.execute(command);
    expect(result.kind, command.kind).toBe('accepted');
    const portCalls = Object.entries(calls).filter(([name]) => name !== 'snapshots' && name !== 'transcript');
    for (const [name, recorded] of portCalls) {
      expect(recorded.length, `${command.kind}/${'action' in command ? command.action : ''} → ${name}`).toBe(
        name === expected ? 1 : 0,
      );
    }
  }
});

test('每个 query variant 只委派一次到对应读取用例', async () => {
  const { service, calls } = harness({ realStoreUseCases: true });

  const snapshot = await service.query({ kind: 'snapshot', coordinationScopeId: SCOPE });
  expect(snapshot.kind).toBe('snapshot');
  expect(calls.snapshots).toEqual([{ coordinationScopeId: SCOPE, selectedSessionId: null }]);
  expect(snapshot.kind === 'snapshot' ? snapshot.snapshot.coordinationScopeId : null).toBe(SCOPE);

  const transcript = await service.query({
    kind: 'session-transcript',
    coordinatorSessionId: SESSION,
    cursor: 'cursor-1',
  });
  expect(transcript.kind).toBe('session-transcript');
  expect(calls.transcript).toEqual([{ coordinatorSessionId: SESSION, cursor: 'cursor-1' }]);
  expect(calls.snapshots).toHaveLength(1);
});

test('过期的 Pending Interaction 回答被拒绝：零副作用、交互保持 open，且不产生 Orca mutation', async () => {
  const { service, counting, backend } = harness({ realStoreUseCases: true });
  const recorded = store.transact({
    kind: 'record-pending-interaction',
    coordinationScopeId: SCOPE,
    expectedRevision: readScopeRevision(),
    writer: WRITER,
    interactionId: 'interaction-1' as InteractionId,
    ownerCoordinatorSessionId: SESSION,
    subjectRef: { kind: 'worker-question', id: 'question-1' },
  });
  expect(recorded.kind).toBe('committed');
  const snapshotAfterRecord = store.query({ kind: 'snapshot', coordinationScopeId: SCOPE });
  const interactionRecord =
    snapshotAfterRecord.kind === 'snapshot'
      ? snapshotAfterRecord.snapshot.pendingInteractions.find(
          (entry) => entry.interactionId === ('interaction-1' as InteractionId),
        )
      : undefined;
  if (interactionRecord === undefined) {
    throw new Error('无法读回交互绑定');
  }
  const binding = interactionRecord.expectedRevision;
  // 记录之后还有写入：交互冻结的绑定 revision 仍然是创建时的那个。
  store.transact({
    kind: 'record-control-state',
    coordinationScopeId: SCOPE,
    expectedRevision: readScopeRevision(),
    writer: WRITER,
    controlState: 'paused',
  });

  const transactsBefore = counting.commands.length;
  const readsBefore = counting.reads;
  const result = await service.execute({
    kind: 'answer-pending-interaction',
    coordinationScopeId: SCOPE,
    writer: WRITER,
    interactionId: 'interaction-1' as InteractionId,
    // 过期的回答绑定的是提问之前的 revision。
    expectedRevision: binding - 1,
    answerRef: { kind: 'answer', id: 'answer-1' },
  });

  expect(result.kind).toBe('rejected');
  expect(result.kind === 'rejected' ? result.code : null).toBe('stale_revision');
  // 零副作用：没有 store 写入，也没有 Orca mutation。
  expect(counting.commands.length).toBe(transactsBefore);
  expect(counting.reads).toBeGreaterThanOrEqual(readsBefore);
  expect(backend.calls).toEqual({ query: 0, mutate: 0 });
  const snapshot = store.query({ kind: 'snapshot', coordinationScopeId: SCOPE });
  const interaction =
    snapshot.kind === 'snapshot'
      ? snapshot.snapshot.pendingInteractions.find((entry) => entry.interactionId === ('interaction-1' as InteractionId))
      : undefined;
  expect(interaction?.state).toBe('open');
});

test('普通 Session 消息不满足 Pending Interaction', async () => {
  const { service, calls } = harness({ realStoreUseCases: true });
  store.transact({
    kind: 'record-pending-interaction',
    coordinationScopeId: SCOPE,
    expectedRevision: readScopeRevision(),
    writer: WRITER,
    interactionId: 'interaction-2' as InteractionId,
    ownerCoordinatorSessionId: SESSION,
    subjectRef: { kind: 'worker-question', id: 'question-2' },
  });

  const result = await service.execute({
    kind: 'send-session-message',
    coordinationScopeId: SCOPE,
    writer: WRITER,
    coordinatorSessionId: SESSION,
    content: '这就是回答？',
  });

  expect(result.kind).toBe('accepted');
  expect(calls.sessionMessages).toHaveLength(1);
  expect(calls.pendingInteractions).toEqual([]);
  const snapshot = store.query({ kind: 'snapshot', coordinationScopeId: SCOPE });
  const interaction =
    snapshot.kind === 'snapshot'
      ? snapshot.snapshot.pendingInteractions.find((entry) => entry.interactionId === ('interaction-2' as InteractionId))
      : undefined;
  expect(interaction?.state).toBe('open');
});

test('订阅者只收到语义事件，取消订阅只移除 listener', () => {
  const events = fakeEventSource();
  const received: SemanticEvent[] = [];
  const other: SemanticEvent[] = [];
  const service = createControllerService({
    snapshots: () => snapshotOf(SCOPE),
    transcript: (input) => ({ coordinatorSessionId: input.coordinatorSessionId, messages: [], nextCursor: null }),
    sessionMessages: () => Promise.resolve(accepted('ok')),
    compaction: () => Promise.resolve(accepted('ok')),
    modelConfiguration: () => Promise.resolve(accepted('ok')),
    planningHandoff: () => Promise.resolve(accepted('ok')),
    scopeControl: () => Promise.resolve(accepted('ok')),
    pendingInteractions: () => Promise.resolve(accepted('ok')),
    executionHandoff: () => Promise.resolve(accepted('ok')),
    scopeInitialization: () => Promise.resolve(accepted('ok')),
    events: events.source,
  });

  const unsubscribe = service.subscribe((event) => received.push(event));
  service.subscribe((event) => other.push(event));

  events.emit({ kind: 'keepalive', at: now });
  events.emit({ kind: 'stderr', line: 'noise' });
  events.emit({ kind: 'poll-timeout', source: 'worker-read' });
  events.emit({ kind: 'unchanged-reconciliation', at: now });
  events.emit({ kind: 'diagnostic', message: 'noise' });
  events.emit({ kind: 'state-changed', coordinationScopeId: SCOPE, revision: 1, reason: 'committed' });
  events.emit({
    kind: 'interaction-opened',
    coordinationScopeId: SCOPE,
    interactionId: 'interaction-1',
    expectedRevision: 1,
  });

  expect(received.map((event) => event.kind)).toEqual(['state-changed', 'interaction-opened']);
  expect(other).toHaveLength(2);

  unsubscribe();
  events.emit({ kind: 'state-changed', coordinationScopeId: SCOPE, revision: 2, reason: 'committed' });

  // 取消订阅只移除该 listener：另一个订阅者仍然收到事件，事件源没有被取消订阅。
  expect(received).toHaveLength(2);
  expect(other).toHaveLength(3);
  expect(events.unsubscribed()).toBe(0);
});

test('噪声通知在 toSemanticEvent 处被丢弃', () => {
  expect(toSemanticEvent({ kind: 'keepalive', at: 1 })).toBeNull();
  expect(toSemanticEvent({ kind: 'stderr', line: 'x' })).toBeNull();
  expect(toSemanticEvent({ kind: 'poll-timeout', source: 'x' })).toBeNull();
  expect(toSemanticEvent({ kind: 'unchanged-reconciliation', at: 1 })).toBeNull();
  expect(toSemanticEvent({ kind: 'diagnostic', message: 'x' })).toBeNull();
  expect(
    toSemanticEvent({ kind: 'state-changed', coordinationScopeId: SCOPE, revision: 1, reason: 'x' })?.kind,
  ).toBe('state-changed');
});

test('façade 不直连 store 或 Orca adapter：委派入口不触碰它们，走真实用例时才触碰', async () => {
  const { service, counting, backend } = harness({ realStoreUseCases: true });

  for (const command of [
    { kind: 'send-session-message', coordinationScopeId: SCOPE, writer: WRITER, coordinatorSessionId: SESSION, content: 'hi' },
    { kind: 'compact-session', coordinationScopeId: SCOPE, writer: WRITER, coordinatorSessionId: SESSION, reason: 'manual' },
    { kind: 'switch-model-configuration', coordinationScopeId: SCOPE, writer: WRITER, coordinatorSessionId: SESSION, nextConfigurationRef: 'config-b' },
    { kind: 'execution-handoff', action: 'cancel', coordinationScopeId: SCOPE, writer: WRITER, handoffId: 'handoff-1' },
  ] satisfies readonly ControllerCommand[]) {
    const result: ControllerCommandResult = await service.execute(command);
    expect(result.kind).toBe('accepted');
  }
  expect(counting.commands).toEqual([]);
  expect(counting.reads).toBe(0);
  expect(backend.calls).toEqual({ query: 0, mutate: 0 });

  // 正向对照：真正需要状态转换的入口会经由既有用例触碰 store，说明计数确实有效。
  const paused = await service.execute({
    kind: 'scope-control',
    action: 'pause',
    coordinationScopeId: SCOPE,
    writer: WRITER,
  });
  expect(paused.kind).toBe('accepted');
  expect(counting.commands.filter((command) => command.kind === 'record-control-state')).toHaveLength(1);
  expect(backend.calls).toEqual({ query: 0, mutate: 0 });
});

test('Scope 初始化走既有 initializeCoordinationScope', async () => {
  const { service, calls } = harness({ realStoreUseCases: true });

  const result = await service.execute({
    kind: 'initialize-scope',
    coordinationScopeId: OTHER_SCOPE,
    coordinatorSessionId: OTHER_SESSION,
    coordinatorModelConfigurationRef: 'model-config-b',
    planningCycleId: 'cycle-2',
    writer: WRITER,
  });

  expect(result.kind).toBe('accepted');
  expect(calls.scopeInitialization).toHaveLength(1);
  const snapshot = store.query({ kind: 'snapshot', coordinationScopeId: OTHER_SCOPE });
  if (snapshot.kind !== 'snapshot') {
    throw new Error('初始化后无法读取 Scope');
  }
  expect(snapshot.snapshot.scope.mode).toBe('route_planning');
  expect(snapshot.snapshot.sessions.map((session) => session.coordinatorSessionId)).toEqual([OTHER_SESSION]);
  // 首个 Session 同时是规划责任方，这是 initializeCoordinationScope 的固有行为。
  expect(snapshot.snapshot.planningResponsibility?.coordinatorSessionId).toBe(OTHER_SESSION);
});

test('快照只携带可投影字段：不含 receipt、结果正文、provider 对象与凭据', () => {
  // 记录一条带 Orca 结果引用的 Delivery 结算：投影必须把它挡在快照之外。
  const lease = acquireExecutionLease(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION,
    runtimeIncarnationId: INC,
    fencingGeneration: WRITER.fencingGeneration,
  });
  expect(lease.kind).toBe('acquired');
  const settled = store.transact({
    kind: 'record-delivery-settlement',
    coordinationScopeId: SCOPE,
    expectedRevision: readScopeRevision(),
    writer: WRITER,
    dedupeKey: 'delivery-1',
    deliveryId: 'delivery-1',
    runId: 'run-1',
    consumerGeneration: 1,
    workerTaskId: 'task-1' as WorkerTaskId,
    dispatchId: 'dispatch-1' as DispatchId,
    attemptId: 'attempt-1',
    role: 'implementation',
    contractRevision: 1,
    orcaResultRef: 'orca-result-secret-body',
  });
  expect(settled.kind).toBe('committed');

  const snapshot = snapshotOf(SCOPE);
  const serialized = JSON.stringify(snapshot);

  expect(Object.keys(snapshot).sort()).toEqual(
    [
      'authorization',
      'blockers',
      'budgets',
      'controlState',
      'coordinationScopeId',
      'executionLeaseHolderSessionId',
      'frontier',
      'graph',
      'handoffs',
      'interactions',
      'maintenance',
      'mapRevision',
      'mode',
      'planningCycleId',
      'recoveries',
      'revision',
      'selectedSessionId',
      'sessions',
      'workers',
    ].sort(),
  );
  for (const forbidden of ['orcaResultRef', 'orca-result-secret-body', 'receipt', 'credential', 'provider']) {
    expect(serialized, forbidden).not.toContain(forbidden);
  }
});
