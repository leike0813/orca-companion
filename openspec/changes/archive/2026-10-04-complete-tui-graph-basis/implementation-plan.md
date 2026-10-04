# Implementation Plan

## 1. 实施基线与权威来源

Baseline mode: predecessor-contract。规划HEAD 41b2f1e636c110441a0a344fc20749911b085201，直接前驱archive/2026-10-04-complete-tui-project-statusline，已核对归档与主规格、初始dirty为空。冻结IC-11/12 ProjectDetailsPort、shared Validator summary、IC-13输入与IC-15偏好、生产adaptive/三栏目。来源为本change规格、D-01–06与六票定稿；实施漂移需重核对。

## 2. 复用与接缝

| IP-ID | 现有文件与符号 | 复用方式 | 禁止复制的事实 |
|---|---|---|---|
| IP-01 | graph-history、record-graph-version、JSON字段范围读取 | schema17原计划及只读历史查询 | 第二份图/状态机 |
| IP-02 | SpecificationProvider/readUnit、gh-tracker | 原生绑定与有界文件/来源读取 | 猜最新规格/旧tracker正文 |
| IP-03 | ProjectDetailsPort、validatorAcceptanceSummary、controller snapshot | 独立GraphBasisPort及原宿主装配 | Orca结果正文/重复摘要 |
| IP-04 | Inspector、ProjectPanel、App输入与返回 | 原定稿组件内下钻 | 第四栏目/新键位 |
| IP-05 | tuistory、PTY、既有benchmark | 隔离生产证据 | fixture冒充真实闭环 |

## 3. 代码变更映射

| IP-ID | Task | Requirement/Scenario | 文件与符号 | 精确变化 | 不得改变 |
|---|---|---|---|---|---|
| IP-01 | 1.1/1.2 | Retained original compilation plan；Append while reading | application/ports/branch-coordination-store.ts；storage/schema.ts、coordination-store.ts；planning/graph-history.ts | initialPlan事务、metadata目录/head/membership、原计划/patch/Manifest范围读取 | 旧历史、Task绑定、预算 |
| IP-02 | 2.1/2.2 | Bounded native specification reading；Long basis and source change | application/ports/specification-provider.ts；adapters/specification/openspec/provider.ts；planning/route-map-service.ts；adapters/tracker/gh-tracker.ts | 原生目录/范围与contract/tracking分离，tracker带版本正文 | 原admission/写tracker行为 |
| IP-03 | 3.1/3.2 | Traceable bounded execution basis；All-generation history | 新application/tui/graph-basis.ts、graph-basis-service.ts；bootstrap/execution-runtime.ts、foreground-planning-runtime.ts；application/controller-service.ts、execution/execution-view.ts、domain/planning/execution-graph.ts、application/tui/view-model.ts | 窄DTO/服务/精确来源；初始编译传计划；snapshot仅当前图与轻量链判定 | 当前结算规则、模型/派发门 |
| IP-04 | 4.1/4.2 | Frozen generation and return；Retired selection；Cross-screen return | interfaces/tui/ports.ts、app.tsx、state.ts；screens/workspace.tsx；components/graph-inspector.tsx、project-panel.tsx；必要新graph-basis-view.tsx | 有界目录/正文、选版Inspector和返回，迟到隔离及cache限额 | 六票布局、输入/偏好owner |
| IP-05 | 5.1/5.2/5.3 | 所有规格场景及D06 | 既有对应store/application/provider/TUI测试；tests/tui/pty-execution.test.ts、pty-handoff.test.ts、tests/support/real-env.ts；新artifacts/graph-basis/；必要scripts/tui-preview.mjs及preview/fixtures.ts | 行为/真实闭环/生产截图/性能 | 用户项目/全局runtime/旧工件 |
| IP-05 | 5.4 | 全部合同及进度 | AGENTS.md、docs/architecture.md、interface-contracts.md、dev/tui-implementation-handoff.md、dev/tui-workbench.md；artifacts/project-statusline/README.md；openspec/config.yaml | schema17/来源合同/第七批归档链接/用户当前批准的验收模型配置 | 历史报告与素材 |

## 4. 调用与副作用顺序

原plan解析/编译 → 原意图/Run序列 → initialPlan与v1同事务记录并回读。用户显式进入 → 校验Scope/注册Session/精确引用 → metadata/范围查询 → 原页面generation核验 → 有限帧展示；失败保留入口，重读仍沿原引用。文件先证明locator/contract，再按来源version范围读；变化返回stale不替换。阅读不写业务、不恢复模型、不派发。

## 5. Schema、状态与持久化落实

schema17仅追加initial_plan_json；initial新写必填，revision禁改；旧行NULL不可推断。不可变来源与Scope revision独立，mutable文件/外部正文带真实version。目录20项、正文64KiB、UTF8连续；cache8MiB/64项、页面返回仅标量。历史拓扑不消费当前frontier/workers/acceptance，包级保留任务无版本猜测。

## 6. 验收证据矩阵

| Requirement/Scenario | IP-ID | 测试文件 | Fixture/前置条件 | 关键断言 | 可运行命令 |
|---|---|---|---|---|---|
| Retained plan / Legacy missing / Append | IP01 | tests/coordination-store.test.ts；现graph-history测试 | 临时SQLite/旧schema | 原子、缺失、metadata分页不取整链正文 | pnpm exec vitest run tests/coordination-store.test.ts tests/application |
| Native tracking / Escaped path / Source change | IP02 | tests/application/specification-admission.test.ts；现tracker测试 | 临时unit/档案/symlink/长中文 | 精确绑定、越界拒绝、有界连续 | pnpm exec vitest run tests/application |
| Missing / bounded body / historic state | IP03 | 新tests/application/graph-basis.test.ts；现host-wiring/foreground测试 | 隔离fakeports/store | 来源版本、缺失、迟到、当前摘要不变 | pnpm exec vitest run tests/application/graph-basis.test.ts tests/tui/host-wiring.test.ts |
| Return / retired / readonly | IP04 | 现graph-inspector、no-side-effect、recovery、execution-handoff测试 | productionApp/受控promise | 多级返回、草稿/锚点、历史不借当前事实 | pnpm exec vitest run tests/tui |
| 全功能原型与性能 | IP05 | artifacts/graph-basis/采集与benchmark | 3尺寸×2色×2图标；SQLite+productionApp | 六票对照、1/5MiB与1千/万/10万记录、100采样p95≤100ms | pnpm build；node artifacts/graph-basis/capture.mjs；node artifacts/graph-basis/benchmark.mjs |
| 真实闭环与重规划 | IP05 | tests/tui/pty-execution.test.ts、pty-handoff.test.ts及本批隔离runner | 显式开关、专用身份、新仓库、用户当前批准的模型与连接 | execution/patch/retire/restart/recovery/Cutover历史可读 | 本批README记录带开关命令；pnpm exec vitest run tests/tui/pty.test.ts |

最终pnpm typecheck、pnpm lint、pnpm test --maxWorkers=4 --testTimeout=15000、pnpm build、openspec validate complete-tui-graph-basis --strict、git diff --check。原失败与条件跳过分别记录，受影响检查通过才结清tasks。

## 7. 文件清单与升级条件

新增文件为上表GraphBasis DTO/service、必要视图/行为测试和本批artifacts/OpenSpec；其余为修改，无计划删除。为schema17同步既有graph fixture构造可修改tests/support及相关store/application测试。IP-05 可修改 tests/support/real-execution-scope.ts，为新隔离现场显式传入唯一 Scope，旧 unknown 现场保留原 OperationId，不以重复默认身份重试。保护references/orca、归档change和原型素材。新依赖、重设计、任意路径读取、公开Orca能力缺口需要升级，不靠私有接口绕过。

## 8. 验收 Agent 授权与限定审计

IP-05 范围扩展（2026-10-04 用户明确批准）：修改 `src/adapters/agents/codex-model-launcher.ts` 的共享模型参数生成器，将 model 绑定统一编码为 `-c model=...`；修改现有 `tests/adapters/agents/codex-launch.test.ts` 与 `codex-read-only-probe.test.ts`，验证固定模型与 sandbox 参数兼容。当前安装的 Codex sandbox 不接受 `--model`，这是真实只读 Worker 验收的解阻塞修复；provider、effort、credential 与 permission profile 保持原合同。验证上述两文件、生产 doctor 与真实只读 Worker。

独立原生代理使用用户当前批准的模型；后续新现场为minimax-cn/MiniMax-M3.1-Flash-Preview，已启动现场保持原授权绑定。仅全部tasks完成并固定实现后创建verification。重点审计authority/source版本、跨代际身份、UTF8/缓存边界、历史无当前状态、返回/迟到隔离、真实证据与六票逐项对照。范围内修复允许，提交/归档不授权。

IP-05 第二项范围扩展（2026-10-04 用户明确批准）：`src/adapters/orca-cli/operation-catalog.ts` 的 worker-show 映射按当前公开响应读取 `worker.agentTerminalHandle`，调整 `tests/orca-backend.contract.test.ts` 既有契约用例，`docs/orca-compatibility.md` 追加 Orca 1.4.218 实测。真实 h 的原 Worker/Run/OperationId 保留，先对账再恢复，不通过换 ID 重派绕过 unknown；权限、exactWorker 核验和预算保持原合同。

## 9. 恢复后的验收记录（2026-10-04）

固定 Worker 字段修复后的全量162文件/1748项通过，6文件/12项条件跳过，exit0。IP-05 的真实阅读脚手架已修正 footer 裁切与 loading 首帧判断，原j现场7页、原i重启12页完整字段可读。原失败与i驱动终止exit143保留，不能把只读复验当作整个执行测试通过。

IP-03 的共享验收摘要仍使用同一Accepted Validator事实。真实运行发现逻辑Dispatch与Orca Dispatch不能直接相等比较；现经可核验 Session Segment 关联，原i记录显示2/2。现有execution-view测试28项，应用/宿主3文件47项，TUI5文件50项通过；typecheck/build通过。最新全量按独立日志记录。

i 的两个包已验证并受控集成，修订持有released，图v2为真实Accepted revise补丁。停调度后GraphBasisPort完整读取2版本/62正文，Scope revision不变。原问题revision145已在绑定回答入口作答，随后Pause并退出前台，Finalizer Verdict尚未取得。j首条Recovery生成Capsule并派发精确替代Session，同一Attempt预算1/1；替代Worker succeeded但结果未接受，还有第二条未决Recovery。Cutover原通过证据保留，不替代上述未完成路径。

IP-05第三项范围扩展（2026-10-04用户明确批准）：为GraphChangeRequest增加有界变化说明，request_graph_patch的输入schema/parser、request-graph-patch用例与graph-patch-planner指令完整传递语义；foreground接线及现有workflow/application/execution测试、PTY声明夹具同步。九项分类和权限规则不变，不将正文当成Scope/Run/operation identity。实现路径为src/domain/execution/change-routing.ts、src/workflow/coordinator/execution-tools.ts、src/application/execution/request-graph-patch.ts、graph-patch-planner.ts及上述现有宿主/测试。新隔离现场验证真实retire，既有i的revise历史保留。六票画面按报告限定，尚不创建verification或提交归档。

摘要修复后的固定全量162文件/1750项通过、6文件/12项条件跳过，exit0；独立日志test-after-summary.log。项目入口重采修复resize文件名重复后，12组合96条记录与96对独立PNG/TXT一致，exit0；新目录basis-path-2026-10-04T13-15-53-509Z。原13:00记录96条但独立文件72对，不再声称96对；旧目录保留。

第三项扩展已实现：必填 `changeInstruction` 为非空、最多4,000个Unicode码点，DTO/schema/parser和用例复验共用上限，完整说明进入Planner指令，原分类规则不读正文。现有foreground接线直接转发DTO，无额外接线修改。49项定向测试、typecheck/build与受影响lint通过。新的k现场通过doctor并派发Planner，但授权后的UI返回竞态使驱动失败（6通过/2失败/2跳过）；增加等待审阅异步返回后再关闭项目面板，旧大小写关键词断言修正。k原身份保留，生产依据回读1版本/6完整正文，Scope revision不变。l新隔离现场继续真实retire验收；Planner通过公开问答询问NOTES内容，由主会话按既定计划回答，单列人工说明。

IP-05第四项范围扩展（2026-10-04用户明确批准）：修复 `src/bootstrap/foreground-planning-runtime.ts` 的 `unboundRoleDispatches`，通过真实身份核验已存在Segment，不依赖Recovery与普通派发的不同Segment ID命名。原launch仅能用于未有Segment且Task只有唯一派发观察的首次补记；已知Segment属于另一Dispatch或多派发时不补签。Recovery替代Session仍由原receipt路径记录。扩展现有 `tests/bootstrap/foreground-execution-runtime.test.ts` 的选择行为用例，更新IC-09的Session Binding合同；不改schema、预算、Recovery状态或旧j记录，在新隔离现场复验。

画面专项在当前dist另存reviews-final-20261004与statusline-final-20261004，旧证据保持只读。全量字段修复后1751项通过、12跳过、2普通PTY退出检查失败（exit1）；同一PTY完整文件独立复验13项通过，原日志保留，最终固定检查待Recovery修复与真实验收结束后执行。

IP-05第五项范围扩展（2026-10-04用户明确批准）：原生 Worker 回报的共用 locator（`src/bootstrap/execution-runtime.ts`）排除 Orca `_orcaLifecycleRejection` 诊断载体，避免 Finalizer 将同 Dispatch 的拒绝诊断误当有效结论；扩展 `tests/bootstrap/execution-finalizer.test.ts` 的现有原生 JSON 回报行为用例。身份、只读与权威证据规则保持原合同，原 l 现场拒绝与重报记录保留。

IP-05第六项范围扩展（2026-10-04用户明确批准）：`src/application/materialize-work-package.ts` 用已有 binding identity 区分旧记录与 issued Utility 绑定，避免合法 Recovery Utility 行的 `role:null` 阻挡同包后续 Validator；扩展现有 `tests/application/materialize-work-package.test.ts` 的 worktree 复用行为用例。schema、权限、Attempt、Task 与预算不变；旧记录仍阻塞，不回填原现场。

IP-05最终检查脚手架：`tests/tui/pty.test.ts` 的退出探针等待 pane dead 与实际退出码同时可读，避免 PTY EOF 先于子进程退出通知时读取 null。原失败日志保留。交接 UI 用例在默认5秒时限下全量超时、独立复验6项通过；最终全量使用 `pnpm test --maxWorkers=4 --testTimeout=15000`，不改产品性能门槛或行为断言。

IP-05真实收尾：MiniMax n为retire、o为同Attempt Recovery/revise，均取得独立Finalizer deliverable；原PTY驱动各6通过/2失败/2阶段跳过、exit1。失败是旧fallback位置的reconcile断言，以及并排对话污染长verdict ID；驱动现通过窄屏独占项目详情读全文，在当前节点Inspector核验reconcile，退役节点只读历史不叠加当前运行态。原暂停现场复验6/13页详情、o当前Inspector及全部原身份字段，脚本exit0；两版图38/82项完整正文且Scope revision不变。读取重启后绑定、Segment、结算、预算和Verdict不变，旧日志未改写。n的公开督办与n/o绑定问答回答单列。零模型Cutover b的两代图、冻结状态与前代原计划证据保留。固定实现全量1756通过/12条件跳过，最终脚手架后的全量与静态检查另存；全部任务完成后才交独立验收。
