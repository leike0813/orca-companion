# tui/session-interactions Specification

## Purpose
定义多 Coordinator Session 的选择与焦点约束、Pending Interaction 回答绑定，以及会话维护、模型配置切换与 Route Planning Handoff 在既有 TUI 中的入口与降级状态。

## Requirements

### Requirement: Session Picker、焦点约束与 Pending Interaction 回答绑定

系统 SHALL 通过 Session Picker 在多个 Coordinator Session 之间切换，并 SHALL 在进程内保留上次选择；无既有选择时 SHALL 优先选择存在 Pending Interaction 的 Session，否则选择最近活动的 Session。新事件 SHALL 只增加未读或待处理标记，MUST NOT 自动切换 transcript、抢占 composer 或改变 Scope 级 Execution Graph。每个 Session 的 composer 草稿与滚动位置 SHALL 独立保存，且草稿 SHALL 跨进程重启持久恢复，而不是只存在于进程内。Pending Interaction SHALL 以绑定 interaction ID 与 expected revision 的内联卡片呈现；用户进入回答模式后 composer SHALL 绑定该 interaction ID、expected revision 与界面生成的稳定 submissionId，普通聊天消息 MUST NOT 满足待答问题，expected revision 过期时系统 SHALL 拒绝提交并提示重新读取。

#### Scenario: 启动时优先待答 Session
- **WHEN** 用户在本次进程内还没有选择记录，且存在一个带 Pending Interaction 的 Session
- **THEN** Session Picker 默认选中该 Session

#### Scenario: 新事件不抢占焦点
- **WHEN** 用户正在向当前 Session 输入消息时另一 Session 收到新事件
- **THEN** 当前 transcript 与 composer 焦点不变，另一 Session 只增加未读标记

#### Scenario: 切换后保留草稿
- **WHEN** 用户在 Session A 输入未提交草稿后切换到 Session B 再切回 A
- **THEN** Session A 的 composer 草稿与滚动位置保持不变

#### Scenario: 重启后恢复草稿
- **WHEN** 用户在某 Session 输入未提交草稿后退出并重新启动 Companion
- **THEN** 该 Session 的 composer 草稿恢复为退出前的完整内容

#### Scenario: 普通消息不满足待答问题
- **WHEN** 用户以普通消息模式向含 Pending Interaction 的 Session 发送文本
- **THEN** 该消息不解析为回答，Pending Interaction 保持待答

#### Scenario: 过期 revision 的回答被拒绝
- **WHEN** 用户提交回答时该 Pending Interaction 的 expected revision 已过期
- **THEN** 系统拒绝提交并提示当前 revision 已变化，且保留回答输入

#### Scenario: 有效回答完成交互
- **WHEN** 用户以绑定 interaction ID、当前 expected revision 与稳定 submissionId 的模式提交回答
- **THEN** 系统接受该回答并记录对应 Pending Interaction 已解决

### Requirement: 会话维护、模型配置与 Route Planning Handoff

系统 SHALL 在既有主视图与 Command Palette 提供 `/compact` 与 Model Picker，并 SHALL 支持 Route Planning Handoff 的 prepare、review 与 cutover；MUST NOT 为此新增应用页面。`compaction_degraded`、`context_exhausted`、handoff review 与 `awaiting_user_prompt` SHALL 由 Controller 投影在既有界面中可见。模型选择 SHALL 仅在 Coordinator Session 已 suspended 且无模型相关操作在途时可提交，系统 MUST NOT 自动 fallback。`compaction_degraded` 可以建议 handoff，但 MUST NOT 自动创建或切换 Session。Source checkpoint 不可恢复或无法生成可移植 Coordinator Context Capsule 时，Handoff SHALL fail closed 并保持 Scope blocked。宿主未提供面向 Session 的压缩请求能力时，`/compact` SHALL 以结构化拒绝 fail closed 并显示 blocker，MUST NOT 静默无操作或伪造压缩结果。

#### Scenario: 手动 compact 与降级状态可见
- **WHEN** 用户在 Command Palette 触发 `/compact`，或 Controller 投影出 `compaction_degraded`
- **THEN** 界面显示 compact 结果，并在降级时持续显示 `compaction_degraded` 的非阻塞告警

#### Scenario: 压缩入口不可用时 fail closed
- **WHEN** 宿主没有提供压缩请求能力而用户触发 `/compact`
- **THEN** 界面显示结构化 blocker，不显示成功，也不伪造压缩结果

#### Scenario: 上下文耗尽停止新调用
- **WHEN** Controller 投影出 `context_exhausted`
- **THEN** 界面显示 `context_exhausted`，并禁用该 Session 的 composer 提交，不再由界面发起新的模型调用

#### Scenario: 模型切换仅在挂起时提交
- **WHEN** Coordinator Session 正在运行模型或 compact，用户通过 Model Picker 选择新的 Coordinator Model Configuration
- **THEN** 系统拒绝或排队该选择，不中断进行中的模型或 tool step，也不自动 fallback

#### Scenario: Handoff 审阅与激活门
- **WHEN** 用户发起 Route Planning Handoff 并在 Review 界面确认
- **THEN** 界面展示 Capsule 摘要、Target 与待转移责任；cutover 后自动选中 Target，composer 指向 Target，且 Target 处于 `awaiting_user_prompt` 直到用户发送下一条普通 Prompt

#### Scenario: Handoff 灾难路径 fail closed
- **WHEN** Source checkpoint 不可恢复或必要 Coordinator Context Capsule 无法生成
- **THEN** 系统不创建替代 Coordinator Session、不转移 Ticket Claim，Scope 保持 blocked 并显示该 blocker

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

### Requirement: 跨 Session 回答与明确返回
用户明确选择 Scope 待答问题时 SHALL 先保存输入、核验精确 owner/revision，再切换到所属 Session 的原回答面板。系统 SHALL 保留单次返回上下文，包括原 Session、阅读锚点、展开模式、项目栏目、所选项、滚动及焦点，草稿 SHALL 沿用原输入存储。Esc 保存回答后 SHALL 返回原入口；当前提交确定受理且原输入没有后来编辑时 SHALL 自动返回。未知、拒绝、保存失败或后来编辑 SHALL 保留输入并保持回答位置。显式切 Session SHALL 使旧返回上下文失效，迟到结果只结算原提交。原列表所选问题消失时 SHALL 显示当前状态，不自动选下一题。Ctrl+R SHALL 保持普通输入历史用途。

#### Scenario: 保存退出和成功返回
- **WHEN** 从 Session A 的项目待答栏目选择 Session B 的问题，编辑后 Esc 或确定提交成功
- **THEN** 保存后恢复 A 的栏目、所选项、阅读位置、全文、光标与粘贴块，B 的回答仍由原管线保存或结算

#### Scenario: 后来编辑与迟到结果
- **WHEN** 回答在途时继续编辑或显式切换 Session，随后原结果受理
- **THEN** 后来输入保留，界面不跳回旧入口，原 submission 独立结算

#### Scenario: 核验或保存失败
- **WHEN** owner/revision 已变化、记录缺失或输入保存失败
- **THEN** 不进入错误问题、不发送回答、不丢弃输入，并显示可重读的状态

### Requirement: 历史问题卡片原位阅读
原提问调用处 SHALL 显示紧凑问题摘要及真实状态，回答后 SHALL 显示回答摘要；用户 SHALL 能原位展开完整问题及回答，并从开放问题进入相同的绑定回答入口。阅读 SHALL 沿用既有有界正文 reader 与稳定来源锚点。新问题和其他 Session 事件 SHALL NOT 抢焦点或改变阅读位置。

#### Scenario: 回答前后原位阅读
- **WHEN** 用户翻到原提问、展开问题，并在回答后刷新或 resize
- **THEN** 同一调用处保留权威问题/回答，锚点绑定原来源版本与原文偏移，正文不复制到事件或 checkpoint

### Requirement: 精确选择与语义审阅
Session、现有模型及交接接收方选择 SHALL 支持独立字面搜索，并按对象身份保持选择。模型查询与切换 SHALL 绑定调用时的 Session。交接 SHALL 使用本次 prepare 的精确 ID，确认/取消 SHALL 绑定用户审阅的 revision；授权 SHALL 保留原 fingerprint/revision。审阅 SHALL 消费可信语义栏目并有界滚动，默认返回；过期内容 SHALL 要求重新读取与明确确认，MUST NOT 自动批准更新内容。

#### Scenario: 多条交接记录
- **WHEN** Scope 存在另一待审阅交接且用户 prepare 新交接
- **THEN** 只审阅本次返回 ID 的提案，Source/Target 与责任真实，不能取首个候选替代

#### Scenario: 审阅期间内容变更
- **WHEN** 授权 fingerprint、交接 revision 或目标归属发生变化后用户确认
- **THEN** 原确认被拒绝，保留审阅入口并明确要求重读，不偷换批准对象

#### Scenario: 非责任 Session 的模型目录
- **WHEN** 用户为明确选中的 Coordinator Session 打开现有模型目录并切换
- **THEN** 当前配置、准入和结果均属于该 Session，不按 Scope 默认责任 Session 解释
