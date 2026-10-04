## Why

第六批 6A 已完成命令搜索与审阅，但 `/model` 仍只能切换预配置 Coordinator，Worker 启动仍读取未被授权绑定的全局模型。6B 要让定稿 #52 的角色模型选择、独立 effort 和配置编辑成为真实功能，并让实际启动与用户审阅的配置一致。

## What Changes

- 完整编辑 provider connection、模型、非秘密选项和角色配置；保存产生不可变引用，应用是独立用户决定。
- 用户级明文 JSON CredentialStore 保存 API key，项目配置仅保存 opaque credentialRef；秘密输入只留内存，启动只通过子进程环境传递。
- **BREAKING** 项目配置升为 v2，移除全局 workerModel；Execution Authorization Manifest 升为 v2，完整绑定角色的 harness/provider/model/effort/options/credentialRef。旧项目格式明确拒绝。
- 执行期间可审阅并重新授权模型配置；新 Task 使用新绑定，原 Task 的 Retry、Validator 修复和替代 Session 保持原绑定；新 Recovery Utility Task 单独固定创建时配置。
- Coordination schema 升为 16，Task materialization 固定授权与 profile；结果结算核验原绑定和当前 generation/contract。
- 遵守六票定稿与 #52 的角色分组、默认返回和独立水平 effort 选择，补齐生产画面对照及隔离启动证据。

直接前驱是已归档 `complete-tui-command-reviews`，本次属于第六批 6B。规划 Utility 和 Specification Validator 无生产生命周期，显示不可用原因。第七批偏好持久化、生命周期扩展、依赖安装、提交、归档与发布不在本次范围。

## Capabilities

### New Capabilities

- `configuration/model-settings`: 不可变配置编辑、CredentialStore、并发保存与秘密隔离。

### Modified Capabilities

- `coordinator/model-configuration`: 受控凭据解析和完整能力核验，保持 suspended 切换约束。
- `planning/execution-authorization`: 完整模型绑定、模型限定的重新授权、旧 Task 的绑定与预算保持。
- `tui/planning-workspace`: 定稿角色模型菜单、effort 与配置编辑/保存/应用。
- `workers/harness-binding`: 实际 Codex 启动与固定模型配置一致，credential 只进子进程环境。

## Impact

影响 application 配置用例、domain Manifest、project-config 与 credential storage、materialization/settlement/recovery、Codex launcher、bootstrap/doctor、TUI ports/菜单/编辑器以及相关文档和行为测试。使用现有依赖，不改 Orca 私有接口、不安装 provider 集成。IC-11/12 命令结果和页面返回、IC-13 输入恢复保持原 owner；配置编辑秘密不进入 UI input store。
