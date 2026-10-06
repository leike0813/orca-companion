/**
 * 模型设置的保存用例（Owner: `complete-tui-model-configuration` IP-02 / D01、D02）。
 *
 * 保存与应用是**两件事**：这里只把用户编辑变成项目配置里的新不可变记录并落盘，不切换 Session、
 * 不碰已批准的 Manifest、不派发任何 Worker。运行中的改变由 Coordinator 切换用例或重新授权承担。
 *
 * 顺序是固定的：先校验候选，再（有新 key 时）保存并回读凭据，最后才用 revision CAS 保存项目。
 * 反过来做会让配置引用一个不存在的凭据；项目保存失败时凭据可能成为孤立项，但孤立项不会激活任何
 * 错误配置——这是两个文件之间唯一可接受的非原子性，不做任何跨文件补偿。
 *
 * 编辑**只追加**：新的 connection、model、configuration 或 profile 获得新引用，旧记录不改写，
 * 因此已批准的授权和在途 Task 仍能按原引用读回当时的配置。角色当前使用哪一条由
 * `execution.workerProfileRefs` 表达，与历史记录分开。
 */

import { randomUUID } from 'node:crypto';

import {
  coordinatorModelConfigurationSchema,
  type CoordinatorModelConfiguration,
} from '../coordinator/model-config-switch.js';
import type { CredentialStore } from '../ports/credential-store.js';
import type {
  ProjectConfigurationStore,
  ProjectConfigurationSaveResult,
} from '../ports/project-configuration-store.js';
import {
  modelDefinitionSchema,
  providerConnectionSchema,
  workerProfileConfigurationSchema,
  WORKER_HARNESS_IDS,
  type EffortCapability,
  type ModelProfileRole,
  type ModelSettingsRole,
  type ProviderConnection,
  type WorkerProfileConfiguration,
} from '../../domain/model-configuration.js';
import { parseProjectConfig, scanCredentialBearingFields, type ProjectConfig } from './project-config.js';

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

/**
 * 候选连接的凭据。
 *
 * `credentialRef` 为 `null` 表示「本次会提供新 key，由服务生成引用」；给出已有引用则表示复用
 * 用户级凭据。秘密本身从不进入这里，只在 `newSecret` 这条内存路径上短暂存在。
 */
export type ModelSettingsConnectionCredential =
  | { readonly kind: 'harness_login' }
  | {
      readonly kind: 'managed';
      readonly credentialRef: string | null;
      /** 凭据要注入的 SDK 字段路径；显式描述，不猜 provider 的参数名。 */
      readonly optionPath: string;
    };

/** 待保存的 provider 连接：与领域记录同构，只差一个尚未生成的引用。 */
export type ModelSettingsConnectionCandidate = Omit<
  ProviderConnection,
  'connectionRef' | 'credential'
> & {
  readonly credential: ModelSettingsConnectionCredential;
};

export type SaveModelSettingsInput = {
  /** 调用方读到的项目配置 revision；不匹配即拒绝，不覆盖较新的配置。 */
  readonly expectedRevision: number;
  readonly role: ModelSettingsRole;
  /**
   * Worker 角色的 harness。缺省表示沿用该角色已有 profile；只有该角色首次配置时才落到项目默认
   * `execution.harness`。Coordinator 不使用它。
   */
  readonly harness?: string;
  readonly connection: ModelSettingsConnectionCandidate;
  readonly model: string;
  readonly modelOptions?: Readonly<Record<string, unknown>>;
  /** 能力来源；缺失且未引用 Model 时，任何非 null effort 都会被拒绝。 */
  readonly effortCapability?: EffortCapability | null;
  readonly effort?: string | null;
  /** 本次新输入的 key；只在内存、CredentialStore 与必要子进程环境中存在。 */
  readonly newSecret?: string;
  /** 只属于 Coordinator configuration：原生压缩窗口的 owner 身份。 */
  readonly nativeWindowOwnerRef?: string | null;
};

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

export type ModelSettingsDependencies = {
  readonly projectStore: ProjectConfigurationStore;
  readonly credentials: CredentialStore;
};

function reject(code: ModelSettingsRejectionCode, message: string): ModelSettingsRejection {
  return { kind: 'rejected', code, message };
}

function isCoordinatorRole(role: ModelSettingsRole): role is 'coordinator' {
  return role === 'coordinator';
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
 * 本次保存实际写入的 Worker harness。
 *
 * 显式给出即采用；缺省沿用该角色已有 profile，只有第一次配置才落到项目默认 `execution.harness`。
 * 这样一次「换模型」的保存不会把角色悄悄从原 harness 换回默认值。
 */
function selectedWorkerHarness(input: SaveModelSettingsInput, current: ProjectConfig): string {
  const explicit = input.harness?.trim() ?? '';
  if (explicit !== '') {
    return explicit;
  }
  return currentWorkerHarness(current, input.role as ModelProfileRole) ?? current.execution.harness;
}

/**
 * harness 与原生连接的准入。
 *
 * Coordinator 保持 LangChain：它不接受 Worker harness 的原生连接。显式选择、既有角色与首次默认
 * 都必须指向已注册 harness。原生连接声明的 harness 必须与所选 harness 一致，否则一次保存会写出一个启动时
 * 无法解释的连接。
 */
function validateHarness(input: SaveModelSettingsInput, current: ProjectConfig): ModelSettingsRejection | null {
  if (isCoordinatorRole(input.role)) {
    return input.connection.nativeWorker === undefined
      ? null
      : reject('invalid_input', 'Coordinator 必须使用 LangChain provider 连接，不接受 Worker 的原生 harness 连接');
  }
  const harness = selectedWorkerHarness(input, current);
  if (!(WORKER_HARNESS_IDS as readonly string[]).includes(harness)) {
    return reject('invalid_input', `不支持的 Worker harness：${harness}`);
  }
  const native = input.connection.nativeWorker;
  if (harness !== 'codex' && native === undefined) {
    return reject('invalid_input', `Worker harness ${harness} 缺少原生连接`);
  }
  if (native !== undefined && input.connection.codex !== null) {
    return reject('invalid_input', '原生 Worker 连接不能同时声明 Codex 配置');
  }
  if (native !== undefined && native.harness !== harness) {
    return reject('invalid_input', `原生连接的 harness ${native.harness} 与所选 harness ${harness} 不一致`);
  }
  return null;
}

/**
 * 保存一次模型设置。
 *
 * 任何一步失败都返回 rejected，调用方保留编辑内容：既不回退已保存的凭据，也不把失败的候选说成
 * 已生效。成功后配置里只多了新记录，`defaultCoordinatorModelRef` 与角色当前选择以外的事实不变。
 */

/** 一次保存新生的引用；预检与最终组装共用同一组，调用方拿到的身份不会变。 */
type CandidateRefs = {
  readonly connectionRef: string;
  readonly modelRef: string;
  readonly configurationRef: string | null;
  readonly profileRef: string | null;
};

type CandidateAssembly =
  | ModelSettingsRejection
  | { readonly kind: 'assembled'; readonly next: ProjectConfig };

/**
 * 预检用的占位凭据引用。
 *
 * 它只在内存里存在：形状、快照一致性与 effort 来源的判定都与真实引用完全相同，因此「完整校验通过
 * 才写 key」不会漏掉任何凭据写入前就能发现的错误。它本身也必须满足引用的正式形状（uuid），否则
 * 预检会比真实路径更宽松或更严格，两次组装的判定就不再等价。真正落盘的候选一定经过第二次组装，
 * 引用已被 CredentialStore 返回的真实值替换。
 */
const PENDING_CREDENTIAL_REF = '00000000-0000-4000-8000-000000000000';

/**
 * 组装并**完整校验**一份候选配置。
 *
 * 新增记录永远追加，角色当前选择只随新 profile 前移；引用与 effort 的一致性由项目配置 parser 统一
 * 判断，这里不重复实现。返回值是「已校验的下一版配置」，调用方只负责把它交给 store。
 */
function assembleCandidate(
  input: SaveModelSettingsInput,
  current: ProjectConfig,
  refs: CandidateRefs,
  credentialRef: string | null,
): CandidateAssembly {
  const harnessRejection = validateHarness(input, current);
  if (harnessRejection !== null) {
    return harnessRejection;
  }
  const connection = providerConnectionSchema.safeParse({
    ...input.connection,
    connectionRef: refs.connectionRef,
    credential:
      input.connection.credential.kind === 'harness_login'
        ? { kind: 'harness_login' }
        : { kind: 'managed', credentialRef, optionPath: input.connection.credential.optionPath },
  });
  if (!connection.success) {
    return reject('invalid_input', 'provider 连接无效');
  }

  const model = modelDefinitionSchema.safeParse({
    modelRef: refs.modelRef,
    connectionRef: refs.connectionRef,
    model: input.model,
    effortCapability: input.effortCapability ?? null,
  });
  if (!model.success) {
    return reject('invalid_input', '模型设置无效');
  }

  const modelOptions = input.modelOptions ?? {};
  const effort = input.effort ?? null;
  let coordinatorConfiguration: CoordinatorModelConfiguration | null = null;
  let profile: WorkerProfileConfiguration | null = null;
  if (refs.configurationRef !== null) {
    const parsed = coordinatorModelConfigurationSchema.safeParse({
      configurationRef: refs.configurationRef,
      providerIntegration: connection.data.providerIntegration,
      model: model.data.model,
      modelOptions,
      credentialRefs: credentialRef === null ? [] : [credentialRef],
      nativeWindowOwnerRef: input.nativeWindowOwnerRef ?? null,
      providerConnection: connection.data,
      modelRef: refs.modelRef,
      ...(input.effortCapability === undefined ? {} : { effortCapability: input.effortCapability }),
      effort,
    });
    if (!parsed.success) {
      return reject('invalid_input', 'Coordinator Model Configuration 无效');
    }
    coordinatorConfiguration = parsed.data;
  } else {
    const parsed = workerProfileConfigurationSchema.safeParse({
      profileRef: refs.profileRef,
      role: input.role as ModelProfileRole,
      harness: selectedWorkerHarness(input, current),
      modelConfiguration: {
        connection: connection.data,
        modelRef: refs.modelRef,
        model: model.data.model,
        effort,
        effortCapability: input.effortCapability ?? null,
        modelOptions,
      },
    });
    if (!parsed.success) {
      return reject('invalid_input', 'Worker Profile 无效');
    }
    profile = parsed.data;
  }

  const next: ProjectConfig = {
    ...current,
    revision: current.revision + 1,
    providerConnections: [...current.providerConnections, connection.data],
    models: [...current.models, model.data],
    coordinatorModels:
      coordinatorConfiguration === null
        ? current.coordinatorModels
        : [...current.coordinatorModels, coordinatorConfiguration],
    execution:
      profile === null
        ? current.execution
        : {
            ...current.execution,
            workerProfiles: [...current.execution.workerProfiles, profile],
            workerProfileRefs: { ...current.execution.workerProfileRefs, [input.role]: profile.profileRef },
          },
  };
  const validated = parseProjectConfig(next);
  if (!validated.ok) {
    return reject('invalid_input', `${validated.field}: ${validated.message}`);
  }
  return { kind: 'assembled', next };
}

export function createModelSettingsService(dependencies: ModelSettingsDependencies): ModelSettingsService {
  const { projectStore, credentials } = dependencies;
  return {
    save(input: SaveModelSettingsInput): SaveModelSettingsResult {
      if (!isCoordinatorRole(input.role) && input.nativeWindowOwnerRef !== undefined) {
        return reject('invalid_input', 'nativeWindowOwnerRef 只属于 Coordinator Model Configuration');
      }

      // 1. 读权威配置并核 revision：冲突时连凭据都不应该写。
      const loaded = projectStore.read();
      if (loaded.kind === 'absent') {
        return reject('config_absent', '项目没有可保存的 orca-companion.json');
      }
      if (loaded.kind === 'failed') {
        return reject('config_unreadable', loaded.message);
      }
      const current = loaded.config;
      if (current.revision !== input.expectedRevision) {
        return reject('conflict', `项目配置已被其他编辑修改（当前 revision ${String(current.revision)}）`);
      }

      // 2. 候选先过密钥字段检查：把 key 写进 modelOptions 的编辑必须先于任何凭据写入被拒绝。
      const scan = scanCredentialBearingFields(
        { connection: input.connection, modelOptions: input.modelOptions ?? {} },
        'modelSettings',
      );
      if (scan.kind === 'credential_field') {
        return reject('invalid_input', `模型设置只接受凭据引用，不接受凭据字段：${scan.path}`);
      }
      if (scan.kind === 'unbounded') {
        return reject('invalid_input', '模型设置结构循环或过深，无法确认其中没有凭据字段');
      }

      // 3. 输入形状：managed 凭据要么复用既有引用，要么本次提供新 key。
      const newSecret = input.newSecret;
      if (newSecret !== undefined && newSecret.length === 0) {
        return reject('invalid_input', '新 key 不能为空字符串');
      }
      // harness_login 用 Harness 自己的登录态，没有可注入的凭据引用：此时写入的 key 既不会被配置
      // 引用、也不会被任何运行时读到，只会在用户级凭据库里留下一条永不使用的明文。
      if (newSecret !== undefined && input.connection.credential.kind !== 'managed') {
        return reject('invalid_input', 'harness_login 凭据来源不接受新 key：它使用 Harness 自己的登录态');
      }
      const requestedRef =
        input.connection.credential.kind === 'managed' ? input.connection.credential.credentialRef : null;
      if (input.connection.credential.kind === 'managed' && requestedRef === null && newSecret === undefined) {
        return reject('invalid_input', 'managed 凭据需要已有 credentialRef 或本次提供的新 key');
      }

      // 4. 完整候选校验先于任何凭据写入：无法落盘的编辑不该在凭据库里留下孤立项。
      const refs: CandidateRefs = {
        connectionRef: randomUUID(),
        modelRef: randomUUID(),
        configurationRef: isCoordinatorRole(input.role) ? randomUUID() : null,
        profileRef: isCoordinatorRole(input.role) ? null : randomUUID(),
      };
      const preflight = assembleCandidate(
        input,
        current,
        refs,
        input.connection.credential.kind === 'managed' ? PENDING_CREDENTIAL_REF : null,
      );
      if (preflight.kind !== 'assembled') {
        return preflight;
      }

      // 5. 凭据解析：新 key 先保存再回读；复用既有引用也必须当场证明它可解析。
      let credentialRef: string | null = null;
      if (newSecret !== undefined) {
        const metadata = credentials.metadata();
        if (metadata.kind === 'rejected') {
          return reject('credential_failed', metadata.message);
        }
        const stored = credentials.save({ expectedRevision: metadata.revision, secret: newSecret });
        if (stored.kind === 'rejected') {
          return reject('credential_failed', stored.message);
        }
        credentialRef = stored.credentialRef;
        const resolved = credentials.read(credentialRef);
        if (resolved.kind === 'rejected') {
          return reject('credential_unresolved', resolved.message);
        }
      } else if (requestedRef !== null) {
        const resolved = credentials.read(requestedRef);
        if (resolved.kind === 'rejected') {
          return reject('credential_unresolved', resolved.message);
        }
        credentialRef = requestedRef;
      }

      // 6. 用真实引用组装最终候选：落盘的永远是预检过的同一份编辑。
      const assembled = assembleCandidate(input, current, refs, credentialRef);
      if (assembled.kind !== 'assembled') {
        return assembled;
      }
      const saved: ProjectConfigurationSaveResult = projectStore.save({
        expectedRevision: input.expectedRevision,
        next: assembled.next,
      });
      if (saved.kind === 'failed') {
        return reject(saved.code === 'conflict' ? 'conflict' : 'save_failed', saved.message);
      }
      return {
        kind: 'saved',
        revision: saved.revision,
        configurationRef: refs.configurationRef,
        profileRef: refs.profileRef,
      };
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
  readonly effortCapability: EffortCapability | null;
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
    roles.push({
      role,
      bindingRef: profile?.profileRef ?? null,
      harness: profile?.harness ?? null,
      ...summarize({
        connection: profile?.modelConfiguration.connection ?? null,
        modelRef: profile?.modelConfiguration.modelRef ?? null,
        model: profile?.modelConfiguration.model ?? null,
        effort: profile?.modelConfiguration.effort ?? null,
        effortCapability: profile?.modelConfiguration.effortCapability ?? null,
        fallbackProviderIntegration: null,
      }),
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
