# Orca 兼容性基线

记录 Companion 依赖的 Orca 侧事实：上游源码快照、本机运行时版本、已经核验的能力，以及尚未验证的部分。运行时能力必须通过当前安装的 Orca 版本核验，不能从 submodule 源码推断。

## 上游源码快照

| 项 | 值 |
| --- | --- |
| 仓库 | `https://github.com/stablyai/orca.git` |
| 路径 | `references/orca`（Git submodule，只读） |
| 固定 commit | `de15227a1d321840ea35c6bb2d0cc01e3409e5f1` |
| commit 时间 | 2026-09-17T03:00:17-07:00 |
| commit 标题 | `feat(terminal): search match count + Cmd+F focus parity (#9035)` |
| 克隆方式 | `git submodule add --depth 1`，浅克隆，工作区约 280 MB |

该目录不参与构建、lint、测试与打包，边界见 `AGENTS.md` 第 3、4 节。

## 验证环境

| 项 | 值 |
| --- | --- |
| 操作系统 | Ubuntu 24.04.4 LTS（Linux 6.8.0-139-generic x86_64） |
| Orca CLI | 1.4.198，`/home/joshua/.local/bin/orca` |
| Orca runtime | `state: ready`、`reachable: true`、`runtimeId: f34e8953-f5ae-42b8-97db-90e33112562f` |
| Node.js | 24.12.0 |
| pnpm | 11.10.0 |
| 记录时间 | 2026-09-21 |

## 已核验

### CLI 与运行时基线

- `orca --version` 输出 `1.4.198`；`orca status --json` 报告 `runtime.state: ready`、`runtime.reachable: true`，并给出 68 项 `capabilities`。
- M0 依赖的四个能力令牌在本机存在：`orchestration.contract.v1`、`orchestration.worker-stop-verdict.v1`、`worktree.create-idempotency.v1`、`terminal.create-idempotency.v2`。
- 当前 `--help` 中，`worker-list` 只接受 `--run` 与 `--terminal-state` 过滤，`worker-stop` / `worker-abandon` / `worker-release` 不接受 `--from`；M0 operation catalog 已按这个安装版本收窄参数。
- `orca host list --json` 只返回一条 `kind: local` 的 host。当次 `orca terminal list --json` 返回 28 条终端，结果级字段为 `terminals`、`hostScope{hostIds,omittedHostIds}`、`topologyRevisions`、`totalCount`、`truncated`。
- `orca-companion doctor` 在无 TTY 管道中运行（2026-09-20）：退出码 0，机器报告只写 stdout，stderr 为空。它核验了可执行文件与版本、runtime 可达性、四项必需能力、local host、M0 操作目录依赖的 24 个公开命令，以及协调身份可取得性——一个由 CLI 自建、`connected` 且 `writable`、并属于本地 host scope 的终端句柄被 `run-current --from` 接受。

### JSON 外壳与错误语义

- 公开 JSON 外壳为 `{ id, ok, result | error{code,message,data?}, _meta{runtimeId} }`。顶层 `id` 是 Orca 的请求凭据，`request-show --request <id>` 与 `--retry-request <id>` 都接受它。
- `_meta.runtimeId` 为 `null` 表示请求没有抵达 runtime。实测：在未注册给 Orca 的目录里执行 `worktree current` 返回 `selector_not_found`，且 `_meta.runtimeId` 为 `null`。Companion 用它区分「可证明无副作用」与「已抵达但结果不可判定」。
- `request-show` 对未知或非法 request id 返回 `ok: true`、`state: "absent"`、退出码 0，并附 `interpretation` 明确写出 absent 不构成「什么都没发生」的证明。`state` 的公开取值为 `completed / pending / absent`。
- 已实测的错误码：`run_not_found`、`terminal_handle_stale`、`selector_not_found`、`invalid_argument`、`task_not_startable`、`stable_pane_required`。
- `check --wait` 每 15 秒在 stderr 写 `_keepalive` JSON 保活行，stdout 只输出一个 JSON 文档。

### 命令回执形状

- `check` 的结果为 `{ runId, deliveryId, messages[], count, timedOut, cancelled, connectionLost? }`；消息为 `{ id, run_id, delivery_contract, from_handle, to_handle, subject, type, priority, body, payload, thread_id, read? }`。`payload` 是 task / dispatch / attempt 归属的唯一来源，必须逐字保留。默认批次在 `--ack` 之前重复投递；`--peek` 只返回未读消息且不带 `deliveryId`。
- `worker-start` 的回执在 `result` 顶层给出 `{ runId, taskId, dispatchId, state, failedStage?, lastError?, effects[], residualResources[], nextCommands? }`；只有 `ready` 退出 0，`failed` 与 `outcome_unknown` 退出 1。
- `worker-show` 的字段大小写是混合的：`dispatch` 与 `worker` 用 snake_case（`task_id`、`agent_terminal_handle`、`worktree_id`），`observation` 与 `terminalResource` 用 camelCase（`observation.status`、`observation.exactWorker`、`terminalResource.releaseState`）。`observation.agentWait` 为 `null` 不构成已退出的证明。
- `worker-list --run <id>` 返回 `workers[]{dispatchId,taskId,runId,workerState,dispatchStatus,agentTerminalHandle,terminalState,resource}`，不需要调用方身份。

### 隔离控制闭环

- 2026-09-18 的独立探针记录了当时的事实：CLI 自建终端可作为协调身份；单 Worker 闭环、`worker_done` 归属、确认后不重放、Run/Dispatch 再绑定均成立；Codex provider transcript 绑定未通过（运行中与完成后为 `session_not_reported`，释放后只有 terminal archive）。细节见 `docs/research/m0-isolated-control-loop-probe.md`。
- 2026-09-20 用 Companion 的 `ExecutionBackend`（`ORCA_M0_PROBE=1`）在一次性仓库与专用身份中重跑了同一闭环：
  - Run `run_575ad2c85787`（`consumer_generation: 1`，协调终端 `term_f85e2f24-c3ac-4118-8d3d-c635808737cc`）；
  - 一个 Task 与一个受监督 Dispatch `ctx_638cea95a219`（`workerState: succeeded`、`dispatchStatus: completed`）；
  - Worker Profile 显式绑定 `minimax-cn/MiniMax-M3`，回执的 `start_options.launch.requested` 与 `effective` 一致；
  - `worker_done` 的 `payload.taskId` 与 `payload.dispatchId` 与当前对象一致，处理完结果后才 `check --ack`；
  - 无进程内状态的新调用重新绑定同一 Run，`worker-list` 仍只有这一个 Dispatch，确认后的批次不再重放。
  - M0 的协调者身份硬门因此通过：一个独立的前台进程可以合法地成为协调者。

### Codex transcript 启动隔离 PoC

- 2026-09-21 使用 Codex CLI 0.154.0 在 `/tmp` 一次性目录验证：将 `CODEX_HOME` 指向工作树内临时目录，在该状态根的 `config.toml` 中写入仅针对一次性项目的 `trust_level = "trusted"`，并为已核验的项目 SessionStart hook 传入进程级 `--dangerously-bypass-hook-trust` 后，hook 能上报 session ID、精确 transcript path、cwd 与该临时 `CODEX_HOME`；非 ephemeral 运行在临时状态根目录内创建唯一 rollout。
- PoC 前后 `~/.codex/config.toml` 的 SHA-256 均为 `f81d8fcf152445ce3d1354c4d91a8cf52622b8059f71d0c1e5d699f7496d6207`。探针只复制配置到隔离状态根，并以符号链接引用现有认证文件；工作树回收时临时配置、rollout 与链接一并删除。
- `--ignore-user-config` 或单次 `-c projects...trust_level=trusted` 不能提供“不写用户配置”的保证：Codex 0.154.0 实测仍会向用户 `config.toml` 追加该临时项目的 trust 记录。探针已精确移除新增块并恢复原哈希，因此产品路径不采用这两种方式作为写入隔离。
- Codex 侧可行路径固定为 worktree 内隔离 `CODEX_HOME`；启动方还须为该次进程传入 hook trust bypass。项目 trust 与 hook trust 是两道独立门，只有 bypass 而没有隔离配置中的项目 trust 时，Codex 仍会停在目录信任提示。
- Orca 1.4.198 无需增加按 Dispatch argv/env 字段即可承载这条路径：Companion 先用公开 `terminal create --worktree --command <fixed-launcher>` 启动隔离 harness，等待 `terminal wait --for tui-idle`，再用 `worker-start --terminal <exact-handle>` 让 Orca 正式接管。该版本可能在大段任务粘贴仍留在 Codex draft 时过早报告 `input_accepted`；Companion 仅在 `terminal read --screen` 读回非空 draft 时以固定 `terminal send --enter` 补交一次。真实探针读回 `exactWorker: true`，agent terminal handle 与预启动句柄一致，SessionStart 在接管并收到 Task 后触发，模型为 `minimax-cn/MiniMax-M3`。
- 预启动 terminal 在 Orca 中的 ownership 为 external；`worker-release` 不负责关闭它。Companion 必须保留精确资源绑定，并在 Dispatch 结算后显式 `terminal close`。探针已关闭全部 terminal、删除 4 条一次性 repo/setup 注册记录并回收磁盘目录。
- 2026-09-21 的 6.5 真实验收以 `operator_close` 终止 exact Validator terminal，SessionStart 与唯一 rollout metadata 签发完整 transcript coverage；受限 Utility Worker 通过继承 `:read-only` 的隔离 Codex permission profile 读取该 rollout，并通过本机 Orca 控制通道投递 `complete` Capsule。当前 Linux 环境禁止 bubblewrap 所需的 namespace，因此 Adapter 在该封闭 profile 下固定使用 Codex `use_legacy_landlock`；这些设置只写工作树内隔离 `CODEX_HOME`。

### 执行阶段只读查询（2026-09-23，`m2-deliver-execution-tui`）

- 前台 TUI 在执行协调模式下只提交两个只读查询，且都不需要协调身份：`worktree-list --repo path:<canonical worktree> --limit 1000`（按 worktree `comment` 与 `src/application/materialize-work-package.ts` 的 `workPackageComment` 归属标记匹配出每个 Work Package 的隔离 worktree）与 `worker-list --run <graph generation 的 orcaRunId>`（`workers[]{dispatchId,taskId,workerState,terminalState,agentTerminalHandle}`）。
- 两个查询的失败只记录为「不可用的观察」，不会被读成「没有 Worker 在运行」；`workerState` 未登记取值一律判为不可核验（fail closed）。
- Companion 侧判定：`workerState` 属 `running|active|working|in_progress` → `live`；属 `succeeded|failed|cancelled|exited|abandoned|completed|done|timed_out` → `exited`；其余（含 `null`）→ `unverifiable`。执行主机未被列举时，只有在「可能有角色级 Worker」的阶段才给出 `unverifiable`。

### 项目必须先登记进 Orca（2026-09-24 实测）

- 在任何 `worktree create` / `worktree-list --repo path:<canonical worktree>` 之前，该路径必须已经出现在 `orca repo list` 里；否则这些命令以 `repo_not_found` 失败，`terminal list --worktree path:<path>` 以 `selector_not_found` 失败。
- 症状与 remedy：全新项目上首次执行推进会在物化阶段停住，宿主 blocker 为 `rejection:repo_not_found`；`orca repo add --path <canonical worktree>` 之后同一 Scope 的物化立即成功（`materialize-worktree/task/worker-terminal/worker-start` 全部 settled）。
- 因此身份探测不能依赖 `terminal-list --worktree`：显式给出的协调身份必须直接可用（`run-current` 核验），否则新项目会先卡在「取不到身份」。这条已按 IC-09 的实现固定。

## 尚未验证

下列能力仍未核验，不能当作既成事实：

- provider transcript 的公共绑定（`worker-read --source transcript`）：2026-09-21 的真实 Validator 探针仍返回 `transcript_required / session_not_reported`；Codex Adapter 可改走已验证的 SessionStart + 隔离 `CODEX_HOME` 精确本地 transcript 路径。
- runtime 重启后的 terminal handle remint、provider session 续用与 `terminal_handle_stale` 的实际恢复路径；本机有无关 live workload，重启不在 M0 授权内。
- `consumer_generation` fence 生效后迟到 `worker_done` 的行为（2026-09-18 的 P5 未执行）。
- `worker-release` 之后的 archive 读取（本次探针按设计保留现场，未释放 Worker），以及 `release_pending` / `release_unknown` 的真实路径。
- `--effort` 与其它 provider 模型 id；本次只验证了 `--model minimax-cn/MiniMax-M3`。
- `terminal read` / `worker read` 的 `cursor`、`source_changed` 与 `fallbackReason` 语义。
- Windows 11 上的进程调用、路径与终端行为。
- **执行阶段的端到端闭环**（2026-09-24，`m2-wire-execution-runtime`）：在一次性隔离项目 `/home/joshua/Workspace/Artifact/orca-companion-e2e2`（分支 `m2-wire-e2e2`，专用于本机验收）上，用真实 Orca 后端与专用身份 `term_61d0e12e-d2b2-43f6-b33a-04e4db092a23` 完成了授权审阅/批准与**真实 Planner Worker 派发**：Work Package `e2e-loop-scope#g1:readme-banner` 取得隔离 worktree（`~/orca/workspaces/orca-companion-e2e2/wp-c0e65…`），Orca Task `task_6406bff5b29d` 与 Dispatch `ctx_bc6ced82be97` 成功，Codex `SessionStart` 报告与 rollout（`…/codex/921a9af0e56c4ca52071/sessions/2026/09/24/rollout-…jsonl`）经 transcript proof 签发精确 Session Binding 并记录 Session Segment，Planner 在 worktree 内产出 OpenSpec change 并提交 `cf60e9c`（`workerState: succeeded`、`dispatchStatus: completed`）。相对 09-23 的失败，本次证明「受限沙箱」不再是阻塞点：Worker 在 `danger-full-access` 下真实执行，provider、hooks、transcript 链路与角色 handoff 均可用。
  - **运行前置**：协调身份终端的 Run 绑定会被 Orca 清掉（`run-current --from <identity>` 变回 `null`，宿主因此停在 `deliveries_replayed`），需要用同一身份 `run-use --id <run>` 重新绑定；`workspaceDir` 必须是普通目录（见上一条）。
  - **本次实现修复**：Runtime Lease 心跳每 10s 续租并推进 Scope revision，原先会让「读 revision → 写 intent」之间的本地 CAS 写入被拒，把**已经发生**的外部 mutation（如已建立的 Orca Task）判成阻塞并永久卡住 lane。物化路径现按计划 §5「CAS 冲突重读事实重新决策」重读 revision 重试本地写入（`tests/application/materialize-work-package.test.ts` 的并发写入回归用例先失败后通过），Resume 也先等在途推进收尾再对账，避免自己的对账把在途 intent 判成未决。
  - **仍未走通**：Planner 的 `worker_done` 交付结算、Specification Admission、Implementation/Validator、受控集成与只读 Finalizer 的真实闭环尚未在本机跑通；本机无法提供可核验的只读 Codex 会话，Finalizer 交付因此只能停在 blocker（与 spec 的「只读无法核验即 blocker」一致）。
- **沙箱主机诊断**（2026-09-24，已被下一条取代）：当次记录的是 bwrap 无法建立 uid map（`kernel.apparmor_restrict_unprivileged_userns=1` 且发行版 `bwrap-userns-restrict` profile 未加载）。加载该 profile 后 bwrap 本身已可用。
- **Codex Linux 沙箱在本机不可用：`/tmp` 位于 btrfs 导致的上游判定失败**（2026-09-24，`m2-wire-execution-runtime`）：加载 `bwrap-userns-restrict` 后，`unshare --user --map-root-user /usr/bin/true` 仍失败，但 `bwrap --unshare-user --uid 0 --gid 0 --ro-bind / / --dev-bind /dev /dev --proc /proc /usr/bin/true` 与带 `--bind` 的写入探针均退出 0，即 bwrap 能力已恢复。随后 `codex exec --sandbox workspace-write` 仍然失败，原始错误为 `error building bubblewrap command: cannot establish app-server socket mount isolation`（`codex exec --json` 的 `item_3`）。按上游源码定位：该错误来自 `codex-rs/linux-sandbox/src/daemon_mounts.rs::check_mounts`，它把 socket 目录的 `st_dev` 与 `/proc/self/mountinfo` 的 `mount_device` 逐字比较，不一致即 fail closed；而共享 socket 目录由 `codex-rs/uds/src/daemon_directory.rs` 固定取 `canonicalize("/tmp")/codex-daemon-<uid>`，与 `TMPDIR`、`CODEX_HOME` 无关。本机 `/`（`0:27`）与 `/home`（`0:40`）都是 btrfs，文件 `st_dev` 为匿名 bdev（实测 `0:28`、`0:41`），两者必然不等，因此**任何** bwrap 沙箱调用（`workspace-write`、`read-only`、`--sandbox danger-full-access` 之外的路径）都在本机不可用；`--enable use_legacy_landlock` 在 0.156.1 已 deprecated，且只对「全盘可写」策略生效，不构成退路。实测 `--sandbox danger-full-access` 下命令可正常执行，说明 provider、hooks 与 transcript 链路本身没有问题。在 `bwrap` 内把 `/tmp` 换成 tmpfs 可让该判定通过（嵌套复现时错误消失），但嵌套 userns 又被 AppArmor 栈拒（`No permissions to create new namespace`）。**结论：真实 Worker 闭环在本机需要先让 `/tmp` 成为非 btrfs 文件系统（例如 tmpfs），或等待上游修复该 device 判定；在系统配置改变之前，Planner/Implementation/Validator 无法取得受限 shell。** 尚未改动系统配置，也不能据此认定真实闭环已通过。
- **接受 full-access 风险的隔离执行路径**（2026-09-24，`m2-wire-execution-runtime`）：项目配置新增 `execution.codexSandbox`（默认 `workspace-write`）。设为 `danger-full-access` 时，Execution Authorization 审阅只在 `acceptedRisks` 里存在 `codex-sandbox-danger-full-access` 时才可能通过，并把该模式作为 `Worker Sandbox` 一行显示给用户；角色级派发与替代 Session 还要求**已批准的 Manifest** 携带同一风险，因此放宽既不会悄悄生效，也不会在审批之后被一次配置改动带偏。Finalizer 不受该字段影响：它始终以 `read-only` 运行，本机因此无法取得可核验的只读会话，交付按设计停在 blocker。Recovery 的 Capsule 提取同为只读语义（信封 `authority.write=false`）：2026-09-25 的真实运行里该受限 Utility Worker 成功派发并启动，但因为启动策略用的是普通 `--sandbox read-only`（bwrap 路径），其每条 shell 命令都以 `error building bubblewrap command: cannot establish app-server socket mount isolation` 失败，读不到 transcript、也投不出 Capsule。修正：Capsule Worker 改用既有的 `read-only-local-control` 模式——它继承 `:read-only`、以 `--enable use_legacy_landlock` 建立受限会话，并开启本机控制通道所需的网络；真实验收用例（`real-validator-partial`、`real-patch-planner`）一向如此。**只读语义没有放宽**。Finalizer 同样切到 `read-only-local-control`（profile 继承 `:read-only`，比角色派发的 `danger-full-access` 更严，不属于放宽）。**2026-09-25 复测（e2e15）：该模式在本机仍然无法建立会话**——Finalizer 终端 header 已显示 `utility-readonly-local-control`，但其每条命令仍报同一个 bwrap panic，它派出的五个 subagent 亦然，最终自行报告「no artifact、no completion」。因此本机结论不变：**任何带沙箱的 Codex 会话都无法在本机执行**，只读路径（Finalizer、Capsule Utility Worker）只能停在这个明确 blocker 上；可行的解除方向是环境或策略二者之一：把 Codex 的 app-server socket 目录放到非 btrfs 文件系统（上游 `daemon_mounts.rs::check_mounts` 比对的是 socket 目录与 `/` 的 `st_dev`），或为这两条路径显式接受 non-read-only 沙箱（会失去只读保证，本 change 不采用）。
- **Orca worktree root 前置：`workspaceDir` 必须指向真实目录**（2026-09-24，`m2-wire-execution-runtime`）：真实闭环第一次尝试停在 `materialize-worktree` lane（intent `state=blocked`，原因 `no_backend_request_id`：副作用是否发生无法证明）。独立复现 `orca worktree create` 得到 `runtime_error: ENOTDIR: not a directory, stat '/home/joshua/orca/workspaces/<repo>/<name>'`：本机 Orca 全局设置 `workspaceDir = /home/joshua/orca/workspaces`，而 `/home/joshua/orca` 是一个 09-21 创建、当时没有任何进程持有的陈旧 unix socket，因此**任何**仓库的 worktree 创建都会失败。删除该陈旧 socket 后 `orca worktree create` 与 `worktree rm` 均即时成功（约 2s），lane 级 fail-closed 行为本身正确。真实闭环的运行前置因此是：`workspaceDir`（或它下面的目录）必须是可创建目录的普通路径。
- **`worker_done` 的真实载荷形状**（2026-09-24，`m2-wire-execution-runtime`）：真实 Codex Worker 完成时投递的 `worker_done` 载荷是 Orca 自己的规范形状（实测 `payload` 原文）：`{"taskId":"task_…","dispatchId":"ctx_…","outcome":"succeeded","filesModified":[…]}`，结果叙述在 `body`，`from_handle` 是 Worker 自己的终端。它**不**回显 Companion 的 Task Envelope 身份，也没有 `result` 字段。Companion 的 Delivery 入口最初只接受 Companion 形状，因此真实运行时每条 Delivery 都被判 `result_missing` → 归类 blocked → 不产生 `delivery-accept-result`/`delivery-ack`，闭环停在 Planner 交付之后；现已改为接受两种形状（Orca 规范形状只作 locator，用 `materialization_bindings.orcaTaskId` + Session Segment 逐项解析归属，结果正文归一化为 `{outcome, filesModified, summary}` 后写回 Orca Task 并回读）。修复后真实闭环连续前进：Planner、Implementation、Validator 三条 Delivery 全部结算成功并推进到下一角色。
- **受控 Git 集成的重放分支**（2026-09-24，`m2-wire-execution-runtime`）：真实闭环走到集成时，`git-integration` intent 收尾为 `rejected`，随后同一 Work Package 的再次尝试被阻塞，原因是 `integrateWorkPackage` 判定 `git-integration-commit:…` 的意图「尚无已接受的确定结果（settled）」——即 commit 步的 intent 已经收尾但不是 `accepted`，重放路径因此拒绝再次发起副作用（fail-closed 行为本身正确），但它只在进程内 blocker 里给出原因，重启后不可复现。下一轮需要：(a) 把这一步的首次结论与原因落成可持久观察的事实；(b) 让 commit 步能按 Git 事实对账「已经提交」（source HEAD 已变化 / canonical 已含该 commit），而不是把「已提交但没有 accepted 意图」永远读成阻塞。
- **`worker-stop` 的真实取词与错误路径**（2026-09-23，`m2-wire-execution-runtime`）：adapter 已按 Orca 回执提供 `WorkerStopPort`。本机对真实外部终端的 `ctx_8b0490f11440` 发出 stop，回执为 `stop_unknown`、`alreadySettled:false`、`processAction:none`，原因是外部终端未被关闭；因此只能判为 `unverifiable`。受管终端的 `stopped` 与取消后重启对账路径尚未实测。
- **执行期对账（Resume 前置）**（2026-09-23，`m2-wire-execution-runtime`）：已接线。Resume 先以原 OperationId 对账、再重放当前 Run 的未确认 Delivery，然后才写 `active`；对账不确定时 Resume 被拒绝且 lane 与原因可见。Resume 的 Worker liveness 核验仍未接线（缺少 Scope 级 liveness provider），未知不会被读作已退出。

## M0 门禁结论

协调者身份硬门通过，M0 必需能力齐备，`docs/orca-compatibility.md`、`doctor` 与隔离探针三者一致。`m1-recover-execution` 已实现共享 Worker Launch Strategy：Orca 原生启动和 prepared-terminal 两条路径共用一个封闭合同，Codex 适配器不写用户级配置，也不需要修改 Orca。

## 已知缺口

- prepared-terminal 以稳定 title 重定位 exact terminal，不把易变 handle 写入 Companion 数据库。terminal create 与必要的 draft submit 各用独立 Operation Intent；`worker-start --terminal` 后必须读回同一 exact handle。真实验收在 `worker-release` 后以 typed `terminal-close` 显式回收 external terminal。相关 provider transcript 缺口仍记录于 [stablyai/orca#21937](https://github.com/stablyai/orca/issues/21937)。

- `orca repo add` 不在 M0 登记的 26 个操作内，但隔离探针必须先把一次性仓库注册进 Orca 才能创建 worktree 与终端。探针把它当作夹具现场搭建，在 operation catalog 之外用同一受限进程边界直接调用；控制闭环本身全部经 `ExecutionBackend`。
- Orca 没有公开的 `repo remove`，`worktree rm` 也会拒绝受保护的 main worktree（`Refusing to delete protected worktree path`）。回收一次性探针仓库只能走 `orca project setup-delete --setup <repoId>`，它同时清掉注册的 repo 兼容记录；Orca 不会删除磁盘目录。
- 探针按设计保留现场，需要用户授权后才能清理。2026-09-20 已按授权回收全部 7 个一次性场景（2026-09-18 的 `.AAo1Yz`、本次五次运行，以及用户自跑的 `.KYmCtX`）：先 `worker-release` 结算 Worker，再 `terminal close --worktree <sel> --all`，再 `project setup-delete`，最后删除 `/tmp/orca-companion-m0-probe.*` 目录。repo、worktree、终端与磁盘目录均已归零，旧路径上的 `worktree show` 返回 `selector_not_found`。
- Run / Task / Dispatch 记录属于 Orca 运行事实，公开 CLI 没有单条删除入口，6 条探针 Run 仍留在编排历史里。`orchestration reset` 是全局破坏性恢复口，不用于清理。已释放 Worker 的 terminal archive 仍可经 `worker-read --dispatch <id>` 读回，回收没有丢掉探针证据。

## 变更规则

升级 submodule 是有明确目的的变更，需要同时给出对应 adapter 的回归结果。不要执行 `git submodule update --remote`。
