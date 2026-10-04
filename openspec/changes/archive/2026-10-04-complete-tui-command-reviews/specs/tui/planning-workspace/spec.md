## ADDED Requirements

### Requirement: 可搜索同源命令目录
Palette、slash、快捷键和帮助 SHALL 共用稳定命令身份、展示定义及同一操作 handler。Palette SHALL 按名称、中文说明、别名和菜单路径字面搜索，支持直达子项；查询 SHALL 独立于 composer，列表 SHALL 有界且不可用项可发现。真实准入 SHALL 在调用前重验。

#### Scenario: 搜索子项与取消
- **WHEN** 用户从含中文与粘贴块的草稿打开 Palette，搜索 ASCII 或状态栏并取消
- **THEN** 匹配子项可直接定位，不可用原因与无匹配区分，原正文、光标、粘贴块及阅读位置保持

#### Scenario: 相同操作的不同入口
- **WHEN** 用户分别从 Palette、slash 和固定快捷键调用同一操作
- **THEN** 目标、真实准入、handler 和原确认路径一致，查询及候选采用不产生业务动作

### Requirement: 命令结果与页面返回绑定
命令 SHALL 区分打开界面、accepted、rejected 与 unknown；accepted MUST NOT 表示业务完成。slash SHALL 只在确定成功且原输入未被后来编辑时结清对应命令输入；失败、unknown、读取或保存失败 SHALL 保留输入。子页返回 SHALL 保留原入口查询、选择、栏目、Session、问题绑定、草稿和来源锚点；迟到结果 MUST NOT 抢焦点或覆盖新输入。

#### Scenario: 拒绝与等待中编辑
- **WHEN** compact 被拒绝或 unknown，或者等待时用户继续编辑并切换 Session
- **THEN** 原输入与结果归属保持，不清新稿、不重新打开旧页、不切换回旧 Session

#### Scenario: 多级搜索返回
- **WHEN** 从 Palette 查询进入 Session 或模型子页，再逐层 Esc
- **THEN** 恢复原搜索及对象选择，最终回原输入/阅读位置，不产生消息或回答提交
