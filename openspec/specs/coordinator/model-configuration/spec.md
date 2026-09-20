# coordinator/model-configuration Specification

## Purpose
定义 Coordinator Model Configuration 到 chat model 实例的绑定、启动前能力核验，以及运行中切换的时机与迁移约束，使 Companion 不承担 provider 网关职责。

## Requirements

### Requirement: Coordinator Model Configuration injects a verified installed chat model

Coordinator 模型 SHALL 由用户批准的 Coordinator Model Configuration 解析到已安装的 provider 集成并注入 chat model 实例；Companion SHALL NOT 维护 provider allowlist、SHALL NOT 自动 fallback 到其他模型，也 SHALL NOT 持久化凭据。建立 Coordinator Session 并开始模型循环之前，能力核验 SHALL 覆盖注入模型的文本生成、流式输出、tool calling、取消与可用 usage 能力，任一必需能力缺失时启动 SHALL 被拒绝。

#### Scenario: 配置的集成不可用时拒绝启动
- **WHEN** Coordinator Model Configuration 指向的 provider 集成不可用或配置缺失
- **THEN** 启动 SHALL 以非零状态和可操作诊断失败，SHALL NOT 改用其他模型、其他配置或环境中的任意凭据

#### Scenario: 模型调用不经过 Companion 代理
- **WHEN** Coordinator Agent 调用模型
- **THEN** 请求 SHALL 由注入的 chat model 实例直接发往用户配置的 provider，Companion SHALL NOT 居间代理、缓存凭据或改写 provider 响应

#### Scenario: 缺少 tool calling 时拒绝启动
- **WHEN** 能力核验发现注入模型不支持工具调用
- **THEN** Companion SHALL 以非零状态拒绝启动并列出缺失能力，SHALL NOT 以降级模式继续

#### Scenario: 核验通过后才建立 Session
- **WHEN** 全部必需能力核验通过
- **THEN** Companion SHALL 才允许建立 Coordinator Session 并开始模型循环

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
