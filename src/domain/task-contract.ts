/**
 * IC-06 / IC-07 / IP-A3：Task Contract、Task Envelope、Spec Binding 与 Task Envelope 的候选报告载荷
 * （Owner: `m1-admit-work-package-specifications`）。
 *
 * 这里只有 Controller 拥有的契约字段，没有任何来自 Worker 载荷的身份位：`scope`、`runId`、
 * `consumerGeneration`、`operationId`、协调身份与 Session 句柄都不在本文件的类型里，因此模型
 * 「填写」这些值的唯一效果是在边界被丢弃（见 `worker-report-dto.ts`），而不是覆盖可信事实。
 *
 * 本模块不读时钟、不接触存储、不派发任何东西；Task Envelope 由 Controller 组装后单向交给 Worker。
 */

import type {
  DispatchId,
  WorkPackageId,
  WorkerTaskId,
} from '../application/dto/identity.js';
import type { RoleAuthorities, WorkerRole } from './planning/execution-authorization.js';
import type { ScopeEnvelope, WorkPackageBudget } from './planning/execution-graph.js';

/** Task Contract 与 Task Envelope 的结构版本；读取到未知版本在边界 fail closed。 */
export const TASK_CONTRACT_SCHEMA_VERSION = 1;

export const TASK_ENVELOPE_SCHEMA_VERSION = 1;

/** 工具原生 Specification Unit 的标识；路径必须是 worktree 相对路径，不记录绝对路径或 mtime。 */
export type SpecificationUnitLocator = {
  readonly worktreeId: string;
  /** worktree 相对路径，POSIX 分隔符。 */
  readonly relativePath: string;
};

/** 一次读取得到的规格内容快照；内容摘要才是身份，路径只用于定位。 */
export type SpecificationUnitSnapshot = {
  readonly provider: string;
  readonly providerVersion: string;
  readonly locator: SpecificationUnitLocator;
  readonly contentDigest: string;
  /** 规格声明的实现范围，用于 Scope Envelope 越界检查。 */
  readonly declaredScope: readonly SpecificationUnitScopeEntry[];
  /** 工具原生 unit 的结构版本；与 Companion 支持的版本不一致时接纳检查失败。 */
  readonly structureVersion: number;
  /** 契约内容 revision：契约工件内容变化即推进。 */
  readonly contractRevision: number;
  /** 追踪内容 revision：只改勾选也会推进。 */
  readonly trackingRevision: number;
};

/** 规格声明的单条实现范围；与 Scope Envelope 的 include/exclude 同构，但不在这里判定。 */
export type SpecificationUnitScopeEntry = {
  readonly kind: 'include' | 'exclude';
  readonly path: string;
};

/** 角色特定工件转换状态；Provider 只回答「这个角色的工件是否就绪」，不替 Controller 决定。 */
export type RoleTransitionQuery = {
  readonly role: WorkerRole;
  readonly workPackageId: WorkPackageId;
  /** 读取角色工件的 worktree；角色转换只存在于某个具体 worktree 内。 */
  readonly worktreeId: string;
};

export type RoleTransitionState = {
  readonly role: WorkerRole;
  readonly ready: boolean;
  readonly artifactKind: string | null;
  readonly detail: string | null;
};


/** Spec Binding 的身份由内容摘要与版本确定；路径只作为定位信息。 */
export type SpecBinding = {
  readonly provider: string;
  readonly relativePath: string;
  readonly contentDigest: string;
  readonly providerVersion: string;
  readonly contractRevision: number;
  readonly trackingRevision: number;
};

/** 期望证据：Controller 在派发前声明 Worker 必须回报什么，而不是事后追认。 */
export type EvidenceRequirement = {
  readonly evidenceKind: string;
  /** 该证据覆盖的 worktree 相对路径范围。 */
  readonly coveredPaths: readonly string[];
};

/** Worker 的工作区绑定；shell 与 cwd 由 Controller 固定，不由 Worker 选择。 */
export type WorkspaceBinding = {
  readonly worktreeId: string;
  readonly canonicalWorktree: string;
  readonly relativePath: string;
};

/** 单个 Worker Attempt 的有限预算；没有「不限制」的表示。 */
export type WorkerBudget = {
  readonly implementationAttempts: number;
  readonly validatorRepairs: number;
  readonly recoveries: number;
};

export type TaskContract = {
  readonly schemaVersion: number;
  readonly workPackageId: WorkPackageId;
  readonly graphGeneration: number;
  readonly dependencies: readonly WorkPackageId[];
  readonly scopeEnvelope: ScopeEnvelope;
  readonly baselineHead: string;
  readonly authority: RoleAuthorities;
  readonly budget: WorkPackageBudget;
  readonly acceptanceEvidence: readonly EvidenceRequirement[];
  readonly resultSchemaVersion: number;
};

/**
 * 每次派发固定的完整信封。
 *
 * 字段来源固定为 Controller：它从 Execution Authorization、当前图记录与 Scope 派生这些值；
 * Worker 只接收，不填写，也不回传覆盖值。
 */
export type TaskEnvelope = {
  readonly schemaVersion: number;
  readonly workerTaskId: WorkerTaskId;
  readonly dispatchId: DispatchId;
  readonly attemptId: string;
  readonly role: WorkerRole;
  readonly taskContract: TaskContract;
  readonly specBinding: SpecBinding;
  readonly workspace: WorkspaceBinding;
  readonly authority: RoleAuthorities;
  readonly budget: WorkerBudget;
  readonly expectedEvidence: readonly EvidenceRequirement[];
};

/**
 * 一次 Worker Dispatch 与真实 harness session 的精确绑定。
 *
 * `providerSessionId` 与 `transcriptRef` 都必须来自 harness 的可证明事实；terminal 输出、工作目录、
 * mtime 与「最近一次 transcript」都不能用来构造这个记录。
 */
export type SessionBinding = {
  readonly harness: string;
  readonly role: WorkerRole;
  readonly workerTaskId: WorkerTaskId;
  readonly dispatchId: DispatchId;
  readonly attemptId: string;
  readonly providerSessionId: string;
  readonly transcriptRef: string;
  readonly observedAt: string;
};

/** 角色是否被授权执行该角色的工作；`gitIntegration` 与 `dependencyChanges` 不属于角色的执行权限。 */
export function roleIsAuthorized(authority: RoleAuthorities, role: WorkerRole): boolean {
  return authority[role];
}

export function isTaskContractSchemaVersion(raw: unknown): raw is number {
  return raw === TASK_CONTRACT_SCHEMA_VERSION;
}

export function isTaskEnvelopeSchemaVersion(raw: unknown): raw is number {
  return raw === TASK_ENVELOPE_SCHEMA_VERSION;
}
