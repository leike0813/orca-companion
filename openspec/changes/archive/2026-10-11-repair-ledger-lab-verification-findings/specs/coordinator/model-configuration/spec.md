## ADDED Requirements

### Requirement: Fixed protocol reasoning presets
用户声明的推理值 SHALL 仅来自选定固定协议的支持预设，由 adapter 唯一映射为 OpenAI reasoning.effort、Anthropic outputConfig.effort 或 Gemini thinkingLevel。未知路径及值 SHALL 拒绝，保存声明 SHALL 不跳过实际能力核验。
#### Scenario: 声明后调用固定协议
- **WHEN** 自定义模型保存受支持的推理强度并通过启动核验
- **THEN** 真实请求携带对应协议参数，不接受任意 SDK options，不影响 Worker 设置

