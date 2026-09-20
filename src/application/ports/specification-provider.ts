/**
 * IC-06 / IP-A4：`SpecificationProvider` 端口（Owner: `m1-admit-work-package-specifications`）。
 *
 * 这个端口只回答两件事：某个 worktree 里的工具原生 Specification Unit 是什么，以及某个角色的工件
 * 转换是否就绪。它不写业务状态、不做 plugin registry、不解析 OpenSpec 的 artifact 图语义；M1 只有
 * 一个产品实现，注册机制属于投机设计。
 *
 * 读取失败一律以结构化拒绝表达；adapter 不得用「最近修改」「当前工作目录」或终端输出替代真实读取。
 */

import type {
  RoleTransitionQuery,
  RoleTransitionState,
  SpecificationUnitLocator,
  SpecificationUnitSnapshot,
} from '../../domain/task-contract.js';

export type SpecificationReadFailure = {
  readonly code: string;
  readonly message: string;
};

export type SpecificationReadResult<T> =
  | { readonly kind: 'read'; readonly value: T }
  | { readonly kind: 'rejected'; readonly failure: SpecificationReadFailure };

export interface SpecificationProvider {
  /** provider 标识与版本；进入 Spec Binding，用于判断绑定是否仍由同一工具语义解释。 */
  readonly providerId: string;
  readonly providerVersion: string;
  /** 读取 worktree 内的工具原生 Specification Unit。 */
  readUnit(input: SpecificationUnitLocator): Promise<SpecificationReadResult<SpecificationUnitSnapshot>>;
  /** 读取某角色的工件转换状态；只读，不触发转换。 */
  readRoleTransition(
    input: RoleTransitionQuery,
  ): Promise<SpecificationReadResult<RoleTransitionState>>;
}
