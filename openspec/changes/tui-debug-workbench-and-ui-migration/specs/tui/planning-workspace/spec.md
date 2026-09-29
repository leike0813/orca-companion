## ADDED Requirements

### Requirement: 状态与焦点的可辨识视觉层级

前台 TUI SHALL 以一致的高对比样式区分当前焦点、选中项、成功、警告、错误与次要信息。关键状态 MUST 同时以文字或符号表达，MUST NOT 仅靠颜色区分；视觉调整 MUST NOT 改变现有输入、确认和回答绑定的语义。

#### Scenario: 彩色终端中切换选择
- **WHEN** 用户在 Session Picker 或 Model Picker 中移动焦点
- **THEN** 当前焦点具有可辨识的高对比标记，选中项及其状态仍可读

#### Scenario: 无彩色终端中的危险状态
- **WHEN** 终端不显示颜色且界面呈现 blocker 或危险操作确认
- **THEN** 用户仍能通过文字或符号识别状态和待确认动作，且 Enter 不会替代显式确认
