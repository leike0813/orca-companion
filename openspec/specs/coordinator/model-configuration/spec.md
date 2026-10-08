# coordinator/model-configuration Specification

## Purpose
定义 Coordinator Model Configuration 到 chat model 实例的绑定、启动前能力核验，以及运行中切换的时机与迁移约束，使 Companion 不承担 provider 网关职责。

## Requirements

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

### Requirement: Provider replay data survives bounded restoration

完整接受的 assistant 响应 SHALL 保留再次请求必需的内容块、推理载荷及签名；数据 SHALL 属于原消息、绑定原模型配置、计入输出和上下文预算，MUST NOT 保存凭据或进入普通 metadata 页。重启和工具续接 SHALL 恢复同模型所需的数据；不兼容切换 MUST NOT 将签名或加密载荷重放到其它模型。普通文本与工具调用历史 SHALL 继续可移植。

#### Scenario: 推理工具续接及重启

- **WHEN** 模型带推理或签名返回工具调用，接受结果后重启并继续
- **THEN** 原调用身份和 Provider 所需重放数据保留，模型能够消费配对的工具结果

#### Scenario: 预算和跨模型隔离

- **WHEN** 重放数据超出预算或目标模型不兼容
- **THEN** 超限明确阻塞，不提交部分响应；不兼容载荷不发送给目标模型

### Requirement: Model Configuration switches only while suspended

运行中切换 Coordinator Model Configuration SHALL 只允许在 Session 处于 suspended 且没有模型相关操作在途时发生；切换时 SHALL 持久化 checkpoint、清空旧模型相关的 cache 与 maintenance 计划，并 SHALL NOT 自动 fallback 到其他模型。

#### Scenario: 模型循环进行中拒绝切换
- **WHEN** Session 正在执行模型循环或存在在途模型调用
- **THEN** 切换 SHALL 被拒绝并保持当前配置，SHALL NOT 中断在途调用或产生半切换状态

#### Scenario: 切换后清空旧 cache 与维护计划
- **WHEN** 在 suspended 且无在途操作时完成一次切换
- **THEN** Session SHALL 先持久化 checkpoint，再清空旧模型相关的 cache 与既有 maintenance 计划，新配置 SHALL 只在全部切换成功后生效

#### Scenario: 不兼容的 native window 先迁移
- **WHEN** 新的 model configuration 不能原样使用 checkpoint 中已有的 Native Compacted Window
- **THEN** Session SHALL 先尝试把该区间迁移为可移植 Context Capsule，并在迁移成功后继续；迁移失败时 Session SHALL 保持 suspended 或 blocked 并报告原因

#### Scenario: 不做自动模型回退
- **WHEN** 切换后的模型调用失败
- **THEN** Companion SHALL NOT 自动切回旧模型或改投其他模型，SHALL NOT 覆盖用户选择的配置

### Requirement: Finite output and context read budgets

项目配置 SHALL 提供有限正整数 output.maxResponseBytes 与 context.maxReadBytes，默认分别为 8 MiB 和 16 MiB。输出预算 SHALL 覆盖文本、内容块和工具参数，超限 SHALL 中断且不接受部分响应。上下文读取 SHALL 按配置限制正文、元数据及上下文材料，保留既有输入 token 与条数上限；读取超限 SHALL 明确阻塞，不截断权威原文、不以空历史继续。

#### Scenario: 默认与非法配置
- **WHEN** 预算未显式设置，或配置为零、负数/非有限/非整数
- **THEN** 未设置时使用上述默认值，非法值在启动前拒绝

#### Scenario: 输出与上下文超限
- **WHEN** 流式输出超过配置预算，或有效上下文超过读取/输入预算
- **THEN** 输出超限中断不提交，读取/输入超限明确阻塞；正式原文仍可通过局部范围阅读
