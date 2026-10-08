## Context

以已归档 `remove-worker-credential-management` 的合同为基线，规划 HEAD 为 f486bd67c64a3dcbd70b81d9773a452ff764bfcb。固定 Worker modelSelection、项目追加历史、Session configurationRef、CredentialStore 唯一 bootstrap 实例和 IC-04/11/12。ledger-lab 配置为本 change 的消费者，共同文件串行编辑。

## Goals / Non-Goals

完成 API Key Provider、可复用连接、多模型、可信目录、明确协议、离线保存和真实工具续接；所有入口共用应用用例。Worker 原生配置、OAuth、gateway、旧配置迁移及自动模型 fallback 不在范围内。

## Decisions

### D01 — 固定协议与不可变配置

`ProviderConnection` 保存 `connectionRef,label,providerId,providerIntegration,baseUrl,credential`。providerIntegration 为闭合协议 enum：`openai-chat`、`openai-responses`、`anthropic-messages`、`google-gemini`；前三项可自定义，第四项来自官方预设。credential 仅 `{kind:'managed',credentialRef:UUID}`。地址仅 HTTP(S)，拒绝 userinfo、秘密 query、fragment。删除连接任意 SDK options 和凭据注入路径。ModelDefinition 保留 exact model ID、connectionRef 与可信 effortCapability；路径仅为内部经过审核的 metadata，不由用户输入。

Coordinator 配置继续使用 configurationRef、providerIntegration、model、credentialRefs、nativeWindowOwnerRef、连接完整快照、modelRef、effortCapability、effort；不接受任意 modelOptions。项目 schema 5，连接快照和模型一致性由项目 parser 拥有；旧格式拒绝且不改写。编辑生成新 connectionRef/modelRef/configurationRef，旧记录和 Session 不变。

### D02 — 用户库与共享保存

新增应用 `ProviderLibraryStore` 端口与用户级 `providers.json`（XDG_CONFIG_HOME/orca-companion），保存 schemaVersion 1、revision、追加式 connections/models。引用选择版本即选择不可变快照；不自动修改项目。与项目 store 一样短锁、CAS、原子替换、回读、有界输入，拒绝 symlink/不安全权限；目录 0700、文件0600。密钥继续由唯一 CredentialStore 保存，顺序为校验→密钥保存回读→库 CAS；CAS 失败可能留下孤立密钥，不能自动激活。

共享服务提供 load/saveConnection/saveModel/resolveModel。saveConnection 输入为预设或自定义协议、label/baseUrl/newSecret 或现有不透明引用，不接受 SDK 形状。saveModel 只接 connectionRef/exact ID，由可信目录查询推导能力，手填未知为 null。项目 model settings 保存 Coordinator 时按 modelRef 解析项目既有完整快照或共享库模型，再追加完整连接/模型/配置快照；Worker 保存保持原合同。Home 的 initializeProject 输入为 modelRef、effort 和用户填写的正整数 routeMapIssueNumber，仅在项目文件不存在时 CAS 保存完整 schema5 快照。初始化用同一快照装配，避免无效 schema seed。

### D03 — 目录与发现

Models.dev snapshot 经生成器转换为随发布 JSON；按支持的 API Key SDK 协议归类，结合公开文档校正地区/产品线/endpoints，不把 SDK 包名变成运行时 import。自定义 providerId=`custom`，只按协议搜索 catalog，不推断域名供应商。

应用目录端口提供同步 cached candidates 和异步 refresh/discover；adapter 拥有 HTTP 和 XDG_CACHE_HOME/orca-companion 下缓存。公共 refresh 和连接发现分开。有效 catalog 版本由发布基线版本及实际内容版本绑定；相同内容刷新保持版本，升级内容或发布基线使旧 LKG 作废。发现缓存键为 connectionRef、credentialRef、catalogVersion。默认 TTL24h、请求 timeout10s、响应最多8MiB、候选最多10000；调用可取消，失败返回结构化状态。OpenAI 系列 GET /models，Anthropic GET /v1/models（处理已有 /v1），Gemini GET /v1beta/models，按公开分页有界读取。有效非空发现完全取代 catalog，失败/空回退同键 LKG→catalog，没有发现服务直接 catalog。精确模型 metadata 可补充能力但不能增加候选。

### D04 — 内置 LangChain adapter

OpenAI1.5.13、Anthropic1.5.10 改为 production dependencies，新增兼容 core1.2.12 的 Google0.2.7。固定 ChatOpenAICompletions/ChatOpenAIResponses/ChatAnthropic/ChatGoogle；关闭 SDK 内层重试，凭据只在构造内读取，映射 baseURL/anthropicApiUrl/endpoint 与可信 effort。保留显式注入 resolver 的测试 seam，删除 module#export 动态导入。未知精确 context/native compaction/keepalive 返回 unavailable，不估算。OpenAI converter 用最小 pnpm patch 保留 assistant reasoning_content 的出站续接，固定 Responses 使用 stateless replay 所需 reasoning 数据。

### D05 — 响应恢复与能力准入

assistant content blocks 和必要白名单 additional_kwargs 保留为有界 replay 数据，绑定 configurationRef；普通历史 metadata/summary 不携带 replay。正文只有一个 owner，预算包括 replay，跨配置只用可移植正文/tool 数据，不能把签名/加密 reasoning 交给另一模型。Capability probe 要求真实非空工具调用及 ToolMessage 续接成功，同时核验文本、流式、取消和真实 usage；超时中止 underlying request、关闭 iterator，错误不携带秘密。保存无需网络成功，启动/应用必须准入通过，失败保持旧绑定。

### D06 — TUI 与 ledger-lab

复用 #52 的角色区域、独立 effort、默认 Return、明确 Apply 和有界 dialog，连接流程为选服务/地区产品线或自定义协议→地址→隐藏 Key→选/手填模型。同步已有候选、显式进入时刷新，迟到结果绑定原调用身份；render/effect/remount/resize 只读。新连接保存触发首次发现，失败仍保存。用户库在未初始化项目的 Home 也可访问。ledger-lab 使用相同服务，不再问 module/export、JSON、认证模式或字段路径。保留原已完成准备流程和人工业务演练边界。

TUI `ModelSettingsPort` 可选暴露共享 `ProviderLibrary` 与 `ProviderCatalog`；Coordinator 项目 save 输入只含 `{expectedRevision, role:'coordinator', modelRef, effort?}`。Home 先独立保存连接/模型到用户库，项目 load 失败不得阻断此流程。缺少项目配置时，用户可在保存模型后显式填写 Route Map issue number 并调用 `initializeProject({modelRef,effort,routeMapIssueNumber})`；宿主只在文件缺失时创建 schema 5 配置，不猜 issue number、Provider 或自动应用模型。

### D07 — 文件所有权与验收

目录/发现、存储保存、workflow replay 分为无重叠写集；父 agent 拥有跨模块合同、bootstrap、UI/lab 和最终验收。覆盖消费者、共享 fixtures、实机配置生成器、exports 和当前文档。TUI 提供120×40、80×24、50×40可审阅画面。用户于2026-10-08明确接受当前功能，TUI美化与完整视觉对照留待后续；本轮功能验收不宣称视觉一致性通过。

## Risks / Trade-offs

公共 catalog 不证明账户可调用；发现也不证明工具能力。手填 ID 无可信 effort/window。厂商可能部分实现标准端点，发现失败保留离线选择。明文 CredentialStore 为既定用户取舍；两个文件无法原子提交，可产生不被使用的孤立密钥。SDK patch 需随升级复核。签名恢复依赖真实 provider 证据；本地模拟测试只证明数据保真。

## Migration Plan

未发布项目无迁移；schema 4 及更早版本明确拒绝，文件保留。修正当前实机 fixture 生成器，历史证据保留。更新当前 AGENTS/架构/合同/使用说明及 active lab 配置描述；不提交或归档。

## Open Questions

无影响实现合同的未决问题。TUI视觉打磨按用户决议留待后续，真实付费 Provider 覆盖由实际可用的显式配置决定。
