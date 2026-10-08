## MODIFIED Requirements

### Requirement: 前台入口与 TTY 门禁

`ocp [repository-path]` SHALL 启动前台 TUI；`ocp status [--json]` 与 `ocp doctor` SHALL 保持无 TTY 可运行。系统 SHALL 提供 `orca-companion` 作为等价长入口，两者的参数、行为与退出状态 SHALL 相同，帮助 SHALL 展示短入口及长别名。系统 MUST NOT 提供 `run`、`resume` 或 `tui` 子命令。启动 TUI 前系统 SHALL 同时检查 stdin 与 stdout 的 TTY 状态，任一无 TTY 时 MUST 在挂载 Ink 之前以非零状态拒绝，且 MUST NOT 出现 raw-mode 报错但退出码为零的结果。

#### Scenario: 无 TTY 时启动 TUI 被拒绝

- **WHEN** 用户在没有 TTY 的环境（管道或 CI）运行 `ocp` 或 `orca-companion`
- **THEN** 进程在挂载 Ink 前以非零状态退出，诊断写入 stderr，且 stdout 不含渲染帧

#### Scenario: 一次性命令在无 TTY 环境保持可用

- **WHEN** 用户在没有 TTY 的环境运行任一入口的 `status --json`
- **THEN** 命令以零状态退出，stdout 输出可解析的 JSON 快照，诊断只写 stderr

#### Scenario: 不存在的子命令被拒绝

- **WHEN** 用户运行任一入口的 `resume`
- **THEN** 命令以非零状态拒绝该子命令，并指出受支持的入口

#### Scenario: 两个入口等价

- **WHEN** 用户通过 `ocp` 与 `orca-companion` 分别调用相同参数
- **THEN** 两者 SHALL 进入相同的 CLI 行为且返回相同退出状态，不产生按名称区分的协调流程
