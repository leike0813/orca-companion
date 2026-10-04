## MODIFIED Requirements

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
