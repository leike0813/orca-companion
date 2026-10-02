## Why

最近两批 TUI 强化已补齐输入保护、完整编辑和当前 Session 回答，但生产界面仍保留旧角色标题和 composer 外观，缺少与定稿原型逐项对照的验收。用户已选择先纠正当前聊天、输入与回答界面，并将尊重原型作为后续 TUI 工作的硬约束。

## What Changes

- 对齐 continuous 时间线的标记、色边、留白和紧凑工具记录，移除重复角色标题。
- 对齐 composer 的圆角边框、焦点色与信息层级，保留前驱完整编辑、粘贴块、原生光标和输入保护。
- 将当前 Session 底部回答面板与同一视觉规则对齐，保持精确回答绑定和 Esc 恢复。
- 建立定稿原型到生产界面的对照与三档真实终端画面验收，不复制原型的假数据、模拟光标或过时键位。
- 在 TUI 交接文档置顶原型硬约束，记录实施、验证、提交、归档和原型验收的独立进度，并由 AGENTS.md 提供必读入口。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `tui/planning-workspace`：continuous 呈现、定稿 composer 外观与生产画面对照验收。
- `tui/session-interactions`：当前 Session 回答面板的统一视觉层级与状态保真。

## Impact

直接前驱为 `complete-tui-editor`，基线采用 `predecessor-contract`。规划 HEAD 为 `c1964d4913343265d20c4076ff82c5643c6cd30e`；前驱实现目前在未提交工作区，7/7 任务完成，已补充复用实施证据的功能范围 verification PASS，尚未归档。新 change 可以现在规划，apply 前须核验前驱归档及同步主规格。

这是 M2 第二批之后、3A 之前的呈现纠偏项；#46 后续批次顺序不变。涉及 MOD-06、IC-12 展示接缝、现有预览和行为/PTY 测试，不改变 IC-11/13 应用端口、数据库 schema、依赖或业务状态机。历史分页/阅读、Markdown、搜索、跨 Session 回答、完整命令、项目页签、可配置状态栏及 adaptive 图仍由原定后续批次承接。
