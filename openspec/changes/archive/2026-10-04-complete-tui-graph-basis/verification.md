# Verification

## 验收对象

- Change：complete-tui-graph-basis（schema orchestrated-delivery，直接前驱 `archive/2026-10-04-complete-tui-project-statusline` 已归档并包含于 41b2f1e）
- 输入实现 HEAD：41b2f1e636c110441a0a344fc20749911b085201 + 未提交工作区（74 个已跟踪文件改动；`src/application/tui/graph-basis.ts`、`graph-basis-service.ts`、`src/interfaces/tui/components/graph-basis-view.tsx`、`tests/application/graph-basis.test.ts`、`tests/support/graph-basis.ts`、`tests/support/graph-plan-fixture.ts` 为新增未跟踪文件）
- 最终验收 HEAD：同上。验收期间未修改任何生产代码、测试、计划工件或证据；本文件是本次验收唯一新增内容（`git diff --check` 通过，工作区 dirty 全部保留）
- 验收 Agent：minimax-cn/MiniMax-M3.1-Flash-Preview（独立验收线程，与主线程并行；主线程固定实现并只整理交付记录）
- 固定实现检查的时间对齐：`src/`、`tests/` 下无文件晚于 2026-10-04 22:50 修改；固定全量 `test-final-retained-readback.log` 于 22:56:53 启动、23:04 结束，覆盖本次被验收的同一棵树

## 结论

**PASS**，边界为 Ubuntu 本机、当前冻结实现与既有隔离现场证据。

5 份 delta spec 的 9 条 Requirement 与全部 Scenario 均有实现与证据；12/12 实施任务对应 IP-01～IP-05；固定全量 162 文件 1756 通过 / 6 文件 12 条件跳过 / exit 0（`test-final-retained-readback.log`，440.01s），typecheck、lint、build、`openspec validate --strict`、`git diff --check` 均通过，其中 typecheck、lint 与 strict 由本次验收独立复跑确认（exit 0）。六项获批范围扩展的实现与既有行为测试一致。真实现场 n/o 各自取得独立 Finalizer deliverable，并由同一暂停现场的只读复验结清原 PTY 驱动的两项显示断言；原 exit 1、阶段跳过、人工督办与 UI 探针取得 Runtime Lease 等边界按原样保留，未被改写为通过。

没有范围内缺陷，没有待完成的必需审计，无遗留的 WARNING 或 SUGGESTION。唯一记录在案的观察是计划工件的模型措辞漂移，已由主线程按用户既有指示同步（纯文档变动，不涉及产品）。

### 覆盖记分卡

| 维度 | 状态 |
|---|---|
| Completeness | 12/12 任务、9/9 Requirement、9/9 Scenario 有实现与证据 |
| Correctness | 9/9 Requirement 实现与规格意图一致 |
| Coherence | 设计 D-01～D-06 全部落地；proposal 与 spec 的模型措辞漂移已同步 |

## 核验与修复证据

| Requirement / Scenario / IP-ID | 证据或命令 | 结果 |
|---|---|---|
| Retained original compilation plan（IP-01，任务 1.1） | `src/adapters/storage/schema.ts:12`（SCHEMA_VERSION 17）、`:621-640`（M17 nullable `initial_plan_json` + 目录索引）；`src/adapters/storage/coordination-store.ts:5264-5324`（initial 必须带 plan、`planRevision` 必须相等、accepted_revision 携带 plan 即拒绝）；`:6892-6904`（单命令单事务，失败回滚）；`src/bootstrap/execution-runtime.ts:267,353`（编译时解析计划并随 v1 提交） | 通过：计划与 v1 在同一 `BEGIN IMMEDIATE` 事务，校验先于 INSERT |
| Scenario: Initial record and restart | `tests/coordination-store.test.ts:3110`（超长中文计划经 64 KiB 分页完整重建，`JSON.parse` 等于原计划）；真实 `real-acceptance/basis-ip05-*-final.json` 跨进程读回 2 个版本 | 通过 |
| Scenario: Legacy record without plan | `tests/coordination-store.test.ts`「schema 16 之前的初始图没有原计划，按缺失呈现且不补写」；`coordination-store.ts:3750` 按来源判别联合选列，`initial_plan_json IS NULL` 直接返回 missing | 通过：不从当前 tracker 或编译结果回填 |
| 跨代际 metadata 目录 / head / membership（IP-01，任务 1.2） | `coordination-store.ts:4526-4566`（keyset `(generation, graphId, version)` 倒序、`LIMIT 21` 截 20）、`:3659-3662`（逐列点名的 metadata 投影，不带 `graph_json` / `patch_json` / `initial_plan_json`）、`:4505-4524`（graph-head 单行）、`:4571-4653`（membership 以一条聚合证明链连续，再只取请求的 ≤20 行） | 通过：目录不整链解码；链缺口、错父、head 不一致一律 fail closed |
| 依据 UTF-8 范围 64 KiB | `coordination-store.ts:3715-3790`（`length(CAST(... AS BLOB))` + `substr`；`initial_plan` 只认 v1、`graph_patch` 只认 accepted_revision；代际不一致抛身份错误，越界与非法边界报错）；`:175` `GRAPH_BASIS_MAX_BYTES = 65_536` | 通过：原计划按 JSON 原结构 BLOB 范围读，不先全文编码 |
| generation 状态只读登记值 | `coordination-store.ts:3682-3701`（`gg.status AS generation_status`，未登记为 `null`）；`graph-basis-service.ts:31` 归一为 `not_recorded` | 通过：同代际旧版本不被标成 frozen |
| Bounded native specification reading（IP-02，任务 2.1） | `src/adapters/specification/openspec/provider.ts:435`（realpath 限 worktree + unit）、`:602 listingOf`（20 项/页 keyset）、`:678 rangeOf`（单次上限、UTF-8 边界、offset 越界、源版本 stale）；`src/application/ports/specification-provider.ts:88,92`（`readFiles?` / `readFileRange?` 可选能力） | 通过 |
| Scenario: Native file and tracking progress | `provider.ts:466-484`（每工件独立内容版本，追踪件不参与契约 digest）、`:582-588 admittedOrChanged`（只有契约内容版本变化才拒绝） | 通过：契约绑定不因追踪进度变化失效 |
| Scenario: Changed contract or escaped path | `provider.ts:493`（stat 判定变化后重开重算 digest）、`:632-652`（绝对路径与 `..` 显式拒绝、realpath 复核）、`rangeOf` 的 `source_version_stale` | 通过：不选最新 unit、不暴露越界文件 |
| tracker 带版本正文（IP-02，任务 2.2） | `src/adapters/tracker/gh-tracker.ts:279-296`（`updatedAt` 缺失即 fail closed）、`:342-356`（沿用既有 transport 限额，截断即拒） | 通过 |
| GraphBasisPort 唯一只读 seam（IP-03，任务 3.1） | `src/application/tui/graph-basis.ts:42-54`（窄 DTO，来源判别联合与 read / unavailable / stale 三值）；实现 `graph-basis-service.ts`；装配见 `src/interfaces/tui/ports.ts` 与 `src/bootstrap/foreground-planning-runtime.ts` | 通过：与 IC-11 ProjectDetails 独立，无通用文件读取接口 |
| 来源身份、原授权与原规格绑定 | `graph-basis-service.ts:56-69`（Session 注册准入，generation 必须与记录相符）、`:235-241`（规格 ref 需 workPackageId / orcaTaskId / locator / contractRevision 全部匹配，否则 `not_recorded_binding`）、`:224`（tracker 只读配置的 `routeMapIssueRef`） | 通过：伪造 package / task / locator 被拒 |
| 批准时正文缺失与当前正文区分 | `graph-basis-service.ts:176-182`（`historical-tracker` 固定 unavailable；当前 Route Map 单独标注为非历史快照并带 tracker sourceVersion） | 通过：当前正文不冒充批准时内容 |
| 可变来源首次版本固定 | `graph-basis-service.ts:44-55,223-233`（tracker 正文按 key 缓存版本，续读版本不符即 stale）；`provider.ts` `rangeOf` 的 `sourceVersion` 比对 | 通过 |
| 双缓存 8 MiB / 64 项 | `graph-basis-service.ts:44-56`（tracker 正文缓存）；`src/interfaces/tui/components/graph-basis-view.tsx:32-35`（`BASIS_PAGE_ITEMS=20`、`BASIS_BODY_BYTES=64KiB`）与 `:103-152`（`BoundedCache` 及正文、布局两个实例） | 通过：返回只保存标量身份与位置 |
| `retained_task` 不按时间归版本 | `graph-basis-service.ts:219-222`（body 注入 `versionAttribution: version_unprovable` 并写明图版本归属不可证明） | 通过 |
| snapshot 只带当前拓扑（IP-03，任务 3.2） | `src/application/controller-service.ts:1074-1086`（只投影 Scope 指针精确命中的一条）、`src/domain/planning/execution-graph.ts:124` + `src/application/execution/execution-view.ts:527`（宿主注入轻量成员事实 `approvedGraphVersions`）、`src/bootstrap/execution-runtime.ts:818,850`（改用 `graph-head`）、`foreground-planning-runtime.ts:2643-2649` | 通过：生命周期结算规则未变，共享 Validator 摘要仍用同一 Accepted 结果 |
| All-generation read-only graph history（IP-04，任务 4.1） | `graph-basis-service.ts:105-131`（frontier 为空、节点运行字段置 null / unknown，retired 只来自所选版本的 accepted patch） | 通过：历史图不借当前 frontier、Worker、预算与验收 |
| Scenario: Frozen generation and return | 真实 `basis-ip05-cutover-20261004b.json`（g1 frozen、g2 active、`historicalRuntimeOverlay:false`）；`tests/tui/graph-inspector.test.tsx:272,317`；`tests/tui/recovery.test.tsx:99-140` | 通过：返回后仍是同一节点与栏目 |
| Scenario: Retired selection | `graph-basis-service.ts:120-128`（无退役证明时只显示该版本没有所选工作包）；`tests/tui/no-side-effect.test.tsx` 退役目录用例；真实 n 现场 `patchShape: retire`，退役节点只读历史 | 通过：不自动改选其他包 |
| Bounded historical navigation；Scenario: Append while reading | `coordination-store.ts:4526-4566`（keyset 追加只出现在自己的页）；`src/interfaces/tui/app.tsx:705`（请求计数 + Session + 顶层 frame key 三重 ownership）；`tests/tui/no-side-effect.test.tsx:242`（迟到目录响应不覆盖已返回页面） | 通过 |
| 有界正文、翻页与 resize（IP-04，任务 4.2） | `app.tsx:795-816`（续读接上次 end、缓存命中不重读）、`:1046-1065`（resize 只重排当前范围并按 `basisReflowScroll` 保持可见位置）；`tests/tui/no-side-effect.test.tsx:189`、`tests/tui/graph-inspector.test.tsx:47` | 通过：resize 不发起读取、不写协调状态 |
| Scenario: Long basis and source change | `tests/tui/no-side-effect.test.tsx:104-130`（首次 `[null, observed-v1]`，续读拒绝替换正文并显示变化）；真实 n / o 分别完整读回 38 / 82 项正文且 Scope revision 不变 | 通过 |
| Scenario: Missing historical text | `graph-basis-service.ts:176-182`；`coordination-store.ts:3766-3772`（缺行或列 NULL 一律 missing，不返回空正文） | 通过：引用仍可见，缺失显式 |
| Scenario: Cross-screen return | `app.tsx:855-861`（项目面板入口恢复原 tab / detail / selectedKey / scroll）；`tests/tui/recovery.test.tsx:47-98`（草稿与 Session 不变）、`:99-140`（Inspector 选择与栏目保留） | 通过 |
| 真实闭环 / Cutover / 历史可读（IP-05，任务 5.3） | `real-acceptance/verified-ip05-retire-20261004n-final.json`（2 版本 38 正文、deliverable，绑定 / Segment / 结算 / 预算 / Verdict 未变）、`verified-ip05-recovery-20261004o-final.json`（2 版本 82 正文、1 条 Recovery、deliverable）、`inspector-ip05-recovery-20261004o-final.json`（`requiredBaselineHead == observedHead`、`severity: canonical_advance`）、`cutover-only-ip05-cutover-20261004b.log`（1 passed / 9 skipped、exit 0、两 Run 两代图、g1 冻结、358 字节原计划可读） | 通过（范围见「后续注意事项」） |
| 六票生产画面（IP-05，任务 5.1） | `artifacts/graph-basis/prototype-review.md` 与 `screenshots/`：主矩阵 216 样本记录 / 192 独立 PNG+TXT 对，`basis-path-…13-15-53-509Z` 96、statusline 114（116 记录）、reviews 108、project-content 36；本次抽查 `capture-2026-10-04T12-05-42-262Z/plan-body-first-range-80x24-color-nerd.png` 确认三栏面包屑、来源版本、JSON 原文与既有键位提示 | 通过：差异按 `git diff 41b2f1e -- src/interfaces/tui` 归因前驱，未重新设计六票 |
| 规模性能（IP-05，任务 5.2） | `artifacts/graph-basis/performance.md`（`node artifacts/graph-basis/benchmark.mjs --run` exit 0）：1k / 10k / 100k 版本与 1 / 5 MiB 正文、每档 100 采样；input p95 最大 30.134ms、缓存版本导航 24.914ms、缓存正文导航 19.422ms，均 ≤100ms；冷读、全扫描与 RSS 单列 | 通过 |
| 合同、进度与检查（IP-05，任务 5.4） | `AGENTS.md:196-198`、`docs/architecture.md:129`、`docs/interface-contracts.md`（IC-05 / 06 / 09 / 11 / 12 与新增「第八批 IC-03/05/06/11/12 图历史与依据阅读扩展」）、`docs/orca-compatibility.md`（Orca 1.4.218、Codex 0.159.0-alpha.3、`worker.agentTerminalHandle`）、`docs/dev/tui-implementation-handoff.md` | 通过：与实现一致，无残留前驱漂移 |
| 探针隔离与模型显式固定（testing/isolated-control-probe） | 现场使用专用身份、Run 与隔离仓库（如 `term_fe6ca06d-…`、`term_dc1f1d09-…`）；`real-acceptance/usage-ip05-*-final.json` 显示 `modelIds: [minimax-cn/MiniMax-M3.1-Flash-Preview]`、无法无歧义计数的 `requests` 保持 `unavailable`、未按 launch 绑定的会话单列 `unbound`；`tests/tui/pty*.test.ts` 以显式开关与条件跳过 | 通过：未触碰用户主项目或全局 runtime，不推断请求数与费用 |
| 扩展 1：sandbox 与 Worker 共用 `-c model=` | `src/adapters/agents/codex-model-launcher.ts:205-212`；`tests/adapters/agents/codex-launch.test.ts:274,312` 断言 `model=MiniMax-M3` | 通过：provider / effort / 凭据与 permission profile 合同未变 |
| 扩展 2：公开 `worker.agentTerminalHandle` | `src/adapters/orca-cli/operation-catalog.ts:516`；`tests/orca-backend.contract.test.ts:550,561`；`docs/orca-compatibility.md` 记录 1.4.218 实测与 h 现场原响应 | 通过：exactWorker 与缺字段不推断存活或派发失败 |
| 扩展 3：4,000 码点 `changeInstruction` 完整传到 Planner | `src/domain/execution/change-routing.ts:18-22`（唯一上限与校验）、`src/application/execution/request-graph-patch.ts:195-199`（副作用前拒绝）、`src/workflow/coordinator/execution-tools.ts:280-345`（schema + parser）、`src/application/execution/graph-patch-planner.ts:137,156-157`（说明与分类分离）；`tests/execution/request-graph-patch.test.ts:166` 断言 Planner 收到原文，`tests/workflow/execution-tools.test.ts:359-386` 覆盖合法、空白与 4,001 边界 | 通过：分类与权限规则不读正文；文本不提供 Scope / Run / OperationId |
| 扩展 4：`unboundRoleDispatches` 精确补记 | `src/bootstrap/foreground-planning-runtime.ts:702-756`（issued + launchId + 图内、该 Task 唯一派发观察、无同 role / task / attempt Segment 才入选，再由 `sessionBindingFromStartReport` 证明身份）；`tests/bootstrap/foreground-execution-runtime.test.ts:1315-1364` 覆盖已有 Segment、替代 Segment、错 Dispatch、多派发、无 launchId、无观察六种否定 | 通过：不换 ID 重派，不误绑替代 Session |
| 扩展 5：`_orcaLifecycleRejection` 不作有效载体 | `src/bootstrap/execution-runtime.ts:1040`（该字段直接返回 null 交回 Companion 解析）；`tests/bootstrap/execution-finalizer.test.ts:166-176,883` 参数化「先有拒绝诊断」仍接受有效 Verdict | 通过：后续有效回报仍需完整匹配 Task / Dispatch / 角色 / 证据 |
| 扩展 6：issued Utility `role:null` 不误挡 Validator | `src/application/materialize-work-package.ts:219`（按 `identity === 'legacy'` 判定，legacy 要求四列身份与 role / utility_role 全空）；`coordination-store.ts:2999-3031`；`tests/application/materialize-work-package.test.ts:467-478` 参数化有 / 无 Utility 绑定复用 worktree | 通过：旧记录仍阻塞，schema / 权限 / Attempt / 预算未变 |
| 固定实现全量与静态检查 | `checks-20261004-resume/test-final-retained-readback.log`（162 passed / 6 skipped，1756 passed / 12 skipped，440.01s）、`typecheck-final-readback.log`、`lint-final-readback.log`、`lint-retained-evidence.log`、`build-final-utility.log`、`strict-final-readback.log`；本次独立复跑 `pnpm typecheck`（exit 0）、`pnpm lint`（exit 0）、`openspec validate complete-tui-graph-basis --strict`（valid）、`git diff --check`（通过） | 通过：证据与被验收工作树一致 |

验收阶段未做任何修复：无。

### 问题（按优先级）

无遗留问题。记录在案并已结清的一项：本验收曾记录 `proposal.md:25` 写 gpt-6-luna、而 `specs/testing/isolated-control-probe/spec.md`、`design.md` D-06、`tasks.md` 5.3、`openspec/config.yaml`、`docs/orca-compatibility.md` 与真实证据（n / o 全部为 minimax-cn/MiniMax-M3.1-Flash-Preview）为 MiniMax。主线程随后按用户既有 MiniMax 指示同步了该行，属纯文档变动，未触及产品行为。复读确认 change 目录内已无相互矛盾的模型表述：`design.md:33` 保留的 gpt-6-luna 是「已启动现场保持原授权绑定」的历史说明，与 spec 一致。归档无需再处理。

## 限定审计

| 审计范围 | 结论 | 证据 |
|---|---|---|
| authority / source 版本 | 通过：不可变来源以精确身份为内容身份；可变来源（tracker、规格文件）以自身版本令牌固定首次读取，续读不一致即 stale，不替换版本 | `coordination-store.ts:3715-3721`、`graph-basis-service.ts:223-233`、`provider.ts` `rangeOf` 的 sourceVersion 比对 |
| 跨代际身份 | 通过：目录按 (generation, graphId, version) keyset；membership 需存储证明；正文读取校验 recordKind 与代际，错代引用报身份错误而非「缺失」 | `coordination-store.ts:4541-4566`、`:4571-4653`、`:3774-3790` |
| UTF-8 与缓存边界 | 通过：单次 ≤64 KiB 并有 4 字节下限、边界回退；目录每页 20；正文与布局各 8 MiB / 64 项 | `graph-basis-service.ts:251-256`、`graph-basis-view.tsx:32-35,103-152` |
| 历史图不含当前状态 | 通过：历史 GraphView 的 frontier 为空、运行字段为空，retired 只来自所选版本 accepted patch；验收摘要仍用当前 Accepted Validator 事实 | `graph-basis-service.ts:107-128`、`tests/tui/graph-inspector.test.tsx:317`、真实 `basis-*-final.json` 的 `historicalRuntimeOverlay:false` |
| 返回与迟到隔离 | 通过：三重 ownership（请求计数 + Session + 顶层 frame key）；resize 只重排并保持可见来源位置；返回恢复原栏目、对象、滚动与草稿 | `app.tsx:705-711`、`:855-861`、`:1046-1065`；`tests/tui/no-side-effect.test.tsx:101-292`；`tests/tui/recovery.test.tsx:46-140` |
| 真实证据与六票逐项对照 | 通过（限定）：抽查一张 80×24 正文画面确认三栏、面包屑、来源版本与既有键位；报告已把英文标题、计数与 idle 相位等差异按 `41b2f1e` 归因前驱，未重新设计六票 | `prototype-review.md`、`screenshots/capture-2026-10-04T12-05-42-262Z/` |

## 后续注意事项

- 原 PTY 驱动 n / o 各自 exit 1、6 通过 / 2 失败 / 2 阶段跳过；两项失败分别是旧 fallback 位置查找 reconcile、与并排对话污染长 verdict ID。结清方式是同一暂停现场的只读复验（生产详情分页、当前节点 Inspector、只读权威端口），不是重跑转绿。归档时不得把这两份日志改称整份通过。
- n / o 是有人工监督的前台流程：n 经公开消息督办一次并回答绑定问题 / revision 143，o 在 revision 157 回答继续。UI 探针启动会取得 Runtime Lease，因此不能宣称整个启动零写入；只读页面不恢复模型、不派发 Worker。
- Cutover-only 现场 b 为 1 passed / 9 阶段跳过、exit 0，没有 Worker 或模型调用，只证明两 Run / 两代图、g1 冻结与 358 字节原计划可读，不能计为执行、补丁、退役或 Recovery 的通过。
- 6 文件 12 项为显式开关下的条件跳过（M0 隔离探针、Coordinator / Planning 模型 smoke、独立真实 Patch / Cutover / Validator、PTY 隔离入口），不得按通过计。最终全量使用 `--testTimeout=15000` 只放宽行为测试时限，产品 100ms 性能门槛未变。
- 性能记录使用 fixture ports 与合成历史行；冷读、全扫描与 RSS 为描述性数据，报告已列明限制；`p95 ≤ 100ms` 按 issue #53 口径核对。
- 六票样本记录数与独立文件对不一致（216 / 192、116 / 114），对外只引用独立 PNG / TXT 对；旧采集目录与失败日志保持只读。
- 平台证据限 Ubuntu；本次没有新增 OS 输入法与候选窗人工证据，Windows、无人值守与原生迁移未验证。请求数与费用不可证明时保持 `unavailable` / `unbound`，不推断。
- 「进入依据后 resize 再返回」的跨屏路径由两个既有用例组合覆盖（依据正文 reflow 与项目面板原栏目 / 草稿恢复），未新增端到端组合用例。若后续要防该组合回归，宜在既有 TUI 行为测试中扩展，而不是新建测试套件。
