/**
 * IC-04 项目配置在 bootstrap 层的入口（Owner: `complete-tui-model-configuration` IP-01）。
 *
 * 实现本身在 `src/application/configuration/project-config.ts`：应用层的 ModelSettingsService 必须
 * 使用同一份 schema 与交叉引用规则，而 application 不能反向依赖 bootstrap。这里只做一次显式转出，
 * 保留既有 import 路径，同时保证项目配置只有一份 parser。
 */

export {
  CODEX_FULL_ACCESS_RISK,
  CODEX_SANDBOX_MODES,
  configurationByRef,
  currentWorkerProfile,
  DEFAULT_PROJECT_EXECUTION,
  loadProjectConfig,
  parseProjectConfig,
  PROJECT_CONFIG_FILENAME,
  PROJECT_CONFIG_SCHEMA_VERSION,
  projectConfigPath,
} from '../application/configuration/project-config.js';
export type {
  CodexSandboxMode,
  LoadProjectConfigOptions,
  ProjectConfig,
  ProjectConfigFailureCode,
  ProjectConfigLoadResult,
  ProjectContextBudget,
  ProjectExecutionConfiguration,
  ProjectOutputBudget,
  ProjectPlanningPermissions,
  ProjectTrackerConfiguration,
} from '../application/configuration/project-config.js';
