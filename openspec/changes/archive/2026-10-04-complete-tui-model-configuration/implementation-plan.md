# Implementation Plan

## 1. 实施基线与权威来源

Baseline mode: `predecessor-contract`。规划/实施 HEAD：`8f6d1a7e6765a024191043b97fbded2d4a902207`。直接前驱：`openspec/changes/archive/2026-10-04-complete-tui-command-reviews/`。apply 前核验归档目录、`openspec/specs/tui/planning-workspace/spec.md` 以及以下接缝：`application/tui/command-result.ts` 是结果唯一 owner；`interfaces/tui/command-invocations.ts` 精确绑定输入和 Session；`ports.ts` review/approve 只携 fingerprint/revision；`ui-input-store.ts` render/resize 不写入且 config secret 不进入输入恢复。实际 HEAD 与规划相同，唯一既有 dirty 文件是 `artifacts/pending-interactions/README.md`，受保护。

权威来源：本 change 五个 delta、D01–D08、CONTEXT、architecture、interface-contracts、六票定稿和当前源码。项目配置是候选事实，批准 Manifest 是启动授权，物化 binding 是 Task 原配置来源。

## 2. 复用与接缝

| IP-ID | 现有或前驱文件与符号 | 复用方式 | 禁止复制的事实 |
|---|---|---|---|
| IP-01 | project-config/parseProjectConfig、model-config-switch DTO | 统一schema与非秘密domain binding | provider状态/秘密 |
| IP-02 | Node filesystem、storage adapter模式 | credential/project短事务端口 | IC-13草稿或业务状态 |
| IP-03 | chat-model-factory、capability-probe、codex-launch/read-only-probe | 最后构造点与同一launcher | 凭据、harness登录 |
| IP-04 | authorization-service/recordApproval、manifestFingerprint、branch store | 原子追加授权、schema16 | 预算/graph状态 |
| IP-05 | materialize-work-package、advance-execution、session recovery、delivery verification | 按原Task固定授权 | 第二个任务状态机 |
| IP-06 | model-picker、selection-list/DialogFrame、app invocation/overlay | 定稿菜单与独立内存编辑 | scope身份/授权组装 |
| IP-07 | workbench、preview/PTY脚本、六票资产 | 单独生产验收 | fixture冒充事实 |

## 3. 代码变更映射

| IP-ID | Task | Requirement/Scenario | 文件与符号 | 精确变化 | 不得改变 |
|---|---|---|---|---|---|
| IP-01 | 1.1 | Immutable versioned model settings | 新domain/model-configuration.ts；bootstrap/project-config.ts；application/coordinator/model-config-switch.ts | D01 DTO/schema2/引用与effort校验，删除workerModel | v1不自动重写 |
| IP-02 | 2.1/2.2 | User credential store with isolated secrets；保存与应用独立；冲突和文件失败保留输入 | 新application/configuration/model-settings.ts、ports/credential-store.ts、ports/project-configuration-store.ts；adapters/storage/credential-store.ts、project-configuration-store.ts | D02短锁/CAS/原子文件、先key后引用，非秘密snapshot | 不跨文件假原子 |
| IP-03 | 3.1/3.2 | Coordinator Model Configuration injects a verified installed chat model；Codex launch resolves the approved model binding | adapters/agents/chat-model-factory.ts、codex-launch.ts、codex-read-only-probe.ts；新codex-model-launcher.ts；bootstrap/doctor.ts与foreground-planning-runtime.ts相关模型装配 | D03/D06解析key/effort、同一launcher/probe、完整能力核验 | suspended/只读约束 |
| IP-04 | 4.1/4.2 | Model-bound authorization and explicit model reapproval，全部场景 | domain/planning/execution-authorization.ts；application/planning/authorization-service.ts；bootstrap/execution-runtime.ts；storage/schema.ts、coordination-store.ts、application/ports/branch-coordination-store.ts | D04 Manifest2、完整review、model-only reapprove、id/CAS；D05 schema16 | 不改变权限/预算/generation |
| IP-05 | 5.1/5.2 | Materialized tasks retain exact model authorization，全部场景 | application/materialize-work-package.ts、execution/advance-execution.ts、recovery/worker-session-recovery-service.ts；adapters/agents/utility-worker.ts；bootstrap/foreground-planning-runtime.ts、execution-runtime.ts、baseline-reconciliation-runtime.ts、graph-patch-worker.ts | D05 pin、retry/recovery/utility/settlement接线；复用 Utility 的 task-created 回调，在 intent 结清前记录独立绑定 | 旧attempt/generation拒绝 |
| IP-06 | 6.1/6.2 | Approved role model settings and independent effort，前三场景 | interfaces/tui/ports.ts、components/model-picker.tsx、新model-settings-editor.tsx、app.tsx、state.ts、commands.ts、screens/workspace.tsx；bootstrap/foreground-planning-runtime.ts | D07角色/effort/配置内存编辑/save/apply/reauthorization，迟到归属 | 6A命令/IC13返回 |
| IP-07 | 7.1/7.2 | 三档生产画面对照、实际进程配置一致、全部文档合同 | artifacts/model-configuration/新证据；scripts/tui-preview.mjs、preview/fixtures必要适配；tests/tui/pty-execution.test.ts；README、AGENTS、CONTEXT、docs/architecture.md、interface-contracts.md、dev/tui-workbench.md、tui-implementation-handoff.md | D08生产画面/隔离启动/当前文档 | 旧资产不覆盖 |

## 4. 调用与副作用顺序

load权威配置→校验内存候选→credential metadata/CAS保存/回读→生成不可变引用→project CAS保存/回读→返回saved，失败保留输入。显式Coordinator apply→原switch checkpoint/migration→完整probe→registry绑定。Worker apply→保存role候选→重读scope/currentauthorization/graph/config→完整review→指纹/revision重验→原授权事务→返回accepted；不派发模型或Worker。Task dispatch→解析原或当前授权→persist materialization pin→intent→公开Orca mutation→readback；unknown沿原ID对账。

## 5. Schema、状态与持久化落实

D01 schema2拒绝旧格式。D04 Manifest2缺少modelbinding不准入。D05迁移16允许历史null但恢复明确阻塞；新记录有精确auth/profile，authorization仍append-only且CAS更新Scope指针。UI配置秘密不存ui.sqlite。credential和project错误固定安全code，不回显原始SDK/文件payload。无新依赖、provider白名单、GraphRevision或预算重置。

## 6. 验收证据矩阵

| Requirement/Scenario | IP-ID | 测试文件 | Fixture/前置条件 | 关键断言 | 可运行命令 |
|---|---|---|---|---|---|
| Immutable versioned model settings（全部）；凭据两场景 | IP-01/02 | tests/bootstrap/project-config.test.ts；新tests/configuration/model-settings.test.ts、tests/adapters/storage/credential-store.test.ts | 临时目录/真实文件CAS | v1拒绝/引用不可变/并发/权限/错误秘密隔离/保存不应用 | pnpm exec vitest run tests/bootstrap/project-config.test.ts tests/configuration tests/adapters/storage/credential-store.test.ts |
| Coordinator注入五场景、suspended保持 | IP-03 | tests/adapters/agents/chat-model-factory.test.ts、capability-probe.test.ts；tests/bootstrap/foreground-planning-runtime.test.ts相关现有测试 | controllable模型+temporarycredential | 最后解析/effort/能力失败不绑定 | pnpm exec vitest run tests/adapters/agents tests/bootstrap/foreground-planning-runtime.test.ts |
| reapproval两场景 | IP-04 | tests/application/authorization-service.test.ts；tests/bootstrap/execution-authorization.test.ts；tests/coordination-store.test.ts | 当前scope/graph/manifest | 新唯一授权/CAS/stale/idempotency/预算不重置 | pnpm exec vitest run tests/application/authorization-service.test.ts tests/bootstrap/execution-authorization.test.ts tests/coordination-store.test.ts |
| pin两场景 | IP-05 | tests/application/materialize-work-package.test.ts、advance-execution.test.ts；tests/bootstrap/execution-delivery.test.ts、foreground-execution-runtime.test.ts；tests/recovery相关 | 固定task/原auth/新auth/unknownrestart | 原任务配置/旧结果接受/跨代拒绝/utility独立 | pnpm exec vitest run tests/application/materialize-work-package.test.ts tests/application/advance-execution.test.ts tests/bootstrap tests/recovery |
| Codex启动两场景 | IP-03/05/07 | tests/adapters/agents/codex-launch.test.ts、codex-read-only-probe.test.ts；tests/tui/pty-execution.test.ts | fakechild观察与隔离真实Orca/MiniMax | model/effort/auth实收，argv/receipt无秘密，精确transcript | pnpm exec vitest run tests/adapters/agents/codex-launch.test.ts tests/adapters/agents/codex-read-only-probe.test.ts；显式real-env运行PTY |
| 定稿菜单四场景 | IP-06/07 | tests/tui/command-reviews.test.tsx、session-lifecycle.test.tsx、input-paths.test.tsx、no-side-effect.test.tsx；新增必要model-settings.test.tsx | 生产App、三档、CJK、latequeries | 独立effort/默认返回/编辑保留/原查询恢复/render无副作用 | pnpm exec vitest run tests/tui；pnpm ui:preview -- --help与文档capture命令 |

## 7. 文件清单与升级条件

以上IP表是生产文件allowlist；对应目录的既有测试fixtures、测试support配置构造和文档中同一schema例子允许同步更新，以typecheck确定实际调用方，不加入其他业务特性。新增测试只验证稳定行为。受保护：用户dirty README、references/orca、历史artifacts与归档报告。无删除文件计划。遇到需安装依赖、扩大角色生命周期、更改权限或重新设计原型才升级；普通DTO细化不超出已授权D01–D08。

## 8. 验收 Agent 授权与限定审计

全部tasks完成后固定HEAD与workspace diff交独立验收；可修复范围内缺陷，但不改规格掩盖缺口。审计：秘密传播边界、CAS/锁/原子文件、reapproval政策保持、Task原binding与generation/attempt、render无副作用与迟到焦点、六票逐画面对照。跑相关测试后一次pnpm typecheck/lint/test/build与openspec validate --strict、git diff --check。真实启动/画面缺失不得PASS。verification.md仅此时创建；不提交或归档。

## 9. 实施记录（2026-10-04）

IP-01–07及13项tasks已完成，输入/最终实现HEAD均为`8f6d1a7e6765a024191043b97fbded2d4a902207`，实现位于未提交工作区。受保护的`artifacts/pending-interactions/README.md`改动保留；未升级依赖、提交、切分支或归档。项目parser移至application/configuration作为唯一事实源，bootstrap/project-config保留公共重导出；属于IP-01/02既定模块owner落实。

| 范围 | 命令/证据 | 结果 |
|---|---|---|
| 静态检查 | `pnpm typecheck`、`pnpm lint`、`pnpm build` | 通过，日志`/tmp/companion-model-{typecheck,lint,build}-checkpoint.log` |
| 全量检查 | `pnpm test --maxWorkers 4 --reporter=default --reporter=json --outputFile.json=/tmp/companion-model-final-tests.json` | 156文件通过/1失败/6条件跳过；1650项通过/2失败/12条件跳过。唯一失败文件在测试期间继续改动候选规则，新断言读取了此前已载入的旧实现；不把该轮退出1写成通过 |
| 最终受影响复验 | `pnpm exec vitest run tests/tui tests/bootstrap/foreground-planning-runtime.test.ts tests/bootstrap/execution-finalizer.test.ts tests/bootstrap/project-config.test.ts tests/configuration --maxWorkers 4 --reporter=default --reporter=json --outputFile.json=/tmp/companion-model-affected-final.json` | 37文件/340项通过，2隔离真实检查条件跳过。按完整文件名用该结果替换全量对应文件，去重后163文件、1653项通过/12项条件跳过、零失败；普通真实PTY13项通过 |
| 格式/规格/入口 | `git diff --check`、`openspec validate complete-tui-model-configuration --strict`、`node scripts/tui-preview.mjs --help` | 通过 |
| 六票画面 | [release清单](../../../artifacts/model-configuration/release/samples.json)、[12组操作](../../../artifacts/model-configuration/release/checks.json) | 171对PNG/UTF-8文本，三档×两色×两图标及连续resize，旧资产未覆盖；六票逐项对照见[README](../../../artifacts/model-configuration/README.md) |
| 实际启动 | [real-startup.json](../../../artifacts/model-configuration/real-startup.json) | 隔离Orca/Codex调用MiniMax真实助手回合；精确SessionStart/transcript核验模型、low effort、隔离身份和认证路径，未记录key |

限定修复包括：项目格式化写入上限、凭据字段别名及opaque引用、Worker连接快照一致性、Harness登录拒绝新key、Bootstrap凭据注入、原Task授权绑定与批准重放、迟到审阅失败归属，以及候选引用/最新连接应用。URL认证信息由领域schema与modelOptions扫描共用规则拒绝，普通API版本参数保留；秘密审计独立复核通过。最新连接复用现有宿主/TUI行为检查，确认同provider/model只有一条可见候选、应用新连接且保持旧历史。没有新增公共状态或迁移。

用户可见布局的最终采集基于生产App与隔离fixture；本轮实际启动证据不扩大为所有provider/角色/恢复路径的真实集成。Ubuntu之外平台与新增OS输入法预编辑未验证。独立验收Agent为`gpt-6-luna`，已针对固定HEAD及当前工作区出具[verification.md](verification.md)，结论为PASS，无未决发现；验收只新增报告，未改产品代码。
