/**
 * IC-04：项目配置的同步窄存储端口（Owner: `complete-tui-model-configuration` IP-02 / D02）。
 *
 * 项目配置是**用户维护、纳入版本控制**的文件，因此这个端口只做三件事：读当前权威配置、在短锁内
 * 用 revision 做 CAS 原子替换、写完回读核验。它不理解模型设置语义，也不保存凭据——凭据由
 * `CredentialStore` 单独拥有，两者没有跨文件事务。
 *
 * 调用约定：
 * - 方法同步返回结果联合而不抛异常，文件系统的任何失败都是带结构化 code 的 `failed`；
 * - `expectedRevision` 是调用方最近一次读到的 revision，`0` 表示期望文件尚不存在；
 * - 候选配置由 store 在锁内重新校验并回读，调用方不需要也无法绕过这一层；
 * - 错误文案固定且安全，不转发原始异常或文件内容。
 */

import type { ProjectConfig } from '../configuration/project-config.js';

/** 失败码：调用方据此决定重试、重新读取还是让用户处理文件。 */
export const PROJECT_CONFIGURATION_FAILURE_CODES = [
  'absent',
  'unreadable',
  'invalid',
  'conflict',
  'lock_busy',
  'write_failed',
  'verify_failed',
] as const;

export type ProjectConfigurationFailureCode =
  (typeof PROJECT_CONFIGURATION_FAILURE_CODES)[number];

export type ProjectConfigurationFailure = {
  readonly kind: 'failed';
  readonly code: ProjectConfigurationFailureCode;
  readonly message: string;
};

export type ProjectConfigurationReadResult =
  | {
      readonly kind: 'read';
      /** 完整、已归一化的配置；`revision` 可直接作为后续保存的 `expectedRevision`。 */
      readonly config: ProjectConfig;
    }
  | { readonly kind: 'absent' }
  | ProjectConfigurationFailure;

export type ProjectConfigurationSaveInput = {
  /** 调用方最近一次读到的 revision；`0` 表示期望文件尚不存在。 */
  readonly expectedRevision: number;
  /** 完整候选配置；其 `revision` 必须等于 `expectedRevision + 1`，否则拒绝。 */
  readonly next: ProjectConfig;
};

export type ProjectConfigurationSaveResult =
  | {
      readonly kind: 'saved';
      readonly revision: number;
      /** 写完回读核验过的配置；store 是 revision 的唯一推进者。 */
      readonly config: ProjectConfig;
    }
  | ProjectConfigurationFailure;

export interface ProjectConfigurationStore {
  read(): ProjectConfigurationReadResult;
  save(input: ProjectConfigurationSaveInput): ProjectConfigurationSaveResult;
}
