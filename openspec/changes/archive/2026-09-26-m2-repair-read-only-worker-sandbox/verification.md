# Verification

## 验收对象

- Change：`m2-repair-read-only-worker-sandbox`
- 输入实现：HEAD `1fb068caa41b536c21fd02419ee5fd822fb20c22` ＋ 差异检查点
- 最终验收 HEAD：`1fb068caa41b536c21fd02419ee5fd822fb20c22`；验收覆盖下述未提交差异，不把基线 commit 当作已包含实现。
- 功能验收检查点：`/tmp/codex-btrfs-fix.KK41s5/accepted-implementation.patch` ＋ 3 个 untracked 文件：`src/adapters/agents/codex-read-only-probe.ts`、`tests/adapters/agents/codex-read-only-probe.test.ts`、`tests/support/read-only-worker-probe.ts`。此后的依赖纠正只修改 OpenSpec 规划、操作规则、任务与报告；代码及真实测试保持该检查点状态。
- 验收 Agent：Linnaeus（agentId `01a0dbb2-7778-7b70-9ab7-3eba7ebd5ab5`），独立只读审计，不提交、不归档、不改代码
- 结论以该 HEAD ＋ 差异检查点对应的未提交树为准；本轮无 commit、无归档授权

## 结论

**PASS。** 本 change 的代码、自动门禁、真实闭环与 §8 限定审计全部通过，任务 11/11 完成。验收范围为本报告列出的未提交实现及隔离 Codex `0.159.0-alpha.3` 环境；本轮未执行提交或归档。

**依赖纠正（2026-09-26）**：原结论把执行 TUI 未归档列为唯一 blocker，导致解阻塞项反过来等待被解阻塞项。经用户指出后重新核对项目已有并行解阻塞规则，将直接前驱纠正为已归档的 `m2-wire-execution-runtime`，固定当前 TUI 接缝并同步规划与操作规则。此项只修正依赖方向，未降低任何技术要求、删除测试或伪称 TUI 已完成。本报告据已取得的完整功能证据更新结论。

`m2-deliver-execution-tui` 独立保持未完成：它仍需补齐 Graph Patch Planner 与 baseline reconciliation 的真实同链路证据。本 change 可先收口，其验收不依赖执行 TUI 先归档。

独立验收 Agent Linnaeus 已复核本轮 8 份文档：依赖循环消除，3 项 Requirement、8 个 Scenario、7 项限定审计及原有测试证据均保留，可维持 PASS；两个 change 的严格规格校验通过。

### 本机真实证据（IP-05 已取得）

隔离 Codex `0.159.0-alpha.3`（包装器仅前置专用 PATH，附加 `--no-daemon`，不接入共享 daemon）：

| 运行 | Run | 日志 | 结果 |
| --- | --- | --- | --- |
| 共享生产提示的 Validator Recovery | `run_606501f396da` | `/tmp/codex-btrfs-fix.KK41s5/recovery-shared-retry.log` | 3 passed / 1 skipped，77.77s，取得按宿主 coverage 校验的 `complete` Capsule |
| PTY 不中断模式 | `run_5eff0872e5ac` | `/tmp/codex-btrfs-fix.KK41s5/pty-final-acceptance.log` | 8 passed / 1 skipped，541.12s，4 个 dispatch 全 succeeded，持久 `deliverable` |
| PTY 中断模式 | `run_cbbd604ac768` | `/tmp/codex-btrfs-fix.KK41s5/pty-final-recovery.log` | 8 passed / 1 skipped，687.09s，6 个 dispatch（原 Implementation 刻意中断 failed + 其余 5 succeeded），`recovered`/`replaced`＋`capsuleRef`＋`replacementSegmentId`，持久 `deliverable` |

两组 PTY 的 1 skipped 是**需要可控在途操作的重启 reconciling 画面**用例：当前完成路径未制造该前置条件，不能声明该画面已经验收。Recovery 组的 1 skipped 是 `real-validator-partial.test.ts` 的「未开启真实开关时整个真实验收被跳过且不加载端点配置」：真实开关启用时该用例跳过，其余 3 条（隔离边界自检、端点检查、真实 Recovery）通过。未启用真实开关时，不依赖真实开关的隔离边界自检仍会运行，只是真实 integration 不启动 Worker。

两组 PTY 都以持久事实核验：`deliverable`、canonical HEAD 与本地获批 origin/ref 的 HEAD 相等、重启后 dispatch 集合不变；全部真实 Session 的 `cli_version` 为 `0.159.0-alpha.3`、模型为 `minimax-cn/MiniMax-M3`。脱敏汇总见 `/tmp/codex-btrfs-fix.KK41s5/final-runtime-evidence.json`；能力探针 `final-alpha-probe.json` 为 `available / host-verify`；完整 `doctor` 退出 0（`doctor-alpha.json`，`read-only-worker: ok`）。

对照：同一主机全局正式版 `0.157.1` 走同一探针仍为 `unavailable / sandbox-read`（`cannot establish app-server socket mount isolation`）。本 change 不修改系统挂载、全局 Codex 或共享 Orca runtime。验收用的临时目录、包装器与日志不属于发布物。

## 核验与修复证据

### Requirement / Scenario（3 Requirement，8 Scenario）

| Requirement / Scenario / IP-ID | 证据或命令 | 结果 |
| --- | --- | --- |
| R1 只读 Worker 能力必须由实际执行证明／受限命令可用且拒绝写入／IP-01 | `codex-read-only-probe.ts`；`pnpm exec vitest run tests/adapters/agents/codex-read-only-probe.test.ts` | 通过 |
| R1／会话能启动但命令不能执行／IP-01 | 同上；沙箱读取失败即 `unavailable`，不再做写入探针 | 通过 |
| R1／无法证明只读边界／IP-01 | 同上；写入成功、内容变化、超时、非 `EROFS/EACCES/EPERM` 均不报可用，且无更宽权限回退 | 通过 |
| R2 doctor 与授权审阅暴露同一能力结论／授权前发现不可用／IP-02、IP-03 | `doctor.ts`、`foreground-planning-runtime.ts`；`tests/doctor.test.ts`、`tests/bootstrap/execution-authorization.test.ts` | 通过 |
| R2／环境修复后重新审阅／IP-03 | 审阅每次现探、批准前重探；`execution-authorization.test.ts` | 通过 |
| R3 执行期按受限能力失败关闭／Recovery 前能力不可用／IP-04 | `execution-runtime.ts`；`tests/recovery/capsule-dispatch.test.ts`（零新派发、零预算、不进入报告等待） | 通过 |
| R3／Finalizer 前能力不可用／IP-04 | `foreground-planning-runtime.ts`；`tests/bootstrap/execution-finalizer.test.ts`（只 blocker、无 deliverable） | 通过 |
| R3／已派发角色遇到能力变化／IP-04 | 既有派发按原身份对账；`execution-finalizer.test.ts`、`capsule-dispatch.test.ts` | 通过 |
| 本机只读命令与真实 Capsule／Finalizer／deliverable／IP-05 | 上表三组隔离项目真实运行 | 通过 |

### IP 矩阵

| IP-ID | 内容 | 结果 |
| --- | --- | --- |
| IP-01 | 共享只读 profile、移除 `use_legacy_landlock`、新增无模型宿主/沙箱探针 | 通过 |
| IP-02 | `doctor` 独立检查项，失败非零，不接 Route Planning 启动门 | 通过 |
| IP-03 | 授权审阅显示结论、批准前重探、失败不写授权 | 通过 |
| IP-04 | Capsule／Finalizer 新派发前探测，既有派发按原身份对账 | 通过 |
| IP-05 | 本机真实 Capsule、替代 Session、只读 Finalizer 与 `deliverable` | 通过 |

### 全量门禁

`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`、`openspec validate m2-repair-read-only-worker-sandbox --strict`、`git diff --check` 全部通过。`pnpm test` 为 139 files passed / 6 skipped、1231 tests passed / 12 skipped（80.06s），记录在 `/tmp/codex-btrfs-fix.KK41s5/all-verification.log`；收尾的 cleanup-diagnostics 变更另加 18 tests，type／lint／build 亦通过。`git status --short` 只含本 change 的实现、测试、文档与本报告；`references/orca` 无改动。

### 本轮修复清单（真实验收暴露）

| 修复 | 位置 |
| --- | --- |
| 探针以真实 errno 判拒写、复现来源 `config.toml` 冲突规则、清理失败追加有界诊断 | `src/adapters/agents/codex-read-only-probe.ts` |
| Capsule 报告形状与生产提示共享（`recoveryCapsuleInstructions`＋可解析样例）、原生 `payload` 元数据与 `body` 正文分离、按 Task AND Dispatch 配对 | `src/adapters/agents/utility-worker.ts` |
| Finalizer 原生 locator／`body` 严格 JSON／身份匹配但不可读时报 `finalizer_report_invalid` 而不退回 `pending`／Task spec 带权威引用提示 | `src/bootstrap/foreground-planning-runtime.ts` |
| PTY 断言读持久身份与 Git 事实、只读观察走 TUI 进程投影、重启核验 dispatch 集合不变 | `tests/tui/pty-execution.test.ts` |

## 限定审计

§8 七项全部通过：

| 项 | 结果 | 依据 |
| --- | --- | --- |
| read-only-enforcement | 通过 | 探针四项证据齐备才 `available`；拒写必须来自实际文件写入权限错误 |
| no-permission-fallback | 通过 | 无 Landlock／`workspace-write`／全权限回退分支，失败即 blocker |
| no-duplicate-dispatch | 通过 | 先查 `findDispatchedUtilityWorker` 与既有 intent 才探测；既有派发直接对账 |
| zero-budget-on-preflight-failure | 通过 | Recovery 在派发前 `failed`，不写 `consumedBudget`、不进入 120s 等待 |
| doctor-vs-planning-start | 通过 | `read-only-worker` 为独立 check，Route Planning 启动门不引用它 |
| no-unverified-deliverable | 通过 | 结论缺失时不接受 deliverable；身份匹配但正文不可读时报 `finalizer_report_invalid` |
| no-host-mutation | 通过 | 临时目录在项目树外、不读 `auth.json`；`references/orca` 无改动 |

## 复现命令（隔离环境，需显式 opt-in）

```sh
pnpm typecheck && pnpm lint && pnpm test && pnpm build && openspec validate m2-repair-read-only-worker-sandbox --strict
```

```sh
# 探针与 dispatch/authorization 门禁
pnpm exec vitest run tests/adapters/agents/codex-read-only-probe.test.ts tests/adapters/agents/codex-launch.test.ts
pnpm exec vitest run tests/doctor.test.ts tests/bootstrap/execution-authorization.test.ts
pnpm exec vitest run tests/recovery/capsule-dispatch.test.ts tests/bootstrap/execution-finalizer.test.ts
```

```sh
# 真实闭环：先 pnpm build，每条命令使用全新隔离项目与专用身份
# 前置：隔离 alpha 与包装器只在本次进程的 PATH 生效，否则会落回全局正式版 0.157.1 重现沙箱失败
export PATH="/tmp/codex-btrfs-fix.KK41s5/acceptance-bin:$PATH"
export GH_REPO=leike0813/orca-companion-test
# 凭据由既有 .env.smoke 装载；isolated-project 与 identity 每次新建

ORCA_COMPANION_REAL_HARNESS=1 ORCA_COMPANION_REAL_REPO=<fresh-isolated-project> \
  ORCA_COMPANION_REAL_IDENTITY=<fresh-dedicated-identity> \
  ORCA_COMPANION_REAL_WORKER_MODEL=minimax-cn/MiniMax-M3 \
  pnpm exec vitest run tests/recovery/acceptance/real-validator-partial.test.ts --no-file-parallelism

ORCA_COMPANION_REAL_HARNESS=1 ORCA_COMPANION_REAL_REPO=<fresh-isolated-project> \
  ORCA_COMPANION_REAL_IDENTITY=<fresh-dedicated-identity> \
  ORCA_COMPANION_COORDINATOR_MODEL=minimax-cn/MiniMax-M3 \
  pnpm exec vitest run tests/tui/pty-execution.test.ts --no-file-parallelism
# PTY 不中断模式：加 ORCA_COMPANION_PTY_RECOVERY_INTERRUPT=0，另用一个全新隔离项目
```

## 后续注意事项

- 探针与生产启动的 argv 形态不同（探针 `--profile`＋`--permission-profile`；生产 `--profile` 由 `default_permissions` 生效），两者共享同一份 profile 文件与只读语义；该口径已写在 `docs/orca-compatibility.md`。
- `messageFromDispatch` 由 OR 收紧为 Task AND Dispatch，与实测的真实 `worker_done` 形状一致。
- 验收用的临时目录、包装器与日志位于 `/tmp/codex-btrfs-fix.KK41s5/`，不属于发布物；正式版包含上游修复后需在正式版上重跑同一探针与真实闭环。
