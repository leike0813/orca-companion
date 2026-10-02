## ADDED Requirements

### Requirement: 当前 Session 异步回答面板
Shift+Left、`/answer` 和 Palette SHALL 打开相同的当前 Session 底部面板，同时保留 transcript。面板 SHALL 有界读取问题正文与选项；Shift+Left/Right SHALL 切问题，Tab SHALL 切选项与自由输入，选项 Enter SHALL 直接以所选标签提交，自由输入 SHALL 走完整 composer。Esc SHALL 保存回答并恢复聊天全文、光标、粘贴块和阅读位置。新问题 SHALL NOT 自动打开面板或切 Session；Ctrl+A SHALL 只到行首。回答 SHALL 沿用 InteractionId、expected revision、稳定 submissionId 和单活跃提交。未知、过期和失败 SHALL 保留输入且不推进问题；受理 SHALL 只结清未再编辑的原输入。

#### Scenario: 选项直接回答
- **WHEN** 用户打开当前 Session 问题并在选项上按 Enter
- **THEN** 标签通过原回答管线提交，其他 Session 的问题与草稿不变

#### Scenario: 退出恢复聊天
- **WHEN** 用户在回答面板编辑后按 Esc
- **THEN** 回答保存，聊天正文、光标和阅读位置恢复

#### Scenario: 失败或后来编辑保留输入
- **WHEN** 回答被拒绝、不可核验或受理前用户继续编辑
- **THEN** 当前回答保留，不由旧结果清空或跳走
