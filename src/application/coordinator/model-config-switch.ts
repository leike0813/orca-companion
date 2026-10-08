/**
 * IC-04 的 Coordinator Model Configuration 与运行中切换用例
 * （Owner: `m1-run-coordinator-sessions`，模型设置形状由 `complete-tui-model-configuration` IP-01 扩展）。
 *
 * 本模块拥有用户选定的完整不可变配置与切换规则；凭据只保留引用，adapter 在构造时解析。
 *
 * 切换顺序是固定的（D14）：校验 Session 处于 suspended 且无在途模型操作 → 持久化 checkpoint →
 * 必要时把不兼容的原生窗口迁移为可移植 Capsule → 清空旧 cache 与维护计划 → 装配并核验新配置 →
 * 生效。任一步失败都保持原配置，不做自动回退，也不产生半切换状态。
 */

import { z } from 'zod';

import type {
  CoordinatorSessionState,
  NativeCompactedWindowOwner,
  PortableContextCapsule,
} from '../../domain/coordinator/session-state.js';
import {
  effortCapabilitySchema,
  providerConnectionSchema,
  providerProtocolSchema,
  type EffortCapability,
  type ProviderConnection,
} from '../../domain/model-configuration.js';
import type { CoordinatorSessionId } from '../dto/identity.js';
import type { CheckpointWriteResult, CoordinatorSessionRecordPort } from './runtime-guard.js';
import type { SuspensionState } from './suspension.js';

const identity = z.string().min(1).max(2048);

/**
 * 一份用户批准的 Coordinator Model Configuration。
 *
 * `credentialRefs` 只是引用：密钥值仅从用户级 CredentialStore 解析。
 *
 * 项目 parser 要求完整连接与 modelRef；未知 effort 能力为 null。
 *
 * `providerConnection` 是完整快照，装配时无需回查可变用户库。
 * 它与项目配置里被引用的连接记录必须逐字段一致，交叉核验在项目配置 parser 统一完成。
 */
export const coordinatorModelConfigurationSchema = z.strictObject({
  /** 稳定引用；Session registry 里登记的就是它。 */
  configurationRef: identity,
  /** 用户选定的固定协议。 */
  providerIntegration: providerProtocolSchema,
  model: identity,
  credentialRefs: z.array(identity),
  /** 该配置使用的原生压缩窗口 owner 身份；跨配置迁移的兼容判据。 */
  nativeWindowOwnerRef: identity.nullable(),
  /** 所引用 Provider Connection 的完整快照；其 connectionRef 必须指向同一条记录。 */
  providerConnection: providerConnectionSchema.optional(),
  /** 所引用 Model 定义的引用。 */
  modelRef: identity.optional(),
  /** effort 的可信能力来源；null 表示该模型没有可信的 effort 能力。 */
  effortCapability: effortCapabilitySchema.nullable().optional(),
  /** 选定的 effort；null 表示交给 provider 默认值。 */
  effort: identity.nullable().optional(),
});

export type CoordinatorModelConfiguration = z.infer<typeof coordinatorModelConfigurationSchema>;

/** 该配置携带的 provider 连接快照；没有可信连接时为 null。 */
export function configurationConnection(
  configuration: CoordinatorModelConfiguration,
): ProviderConnection | null {
  return configuration.providerConnection ?? null;
}

/** 该配置是否有可信 effort 能力来源；没有就不允许显式选 effort。 */
export function isEffortSelectable(configuration: CoordinatorModelConfiguration): boolean {
  const capability: EffortCapability | null | undefined = configuration.effortCapability;
  return capability !== null && capability !== undefined;
}

/** 模型相关操作的在途情况；只有为零时才允许切换。 */
export type SwitchabilityInput = {
  readonly suspension: SuspensionState | null;
  readonly inFlightModelOperations: number;
};

export const SWITCH_REJECTION_CODES = ['not_suspended', 'operations_in_flight'] as const;

export type SwitchRejectionCode = (typeof SWITCH_REJECTION_CODES)[number];

export type SwitchFailureCode =
  | SwitchRejectionCode
  | 'verification_failed'
  | 'persist_failed'
  | 'migration_failed';

export type Switchability =
  | { readonly kind: 'switchable' }
  | { readonly kind: 'rejected'; readonly code: SwitchRejectionCode; readonly message: string };

/**
 * 判定是否允许切换配置。
 *
 * 模型循环进行中或存在在途模型调用时拒绝：中断在途调用只会产生半切换状态，而半切换状态的
 * 代价远高于让用户等这一步结束。
 */
export function assertSwitchable(input: SwitchabilityInput): Switchability {
  if (input.suspension === null) {
    return {
      kind: 'rejected',
      code: 'not_suspended',
      message: '只有处于 suspended 的 Session 才能切换 Coordinator Model Configuration',
    };
  }
  if (input.inFlightModelOperations > 0) {
    return {
      kind: 'rejected',
      code: 'operations_in_flight',
      message: `仍有 ${String(input.inFlightModelOperations)} 个模型相关操作在途`,
    };
  }
  return { kind: 'switchable' };
}

/** 新配置能否原样使用某个已记录的原生压缩窗口。 */
export function isNativeWindowCompatible(
  next: CoordinatorModelConfiguration,
  owner: NativeCompactedWindowOwner | null,
): boolean {
  if (owner === null) {
    return true;
  }
  return next.nativeWindowOwnerRef !== null && next.nativeWindowOwnerRef === owner.ownerRef;
}

/**
 * Capsule 派生 seam。
 *
 * 派生规则属于 workflow 层的上下文维护，不能由 Application 反向 import；因此以函数注入，
 * 与 `compaction.ts` 的做法一致。
 */
export type CapsuleDerivationPort = (input: {
  readonly fromStepId: string;
  readonly toStepId: string;
  readonly steps: readonly {
    readonly stepId: string;
    readonly messages: readonly unknown[];
  }[];
}) => PortableContextCapsule;

/** 迁移原生窗口需要的最小持久化 seam；由 checkpoint store 实现。 */
export type NativeWindowMigrationPort = {
  readonly savePortableCapsule: (
    coordinatorSessionId: CoordinatorSessionId,
    capsule: PortableContextCapsule,
  ) => CheckpointWriteResult;
  readonly clearNativeWindowOwner: (coordinatorSessionId: CoordinatorSessionId) => CheckpointWriteResult;
};

export type NativeWindowMigrationResult =
  | { readonly kind: 'not-needed' }
  | { readonly kind: 'migrated'; readonly capsuleId: string }
  | { readonly kind: 'failed'; readonly reason: string };

/**
 * 把不再兼容的原生压缩窗口迁移为可移植 Context Capsule。
 *
 * 原生窗口绑定 provider 身份与代际，跨配置直接携带会让请求不可解释；Capsule 是唯一不丢失语义的
 * 路径。迁移成功才清掉原生项，失败则原样保留，让 Session 停在 suspended 或 blocked。
 */
export function migrateNativeWindowToCapsule(input: {
  readonly coordinatorSessionId: CoordinatorSessionId;
  readonly owner: NativeCompactedWindowOwner | null;
  readonly sessionState: CoordinatorSessionState;
  readonly deriveCapsule: CapsuleDerivationPort;
  readonly checkpoints: NativeWindowMigrationPort;
}): NativeWindowMigrationResult {
  if (input.owner === null) {
    return { kind: 'not-needed' };
  }
  const steps = input.sessionState.committedMessages.map((entry) => ({
    stepId: entry.stepId,
    messages: [entry],
  }));
  const first = steps[0];
  const last = steps[steps.length - 1];
  if (first === undefined || last === undefined) {
    return { kind: 'failed', reason: '没有可派生 Capsule 的已提交历史，无法迁移原生压缩窗口' };
  }

  let capsule: PortableContextCapsule;
  try {
    capsule = input.deriveCapsule({ fromStepId: first.stepId, toStepId: last.stepId, steps });
  } catch (error) {
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }

  const saved = input.checkpoints.savePortableCapsule(input.coordinatorSessionId, capsule);
  if (saved.kind === 'failed') {
    return { kind: 'failed', reason: saved.message };
  }
  const cleared = input.checkpoints.clearNativeWindowOwner(input.coordinatorSessionId);
  if (cleared.kind === 'failed') {
    return { kind: 'failed', reason: `原生窗口迁移后无法清除原 owner：${cleared.message}` };
  }
  return { kind: 'migrated', capsuleId: capsule.capsuleId };
}

export type SwitchVerification =
  | { readonly kind: 'verified' }
  | { readonly kind: 'rejected'; readonly message: string };

export type SwitchModelConfigurationRequest = {
  readonly coordinatorSessionId: CoordinatorSessionId;
  readonly current: CoordinatorModelConfiguration;
  readonly next: CoordinatorModelConfiguration;
  readonly switchability: SwitchabilityInput;
  readonly sessionRecords: CoordinatorSessionRecordPort;
  readonly nativeWindows: NativeWindowMigrationPort;
  readonly deriveCapsule: CapsuleDerivationPort;
  /** 装配并核验新配置；失败即整次切换失败。 */
  readonly verify: (configuration: CoordinatorModelConfiguration) => Promise<SwitchVerification>;
  /** 核验通过后持久化 Session registry 的配置绑定。 */
  readonly persistConfiguration: (
    configuration: CoordinatorModelConfiguration,
  ) => CheckpointWriteResult;
  /** 清空旧模型相关的 cache 与既有 maintenance 计划；返回被清掉的 maintenance cycle 数。 */
  readonly clearDerivedCaches: () => number;
};

export type SwitchModelConfigurationResult =
  | {
      readonly kind: 'switched';
      readonly configuration: CoordinatorModelConfiguration;
      readonly migratedNativeWindow: boolean;
      readonly clearedMaintenanceCycles: number;
    }
  | {
      readonly kind: 'rejected';
      readonly code: SwitchFailureCode;
      readonly message: string;
      /** 失败时生效的仍然是原配置；这里如实返回它，避免调用方猜测。 */
      readonly configuration: CoordinatorModelConfiguration;
    };

/**
 * 在 suspended 且无在途模型操作时切换配置。
 *
 * 只在全部步骤成功后返回新配置；任何一步失败都回到原配置，且不自动改投其他模型。
 */
export async function switchModelConfiguration(
  request: SwitchModelConfigurationRequest,
): Promise<SwitchModelConfigurationResult> {
  const reject = (code: SwitchFailureCode, message: string): SwitchModelConfigurationResult => ({
    kind: 'rejected',
    code,
    message,
    configuration: request.current,
  });

  const switchable = assertSwitchable(request.switchability);
  if (switchable.kind === 'rejected') {
    return reject(switchable.code, switchable.message);
  }

  // 1. 核验有效上下文并持久化控制位置；已提交历史独立保留。
  const read = request.sessionRecords.loadCheckpoint(request.coordinatorSessionId, 'context');
  if (read.kind !== 'recovered') {
    return reject(
      'persist_failed',
      read.kind === 'absent' ? '该 Session 还没有可持久化的会话记录' : `会话记录不可恢复：${read.reason}`,
    );
  }
  const persisted = request.sessionRecords.updateCheckpoint(request.coordinatorSessionId, { graphPosition: read.state.graphPosition });
  if (persisted.kind === 'failed') {
    return reject('persist_failed', `切换前无法持久化 checkpoint：${persisted.message}`);
  }

  // 2. 必要时迁移不兼容的原生窗口：成功才继续。
  const owner = read.state.contextMaterial?.nativeWindowOwner ?? null;
  let migrated = false;
  if (!isNativeWindowCompatible(request.next, owner)) {
    const original = request.sessionRecords.loadCheckpoint(request.coordinatorSessionId, 'migration');
    if (original.kind !== 'recovered') return reject('migration_failed', original.kind === 'unrecoverable' ? original.reason : 'Session absent');
    const migration = migrateNativeWindowToCapsule({
      coordinatorSessionId: request.coordinatorSessionId,
      owner,
      sessionState: original.state,
      deriveCapsule: request.deriveCapsule,
      checkpoints: request.nativeWindows,
    });
    if (migration.kind === 'failed') {
      return reject('migration_failed', migration.reason);
    }
    migrated = migration.kind === 'migrated';
  }

  // 3. 清空旧模型相关的 cache 与既有 maintenance 计划。
  const clearedMaintenanceCycles = request.clearDerivedCaches();

  // 4. 装配并核验新配置；核验失败保持原配置。
  const verification = await request.verify(request.next);
  if (verification.kind === 'rejected') {
    return reject('verification_failed', verification.message);
  }

  const activated = request.persistConfiguration(request.next);
  if (activated.kind === 'failed') {
    return reject('persist_failed', `无法持久化 Coordinator Model Configuration：${activated.message}`);
  }

  return {
    kind: 'switched',
    configuration: request.next,
    migratedNativeWindow: migrated,
    clearedMaintenanceCycles,
  };
}
