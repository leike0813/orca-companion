/**
 * 各项测试共用的模型绑定夹具（Manifest2 / 项目 schema2 / Task 固定绑定共用同一份）。
 *
 * 统一由这里生成，各测试文件就不必各写一份，也就不会出现「某个夹具的绑定与授权里的绑定对不上」
 * 这种与被测行为无关的失败。夹具只保存 credentialRef 一类的非秘密标识，凭据一律是
 * harness_login：这里没有任何明文 secret，也不代表任何真实 provider 或真实可用性。
 *
 * 需要制造非法绑定时，负例测试自己改写单个字段，不在这里提供「坏配置」开关。
 */

import type { CredentialStore } from '../../src/application/ports/credential-store.js';
import type { RecoveryUtilityProfile, WorkerProfileRef, WorkerRole } from '../../src/domain/planning/execution-authorization.js';
import type { ModelProfileRole, WorkerModelConfiguration, WorkerProfileConfiguration } from '../../src/domain/model-configuration.js';

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

/** 单份已批准模型绑定；role 只让调用点自解释，绑定本身对所有角色相同。 */
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

export function modelConfigurationFixture(
  role?: ModelProfileRole,
  overrides: Partial<WorkerModelConfiguration> = {},
): WorkerModelConfiguration {
  void role;
  return {
    connection: {
      connectionRef: FIXTURE_CONNECTION_REF,
      label: '测试连接',
      providerIntegration: 'minimax',
      modelOptions: {},
      credential: { kind: 'harness_login' },
      codex: { providerId: 'minimax', baseUrl: 'https://example.test/v1', wireApi: 'responses' },
    },
    modelRef: FIXTURE_MODEL_REF,
    model: FIXTURE_MODEL,
    effort: null,
    effortCapability: null,
    modelOptions: {},
    ...overrides,
  };
}

/** 某个生产角色的完整授权绑定。 */
export function workerProfileFixture(
  role: WorkerRole,
  overrides: Partial<WorkerModelConfiguration> = {},
): WorkerProfileRef {
  return {
    profileRef: { kind: 'worker-profile', id: profileRefFor(role) },
    role,
    harness: 'codex',
    modelConfiguration: modelConfigurationFixture(role, overrides),
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
    modelConfiguration: modelConfigurationFixture('recovery_utility'),
  };
}

/** 项目 schema2 的 execution.workerProfiles 与「角色当前选择引用」。 */
export function projectExecutionProfilesFixture(): {
  readonly workerProfiles: readonly WorkerProfileConfiguration[];
  readonly workerProfileRefs: Partial<Record<ModelProfileRole, string>>;
} {
  const workerProfiles = PROJECT_ROLES.map((role) => ({
    profileRef: profileRefFor(role),
    role,
    harness: 'codex',
    modelConfiguration: modelConfigurationFixture(role),
  }));
  const workerProfileRefs: Partial<Record<ModelProfileRole, string>> = {};
  for (const profile of workerProfiles) workerProfileRefs[profile.role] = profile.profileRef;
  return { workerProfiles, workerProfileRefs };
}

/** 项目 schema2 的 providerConnections 与 models 夹具。 */
export function projectConnectionsFixture(): {
  readonly providerConnections: readonly WorkerModelConfiguration['connection'][];
  readonly models: readonly {
    readonly modelRef: string;
    readonly connectionRef: string;
    readonly model: string;
    readonly effortCapability: null;
  }[];
} {
  const base = modelConfigurationFixture();
  return {
    providerConnections: [base.connection],
    models: [
      {
        modelRef: base.modelRef,
        connectionRef: base.connection.connectionRef,
        model: base.model,
        effortCapability: null,
      },
    ],
  };
}
