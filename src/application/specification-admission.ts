/**
 * IC-06 / IP-A4：确定性 Specification Admission 与 Spec Binding
 * （Owner: `m1-admit-work-package-specifications`）。
 *
 * 接纳是一次确定性检查：结构、版本、Scope Envelope、authority 与预算逐项核验，任一不通过都逐条
 * 报告失败项并保留现场——不删除未接纳的 Specification Unit、不回滚 worktree、不消耗实现预算。
 * 接纳通过只说明这份规格可以被实现取用，**不**说明它在语义上完备。
 *
 * Spec Binding 的身份由内容摘要与版本确定，路径只用于定位：因此内容变化与「只改勾选」都会产生
 * 新绑定，而不是复用旧绑定的路径。
 */

import type { WorkPackageId } from './dto/identity.js';
import type { RoleAuthorities, WorkerRole } from '../domain/planning/execution-authorization.js';
import type { ScopeEnvelope } from '../domain/planning/execution-graph.js';
import { roleIsAuthorized, type SpecBinding, type SpecificationUnitSnapshot } from '../domain/task-contract.js';
import { budgetFieldExhausted, workPackageBudgetKey } from '../domain/dispatch-candidate.js';
import type { WorkerResult } from '../domain/worker-report.js';
import type { SpecificationProvider } from './ports/specification-provider.js';

export const SPECIFICATION_ADMISSION_CHECK_CODES = [
  'provider_version_unknown',
  'worktree_mismatch',
  'contract_revision_unsupported',
  'scope_envelope_exceeded',
  'role_not_authorized',
  'budget_exhausted',
  'validator_gate_failed',
] as const;

export type SpecificationAdmissionCheckCode = (typeof SPECIFICATION_ADMISSION_CHECK_CODES)[number];

/** 单条失败项：给出检查码、失败字段与原因，调用方据此报告而不是猜测。 */
export type SpecificationAdmissionFailure = {
  readonly code: SpecificationAdmissionCheckCode;
  readonly field: string;
  readonly message: string;
};

export type SpecificationAdmissionResult =
  | { readonly kind: 'admitted'; readonly specBinding: SpecBinding }
  | { readonly kind: 'rejected'; readonly failures: readonly SpecificationAdmissionFailure[] };

export type ReadinessDeclaration = {
  /** 声明这轮就绪的是哪个角色；本 change 只接受 Specification Planner。 */
  readonly role: WorkerRole;
  readonly producer:
    | { readonly kind: 'worker'; readonly role: WorkerRole; readonly sessionBindingId: string }
    | { readonly kind: 'coordinator-session'; readonly coordinatorSessionId: string };
  readonly workPackageId: WorkPackageId;
  readonly worktreeId: string;
  /** Specification Planner 写出的 worktree 相对路径；worktree 之外的路径由 Controller 拒绝。 */
  readonly relativePath: string;
  /** 声明的结构版本；与 Task Contract 的 schemaVersion 不一致即拒绝。 */
  readonly declaredVersion: number;
};

export type SpecificationAdmissionInput = {
  readonly provider: SpecificationProvider;
  readonly declaration: ReadinessDeclaration;
  readonly worktreeId: string;
  readonly workPackageId: WorkPackageId;
  readonly scopeEnvelope: ScopeEnvelope;
  readonly authority: RoleAuthorities;
  readonly contractSchemaVersion: number;
  /** `specificationRevisions` 的已消耗次数。 */
  readonly consumedSpecificationRevisions: number;
  /** `specificationRevisions` 的上限。 */
  readonly specificationRevisionLimit: number;
};

function safeRelativePath(path: string): boolean {
  const comparable = path.endsWith('/') ? path.slice(0, -1) : path;
  return (
    comparable.length > 0 &&
    !comparable.startsWith('/') &&
    !/^[A-Za-z]:[\\/]/.test(comparable) &&
    !comparable.includes('\\') &&
    comparable.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
  );
}

/** `root` 表示的文件或目录范围是否覆盖 `path`。 */
function pathCovers(root: string, path: string): boolean {
  return root === path || path.startsWith(root.endsWith('/') ? root : `${root}/`);
}

/** 路径是否完整落在 Scope Envelope 内；include 与 exclude 都是约束。 */
export function pathWithinEnvelope(envelope: ScopeEnvelope, path: string): boolean {
  if (!safeRelativePath(path)) {
    return false;
  }
  const included = envelope.include.some(
    (entry) => safeRelativePath(entry) && pathCovers(entry, path),
  );
  const overlapsExcluded = envelope.exclude.some(
    (entry) =>
      safeRelativePath(entry) && (pathCovers(entry, path) || pathCovers(path, entry)),
  );
  return included && !overlapsExcluded;
}

/**
 * 是否是 worktree 内的相对路径。
 *
 * 绝对路径、`..` 上跳与空路径一律不是：worktree 之外的规格必须被拒绝，而不是被静默规范化到别处。
 */
export function pathWithinWorktree(path: string): boolean {
  return safeRelativePath(path);
}

/**
 * 内容摘要绑定的 Spec Binding。
 *
 * `providerId` 与 `providerVersion` 来自 provider 本身，`relativePath` 只作定位，身份由
 * `contentDigest` 与两个 revision 共同确定。
 */
export function specBindingOf(snapshot: SpecificationUnitSnapshot, providerId: string): SpecBinding {
  return {
    provider: providerId,
    relativePath: snapshot.locator.relativePath,
    contentDigest: snapshot.contentDigest,
    providerVersion: snapshot.providerVersion,
    contractRevision: snapshot.contractRevision,
    trackingRevision: snapshot.trackingRevision,
  };
}

/**
 * 执行确定性接纳检查。
 *
 * provider 读取失败时原样透传为拒绝原因：读取失败不是「规格缺失」之外的任何解释。
 */
export async function admitSpecification(
  input: SpecificationAdmissionInput,
): Promise<SpecificationAdmissionResult> {
  const failures: SpecificationAdmissionFailure[] = [];

  if (input.declaration.role !== 'planner') {
    failures.push({
      code: 'role_not_authorized',
      field: 'declaration.role',
      message: `Specification Unit 必须由 Specification Planner 编写，实际为 ${input.declaration.role}`,
    });
  }
  if (
    input.declaration.producer.kind !== 'worker' ||
    input.declaration.producer.role !== 'planner' ||
    input.declaration.producer.sessionBindingId.length === 0
  ) {
    failures.push({
      code: 'role_not_authorized',
      field: 'declaration.producer',
      message: 'Specification Unit 必须来自具有精确 Session Binding 的 Specification Planner Worker',
    });
  }
  if (!roleIsAuthorized(input.authority, 'planner')) {
    failures.push({
      code: 'role_not_authorized',
      field: 'authority.planner',
      message: '当前授权不允许 Specification Planner 角色工作',
    });
  }
  if (input.declaration.worktreeId !== input.worktreeId) {
    failures.push({
      code: 'worktree_mismatch',
      field: 'declaration.worktreeId',
      message: `就绪声明绑定 worktree ${input.declaration.worktreeId}，与当前 Work Package 的 worktree ${input.worktreeId} 不一致`,
    });
  }
  if (input.declaration.workPackageId !== input.workPackageId) {
    failures.push({
      code: 'worktree_mismatch',
      field: 'declaration.workPackageId',
      message: '就绪声明与当前 Work Package 不一致',
    });
  }
  if (input.declaration.declaredVersion !== input.contractSchemaVersion) {
    failures.push({
      code: 'contract_revision_unsupported',
      field: 'declaration.declaredVersion',
      message: `就绪声明版本 ${input.declaration.declaredVersion} 与 Task Contract 版本 ${input.contractSchemaVersion} 不一致`,
    });
  }
  // 接纳只消耗 `specificationRevisions`：判定复用同一条耗尽语义，但只作用于这一个预算项。
  if (budgetFieldExhausted(input.specificationRevisionLimit, input.consumedSpecificationRevisions)) {
    failures.push({
      code: 'budget_exhausted',
      field: workPackageBudgetKey(input.workPackageId, 'specificationRevisions'),
      message: `specificationRevisions 预算已耗尽（${input.consumedSpecificationRevisions}/${input.specificationRevisionLimit}）`,
    });
  }
  if (!pathWithinWorktree(input.declaration.relativePath)) {
    failures.push({
      code: 'worktree_mismatch',
      field: 'declaration.relativePath',
      message: `Specification Unit 路径 ${input.declaration.relativePath} 不是 worktree 内的相对路径`,
    });
  }

  const read = await input.provider.readUnit({
    worktreeId: input.worktreeId,
    relativePath: input.declaration.relativePath,
  });
  if (read.kind === 'rejected') {
    return {
      kind: 'rejected',
      failures: [
        ...failures,
        { code: 'worktree_mismatch', field: 'unit', message: read.failure.message },
      ],
    };
  }
  const snapshot = read.value;

  if (snapshot.provider !== input.provider.providerId) {
    failures.push({
      code: 'provider_version_unknown',
      field: 'unit.provider',
      message: `读取到的 provider ${snapshot.provider} 与当前 provider ${input.provider.providerId} 不一致`,
    });
  }
  if (snapshot.providerVersion !== input.provider.providerVersion) {
    failures.push({
      code: 'provider_version_unknown',
      field: 'unit.providerVersion',
      message: `provider 版本 ${snapshot.providerVersion} 与当前版本 ${input.provider.providerVersion} 不一致`,
    });
  }
  if (snapshot.structureVersion !== input.contractSchemaVersion) {
    failures.push({
      code: 'contract_revision_unsupported',
      field: 'unit.structureVersion',
      message: `规格结构版本 ${snapshot.structureVersion} 与 Task Contract 的版本 ${input.contractSchemaVersion} 不一致`,
    });
  }
  if (snapshot.locator.worktreeId !== input.worktreeId) {
    failures.push({
      code: 'worktree_mismatch',
      field: 'unit.locator.worktreeId',
      message: '读取到的 Specification Unit 不属于当前 Work Package 的 worktree',
    });
  }
  for (const [index, entry] of snapshot.declaredScope.entries()) {
    if (entry.kind !== 'include') {
      continue;
    }
    if (!pathWithinEnvelope(input.scopeEnvelope, entry.path)) {
      failures.push({
        code: 'scope_envelope_exceeded',
        field: `unit.declaredScope[${index}].path`,
        message: `声明范围 ${entry.path} 超出 Work Package 的 Scope Envelope`,
      });
    }
  }

  if (failures.length > 0) {
    return { kind: 'rejected', failures };
  }
  return { kind: 'admitted', specBinding: specBindingOf(snapshot, input.provider.providerId) };
}

export type SpecificationValidatorGate = {
  readonly enabled: boolean;
  /** 需要独立审查角色时派发的角色；未启用时为 `null`。 */
  readonly reviewerRole: WorkerRole | null;
};

export type SpecificationValidatorGateResult = SpecificationValidatorGate & {
  readonly report: WorkerResult | null;
  readonly passed: boolean;
};

/**
 * 可选 Specification Validator 质量门。
 *
 * 质量门启用与否来自工作流配置，不由 Planner 自审决定：启用时返回独立审查角色，未启用时不产生任何
 * 额外派发。这里只回答「要不要派」，实际派发由注入的 reviewer 回调完成。
 */
export function specificationValidatorGate(enabled: boolean): SpecificationValidatorGate {
  return enabled ? { enabled: true, reviewerRole: 'validator' } : { enabled: false, reviewerRole: null };
}

/**
 * 在接纳之前执行质量门。
 *
 * 启用时把独立审查角色交给回调，由 Controller 派发一个独立角色的 Worker Task；未启用时回调一次都不会
 * 被调用，因此「未启用」与「派发失败」不会混为一谈。
 */
export async function runSpecificationValidatorGate(input: {
  readonly enabled: boolean;
  readonly review: (reviewerRole: 'validator') => Promise<WorkerResult>;
}): Promise<SpecificationValidatorGateResult> {
  const gate = specificationValidatorGate(input.enabled);
  if (gate.reviewerRole === null) {
    return { ...gate, report: null, passed: true };
  }
  const report = await input.review('validator');
  return {
    ...gate,
    report,
    passed: report.evidence.length > 0 && report.evidence.every((evidence) => evidence.outcome === 'passed'),
  };
}

/** 启用质量门时，独立 Validator 的 Worker Result 必须先通过，随后才执行确定性接纳。 */
export async function admitSpecificationWithValidatorGate(input: {
  readonly admission: SpecificationAdmissionInput;
  readonly validatorEnabled: boolean;
  readonly review: (reviewerRole: 'validator') => Promise<WorkerResult>;
}): Promise<SpecificationAdmissionResult> {
  const gate = await runSpecificationValidatorGate({
    enabled: input.validatorEnabled,
    review: input.review,
  });
  if (!gate.passed) {
    return {
      kind: 'rejected',
      failures: [
        {
          code: 'validator_gate_failed',
          field: 'specificationValidator',
          message: '独立 Specification Validator 的 Worker Result 未通过质量门',
        },
      ],
    };
  }
  return admitSpecification(input.admission);
}
