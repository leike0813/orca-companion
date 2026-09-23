## Why

`m2-deliver-planning-tui` 已有界面和 Controller 意图端口，但生产装配仍无法把用户消息送入 Coordinator loop；模型工具调用也只被绑定、没有执行节点。初始化、压缩、模型切换、交接与事件源因此无法形成可恢复的前台规划闭环。本 change 补齐这些 M1 接缝，作为规划 TUI 的直接前驱。

## What Changes

- 增加版本化项目配置加载与前台 Coordinator Runtime 装配，复用现有模型核验、lease/fencing、checkpoint、Controller 用例与 tracker adapter。
- **BREAKING**：在 Scope 创建时持久化用户登记的完整 branch ref 与 canonical worktree 绑定；现有缺少绑定的 Scope 必须显式迁移后才能恢复，Home 按精确绑定查找。
- 将用户消息作为可恢复的 Session 工作准入；让 LangGraph 实际执行并持久化模型 tool calls 与配对结果，恢复后不重复副作用。
- 接通手动压缩、模型配置切换、Pending Interaction 回答、Route Planning Handoff 与 Session 归属的语义事件；复用既有应用用例，不让 TUI 直接操作 store。
- 更新 `docs/interface-contracts.md` 中 IC-03、IC-04、IC-11、IC-12 的 Extend 登记，并把 `m2-deliver-planning-tui` 的直接前驱与 Home 接缝改为本 change。

## Capabilities

### New Capabilities

- `coordinator/foreground-planning-runtime`：项目配置、前台 Session 生命周期、Controller 命令装配及语义事件。

### Modified Capabilities

- `coordination/branch-state`：允许不可从 Git 当前状态重建的 Scope 注册绑定，同时继续排除 Git 运行事实副本。
- `coordinator/session-runtime`：完整执行、记录并恢复 Coordinator tool-call 回合。
- `coordinator/wake-suspension`：用户消息按稳定身份准入，并在暂停或崩溃后安全恢复。
- `coordinator/context-maintenance`：Session 手动压缩入口与可恢复的结果投影。

## Impact

直接前驱为已归档的 `m1-evolve-execution-graph`；本 change 属 M1 闭环补线，实施完成并归档后才继续 `m2-deliver-planning-tui`。影响 `src/bootstrap/`、`src/application/coordinator/`、`src/workflow/coordinator/`、两个 SQLite adapter 的受控 schema、Controller 合同、相关测试与规划 TUI 接缝。执行阶段 Worker 派发、Scope 级 Pause/Resume/Cancel UI、后台运行、远程 attach 与新 provider 依赖不在本 change 内。
