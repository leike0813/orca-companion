## ADDED Requirements

### Requirement: Authoritative ordinary input recall

普通发送历史 SHALL 仅来自当前 Session 已确认受理的普通用户消息，跨重启可读，回答 SHALL 不混入，MUST NOT 新建发送日志。空输入↑ SHALL 召回最近内容；仅在召回内容未修改且光标位于全文边界时↑↓继续浏览，越过最新 SHALL 恢复原完整草稿。Ctrl+R SHALL 独立搜索，↑↓选择更旧/更新匹配，Enter仅采用到草稿，之后再次Enter才提交。取消 SHALL 恢复正文、光标和粘贴范围；读取失败 SHALL 保留输入并允许重试，回填使用完整原文，不改历史。预览 MUST NOT 覆盖持久草稿，采用后的编辑/提交沿原输入保护管线。

#### Scenario: 普通历史与回答隔离
- **WHEN** 当前Session同时有普通消息、其他Session消息和回答，用户召回或搜索
- **THEN** 只有当前Session的普通消息出现，重新发送形成新的消息，不改写原条目

#### Scenario: 采用与发送及原草稿
- **WHEN** 用户持有粘贴块和中间光标草稿，Ctrl+R采用匹配或取消
- **THEN** 首次Enter只采用不执行/发送；取消精确恢复原全文/光标/块，后续明确提交仍受原快照和准入保护

#### Scenario: 上下召回与修改
- **WHEN** 空输入开始召回，继续浏览、越过最新或修改召回内容
- **THEN** 仅未修改且光标在边界时继续历史浏览，越过最新恢复原草稿，修改后方向键返回普通编辑

#### Scenario: 读取失败与迟到结果
- **WHEN** 读取历史失败，或切Session之后旧查询完成
- **THEN** 草稿不被清空或覆盖，失败可重试，旧结果不进入新输入目标
