/**
 * IP-9：应用层事件契约（Owner: `m1-wire-foreground-planning-runtime`）。
 *
 * 事件流只承载语义事件与发布者给出的身份/归属：噪声在 façade 被丢弃，归属逐条照搬（Scope 级为
 * `null`，不伪造 Session），取消订阅只移除那个 listener。事件发布是纯转发——它不读也不写任何业务
 * 状态，因此这里只装配 façade 与可控事件源，不打开真实 store。
 */

import { expect, test } from 'vitest';

import {
  createControllerService,
  type ControllerEventSource,
  type ControllerNotification,
  type ControllerNotificationMessage,
  type ControllerService,
  type ControllerServiceDependencies,
  type SemanticEvent,
  type SemanticEventEnvelope,
} from '../../src/application/controller-service.js';

const SCOPE = 'scope-events';

/** 具体语义事件 payload；测试只关心它是否原样到达。 */
function stateChanged(revision: number): ControllerNotification {
  return { kind: 'state-changed', coordinationScopeId: SCOPE, revision, reason: 'worker-task-verified-accepted' };
}

/**
 * fake 依赖：任何一次调用都记录并抛出。
 *
 * 事件发布不该碰任何用例或读取，所以「被调用」本身就是缺陷；计数因此是空的，而不是某个期望值。
 */
function fakeDependencies(events: ControllerEventSource): {
  readonly dependencies: ControllerServiceDependencies;
  readonly calls: readonly string[];
} {
  const calls: string[] = [];
  const forbidden =
    (name: string) =>
    (): never => {
      calls.push(name);
      throw new Error(`事件发布不得调用 ${name}`);
    };
  return {
    dependencies: {
      events,
      snapshots: forbidden('snapshots'),
      transcript: forbidden('transcript'),
      sessionMessages: forbidden('sessionMessages'),
      compaction: forbidden('compaction'),
      modelConfiguration: forbidden('modelConfiguration'),
      planningHandoff: forbidden('planningHandoff'),
      scopeControl: forbidden('scopeControl'),
      pendingInteractions: forbidden('pendingInteractions'),
      executionHandoff: forbidden('executionHandoff'),
      graphEvolution: forbidden('graphEvolution'),
      scopeInitialization: forbidden('scopeInitialization'),
    },
    calls,
  };
}

/** 可控事件源：测试自己决定发布哪条通知、带哪个 envelope。 */
function controllableSource(): {
  readonly source: ControllerEventSource;
  publish(notification: ControllerNotification, envelope: SemanticEventEnvelope): void;
} {
  const listeners = new Set<(message: ControllerNotificationMessage) => void>();
  return {
    source: {
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    publish: (notification, envelope) => {
      for (const listener of [...listeners]) {
        listener({ envelope, notification });
      }
    },
  };
}

/** 订阅一个新 listener，并返回它收到的事件列表（按到达顺序）。 */
function collect(service: ControllerService): SemanticEvent[] {
  const received: SemanticEvent[] = [];
  service.subscribe((event) => received.push(event));
  return received;
}

test('维护噪声经事件源发入后一次都不到达订阅者', () => {
  const events = controllableSource();
  const { dependencies, calls } = fakeDependencies(events.source);
  const service = createControllerService(dependencies);
  const received = collect(service);

  const noise: readonly ControllerNotification[] = [
    { kind: 'keepalive', at: 1 },
    { kind: 'stderr', line: '诊断噪声' },
    { kind: 'poll-timeout', source: 'worker-read' },
    { kind: 'unchanged-reconciliation', at: 2 },
    { kind: 'diagnostic', message: '诊断噪声' },
  ];
  noise.forEach((notification, index) => {
    events.publish(notification, { eventId: `noise-${String(index)}`, coordinatorSessionId: null });
  });

  expect(received).toEqual([]);
  expect(calls).toEqual([]);
});

test('语义事件逐条照搬发布者给出的 eventId 与 Session 归属', () => {
  const events = controllableSource();
  const { dependencies, calls } = fakeDependencies(events.source);
  const service = createControllerService(dependencies);
  const received = collect(service);

  events.publish(stateChanged(3), { eventId: 'event-session-b', coordinatorSessionId: 'session-b' });
  events.publish(
    { kind: 'scope-control-changed', coordinationScopeId: SCOPE, controlState: 'paused' },
    { eventId: 'event-scope', coordinatorSessionId: null },
  );

  expect(received.map((event) => event.kind)).toEqual(['state-changed', 'scope-control-changed']);
  // 归属不被推导、不被改写：Session 事件归它自己，Scope 级事件是 null。
  expect(received.map((event) => event.coordinatorSessionId)).toEqual(['session-b', null]);
  // 身份逐条独立：两条事件不会共用同一个 eventId。
  expect(received.map((event) => event.eventId)).toEqual(['event-session-b', 'event-scope']);
  // payload 原样保留：envelope 只添加身份，不替换事实。
  expect(received[0]).toMatchObject({ revision: 3, reason: 'worker-task-verified-accepted' });
  expect(received[1]).toMatchObject({ controlState: 'paused' });
  expect(calls).toEqual([]);
});

test('取消订阅只移除该 listener，之后新订阅的 listener 仍收到事件', () => {
  const events = controllableSource();
  const { dependencies, calls } = fakeDependencies(events.source);
  const service = createControllerService(dependencies);
  const received: SemanticEvent[] = [];
  const unsubscribe = service.subscribe((event) => received.push(event));

  events.publish(stateChanged(1), { eventId: 'event-1', coordinatorSessionId: 'session-b' });
  expect(received.map((event) => event.eventId)).toEqual(['event-1']);

  unsubscribe();
  events.publish(stateChanged(2), { eventId: 'event-2', coordinatorSessionId: 'session-b' });
  // 取消之后同一事件不再到达这个 listener。
  expect(received.map((event) => event.eventId)).toEqual(['event-1']);

  // 事件源没有被取消：新订阅的 listener 照常收到后续事件。
  const late = collect(service);
  events.publish(stateChanged(3), { eventId: 'event-3', coordinatorSessionId: null });
  expect(late.map((event) => event.eventId)).toEqual(['event-3']);
  expect(received.map((event) => event.eventId)).toEqual(['event-1']);
  expect(calls).toEqual([]);
});
