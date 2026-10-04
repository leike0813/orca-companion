# Implementation Plan

## 1. 实施基线与权威来源
Baseline mode: `predecessor-contract`。规划 HEAD `82f6a77`，直接前驱 `archive/2026-10-04-complete-tui-model-configuration`；已核验归档目录、主规格和当前工作区无既有 dirty。冻结接缝：immutable model/role bindings、Manifest2/Task binding，IC-11 command results、IC-13 UiDraft/submission generation，固定项目面板及 single-row statusline。实施前若前驱未归档或上述合同漂移，回到规划。规格与 D-01–08 是本次权威；六票画面不可改写。

## 2. 复用与接缝

| IP-ID | 现有或前驱文件与符号 | 复用方式 | 禁止复制的事实 |
|---|---|---|---|
| IP-01 | controller-service、tui/view-model、Scope/session/model bindings | application presentation DTO | tracker/body、provider usage |
| IP-02 | execution-view/currentContractSettlements、GraphVersion | 唯一全图验收摘要 | Task完成/局部计数 |
| IP-03 | branch store、route-map-service、gh-tracker、Manifest | 精确有界项目读取 | 第二份授权/graph历史 |
| IP-04 | credential/project configuration storage filesystem模式 | 独立用户偏好短锁/CAS | secrets、IC-13草稿 |
| IP-05 | app/state/commands、StatusLine、TopBar、ProjectPanel、Sidebar/Inspector | 原输入与overlay顺序，纯呈现 | 业务状态/主动模型恢复 |
| IP-06 | preview fixtures、tuistory capture、PTY | 隔离生产App证据 | 原型fixture作为生产事实 |

## 3. 代码变更映射

| IP-ID | Task | Requirement/Scenario | 文件与符号 | 精确变化 | 不得改变 |
|---|---|---|---|---|---|
| IP-01 | 1.1/1.2 | Trusted project/session；Exact current context（全部） | 新application/tui/project-presentation.ts；controller-service.ts、tui/view-model.ts；chat-model-factory.ts；bootstrap/foreground-planning-runtime.ts | D02/03 DTO、可信模型/身份/Claim/context绑定，精确capability注入 | immutable模型/调度/输入预算 |
| IP-02 | 2.1 | Shared current contract acceptance（全部） | application/execution/execution-view.ts及IP01 DTO；controller-service.ts | D04全图当前Validator结果去重 | 原settlement准入 |
| IP-03 | 3.1/3.2 | Version-bound bounded details（全部） | application/ports/branch-coordination-store.ts；storage/coordination-store.ts、schema.ts；planning/route-map-service.ts；adapters/tracker/gh-tracker.ts；新application/tui/project-details.ts；foreground-planning-runtime.ts | D05精确读取、预算主体/批准Manifest、20项64KiB分页/continuation | Scope唯一owner/预算消耗 |
| IP-04 | 4.1/4.2 | User preferences（全部） | 新application/configuration/tui-preferences.ts；adapters/storage/tui-preferences-store.ts；foreground-planning-runtime.ts | D06 schema/port、默认/损坏/CAS/原子回读及装配 | 无自动写入 |
| IP-05 | 5.1/5.2/5.3 | Custom editor、Trusted presentation、details、shared acceptance（全部） | interfaces/tui/ports.ts、app.tsx、state.ts、commands.ts；components/status-line.tsx、top-bar.tsx、project-panel.tsx、新statusline-settings.tsx；screens/workspace.tsx；sidebar/Inspector当前组件 | D07编辑/预览/显式save/icon未保存状态、迟到隔离、三处共享摘要及D05页 | 三档定稿布局/输入返回 |
| IP-06 | 6.1/6.2 | 全部规格场景与D08 | scripts/tui-preview.mjs、preview/fixtures.ts；artifacts/project-statusline新采集/证据；AGENTS、architecture、interface-contracts、dev/handoff/workbench | 六票三档与性能/PTY、当前合同和进度 | 历史assets只读 |

## 4. 调用与副作用顺序
snapshot从权威绑定派生 → 界面读取；项目详情仅显式读取原对象版本。真实有效输入准备 → optional精确capability → 原绑定观察 → 输入提交/切换即失效。设置load只读 → 内存draft/preview → Enter save(expectedRevision,单区patch) → adapter锁内重读/CAS/原子rename/回读 → saved后应用；失败保留，conflict显式第二次提交。UI回调核对请求页面generation，不闭合新页面；图标先在内存应用，再保存独立patch，失败保留unsaved。

## 5. Schema、状态与持久化落实
用户偏好schema1文件只存展示值及revision，短锁不建立项目锁；损坏/未来schema禁止覆盖，缺失默认不写。业务schema16原事实保持，必要schema17仅索引；不迁移checkpoint或输入schema。预算限额按批准ref核验，不重置消耗。context观察临时且精确版本绑定，不作为持久usage。

## 6. 验收证据矩阵

| Requirement/Scenario | IP-ID | 测试文件 | Fixture/前置条件 | 关键断言 | 可运行命令 |
|---|---|---|---|---|---|
| Trusted/session/context | IP01 | tests/application/controller-service.test.ts；tests/bootstrap/foreground-planning-runtime.test.ts；tests/adapters/chat-model-factory.test.ts及必要presentation测试 | 精确claim/配置与installed fakeintegration | 未配置/缺来源、跨Session/迟到输入失效、snapshot不测量 | pnpm exec vitest run tests/application tests/bootstrap/foreground-planning-runtime.test.ts tests/adapters/chat-model-factory.test.ts |
| Shared acceptance | IP02 | 现execution-view测试及presentation测试 | 当前/旧合同、retire、重复结果 | 当前版本全图唯一计数 | pnpm exec vitest run tests/application |
| Details/budgets | IP03 | tests/coordination-store.test.ts；planning tracker tests；host wiring | 长UTF8 Manifest/精确批准绑定 | 20项/64KiB连续读、stale/主体正确 | pnpm exec vitest run tests/coordination-store.test.ts tests/application tests/tui/host-wiring.test.ts |
| Preferences/CAS | IP04 | 新tests/adapters/tui-preferences-store.test.ts | 临时configHome/twohosts/future/corrupt | 分区写、重启、CAS失败不损坏 | pnpm exec vitest run tests/adapters/tui-preferences-store.test.ts |
| Editor/late/return | IP05 | 复用tests/tui/input-paths、no-side-effect、session-lifecycle；必要statusline行为测试 | productionApp/edit控promise | 输入锚点/页面保持、save明确、图标unsaved | pnpm exec vitest run tests/tui |
| Prototype/performance | IP06 | 普通PTY及新增artifactcapture | 三档×两色×两图标、五状态、SQLite/App | 六票画面对照、resize、输入/缓存导航p95≤100ms | pnpm build；node artifacts/project-statusline/capture.mjs；pnpm exec vitest run tests/tui/pty.test.ts |

最终 `pnpm typecheck`、`pnpm lint`、`pnpm test --maxWorkers 4`、`pnpm build`、`openspec validate complete-tui-project-statusline --strict`、`git diff --check`。条件跳过单列。无实际provider精确capability或人工IME证据不宣称已验证。

## 7. 文件清单与升级条件
IP表列出新增/修改文件；对应既有测试/fixture允许同步最小变更。无删除/新依赖/提交/分支/上游修改。旧artifact和归档报告保留。扩大授权、provider heuristic、自定义键位或重设计须升级；普通DTO字段细化遵守D02–07。

## 8. 验收 Agent 授权与限定审计
全部tasks完成后固定实现状态，独立gpt-6-luna验收只读审计：精确绑定、context失效、无fallback、批准/候选分离、分页上限、CAS/原子完整性、迟到焦点、六票画面对照。范围内修复可做，verification不能提前创建；不提交或归档。

## 9. 实施记录（2026-10-04）

IP-01–05完成可信投影、完整有效输入测量绑定、当前合同Validator摘要、精确存储/批准详情和独立用户偏好CAS；三档custom及图标返回沿定稿。详情从SQLite按字段与UTF-8范围读取，复用schema16，无迁移。独立只读预审发现的Recovery/Finalizer工作详情回归已修复：当前Session/revision观察和原文范围共用有界分页，失效明确重读。

IP-06的六票对照、最终116对生产画面、补采95对及24项检查/53条操作、真实PTY与性能证据见[本批README](../../../artifacts/project-statusline/README.md)。原采集和首轮失败均保留。最终全量1690通过/2失败/12条件跳过；失败文件修复后5文件110项通过，其余受影响7文件92项通过；去重合并1692通过/12条件跳过。补回修复后Runtime/宿主/普通PTY3文件42项通过。typecheck/lint/build/严格OpenSpec/diff全部通过。

最终实现固定在HEAD `82f6a77`上的未提交工作区；用户未授权提交，故不制造验收commit。后续独立gpt-6-luna验收读取这一状态并记录输入/最终HEAD、实际工件与限制。平台证据限Ubuntu，provider真实精确测量、Windows和新增OS输入法人工验收未验证，条件跳过不算通过。历史GraphVersion与依据全文仍由第八批负责。
