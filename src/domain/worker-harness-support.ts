/**
 * IC-07：Worker Harness 能力证据与分级准入（change: `grade-worker-harness-admission`）。
 *
 * 支持等级是已核验能力的连续前缀：`basic` → `enhanced` → `complete`。只有低一级被完整证明，
 * 高一级才成立；缺一条底层能力就整体退回 `unavailable`，不存在「跳过 basic 直接 enhanced」。
 *
 * 事实只有三种状态，且 `verified` 必须带非空 `evidenceRef`：缺失、失败与无法核验都不构成证据，
 * 因此「没有记录」永远不会被读成「可用」。同一 capability 只允许一条证据，重复即拒绝，不静默覆盖。
 *
 * 只读（`read_only`）是任务级可选能力：Recovery Utility 与只读的规划/规格辅助操作在派发前单独核验它，
 * 但它不参与通用等级推导，缺少或失败都不会把已证的 enhanced/complete 拉回低级别。
 *
 * 纯判定模块：不启动 harness、不读 transcript、不碰时钟与存储。
 */

import { z } from 'zod';

import type { WorkerRole } from './planning/execution-authorization.js';

/** 支持等级由低到高；索引即排序，用于比较「实际是否满足要求」。 */
export const WORKER_SUPPORT_LEVELS = ['unavailable', 'basic', 'enhanced', 'complete'] as const;

export type WorkerSupportLevel = (typeof WORKER_SUPPORT_LEVELS)[number];

/** Companion 承认的能力维度（唯一事实源）。 */
export const WORKER_CAPABILITIES = [
  'task_input',
  'orca_binding',
  'planner_result',
  'implementation_result',
  'native_session',
  'session_resume',
  'read_only',
  'validator_result',
  'finalizer_result',
  'transcript_coverage',
  'recovery',
  'mixed_controller',
] as const;

export type WorkerCapability = (typeof WORKER_CAPABILITIES)[number];

export const WORKER_EVIDENCE_STATES = ['verified', 'failed', 'unverified'] as const;

export type WorkerEvidenceState = (typeof WORKER_EVIDENCE_STATES)[number];

/** 一条能力事实；`evidenceRef` 与 `diagnostic` 都没有时为 `null`。 */
export type WorkerCapabilityEvidence = {
  readonly capability: WorkerCapability;
  readonly state: WorkerEvidenceState;
  readonly evidenceRef: string | null;
  readonly diagnostic: string | null;
};

/** 一次 harness 资格核验的记录：只承载 harness 身份、证据引用与逐条能力事实。 */
export type WorkerHarnessQualification = {
  readonly harness: string;
  readonly evidenceRef: string;
  readonly facts: readonly WorkerCapabilityEvidence[];
};

const identity = z.string().min(1).max(2048);

/** 单条能力事实；`verified` 必须带非空 `evidenceRef`，否则连解析都不通过。 */
export const workerCapabilityEvidenceSchema = z
  .strictObject({
    capability: z.enum(WORKER_CAPABILITIES),
    state: z.enum(WORKER_EVIDENCE_STATES),
    evidenceRef: identity.nullable(),
    diagnostic: identity.nullable(),
  })
  .refine((fact) => fact.state !== 'verified' || fact.evidenceRef !== null, {
    message: 'verified 能力事实必须带非空 evidenceRef',
  });

/** 资格记录；同一 capability 出现两条证据即拒绝。 */
export const workerHarnessQualificationSchema = z.strictObject({
  harness: identity,
  evidenceRef: identity,
  facts: z
    .array(workerCapabilityEvidenceSchema)
    .refine(
      (facts) => new Set(facts.map((fact) => fact.capability)).size === facts.length,
      { message: '同一 capability 最多一条证据；重复即拒绝，不静默覆盖' },
    ),
});

/** 等级所需能力，按级别分组；组内缺一即该级别不成立。 */
const WORKER_SUPPORT_TIERS: ReadonlyArray<{
  readonly level: Exclude<WorkerSupportLevel, 'unavailable'>;
  readonly capabilities: readonly WorkerCapability[];
}> = [
  {
    level: 'basic',
    capabilities: ['task_input', 'orca_binding', 'planner_result', 'implementation_result'],
  },
  {
    level: 'enhanced',
    capabilities: ['native_session', 'session_resume', 'validator_result', 'finalizer_result'],
  },
  {
    level: 'complete',
    capabilities: ['transcript_coverage', 'recovery', 'mixed_controller'],
  },
];

/** 能力要求的主体：四种生产角色加三个专用角色。 */
export type WorkerSupportSubject =
  | WorkerRole
  | 'recovery_utility'
  | 'planning_utility'
  | 'specification_validator';

const MINIMUM_LEVELS: Record<WorkerSupportSubject, WorkerSupportLevel> = {
  planner: 'basic',
  implementation: 'basic',
  validator: 'enhanced',
  finalizer: 'enhanced',
  planning_utility: 'enhanced',
  specification_validator: 'enhanced',
  recovery_utility: 'complete',
};

/**
 * 从资格记录导出支持等级：返回最高的连续已证级别。
 *
 * 只有带非空 `evidenceRef` 的 `verified` 事实算证据；`failed`、`unverified` 与未记录的能力一律
 * 视为未证明，因此部分历史（部分能力无记录）得到的是更低的级别，而不是更高的。
 */
export function deriveWorkerSupportLevel(qualification: WorkerHarnessQualification): WorkerSupportLevel {
  const verified = new Set(
    qualification.facts
      .filter((fact) => fact.state === 'verified' && fact.evidenceRef !== null)
      .map((fact) => fact.capability),
  );
  let level: WorkerSupportLevel = 'unavailable';
  for (const tier of WORKER_SUPPORT_TIERS) {
    if (!tier.capabilities.every((capability) => verified.has(capability))) {
      break;
    }
    level = tier.level;
  }
  return level;
}

/** 各角色与专用角色所需的最低支持等级。 */
export function minimumWorkerSupportLevel(subject: WorkerSupportSubject): WorkerSupportLevel {
  return MINIMUM_LEVELS[subject];
}

/** 实际等级是否达到要求；仅按等级排序比较，不解释能力语义。 */
export function workerSupportLevelAllows(
  actual: WorkerSupportLevel,
  required: WorkerSupportLevel,
): boolean {
  const actualRank = WORKER_SUPPORT_LEVELS.indexOf(actual);
  const requiredRank = WORKER_SUPPORT_LEVELS.indexOf(required);
  return actualRank >= 0 && requiredRank >= 0 && actualRank >= requiredRank;
}
