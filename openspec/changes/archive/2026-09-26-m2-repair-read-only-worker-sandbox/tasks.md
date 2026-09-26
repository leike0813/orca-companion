## 1. 实施前核验

- [x] 1.1 按 IP-01～IP-05 核验直接前驱 `m2-wire-execution-runtime` 已归档、对应主规格存在，并固定并行项 `m2-deliver-execution-tui` 的当前共享接缝；运行 `openspec list --json`、`openspec list --specs --json` 与 `git status --short`，保留未提交改动，若接缝漂移则返回规划。
  **核验结果（2026-09-26）**：前驱位于 `openspec/changes/archive/2026-09-25-m2-wire-execution-runtime/`，运行时、Finalizer 与 Recovery 主规格均存在。HEAD 为 `1fb068caa41b536c21fd02419ee5fd822fb20c22`；已核验只读启动、doctor、授权审阅/批准、Capsule/Finalizer 派发及真实 PTY 接缝，保留本轮开始时已有的未提交实现。技术义务与测试证据不变。
  **依赖纠正**：用户指出原规划把解阻塞项错误地列为执行 TUI 的串行后继，形成循环依赖。本轮同步纠正 proposal、design、implementation-plan 与项目 OpenSpec 操作规则，沿用项目已有的解阻塞并行模式。本 change 先验收、归档；执行 TUI 随后补齐 Graph Patch Planner 与 baseline reconciliation 的真实场景。未把执行 TUI 的未完成任务标为完成，也未改动其未同步主规格。

## 2. 只读启动与能力探针

- [x] 2.1 按 IP-01 共用只读 profile 并移除 `use_legacy_landlock` 启动参数；运行 `pnpm exec vitest run tests/adapters/agents/codex-launch.test.ts` 确认权限配置与启动命令。
- [x] 2.2 按 IP-01 实现有界、无模型的宿主可写/沙箱读/沙箱拒写/宿主回读探针及三态诊断；运行 `pnpm exec vitest run tests/adapters/agents/codex-read-only-probe.test.ts` 覆盖成功、沙箱失败、超时和意外写入。

## 3. 启动前诊断与授权

- [x] 3.1 按 IP-02 将独立只读能力检查接到 `doctor`，不扩大 Route Planning 启动门；运行 `pnpm exec vitest run tests/doctor.test.ts` 确认 JSON、退出码与无 TTY 行为。
- [x] 3.2 按 IP-03 在授权审阅显示 Capsule/Finalizer 的只读配置与探针结论，并在批准前重新检查；运行 `pnpm exec vitest run tests/bootstrap/execution-authorization.test.ts tests/tui/authorization-review.test.tsx` 确认失败不写授权、环境恢复可重审。

## 4. 执行期失败关闭

- [x] 4.1 按 IP-04 将探针接到 Capsule 新派发前，先核对已有 intent/Task/Dispatch；运行 `pnpm exec vitest run tests/recovery/capsule-dispatch.test.ts` 确认不可用时零新派发、零预算消耗，旧派发按原身份对账。
- [x] 4.2 按 IP-04 将探针接到 Finalizer 新派发前，保留原报告与工作区核验；运行 `pnpm exec vitest run tests/bootstrap/execution-finalizer.test.ts` 确认不可用时只有 blocker、没有 deliverable 或重复派发。

## 5. 本机证据与收口

- [x] 5.1 按 IP-05 更新 `docs/orca-compatibility.md` 的统一只读基线，记录实际版本、探针结果、环境措施与未解除的限制；检查文档不再把 Landlock 写成只读退路。
- [x] 5.2 按 IP-05 将 `tests/tui/pty-execution.test.ts` 的环境可用路径收紧为真实 Capsule 与 deliverable 必达；运行 `pnpm exec vitest run tests/tui/pty-execution.test.ts` 确认默认无真实开关时仍安全跳过。
  **证据（2026-09-26）**：无真实开关时 `tests/tui/pty-execution.test.ts` 安全跳过（1 skipped）；宽松接受任何 blocker 的四处断言已改为只接受**点名只读能力缺口**的 blocker，能力可用时必须取得真实 Capsule（中断模式）与 `deliverable`（不中断模式）。
- [x] 5.3 按 IP-05 在获得独立的主机环境修复后先运行 `pnpm build`，再依 implementation-plan §6 的命令，以全新隔离项目和专用身份分别运行真实 Validator Recovery、PTY 中断模式与不中断模式；确认 Capsule 报告、只读 Finalizer、deliverable 与重启不重复派发。环境未修复则保持本任务未完成并记录 blocker。
  **最终证据（2026-09-26）**：用户批准使用隔离 `0.159.0-alpha.3` 验收；未替换全局 `0.157.1` 或修改系统挂载。alpha 实际探针 `available / host-verify`，完整 doctor 退出 0；正式版同探针仍报 mount isolation 错误。共享生产提示的真实 Validator Recovery 为 3 passed / 1 skipped（77.77 秒，Run `run_606501f396da`，`complete` Capsule）。不中断 PTY 为 8 passed / 1 skipped（541.12 秒，Run `run_5eff0872e5ac`，4 个成功 Dispatch）；中断 PTY 为 8 passed / 1 skipped（687.09 秒，Run `run_cbbd604ac768`，1 个刻意中断的 Dispatch 加 5 个成功 Dispatch）。两组均取得持久化 `deliverable`、canonical 与本地 origin HEAD 一致、重启 Dispatch 集合不变；中断组 Recovery 为 `recovered/replaced` 且绑定真实 Capsule 与替代 Segment。逐会话记录均为 alpha 与 `minimax-cn/MiniMax-M3`。日志及脱敏事实位于 `/tmp/codex-btrfs-fix.KK41s5/{recovery-shared-retry.log,pty-final-acceptance.log,pty-final-recovery.log,final-runtime-evidence.json}`。
  **IP-05 收尾修复范围**：真实验收暴露 Capsule 提示未说明对象结构、生产读回把 Orca payload 元数据当报告、Finalizer 未接原生结果载荷。按用户本轮「最终收尾和 verification」指示修复这些闭环缺口；新增涉及 `src/adapters/agents/utility-worker.ts`、现有 recovery parser/dispatch 测试及 Finalizer 既有接缝。权限、领域 verdict、身份核验和预算合同不变，测试不得接受无法解释的 blocker。
  **验收取证修正**：CLI `status` 不提供宿主进程内的只读/集成观察，改由 TUI 核验 `read-only enforced`、Git 核验真实集成；侧栏会裁切长 Segment ID，改从持久记录核验 Capsule/替代 Segment，界面核验恢复状态。失败日志保留；以上最终结果来自修正后的全新现场。两组均跳过需要可控在途操作的「重启先显示 reconciling」场景，已执行的重启用例核验同一持久事实与真实 Dispatch 集合不变。
- [x] 5.4 按 IP-01～IP-05 运行 `pnpm typecheck && pnpm lint && pnpm test && pnpm build && openspec validate m2-repair-read-only-worker-sandbox --strict`，并核对没有修改上游、系统挂载或用户已有改动。
  **证据（2026-09-26）**：`pnpm typecheck`、`pnpm lint`、`pnpm build`、`openspec validate m2-repair-read-only-worker-sandbox --strict` 全部通过；收尾全量 `pnpm test` 为 139 passed / 6 skipped（1231 passed / 12 skipped，80.06 秒；未启用的真实集成用例按设计跳过）。日志 `/tmp/codex-btrfs-fix.KK41s5/all-verification.log`。`references/orca`、`src/domain/`、依赖及锁文件均无改动，未修改系统挂载、全局 Codex 安装或配置，保留了本轮开始时已有的未提交实现。
