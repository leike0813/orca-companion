## Context

当前 Capsule Utility Worker 与 Finalizer 都走 `createCodexWorkerLaunch(..., sandboxMode: 'read-only-local-control')`。该 profile 继承 `:read-only`，但启动参数仍带 `--enable use_legacy_landlock`。在本机 Codex 0.156.1 上，受限命令会以 `filesystem-restricted execution requires bubblewrap to isolate app-server sockets` panic；上游 [Linux sandbox 说明](https://github.com/openai/codex/blob/main/codex-rs/linux-sandbox/README.md) 也明确文件系统受限策略需要 Bubblewrap，legacy Landlock 不能代替它。规划时只读执行探针 `codex sandbox -c 'sandbox_mode="read-only"' /usr/bin/true` 退出 1，报 `cannot establish app-server socket mount isolation`。`docs/orca-compatibility.md` 已记录 Bubblewrap 在当前 btrfs 布局下的同一失败。单独找到 `bwrap` 可执行文件、启动 Codex 会话或设置 `TMPDIR` 都不能证明这条路径能工作。

现有 `doctor` 只核验 Orca 与可选的 Coordinator 模型；Execution Authorization 审阅只显示 `finalizer=read-only`，没有可运行性事实。Recovery 在 Capsule 派发后等待最多 120 秒才报告超时；Finalizer 可能派发成功却始终读不到报告。领域结论仍正确地保持 blocker，但诊断来得太晚。

## Goals / Non-Goals

**Goals:** 用实际受限命令证明只读可运行性；在 `doctor`、授权审阅及两个派发入口一致地暴露能力缺口；在环境恢复后取得真实 Capsule 与 Finalizer 结论，同时保留原身份、权限和预算约束。

**Non-Goals:** 修改 Orca 或 Codex 私有源码；在 Companion 中改变主机挂载；放宽 `:read-only`、改用 `danger-full-access`、允许模型替代环境核验；重做 Recovery/Finalizer 状态机或 TUI 页面。

## Decisions

### D1：只用真实 Codex 只读沙箱探针判定能力

在 `src/adapters/agents/` 增加一个小的、无模型调用的本机探针，复用 `codex-launch.ts` 中只读 profile 的生成规则。以隔离临时目录和该 profile 调用当前 `codex sandbox`：先由宿主证明专用哨兵文件可写，再让沙箱命令读取它、尝试修改它，最后由宿主回读确认内容未变。只有宿主可写、沙箱读取成功、沙箱写入被明确拒绝、内容不变四项都成立才是 `available`。探针在当前进程、当前 Codex 可执行文件及配置下运行；输出为 `available | unavailable | unknown`、阶段、有限诊断和版本。子进程采用现有进程执行器的超时/输出上限；临时目录不在项目树内，清理失败不能改变能力结论。探针不能以命令退出码单独推断写入被拒绝。

**权威来源：** 实际 Codex 子进程与宿主文件观察。**失败关闭：** 超时、配置冲突、无法回读或意外写入均不得宣称只读可用。备选的 `bwrap --version`、内核特征、挂载类型推断和 Codex SessionStart 均不能覆盖真实命令路径。

### D2：删除无效的 Landlock 选择，保留单一只读 profile

`codex-launch.ts` 中 `read-only-local-control` 仍生成继承 `:read-only` 且允许本机控制通道的 profile，但不再传 `--enable use_legacy_landlock`；Capsule 与 Finalizer 继续复用该启动策略。普通 Planner/Implementation/Validator 的已批准沙箱模式不变。探针与生产启动共享 profile 内容及配置冲突检查，避免两份权限事实。若 Codex 版本或配置不支持该 profile，D1 报能力缺失。

**权威来源：** Codex 当前实际策略、生成的 profile 与真实探针。**失败关闭：** 不尝试 Landlock、`workspace-write` 或全权限回退。备选的放宽 Finalizer/Capsule 权限违反项目合同。

### D3：能力结论只存在于当前检查，不进入授权或恢复持久化

`doctor` 在原有 Orca 检查之后增加独立只读 Worker 检查项；不可用或未知使该命令非零退出，结构化输出包含阶段与原因。它不修改 Scope，Route Planning 的启动门不使用此项。授权审阅在呈现或返回 blocker 时进行新探针，明确 `Capsule/Finalizer=read-only` 及结论；批准命令在重读 Manifest 与指纹时重新探测，失败即拒绝批准。能力结果不写入 Manifest、SQLite、checkpoint 或持久缓存；旧审阅和环境变化都不能绕过批准时检查。

**权威来源：** 本次 D1 探针；Manifest 仍是执行策略与风险批准的权威。**失败关闭：** 探针不可用则该次批准失败，原 Scope 仍可规划。备选的持久化成功标志会在主机挂载、Codex 版本或配置变化后过期。现有审阅 DTO 的 blocked 形态可携带配置与诊断，不新增 TUI 页面或领域字段。

### D4：只在尚未派发时阻断，已派发事实继续对账

Recovery 的 Capsule 派发前与 Finalizer 的新派发前各运行 D1 检查；失败时沿既有 blocker 出口记录稳定的 `read_only_worker_unavailable` 原因，不进入 120 秒报告等待，不产生 Task/Dispatch，也不消耗 Recovery 预算。先检查既有 Task/Dispatch/intent，再决定能否新派发；已经派发的角色即使当前探针失败，也按原 OperationId 与 Session/Delivery 事实对账，不能以探针结果伪造终态。用户修好环境后的下一次正常推进可重新检查并继续，不能自动换 ID 重试 unknown mutation。

**权威来源：** Orca 派发/结果与 Companion 已记录的 intent；探针只决定新的受限派发是否可启动。**失败关闭：** 不可核验的在途角色保持原 blocker。备选的全局启动门会误伤 Route Planning，且无法处理执行中环境变化。

### D5：本机解阻塞是明确的环境前置，不是 Companion 自动修复

实施验收前由操作人员在隔离环境中使 Codex Bubblewrap 路径可用；候选为把 Codex 固定使用的 `/tmp/codex-daemon-<uid>` 所在目录放在能通过其 mount isolation 检查的文件系统，或采用经实测修复该问题的上游 Codex 版本。`TMPDIR` 与 `CODEX_HOME` 不是该 socket 路径的替代配置。任何 mount、root 权限、系统配置或 Codex 升级都不由本 change 自动执行，也不作为本轮规划的既成事实。环境改变后必须通过 D1 探针和隔离项目真实闭环，才能宣称本机可用。

**权威来源：** `docs/orca-compatibility.md` 的本机复现及修复后的探针/真实运行；上游源码仅用于解释候选原因。**失败关闭：** 环境仍不满足时变更只交付确定性诊断与阻塞，不声称 `deliverable` 已验收。备选的 rootless 嵌套 namespace 已有 AppArmor 失败证据，不能预设可行。

### D6：沿既有合同做最少改动

`doctor` 归 MOD-07 与现有 CLI 组合；授权审阅与批准、Capsule/Finalizer 派发入口归 `src/bootstrap/`；只读启动与探针归 `src/adapters/agents/`。使用 IC-09 的 Recovery 记录与 IC-11 的 blocker/Finalizer 投影，维持 IC-03/IC-05 的 intent 和身份规则。无新数据库表、migration、依赖、领域 DTO、公开 CLI 子命令或 TUI 组件。`docs/orca-compatibility.md` 合并当前只读基线、修复前后探针与真实结果，删去“Landlock 是退路”的过时叙述。

**权威来源：** `docs/architecture.md`、`docs/interface-contracts.md` 与现有代码。**失败关闭：** 若既有 blocker 无法表达诊断，只在已有 bootstrap/投影合同上做最小扩展，不另建状态机。

## Risks / Trade-offs

- 探针只证明调用时刻的本机能力；环境在探针与派发之间变化仍可能让 Worker 失败。原有 Session/Delivery/unknown 对账负责处理该窗口，不能把探针当作跨进程保证。
- 只读探针会尝试写入临时哨兵，这是必要的负向验证；若写入竟成功，探针报告权限失效并清理隔离目录。它不触碰项目文件。
- 当前本机上探针预期失败；因此正常的执行授权会被提前阻断。已批准且已派发的旧 Scope 保持可对账，不通过新门禁重写历史。
- 真正取得 `deliverable` 取决于主机/上游沙箱修复；仓库内代码无法单独保证这一项。

## Migration Plan

实施前核验直接前驱 `m2-deliver-execution-tui` 已归档、主规格已同步、现有未提交改动已保留。先落共享只读 profile 与探针，再接 `doctor`/授权/运行期门禁，最后更新 compatibility 文档。没有持久数据迁移。旧执行中的受限 Dispatch 按原事实对账；新派发使用当前检查。系统环境修复作为独立运维步骤，在显式选择的隔离项目中验收，不隐式修改宿主。

## Open Questions

无影响实现路径的开放问题。系统管理员最终采用 `/tmp` 挂载调整还是经验证的 Codex 上游修复，可在实施验收时按实际环境决定；两条路径都必须满足 D1 与真实闭环判据。
