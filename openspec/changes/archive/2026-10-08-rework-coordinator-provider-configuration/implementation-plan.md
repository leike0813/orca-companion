# Implementation Plan

## 1. 实施基线与权威来源

baseline mode: `predecessor-contract`。直接前驱：`remove-worker-credential-management`，已归档于 2026-10-07；规划 commit f486bd67c64a3dcbd70b81d9773a452ff764bfcb。前驱主规格 configuration/model-settings、coordinator/model-configuration 已存在。冻结 Worker harness/modelSelection、Manifest v4、CredentialStore 单实例、追加式项目配置与 Session 显式切换、IC-04/11/12 和 #52 布局。实施前已核对这些真实模块；ledger-lab 现有准备与人工业务边界固定，共同文件串行。

## 2. 复用与接缝

| IP-ID | 现有文件与符号 | 复用方式 | 禁止复制的事实 |
|---|---|---|---|
| IP-01 | model-configuration/project-config/model-config-switch | strict schema、语义引用校验 | Worker 生命周期、凭据值 |
| IP-02 | CredentialStore/FileProjectConfigurationStore/model-settings | CAS、原子文件、追加快照、保存与应用分离 | 第二份 CredentialStore |
| IP-03 | Worker 目录查询模式 | 同步候选与显式异步查询 | 供应商能力猜测 |
| IP-04 | resolveChatModel、capability-probe、context、checkpoint | BaseChatModel、权威正文、有界上下文 | gateway、第二份历史正文 |
| IP-05 | modelSettingsPort、#52 editor/picker、ledger wizard | 公共保存与查询用例 | UI/lab 内的 Provider 规则 |
| IP-06 | shared fixtures、当前文档、TUI preview | 更换当前生产者与行为断言 | 历史证据改写 |

## 3. 代码变更映射

| IP-ID | Task | Requirement/Scenario | 文件与符号 | 精确变化 | 不得改变 |
|---|---|---|---|---|---|
| IP-01 | canonical DTO | Immutable versioned model settings/旧 schema、复杂字段 | src/domain/model-configuration.ts；src/application/configuration/project-config.ts；src/application/coordinator/model-config-switch.ts；src/bootstrap/project-config.ts | D01，schema5、完整绑定、删除自由 options/auth | Worker schema |
| IP-02 | 用户库与项目保存 | 跨项目复用、多模型、冲突、保存与应用独立 | 新 src/application/ports/provider-library-store.ts；src/adapters/storage/provider-library-store.ts；src/application/configuration/provider-library.ts；修改 model-settings.ts | D02，API Key校验/CAS与快照选择 | Session/Manifest 自动变化 |
| IP-03 | catalog/发现 | provider-catalog 全部 requirements/scenarios | 新 src/application/configuration/provider-catalog.ts；src/adapters/agents/provider-catalog.ts；src/adapters/agents/provider-catalog.json；scripts/generate-provider-catalog.mjs；tests/configuration/provider-catalog.test.ts | D03，公共更新、分页发现、TTL和LKG版本隔离 | 候选合并/模型ID重写 |
| IP-04 | factory/恢复/probe | verified installed chat model、Provider replay data 全部 scenarios | chat-model-factory.ts、capability-probe.ts、workflow/coordinator/{context,model-call,nodes}.ts、domain/coordinator/session-state.ts、storage/checkpoint-store.ts、package.json、pnpm-workspace.yaml、pnpm-lock.yaml、patches/ | D04/D05，固定协议、生产依赖、真实续接、白名单有界恢复 | 内层重试/秘密落盘 |
| IP-05 | 接入消费者 | 简洁配置、默认返回、离线保存、独立应用 | bootstrap/{foreground-planning-runtime,coordinator-runtime,doctor,ledger-lab}.ts；application/tui/project-presentation.ts；interfaces/tui/{ports,state,app,commands}.ts或tsx及components/{model-settings-editor,model-picker,workspace}.tsx；artifacts/ledger-lab/wizard.mjs | D06，共享服务及明确用户意图、隐藏key、迟到隔离；Home project load 可失败但 library 独立可用；项目缺失时显式 issue number 初始化入口 | Worker 原生选择 |
| IP-06 | fixtures/文档/验收 | 所有 scenarios | tests/support/model-configurations.ts、tests/tui/harness.ts、受影响 tests/{configuration,adapters,bootstrap,workflow,tui,integration,acceptance}；artifacts/{execution-concurrency,graph-basis/real-acceptance}/*setup-fixture.mjs；scripts/tui-preview.mjs；AGENTS.md、CONTEXT.md、docs/{architecture,interface-contracts}.md、docs/dev/tui-implementation-handoff.md、docs/research/provider-configuration.md、README.md、active lab artifacts、openspec/config.yaml | D07，当前配置生产者/事实源/三尺寸画面、完整检查 | 历史现场/前驱历史 |

## 4. 调用与副作用顺序

连接：输入 strict 校验→预设/地址解析→credential metadata/CAS/save/read→library CAS/save/read→首次 discovery。失败不激活、不跨文件补偿。模型：原连接和当前目录→精确匹配 metadata 或手填null→library CAS。项目：load/revision→resolve immutable library model→去重追加完整快照→parse→project CAS。应用：原 Session 身份/suspended/no-inflight→核验→原切换用例；失败保持旧绑定。发现/public refresh 各自有界并绑定查询身份，不从 render 派发。

## 5. Schema、状态与持久化落实

D01/D02/D03/D05 定义唯一 owner。项目 schema5 拒绝旧格式，不迁移。用户库schema1，缓存非秘密，发现缓存绑定版本/credentialRef，不保存secret。checkpoint replay 属原消息且只在对应配置恢复；历史 metadata 排除。错误结构化，秘密不进入异常输出。无新增协调业务状态机。

## 6. 验收证据矩阵

| Requirement/Scenario | IP-ID | 测试文件 | Fixture/前置条件 | 关键断言 | 可运行命令 |
|---|---|---|---|---|---|
| immutable/旧格式/复杂字段/冲突/跨项目/多模型 | IP-01/02 | configuration/{project-config,model-settings,provider-library}.test.ts及storage tests | 隔离临时XDG和项目 | 拒绝秘密/旧格式；CAS与旧快照不变 | pnpm test tests/configuration |
| provider-catalog 全部 | IP-03 | provider-catalog.test.ts | mock bounded HTTP/clock/cache | 非空真源、空回退、版本失效、取消及手填 | pnpm test tests/configuration/provider-catalog.test.ts |
| 安装/直接调用/核验/恢复/预算隔离 | IP-04 | adapters/{chat-model-factory,capability-probe}、workflow/coordinator、checkpoint tests | SDK模型mock与signed/reasoning工具结果 | 固定协议、不丢数据、真工具续接/abort | pnpm test tests/adapters tests/workflow |
| offline save/简洁表单/Worker/默认返回/迟到 | IP-05/06 | tui/model-settings、bootstrap/ledger-lab、acceptance/ledger-lab-setup | fake共享port/临时配置 | key隐藏、明确选择/应用、Worker隔离 | pnpm test tests/tui tests/bootstrap tests/acceptance |
| 三尺寸画面与用户决议 | IP-05/06 | TUI preview artifacts | #52交接；120×40、80×24、50×40 | 同角色结构/返回/独立effort；用户接受当前功能，完整视觉对照留待后续 | pnpm build；node scripts/render-provider-tui.mjs；记录2026-10-08用户决议 |
| 完整仓库回归 | IP-06 | 现有套件 | 不触碰references/orca | 类型/lint/build/tests | pnpm typecheck；pnpm lint；pnpm build；pnpm test；git diff --check；openspec validate rework-coordinator-provider-configuration --strict |

## 7. 文件清单与升级条件

allowlist 为第3节全部文件及其直接受影响 tests/fixtures/exports；未用旧Provider表单/动态module resolver直接删除。禁改 references/orca、用户配置/密钥、历史证据、Git历史。发现影响 Worker原生认证、引入gateway或需要迁移时返回设计；局部API/SDK字段与测试诊断由各slice在既定合同内解决。

## 8. 验收 Agent 授权与限定审计

授权限定诊断/修复上述写集内功能与测试，父agent最终核验产品合同、secret边界、版本失效、async身份、Provider续接和预算。真实付费请求仅在已有明确配置授权下执行。2026-10-08用户明确接受当前功能，TUI美化与完整视觉对照留待后续；本轮结论只覆盖功能。完成实现后才建立verification，不归档、不提交。
