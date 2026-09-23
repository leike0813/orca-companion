/**
 * MOD-07：TUI 的真实装配（Owner: `m2-deliver-planning-tui`）。
 *
 * 这个模块把界面端口接到既有的应用用例与适配器上，并把**当前不存在的权威**如实表达为结构化拒绝，
 * 而不是发明一套语义或让界面直接接触 store。
 *
 * 已接线的能力（只读与既有用例）：
 * - Home 解析：Git common dir → 该仓库唯一的 Branch Coordination State → Scope 集合；
 * - 快照：IC-03 查询 + `projectControllerSnapshot`（含图拓扑与压缩投影）；
 * - transcript：checkpoint store 的已提交消息；
 * - 向导核验：`git`、Orca 版本/runtime、协调身份（doctor probe）。
 *
 * 尚未接线的能力（每一项都以 `<capability>_unavailable` fail closed，并在报告里列为前置缺口）：
 * - `session_message`：M1 没有「用户消息进入 Coordinator 模型循环」的用例（Actionable Work 只来自
 *   store 事实），也没有前台 Runtime Incarnation 装配；
 * - `compaction`：`/compact` 没有面向 Session 的压缩请求用例；
 * - `model_configuration`：M1 没有项目级配置加载器，因此没有可切换的 Coordinator Model Configuration；
 * - `planning_handoff`：prepare 需要宿主读好 map/plan revision、Target 与 Capsule 引用，Capsule 生成
 *   器属于未接线的 Runtime 装配；
 * - `scope_initialization`：创建 Scope 需要合法的 `CoordinationWriter`，而那需要前台 Runtime
 *   Incarnation 的 lease/fencing——由 UI 进程谎称持有 lease 会把真正的运行时 fence 掉。
 *
 * 空清单与 `null` 投影都是显式结果：界面据此显示 blocker，而不是把「没有配置」显示成「已核验」。
 */

import type { CoordinationScopeId, CoordinatorSessionId } from '../application/dto/identity.js';
import {
  projectControllerSnapshot,
  type ControllerCommandResult,
  type ControllerSnapshot,
  type ControllerTranscriptMessage,
  type ControllerTranscriptPage,
} from '../application/controller-service.js';
import { createCoordinationStore, resolveGitCommonDir } from './composition.js';
import { createOrcaDoctorProbe } from './doctor.js';
import { openCheckpointStore, type CheckpointStore } from '../adapters/storage/checkpoint-store.js';
import type { BranchCoordinationStore } from '../application/ports/branch-coordination-store.js';
import type { TuiEntryEnvironment } from './tui-entry.js';
import type {
  HandoffIntentPort,
  HomeResolution,
  ModelCatalogPort,
  ScopeCandidate,
  ScopeSetupPort,
  SnapshotLoad,
  TranscriptLoad,
  TuiIntent,
  TuiPorts,
  WizardCheck,
  WizardProposal,
} from '../interfaces/tui/ports.js';
import { ANCHORED_CAPABILITY_GAPS } from './tui-capability-gaps.js';
import { checkpointDatabasePath } from './coordinator-runtime.js';

const TRANSCRIPT_WINDOW = 200;

type BoundScope =
  | { readonly kind: 'bound'; readonly coordinationScopeId: CoordinationScopeId }
  | { readonly kind: 'none' }
  | { readonly kind: 'multiple'; readonly candidates: readonly ScopeCandidate[] }
  | { readonly kind: 'failed'; readonly code: string; readonly message: string };

function bindScope(store: BranchCoordinationStore): BoundScope {
  const scopes = store.query({ kind: 'scopes' });
  if (scopes.kind === 'rejected') {
    return { kind: 'failed', code: scopes.code, message: scopes.message };
  }
  if (scopes.kind !== 'scopes') {
    return { kind: 'failed', code: 'invalid_state', message: '无法读取 Coordination Scope 列表' };
  }
  if (scopes.scopes.length === 0) {
    return { kind: 'none' };
  }
  if (scopes.scopes.length > 1) {
    return {
      kind: 'multiple',
      candidates: scopes.scopes.map((scope) => ({
        coordinationScopeId: scope.coordinationScopeId,
        mode: scope.mode,
        controlState: scope.controlState,
      })),
    };
  }
  const only = scopes.scopes[0];
  if (only === undefined) {
    return { kind: 'none' };
  }
  return { kind: 'bound', coordinationScopeId: only.coordinationScopeId };
}

function durableMessagesToTranscript(
  coordinatorSessionId: CoordinatorSessionId,
  raw: readonly unknown[],
): ControllerTranscriptPage {
  const window = raw.slice(-TRANSCRIPT_WINDOW);
  const messages: ControllerTranscriptMessage[] = [];
  for (const entry of window) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const role = record['role'];
    const content = record['content'];
    if (typeof role !== 'string' || typeof content !== 'string') {
      continue;
    }
    messages.push({ role, content, stepId: null });
  }
  return { coordinatorSessionId, messages, nextCursor: null };
}

function unavailable(capability: string, detail: string): ControllerCommandResult {
  return { kind: 'rejected', code: `${capability}_unavailable`, message: detail };
}

export function createTuiPorts(environment: TuiEntryEnvironment): Promise<TuiPorts> {
  return createTuiPortsInternal(environment);
}

async function createTuiPortsInternal(environment: TuiEntryEnvironment): Promise<TuiPorts> {
  const commonDir = await resolveGitCommonDir({ repositoryPath: environment.cwd, env: environment.env });
  let store: BranchCoordinationStore | null = null;
  let storeFailure: { readonly code: string; readonly message: string } | null = null;
  if (commonDir.kind === 'failed') {
    storeFailure = { code: 'repository_unresolved', message: commonDir.message };
  } else {
    // 只读打开：界面本身不写入，写入必须经应用用例与合法 writer。
    const opened = createCoordinationStore({ gitCommonDir: commonDir.path, readOnly: true });
    if (opened.kind === 'failed') {
      // 尚未初始化是本项目的正常起点：进入向导而不是报错。
      if (opened.code !== 'missing') {
        storeFailure = { code: opened.code, message: opened.message };
      }
    } else {
      store = opened.store;
    }
  }

  let checkpoints: CheckpointStore | null = null;
  const checkpointStore = (): CheckpointStore | null => {
    if (checkpoints !== null) {
      return checkpoints;
    }
    if (commonDir.kind === 'failed') {
      return null;
    }
    const opened = openCheckpointStore({ databasePath: checkpointDatabasePath(commonDir.path) });
    if (opened.kind === 'failed') {
      return null;
    }
    checkpoints = opened.store;
    return checkpoints;
  };

  const bound = (): BoundScope => {
    if (storeFailure !== null) {
      return { kind: 'failed', code: storeFailure.code, message: storeFailure.message };
    }
    if (store === null) {
      return { kind: 'none' };
    }
    return bindScope(store);
  };

  const readSnapshot = (selectedSessionId: string | null): SnapshotLoad => {
    const scope = bound();
    if (scope.kind !== 'bound') {
      return scope.kind === 'failed'
        ? { kind: 'failed', code: scope.code, message: scope.message }
        : { kind: 'failed', code: 'scope_ambiguous', message: '当前仓库没有唯一可绑定的 Coordination Scope' };
    }
    if (store === null) {
      return { kind: 'failed', code: 'store_unavailable', message: 'Branch Coordination State 不可读' };
    }
    const coordinationScopeId = scope.coordinationScopeId;
    const snapshot = store.query({ kind: 'snapshot', coordinationScopeId });
    if (snapshot.kind !== 'snapshot') {
      return {
        kind: 'failed',
        code: snapshot.kind === 'rejected' ? snapshot.code : 'invalid_state',
        message: snapshot.kind === 'rejected' ? snapshot.message : 'snapshot 查询返回了非预期结果',
      };
    }
    const counters = store.query({ kind: 'budget-counters', coordinationScopeId });
    const graphId = snapshot.snapshot.scope.graphId;
    const versions =
      graphId === null
        ? ({ kind: 'graph-versions', versions: [] } as const)
        : store.query({ kind: 'graph-versions', coordinationScopeId, graphId });
    const authorizations = store.query({ kind: 'authorizations', coordinationScopeId });
    const authorization =
      authorizations.kind === 'authorizations'
        ? authorizations.authorizations.find(
            (entry) => entry.authorizationId === snapshot.snapshot.scope.authorizationId,
          )
        : undefined;
    const projected: ControllerSnapshot = projectControllerSnapshot({
      snapshot: snapshot.snapshot,
      budgets: counters.kind === 'budget-counters' ? counters.counters : [],
      graphGeneration:
        snapshot.snapshot.graphGenerations.find((entry) => entry.graphId === graphId)?.generation ?? null,
      frontier: [],
      workers: [],
      extraBlockers: [],
      maintenance: null,
      selectedSessionId: selectedSessionId === null ? null : (selectedSessionId as CoordinatorSessionId),
      graphVersions: versions.kind === 'graph-versions' ? versions.versions : [],
      authorizationGraphRef:
        authorization === undefined
          ? null
          : {
              graphId: authorization.manifest.graph.graphId,
              graphVersion: authorization.manifest.graph.version,
            },
      // 压缩结论来自 Runtime 观察；TUI 进程里没有 Runtime，因此显式为 null（界面显示 blocker）。
      compaction: null,
    });
    return { kind: 'snapshot', snapshot: projected };
  };

  const readTranscript = (coordinatorSessionId: string): TranscriptLoad => {
    const checkpointsStore = checkpointStore();
    if (checkpointsStore === null) {
      return {
        kind: 'failed',
        code: 'checkpoint_store_unavailable',
        message: 'checkpoint store 不可读：无法加载 transcript',
      };
    }
    const read = checkpointsStore.loadCheckpoint(coordinatorSessionId as CoordinatorSessionId);
    if (read.kind !== 'recovered') {
      return {
        kind: 'failed',
        code: read.kind,
        message: `Session ${coordinatorSessionId} 没有可恢复的会话记录`,
      };
    }
    return {
      kind: 'transcript',
      transcript: durableMessagesToTranscript(
        coordinatorSessionId as CoordinatorSessionId,
        checkpointsStore.readCommittedMessages(coordinatorSessionId as CoordinatorSessionId),
      ),
    };
  };

  const resolveHome = (): HomeResolution => {
    const scope = bound();
      switch (scope.kind) {
      case 'bound':
        return { kind: 'restore', coordinationScopeId: scope.coordinationScopeId };
      case 'none':
        return { kind: 'wizard' };
      case 'multiple':
        return { kind: 'choose', candidates: scope.candidates };
      case 'failed':
        return { kind: 'failed', code: scope.code, message: scope.message };
    }
  };

  const scopeSetup: ScopeSetupPort = {
    resolveHome: () => Promise.resolve(resolveHome()),
    verify: async (): Promise<readonly WizardCheck[]> => {
      const probe = createOrcaDoctorProbe(environment);
      const orcaVersion = await probe.readOrcaVersion();
      const runtime = await probe.readRuntime();
      const identity = await probe.readCoordinatorIdentity();
      return [
        {
          id: 'repository',
          ok: commonDir.kind === 'resolved',
          detail: commonDir.kind === 'resolved' ? commonDir.path : commonDir.message,
        },
        {
          id: 'orca',
          ok: orcaVersion.ok && runtime.ok && runtime.value.reachable,
          detail: orcaVersion.ok
            ? runtime.ok
              ? `version ${orcaVersion.value} · runtime ${runtime.value.state}`
              : runtime.detail
            : orcaVersion.detail,
        },
        {
          id: 'identity',
          ok: identity.ok,
          detail: identity.ok ? identity.value : identity.detail,
        },
        {
          id: 'model',
          ok: false,
          detail: ANCHORED_CAPABILITY_GAPS.model_configuration,
        },
        {
          id: 'tracker',
          ok: false,
          detail: ANCHORED_CAPABILITY_GAPS.tracker,
        },
      ];
    },
    proposal: (): Promise<WizardProposal> =>
      Promise.resolve({
        // 身份派生规则尚未定义（M1 未持久化 branch 与 Scope 的绑定），因此这里不制造可提交的提议。
        coordinationScopeId: '',
        coordinatorSessionId: '',
        coordinatorModelConfigurationRef: '',
        planningCycleId: '',
        repositoryPath: environment.cwd,
        canonicalWorktree: environment.cwd,
        trackerRef: '',
      }),
    initialize: (): Promise<ControllerCommandResult> =>
      Promise.resolve(unavailable('scope_initialization', ANCHORED_CAPABILITY_GAPS.scope_initialization)),
  };

  const modelCatalog: ModelCatalogPort = {
    load: () =>
      Promise.resolve({
        options: [],
        currentConfigurationRef: null,
        switchable: false,
        switchBlockReason: ANCHORED_CAPABILITY_GAPS.model_configuration,
      }),
  };

  const handoffRejection = (): Promise<ControllerCommandResult> =>
    Promise.resolve(unavailable('planning_handoff', ANCHORED_CAPABILITY_GAPS.planning_handoff));

  const handoff: HandoffIntentPort = {
    prepareProposal: handoffRejection,
    cutover: handoffRejection,
    cancel: handoffRejection,
  };

  const executeIntent = (intent: TuiIntent): ControllerCommandResult => {
    switch (intent.kind) {
      case 'send-session-message':
        return unavailable('session_message', ANCHORED_CAPABILITY_GAPS.session_message);
      case 'answer-pending-interaction':
        return unavailable('interaction_answer', ANCHORED_CAPABILITY_GAPS.interaction_answer);
      case 'compact-session':
        return unavailable('compaction', ANCHORED_CAPABILITY_GAPS.compaction);
      case 'switch-model-configuration':
        return unavailable('model_configuration', ANCHORED_CAPABILITY_GAPS.model_configuration);
      case 'scope-control':
        return unavailable('scope_control', ANCHORED_CAPABILITY_GAPS.scope_control);
    }
  };

  return {
    snapshot: (selectedSessionId) => Promise.resolve(readSnapshot(selectedSessionId)),
    transcript: (coordinatorSessionId) => Promise.resolve(readTranscript(coordinatorSessionId)),
    execute: (intent) => Promise.resolve(executeIntent(intent)),
    // 语义事件源尚未装配：M1 只声明了 `ControllerNotification`，没有任何发布者。
    subscribe: () => () => undefined,
    scopeSetup,
    modelCatalog,
    handoff,
  };
}
