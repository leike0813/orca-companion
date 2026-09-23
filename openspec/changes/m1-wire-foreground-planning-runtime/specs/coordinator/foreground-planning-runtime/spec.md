## Purpose

定义一个前台 Companion 进程如何从用户批准的项目配置建立可恢复的规划 Session，并把受控用户意图、模型工具、语义事件和现有应用用例接成真正可用的规划入口。

## ADDED Requirements

### Requirement: Versioned project configuration and exact Scope binding

Companion SHALL 从版本化项目配置读取可选的 Coordinator Model Configuration、默认配置引用、tracker 地图引用及有限的规划写入权限和预算；配置 SHALL 只包含凭据引用，不保存凭据值。配置缺失、无效、绑定的模型或 tracker 不可用时，初始化与模型恢复 SHALL 明确拒绝。Home SHALL 只恢复与当前 Git repository、完整 branch ref、用户登记的 canonical worktree 精确匹配的 Scope。

#### Scenario: 当前分支没有匹配 Scope
- **WHEN** 同一 Git common dir 中存在其他 branch ref 的 Scope
- **THEN** Home SHALL 进入当前分支的初始化向导，SHALL NOT 自动恢复其他 Scope

#### Scenario: 配置不可用
- **WHEN** 配置缺失、schema 无效或登记的模型引用无法解析
- **THEN** 前台运行 SHALL 给出可诊断拒绝，SHALL NOT 选择任意已安装模型或隐式创建 Scope

### Requirement: Foreground Runtime owns planning commands

前台进程 SHALL 为选中的 Coordinator Session 取得并续约 Runtime Lease，在每次状态写入与副作用前核验 fencing；它 SHALL 通过同一 Controller 入口处理用户消息、待答交互、手动压缩、模型配置切换及规划交接。界面 SHALL 只提交意图并读取快照、transcript 与事件。退出 SHALL 关闭当前进程资源，SHALL NOT 隐式暂停或取消 Scope。

#### Scenario: 租约失效
- **WHEN** 前台 Runtime 续约失败或被更高 generation 取代
- **THEN** 该进程 SHALL 停止模型调用和写入，向界面显示 blocker，SHALL NOT 用新身份重试当前动作

#### Scenario: 渲染不触发动作
- **WHEN** TUI 重绘、resize 或切换选中 Session
- **THEN** SHALL NOT 因这些操作启动模型、派发 Worker 或写入协调状态

#### Scenario: 回答保留正文并绑定交互
- **WHEN** 用户针对开放的 Pending Interaction 提交正文、interaction ID 与 expected revision
- **THEN** 回答正文和解决状态 SHALL 一起持久化；revision 过期时 SHALL 零写入且保留界面草稿

### Requirement: Session-owned semantic events

Controller SHALL 发布带 Scope 与可选 Session 归属的语义事件，覆盖用户消息接受、模型回合完成、工具结果、交互与交接状态变化；噪声 SHALL 不进入事件流。Session 事件 SHALL 只更新对应 Session 的未读状态，不抢占当前 transcript 或 composer。

#### Scenario: 非当前 Session 收到结果
- **WHEN** 后台对账使另一个 Session 产生语义事件
- **THEN** 当前选择 SHALL 保持不变，另一个 Session SHALL 出现未读标记

### Requirement: Planning handoff uses authoritative inputs

规划交接准备 SHALL 从当前 tracker/map、候选计划或图、Session registry 与源 Session 的可移植 Capsule 读取真实引用；Target SHALL 由用户明确选择。缺少可移植 Capsule、Source checkpoint 不可恢复或提案 revision 已过期时 SHALL 拒绝 cutover，SHALL NOT 激活 Target。

#### Scenario: Capsule 不能生成
- **WHEN** 用户确认交接而源 Session 的已提交历史不能生成可移植 Capsule
- **THEN** SHALL 保留 Source 的规划责任，并显示可诊断 blocker
