## Why

`m2-deliver-execution-tui` 已有执行态投影，但生产路径没有把授权、角色派发、Delivery 结算、集成和 Finalizer 串成可恢复闭环；Resume 与 Cancel 仍使用拒绝或不可核验的占位端口。真实 PTY 的执行验收因此无法开始。

## What Changes

- 在前台 Controller 接通规划到执行的授权切换，并由唯一 Execution Coordination Lease 持有者驱动并发上限为 1 的 Work Package 生命周期。
- 复用现有物化、规格接纳、Delivery 结算、Validator 修复、Recovery、Git 集成与 Finalizer 用例；补齐它们所需的可信事实装配和缺失的受控 adapter。
- 启动、Resume 与 Cancel 分别接通执行期对账和 Worker 停止；不确定结果保持原 OperationId、阻塞受影响 lane，界面只消费已提交事实。
- 在显式隔离的项目与专用身份中完成执行闭环验证，为 `m2-deliver-execution-tui` 保留的 5.2/5.3 真实 PTY 验收解除阻塞。

## Capabilities

### New Capabilities

- `coordinator/foreground-execution-runtime`: 前台执行宿主的授权交接、串行推进、恢复、控制和终态生产接线。

### Modified Capabilities

无；执行用例的行为仍以现有 `execution/*`、`coordination/*` 与 `planning/execution-authorization` 主规格为准。

## Impact

- **直接前驱**：已归档的 `m2-deliver-planning-tui`。`m2-deliver-execution-tui` 是并行活跃的执行界面 change；它保留 5.2/5.3，待本 change 接线完成后验收。两者共享文件在实施时串行编辑、按接缝核验。
- **里程碑**：补齐 M2 真实 PTY 路径所需的 M1 执行闭环接线；Graph Patch、Specification Revision 与 Replanning 的生产接线另行验收。
- **代码与合同**：主要涉及 `src/bootstrap/`、`src/application/execution/`、`src/workflow/coordinator/`、`src/adapters/{agents,git,orca-cli}/`，并按新增生产事实更新 IC-05/07/08/09/11 与文档。复用既有 TUI 投影，不增加页面或用户控制粒度。
- **依赖**：不新增 npm 依赖；不改 `references/orca`。不交付后台运行、远程 attach、无人值守、并行执行、发布、部署或 Windows 支持。
