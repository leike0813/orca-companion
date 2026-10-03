## ADDED Requirements

### Requirement: Authoritative history paging and full original text

正式 TUI SHALL 经应用合同读取当前 Session 的完整已提交原文，元数据 keyset 页 SHALL 同时受条数及字节上限约束，正文 SHALL 按 UTF-8 完整字符边界作独立范围读取。新增消息和压缩 MUST NOT 移动旧游标；不得以深 OFFSET 或整体 Session 切片实现。PgUp/PgDn SHALL 浏览正文和历史，Ctrl+Home/Ctrl+End SHALL 有界到起点/最新，Esc 从回看返回最新；composer 草稿不变。工具详情仍默认折叠，完整保留结果可按范围读取。读取失败 SHALL 保留当前视窗并允许重读；切 Session 后迟到结果 MUST NOT 覆盖当前视窗。未加载/失败/缺失/空历史 SHALL 明确区分，读取不得触发业务动作。

#### Scenario: 全历史与巨大正文
- **WHEN** 用户翻阅超过旧 200 条窗口的历史或大于一次正文范围的中文混排消息/工具结果
- **THEN** 全部原文可通过有界页和范围连续读取，字符不丢失，composer 与定稿 continuous 层级保留

#### Scenario: 游标稳定与最早直达
- **WHEN** 取得历史页后新增消息或保存 Capsule，并使用旧游标或跳到起点
- **THEN** 旧边界保持稳定，起点直接取得附近内容，不遍历全部中间页

#### Scenario: 失败与切会话
- **WHEN** 读取失败或上一 Session 的读取在切换后才完成
- **THEN** 原位置与草稿保持，失败明确可重读，迟到内容不会进入新 Session，也不发送消息或恢复模型
