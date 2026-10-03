## Why

#46 确认的第五批“待答联动”尚未接通：项目面板不能直接回答其他 Session 的问题，历史工具调用也没有权威问题状态和回答正文。第四批已归档，现在可以在冻结的历史读取与输入保护接缝上实现联动。

## What Changes

- Scope 与 Session 待答列表采用二十条 keyset 分页，精确详情绕过列表首屏；展示快照使用摘要和完整待答计数。
- 由已持久化工具调用的可信 operationId 定位 `ask_user` 问题，在原调用位置呈现状态、问题及回答，并支持原位展开。
- 用户明确选择跨 Session 问题时保存输入、切换并回答；Esc 保存后返回，成功且没有后来编辑时自动返回原入口。
- 保留现有回答提交、恢复、草稿隔离、历史锚点和缓存预算，并补齐竞态与真实 PTY 验收。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `coordinator/user-questions`：Scope 分页、精确读取、历史摘要及完整计数。
- `tui/session-interactions`：可信历史卡片与跨会话回答返回。
- `tui/planning-workspace`：项目待答分页与原位问题/回答阅读。

## Impact

直接前驱为已归档 `inspect-and-search-coordinator-history`，基线 HEAD 为 `69f0aa1781265bb7623cb4bbb3e8ae5722e72bce`，采用 predecessor-contract。影响 IC-03/11/12 的应用与 storage 查询、Bootstrap 接线、TUI reader、回答及项目面板、测试和交接文档。Coordination schema 15 仅增加 Scope 分页索引；UI 与 checkpoint schema 不变，不新增依赖。

边界为 M2 第五批，沿用六票定稿原型。不实现后续状态栏/Graph/初始化批次，不提交或归档本 change，不重新设计交互。
