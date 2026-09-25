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

import { createHash } from 'node:crypto';

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

/**
 * 工具原生规格树的根目录。
 *
 * 它是 Specification Pipeline 自己的工作区（change 单元、同步后的主规格、以及工具自己的配置），不是被
 * 实现的项目内容：因此不参与 Work Package 的 Scope Envelope 越界判定。单元身份仍由内容摘要与 Spec
 * Binding 约束。
 */
export const SPECIFICATION_ROOT_DIRECTORY = 'openspec';

/** Planner 的目标路径在规格产生前就由宿主固定，供后续 Admission 原样读回。 */
export const SPECIFICATION_UNIT_DIRECTORY = `${SPECIFICATION_ROOT_DIRECTORY}/changes`;

/**
 * Work Package 身份 → 文件系统安全的 change 目录名。
 *
 * 目录名要同时满足三件事：跨平台可写（不能出现 `:` 之类 NTFS 不允许的字符）、人能照着写、以及不同
 * Work Package 不会撞到同一个名字。因此把身份里的其它字符折成 `-`，再接一段内容哈希后缀保证单射。
 * 百分号编码不是可选项：`%23`/`%3A` 这种拼写既不是工具惯例，Worker 会自然写成解码后的形式。
 */
export function specificationUnitNameFor(workPackageId: WorkPackageId): string {
  const slug = String(workPackageId)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  const digest = createHash('sha256').update(String(workPackageId)).digest('hex').slice(0, 8);
  return `${slug.length === 0 ? 'work-package' : slug}-${digest}`;
}

export function specificationUnitPathFor(workPackageId: WorkPackageId): string {
  return `${SPECIFICATION_UNIT_DIRECTORY}/${specificationUnitNameFor(workPackageId)}`;
}

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
  /** Planner 首次创建规格时为 null；后续角色必须使用已接纳的内容绑定。 */
  readonly specBinding: SpecBinding | null;
  /** Planner 创建规格的固定 worktree 相对路径。 */
  readonly specificationUnitPath?: string;
  /**
   * 宿主对这次派发的直接指令（面向 Worker 的正文，不是可选建议）。
   *
   * Worker 只读：它由 Controller 按角色与模式写出，进入 Orca Task 的 `spec`，不参与任何身份判定，也
   * 不接受回传覆盖。角色没有额外指令时是空数组。
   */
  readonly instructions: readonly string[];
  readonly workspace: WorkspaceBinding;
  readonly authority: RoleAuthorities;
  readonly budget: WorkerBudget;
  readonly expectedEvidence: readonly EvidenceRequirement[];
};

/**
 * Specification Planner 的产出纪律。
 *
 * 真实运行里 Planner 两次把单元写在自选名字的目录、或漏掉 `specs/`，Admission 只能 fail closed——那是
 * 宿主该说清楚的话，而不是让 Worker 猜：位置由 Envelope 固定，结构由 OpenSpec 决定，归档属于交付之后
 * 的动作，都不在这次派发范围内。
 */
export function plannerSpecificationInstructions(specificationUnitPath: string): readonly string[] {
  return [
    `Specification Unit 必须写在 ${specificationUnitPath}（worktree 相对路径），不得改名或另建目录。`,
    '该 change 必须包含 OpenSpec 的 specs/ 增量规格与 tasks.md；结构不完整的单元不会被接纳。',
    '本次派发只负责编写规格：不得执行 `openspec archive` 或把 change 移入 archive/。',
    'proposal.md 的 `## Impact` 段落只能引用本 Work Package Scope Envelope 内的路径：声明信封外的文件会被 Admission 以 `scope_envelope_exceeded` 拒绝。',
  ];
}

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
