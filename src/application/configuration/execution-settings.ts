/**
 * 可配置执行并发的项目默认值用例（restore-configurable-execution-concurrency IP-04）。
 *
 * 它只拥有**项目默认额度**：读取当前配置并在 revision CAS 下保存一个新的
 * `execution.limits.maxActiveWorkPackages`。保存不构成执行授权——当前批准额度只存在
 * Execution Authorization Manifest 里，改变它必须经完整 Manifest 重新审阅与批准，因此这里
 * 既不读也不写任何授权记录。额度无硬上限 3：任意正安全整数都可保存，由调度按批准额度使用。
 */

import type {
  ProjectConfigurationStore,
  ProjectConfigurationSaveResult,
} from '../ports/project-configuration-store.js';
import { parseProjectConfig, type ProjectConfig } from './project-config.js';

export const EXECUTION_SETTINGS_REJECTION_CODES = [
  'invalid_input',
  'config_absent',
  'config_unreadable',
  'conflict',
  'save_failed',
] as const;

export type ExecutionSettingsRejectionCode = (typeof EXECUTION_SETTINGS_REJECTION_CODES)[number];

export type ExecutionSettingsRejection = {
  readonly kind: 'rejected';
  readonly code: ExecutionSettingsRejectionCode;
  readonly message: string;
};

export type ExecutionSettingsLoadResult =
  | {
      readonly kind: 'loaded';
      /** 项目配置 revision；保存候选的 CAS 基准。 */
      readonly revision: number;
      readonly defaultMaxActiveWorkPackages: number;
    }
  | ExecutionSettingsRejection;

export type ExecutionSettingsSaveResult =
  | {
      readonly kind: 'saved';
      readonly revision: number;
      readonly defaultMaxActiveWorkPackages: number;
    }
  | ExecutionSettingsRejection;

export type SaveExecutionSettingsInput = {
  /** 调用方读到的项目配置 revision；不匹配即拒绝，不覆盖较新的配置。 */
  readonly expectedRevision: number;
  readonly maxActiveWorkPackages: number;
};

export type ExecutionSettingsService = {
  readonly load: () => ExecutionSettingsLoadResult;
  readonly save: (input: SaveExecutionSettingsInput) => ExecutionSettingsSaveResult;
};

export type ExecutionSettingsDependencies = {
  readonly projectStore: ProjectConfigurationStore;
};

function reject(code: ExecutionSettingsRejectionCode, message: string): ExecutionSettingsRejection {
  return { kind: 'rejected', code, message };
}

/** 默认并行额度必须是正安全整数，与配置 schema 的约束一致；校验先于任何读取或写入。 */
export function isValidMaxActiveWorkPackages(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/** 只替换默认额度，保留其余配置与既有的不可变记录。 */
function withDefaultConcurrency(current: ProjectConfig, value: number): ProjectConfig {
  return {
    ...current,
    revision: current.revision + 1,
    execution: {
      ...current.execution,
      limits: { ...current.execution.limits, maxActiveWorkPackages: value },
    },
  };
}

export function createExecutionSettingsService(
  dependencies: ExecutionSettingsDependencies,
): ExecutionSettingsService {
  const { projectStore } = dependencies;
  return {
    load(): ExecutionSettingsLoadResult {
      const loaded = projectStore.read();
      if (loaded.kind === 'absent') {
        return reject('config_absent', '项目没有可保存的 orca-companion.json');
      }
      if (loaded.kind === 'failed') {
        return reject('config_unreadable', loaded.message);
      }
      return {
        kind: 'loaded',
        revision: loaded.config.revision,
        defaultMaxActiveWorkPackages: loaded.config.execution.limits.maxActiveWorkPackages,
      };
    },
    save(input: SaveExecutionSettingsInput): ExecutionSettingsSaveResult {
      if (!isValidMaxActiveWorkPackages(input.maxActiveWorkPackages)) {
        return reject('invalid_input', '并行额度必须是正安全整数');
      }
      const loaded = projectStore.read();
      if (loaded.kind === 'absent') {
        return reject('config_absent', '项目没有可保存的 orca-companion.json');
      }
      if (loaded.kind === 'failed') {
        return reject('config_unreadable', loaded.message);
      }
      const current = loaded.config;
      if (current.revision !== input.expectedRevision) {
        return reject('conflict', `项目配置已被其他编辑修改（当前 revision ${String(current.revision)}）`);
      }
      const next = withDefaultConcurrency(current, input.maxActiveWorkPackages);
      const validated = parseProjectConfig(next);
      if (!validated.ok) {
        return reject('invalid_input', `${validated.field}: ${validated.message}`);
      }
      const saved: ProjectConfigurationSaveResult = projectStore.save({
        expectedRevision: input.expectedRevision,
        next: validated.value,
      });
      if (saved.kind === 'failed') {
        return reject(saved.code === 'conflict' ? 'conflict' : 'save_failed', saved.message);
      }
      return {
        kind: 'saved',
        revision: saved.revision,
        defaultMaxActiveWorkPackages: saved.config.execution.limits.maxActiveWorkPackages,
      };
    },
  };
}
