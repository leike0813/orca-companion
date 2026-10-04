# coordinator/model-configuration Specification

## Purpose
定义 Coordinator Model Configuration 到 chat model 实例的绑定、启动前能力核验，以及运行中切换的时机与迁移约束，使 Companion 不承担 provider 网关职责。

## Requirements

### Requirement: Coordinator Model Configuration injects a verified installed chat model

Coordinator 模型 SHALL 由用户批准的 Coordinator Model Configuration 解析到已安装的 provider 集成并注入 chat model 实例；Companion SHALL NOT 维护 provider allowlist、SHALL NOT 自动 fallback 到其他模型。凭据 SHALL 仅由用户级 CredentialStore 或显式 Harness-login 解析，版本化配置只保存引用。建立 Coordinator Session 并开始模型循环之前，以及显式切换之前，能力核验 SHALL 覆盖文本生成、流式输出、tool calling、取消与可用 usage，任一必需能力缺失时 SHALL 拒绝。

#### Scenario: 配置的集成不可用时拒绝启动
- **WHEN** 配置指向的 provider 集成不可用、配置缺失或凭据无法解析
- **THEN** 启动以非零状态和可操作诊断失败，不改用其他模型、配置或任意凭据

#### Scenario: 模型调用不经过 Companion 代理
- **WHEN** Coordinator Agent 调用模型
- **THEN** 注入的 chat model 直接调用配置 provider，凭据不进入协调记录，provider 响应不被代理改写

#### Scenario: 缺少 tool calling 时拒绝启动
- **WHEN** 能力核验发现不支持工具调用
- **THEN** 启动被拒绝并列出缺失能力，不以降级模式继续

#### Scenario: 核验通过后才建立 Session
- **WHEN** 全部必需能力核验通过
- **THEN** 才建立 Coordinator Session 并开始模型循环

#### Scenario: 切换也核验全部能力
- **WHEN** suspended 且无在途模型操作的 Session 显式应用新配置
- **THEN** 先按既有 checkpoint/native-window 迁移合同完成准备并核验全部必需能力，失败保持原绑定且不自动 fallback

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
