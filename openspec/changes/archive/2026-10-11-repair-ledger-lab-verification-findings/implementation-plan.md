# Implementation Plan

## 1. 实施基线与权威来源

baseline: predecessor-contract。planning commit: e6203fb43269a49005888daa8bda78735c34907f。直接前驱 simplify-ledger-lab-lifecycle 已在 archive/2026-10-10-simplify-ledger-lab-lifecycle；十项主 capability 均存在。冻结 ProviderLibraryEditor/library、RouteMapInitialization、InputProtection/HistoryReadPort、AgentTurnDriver、cleanup 原 run identity 与公开命令。实施前 git status、前驱归档/主规格、这些文件符号核验；规划时工作区干净，4文件53现有用例通过但未覆盖回归。用户批准所有 D-01–06，并允许本修复与原 lab 并存。

## 2. 复用与接缝

| IP-ID | 现有文件/符号 | 复用 | 禁止复制 |
|---|---|---|---|
| IP-01 | domain/model-configuration、ProviderLibraryEditor、ProviderLibrary、chat-model-factory | metadata与菜单/固定协议 | 凭据与Worker模型owner |
| IP-02 | model-call/CommittedModelStep、project-presentation、history-input | usage与输入预算 | tokenizer估算冒充真实用量 |
| IP-03 | checkpoint-store、history-inspection-index、HistoryReadPort、TranscriptReader | 有界投影和锚点 | replay/原文权威 |
| IP-04 | InputProtection.beginSubmission、TuiApp、DebugApp | durable pending与新草稿 | 业务受理事实 |
| IP-05 | AgentTurnDriver、ControllerSessionSummary、startup-onboarding | 状态与spinner | Scope控制状态 |
| IP-06 | TranscriptReader.move、Conversation、public stdin | 串行阅读与区域鼠标 | Ink私有输入实现 |
| IP-07 | cleanup.remoteTarget、run-record | 复核与后置对账 | Github原子条件假设 |
| IP-08 | 文档/现有验收工具 | 来源接缝同步/证据 | 原型final/旧verification |

## 3. 代码变更映射

| IP-ID | Task | Requirement/Scenario | 文件与符号 | 精确变化 | 不得改变 |
|---|---|---|---|---|---|
| IP-01 | 1.1 | Declared immutable model metadata / Distinct manual model input / Fixed protocol reasoning presets | src/domain/model-configuration.ts；application/configuration/{provider-library,provider-catalog,model-settings,project-config}.ts；application/coordinator/model-config-switch.ts；adapters/agents/chat-model-factory.ts；interfaces/tui/components/{provider-library-editor,model-settings-editor}.tsx | optional schema+snapshot；manual/metadata/menu；protocol presets | immutable历史、probe、Worker |
| IP-02 | 1.2 | Model window caps effective input budget / Protocol-correct last request usage / Exact current model context observation | workflow/coordinator/model-call.ts；application/tui/project-presentation.ts；interfaces/tui/components/status-line.tsx；bootstrap/{foreground-planning-runtime,debug-runtime}.ts | 协议usage、last step metadata、窗口上限与展示 | 原预算、历史usage |
| IP-03 | 2.1 | Empty registered history and bounded visible projection 的全部场景 | adapters/storage/{checkpoint-store,history-inspection-index}.ts；application/coordinator/history.ts；interfaces/tui/render/transcript-reader.ts；bootstrap两个宿主 | schema5 projection、bounded backfill/read/search、空历史 | 原文/续接身份/缓存上限 |
| IP-04 | 2.2 | Immediate pending submission presentation 的全部场景 | interfaces/tui/{app,debug-app}.tsx；input/input-protection.ts；components/{conversation,transcript,composer}.tsx | durable分离、pending、去重、新草稿 | original submission/answer |
| IP-05 | 2.3 | Observable genuine agent turn state / Actual asynchronous initialization feedback | application/controller.ts及controller DTO；interfaces/tui/screens/startup-onboarding.tsx；两个宿主/两App | 真实turn事件/spinner | scope语义 |
| IP-06 | 2.4 | Serialized transcript navigation and regional wheel 的全部场景 | render/transcript-reader.ts；两个App/Conversation；新增input/transcript-mouse.ts | navigation队列/底部；stdin过滤/区域三行 | 来源和焦点/输入 |
| IP-07 | 3.1 | Explicit repository reclamation 的全部场景 | artifacts/ledger-lab/cleanup.mjs；tests/acceptance/ledger-lab-cleanup.test.ts | deleting后复核、DELETE后验证、unknown阻止本地 | 记录/外置证据 |
| IP-08 | 4.1–4.2 | Shared repaired conversation behavior 及全部映射 | AGENTS.md、docs/{architecture,interface-contracts}.md、docs/dev/tui-implementation-handoff.md、artifacts/ledger-lab/guide.md、openspec/config.yaml；本change工件与新证据 | 当前合同/链接；检查/独立验收 | 原lab业务任务、历史证据 |

## 4. 调用与副作用顺序

遵守 D-01–06。model save：validate→append/CAS→project copy→explicit probe/apply；pending：snapshot durable→detach original→execute→settle original；display：commit新投影/Bootstrap旧投影→query range→render；turn：persist running→notify→invoke→idle/halted→notify；cleanup：lock→preflight→deleting→immediate identity→DELETE→absence→deleted→local。失败保留原输入/身份，不跨文件回滚或自动重试 unknown。render/resize只读。

## 5. Schema、状态与持久化落实

D-01 metadata只添加可选项，project5/library1原引用不改；D-03 checkpoint4→5 additive，derived chunks与原文独立。投影批次≤64KiB、来源有独立UTF8空间。UI schema不变，pending来自原snapshot。turn原idle/running/halted不另建状态机。

## 6. 验收证据矩阵

| Requirement/Scenario | IP-ID | 测试文件 | Fixture | 关键断言 | 命令 |
|---|---|---|---|---|---|
| 模型三个requirement全部场景 | IP-01 | tests/tui/provider-library-editor.test.tsx；tests/application/provider-library.test.ts；tests/adapters/chat-model-factory.test.ts | 合成library/协议 | 手填保存、metadata重开、实际参数 | pnpm exec vitest run tests/tui/provider-library-editor.test.tsx tests/application/provider-library.test.ts tests/adapters/chat-model-factory.test.ts |
| 窗口/usage/上下文全部场景 | IP-02 | tests/workflow/coordinator-graph.test.ts；tests/application/project-presentation.test.ts | 真实SDK语义fixture | cache不重复、累计不相加、窗口min | pnpm exec vitest run tests/workflow/coordinator-graph.test.ts tests/application/project-presentation.test.ts |
| 投影/空历史/导航全部场景 | IP-03/06 | tests/adapters/checkpoint-store.test.ts；tests/tui/transcript-reader.test.ts | SQLite/旧JSON/延迟range | 原文保留、text/search一致、串行/底部 | pnpm exec vitest run tests/adapters/checkpoint-store.test.ts tests/tui/transcript-reader.test.ts |
| 提交/turn/初始化/debug全部场景 | IP-04/05 | tests/tui/{input-protection,workspace,debug-app,startup-onboarding}.test.tsx；tests/bootstrap/foreground-planning-runtime.test.ts | delayed execute/model | immediate pending/new draft/真实turn | pnpm exec vitest run tests/tui/input-protection.test.tsx tests/tui/workspace.test.tsx tests/tui/debug-app.test.tsx tests/tui/startup-onboarding.test.tsx tests/bootstrap/foreground-planning-runtime.test.ts |
| 鼠标区域及协议过滤 | IP-06 | 新input mouse小测试；现有PTY | SGR/3尺寸 | 3行、overlay/输入隔离/restore | pnpm exec vitest run tests/tui/transcript-mouse.test.ts |
| 回收全部场景 | IP-07 | tests/acceptance/ledger-lab-cleanup.test.ts | 合成公开gh、临时目录 | 漂移零DELETE、postunknown保留本地 | pnpm exec vitest run tests/acceptance/ledger-lab-cleanup.test.ts |
| 文档/全部集成 | IP-08 | 受影响测试+新证据 | 生产TUI/三档色彩图标 | 来源对照/风险诚实 | pnpm typecheck；pnpm lint；pnpm build；openspec validate repair-ledger-lab-verification-findings --strict；git diff --check |

测试路径以当前文件核验为准，重用现有用例；只为稳定可观察边界补回归，不精确断言文案。三尺寸120x40/80x24/50x40，color/NO_COLOR、Nerd/ASCII另存证据，不覆盖final。真实provider与用户人工视觉不能推定通过。

## 7. 文件清单与升级条件

允许修改第3节列出源码及对应现有 tests/{application,adapters,workflow,bootstrap,tui,integration,acceptance} 用例/fixtures；新增窄mouse模块及projection需要的内聚storage模块、对应回归和独立画面证据。root exports仅因现有公共DTO必须时更新。保护 references/orca、package/lock、prototype final、前驱verification、用户状态/凭据、原lab业务任务。新增依赖、改产品决策/原型、超ownership写同一文件须升级；无需再次询问已批准行为。

## 8. 验收 Agent 授权与限定审计

所有实现任务完成后固定 HEAD+本change完整diff（用户未授权commit），独立 Agent 只读审查本计划范围及实际证据；授权跑局部合成测试，不操作真实平台。审计标签：immutable-snapshot、usage-semantics、bounded-projection、submission-loss、turn-authority、navigation-order、mouse-input、deletion-toctou。verification在apply后创建，缺真人/平台证据明确记录，不能伪称全业务通过。
