/**
 * 各项测试共用的模型绑定夹具（Manifest4 / 项目 schema4 / Task 固定绑定共用同一份）。
 *
 * 统一由这里生成，各测试文件就不必各写一份，也就不会出现「某个夹具的绑定与授权里的绑定对不上」
 * 这种与被测行为无关的失败。Worker 的模型只表达 harness、native model ID 与 effort；连接、凭据与
 * provider options 由 harness 自身拥有，夹具里没有明文 secret，也不代表任何真实 provider 或可用性。
 * Coordinator 连接夹具保留 `harness_login`（provider integration 自身的环境认证路径）。
 *
 * 需要制造非法绑定时，负例测试自己改写单个字段，不在这里提供「坏配置」开关。
 */

import type { CredentialStore } from '../../src/application/ports/credential-store.js';
import type { RecoveryUtilityProfile, WorkerProfileRef, WorkerRole } from '../../src/domain/planning/execution-authorization.js';
import type {
  ModelProfileRole,
  ProviderConnection,
  WorkerModelSelection,
  WorkerProfileConfiguration,
} from '../../src/domain/model-configuration.js';

export const FIXTURE_CONNECTION_REF = 'connection-1';
export const FIXTURE_MODEL_REF = 'model-1';
export const FIXTURE_MODEL = 'MiniMax-M3';

const PRODUCTION_ROLES = ['planner', 'implementation', 'validator', 'finalizer'] as const;

/** 项目配置可以为 Recovery Utility 固定 profile，但它不属于授权的四个生产角色。 */
const PROJECT_ROLES = ['planner', 'implementation', 'validator', 'finalizer', 'recovery_utility'] as const;

/** workerProfileRef 的稳定身份：Manifest、项目配置、Task 固定绑定与恢复路径共用同一拼法。 */
export function profileRefFor(role: ModelProfileRole): string {
  return 'profile-' + role;
}

/**
 * 测试用凭据 store：记录被读取过的引用，按夹具给定的方式回答。
 *
 * 生产启动在准备阶段用同一份 store 证明 managed key 存在，测试因此需要一个可断言「有没有被读过、
 * 读到没有」的替身，而不是真的去碰用户凭据文件。
 */
export function credentialStoreFixture(secretByRef: Readonly<Record<string, string>> = {}): CredentialStore & {
  readonly reads: string[];
} {
  const reads: string[] = [];
  return {
    reads,
    metadata: () => ({ kind: 'metadata', revision: 1, refs: Object.keys(secretByRef) }),
    read: (credentialRef) => {
      reads.push(credentialRef);
      const secret = secretByRef[credentialRef];
      return secret === undefined
        ? { kind: 'rejected', code: 'credential_missing', message: '凭据不存在' }
        : { kind: 'resolved', secret };
    },
    save: () => ({ kind: 'rejected', code: 'invalid_request', message: '测试夹具不保存凭据' }),
  };
}

/** 单份 Worker 模型选择；legacy 名字保留，返回新 selection，新代码用 `modelSelectionFixture`。 */
export function modelConfigurationFixture(overrides: Partial<WorkerModelSelection> = {}): WorkerModelSelection {
  return {
    model: FIXTURE_MODEL,
    effort: null,
    effortCapability: null,
    catalogSource: null,
    ...overrides,
  };
}

/** 语义别名。 */
export const modelSelectionFixture = modelConfigurationFixture;

/** 某个生产角色的完整授权绑定。 */
export function workerProfileFixture(
  role: WorkerRole,
  overrides: Partial<WorkerModelSelection> = {},
): WorkerProfileRef {
  return {
    profileRef: { kind: 'worker-profile', id: profileRefFor(role) },
    role,
    harness: 'codex',
    modelSelection: modelConfigurationFixture(overrides),
  };
}

/** 四个生产角色齐全的授权绑定。 */
export function workerProfilesFixture(): readonly WorkerProfileRef[] {
  return PRODUCTION_ROLES.map((role) => workerProfileFixture(role));
}

/** Recovery Utility 的独立绑定：它不参与四主角色，但替代 Session 同样需要模型配置。 */
export function recoveryUtilityProfileFixture(): RecoveryUtilityProfile {
  return {
    profileRef: { kind: 'worker-profile', id: profileRefFor('recovery_utility') },
    harness: 'codex',
    modelSelection: modelConfigurationFixture(),
  };
}

/** 项目 schema4 的 execution.workerProfiles 与「角色当前选择引用」。 */
export function projectExecutionProfilesFixture(): {
  readonly workerProfiles: readonly WorkerProfileConfiguration[];
  readonly workerProfileRefs: Partial<Record<ModelProfileRole, string>>;
} {
  const workerProfiles: WorkerProfileConfiguration[] = PROJECT_ROLES.map((role) => ({
    profileRef: profileRefFor(role),
    role,
    harness: 'codex',
    modelSelection: modelConfigurationFixture(),
  }));
  const workerProfileRefs: Partial<Record<ModelProfileRole, string>> = {};
  for (const profile of workerProfiles) workerProfileRefs[profile.role] = profile.profileRef;
  return { workerProfiles, workerProfileRefs };
}

/** 项目 schema4 的 Coordinator providerConnections 与 models 夹具。 */
export function projectConnectionsFixture(): {
  readonly providerConnections: readonly ProviderConnection[];
  readonly models: readonly {
    readonly modelRef: string;
    readonly connectionRef: string;
    readonly model: string;
    readonly effortCapability: null;
  }[];
} {
  const connection: ProviderConnection = {
    connectionRef: FIXTURE_CONNECTION_REF,
    label: '测试连接',
    providerIntegration: 'minimax',
    modelOptions: {},
    credential: { kind: 'harness_login' },
  };
  return {
    providerConnections: [connection],
    models: [
      {
        modelRef: FIXTURE_MODEL_REF,
        connectionRef: FIXTURE_CONNECTION_REF,
        model: FIXTURE_MODEL,
        effortCapability: null,
      },
    ],
  };
}
