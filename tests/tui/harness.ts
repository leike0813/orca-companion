/**
 * TUI 测试 harness（Owner: `m2-deliver-planning-tui`）。
 *
 * 组件测试只经 `TuiPorts` 驱动：fake 端口记录每次调用，因此「渲染与重挂载零业务副作用」可以断言成
 * 「execute 调用计数为 0」这种可观察事实，而不是读实现内部结构。
 *
 * 注意：`ink-testing-library` 的 Stdin mock 把 `isTTY` 硬编码为 true，因此 TTY 语义（无 TTY 拒绝、
 * 真实 resize）必须由 `pty.test.ts` 用真实子进程覆盖，不能靠这里的 mock。
 */

import { render } from 'ink-testing-library';
import { createElement, type ReactElement } from 'react';

import { TuiApp } from '../../src/interfaces/tui/app.js';
import type {
  ControllerCommandResult,
  ControllerSnapshot,
  ControllerTranscriptPage,
  SemanticEvent,
} from '../../src/application/controller-service.js';
import type {
  HomeResolution,
  ModelCatalog,
  ModelConfigurationOption,
  ScopeSetupPort,
  SnapshotLoad,
  TranscriptLoad,
  TuiIntent,
  TuiPorts,
  WizardCheck,
  WizardProposal,
} from '../../src/interfaces/tui/ports.js';
import { WIZARD_CHECKS } from '../../src/interfaces/tui/ports.js';

/* -------------------------------------------------------------------------- */
/* 快照构造                                                                    */
/* -------------------------------------------------------------------------- */

export type SnapshotOverrides = Partial<ControllerSnapshot>;

export function makeSnapshot(overrides: SnapshotOverrides = {}): ControllerSnapshot {
  return {
    coordinationScopeId: 'scope-1',
    revision: 7,
    mode: 'route_planning',
    controlState: 'active',
    planningCycleId: 'cycle-1',
    mapRevision: 3,
    graph: { graphId: 'graph-1', graphVersion: 2, generation: 1 },
    authorization: null,
    executionLeaseHolderSessionId: null,
    selectedSessionId: null,
    sessions: [
      {
        coordinatorSessionId: 'session-a',
        coordinatorModelConfigurationRef: 'config-a',
        lifecycleState: 'active',
        holdsRuntimeLease: false,
        holdsExecutionLease: false,
        planningResponsible: true,
        openInteractionCount: 0,
      },
      {
        coordinatorSessionId: 'session-b',
        coordinatorModelConfigurationRef: 'config-b',
        lifecycleState: 'active',
        holdsRuntimeLease: false,
        holdsExecutionLease: false,
        planningResponsible: false,
        openInteractionCount: 1,
      },
    ],
    budgets: [],
    frontier: [],
    workers: [],
    blockers: [],
    interactions: [],
    handoffs: [],
    recoveries: [],
    graphEvolution: {
      generations: [],
      revisionHolds: [],
      reconciliations: [],
      lineages: [],
      adoptions: [],
    },
    maintenance: null,
    graphTopologies: [
      {
        graphId: 'graph-1',
        graphVersion: 2,
        generation: 1,
        nodes: [
          {
            workPackageId: 'wp-1',
            title: '第一个工作包',
            dependsOn: [],
            scopeEnvelope: { include: ['src/a.ts'], exclude: [] },
          },
          {
            workPackageId: 'wp-2',
            title: '第二个工作包',
            dependsOn: ['wp-1'],
            scopeEnvelope: { include: ['src/b.ts'], exclude: ['tests/**'] },
          },
        ],
        readiness: { generationStatus: 'candidate', authorizationBound: false },
      },
    ],
    compaction: null,
    planningHandoffs: [],
    ...overrides,
  };
}

export function makeTranscript(
  coordinatorSessionId = 'session-a',
  messages: ControllerTranscriptPage['messages'] = [
    { role: 'user', content: '先看看地图', stepId: null },
    { role: 'assistant', content: '好的', stepId: 'step-1' },
    { role: 'tool', content: 'search\n命中 3 个文件', stepId: 'step-2' },
    { role: 'system', content: '内部注入，不应出现在时间线', stepId: 'step-3' },
  ],
): ControllerTranscriptPage {
  return { coordinatorSessionId, messages, nextCursor: null };
}

/* -------------------------------------------------------------------------- */
/* fake 端口                                                                   */
/* -------------------------------------------------------------------------- */

export type PortCall = { readonly name: string; readonly detail: unknown };

export type FakePortsOptions = {
  readonly snapshot?: SnapshotOverrides;
  readonly transcript?: ControllerTranscriptPage;
  readonly snapshotFailure?: { readonly code: string; readonly message: string };
  readonly home?: HomeResolution;
  readonly checks?: readonly WizardCheck[];
  readonly proposal?: WizardProposal;
  readonly initializeResult?: ControllerCommandResult;
  readonly executeResult?: ControllerCommandResult;
  readonly models?: readonly ModelConfigurationOption[];
  readonly modelCatalog?: Partial<ModelCatalog>;
};

export type FakePorts = {
  readonly ports: TuiPorts;
  readonly calls: PortCall[];
  readonly executeIntents: TuiIntent[];
  readonly emitted: SemanticEvent[];
  readonly emit: (event: SemanticEvent) => void;
  readonly executeCount: () => number;
};

export const DEFAULT_PROPOSAL: WizardProposal = {
  coordinationScopeId: 'scope-1',
  coordinatorSessionId: 'session-a',
  coordinatorModelConfigurationRef: 'config-a',
  planningCycleId: 'cycle-1',
  repositoryPath: '/tmp/repo',
  canonicalWorktree: '/tmp/repo',
  trackerRef: 'github:owner/repo',
};

export function allChecksOk(): readonly WizardCheck[] {
  return WIZARD_CHECKS.map((id) => ({ id, ok: true, detail: 'ok' }));
}

export function createFakePorts(options: FakePortsOptions = {}): FakePorts {
  const calls: PortCall[] = [];
  const executeIntents: TuiIntent[] = [];
  const listeners = new Set<(event: SemanticEvent) => void>();
  const snapshot = makeSnapshot(options.snapshot ?? {});
  const transcript = options.transcript ?? makeTranscript();
  const accepted: ControllerCommandResult = { kind: 'accepted', revision: 1, summary: 'ok' };

  const scopeSetup: ScopeSetupPort = {
    resolveHome: (): Promise<HomeResolution> => {
      calls.push({ name: 'resolveHome', detail: null });
      return Promise.resolve(options.home ?? { kind: 'restore', coordinationScopeId: 'scope-1' });
    },
    verify: () => {
      calls.push({ name: 'verify', detail: null });
      return Promise.resolve(options.checks ?? allChecksOk());
    },
    proposal: () => {
      calls.push({ name: 'proposal', detail: null });
      return Promise.resolve(options.proposal ?? DEFAULT_PROPOSAL);
    },
    initialize: (input) => {
      calls.push({ name: 'initialize', detail: input });
      return Promise.resolve(options.initializeResult ?? accepted);
    },
  };

  const ports: TuiPorts = {
    snapshot: (selectedSessionId): Promise<SnapshotLoad> => {
      calls.push({ name: 'snapshot', detail: selectedSessionId });
      if (options.snapshotFailure !== undefined) {
        return Promise.resolve({
          kind: 'failed',
          code: options.snapshotFailure.code,
          message: options.snapshotFailure.message,
        });
      }
      return Promise.resolve({ kind: 'snapshot', snapshot: { ...snapshot, selectedSessionId } });
    },
    transcript: (coordinatorSessionId): Promise<TranscriptLoad> => {
      calls.push({ name: 'transcript', detail: coordinatorSessionId });
      return Promise.resolve({ kind: 'transcript', transcript });
    },
    execute: (intent) => {
      executeIntents.push(intent);
      calls.push({ name: 'execute', detail: intent });
      return Promise.resolve(options.executeResult ?? accepted);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    scopeSetup,
    modelCatalog: {
      load: () => {
        calls.push({ name: 'modelCatalog', detail: null });
        return Promise.resolve({
          options: options.models ?? [{ configurationRef: 'config-a', model: 'model-a' }],
          currentConfigurationRef: 'config-a',
          switchable: true,
          switchBlockReason: null,
          ...options.modelCatalog,
        });
      },
    },
    handoff: {
      prepareProposal: () => {
        calls.push({ name: 'handoff.prepare', detail: null });
        return Promise.resolve(accepted);
      },
      cutover: (proposalId) => {
        calls.push({ name: 'handoff.cutover', detail: proposalId });
        return Promise.resolve(accepted);
      },
      cancel: (proposalId) => {
        calls.push({ name: 'handoff.cancel', detail: proposalId });
        return Promise.resolve(accepted);
      },
    },
  };

  return {
    ports,
    calls,
    executeIntents,
    emitted: [],
    emit: (event) => {
      for (const listener of listeners) {
        listener(event);
      }
    },
    executeCount: () => calls.filter((call) => call.name === 'execute').length,
  };
}

/* -------------------------------------------------------------------------- */
/* 渲染                                                                        */
/* -------------------------------------------------------------------------- */

export type RenderedTui = ReturnType<typeof render>;

/**
 * 渲染完整 TUI。
 *
 * `ink-testing-library` 的 stdout mock 固定报告 `columns = 100`，因此窄屏布局必须直接渲染
 * `Workspace`/`Home`/`Wizard` 并传入 `terminalWidth`，不要试图通过这里改变列宽。
 */
export function renderTui(ports: TuiPorts): RenderedTui {
  return render(createAppElement(ports));
}

function createAppElement(ports: TuiPorts): ReactElement {
  return createElement(TuiApp, {
    ports,
    terminalWidth: 100,
    initialScopeId: null,
    onExit: () => undefined,
  });
}

/** 直接渲染一个展示组件；用于窄屏、密度与纯投影断言。 */
export function renderComponent(element: ReactElement): RenderedTui {
  return render(element);
}

/** 等待若干 microtask 与定时器，让 effect 中的异步加载落地。 */
export async function settle(ticks = 6): Promise<void> {
  for (let index = 0; index < ticks; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export function frameText(rendered: RenderedTui): string {
  return rendered.lastFrame() ?? '';
}
