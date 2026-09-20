## Purpose

定义前台 TUI 的启动门禁，以及 Home 恢复既有 Coordination Scope 或经向导原子创建新 Scope 的可观察行为。

## ADDED Requirements

### Requirement: 前台入口与 TTY 门禁

`orca-companion [repository-path]` SHALL 启动前台 TUI；`orca-companion status [--json]` 与 `orca-companion doctor` SHALL 保持无 TTY 可运行。系统 MUST NOT 提供 `run`、`resume` 或 `tui` 子命令。启动 TUI 前系统 SHALL 同时检查 stdin 与 stdout 的 TTY 状态，任一无 TTY 时 MUST 在挂载 Ink 之前以非零状态拒绝，且 MUST NOT 出现 raw-mode 报错但退出码为零的结果。

#### Scenario: 无 TTY 时启动 TUI 被拒绝
- **WHEN** 用户在没有 TTY 的环境（管道或 CI）运行 `orca-companion`
- **THEN** 进程在挂载 Ink 前以非零状态退出，诊断写入 stderr，且 stdout 不含渲染帧

#### Scenario: 一次性命令在无 TTY 环境保持可用
- **WHEN** 用户在没有 TTY 的环境运行 `orca-companion status --json`
- **THEN** 命令以零状态退出，stdout 输出可解析的 JSON 快照，诊断只写 stderr

#### Scenario: 不存在的子命令被拒绝
- **WHEN** 用户运行 `orca-companion resume`
- **THEN** 命令以非零状态拒绝该子命令，并指出受支持的入口

### Requirement: Home 的 Scope 恢复与查找

Home SHALL 按 Git common dir 与完整 branch ref 查找当前仓库下唯一未归档的 Coordination Scope。存在匹配 Scope 时系统 SHALL 直接恢复该 Scope，MUST NOT 重复创建；不存在匹配 Scope 时系统 SHALL 进入初始化向导，MUST NOT 在启动过程中隐式创建 Scope。

#### Scenario: 存在匹配 Scope 时直接恢复
- **WHEN** 用户在已有未归档 Scope 的仓库中启动 TUI
- **THEN** 系统进入该 Scope 并恢复上次选中的 Coordinator Session，不创建新的 Scope

#### Scenario: 无匹配 Scope 时进入向导
- **WHEN** 用户在没有任何 Scope 的仓库中启动 TUI
- **THEN** 系统展示初始化向导，且在用户最终确认前不写入任何持久化记录

### Requirement: 初始化向导的核验与原子创建

初始化向导 SHALL 依次核验 repository 与 canonical worktree、Orca 能力与调用者身份、Coordinator Model Configuration 与 issue tracker。向导 MUST NOT 收集 Worker Profiles、并发与尝试预算、依赖权限、Git 集成策略或 accepted risks；这些 SHALL 留给 Execution Authorization Manifest。最终 Review 之前系统 MUST NOT 持久化任何 Scope 记录。用户确认后系统 SHALL 以单事务创建 Scope、初始 Planning Cycle 与首个 Coordinator Session，并 MUST NOT 创建 Orca Run、Task 或 worktree。任一步核验失败时系统 SHALL 停留在向导内并指出失败项，MUST NOT 部分创建 Scope。

#### Scenario: 确认后原子创建最小 Scope
- **WHEN** 用户在向导中完成全部核验并在 Review 界面确认
- **THEN** 系统以单事务创建 Scope、初始 Planning Cycle 与首个 Coordinator Session，且不存在新增的 Orca Run、Task 或 worktree

#### Scenario: 向导不收集预算与权限
- **WHEN** 用户完整走完初始化向导
- **THEN** 向导只核验 repository 与 worktree、Orca 能力与身份、Coordinator Model Configuration 与 tracker，不出现 Worker Profile、预算、依赖权限、Git 集成策略或风险的输入项

#### Scenario: 核验失败不产生部分状态
- **WHEN** 向导中的 Orca 能力核验失败
- **THEN** 系统停留在向导内指出失败项，且不写入 Scope 或 Planning Cycle 记录

#### Scenario: 确认前退出不留记录
- **WHEN** 用户在 Review 确认前的任何步骤退出向导
- **THEN** 仓库中不存在该仓库的新 Scope 记录，重新启动仍进入向导
