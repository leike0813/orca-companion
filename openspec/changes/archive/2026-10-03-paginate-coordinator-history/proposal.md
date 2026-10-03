## Why

#37 地图的 #46 第三批 3A 要求正式读取完整历史。当前 checkpoint 用一份 Session JSON 保存所有消息、模型响应和 Wake Batch，普通追加和恢复反复处理全部历史；生产 transcript 仅取末尾 200 条且忽略游标。

## What Changes

- **BREAKING**：IC-04 改用稳定身份关联的增量权威记录，正文只保存一次；消息与 Wake、响应与调用、工具结果及消费关系在短事务中提交。
- 改造全部生产消费者，按控制元数据、有效上下文、精确工具恢复和待处理来源读取，保留原子性、幂等、压缩与恢复身份。
- IC-11/12 提供条数和字节双限的稳定 keyset 页与 UTF-8 正文范围；正式 TUI 能翻阅全部原文，读取失败和迟到结果不破坏输入。
- 直接前驱为已归档 `align-tui-with-approved-prototypes`；消费 `complete-tui-editor` 的 IC-13。依 #46，本次不包含 3B 局部虚拟视窗/Markdown/流式预算、第四批搜索与活动、后续跨 Session 回答及配置功能。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `coordinator/session-runtime`：增量关联提交与精确恢复。
- `coordinator/context-maintenance`：仅读取有效历史，压缩不删除原文。
- `tui/planning-workspace`：真实 keyset 与正文范围阅读。

## Impact

MOD-02/03/04/06/07、IC-04/11/12；storage/application/workflow/bootstrap/TUI 的实际生产调用与测试、架构/接口/交接文档。保持 LangGraph SqliteSaver、现有数据库驱动和全部依赖版本。不改 Orca/Worker、业务权限、Scope 状态机和 IC-13 存储。按首版合同设计，旧整体记录格式明确拒绝，不建立迁移或双格式路径。
