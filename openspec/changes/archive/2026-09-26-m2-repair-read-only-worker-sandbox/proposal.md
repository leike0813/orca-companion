## Why

本机的**只读 Codex 会话无法执行任何命令**，因此依赖只读会话的两个角色事实上跑不动：Recovery Capsule 提取的受限 Utility Worker 只能停在 blocker，只读 Finalizer 永远拿不到交付结论。`m2-deliver-execution-tui` 的真实 PTY 验收因此只能证明「Recovery 形成明确 blocker」，无法取得 `deliverable`。

实测证据（2026-09-25，Ubuntu 24.04.4、Orca 1.4.198、Codex CLI 0.156.1、`/tmp` 位于 btrfs）：

- 用生产同一份启动方式（隔离 `CODEX_HOME`、`:read-only` 继承的 permission profile `utility-readonly-local-control`、`--enable use_legacy_landlock`、`--ask-for-approval never`）执行 `codex exec --json 'Use the shell to run: cat README.md'`，`exec_command` 直接 panic：

  ```
  thread 'main' (251075) panicked at linux-sandbox/src/linux_run_main.rs:410:9:
  filesystem-restricted execution requires bubblewrap to isolate app-server sockets
  ```

- 真实运行里同一条路径的旁证：隔离项目 `orca-companion-e2e22` 的 Recovery Capsule Utility Worker（`ctx_430f7d027fdc`）在自己的 transcript 里请求「把审批策略从 `never` 改掉，或由人把 500 行内容贴给我」——它读不到 transcript，也投不出 Capsule；宿主按设计在 `CAPSULE_REPORT_TIMEOUT_MS = 120_000` 后收尾为 `blocked`（`consumed_budget = 0`，`blocking_reason = 等待 Capsule 报告超时（Dispatch ctx_430f7d027fdc）`）。
- 同一限制与 `docs/orca-compatibility.md` 已记录的 Finalizer 只读限制同因（更早的记录是 bwrap 无法建立 uid map / socket mount isolation）。

这条限制让 M2 的终态验收失去一半可达性：只要运行里真的发生一次执行态中断，唯一的 Work Package 就会停在 Recovery blocker 上，Finalizer 门禁永不满足；而本机无法提供可核验的只读会话，即便门禁满足也拿不到 verdict。

## What Changes

- 让本机的**只读 Worker 会话可以真正执行命令**（Capsule Utility Worker 与只读 Finalizer 都在这一路径上），或者对「本机无法提供可核验只读会话」给出确定性的、可诊断的处置，而不是停在只有超时原因的 blocker 上。
- 把该能力纳入能力核验：`doctor` 与 Execution Authorization 审阅必须能回答「本机此刻能否运行只读 Worker」，而不是等到真实派发后才以超时暴露。
- 修正 `docs/orca-compatibility.md` 的只读基线记录：现行记录分散在三处（bwrap uid map、btrfs socket mount isolation、Capsule/Finalizer 的 `read-only-local-control`），需要一条把「哪条受限路径在本机可用/不可用、可用路径的判据与验证方式」讲清楚的结论。
- 不改变 `:read-only` 语义，不放宽 Capsule 或 Finalizer 的权限；本 change 只解决「受限会话能不能跑」，不解决「要不要继续只读」。

## Capabilities

### New Capabilities

- `orchestration/read-only-worker-execution`: 本机只读 Worker 会话的可运行性判定、启动策略与失败归因（含 `doctor` 与授权审阅的可观测结论、Capsule 提取与 Finalizer 的确定性终态）。

### Modified Capabilities

无。本 change 只新增独立 capability；`m1-recover-execution` 的 Recovery 状态机与 `m2-deliver-execution-tui` 的投影语义不变。

## Impact

- 直接前驱：已归档的 `m2-wire-execution-runtime`。本 change 是 `m2-deliver-execution-tui` 的解阻塞并行项，消费其已固定的执行态投影与 PTY 接缝；本 change 先验收、归档，再补齐执行 TUI 的剩余真实验收。两者可同时 active，不要求执行 TUI 先归档。
- 受影响代码面（规划阶段确认）：`src/adapters/agents/codex-launch.ts`（只读 profile 与 `--enable use_legacy_landlock` 的启动参数）、`src/bootstrap/doctor.ts`（能力核验）、`src/bootstrap/execution-runtime.ts`（Capsule 提取的等待与归因）、`src/bootstrap/foreground-planning-runtime.ts`（Finalizer 派发与 gate）。
- 可能超出仓库边界：若根因只能在 Codex 侧修（`linux-sandbox/src/linux_run_main.rs` 对 app-server socket 目录的设备判定），本 change 只能把它收敛成显式的能力缺口与可诊断结论，并记录上游依赖；需要时可向上游提交最小复现。
- 环境前置：本机 `/tmp` 位于 btrfs，daemon socket 目录固定取 `canonicalize("/tmp")/codex-daemon-<uid>`，`check_mounts` 的设备比较因此失败。规划时没有已验证的无 root 修法；嵌套 namespace 探针已被 AppArmor 拒绝。实施验收依赖独立的主机环境调整或经实测修复的上游版本；本 change 不自动修改 mount 或系统权限。
- 不在本 change 内：放宽 Capsule 与 Finalizer 的只读权限、把 Capsule 报告读回改成异步（那会改 `m1-recover-execution` 的状态机与契约）、恢复 `deliverable` 的产品语义变更。
