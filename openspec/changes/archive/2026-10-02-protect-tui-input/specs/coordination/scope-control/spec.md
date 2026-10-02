## MODIFIED Requirements

### Requirement: ControllerService 统一界面层的查询、命令与事件接缝

CLI 与 TUI SHALL 仅通过 `ControllerService` 获取运行时校验后的只读快照、订阅语义事件，以及提交 Session 消息、手动 compact、Coordinator Model Configuration 切换、Planning Handoff、Pause/Resume/Cancel、Execution Handoff、Pending Interaction 回答与只读提交核验；façade SHALL 只委派到对应既有应用用例，MUST NOT 直接打开 store、调用 Orca adapter 或拥有状态转换。普通 Session 消息提交 SHALL 必填界面生成的稳定 `submissionId`，并对同一身份但内容不同的提交返回结构化冲突。Pending Interaction 回答 SHALL 同时绑定 interaction ID、expected revision 与稳定 `submissionId`，revision 过期时 SHALL 拒绝且不把普通聊天当作回答。只读提交核验 SHALL 返回已受理（含权威引用）、未发现、内容冲突或不可核验；宿主未提供该能力时 SHALL 报告不可核验，MUST NOT 猜测成功或失败。Scope 初始化 SHALL 复用既有 `initializeCoordinationScope`，不得在 façade 中重写创建规则。

#### Scenario: 过期的 Pending Interaction 回答被拒绝
- **WHEN** 界面通过 ControllerService 提交 interaction ID 正确但 expected revision 已过期的回答
- **THEN** 服务拒绝该回答，Pending Interaction 保持未解决，且不产生 Orca mutation

#### Scenario: 普通消息必填稳定提交身份
- **WHEN** 界面提交普通 Session 消息
- **THEN** 提交携带稳定 `submissionId`，并以该身份落盘与核验；缺失时被结构化拒绝

#### Scenario: 只读提交核验区分四种结果
- **WHEN** 界面查询一条待核验提交
- **THEN** 服务返回已受理（含权威引用）、未发现、内容冲突或不可核验之一，不猜测结果

#### Scenario: 订阅者只收到语义事件
- **WHEN** store 或 backend 产生状态变化、keepalive 与诊断输出
- **THEN** ControllerService 只发布可投影的语义事件，keepalive 与诊断噪声不进入界面事件流
