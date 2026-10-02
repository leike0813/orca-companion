## ADDED Requirements

### Requirement: 当前 Session 回答面板的定稿视觉层级

当前 Session 回答面板 SHALL 位于原输入区位置并保留 transcript；问题、进度、选项与自由输入 SHALL 沿用定稿 composer 和既定选择组件的边框、焦点、选中态及次要信息规则。选项焦点 SHALL 具有文字或符号标记，并在彩色终端使用高对比选中态；说明与操作提示 SHALL 有界呈现，不挤掉当前问题或输入。呈现调整 SHALL 保留 owner Session、InteractionId、expected revision、稳定 submissionId 和聊天/回答草稿隔离；新问题 MUST NOT 自动打开面板或抢焦点，未知、拒绝或过期结果 MUST NOT 被显示为回答成功。

#### Scenario: 选项和自由回答保持统一视觉
- **WHEN** 用户进入当前 Session 的回答面板，用 Tab 切换选项与自由输入
- **THEN** 问题和输入保持同一视觉层级，当前选项具有明确选中标记，自由输入使用定稿输入框及完整编辑能力，提交仍指向原问题和 revision

#### Scenario: Esc 返回恢复原聊天
- **WHEN** 用户在回答面板编辑后按 Esc 返回聊天
- **THEN** 回答草稿保存，原聊天全文、光标和粘贴块恢复，焦点回到原输入区，不新增提交或切换 Session

#### Scenario: 未确定状态保持真实含义
- **WHEN** 回答被拒绝、revision 过期或结果未知，或者新问题在用户输入时到达
- **THEN** 失败或未确定状态在彩色和无色环境都清楚可读，原输入与绑定保持，不显示成功、不跳题、不抢焦点
