## MODIFIED Requirements

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
