# 多包并发真实验收（IP-05）

本目录是 `restore-configurable-execution-concurrency` 的真实验收现场：隔离 Git 项目、专用 Orca
身份与运行证据。历史 `artifacts/*` 的报告不改写。

## 文件

| 文件 | 作用 |
| --- | --- |
| `setup-fixture.mjs` | 建隔离仓库、写 schema 3 配置（并行额度 5）、建隔离凭据存储、登记 Orca、建专用身份，并打印调用环境变量 |
| `fixture-<name>.json` | 每次运行的现场身份记录（不含 secret） |
| `report-<scope>.json` | 一次完整验收的观测结果：活动包峰值、同时 live Worker 峰值、集成复验轮次、Finalizer Verdict |

## 运行

```sh
pnpm build
node artifacts/execution-concurrency/setup-fixture.mjs /tmp/orca-cc-<name> ip05-cc-<name>
# 按 setup 打印的 export 块设置环境，然后：
pnpm exec vitest run tests/acceptance/execution-concurrency.test.ts --no-file-parallelism
```

## 它证明什么

- 并行包额度可配置且大于设计时的保守假定 3（本验收取 5），并被真实使用：观测到 >=2 个 Work
  Package 同时活动；
- 两个独立 Work Package 的隔离 worktree 建立在同一条 baseline 上，且至少两个 Worker 同时 live；
- 串行 Git 集成把前移的 canonical 合并进后集成包的 worktree，由原 Validator 精确 provider Session
  复验（integration reconciliation，绑定原 Validation Attempt），最终取得 Finalizer Verdict；
- 退出重启读回同一批身份，不产生新的派发。

任何一项缺失都如实失败并写出上述报告，不把跳过或阻塞改写成通过。

## 当前结果：fixture 06 通过

隔离项目 `~/.cache/orca-acceptance/fixtures/orca-cc-concurrency-06`、专用身份
`term_e065b760-80d2-4e61-ae60-dce7c69c8ad8`、Run `run_c519360a61be`，模型
`minimax-cn/MiniMax-M3.1-Flash-Preview`。最终真实验收退出码 0，1 项通过：

- [完整恢复报告](report-orca-cc-concurrency-06-resume.json)：批准额度 5，公共 Worker 区间重叠峰 2；
  两包的持久化准入基线均为 `ee6cf84fd2450d48d8ac20925e6c213bd7dc9c07`，最终占位均已释放。
- [会话证据](session-starts-orca-cc-concurrency-06-resume.json)与[合并树证据](continuation-proof-06.json)：
  原 Validator 与续接 UUID 同为 `01a10b63-6084-7291-bf15-7fc07b88ab67`，业务 Validation Attempt 不变；
  续接使用新的物理 Task/Dispatch，round 1 validated。
- Finalizer 给出 `deliverable`；同 Scope 重启时两条非空原 Planner Task/Dispatch 集合保持相等，
  Work Package 状态与 Attempt 也不变。最终日志 `/tmp/orca-cc-06-restart-readonly.log`，`EXIT:0`。

首轮已取得真实 Verdict、随后因验收取证错误而失败的报告保留为
[首轮 Finalizer 报告](report-orca-cc-concurrency-06-finalizer-first.json)，日志
`/tmp/orca-cc-06-recovery-main2.log`。模型服务 529、旧取证失败均不计为通过；生产只返回当前占位，
最终验收以只读方式检查隔离项目的 Companion 数据库中当前图的占位历史。未访问 Orca 数据库。

完整常规验证：1950 项通过、14 项跳过；typecheck、lint、build 与 OpenSpec strict 均通过。
TUI 三档画面及 PTY 证据见 [执行设置验收](../execution-settings/README.md)。

## 历史现场 02（未通过）

已执行真实隔离运行，分两段，均**未取得 Finalizer Verdict**，不计通过：

- 播种段（/tmp/orca-cc-concurrency-02，身份 term_47830d25…，Run run_5fc0863c9434）：两包 readme-banner 与
  notes-basics 同 base 并发启动，lane 同时 held，两个真实 Orca Task/ctx 派发与两条 planner Session Segment
  成立。原峰证据见 evidence-ip05-cc-02-peak.json。该段在 planner→implementation 角色边界停住（logical
  draft Dispatch 与真实 ctx Dispatch 身份不一致），已由主线在 shared helper 修正。
- 恢复段（同一 Scope，resume 模式，未 seed、未重授权）：复用原 planner Task，新派两包 implementation
  （notes-basics 走通 impl→validator 并 accepted；readme-banner implementation **从未启动**）。
  只读证据（公共）：该包 implementation 有 Task `task_b7bc2a940756` 与逻辑 binding
  `dispatch:…:readme-banner:implementation:4217450013436908:1`、attempt 同后缀，但**没有** SessionSegment、
  没有物理 `ctx_`；`orchestration task-list` 显示 `task_b7bc2a940756` 状态为 **`ready`**（其余 Task 均
  `completed`），`dispatch-show --task task_b7bc2a940756` 返回 `dispatch: null`。intents 只有
  `materialize-task` 与 `materialize-worker-terminal`（均 settled/accepted），**没有** `materialize-worker-start`。
  该包 implementation 的 per-launch CODEX_HOME（digest `925a2a2eb6a11cd6dd64`）只有 reporter hook、**没有** SessionStart 报告（其余 4 次启动都各有一份 `.jsonl`），进一步证明该 Codex 会话从未启动。
  因此 worker-list 缺该 Dispatch 的原因是「Dispatch 从未创建（Task 停在 ready）」，不是 ack 删除了 Worker。
  已停止宿主、保留现场，待 central 与 IP03 修复后在原 Scope resume，不重派、不写 store。

**并发峰的真实 worker-list 同时 live 样本尚未落盘**：原段样本未持久化；探测终端（term_f0a38b8c…）的
worker-list 在该上下文不可用；只有 run-owner 终端可见，而它被前台宿主占用。恢复段宿主每 5 s 采样并会在
结束时写 observation.maxLiveWorkers；本次未跑到报告。已知真实现场事实：5 个 worker 终端（2 planner +
2 implementation + 1 validator），两包 implementation 绑定相差约 17 s。

日志：/tmp/orca-cc-02-run.log（播种段，人为停止）、/tmp/orca-cc-02-resume.log（恢复段，人为停止）、
/tmp/orca-cc-02-workerlist.log（探测终端采样，全 0，不可用）。

## 现场保留与后继

- 上述未通过现场**原样保留、不掩盖**：fixture 02（`/tmp/orca-cc-concurrency-02`，Scope `e2e-loop-scope`、
  Run `run_5fc0863c9434`、Task `task_b7bc2a940756` 停在 `ready`）连同其约 30 个同标题终端一起留着；
  生产修复会把 terminal-create 回执的 exact handle 持久化到 `OperationIntent.terminalHandle`（schema 19），
  原 `NULL` 不回填、旧现场明确 blocked。
- 后继验收使用独立现场 fixture 03（`~/.cache/orca-acceptance/fixtures/orca-cc-concurrency-03`，
  专用身份 `term_ac28b130-…`、独立 ref `ip05-cc-03-integration`），不再复用 fixture 02。

### 根因更正（fixture 03）

- 之前记录的“共享 OpenSpec config add/add 冲突、guard 正确”**不成立，已更正**：普通 Worker 的范围判定
  SSOT 是 `envelopeCheckedPaths`，它会把整个 `openspec/` 与工具目录过滤为不在 scope 内；03 的集成复验
  **续接 runtime 绕过了该 SSOT**，才把 `openspec/config.yaml` 误判成越权修改（旧规则本身不一致），
  属 production bug，不是在现场真实越权。负证据保留（round1 blocked 记录不改），但原因按此更正。
- 主线以最小复用修复该绕过；fixture 04 的 baseline 另预建标准 `openspec/config.yaml`（`openspec init`
  原样模板）作为并发场景的稳定前提。
## 独立现场 04 / 05 的真实阶段（未通过）

- **fixture 04**（`~/.cache/orca-acceptance/fixtures/orca-cc-concurrency-04`，baseline 预建标准
  `openspec/config.yaml`）：整轮跑到串行集成复验；两条 planner/implementation/validator 均 accepted。
  readme-banner 的集成复验 round 1 `blocked`，`blocker_ref=无法观察到该 Utility Worker 的精确 harness session 事实`。
  续接物理身份已落盘（`orca_task_id`/`dispatch_id` 与三条 accepted intent），但续接 SessionStart 报告不存在；
  原 Validator SessionStart 报告存在（`sessionId 01a10b09-…`）。证据：
  [evidence-orca-cc-concurrency-04-recon-round1.json](evidence-orca-cc-concurrency-04-recon-round1.json)。
- **fixture 05**（同法预建 baseline）：同样在集成复验 round 1 `blocked`，同一 blocker；
  续接 `worker-start` 已 accepted 但 `backend_request_id=null`（fresh binding unavailable），续接 SessionStart 报告缺席；
  原 Validator SessionStart 报告存在（`sessionId 01a10b1f-…`）。证据：
  [evidence-orca-cc-concurrency-05-recon-round1.json](evidence-orca-cc-concurrency-05-recon-round1.json)，
  运行期 peak/绑定证据：[report-orca-cc-concurrency-05-seed-partial.json](report-orca-cc-concurrency-05-seed-partial.json)。
- 两个现场的 host 均已按具体 pid 停止；Scope、Orca Task、预算与记录保留未改，未 reseed；Worker 未被 stop。
  04/05 的续接 launchId 按生产 callsite 为 `<原 Validator launchId>:round-<n>`，报告用生产
  `codexSessionPathsUnder` 精确路径有界读取，不做摘要猜测。

## 结论边界

- 当前通过结论只覆盖 fixture 06、当前实现及 Ubuntu 上实际核验的 Orca/Codex 版本。
- 02–05 未通过记录保留；04/05 的旧续接事实缺失，不从 probe 元数据回填 binding。
- 03 的负证据与更正原因保留（见上节）；04/05 的 blocked round 原样保留，不伪造为通过。
