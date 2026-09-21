/**
 * IC-09 / IP-8：替代 Session 启动前的四角色门（Owner: `m1-recover-execution`）。
 *
 * 门是纯判定：入参全部是已经核验的事实，出参只回答「这个角色的替代 Session 是否可以安全接续」。
 * 四个角色共用同一 Recovery Capsule 合同，只在准入条件上分叉：
 *
 * - Specification Planner：已落盘的 Specification Unit 不含隐藏决定；
 * - Implementation：workspace、HEAD 与 dirty paths 可对账，且无未知外部副作用；
 * - Validator：识别缺口后判断相关 Evidence 是否失效并重新验证；
 * - Finalizer：不需要 Capsule，从权威输入重跑只读交付检查。
 *
 * 本模块不生成 Capsule、不派发 Worker、不写存储，也不把「经过角色门」读成「任务通过」。
 */

import type { WorkerRole } from '../planning/execution-authorization.js';

export type PlannerGateFacts = {
  /** 工具原生 Specification Unit 是否已经落盘；没落盘就没有可接续的确定性契约。 */
  readonly specificationUnitLanded: boolean;
  /** 已落盘 unit 中尚未显式化的决定；非空即说明接续会依赖隐藏决定。 */
  readonly hiddenDecisions: readonly string[];
};

export type ImplementationGateFacts = {
  readonly workspaceReconciled: boolean;
  readonly headReconciled: boolean;
  readonly dirtyPathsReconciled: boolean;
  /** 无法对账的外部副作用引用；非空即不允许接续。 */
  readonly unknownExternalEffects: readonly string[];
};

export type ValidatorGateFacts = {
  /** 恢复时识别出的缺口；用于阻塞原因，不单独决定通过与否。 */
  readonly identifiedGaps: readonly string[];
  /** 因缺口而判定失效的 Evidence Record。 */
  readonly invalidatedEvidenceIds: readonly string[];
  /** 已经重新验证的 Evidence Record。 */
  readonly reverifiedEvidenceIds: readonly string[];
};

export type FinalizerGateFacts = {
  /** 权威输入引用（图、授权、Delivery Verdict 输入等）；为空说明没有可重跑的依据。 */
  readonly authoritativeInputs: readonly string[];
};

export type RoleGateFacts =
  | { readonly role: 'planner'; readonly planner: PlannerGateFacts }
  | { readonly role: 'implementation'; readonly implementation: ImplementationGateFacts }
  | { readonly role: 'validator'; readonly validator: ValidatorGateFacts }
  | { readonly role: 'finalizer'; readonly finalizer: FinalizerGateFacts };

export const ROLE_GATE_BLOCK_CODES = [
  'planner_unit_not_landed',
  'planner_hidden_decisions',
  'implementation_workspace_unreconciled',
  'implementation_unknown_side_effects',
  'validator_evidence_not_reverified',
  'finalizer_inputs_missing',
] as const;

export type RoleGateBlockCode = (typeof ROLE_GATE_BLOCK_CODES)[number];

export type RoleGateDecision =
  | { readonly kind: 'admitted'; readonly role: WorkerRole; readonly reason: string }
  | { readonly kind: 'blocked'; readonly role: WorkerRole; readonly code: RoleGateBlockCode; readonly reason: string };

function blocked(role: WorkerRole, code: RoleGateBlockCode, reason: string): RoleGateDecision {
  return { kind: 'blocked', role, code, reason };
}

function admitted(role: WorkerRole, reason: string): RoleGateDecision {
  return { kind: 'admitted', role, reason };
}

/** 只有 Finalizer 的门不依赖 Recovery Capsule，它从权威输入重跑只读检查。 */
export function roleGateRequiresCapsule(role: WorkerRole): boolean {
  return role !== 'finalizer';
}

export function evaluateRoleGate(facts: RoleGateFacts): RoleGateDecision {
  switch (facts.role) {
    case 'planner': {
      if (!facts.planner.specificationUnitLanded) {
        return blocked('planner', 'planner_unit_not_landed', '已落盘的 Specification Unit 缺失，无法确定接续的契约');
      }
      if (facts.planner.hiddenDecisions.length > 0) {
        return blocked(
          'planner',
          'planner_hidden_decisions',
          `已落盘 Specification Unit 含隐藏决定：${facts.planner.hiddenDecisions.join('、')}`,
        );
      }
      return admitted('planner', 'Specification Unit 已落盘且不含隐藏决定');
    }
    case 'implementation': {
      const unreconciled = [
        facts.implementation.workspaceReconciled ? null : 'workspace',
        facts.implementation.headReconciled ? null : 'HEAD',
        facts.implementation.dirtyPathsReconciled ? null : 'dirty paths',
      ].filter((value): value is string => value !== null);
      if (unreconciled.length > 0) {
        return blocked(
          'implementation',
          'implementation_workspace_unreconciled',
          `workspace / HEAD / dirty paths 无法对账：${unreconciled.join('、')}`,
        );
      }
      if (facts.implementation.unknownExternalEffects.length > 0) {
        return blocked(
          'implementation',
          'implementation_unknown_side_effects',
          `存在未知外部副作用：${facts.implementation.unknownExternalEffects.join('、')}`,
        );
      }
      return admitted('implementation', 'workspace、HEAD 与 dirty paths 可对账且无未知外部副作用');
    }
    case 'validator': {
      const notReverified = facts.validator.invalidatedEvidenceIds.filter(
        (evidenceId) => !facts.validator.reverifiedEvidenceIds.includes(evidenceId),
      );
      if (notReverified.length > 0) {
        return blocked(
          'validator',
          'validator_evidence_not_reverified',
          `缺口后失效的证据尚未重新验证：${notReverified.join('、')}`,
        );
      }
      return admitted(
        'validator',
        facts.validator.identifiedGaps.length === 0
          ? '未识别出需要重新验证的缺口'
          : `已识别 ${facts.validator.identifiedGaps.length} 个缺口，相关证据已失效并重新验证`,
      );
    }
    case 'finalizer': {
      if (facts.finalizer.authoritativeInputs.length === 0) {
        return blocked('finalizer', 'finalizer_inputs_missing', '缺少可重跑只读交付检查的权威输入');
      }
      return admitted('finalizer', '不需要 Capsule：从权威输入重跑只读交付检查');
    }
  }
}
