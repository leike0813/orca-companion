## Why

现有五个 Worker Harness 之外，本机已有可使用中国区 MiniMax M Plan 的候选，用户也可提供 Antigravity 订阅登录。下一期接入需要以真实运行证据扩大选择，同时保留精确会话、恢复和只读隔离边界。

## What Changes

- 逐项评估 Qwen Code、新版 Kimi Code、Antigravity、Command Code、MiniMax Code、Kilo、Hermes，以及官方 Droid、Prime Agent、Cline、Goose、Crush、Vibe、Autohand、Copilot、CodeBuddy、Grok、Cursor CLI；只有通过完整能力与真实验收的候选才注册。
- 固定 MiniMax-M3.1-Flash-Preview；Antigravity 使用用户登录后的 gemini-3.8-flash-medium。用户级安装和追加配置保留原默认项与登录态。
- 将 transcript 身份复核和 Recovery 读取配方归还 WorkerHarness adapter，复用现有运行与恢复流程。
- 修正真实验收矩阵的旧模型、统一协议和 CLI 路径假设，记录各候选版本、能力、测试与排除证据。

## Capabilities

### New Capabilities

无；复用已有 Worker Harness capability。

### Modified Capabilities

- `workers/harness-adapters`：扩展端口归属、候选纳入与精确原生能力验证合同。

## Impact

直接前驱为已归档 remove-worker-credential-management；采用 predecessor-contract，规划 HEAD 1a3eaf7577a3fe62af3e8a35ba5451080ac34e47。影响 Worker adapter、bootstrap、原生模型选择、doctor、现有真实验收及当前合同文档。保留 schema 5、Manifest v4、SQLite、预算与角色生命周期。与 active ledger-lab 串行编辑共享文件；不修改其业务工件、不新增项目依赖、不提交、不自动归档。用户另已批准 Controller 消息/恢复接线修复与上游官方 main 的 fast-forward 更新；不编辑上游源码。支持范围限 Ubuntu。
