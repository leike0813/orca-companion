# Implementation Plan

## 1. 实施基线与权威来源

predecessor-contract：前驱 complete-tui-graph-basis，规划 HEAD 055c148bf037af825c6c099e38fda85317133731。开始前核验 archive/2026-10-04-complete-tui-graph-basis、主规格与冻结 IC-03/05/07/08/09/11/12；git 工作区初始干净。CONTEXT、architecture、interface-contracts 与本次 D-01—05 为输入，用户当前选择覆盖串行限制。

## 2. 复用与接缝

| IP-ID | 复用 | 禁止复制 |
|---|---|---|
| IP-01 | ExecutionLimits、parseManifest、graph compiler、ProjectConfigurationStore | 图和授权的并行额度副本 |
| IP-02 | BranchCoordinationStore.transact、Operation Intent、materializeWorkPackage、advanceExecution | 通用 scheduler 或第二生命周期 |
| IP-03 | integrateWorkPackage、Git steps、Codex prepared-terminal、精确 Session Binding、Delivery pipeline | Orca 状态机、猜测 transcript |
| IP-04 | TuiPorts、command registry、final dialogs、现有 review/CAS | UI 推进业务或持久化第二份配置 |
| IP-05 | Vitest fake harness、现有隔离真实执行测试 | 大屏 snapshot、私有 RPC |

## 3. 代码变更映射

| IP-ID | Requirement/Scenario | 文件与符号 | 精确变化 |
|---|---|---|---|
| IP-01 | Configurable concurrency、Compilation carries budget caps、Model-bound authorization | src/domain/planning/{budget-policy,execution-graph,execution-authorization,graph-compiler}.ts、src/domain/execution/graph-compiler.ts、src/application/configuration/project-config.ts、src/application/planning/authorization-service.ts | 额度 SSOT、schema3、Manifest3、有限集成复验预算、限定额度重授权 |
| IP-02 | Atomic lane admission、Restart before worker observation、Prepared terminal title changes、Lane-local blockers | src/application/{dto/operation-intent,ports/branch-coordination-store,ports/execution-backend}.ts、src/adapters/storage/{schema,coordination-store}.ts、src/application/{materialize-work-package,execution/advance-execution,execution/execution-view,worker-launch,coordination/intent-service,recovery/worker-session-recovery-service}.ts、src/adapters/agents/utility-worker.ts、src/bootstrap/foreground-planning-runtime.ts | schema19 reservation、CAS 准入/释放、共享候选选择、多包触发、原 terminal 回执定位与包级阻塞 |
| IP-03 | Merged-tree validation、Session/evidence mismatch、Budget exhausted | src/application/integrate-work-package.ts、src/domain/git-integration-policy.ts、src/adapters/git/integration.ts、src/adapters/agents/{codex-launch,codex-model-launcher,validator-runner}.ts、src/bootstrap/execution-runtime.ts、foreground runtime 的专用集成装配 | 续接 Task/Dispatch、精确会话、树证据、轮次预算、串行集成和 Finalizer 门禁 |
| IP-04 | execution-settings 全部 Scenario、Multiple active packages | 新增 src/application/configuration/execution-settings.ts、src/application/tui/{ports,view-model,project-presentation}.ts、src/interfaces/{cli/status,tui/commands,tui/app}.ts 及现有 dialog/statusline/sidebar/inspector 模块 | 保存/批准分离，多 active DTO，status JSON3，六票布局内编辑 |
| IP-05 | 全部 Scenario | tests/domain、tests/application、tests/configuration、tests/bootstrap、tests/execution、tests/tui 相关已有用例与 support fixtures；新增仅关键回归测试 | 有界准入/恢复/Git/TUI/真实并行证据 |

## 4. 调用与副作用顺序

读取注册/lease/当前授权/图/Orca/Git → 选择候选 → 事务准入 reservation → 持久 Intent → 外部 mutation → 核验/完成 Intent。未知保留身份与额度，只冻结归属 lane。派发逐项串行，Worker 后台并行。Git 同步后先 Validator 复验，再 Controller 提交/集成/推送；Finalizer 必须等待全部完成。

IP-03 的结果接缝还包括 `src/application/{worker-report-dto,delivery/process-delivery,reconciliation/replay-deliveries}.ts` 与专用 `integration-reconciliation.ts`、`src/bootstrap/integration-reconciliation-runtime.ts`。Worker locator/声称载荷只有一个应用层解析 owner；Delivery 确认以整批为单位，先逐条核验、结算与回读，再统一确认。复验提交绑定已验证的 tree OID；崩溃后沿原轮次、Task/Dispatch 和 Git 意图继续。

## 5. Schema、状态与持久化落实

执行默认 3/8/2；无硬上限 3。schema3 配置及 Manifest、schema19 store、status3。包 reservation 与集成 reconciliation 是不能从外部重建的最小事实；预算消费与稳定轮次注册同事务。原 terminal-create 的精确句柄随 Intent 结算，恢复重验资源且不重复 mutation。已有包在额度降低后保留 reservation。新 Task 固定新授权，已有 Task 仍按原模型绑定运行。无旧 Scope 回填、无新依赖。

## 6. 验收证据矩阵

| Requirement/Scenario | IP-ID | 测试/前置条件 | 关键断言 | 命令 |
|---|---|---|---|---|
| 配置/授权/编译全部 | IP-01/04 | domain、configuration、authorization 现有 fixture | 1/2/3/5、非法值、CAS、完整重批准 | pnpm exec vitest run tests/domain tests/configuration tests/application/authorization-service.test.ts |
| 准入/恢复/局部阻塞全部 | IP-02 | advance-execution、coordination-store、foreground runtime fake backend | 原子占位、不超额、不重复、不跨包互斥 | pnpm exec vitest run tests/application/advance-execution.test.ts tests/coordination-store.test.ts tests/bootstrap/foreground-execution-runtime.test.ts |
| 集成全部 | IP-03 | Git 临时 repo、精确 session fake 与真实隔离项目 | 分叉/冲突、原 UUID、轮次预算和证据 | pnpm exec vitest run tests/execution tests/bootstrap |
| 设置/多包投影全部 | IP-04 | TUI/CLI 现有生产 App 与 PTY | 保存失败保留输入、批准边界、多 active、resize 无副作用 | pnpm exec vitest run tests/tui |
| 真实闭环与检查 | IP-05 | 专用隔离 repo/身份，用户批准 MiniMax-M3.1-Flash-Preview | 至少两 Worker 同时 live，完整集成和 Verdict | 现有真实接受测试显式隔离开关；pnpm typecheck；pnpm lint；pnpm test；pnpm build；openspec validate restore-configurable-execution-concurrency --strict |

## 7. 文件清单与升级条件

允许 IP 表列出的生产模块、直接消费者、相关测试、AGENTS.md、CONTEXT.md、docs/architecture.md、docs/interface-contracts.md、docs/orca-compatibility.md、docs/dev/tui-implementation-handoff.md 与本 change 工件；新 UI 组件沿现有 final dialog seam。更新当前文档漂移，历史归档不改。保护 references/orca、依赖/锁文件、其他项目、用户数据及 Git 历史。缺少真实运行条件如实记录，不把跳过算通过。只在超出本次用户明确范围或公开能力缺口无法安全实现时升级。

## 8. 验收 Agent 授权与限定审计

按上述完整实现/测试范围核验；重点审计 admission CAS/未可见派发、authorization/task 模型绑定、merged-tree 证据、未知归属、TUI 写入副作用。未经完整证据不得标记任务完成，不在 apply 阶段创建 verification.md 或提交。
