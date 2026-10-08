## MODIFIED Requirements

### Requirement: Coordinator Model Configuration injects a verified installed chat model

Coordinator SHALL 从用户批准的完整配置快照解析内置固定协议 chat model，并直接调用指定 Provider。凭据 SHALL 只从用户级 CredentialStore 按精确引用解析。创建 Session、启动及显式切换之前 SHALL 核验文本、流式、实际工具调用与结果续接、取消及可用 usage；必需能力缺失 SHALL 拒绝，MUST NOT 自动换协议、模型或凭据。

#### Scenario: 配置或凭据不可用
- **WHEN** 必需 adapter、配置或凭据不可用
- **THEN** 启动明确失败并保留原配置，不使用其它模型或环境认证

#### Scenario: 模型调用不经过 Companion 代理
- **WHEN** Coordinator 调用模型
- **THEN** chat model 直接调用配置 Provider，秘密不进入协调记录

#### Scenario: 核验通过后才建立 Session
- **WHEN** 文本、流式、工具及续接、取消和 usage 全部核验通过
- **THEN** 才建立 Session 或应用新模型；任何失败保留原绑定

#### Scenario: 配置的集成不可用时拒绝启动
- **WHEN** 配置协议无可用内置 adapter
- **THEN** 启动拒绝，不更换协议或模型

#### Scenario: 缺少 tool calling 时拒绝启动
- **WHEN** 未取得真实非空工具调用或工具结果续接失败
- **THEN** 必需能力核验失败，不能建立 Session

#### Scenario: 切换也核验全部能力
- **WHEN** 用户明确应用新配置
- **THEN** 再次核验全部必需能力，失败保持旧绑定

## ADDED Requirements

### Requirement: Provider replay data survives bounded restoration

完整接受的 assistant 响应 SHALL 保留再次请求必需的内容块、推理载荷及签名；数据 SHALL 属于原消息、绑定原模型配置、计入输出和上下文预算，MUST NOT 保存凭据或进入普通 metadata 页。重启和工具续接 SHALL 恢复同模型所需的数据；不兼容切换 MUST NOT 将签名或加密载荷重放到其它模型。普通文本与工具调用历史 SHALL 继续可移植。

#### Scenario: 推理工具续接及重启
- **WHEN** 模型带推理或签名返回工具调用，接受结果后重启并继续
- **THEN** 原调用身份和 Provider 所需重放数据保留，模型能够消费配对的工具结果

#### Scenario: 预算和跨模型隔离
- **WHEN** 重放数据超出预算或目标模型不兼容
- **THEN** 超限明确阻塞，不提交部分响应；不兼容载荷不发送给目标模型
