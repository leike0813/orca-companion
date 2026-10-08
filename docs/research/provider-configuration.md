# Coordinator Provider 配置依据

截至本 change 调研，成熟 harness 都把服务预设、公开模型 metadata、账户可见模型与运行能力分开；用户选择不需要 SDK 包名和参数 JSON。

- [Models.dev 公共目录](https://models.dev/api.json) 提供 Provider、协议生态、模型与窗口 metadata，适合作为随发布固定的基础 catalog。目录不证明账户可调用或工具能力。
- [OpenCode v2.0.21 models-dev.ts](https://github.com/anomalyco/opencode/blob/8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72/packages/core/src/models-dev.ts) 使用嵌入基线、缓存及公共更新；这一路径是公共目录更新，不能当作私有端点发现。
- OMP 18.8.3 的已安装 `pi-catalog/src/model-manager.ts`、`model-cache.ts` 与 `provider-models/openai-compat.ts` 把 Provider 发现结果与基础目录分开，并管理发现缓存。Companion采用已确认的非空发现独占候选、失败LKG→catalog规则。
- [OpenCodex](https://github.com/lidge-jun/opencodex) 2.80.0 的 registry/entries-core、entries-extended、model-discovery 与生成 metadata 提供广泛预设参考；不引入其gateway/account/proxy层。
- [DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/) 要求工具续接携带原 assistant reasoning_content；只保存文本/tool args不够。LangChain OpenAI1.5.13入站保留该字段，出站converter需要最小补丁。
- [Cohere compatibility API](https://docs.cohere.com/docs/compatibility-api) 提供官方 OpenAI兼容地址，可归入固定Chat协议；[Azure现代v1](https://learn.microsoft.com/zh-cn/azure/foundry/openai/api-version-lifecycle) 使用用户资源地址与精确deployment ID，不需要暴露任意SDK options。
- [OpenAI GPT-5.1](https://developers.openai.com/api/docs/models/gpt-5.1) 的 reasoning effort 为 none、low、medium、high；目录仅为这个精确模型记录该能力。OpenAI 默认预设采用 Responses，另有 Chat Completions 预设。

实现中的目录校正必须来自精确Provider/模型来源。未知effort与window保持未知，发现列表也需经过独立的真实工具调用及续接核验才能运行。
