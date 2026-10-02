## MODIFIED Requirements

### Requirement: 常驻 transcript 与 composer 主视图

主视图 SHALL 固定包含顶栏、Coordinator transcript、composer 与状态行，且 transcript 与 composer 在任何终端宽度下 MUST NOT 被折叠或切换走。Transcript SHALL 只展示用户消息、Agent 回复与默认折叠的工具调用记录。composer SHALL 支持多行输入与提交流式回复，并 SHALL 严格区分命令与消息：以 `/` 开头的输入 MUST NOT 作为普通消息或回答发送；无法识别或格式错误的命令 SHALL 保留输入并给出结构化提示，MUST NOT 回退为发送。粘贴 SHALL 只把正文插入 composer 并立即保存，MUST NOT 触发发送或命令。系统 SHALL 提供 `Ctrl+P` Command Palette、`Ctrl+B` 切换 Sidebar、`Ctrl+G` Graph Inspector、`Esc` 逐层关闭 overlay 与 `Ctrl+C` 退出；Pause、Resume、Cancel、Session Picker、Event Drawer 与 Help SHALL 通过 Command Palette 暴露。composer 聚焦时普通字符 MUST NOT 触发全局命令，且系统 MUST NOT 提供用户自定义键位。

#### Scenario: 窄屏下主视图保持可见
- **WHEN** 终端宽度收窄到 Sidebar 无法并排显示的尺寸
- **THEN** Sidebar 折叠，transcript 与 composer 仍完整可见并可继续输入

#### Scenario: 工具调用默认折叠
- **WHEN** Coordinator 在一次回复中调用受控工具
- **THEN** transcript 显示该工具调用的折叠记录，展开后才显示细节

#### Scenario: composer 聚焦时普通字符不触发全局命令
- **WHEN** composer 处于聚焦状态，用户键入普通字符
- **THEN** 字符进入 composer 内容，不触发任何全局命令或 overlay

#### Scenario: Esc 逐层关闭
- **WHEN** 用户在一个 overlay 之上再打开另一个 overlay 后按下 `Esc`
- **THEN** 只有最上层 overlay 关闭，其余界面状态不变

#### Scenario: 未知命令不进入聊天
- **WHEN** 用户在普通消息模式输入以 `/` 开头且无法识别的命令并回车
- **THEN** 系统显示结构化命令提示并保留输入，MUST NOT 把它作为普通消息发送

#### Scenario: 多行命令格式错误保留输入
- **WHEN** 用户输入一个参数或行数不符合要求的多行命令并回车
- **THEN** 系统提示格式错误并保留输入，MUST NOT 发送该内容

#### Scenario: 粘贴只插入不发送
- **WHEN** 用户在 composer 中粘贴多行文本
- **THEN** 文本作为正文插入并立即保存，不触发发送、命令解析或清空输入
