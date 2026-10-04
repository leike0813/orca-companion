import type { CommandId } from '../../src/interfaces/tui/commands.js';
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
  ExecutionAuthorizationIntentPort,
  ExecutionAuthorizationLoad,
  ExecutionAuthorizationView,
  ExecutionHandoffIntentPort,
  HomeResolution,
  ModelCatalog,
  ModelConfigurationOption,
  ModelSettingsPort,
  ModelSettingsSnapshotView,
  ScopeSetupPort,
  SnapshotLoad,
  TranscriptLoad,
  TuiIntent,
  TuiPorts,
  WizardCheck,
  WizardProposal,
} from '../../src/interfaces/tui/ports.js';
import type {
  FinalizerView,
  WorkPackageExecutionEntry,
} from '../../src/application/execution/execution-view.js';
import { WIZARD_CHECKS } from '../../src/interfaces/tui/ports.js';
import type { EffortCapability } from '../../src/domain/model-configuration.js';
import { openUiInputStore } from '../../src/adapters/storage/ui-input-store.js';
import { createTranscriptReadingFixture } from '../support/transcript-reading.js';
import type { UiInputStore } from '../../src/application/ports/ui-input-store.js';
import type { SubmissionQuery, SubmissionStatus } from '../../src/application/coordinator/submission-status.js';

/** 真实的内存 UI 输入存储：行为测试因此不重复实现 store 的 CAS/容量语义。 */
export function createMemoryInputStore(): UiInputStore {
  const opened = openUiInputStore({ databasePath: ':memory:' });
  if (opened.kind !== 'opened') {
    throw new Error(`无法创建内存 UI 输入存储：${opened.code} ${opened.message}`);
  }
  return opened.store;
}

/** 写操作一律失败、读操作照常的 store：验证「保存失败仍保留内存输入」。 */
export function createFailingInputStore(code = 'capacity_exceeded'): UiInputStore {
  const base = createMemoryInputStore();
  const failure = { kind: 'failed' as const, code, message: '注入的写入失败' };
  return {
    read: (key) => base.read(key),
    list: (coordinationScopeId) => base.list(coordinationScopeId),
    write: () => failure,
    remove: () => failure,
  };
}

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
    finalizer: makeFinalizer(),
    executionReconciliation: {
      pending: false,
      unresolvedIntentCount: 0,
      activeWorkerCount: 0,
      reasons: [],
    },
    blockers: [],
    interactions: [],
    openInteractionCount: overrides.interactions?.filter(item => item.state === 'open').length ?? 0,
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

/** 执行阶段 Work Package 投影的默认值；测试只需覆盖关心的字段。 */
export function makeWorkPackageExecution(
  workPackageId: string,
  overrides: Partial<WorkPackageExecutionEntry> = {},
): WorkPackageExecutionEntry {
  return {
    workPackageId,
    state: 'waiting',
    role: null,
    attemptId: null,
    liveness: null,
    worktreePath: null,
    baselineHead: null,
    validation: null,
    integration: null,
    derivedFrom: [],
    blockerRefs: [],
    ...overrides,
  };
}

/** Finalizer 投影的默认值：没有门禁通过、没有结论，因此界面不显示 deliverable。 */
export function makeFinalizer(overrides: Partial<FinalizerView> = {}): FinalizerView {
  return {
    gate: { ready: false, blockers: ['no-work-packages'] },
    coversWorkPackageIds: [],
    worktreePath: null,
    readOnlyProfile: 'unverified',
    integrationFrozen: 'unknown',
    workspace: null,
    evidenceRefs: [],
    verdict: null,
    ...overrides,
  };
}

/** 一次 Worker Session Recovery 的默认投影。 */
export function makeRecovery(
  overrides: Partial<ControllerSnapshot['recoveries'][number]> = {},
): ControllerSnapshot['recoveries'][number] {
  return {
    recoveryId: 'recovery-1',
    workerTaskId: 'task-1',
    workPackageId: 'wp-1',
    businessAttemptId: 'attempt-1',
    role: 'validator',
    status: 'recovered',
    consumedBudget: 1,
    consumedForAttempt: 1,
    budgetLimit: 2,
    remainingBudget: 1,
    sourceSegmentId: 'segment-1',
    replacementSegmentId: 'segment-2',
    supersededSegmentId: 'segment-1',
    replacementSessionBindingId: 'binding-2',
    capsule: { ref: 'capsule-1', coverage: null, gaps: [] },
    terminalOutcome: 'replaced',
    blockingReason: null,
    acceptedResultRef: null,
    ...overrides,
  };
}

/** Execution Handoff 记录（`ExecutionHandoffState`）的默认投影。 */
export function makeExecutionHandoff(
  overrides: Partial<ControllerSnapshot['handoffs'][number]> = {},
): ControllerSnapshot['handoffs'][number] {
  return {
    handoffId: 'execution-handoff-1',
    sourceSessionId: 'session-a',
    targetSessionId: 'session-b',
    graphGeneration: 1,
    phase: 'reviewed',
    expectedRevision: 7,
    responsibilitySet: ['execution_coordination_lease', 'pending_interactions', 'worker_lifecycle_events'],
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
  readonly bindLegacyResult?: ControllerCommandResult;
  readonly executeResult?: ControllerCommandResult;
  readonly models?: readonly ModelConfigurationOption[];
  readonly modelCatalog?: Partial<ModelCatalog>;
  /**
   * 角色模型配置端口。
   *
   * 省略即不装配：界面按「尚未接通」显示不可用，这与生产宿主未实现时的行为一致。
   */
  readonly modelSettings?: Partial<ModelSettingsPort>;
  /** Execution Handoff 各步骤的返回值；省略即 accepted。 */
  readonly executionHandoff?: Partial<Record<'prepare' | 'review' | 'cutover' | 'cancel', ControllerCommandResult>>;
  /** Execution Authorization 的审阅结果与批准结果；省略即一份门禁通过的完整 Manifest。 */
  readonly authorizationReview?: ExecutionAuthorizationLoad;
  readonly authorizationApprove?: ControllerCommandResult;
  /** 注入 UI 输入存储（可失败）；省略即使用真实的内存 store。 */
  readonly inputStore?: UiInputStore;
  readonly submissionStatus?: (query: SubmissionQuery) => Promise<SubmissionStatus>;
};

export type FakePorts = {
  readonly ports: TuiPorts;
  readonly calls: PortCall[];
  readonly executeIntents: TuiIntent[];
  readonly emitted: SemanticEvent[];
  readonly emit: (event: SemanticEvent) => void;
  readonly executeCount: () => number;
  /** 真实的 UI 输入存储句柄：测试可直接 `read`/`list` 断言持久状态。 */
  readonly inputStore: UiInputStore;
  readonly closeInputStore: () => void;
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

  let closeInputStore: () => void = () => undefined;
  let rawInputStore: UiInputStore;
  if (options.inputStore !== undefined) {
    rawInputStore = options.inputStore;
  } else {
    const opened = openUiInputStore({ databasePath: ':memory:' });
    if (opened.kind !== 'opened') {
      throw new Error(`无法创建内存 UI 输入存储：${opened.code} ${opened.message}`);
    }
    rawInputStore = opened.store;
    closeInputStore = opened.store.close;
  }
  // 记录每个 store 调用：`no-side-effect` 因此能断言渲染路径只发生只读读取。
  const inputStore: UiInputStore = {
    read: (key) => {
      calls.push({ name: 'inputStore.read', detail: key });
      return rawInputStore.read(key);
    },
    list: (coordinationScopeId) => {
      calls.push({ name: 'inputStore.list', detail: coordinationScopeId });
      return rawInputStore.list(coordinationScopeId);
    },
    write: (input) => {
      calls.push({ name: 'inputStore.write', detail: input.key });
      return rawInputStore.write(input);
    },
    remove: (input) => {
      calls.push({ name: 'inputStore.remove', detail: input.key });
      return rawInputStore.remove(input);
    },
  };

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
    bindLegacyIdentity: (coordinationScopeId) => {
      calls.push({ name: 'bindLegacyIdentity', detail: coordinationScopeId });
      return Promise.resolve(options.bindLegacyResult ?? accepted);
    },
  };

  const ports: TuiPorts = {
    commandStatus: ref => Promise.resolve({kind:'accepted',revision:null,summary:'已核验',resultRef:ref}),
    reading: {
      history: (query) => {
        calls.push({ name: 'history', detail: query.coordinatorSessionId });
        return createTranscriptReadingFixture({ coordinatorSessionId: query.coordinatorSessionId, page: () => transcript }).history(query);
      },
      body: (query) => {
        calls.push({ name: 'transcript-body', detail: query });
        return createTranscriptReadingFixture({ coordinatorSessionId: query.coordinatorSessionId, page: () => transcript }).body(query);
      },
      previews: () => Promise.resolve([]), pin: () => () => {}, subscribe: () => () => {},
    },
    questions: (input) => {
      calls.push({ name: 'questions', detail: input });
      const items = snapshot.interactions.filter((item) => (input.coordinatorSessionId === undefined || item.ownerCoordinatorSessionId === input.coordinatorSessionId) && item.state === 'open');
      if (input.kind === 'pending-interactions') {
        const start = input.after === undefined ? 0 : items.findIndex(item => item.interactionId === input.after!.interactionId) + 1;
        const page = items.slice(start, start + 20), last = page.at(-1);
        return Promise.resolve({ kind: 'pending-interactions', interactions: page, nextCursor: start + page.length < items.length && last ? { createdAt: start + page.length, interactionId: last.interactionId } : null });
      }
      const item = items.find((item) => item.interactionId === input.interactionId);
      return Promise.resolve({ kind: 'pending-interaction', interaction: item ? { ...item, question: null, answerRef: null, answerText: null } : null });
    },
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
          configurationRevision: 7,
          ...options.modelCatalog,
        });
      },
    },
    handoff: {
      read: id => Promise.resolve(snapshot.planningHandoffs.find(p=>p.proposalId===id)??null),
      prepareProposal: () => {
        calls.push({ name: 'handoff.prepare', detail: null });
        const p=snapshot.planningHandoffs[0];
        return Promise.resolve(p?{...accepted,resultRef:{kind:'planning-handoff',coordinationScopeId:snapshot.coordinationScopeId,proposalId:p.proposalId,revision:p.proposalRevision,phase:p.phase}}:accepted);
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
    executionHandoff: createFakeExecutionHandoff(options, calls, accepted),
    executionAuthorization: createFakeExecutionAuthorization(options, calls, accepted),
    ...(options.modelSettings === undefined ? {} : { modelSettings: createFakeModelSettings(options, calls) }),
    inputStore,
    submissionStatus: (query) => {
      calls.push({ name: 'submissionStatus', detail: query });
      return options.submissionStatus?.(query) ?? Promise.resolve({ kind: 'not-found' });
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
    inputStore: rawInputStore,
    closeInputStore,
  };
}

function createFakeExecutionHandoff(
  options: FakePortsOptions,
  calls: PortCall[],
  accepted: ControllerCommandResult,
): ExecutionHandoffIntentPort {
  const resultFor = (step: 'prepare' | 'review' | 'cutover' | 'cancel'): ControllerCommandResult =>
    options.executionHandoff?.[step] ?? accepted;
  const records=options.snapshot?.handoffs??[];
  const wrap=(step:'prepare'|'review'|'cutover'|'cancel',id?:string):ControllerCommandResult=>{const result=resultFor(step),record=records.find(r=>r.handoffId===id)??records[0];return result.kind==='accepted'&&record?{...result,resultRef:{kind:'execution-handoff',coordinationScopeId:'scope-1',handoffId:record.handoffId,revision:0,phase:record.phase}}:result;};
  return {
    read:id=>Promise.resolve(records.find(r=>r.handoffId===id)??null),
    prepare: (targetCoordinatorSessionId) => {
      calls.push({ name: 'execution-handoff.prepare', detail: targetCoordinatorSessionId });
      return Promise.resolve(wrap('prepare'));
    },
    review: (handoffId) => {
      calls.push({ name: 'execution-handoff.review', detail: handoffId });
      return Promise.resolve(wrap('review',handoffId));
    },
    cutover: (handoffId) => {
      calls.push({ name: 'execution-handoff.cutover', detail: handoffId });
      return Promise.resolve(resultFor('cutover'));
    },
    cancel: (handoffId) => {
      calls.push({ name: 'execution-handoff.cancel', detail: handoffId });
      return Promise.resolve(resultFor('cancel'));
    },
  };
}

/**
 * Execution Authorization 的 fake。
 *
 * `review` 记录调用并返回审阅结果；`approve` 只记录界面回传的指纹与 revision——断言「界面不构造
 * 身份」就落在这两个值上。
 */
const FAKE_EFFORT_CAPABILITY: EffortCapability = {
  values: ['low', 'medium', 'high'],
  source: 'fixture:capability-a',
  optionPath: 'modelReasoningEffort',
};

/** 预览级角色模型配置夹具：只有非秘密字段，绝不携带 key。 */
export const FAKE_MODEL_SETTINGS_SNAPSHOT: ModelSettingsSnapshotView = {
  revision: 7,
  roles: [
    {
      role: 'coordinator',
      bindingRef: 'config-a',
      connectionRef: 'connection-a',
      connectionLabel: '主连接',
      providerIntegration: 'openai',
      model: 'model-a',
      effort: 'high',
      effortCapability: FAKE_EFFORT_CAPABILITY,
      harness: null,
    },
    {
      role: 'planner',
      bindingRef: 'profile-planner',
      connectionRef: 'connection-a',
      connectionLabel: '主连接',
      providerIntegration: 'openai',
      model: 'model-a',
      effort: 'high',
      effortCapability: FAKE_EFFORT_CAPABILITY,
      harness: 'codex',
    },
  ],
  connections: [
    {
      connectionRef: 'connection-a',
      label: '主连接',
      providerIntegration: 'openai',
      modelOptions: {},
      credential: { kind: 'managed', credentialRef: '11111111-1111-4111-8111-111111111111', optionPath: 'apiKey' },
      codex: { providerId: 'openai', baseUrl: 'https://api.openai.com/v1', wireApi: 'responses' },
    },
  ],
  models: [
    { modelRef: 'model-a', connectionRef: 'connection-a', model: 'model-a', effortCapability: FAKE_EFFORT_CAPABILITY },
    { modelRef: 'model-b', connectionRef: 'connection-a', model: 'model-b', effortCapability: FAKE_EFFORT_CAPABILITY },
  ],
  coordinatorConfigurations: [
    { configurationRef: 'config-a', model: 'model-a', effort: 'high' },
    { configurationRef: 'config-b', model: 'model-b', effort: 'medium' },
  ],
};

function createFakeModelSettings(options: FakePortsOptions, calls: PortCall[]): ModelSettingsPort {
  return {
    load: () => {
      calls.push({ name: 'modelSettings.load', detail: null });
      return Promise.resolve(options.modelSettings?.load?.() ?? { kind: 'loaded', snapshot: FAKE_MODEL_SETTINGS_SNAPSHOT });
    },
    save: (input) => {
      calls.push({ name: 'modelSettings.save', detail: input });
      return Promise.resolve(
        options.modelSettings?.save?.(input) ?? {
          kind: 'saved',
          revision: 8,
          configurationRef: input.role === 'coordinator' ? 'config-saved' : null,
          profileRef: input.role === 'coordinator' ? null : 'profile-saved',
        },
      );
    },
    apply: (input) => {
      calls.push({ name: 'modelSettings.apply', detail: input });
      return Promise.resolve(
        options.modelSettings?.apply?.(input) ?? {
          kind: 'saved',
          revision: 8,
          configurationRef: input.role === 'coordinator' ? 'config-saved' : null,
          profileRef: input.role === 'coordinator' ? null : 'profile-saved',
        },
      );
    },
  };
}

function createFakeExecutionAuthorization(
  options: FakePortsOptions,
  calls: PortCall[],
  accepted: ControllerCommandResult,
): ExecutionAuthorizationIntentPort {
  return {
    review: () => {
      calls.push({ name: 'authorization.review', detail: null });
      return Promise.resolve(options.authorizationReview ?? makeAuthorizationReview());
    },
    approve: (input) => {
      calls.push({ name: 'authorization.approve', detail: input });
      return Promise.resolve(options.authorizationApprove ?? accepted);
    },
  };
}

/** 一份门禁通过、可批准的完整 Manifest 投影；测试可覆盖任意字段。 */
export function makeAuthorizationReview(
  overrides: Partial<ExecutionAuthorizationView> = {},
): ExecutionAuthorizationLoad {
  return {
    kind: 'review',
    review: {
      fingerprint: 'fingerprint-1',
      scopeRevision: 7,
      candidate: {
        graphId: 'graph-1',
        generation: 1,
        version: 2,
        baselineHead: 'head-1',
        workPackageCount: 2,
      },
      manifestRows: [
        { label: 'Coordination Scope', value: 'scope-1' },
        { label: 'Git Policy', value: 'main remotes=[origin] refs=[refs/heads/main]' },
      ],
      sections:[{id:'overview',label:'概览',fields:[{label:'图',value:'graph-1'}]},{id:'permissions',label:'权限',fields:[]},{id:'budget',label:'预算',fields:[]},{id:'workspace',label:'工作范围',fields:[]},{id:'complete',label:'完整清单',fields:[{label:'fingerprint',value:'fingerprint-1'}]}],
      gate: { ready: true, blockers: [] },
      ...overrides,
    },
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

/** Explicit caller navigation and literal search; command ordering is not a test contract. */
export async function chooseCommand(app:RenderedTui,id:CommandId):Promise<void>{
  if(frameText(app).includes('选择交接收件方')){app.stdin.write('\u001b');await new Promise<void>(resolve=>setTimeout(resolve,60));await settle(3);}
  if(frameText(app).includes('Command Palette')){app.stdin.write('\u001b');await new Promise<void>(resolve=>setTimeout(resolve,60));await settle(3);}
  app.stdin.write('\u0010');await settle(3);
  app.stdin.write(id);await settle(3);
  app.stdin.write('\r');await settle(4);
}
