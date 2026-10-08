/**
 * 模型设置的保存用例（Owner: `complete-tui-model-configuration` IP-02 / D01、D02）。
 *
 * 保存与应用是**两件事**：这里只把用户编辑变成项目配置里的新不可变记录并落盘，不切换 Session、
 * 不碰已批准的 Manifest、不派发任何 Worker。运行中的改变由 Coordinator 切换用例或重新授权承担。
 *
 * Coordinator 的顺序是固定的：先校验候选，再（有新 key 时）保存并回读凭据，最后才用 revision CAS
 * 保存项目。反过来做会让配置引用一个不存在的凭据；项目保存失败时凭据可能成为孤立项，但孤立项不会
 * 激活任何错误配置——这是两个文件之间唯一可接受的非原子性，不做任何跨文件补偿。Worker 保存不写
 * 凭据：连接、endpoint 与凭据由 harness 自身拥有，只追加 {harness, modelSelection}。
 *
 * 编辑**只追加**：新的 connection、model、configuration 或 profile 获得新引用，旧记录不改写，
 * 因此已批准的授权和在途 Task 仍能按原引用读回当时的配置。角色当前使用哪一条由
 * `execution.workerProfileRefs` 表达，与历史记录分开。
 */

import { randomUUID } from 'node:crypto';

import {
  coordinatorModelConfigurationSchema,
} from '../coordinator/model-config-switch.js';
import type { CredentialStore } from '../ports/credential-store.js';
import type { ProviderLibrary } from './provider-library.js';
import type {
  ProjectConfigurationStore,
  ProjectConfigurationSaveResult,
} from '../ports/project-configuration-store.js';
import {
  semanticEqual,
  workerModelSelectionSchema,
  workerProfileConfigurationSchema,
  WORKER_HARNESS_IDS,
  type EffortCapability,
  type ModelProfileRole,
  type ModelSettingsRole,
  type ProviderConnection,
  type WorkerEffortCapability,
  type WorkerHarnessId,
  type WorkerModelSelection,
} from '../../domain/model-configuration.js';
import { parseProjectConfig, type ProjectConfig } from './project-config.js';

export const MODEL_SETTINGS_REJECTION_CODES = [
  'invalid_input',
  'config_absent',
  'config_unreadable',
  'conflict',
  'credential_failed',
  'credential_unresolved',
  'save_failed',
] as const;

export type ModelSettingsRejectionCode = (typeof MODEL_SETTINGS_REJECTION_CODES)[number];

export type ModelSettingsRejection = {
  readonly kind: 'rejected';
  readonly code: ModelSettingsRejectionCode;
  readonly message: string;
};

export type SaveCoordinatorModelSettingsInput = {
  readonly expectedRevision: number;
  readonly role: 'coordinator';
  readonly modelRef: string;
  readonly effort?: string | null;
};

/**
 * Worker 的保存输入。
 *
 * Worker 只按角色选择 harness、模型与 effort：连接、endpoint、凭据与 provider options 由 harness 自身
 * 拥有。调用方传入 `connection`/`newSecret`/`modelOptions` 等字段会在运行时被明确拒绝，保存全程不访问
 * CredentialStore。
 */
export type SaveWorkerModelSettingsInput = {
  /** 调用方读到的项目配置 revision；不匹配即拒绝，不覆盖较新的配置。 */
  readonly expectedRevision: number;
  readonly role: ModelProfileRole;
  /**
   * 显式选择的已注册 harness；缺省表示沿用该角色已有 profile，只有首次配置才落到项目默认
   * `execution.harness`。
   */
  readonly harness?: string;
  readonly modelSelection: WorkerModelSelection;
};

export type SaveModelSettingsInput = SaveCoordinatorModelSettingsInput | SaveWorkerModelSettingsInput;

export type SaveModelSettingsResult =
  | {
      readonly kind: 'saved';
      readonly revision: number;
      /** Coordinator 角色新生成的配置引用；Worker 角色为 null。 */
      readonly configurationRef: string | null;
      /** Worker 角色新生成的 profile 引用；Coordinator 角色为 null。 */
      readonly profileRef: string | null;
    }
  | ModelSettingsRejection;

export type ModelSettingsService = {
  readonly save: (input: SaveModelSettingsInput) => SaveModelSettingsResult;
};

/** 一次显式原生目录查询的可信结果；null 来源表示该 harness 没有可核验的目录来源。 */
export type WorkerSelectionVerification = {
  readonly catalogSource: string | null;
  readonly effortCapability: WorkerEffortCapability | null;
};

/** 可选来源核验：按 harness 与 native model ID 返回本次查询的可信来源与能力。 */
export type WorkerSelectionVerifier = (input: {
  readonly harness: string;
  readonly model: string;
}) => WorkerSelectionVerification | null;

export type ModelSettingsDependencies = {
  readonly projectStore: ProjectConfigurationStore;
  readonly credentials: CredentialStore;
  readonly library?: Pick<ProviderLibrary, 'resolveModel'>;
  /**
   * 可选的 Worker 选择来源核验。
   *
   * 保存时用它把输入的 catalogSource/effortCapability 收敛到**本次显式原生目录查询**的可信结果上：
   * 输入必须与回调返回的来源一致，effort 只按回调给出的能力取值判定。缺省表示没有可信目录，此时只
   * 接受手填的未验证选择（catalogSource 与 effortCapability 均为 null、effort 为 null），任何非 null
   * 的 source/capability/effort 都以 invalid_input 拒绝，避免调用方自报来源冒充原生结果。
   */
  readonly verifyWorkerSelection?: WorkerSelectionVerifier;
};

function reject(code: ModelSettingsRejectionCode, message: string): ModelSettingsRejection {
  return { kind: 'rejected', code, message };
}

function isWorkerHarnessId(value: string): value is WorkerHarnessId {
  return (WORKER_HARNESS_IDS as readonly string[]).includes(value);
}

/** 该角色当前绑定的 profile harness；没有 profile 时为 null。 */
function currentWorkerHarness(current: ProjectConfig, role: ModelProfileRole): string | null {
  const profileRef = current.execution.workerProfileRefs[role];
  if (profileRef === undefined) {
    return null;
  }
  return current.execution.workerProfiles.find((entry) => entry.profileRef === profileRef)?.harness ?? null;
}

/**
 * 本次 Worker 保存实际写入的 harness。
 *
 * 显式给出即采用；缺省沿用该角色已有 profile，只有第一次配置才落到项目默认 `execution.harness`。
 * 这样一次「换模型」的保存不会把角色悄悄从原 harness 换回默认值。
 */
function selectedWorkerHarness(input: SaveWorkerModelSettingsInput, current: ProjectConfig): string {
  const explicit = input.harness?.trim() ?? '';
  if (explicit !== '') {
    return explicit;
  }
  return currentWorkerHarness(current, input.role) ?? current.execution.harness;
}

/**
 * 保存一次模型设置。
 *
 * 任何一步失败都返回 rejected，调用方保留编辑内容：既不回退已保存的凭据，也不把失败的候选说成
 * 已生效。成功后配置里只多了新记录，`defaultCoordinatorModelRef` 与角色当前选择以外的事实不变。
 */

export function createModelSettingsService(dependencies: ModelSettingsDependencies): ModelSettingsService {
  const { projectStore, credentials } = dependencies;
  const verifyWorkerSelection = dependencies.verifyWorkerSelection;

  /** 读权威配置并核 revision；冲突时调用方不该写任何东西。 */
  function loadCurrent(
    expectedRevision: number,
  ): { readonly kind: 'current'; readonly config: ProjectConfig } | ModelSettingsRejection {
    const loaded = projectStore.read();
    if (loaded.kind === 'absent') {
      return reject('config_absent', '项目没有可保存的 orca-companion.json');
    }
    if (loaded.kind === 'failed') {
      return reject('config_unreadable', loaded.message);
    }
    if (loaded.config.revision !== expectedRevision) {
      return reject('conflict', `项目配置已被其他编辑修改（当前 revision ${String(loaded.config.revision)}）`);
    }
    return { kind: 'current', config: loaded.config };
  }

  function persist(
    expectedRevision: number,
    next: ProjectConfig,
    configurationRef: string | null,
    profileRef: string | null,
  ): SaveModelSettingsResult {
    const saved: ProjectConfigurationSaveResult = projectStore.save({ expectedRevision, next });
    if (saved.kind === 'failed') {
      return reject(saved.code === 'conflict' ? 'conflict' : 'save_failed', saved.message);
    }
    return { kind: 'saved', revision: saved.revision, configurationRef, profileRef };
  }

  function saveCoordinator(input: SaveCoordinatorModelSettingsInput): SaveModelSettingsResult {
    if (Object.keys(input).some((key) => !['expectedRevision', 'role', 'modelRef', 'effort'].includes(key))) {
      return reject('invalid_input', 'Coordinator 模型设置字段无效');
    }
    const loaded = loadCurrent(input.expectedRevision);
    if (loaded.kind !== 'current') {
      return loaded;
    }
    const current = loaded.config;

    const projectModel = current.models.find((candidate) => candidate.modelRef === input.modelRef);
    const projectConnection = projectModel === undefined ? undefined : current.providerConnections.find((candidate) => candidate.connectionRef === projectModel.connectionRef);
    const library = dependencies.library;
    const resolved = projectModel !== undefined && projectConnection !== undefined
      ? { kind: 'resolved' as const, model: projectModel, connection: projectConnection }
      : library?.resolveModel(input.modelRef) ?? reject('invalid_input', 'Provider library is unavailable');
    if (resolved.kind !== 'resolved') return reject('invalid_input', resolved.message);
    const capability = resolved.model.effortCapability;
    if (capability === null ? input.effort != null : input.effort != null && !capability.values.includes(input.effort)) {
      return reject('invalid_input', '所选模型不支持该 effort');
    }
    const credentialRef = resolved.connection.credential.credentialRef;
    if (credentials.read(credentialRef).kind !== 'resolved') return reject('credential_unresolved', '模型凭据不可用');
    const configurationRef = randomUUID();
    const configuration = coordinatorModelConfigurationSchema.safeParse({
      configurationRef,
      providerIntegration: resolved.connection.providerIntegration,
      model: resolved.model.model,
      credentialRefs: [credentialRef],
      nativeWindowOwnerRef: null,
      providerConnection: resolved.connection,
      modelRef: resolved.model.modelRef,
      effortCapability: capability,
      effort: input.effort ?? null,
    });
    if (!configuration.success) return reject('invalid_input', 'Coordinator Model Configuration 无效');
    const next: ProjectConfig = {
      ...current,
      revision: current.revision + 1,
      providerConnections: current.providerConnections.some(entry => entry.connectionRef === resolved.connection.connectionRef)
        ? current.providerConnections : [...current.providerConnections, resolved.connection],
      models: current.models.some(entry => entry.modelRef === resolved.model.modelRef)
        ? current.models : [...current.models, resolved.model],
      coordinatorModels: [...current.coordinatorModels, configuration.data],
    };
    const validated = parseProjectConfig(next);
    if (!validated.ok) return reject('invalid_input', `${validated.field}: ${validated.message}`);
    return persist(input.expectedRevision, next, configurationRef, null);
  }

  function saveWorker(input: SaveWorkerModelSettingsInput): SaveModelSettingsResult {
    // 1. 运行时严格键检查：Worker 不接受连接、秘密或 options 字段。TS 判别联合只约束静态调用方，
    //    JS 调用方仍可能传入这些事实，这里显式拒绝且不读取任何凭据。
    const allowed = new Set(['expectedRevision', 'role', 'harness', 'modelSelection']);
    for (const key of Object.keys(input)) {
      if (!allowed.has(key)) {
        return reject('invalid_input', `Worker 模型设置不接受字段：${key}`);
      }
    }

    const loaded = loadCurrent(input.expectedRevision);
    if (loaded.kind !== 'current') {
      return loaded;
    }
    const current = loaded.config;

    // 2. harness 必须是已注册身份；缺省沿用该角色既有 profile 或项目默认。
    const harness = selectedWorkerHarness(input, current);
    if (!isWorkerHarnessId(harness)) {
      return reject('invalid_input', `不支持的 Worker harness：${harness}`);
    }

    // 3. 结构先过 schema。非 null 的来源与能力 claim 必须与本次可信目录核验一致；手填的
    //    catalogSource/effortCapability 均为 null 时跳过核验，允许已有的未验证 native ID（effort 为 null）。
    const claimed = workerModelSelectionSchema.safeParse(input.modelSelection);
    if (!claimed.success) {
      return reject('invalid_input', `Worker 模型选择无效：${claimed.error.issues[0]?.message ?? '结构不合法'}`);
    }
    let effortCapability = claimed.data.effortCapability;
    let catalogSource = claimed.data.catalogSource;
    if (claimed.data.catalogSource !== null || claimed.data.effortCapability !== null) {
      const verified = verifyWorkerSelection?.({ harness, model: claimed.data.model }) ?? null;
      const actualCapability = verified?.effortCapability ?? null;
      const actualSource = verified?.catalogSource ?? null;
      if (!semanticEqual(claimed.data.effortCapability, actualCapability)) {
        return reject('invalid_input', '模型能力来源未经过本次原生目录查询核验');
      }
      if (!semanticEqual(claimed.data.catalogSource, actualSource)) {
        return reject('invalid_input', '目录来源未经过本次原生目录查询核验');
      }
      effortCapability = actualCapability;
      catalogSource = actualSource;
    }

    // 4. 保存的 selection 采用核验后的实际能力与来源（手填为 null）；effort 由 schema 按实际能力取值判定。
    const selection = workerModelSelectionSchema.safeParse({
      model: claimed.data.model,
      effort: claimed.data.effort,
      effortCapability,
      catalogSource,
    });
    if (!selection.success) {
      return reject('invalid_input', `Worker 模型选择无效：${selection.error.issues[0]?.message ?? '结构不合法'}`);
    }
    const profile = workerProfileConfigurationSchema.safeParse({
      profileRef: randomUUID(),
      role: input.role,
      harness,
      modelSelection: selection.data,
    });
    if (!profile.success) {
      return reject('invalid_input', 'Worker Profile 无效');
    }

    // 5. 只追加 profile 并前移角色当前选择；不触碰 providerConnections/models。
    const next: ProjectConfig = {
      ...current,
      revision: current.revision + 1,
      execution: {
        ...current.execution,
        workerProfiles: [...current.execution.workerProfiles, profile.data],
        workerProfileRefs: {
          ...current.execution.workerProfileRefs,
          [input.role]: profile.data.profileRef,
        },
      },
    };
    const validated = parseProjectConfig(next);
    if (!validated.ok) {
      return reject('invalid_input', `${validated.field}: ${validated.message}`);
    }
    return persist(input.expectedRevision, next, null, profile.data.profileRef);
  }

  return {
    save(input: SaveModelSettingsInput): SaveModelSettingsResult {
      return input.role === 'coordinator' ? saveCoordinator(input) : saveWorker(input);
    },
  };
}

// ---------------------------------------------------------------------------
// 非秘密快照
// ---------------------------------------------------------------------------

/** 候选连接：不含凭据引用之外的任何秘密信息，因此可以直接进入 UI 投影。 */
export type ModelSettingsConnectionSummary = {
  readonly connectionRef: string;
  readonly label: string;
  readonly providerIntegration: string;
  readonly credentialKind: ProviderConnection['credential']['kind'];
};

export type ModelSettingsModelSummary = {
  readonly modelRef: string;
  readonly connectionRef: string;
  readonly model: string;
  readonly effortCapability: EffortCapability | null;
};

export type ModelSettingsRoleBinding = {
  readonly role: ModelSettingsRole;
  /** Coordinator 为 configuration 引用，Worker 角色为 profile 引用；未配置时为 null。 */
  readonly bindingRef: string | null;
  readonly connectionRef: string | null;
  readonly connectionLabel: string | null;
  readonly providerIntegration: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  /** Coordinator 用带 optionPath 的能力来源；Worker 用原生 harness 的能力来源；无来源为 null。 */
  readonly effortCapability: EffortCapability | WorkerEffortCapability | null;
  /** 原生目录来源；Worker 手填未验证时为 null。Coordinator 没有这个概念，恒为 null。 */
  readonly catalogSource: string | null;
  /** Worker 角色的 harness；Coordinator 角色为 null。 */
  readonly harness: string | null;
};

export type ModelSettingsSnapshot = {
  readonly revision: number;
  readonly roles: readonly ModelSettingsRoleBinding[];
  readonly connections: readonly ModelSettingsConnectionSummary[];
  readonly models: readonly ModelSettingsModelSummary[];
  /** Coordinator 全部配置（含历史），供选择器展示候选与「当前」。 */
  readonly coordinatorConfigurations: readonly {
    readonly configurationRef: string;
    readonly model: string;
    readonly effort: string | null;
  }[];
};

/**
 * 把项目配置投影成非秘密快照。
 *
 * 快照是纯函数：同一个配置永远得到同一个结果，UI 重绘与 resize 不会产生写入或新的身份。
 */
export function modelSettingsSnapshot(config: ProjectConfig): ModelSettingsSnapshot {
  const models = new Map(config.models.map((entry) => [entry.modelRef, entry]));
  const summarize = (input: {
    readonly connection: ProviderConnection | null;
    readonly modelRef: string | null;
    readonly model: string | null;
    readonly effort: string | null;
    readonly effortCapability: EffortCapability | null;
    /** 没有连接快照的旧配置仍带 providerIntegration，快照据此补齐。 */
    readonly fallbackProviderIntegration: string | null;
  }): Pick<
    ModelSettingsRoleBinding,
    'connectionRef' | 'connectionLabel' | 'providerIntegration' | 'model' | 'effort' | 'effortCapability'
  > => {
    const model = input.modelRef === null ? null : models.get(input.modelRef) ?? null;
    return {
      connectionRef: input.connection?.connectionRef ?? null,
      connectionLabel: input.connection?.label ?? null,
      providerIntegration: input.connection?.providerIntegration ?? input.fallbackProviderIntegration,
      model: input.model ?? model?.model ?? null,
      effort: input.effort,
      effortCapability: input.effortCapability ?? model?.effortCapability ?? null,
    };
  };

  const defaultConfiguration =
    config.coordinatorModels.find(
      (configuration) => configuration.configurationRef === config.defaultCoordinatorModelRef,
    ) ?? null;

  const roles: ModelSettingsRoleBinding[] = [
    {
      role: 'coordinator',
      bindingRef: defaultConfiguration?.configurationRef ?? null,
      harness: null,
      catalogSource: null,
      ...summarize({
        connection: defaultConfiguration?.providerConnection ?? null,
        modelRef: defaultConfiguration?.modelRef ?? null,
        model: defaultConfiguration?.model ?? null,
        effort: defaultConfiguration?.effort ?? null,
        effortCapability: defaultConfiguration?.effortCapability ?? null,
        fallbackProviderIntegration: defaultConfiguration?.providerIntegration ?? null,
      }),
    },
  ];
  for (const role of ['planner', 'implementation', 'validator', 'finalizer', 'recovery_utility'] as const) {
    const profileRef = config.execution.workerProfileRefs[role];
    const profile =
      profileRef === undefined
        ? null
        : config.execution.workerProfiles.find((entry) => entry.profileRef === profileRef) ?? null;
    const selection = profile?.modelSelection ?? null;
    roles.push({
      role,
      bindingRef: profile?.profileRef ?? null,
      harness: profile?.harness ?? null,
      connectionRef: null,
      connectionLabel: null,
      providerIntegration: null,
      model: selection?.model ?? null,
      effort: selection?.effort ?? null,
      effortCapability: selection?.effortCapability ?? null,
      catalogSource: selection?.catalogSource ?? null,
    });
  }

  return {
    revision: config.revision,
    roles,
    connections: config.providerConnections.map((connection) => ({
      connectionRef: connection.connectionRef,
      label: connection.label,
      providerIntegration: connection.providerIntegration,
      credentialKind: connection.credential.kind,
    })),
    models: config.models.map((model) => ({
      modelRef: model.modelRef,
      connectionRef: model.connectionRef,
      model: model.model,
      effortCapability: model.effortCapability,
    })),
    coordinatorConfigurations: config.coordinatorModels.map((configuration) => ({
      configurationRef: configuration.configurationRef,
      model: configuration.model,
      effort: configuration.effort ?? null,
    })),
  };
}
