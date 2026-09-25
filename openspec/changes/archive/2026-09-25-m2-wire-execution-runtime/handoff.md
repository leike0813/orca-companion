# Handoff — `m2-wire-execution-runtime` 收口清单

本文件回答一个问题：**这个 change 还要做什么才能收口，每一步具体怎么做。**
权威事实源仍是 `tasks.md`（勾选状态）、`verification.md`（核验与证据）、`specs/coordinator/foreground-execution-runtime/spec.md`（行为合同）；
本文件只补充「下一步怎么做」以及环境/决策前置，不改变上述任何一个的结论。

## 0. 现状快照（2026-09-24 收尾时）

- 代码：HEAD `82b98e3`；**工作区 87 个文件未提交（含 20 个未跟踪），未创建任何 commit**（本 change 的全部改动都在工作区里）。
- 任务：`1.1–3.2`、`4.1` 已完成；**`4.2`（IP-08 真实闭环）未完成**。
- 门禁（当前工作区，全部通过）：`pnpm typecheck`、`pnpm lint`、`pnpm test`（134 files passed / 6 skipped；**1166 tests passed** / 12 skipped）、`pnpm build`、`openspec validate m2-wire-execution-runtime --strict`。
- 本 change 已修 **14 处**真实运行定位的宿主缺陷/可观察性缺口（逐条见 `verification.md`「本轮实现修复」1–14）；**仍有 3 处待办**（见下文 T1/T2/T3）。
- 真实运行证据留在磁盘：隔离项目 `/home/joshua/Workspace/Artifact/orca-companion-e2e2`（链路证到 Validator 结算 + 集成 `commit` 步通过）、`…-e2e6`（新项目物化 + 真实 Planner 会话）。
- 一次性工序脚本（`/tmp` 下，关机即失；逻辑见 T1.4）：`inject-segment.mjs`、`trigger-once.mjs`、`release-bench-lease.mjs`、`drive-e2e.mjs`。

## 1. 收口定义（Done 的判据）

本 change 收口 = 同时满足：

1. `4.2` 勾选，且 `verification.md` 有**真实运行**证据覆盖：授权 → Planner → Delivery 结算 → Admission → Implementation → Validator → **集成 `integrate_canonical`** → **Finalizer 结论或明确 blocker**；重启不重复派发。
2. T1/T2 的处理已落地（实现并测试）或已明确拆成后继 change 并在 `verification.md` 注明。
3. 全量门禁通过（`typecheck` / `lint` / `test` / `build` / `openspec validate --strict`）。
4. 完成后按流程 `openspec archive m2-wire-execution-runtime`，并在 M2 的 `5.2/5.3`（真实 PTY 验收）解除阻塞（**不在本 change 勾选它们**）。

## 2. 待办任务（按依赖排序）

> **进度（收口轮）**：T1、T2、T3 已实现并带测试（`verification.md` 第 15–18 条）；T4 已把真实链路推进到
> 「Planner 结算 → Admission 通过 → Implementation 派发开始」，随后被工序失误打断（驱动时释放了 Lease）。
> 只剩 T4（继续跑真实闭环）与 T5（收口动作）。

### T1 — 补记 Session Binding（✅ 已实现，schema 12）

**问题**（真实证据）：`recordRoleSession`（`src/bootstrap/foreground-planning-runtime.ts:3784`）只在「派发刚成功」的那次触发、且在 `bindingWindowMs` 窗口内读 Codex SessionStart 报告。窗口错过（派发的宿主进程先退出、报告晚落盘、诊断/驱动进程交替）后，`materialization_bindings` 有记录但**没有 Session Segment**；按 IC-08，这条派发的 Delivery 无法归因 → 宿主 blocker `dispatch_record_missing`，链路停在「Worker 已做完、结果无法结算」。fail-closed 正确，缺的是补记。

**为什么必须由宿主做**：Segment 是 Delivery 归属的必需事实（不是可选证据）。

**已实现**：`MIGRATION_12`（`materialization_bindings.launch_id`）、`sessionBindingFromStartReport` 与
`unboundRoleDispatches`、`reconcileUnboundRoleSessions`（在 `runExecutionTrigger` 里先于 Recovery 判定执行）、
`recordRoleSegment`（派发与补记共用）。真实运行里该补记已把一个错过的 Planner 绑定补回来并让 Delivery 结算。
下面保留最初的设计说明，供后续维护参考。

**步骤**

1. ~~**持久化定位事实（推荐方案，需一次小 schema 变更）**~~（已完成）
   - `src/adapters/storage/schema.ts`：新增 `MIGRATION_12`，给 `materialization_bindings` 加 `launch_id TEXT`（或 `report_path TEXT`）；旧行保持 `NULL`，读取时 fail-closed。
   - `src/application/ports/branch-coordination-store.ts`：`record-materialization-binding` 增加该字段（必填，writer/expectedRevision 不变）。
   - 写入点：`src/application/materialize-work-package.ts`（`task-created` 分支处）与 `src/bootstrap/foreground-planning-runtime.ts` 的角色派发路径（`roleIdentityOf` 已产出 `launchId`，直接带上）。
   - 合同同步：`docs/interface-contracts.md` IC-07（物化绑定记录的内容）与 IC-03（命令字段）。
2. **抽出可复用的绑定函数**
   - 把 `recordRoleSession` 中「报告 → `bindCodexSessionFromStartReport` → `record-session-segment`」这段抽成 `bindRoleSessionFor(binding)`：输入物化绑定（含 `launchId`）+ 图/Work Package 事实，输出 `null` 或结构化失败；`recordRoleSession` 改为调用它，行为不变（回归测试必须保持全绿）。
3. **在触发序列里对账**
   - `runExecutionTrigger`（同文件 `:5124`）在 `advanceExecutionOnce` 之前加一步：对当前图中**已派发但无 Segment** 的角色（物化绑定有 `launchId`、`snapshot.sessionSegments` 缺对应 `segmentId`）调用 `bindRoleSessionFor`。
   - 报告不存在时**不新增 blocker**（保持现状：交付结算时会以 `dispatch_record_missing` 呈现）；报告存在且校验通过才写 Segment，并通过既有 `publish` 发一次 `state-changed`。
   - 不新派发、不改 Attempt、不消耗预算：只用同一份事实补记。
4. **回退方案（不改 schema 时）**：在生产里枚举 `contractRevision × attemptIndex(0..N)` 计算候选 `launchId`，用 Codex 状态文件名 `sha256(launchId)[0:20]` **精确匹配**（不是按 mtime 找最新），再走同一条校验。工序脚本 `/tmp/inject-segment.mjs` 已证明可行；缺点是依赖内部编码，故列为备选。
5. **测试**（`tests/bootstrap/*` 与 `tests/recovery/*` 既有风格，用临时目录 + 真实 store + fake backend）：
   - 绑定窗口内报告到达 → 仍由派发路径写入 Segment（既有行为不回归）；
   - 窗口过后报告才到达 → 下一次触发补记成功，且 Delivery 随后可结算；
   - 报告不可达 → 不写 Segment、不新增 blocker、不重复派发；
   - `launch_id` 为 `NULL` 的旧行 → fail-closed，不猜。

**验收证据**：上述测试 + 一次真实运行（T4）里「补记后 Delivery 结算并推进到下一角色」。

**风险**：schema 迁移必须单事务、幂等；旧行读取必须阻塞而不是补造；补记必须复用同一 `segmentId` 派生规则（`derivedKey('segment', [scope, orcaDispatchId, attemptId])`）。

### T2 — Planner 产出纪律（✅ 已实现，真实运行已验证）

**问题**：Planner 两次都把 OpenSpec 单元写在**自选名字**的目录（`openspec/changes/e2e-loop-scope-g1-readme-banner`），第二次还缺 `specs/`；Envelope 固定的 `specificationUnitPath` 为空 → Admission 正确拒绝（`worktree_mismatch`）。宿主 fail-closed 已达标，缺的是让 Worker 按约定产出。

**已实现**：`TaskEnvelope.instructions` + `plannerSpecificationInstructions(path)`，宿主在角色 Envelope 组装处填充，
materialization 重新解析 Envelope 时原样保留。真实运行证据：加入指令后 Planner 直接把单元写在固定路径下并建出 `specs/`。

**步骤**

1. `src/domain/task-contract.ts`：给 `TaskEnvelope` 增加一个可选的、**面向 Worker 的显式指令**字段（例如 `instructions: readonly string[]`），并在 Planner 角色上由宿主填充固定三条：写在 `specificationUnitPath`、必须包含 `specs/`、不得改名或 `openspec archive`。Envelope 是 JSON，**不需要迁移**。
2. 渲染点：`src/bootstrap/foreground-planning-runtime.ts:3548` 附近（角色 Envelope 组装处）填充该字段；`task-create --spec <envelope JSON>` 就是 Worker 看到的任务正文，无需改 transport。
3. 合同同步：`docs/interface-contracts.md` IC-07；`specs/coordinator/foreground-execution-runtime/spec.md` 增加一个场景（Envelope 明示产出位置与结构）。
4. 可选（若仍不奏效）：把同样的约束写进 Worker Profile / 项目配置的 planner 段，或在 Admission 的 blocker 文案里直接给出「把单元移到 `<path>` 并补 `specs/`」的可执行提示——文案改进不构成合同变更。
5. **测试**：Envelope 解析/序列化往返含新字段；Planner 派发时该字段存在且内容固定（断言行为，不锁死文案细节）。

**注意**：不要用「Admission 放宽到接受任意活跃 change」来绕过——那会让 `specificationUnitPath` 的约束失效，并掩盖 Worker 偏差（已在 `verification.md` 第 7 条按归档场景做过最小放宽，不要扩大）。

### T3 — 机器可读的 CLI 看不到执行期 blocker（✅ 已按 (b) 实现）

**问题**：执行期 blocker（`repo_not_found`、`dispatch_record_missing`、`advance_idle`）只在**宿主自己的快照**里；同一条 Scope 上 `orca-companion status --json` 给的是 `blockers: []` + `executionReconciliation.reasons: ["cli-no-execution-observation"]`。TUI 不受影响（同进程），但自动化/排查会被误导（本会话为此多花很久）。

**已实现 (b)**：`status --json` 顶层 `projection` 字段（`store-only` + `missing` 列表）。若将来要做 (a)（把执行 blocker 落 store），按原计划单独变更。

**步骤（二选一，建议先做 (b)）**

- (a) 把执行 blocker 落成 store 事实（新表或在 lane 记录上扩展），`status` 直接投影；需要迁移与投影改动。
- (b) 在 `status --json` 输出里显式表达「执行 blocker 需要宿主观察」：`executionReconciliation.reasons` 已有该枚举，把它提升为顶层可读字段（例如 `executionObservation: 'host-only'`），并把宿主侧的 blocker 通过 `publish` 事件镜像到一个可读位置（M2 已有事件通道）。成本低，先满足「不误导」。

**验收**：`status --json` 在停滞 Scope 上能明确说明「执行 blocker 需宿主观察」或直接给出 blocker；测试断言该字段语义，不断言文案。

### T4 — 真实闭环跑到集成与 Finalizer（进行中；4.2 的真正内容）

**驱动方式与现场（续）**：`e2e9` 的失败根因是**播种测试的 vitest worker 子进程**在杀掉主进程后仍活着续租（`kill` 主进程不够，要连 `vitest.mjs` 的 worker 一起杀）；`e2e10` 是新开的干净项目，走**播种测试自己的循环**（不与其争租约）驱动，授权已完成（`execution_coordination` / `active` / `auth:…g1:1`，Run 见 `graph_generations`），等待其循环推出第一次派发。

**本轮已到达**：新隔离项目 `orca-companion-e2e7`（已 `orca repo add`）里 —— Planner 会话完成并产出合规单元 →
Session Binding 由补记写回 → Planner Delivery 结算 → Specification Admission 通过 → Implementation 派发开始。
**被打断的原因（工序）**：驱动脚本在宿主正在物化时释放了 Runtime Lease，`materialize-worker-start` 拿到
`released_lease` fencing 拒绝而停在该 lane。继续时要么在同一项目重新派发该 Attempt，要么换新 Scope，
并且**驱动期间不要释放 Lease**（宿主的 Lease TTL 只有 30s，宿主的 heartbeat 自己会续）。

**环境前置（缺一不可）**

1. 隔离项目（不要用主项目），并且**已登记进 Orca**：`orca repo add --path <canonical worktree>`（否则 `worktree create`/`worktree-list` 以 `repo_not_found` 失败——本轮已实测）。
2. 一个**活着的**专用协调终端作为身份（`ORCA_COMPANION_E2E_IDENTITY`）；终端的 Run 绑定可能被 Orca 清掉，用同一身份 `run-use` 重新绑定。
3. `COORDINATOR_SMOKE_API_KEY` / `OPENAI_API_KEY`（MiniMax）；Worker 为 Codex + `minimax-cn/MiniMax-M3`。
4. Finalizer 需要**可核验的只读 Codex 会话**：本机 `/tmp` 在 btrfs 上、bwrap uid map 失败 ⇒ 本机跑不出 deliverable，只能得到明确 blocker；要拿到真实 `deliverable` 结论需换主机/目录（或安装可用的 bwrap）。
5. **必须用全新 Scope**：旧 Scope 里 `settled` 且 `rejected` 的 git 集成 / Finalizer Task 的 intent 按设计会永久挡同一条 lane，重试不会发生（见 `verification.md` 后续事项）。

**步骤**

1. 用新 Scope 播种候选图 + Run（`tests/integration/foreground-execution-runtime.test.ts` 的 `ORCA_COMPANION_E2E_LOOP=1` 用例只对**无 Scope** 的项目生效），或按 `implementation-plan.md` 第 6 节的命令装配。
2. 用宿主驱动推进（不要在 TUI 之外另造推进路径）：启宿主 + 绑定 Run + 等 Lease + 每轮 `pause` / `resume` 触发一次推进；读**宿主快照**（`host.ports.snapshot`）看 blocker，不要只读 CLI。
3. 依次观察并记录：Planner（规格 + 提交）→ Delivery 结算 → Admission → Implementation → Validator → 集成 `commit` / `integrate_canonical` / `push` → Finalizer 的 `Delivery Verdict`。
4. 预期终点有两种都算 4.2 合格：**deliverable** 结论，或**明确且可核验的 blocker**（本机 Finalizer 大概率是后者：只读会话不可核验）。
5. 记入 `verification.md`：命令、真实标识（Run/Task/Dispatch/commit）、每一步的结论与失败时的 blocker 文案。

**时间预算**：一轮真实闭环 ~40–60 分钟真实模型时间；若中途改代码，需要重跑。

### T4.5 — `worker-start` 未知结果的对账（✅ 已实现，待真实观察）

**问题**：宿主在 `worker-start` 的 mutation 结果未知时被杀，intent 停在 `pending`；随后的对账以
`no_backend_request_id` 阻塞该 lane（`reconcileOperation` 只会用 `request-show`），于是 Worker 其实已经
跑起来并成功（`worker-list: succeeded`）、Session Binding 也已补记，但 WP 不再推进。
**步骤**：为「结果未知」的 `worker-start` 增加基于 **Orca 事实**的对账（该 Task 是否已有 Dispatch、对应
terminal 是否存在、SessionStart 报告能否证明），并确保 adapter 只要拿到请求标识就必须写进 intent。
**验收**：宿主在 worker-start 中途被杀 → **下一次物化尝试**按事实收尾（已由 `tests/application/materialize-work-package.test.ts` 覆盖）；
注意已经 `blocked` 的 lane 不会被追溯解锁——那需要新 Attempt 或人工解除，这也是为什么本轮 e2e8 停在 `blocked` 后只能换新 Scope 继续。

### 诊断坑（本轮踩过，避免重复）

- **两套词汇不要混**：投影里的 `workPackages[].state` 用 `admitting` 表示「尚未派发的 frontier 成员」，而领域判定
  `evaluateDispatchCandidate` 的 `lifecycleStage` 用 `frontier`；把前者直接喂给后者会得到
  `lifecycle_not_frontier` 的**假结论**。
- **不要用第三方进程替代宿主推进**：`pause`/`resume` 触发的推进只有在「Resume 真正发生状态迁移」时才跑
  `runExecutionTrigger`（`unchanged` 会提前返回）；因此驱动必须让控制状态真的从 paused → active。
- **租约**：宿主存活期间不要释放 Lease；杀播种测试时要连 `vitest.mjs` 的 **worker 子进程**一起杀，否则它会继续续租。

### T4.6 — 集成的「成功」是静默 no-op（本轮定位并修复，最危险）

**问题**：集成请求的 `branch` 传的是 canonical 分支，于是 `integrate_canonical` 在 canonical 里
`merge --ff-only <canonical>`——自我合并、退出码 0、回读一致，三步全部 `settled accepted`，而 canonical
分支与获批 ref 都没动。**e2e12 就是这种状态**（三个 `git-integration` intent 全 accepted，
`e2e12-integration`/`main`/`git ls-remote` 都还停在 baseline）。
**修复**：源分支改取该 Work Package 隔离 worktree 自己的分支（`integrationSourceBranchOf`，按 worktree 归属
注释定位），读不到即阻塞该 lane。
**验收（必须核验 Git 事实，不能只看 intent）**：集成后 `git log <canonical branch>` 出现 Worker 的提交，
且 `git ls-remote <remote> <approved ref>` 指向同一 commit。

### T5 — 收口动作（T1–T4 完成后）

1. 更新 `tasks.md`：勾选 `4.2`，把本轮证据浓缩为一段（细节指向 `verification.md`）。
2. `verification.md`：删除已结案的「后续注意事项」，把仍成立的（Planner 纪律若未并入 T2、Finalizer 本机限制）保留为**风险/限制**而不是未决项。
3. 全量门禁 + `openspec validate --strict`。
4. `openspec archive m2-wire-execution-runtime`（`verification.md` 定稿后再归档；归档前确认主 specs 的 delta 已被接受）。
5. 通知 M2 的 `5.2/5.3` 解除阻塞（不代勾）。
6. 视需要创建后继 change（若 T1/T2/T3 中有被拆出的部分）。

## 3. 需要用户拍板的决策

| # | 决策点 | 选项 | 建议 |
|---|---|---|---|
| D1 | Session Binding 补记方式 | (i) schema 12 持久化 `launchId`；(ii) 生产里枚举候选 `launchId` 精确匹配状态文件名 | **(i)**：契约层事实优于内部编码枚举 |
| D2 | Planner 纪律的落点 | (i) Envelope 指令字段（本 change 内做）；(ii) 拆成独立 change（Worker Profile/提示词） | **(i)**，否则 T4 还会被同一条门挡住 |
| D3 | CLI 执行 blocker 投影 | (a) 落 store（迁移）；(b) 显式标注「需宿主观察」 | 先 **(b)**，后续按需做 (a) |

## 4. 易踩的坑（都已实测，避免重复支付）

- **进度读法**：用宿主快照 `host.ports.snapshot(...)`；CLI `status --json` 没有执行观察（见 T3）。
- **Lease**：宿主被杀后 Runtime Lease 仍存活到 TTL（默认 ~5min），期间新宿主无法写入；工序释放需用同一 incarnation 身份 + 当前 fencing。
- **集成链核验基准**：三步各自核验自己的目标（commit=source、integrate/push=canonical）；不要把上一步的回读值顺延。
- **工具状态目录**：`.agents/`、`.codex/` 下的报告不算项目改动、不算越界、不参与 Finalizer 前后比较。
- **回执形状**：`task-create`/`worker-start` 的真实回执把身份放在 `task`/`dispatch` 下；解析只有一处实现（`ports/execution-backend.ts`），不要另写。
- **归档/命名**：Planner 可能把 change 归档或改名；Provider 只接受「同名唯一归档」的回退，改名仍会 fail-closed（正解在 T2）。
- **旧 Scope 会毒化重试**：`settled`+`rejected` 的 intent 永不重试；验证必须开新 Scope。
