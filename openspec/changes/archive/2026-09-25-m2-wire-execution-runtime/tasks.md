## 1. 授权与恢复入口

- [x] 1.1 按 IP-01 接通完整 Manifest 审阅、显式批准和当前图切换；运行 `pnpm exec vitest run tests/bootstrap/execution-authorization.test.ts`。
- [x] 1.2 按 IP-02 将前台 Session 与 `startCompanionStartup` 收敛为一次租约取得、执行期对账和 Resume 门；运行 `pnpm exec vitest run tests/bootstrap/foreground-execution-runtime.test.ts tests/bootstrap/startup-reconciliation.test.ts`。

## 2. 串行 Worker 生命周期

- [x] 2.1 按 IP-03 接通单步 Frontier/角色物化与执行态受控工具，稳定签发每个副作用的 OperationId；运行 `pnpm exec vitest run tests/application/advance-execution.test.ts`。
- [x] 2.2 按 IP-04 接通当前 Run 的 Delivery、Specification Admission、Validator 同 Session 修复与 Worker Session Recovery；运行 `pnpm exec vitest run tests/bootstrap/execution-delivery.test.ts tests/application/run-validation.test.ts`。

  Delivery 结算与 Validator 同 Session 修复复验已有生产接线。Planner 的 Task Envelope 固定 OpenSpec 路径；
  Codex SessionStart 报告经精确 transcript proof 签发 binding 后，宿主组装 Planner 就绪声明并调用
  `admitSpecification`，后续角色 Envelope 使用接纳返回的 Spec Binding。物化绑定的 schema 11 记录
  Task Envelope 身份和 Spec Binding，旧行保持 fail closed。

  Worker Session Recovery 的生产事实已接通：`createExecutionRecoveryFacts` 从精确 transcript 的
  `session_meta` 重新读出中断归属、用 `worker-list` + `terminal-list` 判存活、用 `worktree-list` 的
  归属注释 + `readWorkspaceFacts` 对账 workspace、只认已结算的 Orca 结果为原会话终态，并按已批准
  Manifest 的项目配置准备替代 Session 的 Codex 启动策略与 `worker-start` 回执解释（回执解释因此改为
  异步 seam）；角色级 Task 查找按 role + Attempt 命中，不再要求「只有一行绑定」。前台宿主在
  「Orca 明确报告该 Dispatch 已退出、且该角色同一次 Attempt 没有已接受结果」时按原 RecoveryId 续办
  一次（`unverifiable` 不触发，避免重复派发），结论落成 blocker 与语义事件。需要 Recovery Capsule 的
  角色仍以 `transcript_unavailable` 阻塞：Capsule 正文只能由受限 Utility Worker 经 IC-08 Delivery
  pipeline 回到应用层，该路径未接线时不建第二条 pipeline。

## 3. 集成与项目终态

- [x] 3.1 按 IP-05 修正 IC-08 Git 分目标读回合同并接通受控 Git adapter；运行 `pnpm exec vitest run tests/application/integrate-work-package.test.ts tests/adapters/git-integration.test.ts`。
- [x] 3.2 按 IP-06 接通新只读 Finalizer Session、运行前后工作区观察和独立 verdict；运行 `pnpm exec vitest run tests/bootstrap/execution-finalizer.test.ts tests/application/finalize-project.test.ts`。

## 4. 控制、真实验证与文档

- [x] 4.1 按 IP-07 接通 exact Worker stop verdict、原 ID 对账和提交后语义事件，更新合同与能力说明；运行 `pnpm exec vitest run tests/adapters/worker-stop.test.ts tests/coordination/scope-control.test.ts`。
- [x] 4.2 按 IP-08 在显式隔离项目及专用 Orca 身份中运行真实 MiniMax-M3 执行闭环（含一次 Recovery 或明确 blocker），并执行全量门禁；命令见 implementation-plan 第 6 节。本任务通过后仅为原 M2 的 5.2/5.3 解除阻塞，不在本 change 勾选它们。

  **真实运行证据（2026-09-24，共三轮；细节与逐条证据见 `verification.md`）**：隔离项目
  `orca-companion-e2e2`（分支 `m2-wire-e2e2b`）+ 专用身份 `term_61d0e12e-d2b2-43f6-b33a-04e4db092a23`，Worker 为真实
  MiniMax-M3 / Codex。
  - 授权：宿主从权威事实组装 Manifest，审阅显示 `Worker Sandbox codex=danger-full-access`，批准后 Scope 原子进入
    Execution Coordination 并取得唯一 Execution Lease。
  - 串行角色：隔离 worktree + Planner（产出 OpenSpec change 并提交）→ Delivery 结算 → Specification Admission →
    Implementation 派发与结算 → Validator 派发与结算 → 集成；三到四条 Delivery 全部走完
    `delivery-accept-result` → Orca 回读 → `delivery-ack`，Session Binding 由 SessionStart 报告 + rollout 经
    transcript proof 签发。
  - 第三轮（本变更最后一批改动）由真实运行定位并修复 14 处缺陷/可观察性缺口，全部带回归测试：
    Delivery 入口接受 Orca 规范形状、物化路径 CAS 重试、Resume 不与在途 intent 抢锁、集成 commit 步接受
    「Worker 已自行提交」、`integrate_canonical` 按 canonical 基准核验、Orca 回执解析收敛到唯一实现、
    Planner 归档后仍解析同一单元、工具状态目录不算项目改动、Recovery 触发要求「没有未确认 Delivery」、
    已结算的 Recovery 以 `source_completed` 收口、显式协调身份在新项目直接可用、空闲推进落成可观察原因。
    修复后在 e2e2 上 `git-integration-commit` 步真实通过（真实运行里首次达到集成步）。
  - 全新隔离项目 `orca-companion-e2e6`：`orca repo add` 之后物化（worktree/task/terminal/worker-start）与真实
    Planner 会话均成功；随后暴露两处**未修**缺口——(a) Session Binding 只在派发那一次建立，窗口错过即无法补记、
    该 Delivery 无法归因；(b) Planner 自选 change 名字且未写 `specs/`，Admission 按设计拒绝。
  - 收口轮（第四轮）：按 `handoff.md` 实现 T1（Session Binding 补记：schema 12 `launch_id` + 每次触发对账）、T2（Task Envelope 产出纪律）、T3（`status --json` 声明投影范围 store-only），并修正固定路径拼写（文件系统安全 slug + 规范优先/旧拼写兜底的读取规则）。真实运行 e2e7（已 `orca repo add`）证明：补记把错过的 Planner 绑定写回、Planner Delivery 结算、Admission 通过、Implementation 派发开始；随后因工序失误（驱动时释放 Runtime Lease）停在 `released_lease`。
  - 第五轮（收口继续）：按 `handoff.md` 修复 #20/#21/#22（Specification 规格树不算越界；`delivery-ack` 按 Orca 批次事实对账；**集成源分支不再是 canonical**）。e2e12 把链路推到了 **集成三步全部 settled accepted + Finalizer 派发**，并借此暴露了「自我合并」的静默 no-op（canonical 与获批 ref 都没有动）。e2e13 用修复后的构建重跑中。
  - **集成已在 e2e13 上真实走通**：三步 `git-integration-*` 全部 settled accepted，且 canonical HEAD `47776f6` 含 Implementation 的提交 `4c63071`、`git ls-remote` 的获批 ref 指向同一 commit。
  - **进度消息不再阻塞结果交付**（e2e14 真实运行取证）：Orca 的当前未确认批次只带 `heartbeat` 时，真实 `worker_done` 要等它被确认才成为当前批次；修复前宿主判成 `result_missing` 并永久阻塞 lane。现在这类批次按 `progressAcks` 确认（intent 保护、`unknown` 以「批次已推进」收尾），`worker_done` 解析失败仍 fail closed。
  - Planner 信封纪律补一条：`## Impact` 只能引用信封内路径（真实运行里它声明了 `orca-companion.json` 与 `openspec/specs/`，被 Admission 正确拒绝）。
  - **未决 Recovery 的原因已可观察**（e2e14 真实运行）：宿主报 `unverifiable` 时保持 `pending`、不消耗额度、不主张终态，同时把原因写成记录事实；`status --json` 显示 `blocked` 与原因（实测 `终端仍在已列举主机上存在`）。
  - **Recovery Capsule 报告回路已接线**（方案 a：Delivery 传输原语读回 + 正文按 `capsuleRef` 确定性落 Companion 状态根）：`extractCapsule` 先取 host 侧 transcript 证据，再以 `recovery-capsule-extraction` 信封 + 只读沙箱派发受限 Utility Worker，报告按 Orca 身份配对、按证据校验通过才交回 Delivery 身份，落盘回读后才确认。验证：`tests/recovery/capsule-dispatch.test.ts` 3 例通过；真实运行待新隔离 Scope（e2e14 的启动对账先被 Delivery blocker 挡住）。
  - 真实闭环（e2e15，隔离项目 + 专用 Orca 身份 + MiniMax-M3）：planner（规格落在 `specs/readme-banner/`）→ Specification Admission → implementation → validator → 受控 Git 三步（commit / integrate_canonical / push）全部 accepted，canonical `main` 与 remote `refs/heads/e2e15-integration` 同为 `ed98548`；Finalizer 的只读 Session 被派发并真实运行（终端 header 显示 `utility-readonly-local-control`），但它报告本机沙箱 panic：每条命令都是 `error building bubblewrap command: cannot establish app-server socket mount isolation`，五个 subagent 同样失败，因此**没有产出 verdict、也没有 worker_done**，按设计停在明确 blocker。命令与观测见 `verification.md`。
  - Finalizer 的 `worker-start` 已接入事实对账（`dispatchScopedWorker` → `runProtected.reconcileFacts`，用 `worker-list` 事实判定副作用是否发生），并有能守住该行为的用例。
  - 仍未取得真实结论：Finalizer 的交付结论。原因有二：既有 Scope 上该 lane 已被旧失败永久阻塞（不自动重试，需新 Scope 再跑）；且本机 `/tmp` 位于 btrfs，Codex 受限沙箱无法建立 bubblewrap uid map，而 Finalizer 固定只读沙箱，因此本机真实运行只能得到明确 blocker。`finalizer-not-authorized` 是 CLI `status` 投影缺 authority 事实的显示口径，宿主侧 gate 用的是 `manifest.permissions.finalizer = true`。
  - 全量门禁：`pnpm typecheck`、`pnpm lint`、`pnpm test`（134 files 通过 / 6 skipped，1169 tests 通过）、
    `pnpm build`、`openspec validate m2-wire-execution-runtime --strict` 全部通过。
