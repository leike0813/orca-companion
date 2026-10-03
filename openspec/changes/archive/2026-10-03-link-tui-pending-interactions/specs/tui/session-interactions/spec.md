## ADDED Requirements

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
