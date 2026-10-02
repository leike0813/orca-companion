# tui/input-protection Specification

## Purpose

定义用户输入在 TUI 进程之外的可恢复边界：草稿、粘贴载荷与待核验提交按 Scope、Session 与回答绑定持久保存，提交具有稳定身份，并能区分已受理、未发现、内容冲突与不可核验。

## Requirements

### Requirement: 每仓库 UI 输入持久化与隔离

系统 SHALL 为每个仓库使用独立的 UI 输入存储保存用户输入，且 SHALL NOT 把它写入 Coordinator checkpoint、Branch Coordination State 或任何业务授权队列。聊天草稿 SHALL 按 Coordination Scope 与 Coordinator Session 隔离；回答草稿 SHALL 按 Coordination Scope、Coordinator Session、InteractionId 与 expected revision 隔离。每条记录 SHALL 保存展开后的完整正文、光标位置与全部粘贴载荷，使重启后能完整恢复。系统 MUST NOT 把 UI 输入持久化当作业务权威事实。

#### Scenario: 重启后完整恢复多行中文与粘贴内容
- **WHEN** 用户在某 Session 输入多行中文并粘贴多段内容后重启 Companion
- **THEN** 该 Session 的草稿、光标与全部粘贴载荷完整恢复，未被截断或改写

#### Scenario: 不同 Session 与回答草稿互不影响
- **WHEN** 用户在 Session A 保存普通草稿，并在 Session B 为某个 Pending Interaction 保存回答草稿
- **THEN** 两条记录互相隔离，读取任一记录都不会返回另一条的内容

#### Scenario: 同一个交互不同 revision 的回答相互隔离
- **WHEN** 用户先为一个 expected revision 保存回答草稿，随后该交互 revision 变化
- **THEN** 旧 revision 的回答草稿仍可单独查看，且不会自动改绑到新 revision

### Requirement: 编辑合并保存与关键节点立即保存

连续编辑 SHALL 以约 250 ms 的合并窗口保存，该计时器 SHALL 由用户编辑触发；且 SHALL 在粘贴、切换 Session、退出回答模式以及正常退出前立即保存当前输入。界面 effect、渲染、resize 与组件重挂载 SHALL 只读取或查询，MUST NOT 触发持久写入、自动发送或任何业务动作。突然崩溃最多丢失合并窗口内最后一次未保存编辑。

#### Scenario: 连续编辑只落最后一次内容
- **WHEN** 用户在合并窗口内连续输入多个字符
- **THEN** 系统保存最终正文，且不因每次按键产生一条独立持久记录

#### Scenario: 粘贴立即保存
- **WHEN** 用户粘贴一段内容
- **THEN** 该内容在粘贴返回前已随草稿保存，且不等待合并窗口

#### Scenario: 重绘与 resize 不触发写入
- **WHEN** 界面因新事件重绘、终端 resize 或组件重挂载
- **THEN** 不产生新的持久写入或业务动作

#### Scenario: 载入既有输入不覆盖新编辑
- **WHEN** 界面异步载入某目标的已存草稿时用户已开始新的编辑
- **THEN** 载入结果的未修改版本 MUST NOT 覆盖用户新输入，当前输入保持不变

### Requirement: 提交快照、稳定身份与单活跃提交

普通消息与回答提交 SHALL 携带界面生成的稳定 `submissionId`，并在调用应用用例前先把完整提交快照（正文、粘贴展开内容、目标与回答绑定）原子保存。同一 Session 同时 SHALL 最多存在一条处于等待确认或不可核验的提交；连按提交 MUST NOT 产生重复请求。提交结果 SHALL 只结清原快照，MUST NOT 清掉后来编辑的输入或另一个 Session 的草稿。权威事实确认受理后 SHALL 删除该快照；明确拒绝或内容冲突的提交 SHALL 保留记录但释放等待位置。

#### Scenario: 连按提交只产生一次请求
- **WHEN** 用户在一次待确认提交未结清前连续按回车
- **THEN** 系统只提交一次，MUST NOT 生成第二条待确认提交

#### Scenario: 继续编辑不被旧提交结果清空
- **WHEN** 用户提交一条消息后立即输入下一条内容，原提交随后被受理
- **THEN** 界面只清空原提交快照，用户新输入的内容保持不变

#### Scenario: 提交快照保存失败时不发送
- **WHEN** 提交快照无法持久保存
- **THEN** 系统保留内存输入并提示失败，MUST NOT 调用发送

#### Scenario: 受理后清除快照而拒绝释放等待位
- **WHEN** 一次提交被权威事实确认受理，另一次提交被明确拒绝
- **THEN** 受理的提交快照被删除；被拒绝的提交记录保留供用户恢复或显式删除，同时释放该 Session 的等待位

#### Scenario: 已受理的清理不依赖界面渲染
- **WHEN** 重启后核验到一条待确认提交已被权威事实受理
- **THEN** 其持久记录由 Bootstrap 恢复流程或用户显式核验动作清除，MUST NOT 依赖 React 渲染或 effect

### Requirement: 权威提交核验

系统 SHALL 提供只读提交核验，按普通消息（coordinator Session、submissionId、正文）或回答（coordinator Session、submissionId、正文、InteractionId、expected revision）查询并返回已受理、未发现、内容冲突或不可核验。已受理 SHALL 附带对应权威引用。回答的权威引用 SHALL 由 InteractionId 与 submissionId 共同派生，因此问题被他人回答或关闭 MUST NOT 被当成本次回答成功。重启后系统 SHALL 先核验既有待确认提交，MUST NOT 自动重发、换身份重发或按时间清理未决提交。核验不可用时 SHALL 报告不可核验，MUST NOT 猜测为成功或失败。

#### Scenario: 同一身份内容不同的提交判为冲突
- **WHEN** 核验一个已提交过内容不同消息的 submissionId
- **THEN** 系统返回内容冲突，且不把它报告为本次成功

#### Scenario: 重启先核验而不自动重发
- **WHEN** 存在等待确认的提交时重启 Companion
- **THEN** 系统以原身份核验该提交，保留其未决状态，MUST NOT 自动再次发送

#### Scenario: 被他人回答的问题不算本次成功
- **WHEN** 待核验回答对应的 Pending Interaction 已被另一 submissionId 或外部动作解决
- **THEN** 核验不返回本次回答的已受理引用

#### Scenario: 核验能力缺失时如实报告
- **WHEN** 宿主未提供提交核验能力
- **THEN** 系统报告不可核验，MUST NOT 投影为已受理或已拒绝

### Requirement: 并发冲突、容量上限与恢复保护

并发写入 SHALL 以 CAS revision 判定；版本不匹配时 SHALL 保留双方内容交由用户选择，MUST NOT 静默覆盖或自动合并。冲突解决后 SHALL 以带备份的冲突记录保留另一版本，直到用户显式选择或删除；写入失败时 SHALL 保留内存输入并明确报告阻塞，MUST NOT 静默丢弃。删除后重建 MUST NOT 接受删除前的旧版本写入。每仓库 SHALL 以 32 MiB UTF-8 内容载荷与 256 条持久记录为起始双上限，草稿、冲突副本与待核验提交都计入；达到上限时 SHALL 保留既有记录与当前内存输入并提示显式清理，MUST NOT 按时间淘汰或静默丢弃。系统 SHALL 提供对不可读记录的重新核验入口。

#### Scenario: 两个连接并发写入不被静默覆盖
- **WHEN** 两个 SQLite 连接以同一 expected revision 写入同一目标
- **THEN** 只有一个写入成功，另一个收到冲突并保留自己的内容

#### Scenario: 删除后旧版本写入被拒绝
- **WHEN** 一条记录被删除后，一个持有删除前 revision 的写入到达
- **THEN** 该写入被拒绝，不重建被删除的内容

#### Scenario: 冲突解决保留另一版本
- **WHEN** 用户在一次 CAS 冲突中选择保留自己的内容
- **THEN** 被覆盖的另一版本作为冲突备份保留，可单独查看或删除

#### Scenario: 写入失败不丢内存输入
- **WHEN** 一次持久写入失败
- **THEN** 内存中的输入保留，界面显示明确阻塞原因，MUST NOT 静默丢弃或继续发送

#### Scenario: 容量满额保留当前输入
- **WHEN** 存储达到容量上限且用户继续编辑
- **THEN** 既有记录与当前内存输入保留，系统提示清理，MUST NOT 自动淘汰旧记录

### Requirement: 有界输入记录管理

系统 SHALL 在既有界面提供有界输入记录管理入口，列出当前 Scope 的草稿、冲突副本与待核验提交，并支持查看、恢复、选择与删除，以及重新核验既有提交。该入口 MUST NOT 成为通用状态存储管理平台；MUST NOT 使界面直接打开数据库、调用 Orca 或写入业务状态。

#### Scenario: 查看并恢复一条草稿
- **WHEN** 用户在记录管理中选中某条草稿并选择恢复
- **THEN** 该草稿成为对应目标的当前输入，原记录按选择更新

#### Scenario: 删除冲突副本
- **WHEN** 用户在记录管理中删除一条不再需要的冲突副本
- **THEN** 该记录被移除，其他草稿与待核验提交不受影响

#### Scenario: 重新核验未决提交
- **WHEN** 用户在记录管理中对一条核验不可用的提交触发重新核验
- **THEN** 系统以原身份重新查询，并按已受理、未发现、内容冲突或不可核验更新状态
