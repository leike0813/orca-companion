## Why

ledger-lab 的配置向导把模块导出、SDK JSON 与凭据注入路径交给操作者，暴露了 Coordinator Provider 配置缺少产品接口的问题。统一连接、模型目录与核验用例，让 TUI 和实验向导都能通过服务、地址、API Key 与模型完成配置。

## What Changes

- **BREAKING**：项目配置升级 schema 5，Coordinator 采用内置固定协议 adapter 和 API Key；旧格式保留并明确拒绝，不迁移。
- 增加用户级不可变连接/模型库，一个连接可保存多个模型，项目及 Session 使用明确选择的完整快照。
- 增加随版本固定的 Models.dev catalog、公共更新及连接模型发现；非空发现为真源，失败回退 last known good → catalog，catalog 更新使旧发现缓存失效。
- 普通表单只暴露 Provider、地区/产品线或自定义协议、地址、隐藏 Key、模型与可信 effort；删除 module/export、SDK options JSON、认证模式与字段路径输入。
- 内置生产依赖、能力核验及完整工具续接；保留 provider 推理/签名数据以支持恢复。
- TUI 与 ledger-lab 复用共享用例；Worker 仍沿 harness 原生模型和认证合同。

直接前驱为已归档的 `remove-worker-credential-management`。本 change 是 active `add-ledger-lab-rehearsal-infrastructure` 的配置解阻塞项，允许先实施；共同文件串行编辑。后者的实机业务演练不计为本 change 的完成条件，也不得提前勾选。用户已明确授权起草并实现，不需要重复批准流程或依赖接入。

验收范围按2026-10-08用户决议收口：“可以，先这样吧，功能先做出来就行，TUI美化可以以后慢慢做”。本轮接受当前功能及已提供的三尺寸审阅材料；视觉美化与完整视觉一致性对照留待后续，不宣称本轮视觉验收通过。

## Capabilities

### New Capabilities

- `configuration/provider-catalog`: Provider presets、基础目录、连接发现、缓存回退和可信 metadata。

### Modified Capabilities

- `configuration/model-settings`: 用户连接/模型库、schema 5、API Key、不可变项目绑定。
- `coordinator/model-configuration`: 固定协议装配、核验与 provider 消息恢复。
- `tui/planning-workspace`: 简洁 Coordinator 配置流程与同源模型候选。

ledger-lab 的配置要求在其 active `testing/ledger-lab-rehearsal` delta 内同步，避免创建重复 capability。

## Impact

domain/configuration、model settings 和 storage ports/adapters、chat factory/capability probe、workflow/context 与 checkpoint 消息、doctor/foreground bootstrap、TUI、ledger-lab、共享与实机 fixtures、当前文档。OpenAI/Anthropic 改为生产依赖，新增 `@langchain/google@0.2.7`，最小 OpenAI converter 补丁与 lockfile。没有 Orca gateway、Worker 凭据管理、OAuth、旧配置迁移、Git 提交或归档。
