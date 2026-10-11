## ADDED Requirements

### Requirement: Declared immutable model metadata
模型 SHALL 可保存正安全整数 contextWindow、唯一非空且含 text 的 text/image/audio/video 输入模态与 catalog/user_declared 来源。手填模型 SHALL 可选择固定协议推理预设，声明 MUST NOT 冒充能力核验。编辑 SHALL 创建新 modelRef，既有配置与 Session 快照不变；旧记录缺元数据时 SHALL 表示未知。
#### Scenario: 自定义模型保存重开
- **WHEN** 用户手填 ID、推理强度、窗口和输入模态并保存重开
- **THEN** 原声明及来源恢复，显式应用使用该快照，非法窗口或模态拒绝且保留输入

