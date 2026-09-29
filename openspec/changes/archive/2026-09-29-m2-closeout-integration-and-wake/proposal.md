## Why

M2 的真实 PTY 验收已通过，但收尾记录和当前代码揭示三处会误导后续执行的边界：部分 Git 步骤被当作完整集成、已集成节点仍显示等待集成、已受理的图补丁请求因缺少最终散文响应而被重复提交。收尾验收应以持久事实修正这些判定。

## What Changes

- 仅在当前 Work Package 的 push 操作已确定结算且被接受后判定集成完成；中途退出时沿原操作身份继续剩余步骤。
- 执行投影与调度读取同一份集成事实，使完成集成的节点成为 `accepted`，未完成的仍排队。
- `request_graph_patch` 已受理的工具结果持久化“本条工作已处理”事实；中断后不重提同一用户声明。拒绝和未知结果不消费工作。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `execution/git-integration`：完整集成的完成边界与中途恢复。
- `tui/execution-monitoring`：节点集成状态以完整集成事实投影。
- `coordinator/wake-suspension`：单次图补丁请求被受理后的消息消费与恢复。

## Impact

- 直接前驱：已归档的 `m2-deliver-execution-tui`；本 change 是 M2 收尾修复。
- 修改应用层集成判定、协调快照与执行投影、前台宿主、受控工具节点和 checkpoint 消息合同；沿用现有 SQLite、LangGraph、Vitest，不新增依赖或发布接口。
- 不涉及 Orca 私有接口、并行 Worker、后台运行或 Windows 支持；真实 Orca 验收只在隔离项目和专用身份中执行。
