## Why

现有 `lab:new` 提前填写模型配置、创建 Route Map 并调用有费用的 doctor，绕过了实操需要检验的用户配置流程；ocp 启动器还指向开发仓库的可变构建。仓库回收缺少入口，创建记录又不足以证明删除目标身份。

## What Changes

- `lab:new` 准备独立私有 GitHub 仓库、主 checkout 与仓库内安装的 ocp，登记到 Orca 并打开项目终端；在该终端直接运行 `ocp` 或 `ocp --debug`。模型与 Scope 由用户通过 TUI 配置。
- 用当前构建的本地 npm 包安装 ocp，记录安装来源；不依赖开发仓库的启动脚本。
- **BREAKING** 移除 lab 专用模型向导、`lab configure`、`--settings` 和准备期 doctor。普通 TUI 启动自动核验环境，首次启动以步骤卡片配置模型、创建或选择 Route Map、明确确认初始化；debug 从空用户模型库也能完成配置。
- Scope 前 Route Map 初始化经 list/select/create 窄端口完成；按完整 branch ref 保存稳定操作记录，issue 附唯一 operation marker，unknown 只按原身份对账，不重新创建。
- 在动作前持久化轮次目标，取得资源后记录本地目录身份、远程不可变 ID 与安装来源；增加轮次列表及明确指定轮次的回收预览/执行。
- 回收保留仓库外的 `run.json`、安装包、operator 材料、采集证据和报告；失败与不确定结果可观测，不自动重试删除。
- 更新人工剧本，把 TUI 配置与首次启动列为验收步骤。

## Capabilities

### New Capabilities

- `testing/ledger-lab-rehearsal`：沿用 active `add-ledger-lab-rehearsal-infrastructure` 中的同名 capability，整合新的准备、配置边界、记录和显式回收合同。该路径尚无主规格，因此本 change 使用完整 ADDED 规格，并在实施时移交原 change 的对应 delta，避免两份互相冲突的合同同步。

### Modified Capabilities

生产初始化、模型设置与 debug 入口沿既有归属扩展，合同更新 IC-12/14/16；Worker 授权规则保持原归属。

## Impact

- 直接前驱：已归档的 `stabilize-agent-harness-core`（2026-10-09）；规划代码基线 `a29704bc7226c215f2bb14d1503211af82867c5f`。本 change 是原 lab 实操的准备流程调整，允许原 lab 保持 active；共享文件串行编辑，原 lab 尚未完成的真实业务验收继续保持未完成。
- 影响 `artifacts/ledger-lab` 的 setup/CLI/文档、`package.json` 打包清单、旧 lab 专用 bootstrap、普通启动引导、共享 provider 用户库编辑器、Scope 前地图应用端口/gh 与文件 adapter、debug 窄入口及相关测试；更新 architecture 和 IC-12/14/16。不新增依赖或 DB migration，不改变凭据归属、schema 5、Manifest v4 或 Worker Profile 门禁。
- 实施时更新 `openspec/config.yaml` 的已漂移批次说明和并行例外，调整原 lab 的受影响规划材料并移交同路径 delta；不改 archived 前驱。
- 包含用户批准的启动核验与配置引导呈现改进，复用已批准模型设置组件。范围不包含自动业务执行、批量回收、强制结束进程、自动 Orca 注销、旧轮次自动迁移或删除既有现场。
- 真实 GitHub/Orca main 轮次的限定框架生命周期 T4 已于 2026-10-10 完成，见 verification.md；cancel 档案隔离由 setup acceptance 覆盖，真实 Scope Cancel 归原 lab 业务验收。父任务写 verification，不启动独立 verifier；工程检查与本地 PTY 不替代真实平台证据，现场 TUI 缺陷继续保留记录。
