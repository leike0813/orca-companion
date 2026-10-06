# Implementation Plan

## 1. 实施基线与权威来源

模式：predecessor-contract。前驱 add-worker-harness-adapters 已归档于 2026-10-06，规划 HEAD f445aee37dfe0a6514b569678754fde3481ee0fb。实施前核验 archive、workers/harness-adapters 主规格及 HEAD；已读当前 WorkerHarness、ProviderConnection、ModelSettingsService、launch/resume 与生产运行时调用。冻结接缝：ExecutionBackend 公开 query/mutate、OperationId unknown 对账、原 Task authorization/profile binding、预算、Coordinator CredentialStore、#52 final 布局/返回。仅设计 D-01–04 指定字段发生有意 breaking change；其他漂移停止。

## 2. 复用与接缝

| IP-ID | 现有或前驱文件与符号 | 复用方式 | 禁止复制的事实 |
|---|---|---|---|
| IP-01 | model-configuration / model-settings / project-config / execution-authorization | 严格 schema、CAS、append-only profile 与指纹 | Worker provider/credential owner |
| IP-02 | WorkerHarness、worker-harness registry、codex-model-launcher、read-only-execution-wrapper | 同一生产描述符/runner/哨兵 | 原生配置、认证资产、native DB |
| IP-03 | foreground-planning-runtime、execution-runtime、doctor | 原Task绑定、准入/恢复/完整授权 | 当前默认替代原profile |
| IP-04 | ModelCatalogPort、RoleModelMenu、ModelSettingsPort | #52 role/candidate/effort与显式意图 | GUI推断认证/能力 |
| IP-05 | 当前 docs 和相关现有fixtures/tests | 更新当前边界并复用验证 | 历史验收的PASS |

## 3. 代码变更映射

| IP-ID | Task | Requirement/Scenario | 文件与符号 | 精确变化 | 不得改变 |
|---|---|---|---|---|---|
| IP-01 | 1.1 | model-settings全部；authorization全部 | src/domain/model-configuration.ts、planning/execution-authorization.ts；src/application/configuration/model-settings.ts、project-config.ts | D-01 union/schema4、零Worker credential访问、source缓存核验、modelSelection | Coordinator认证/预算/CAS |
| IP-02 | 2.1–2.3 | harness-adapters全部；harness-binding全部；worker-sessions恢复；read-only全部 | src/application/ports/worker-harness.ts；src/bootstrap/worker-harness.ts；src/adapters/agents/{codex-model-launcher,codex-launch,codex-harness,codex-transcript,codex-read-only-probe,native-worker,opencode-harness,read-only-execution-wrapper,worker-runtime,worker-model-catalog}.ts；src/adapters/orca-cli/process-runner.ts | D-02/03/04删除隔离/auth/config，query目录，实际root proof，严格readonly | exact session/unknown/bounded/cancel |
| IP-03 | 3.1 | harness-binding启动/恢复；worker-sessions；authorization原任务；doctor | src/bootstrap/{foreground-planning-runtime,execution-runtime,baseline-reconciliation-runtime,integration-reconciliation-runtime,graph-patch-worker,doctor}.ts | D-01–04将profiles选择接线全部角色/恢复/probe，cache verifier，原report actualroot | 原授权/Task/Dispatch/消费 |
| IP-04 | 4.1 | tui/planning-workspace模型；model-settings手填/来源 | src/interfaces/tui/{ports,state,app}.ts(x)、components/{model-picker,model-settings-editor}.tsx、screens/workspace.tsx | D-04去Worker form，harness/nativeID/effort与显式cancel目录 | 原型/迟到归属/默认返回 |
| IP-05 | 5.1–5.2 | 全部Scenarios的检查及当前文档 | 下述文件清单 | 当前边界、fixtures/最小checks、测试与风险结果 | 用户数据/未提交文件/历史工件 |

## 4. 调用与副作用顺序

显式目录查询→有界原生读取→非秘密cache→save验证claims→项目短锁/CAS追加profile；Worker不访问CredentialStore。Coordinator原凭据先写/配置CAS路径不变。Manifest审批→原Task binding→准备Companion工件→实际终端launcher解析env roots→readonly overlap核验→native startup reporter→exact proof→既有结算。恢复按原report与binding，不覆盖native环境。失败不自动fallback/retry；unknown沿原OperationId。

## 5. Schema、状态与持久化落实

项目4/Manifest4/descriptor2，拒绝旧版不迁移；SQLite版本不改。原生session facts由harness拥有，report只非secretpaths，不复制整env/auth。角色profile追加、原授权固定、预算不重置。目录有界4096项/1MiB、30秒与AbortSignal，缺能力effort为null。

## 6. 验收证据矩阵

| Requirement/Scenario | IP-ID | 测试文件 | Fixture/前置条件 | 关键断言 | 可运行命令 |
|---|---|---|---|---|---|
| 配置保存/旧版本/来源/伪造拒绝 | IP-01 | tests/configuration/**、tests/domain/execution-authorization.test.ts | fake stores/native目录 | 零Worker凭据调用、CAS、旧版拒绝 | pnpm exec vitest run tests/configuration tests/domain/execution-authorization.test.ts |
| 所有harness launch/proof/resume与readonly | IP-02 | tests/adapters/agents/**、tests/application/worker-harness-registry.test.ts | fake executable＋真实Node launcher；bwrap条件探针 | 原生env继承/无auth副本/精确identity/写入拒绝 | pnpm exec vitest run tests/adapters/agents tests/application/worker-harness-registry.test.ts |
| 原Task profile/恢复/doctor及运行时 | IP-03 | tests/bootstrap/** | 原授权fakeOrca | 元数据/角色选择、无凭据传播、预算不变 | pnpm exec vitest run tests/bootstrap |
| Worker picker/未验证ID/Coordinator form | IP-04 | tests/tui/model-settings.test.tsx、host-wiring.test.ts | production App fake ports | 显式query与迟到/cancel、harness切换、返回 | pnpm exec vitest run tests/tui/model-settings.test.tsx tests/tui/host-wiring.test.ts |
| 全部契约整合 | IP-05 | 全suite、docs与preview | 已安装依赖 | type/lint/build/fullsuite；严格spec/diff | pnpm typecheck；pnpm lint；pnpm build；pnpm test；openspec validate remove-worker-credential-management --strict；git diff --check |

真实本机原生目录无prompt检查、生产launcher环境/恢复/readonly核验和52三尺寸画面复用现有检查；只能记录实际结果。真实Orca矩阵仅显式隔离开关，未运行标skip不计PASS；无需为此提交HEAD或运行用户主项目。

## 7. 文件清单与升级条件

新增仅worker-runtime.ts、worker-model-catalog.ts及对应最小测试、当前change工件。修改上表源文件；相关tests/configuration/**、tests/domain/execution-authorization.test.ts、tests/adapters/agents/**、tests/application/worker-harness-registry.test.ts、tests/bootstrap/**、tests/tui/**、tests/support/{model-configurations,read-only-worker-probe,worker-harness-acceptance}.ts、tests/acceptance/worker-harness-matrix.test.ts、scripts/tui-preview.mjs的原Worker契约fixture。文档allowlist AGENTS.md、CONTEXT.md、README.md、docs/{architecture,interface-contracts,orca-compatibility}.md、docs/dev/tui-implementation-handoff.md、openspec/config.yaml。

不改references/orca、lockfile、依赖、已归档specs/verification、历史工件、用户opencode.json与研究未提交文件。超出此范围的新公开contract/权限/数据迁移需升级。

## 8. 验收 Agent 授权与限定审计

实现后核验 zero-worker-credential、native-env、exact-session、readonly-overlap、original-task-binding、catalog-provenance 六项；允许上述边界内缺陷修复。apply不创建verification.md、不提交/归档。正式固定checkpoint验收另按现有流程。

## 9. 实施结果

2026-10-07 Ubuntu 本机。当前文档、生产代码、preview 与受影响 fixtures 已同步；Coordinator CredentialStore、Orca transport、原 Task 授权及预算 owner 保持原合同。项目 schema4 / Manifest4 / launcher descriptor2 拒绝旧格式，不迁移配置，不清理任何原有凭据。

| 限定审计 | 结果与证据 |
| --- | --- |
| zero-worker-credential | Worker port、launcher、原生目录与角色保存不再接收或读取 CredentialStore；现有配置测试核验零调用，host-wiring 核验手填不创建凭据文件。chat-model-factory 中的凭据解析仅属 Coordinator。 |
| native-env | descriptor2 继承实际 process.env，runtime/reporter 只上报非秘密路径；无原生认证副本、链接或 provider 配置写入。Codex launch 与五 harness adapter 检查覆盖原生环境和逐次模型参数。 |
| exact-session | native/OpenCode/Codex 按精确 ID、cwd、transcript metadata、时间窗与实际 roots 证明；resume 校验原 root；不按最新文件猜 Session。相关 adapter 与恢复测试通过。 |
| readonly-overlap | launcher 解析 realpath，拒绝 native writable roots 与仓库/Git/common dir/协调状态重叠；OpenCode DB 的外部路径也进入边界。既有 wrapper/launch 测试和五项本机哨兵探针通过。 |
| original-task-binding | dispatchProfileFor/pinnedProfileFor 与恢复、Finalizer、集成均读取原 Task 授权绑定；集成恢复从原报告取实际 root。Bootstrap 17 文件/169 项、恢复及集成专项 20 项通过。 |
| catalog-provenance | 查询开始即使旧缓存失效，只接受当前未取消查询的来源；伪造、取消、迟到结果不能用于保存，手填无 effort。配置、目录、TUI 与真实 host-wiring 检查通过。 |

角色模型界面沿 #52 final，在 120×40、80×24、50×40 和 color/no-color × Nerd/ASCII 共12组完成查询、切换、effort、中文手填、返回草稿/光标检查；resize 与完整授权审阅默认返回通过。[当前画面与复现入口](evidence/README.md)。

原生无 prompt 查询：Codex 0.160.0/14项，Claude 2.1.291/4项，pi 1.0.0/521项，OMP 18.4.10/913项；OpenCode 2.0.21 输出为空，正确返回 catalog_empty，允许未验证手填。五项生产 launcher/bwrap 哨兵探针均为 available / host-verify。真实 Orca 角色 Session、恢复与隔离端到端矩阵未运行，明确 skip，不以历史矩阵计 PASS。

最终检查全部 exit0：`pnpm typecheck`、`pnpm lint`、`pnpm build`；`pnpm test --maxWorkers 6 --reporter=default --reporter=json --outputFile.json=/tmp/companion-stable-test-results.json` 为183文件通过/7文件条件跳过，2087项通过/16项条件跳过（共2103项），耗时410.29秒；`openspec validate remove-worker-credential-management --strict` 与 `git diff --check` 通过。[结构化结果](evidence/checks.json)。

实施中新增的 host-wiring 检查发现取消刷新后旧目录缓存仍可被保存；已在共享查询入口开始时使旧缓存失效。修复后专项及最终全量检查通过。未提交代码、未归档 change，历史工件与用户原有未提交文件保留。
