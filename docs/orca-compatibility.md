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
- 2026-09-21 的 6.5 真实验收以 `operator_close` 终止 exact Validator terminal，SessionStart 与唯一 rollout metadata 签发完整 transcript coverage；受限 Utility Worker 通过继承 `:read-only` 的隔离 Codex permission profile 读取该 rollout，并通过本机 Orca 控制通道投递 `complete` Capsule。该 profile 与启动参数只写工作树内隔离 `CODEX_HOME`；只读语义由 Codex 当前的文件系统受限实现提供，Companion 不指定沙箱后端（见「只读 Worker 能力」一节）。

### 执行阶段只读查询（2026-09-23，`m2-deliver-execution-tui`）

- 前台 TUI 在执行协调模式下只提交两个只读查询，且都不需要协调身份：`worktree-list --repo path:<canonical worktree> --limit 1000`（按 worktree `comment` 与 `src/application/materialize-work-package.ts` 的 `workPackageComment` 归属标记匹配出每个 Work Package 的隔离 worktree）与 `worker-list --run <graph generation 的 orcaRunId>`（`workers[]{dispatchId,taskId,workerState,terminalState,agentTerminalHandle}`）。
- 两个查询的失败只记录为「不可用的观察」，不会被读成「没有 Worker 在运行」；`workerState` 未登记取值一律判为不可核验（fail closed）。
- Companion 侧判定：`workerState` 属 `running|active|working|in_progress` → `live`；属 `succeeded|failed|cancelled|exited|abandoned|completed|done|timed_out` → `exited`；其余（含 `null`）→ `unverifiable`。执行主机未被列举时，只有在「可能有角色级 Worker」的阶段才给出 `unverifiable`。
- **运行中的 prepared-terminal Worker 在 `worker-list` 里是 `ready`**（2026-09-25 实测，Orca 1.4.198）：真实 Codex 会话正在跑、dispatch 尚未收尾时，`workerState` 为 `ready`、`dispatchStatus` 为 `dispatched`；收尾后才变成 `succeeded`/`failed`。按上面的闭集，`ready` 落在「其余」分支，因此 Companion 会把**正在真实运行的 Worker** 判为 `unverifiable` 而不是 `live`。这是既有的 fail-closed 选择（不推断存活、不推断退出、不据此重复派发），代价是执行期间界面无法把这类 Worker 显示为 live。
- 推论（对外部观察者与驱动同样成立）：判断「这个派发是否已经收尾」必须用未收尾取值闭集 `starting|ready|start_unknown|stopping|stop_unknown`，只按 `live` 集合判断会在 Worker 仍在运行时把它当成「没有 Worker」；真实 Codex 会话的时长由模型决定，没有固定上限。

### 只读 Worker 能力：统一基线与派发前门禁（2026-09-26）

**当前验收使用隔离 Codex `0.159.0-alpha.3`；全局正式版仍为 `0.157.1`。** 固定版本与整套验收脚手架安装在项目外的 `~/.cache/orca-acceptance/`（`codex-alpha/` 是固定版本依赖，`acceptance-bin/` 是该版本的 `codex`/`orca` 包装器，`setup-fixture.sh` 建立全新隔离项目与专用协调身份，日志在 `logs/`；此前位于 `/tmp` 的同一套脚手架在机器重启后丢失，因此移到持久位置）。验收进程前置专用 PATH，Codex 包装器附加 `--no-daemon`，Orca 包装器仅在公开 `terminal create --command` 的命令前传入同一 PATH。生产代码没有版本分支或自动升级逻辑，未改系统挂载、全局 Codex 配置或共享 Orca runtime。

- **根因与上游修复**：旧版在 `daemon_mounts.rs::reject_daemon_mount_aliases` 中要求 socket 目录的 `st_dev` 与其 `mnt_id` 对应 mountinfo 的 device 相同；本机 btrfs 分别为 `0:28` 与 `0:27`。上游 [#47968](https://github.com/openai/codex/pull/47968)（`a708fc683934d7d7ea7560354968fedd2be28581`）针对经实际文件描述符确认的 btrfs 处理该差异，同时保留挂载与别名隔离检查。隔离 alpha 已包含此修复。
- **真实能力判据**：共享 `utility-readonly-local-control` profile 继承 `:read-only`，移除无效 `use_legacy_landlock`。探针复制与生产启动同源的 `config.toml` 到临时 `CODEX_HOME`，并复用配置冲突检查；不调用模型、不读取认证文件。宿主写哨兵、受限命令读取、实际追加写入返回 `EROFS/EACCES/EPERM`、宿主回读内容未变，四项齐备才是 `available`。普通非零退出、`ENOENT`、`ENOSPC`、超时或配置冲突均不放行。
- **本机对照**：同一主机上，正式版 `0.157.1` 返回 `unavailable / sandbox-read`，原因为 `cannot establish app-server socket mount isolation`；隔离 alpha 返回 `available / host-verify`。alpha 的完整 `doctor` 退出 0，`read-only-worker` 为 `ok`。旧版 `workspace-write` 与 `read-only` 都受影响，只有获授权的全权限普通角色可避开该问题。Capsule 与 Finalizer 始终只读。
- **隔离边界实测**：alpha 沙箱内不可访问宿主 daemon 目录真实条目，普通专用 Unix socket 仍可连接。临时包装器只影响本次验收启动的进程，不接入共享 Codex daemon。此前失败的 TMPDIR、tmpfs CODEX_HOME、禁用 daemon 自动启动及嵌套 userns/bwrap 路径未重复采用。
- **产品门禁**：`doctor` 独立报告能力；审阅与批准分别现探；Capsule 和 Finalizer 只在确认没有既有派发或 intent 后现探。失败给出 `read_only_worker_unavailable`，零新派发、零 Recovery 预算消耗，不进入报告等待。已有派发仍按原身份对账。结论不写入 Manifest、SQLite 或缓存，Route Planning 启动不使用该门禁。
- **真实 Recovery**：共享生产提示复验为 3 passed / 1 skipped（77.77 秒），Run `run_606501f396da`，被中断 Validator `ctx_988d7f2e2c0f`，取得按宿主 coverage 校验的 `complete` Capsule。日志 `/tmp/codex-btrfs-fix.KK41s5/recovery-shared-retry.log`。此前一次重跑在 Worker 启动前因终端列举不完整被拒绝，未放松该安全门。
- **PTY 真实结果**：不中断模式 8 passed / 1 skipped（541.12 秒，Run `run_5eff0872e5ac`）；中断模式 8 passed / 1 skipped（687.09 秒，Run `run_cbbd604ac768`）。两组均取得持久化 `deliverable`，canonical 与获批本地 origin 的 HEAD 一致，重启前后真实 Dispatch 集合相同。中断组另有 `recovered/replaced` 记录及真实 Capsule、替代 Segment；刻意关闭的原 Implementation 失败，其余 5 个 Dispatch 成功。未制造中断的一组 4 个 Dispatch 全部成功。跳过的是需要可控在途操作的 reconciling 画面场景，不能据此声明该场景已验收。
- **验收现场与证据**：两个模式分别使用全新隔离 Git 仓库、专用协调身份。全部精确 Codex Session 记录均为 `0.159.0-alpha.3`、`minimax-cn/MiniMax-M3`。只读 tracker 通过 `GH_REPO=leike0813/orca-companion-test` 读取现有 Route Map #1；Git origin 是本地裸仓库，验收不写外部 issue 或 remote。环境脚本、失败记录、最终日志 `pty-final-{acceptance,recovery}.log` 与脱敏事实 `final-runtime-evidence.json` 保留在 `/tmp/codex-btrfs-fix.KK41s5/`。Capsule 的报告提示、原生 payload/body 读回及 Finalizer 原生结果适配均经过真实闭环复验。

临时目录不属于发布工件。正式版包含修复后，须重新运行同一探针和真实闭环，不能从版本号或预计发布时间推断可用性。

探针与生产 Worker 复用同一 profile 文件：生产通过 `--profile utility-readonly-local-control` 及其中的 `default_permissions` 选择权限；`codex sandbox` 另外显式传入 `--permission-profile utility-readonly-local-control`。两者权限定义同源，CLI 参数按各自入口设置。

### Work Package worktree 的 base ref（2026-09-26 实测）

- `orca worktree create --repo path:<canonical> --name <n> --base-branch <ref>` 的 `baseRef`/`head` 就是该 ref 解析出的 commit：传分支名时是**分支当前尖端**，传 commit 时就是那个 commit（本机 1.4.198 实测，`--base-branch c017b71…` 建出的 worktree `head` 精确等于该 commit）。
- Companion 的 Work Package worktree 必须建立在 **Execution Authorization 绑定的 baseline HEAD** 上：物化在建立后按 `found.head === <baseline>` 核验身份，受控集成的 commit 步也按同一 baseline 核验来源 HEAD（允许「已自行提交」的后继 HEAD）。
- **2026-09-26 验收发现并修复的缺陷**：物化此前把 **canonical 分支名**当 base ref 传给 Orca，而分支会随每次受控集成前移，因此**第一次集成之后建立的新 worktree 必然落在新的分支尖端**，与授权 baseline 不一致 → worktree-create 步骤在核验处判 `unknown`、lane 永久阻塞：多 Work Package 图与图补丁新增节点在真实环境里都无法再物化（此前真实验收只跑过单 Work Package，因此未被发现）。修复：物化把授权 baseline 的 exact commit 作为 base ref（`materialize-work-package.ts` 的 `baseBranch: paths.baselineHead`，`tests/application/advance-execution.test.ts` 的「canonical 被已归属的集成推进后…」先失败后通过）。
- 由此产生的既有语义：canonical 前移之后仍在跑的 Work Package，其 worktree base 会落后于所需基线；Baseline Reconciliation 就是在图修订或 canonical 前移之后把该 worktree 对齐到当前版本所需基线（`targetHeadVerified` 要求 worktree HEAD 精确等于 `requiredBaselineHead`）。
- **多 Work Package 代际的交付路径（2026-09-26，本轮修复）**：受控集成是 `merge --ff-only`，而 canonical 已被前一个集成推进时，后物化的 Work Package 建立在授权 baseline 上，因此它的成果永远无法集成（实测 `canonical_not_forward` / `canonical_not_fast_forward`）。修复：`advanceExecution` 在**派发之前**发现 `canonical HEAD !== Authorization baseline` 就登记 Baseline Reconciliation（(Work Package, 目标基线) 幂等），物化只把隔离 worktree 建出来、角色 Task 由 `baseline_reconciliation_pending` 门禁挡到核验通过——门禁因此从「物化零副作用」变为「不派发角色 Task，但允许建立对齐所需的 worktree」。
- **被中断的原会话仍可自行完成**（2026-09-26 实测）：`terminal-close` 之后 Orca 枚举里那个终端仍然存在（宿主因此先记下 hold 原因「终端仍在已列举主机上存在」），而原 Codex 会话可能随后自己走到终态；Recovery 因此以 `recovered` + `terminal_outcome: source_completed` 收尾并 supersede 原 Segment。Recovery 的终态记录**保留**当时那条 hold 原因（store 的终态迁移不再接受写入），所以「有原因 ⇒ 该 Work Package 阻塞」的投影会让已经续办的节点永久停在 `blocked`：既挡住派生阶段也挡住后续派发。修复：只有 `blocked` 与未终结（`pending`/`recovering`）且带原因的 Recovery 才算阻塞（`execution-view.ts`，`tests/application/execution-view.test.ts` 的「已终结的 Recovery 不再阻塞」先失败后通过）。
- **Execution Coordination Lease 必须随 Incarnation 重指**（2026-09-26 实测）：租约按 Session 归属，而记录里的 `runtimeIncarnationId`/`fencingGeneration` 会被协调级写入用来拒绝陈旧进程。Runtime Lease 在每次进程启动或同一 Session 重新接管时会拿到更大的 fencing generation（实测同一 Session 内 fencing 3 → 4），而 Execution Coordination Lease 只在授权切换/交接/重规划时写入一次、`expires_at` 为 `NULL`、也没有续约路径，因此**重启之后**它的身份永久陈旧：`request_graph_patch` 之类的用例一律返回 `stale_lease_identity`，而派发路径（只比对 Session）看起来完全正常。修复：Session 每次 ensure（含接管后重新启动）都把已由本 Session 持有的执行租约重指到当前 Incarnation（`lease-service.ts` 的 `repointExecutionLease`，别人持有的租约绝不覆盖；`tests/lease-fencing.test.ts` 覆盖重指、幂等与 `held_by_other` 三种结论）。

### Graph Patch Planner 的派发门禁与「图修订请求」的时序（2026-09-26 实测）

- `runGraphPatchPlannerWorker` 在新派发前要求**整个 Run 静止**：任何 Worker 的 `workerStateLiveness !== 'exited'` 都会得到 `worker_in_flight`（Graph Patch Planner 自己就是一个 Worker，受并发上限 1 约束），并且要求当前没有未确认 Delivery（`delivery_pending`，而 Delivery 由启动 / Resume 的重放结算，普通触发点不结算）。
- **声明由模型转写，路由是确定性的（2026-09-26 实测）**：九字段声明是确定性路由输入，但字段值由模型读取用户消息后填写。用散文描述「把 X 填 unknown、其余填 no」时，真实 Coordinator 把 `unknown` 写成了 `no`，于是九项声明事实全部「已核验不成立」→ 路由为 `no_change`，一次补丁都不会起草（宿主既没有 blocker、也没有 GraphVersion，只有「执行过 1 个受控工具调用」这一条痕迹）。把请求改为**字面 JSON**、并让驱动在有界次数内重提请求后，才真的走到 Graph Patch Planner。产品侧路由无需改动：这是「自然语言 → 结构化声明」这一步的保真度问题，验收因此必须按「提交请求」而不是「模型一定照抄」来设计。
- 携带图变化声明的**用户消息本身就是触发点**：`sessionMessages` 先 `triggerExecution`（会派发下一个角色）、再唤醒模型，而模型要到几十秒后才调用工具。真实运行（`pty-gp-quiet`，Run 静止时提交）里模型连续 16 次拿到的都是 `worker_in_flight`；把提交时机放在「收到消息时 Run 恰好静止」并不能改变结论，因为派发先发生。
- **修订造成的 revision pending：释放路径在运行时缺接线（2026-09-27 实测，未修复）**：同一个补丁如果选择**修订**在途节点而不是把它退场，它照样进入 revision pending（本图内仍在），按规格持有应由「规格重新准入」解除——但 `beginSpecificationRevision` / `settleSpecificationRevision` 在生产运行时从未被调用（只被测试引用），因此持有同样永不释放。真实运行 `orca-companion-e2e46`：补丁 v2 保留两个节点（`retired: []`），Scope 停在 `revision_pending:graph_patch` 直到驱动截止，`revision_holds` 仍 pending。这条与「退休」是两支不同的释放路径，前者已修、后者待接线。
- **退休造成的 revision pending 必须在与图版本同一事务里结清（2026-09-27 实测，本轮修复）**：规格要求「修订**或退休**需求在 Worker 已派发时被报告」都把受影响节点置 revision pending，其当前 Worker 先运行至可核验终态。规格修订由重新准入解除持有，但被 retire 的节点已经不在图里、永远不会再被重新准入——真实运行里那份被接受的补丁同时 `retired: [readme-banner]` 并给它登记了 pending 持有，此后**没有任何路径释放它**（宿主侧的两种判定都试过：按 Orca Worker 存活、按 store 里该节点的结果是否已结算；真实链路里两者都没能让它释放），Scope 因此永久停在 `revision_pending:graph_patch`，Finalizer 门禁（要求每个 Work Package 都 validated）再也不满足：Git 侧早已集成成功（canonical 有集成提交、远端有推上去的 ref），却拿不到交付结论。修复：`record-graph-version` 在登记持有的同一事务里，对**已不在新图中的节点**记一次释放（理由「节点已由图修订退场，不会有后续角色或依赖工作」）——退休仍然登记持有（规格如此），只是紧接着结清；规格要求的「当前 Worker 先运行至可核验终态」不被违反，因为工作不会被打断，只是它的旧结果无法越过一个已退场的节点推进。宿主触发链另有一个只读 store 的兜底结算（`settleRetiredRevision`），用于修复历史遗留的悬挂持有。
- **Scope 必须处于 `active`（2026-09-26 实测）**：Scope 处于 `paused` 时 `request_graph_patch` 以 `control_state` 拒绝（`Scope 处于 paused，执行推进被暂停`）。这是产品语义的正确体现——Pause 本来就停止新的模型恢复与派发——因此驱动必须让这次工具调用落在 `active` 窗口里：实测两次把声明提交在 Pause→Resume 的相邻轮次后，模型忠实照抄了字面 JSON 却仍被 `control_state` 拒绝。
- **Planner 初稿可能过不了 Admission（2026-09-26 实测）**：真实 Graph Patch Planner 起草的补丁有一次被确定性 Admission 判为 `admission_rejected`（`补丁未通过 Admission 编译校验`），而同一请求在另一次运行里通过并追加了 GraphVersion。这是 Planner 产出纪律问题（T2 的信封纪律），产品侧门禁行为正确；验收因此按「提出请求」设计，允许有界重提，并把「补丁只调整该 Work Package 已有的 contract 内容」写进请求本身。
- **重试必须先结清 Delivery（2026-09-26 实测）**：一次请求失败后再次提交，门禁只回 `delivery_pending`——上一次 Planner 收尾留下未确认批次，而那时已经没有角色在跑。等待路径因此改成**每轮都做一次对账**（同一 `ScopeControlService.reconcile`），而不是等 Run 静止之后才结算一次。
- **修复（2026-09-26，本轮）**：`request_graph_patch` 的宿主路径在提交请求前**有界等待** Run 静止，并在此期间用同一个对账用例（`ScopeControlService.reconcile`：原 OperationId 对账 + 同一 pipeline 重放未确认 Delivery）结清 Delivery；10 分钟内没能静止则仍返回结构化 `worker_in_flight`。等待期间不改变控制状态、不建立第二套重放路径，因此派发语义与触发点顺序都不变。

### 未确认 Delivery 的读取与批次推进（2026-09-25 实测）

- `orchestration check --json --terminal <identity> --run <runId> --types worker_done` 在默认（非 `--peek`）模式下返回 `{ deliveryId, messages[], count, timedOut, cancelled }`；`--peek` 只返回未读消息、**不带 `deliveryId`**。只读探测因此必须用默认模式读身份，否则拿到了消息却拿不到可确认的 Delivery 身份。
- 结果消息要等**进度批次被确认**之后才成为当前批次：真实 Planner 的 `worker_done` 在 `heartbeat` 批次被 `delivery-ack` 确认之前不出现在当前批次里。因此「一次触发能不能结算 Delivery」取决于进度批次是否已经被确认，驱动与验收必须容忍「这一轮只推进批次、没有结算」。
- 读取范围绑定在**协调终端当前绑定的 Run**（`run-current`）上。Scope 在同一个前台进程里从 `route_planning` 授权切换到 `execution_coordination` 时 Run 才建立：启动时读到的「本 Scope 没有 Run」会立刻过期，读取范围必须每次读取时重新解析，不能在进程启动时冻结（Companion 侧已按此修复：`src/bootstrap/startup.ts` 的 `readDeliveries` 与 `src/bootstrap/foreground-planning-runtime.ts` 的 `currentDeliveryFacts`）。

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
  - **后续证据**：2026-09-26 的隔离 alpha 运行已补齐 Planner 交付、Specification Admission、Implementation/Validator、受控集成及只读 Finalizer，并取得持久化 `deliverable`；当前基线见上文「只读 Worker 能力」。前驱要求的 Graph Patch Planner 与 baseline reconciliation 同链路场景经同日复验定因：派发门禁与用户消息时序不可兼得，详见上文「Graph Patch Planner 的派发门禁与「图修订请求」的时序」；多包代际的第二个包还受 `merge --ff-only` 与授权 baseline 的限制（见「Work Package worktree 的 base ref」）。
- **沙箱主机诊断**（2026-09-24，已被下一条取代）：当次记录的是 bwrap 无法建立 uid map（`kernel.apparmor_restrict_unprivileged_userns=1` 且发行版 `bwrap-userns-restrict` profile 未加载）。加载该 profile 后 bwrap 本身已可用。
- **旧版 Codex Linux 沙箱基线**：0.156.1 至本机正式版 0.157.1 的文件系统受限会话因 btrfs device 判定失败而不可用；独立 bwrap 成功并不证明 Codex 沙箱可用。当前隔离 alpha 的修复、探针与真实验收结论统一见上文「只读 Worker 能力」。系统挂载未修改。
- **普通角色的沙箱授权**：`execution.codexSandbox` 默认 `workspace-write`；选择 `danger-full-access` 必须由 Manifest 的 `codex-sandbox-danger-full-access` 风险明确授权，派发与替代 Session 均重验。Finalizer 与 Capsule 不使用此字段，固定复用继承 `:read-only` 的 `read-only-local-control` profile，并开放本机 Orca 控制通道所需网络；真实可运行性以当前探针为准。
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
