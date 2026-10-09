## Why

ledger-lab 的真实问候触发了 13 次失败模型轮次：生产装配遗漏可信配置绑定，失败后定时对账又重新生成同一消息。现有局部测试没有覆盖生产装配、跨轮停止和真实 CLI 链路，需要先稳定对话核心，再继续业务验收。

## What Changes

- 统一调试与协调模式的 LangGraph 循环驱动，请求前核验配置；内部失败持久停止，未结束轮次重启后等待明确恢复。
- 瞬时网络、429 与可重试 5xx 最多尝试三次；取消、输出超限、解析、上下文或落盘故障不自动重试。
- 新增 `ocp --debug [directory]`：独立持久会话、已有模型连接复用、有界只读目录/文件/搜索/Git diff 工具，不装配协调功能。
- 抽出共用 Ink transcript/composer、明确故障反馈、停止/重试意图和退出取消链；保留已批准布局、历史锚点和输入保护。
- 扩展生产宿主回归及 CLI/PTY/正式 SDK/本地 HTTP-SSE E2E，补有请求上限的真实 MiniMax验收。

## Capabilities

### New Capabilities

- `agent/debug-harness`: 独立目录和持久调试会话，共享真实对话核心及只读工具。

### Modified Capabilities

- `coordinator/session-runtime`: 可信配置装配、轮次状态、故障停止、重试与退出。
- `coordinator/wake-suspension`: 失败及未结束轮次不能被定时器、事件和重启自动恢复。
- `tui/planning-workspace`: 共用对话工作区、失败反馈、停止/重试入口。
- `tui/input-protection`: 非 Scope 调试目标隔离、同一输入保护管线。
- `tui/development-workbench`: 生产 CLI E2E 与隔离预览、真实 provider 验收的证据边界。

## Impact

直接前驱为已归档 `rework-coordinator-provider-configuration`，基线 HEAD `c988b89`，冻结 IC-04/11/12/13/14 接缝。此 change 是 active ledger-lab 剩余验收的解阻塞项，共享文件串行编辑，lab 业务验收继续保持未完成。

影响 application/workflow、checkpoint/UI adapters、两种 bootstrap 宿主及 CLI/TUI。复用现有依赖，不引入 DeepAgents、pi TUI 或 OpenTUI，不重设计 UI、不改变 Worker/执行授权。保留已有四个 doctor 诊断文件改动；既有会话、草稿和副作用身份不得删除、回填或重置。
