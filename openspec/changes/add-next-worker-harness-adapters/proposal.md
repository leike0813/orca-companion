# 下一批 Worker Harness 接入

## Why

前一轮已纳入 Command Code 与 Qwen Code。本轮补齐 Antigravity CLI、Kilo Code、Kimi Code、Hermes、Cline、Meta Muse Code CLI 与 Cursor Agent，优先使用现有订阅完成真实验收。此前部分候选缺少逐次报告 loader；用户已允许独立安装可卸载的原生报告插件，Worker 启动仍不管理认证、provider 或用户默认配置。

## What Changes

- 七家实现现有 WorkerHarness 契约：公开终端内启动真实原生 TUI、精确 Session 绑定、按 ID 恢复、transcript 覆盖、Recovery 与原生模型目录；Antigravity 在本项目 launcher 中过滤重复输入协议设置。
- 新增独立报告插件 install/status/uninstall 接入步骤，仅维护 Companion 自有条目；普通原生启动无动作。
- Antigravity 使用已登录订阅与 gemini-3.8-flash-medium；Kilo/Kimi/Hermes/Cline 使用中国 MiniMax M Plan 的 MiniMax-M3.1-Flash-Preview。
- Muse/Cursor 完成实现和离线验证，明确后续真实验收任务，验收前不注册。其他候选同样只有完整真实验收通过才注册。
- 持续存证并回收不用的测试终端/worktree，更新当前支持与失败原因。
- 按候选独立收敛探索，优先完成有希望的完整接入。原生能力缺口经可复核调查仍无法解决时，可记录阻塞证据、恢复验收前置条件并延期；延期不阻塞其他候选，也不作为真实验收通过。

## Capabilities

### Modified Capabilities

- `workers/harness-adapters`: 独立报告插件安装、下一批候选的精确 Session 与分级验收。

## Impact

直接前驱为已归档 `add-testable-worker-harness-adapters`，基线 HEAD `13b203f62bbb68a60456c5acd7d28e4c54c625a4`。复用 IC-07/09/14 与现有 launcher、bwrap、Controller 和测试矩阵；不改存储/schema、授权语义或 #52 TUI 布局。不修改 ledger-lab 或上游私有源码、不提交或自动归档。
