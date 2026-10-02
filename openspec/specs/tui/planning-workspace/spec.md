# tui/planning-workspace Specification

## Purpose
定义 Route Planning 前台工作区的常驻主视图、响应式辅助栏、信息分层与终端渲染保真要求。

## Requirements

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

### Requirement: 信息分层

Scope 状态、预算、执行图、Worker 与 attention 的当前投影 SHALL 只出现在 Sidebar；Worker 生命周期、验证、授权、暂停与恢复等语义事件 SHALL 只进入 Event Drawer；keepalive、轮询超时、重复事件与无变化对账 MUST NOT 进入用户可见时间线。用户可见故障 SHALL 投影为明确 blocker 或状态。

#### Scenario: 维护噪声不进入用户时间线
- **WHEN** Controller 在 Coordinator Session 挂起期间执行一次保活调用
- **THEN** transcript 与 Event Drawer 均不新增该保活的条目

#### Scenario: 语义事件进入 Event Drawer
- **WHEN** 一个 Worker Task 完成验证并被接受
- **THEN** Event Drawer 新增对应语义事件，transcript 不被改写

### Requirement: 三态 Sidebar 与渲染保真

Sidebar SHALL 提供完整、紧凑与折叠三态，宽度 SHALL 只规定允许的最高密度。状态变化 MUST NOT 强制展开 Sidebar；终端过窄时 Sidebar SHALL 折叠，`Ctrl+G` MUST NOT 用 overlay 遮挡主视图，只提示扩宽终端。中文、中英文混排的 transcript 与 composer 内容 SHALL 在 resize 后保持正确显示宽度与边框对齐，Graph 标题 SHALL 按显示宽度裁切。动态效果 SHALL 只用于模型 spinner、节点状态短暂高亮与一次性 attention。

#### Scenario: resize 后宽字符不失配
- **WHEN** 含中英文混排内容的界面收到窗口尺寸变化
- **THEN** 文本按显示宽度重新换行与裁切，边框保持对齐且无残留字符

#### Scenario: 用户折叠后状态变化不强制展开
- **WHEN** 用户用 `Ctrl+B` 将 Sidebar 折叠为折叠态后出现新的待处理交互
- **THEN** Sidebar 保持折叠，仅出现一次性 attention 标记

#### Scenario: 终端过窄时不遮挡主视图
- **WHEN** 用户在终端过窄的状态按下 `Ctrl+G`
- **THEN** 系统提示扩宽终端，transcript 与 composer 保持可见

### Requirement: 状态与焦点的可辨识视觉层级
前台 TUI SHALL 以一致的高对比样式区分当前焦点、选中项、成功、警告、错误与次要信息。关键状态 MUST 同时以文字或符号表达，MUST NOT 仅靠颜色区分；视觉调整 MUST NOT 改变现有输入、确认和回答绑定的语义。

#### Scenario: 彩色终端中切换选择
- **WHEN** 用户在 Session Picker 或 Model Picker 中移动焦点
- **THEN** 当前焦点具有可辨识的高对比标记，选中项及其状态仍可读

#### Scenario: 无彩色终端中的危险状态
- **WHEN** 终端不显示颜色且界面呈现 blocker 或危险操作确认
- **THEN** 用户仍能通过文字或符号识别状态和待确认动作，且 Enter 不会替代显式确认
