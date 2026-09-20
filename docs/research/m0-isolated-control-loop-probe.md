# M0 隔离控制闭环探针

对应 Decision Ticket：[*执行隔离的 M0 控制闭环探针*](https://github.com/leike0813/orca-companion/issues/8)，隔离边界来自 [*确定 M0 隔离探针的范围与安全边界*](https://github.com/leike0813/orca-companion/issues/10)。

## 结论

2026-09-18（Asia/Shanghai）在本机 Orca 1.4.198 上完成了一次真实、隔离的单 Worker 闭环：专用协调终端成功以 stable pane identity 创建并绑定 Run；Controller 创建一个 Task，通过 `worker-start` 启动一个 Codex Worker；Worker 修改夹具、提交带 task/dispatch 归属的 `worker_done`；Controller 验证结果、确认 Delivery、释放 Worker；随后新的 CLI 进程重新绑定原 Run，并找回同一 Task、Dispatch、回执和空收件箱。全程只有一个 Task 和一个 Dispatch，没有重复派发。

M0 的协调者身份硬门通过。Orca 的 Run/Task/Dispatch、消息确认、请求对账、资源释放与终端归档足以支撑这个受监督串行闭环。

Codex provider session 的公共绑定链未通过。Worker 自报的 `CODEX_THREAD_ID`、`CODEX_SESSION_ID`、rollout 文件名和 `session_meta.id` 完全一致，且 cwd 唯一匹配；但 `worker-read --source transcript` 在运行中、完成后和释放后都不能取得 provider transcript：运行中/完成后为 `session_not_reported`，释放后明确表示 archive 只有 terminal output。现有结论“已安装 hook 即可让 Orca 读取真实 Codex transcript”不成立，至少在这条实际启动路径上不成立。

## 范围与环境

| 项 | 值 |
| --- | --- |
| Companion 仓库 HEAD | `cd29e2bcd8b0278d34ae19db64cb8ebdaf149279` |
| Companion 原有 dirty paths | `CONTEXT.md`、`docs/research/` 均为用户未跟踪内容；探针未改写既有文件 |
| CLI / runtime | `orca-ide` / Orca `1.4.198` |
| runtime | `ready`、`reachable: true`、`runtimeId: f34e8953-f5ae-42b8-97db-90e33112562f` |
| host / environment | 唯一 host `local`（Linux）；远程 environments 为空 |
| 执行时间 | `2026-09-17T20:58:16Z` 至约 `2026-09-17T21:02:50Z` |
| 一次性仓库 | `/tmp/orca-companion-m0-probe.AAo1Yz` |
| Git 状态 | unborn `main`，无 remote，无 commit；最终仅 3 个未跟踪夹具/报告文件 |
| 实际 Worker | Codex；`worker-start` 的 requested/effective agent 均为 `codex`，model/effort 使用本机默认值 |

执行前 Orca 中另有 14 个 connected/writable 终端。探针未读取、发送、停止或修改其中任何一个，也未重启全局 Orca runtime。后者既不在票据授权内，也会影响无关 live workload。

## 对象与回执

| 对象/操作 | 标识 |
| --- | --- |
| Orca repo | `c6a94748-9625-4fc0-b4d0-c5c27eab2236` |
| worktree | `c6a94748-9625-4fc0-b4d0-c5c27eab2236::/tmp/orca-companion-m0-probe.AAo1Yz` |
| Coordinator terminal | `term_4d8b2d16-b685-435c-8375-b968c36ed442` |
| Coordinator pane | `fdf789f4-f2c2-466e-b16b-2180244d3e0f:3cd6887a-a683-4bfc-9bbc-13868c5d7a4a` |
| Run | `run_ad0f923b4f69` |
| Run create request | `47b9079b-cbac-41dc-b2a8-5ba5ff30efaf` |
| Task | `task_9998557d8f08` |
| Task create request | `cb515600-1c0c-4894-9fc6-11b1512ed60e` |
| Dispatch | `ctx_825b15c42cc1` |
| Worker terminal | `term_13c9a78a-be51-4e29-b08e-922a7dca9680` |
| Worker start request | `9cb78bc1-038c-406d-ae3d-0dfe012a576b` |
| `worker_done` message / Delivery | `msg_9df8a6afa03c` / `delivery_9fc9a0b6518d` |
| Worker release request | `651b4686-ab8d-46f2-b924-169f4f1421ca` |
| Delivery ack request | `a1aaa052-b936-411b-a839-655705f6e22f` |
| Re-bind request | `5005fb4a-c596-4e6f-b093-c495c6b54bed` |

## 执行记录

以下命令都在一次性仓库或 Companion 仓库内执行；输出使用 `--json` 并做有界读取，未保存认证信息或无关 transcript 内容。

### 1. 建立基线与隔离仓库

```sh
orca-ide --version
orca-ide status --json
orca-ide host list --json
orca-ide environment list --json
orca-ide orchestration run-list --json
orca-ide terminal list --json

mktemp -d /tmp/orca-companion-m0-probe.XXXXXX
git init -b main
git status --short
git remote -v
orca-ide repo add --path /tmp/orca-companion-m0-probe.AAo1Yz --json
```

结果：创建无 remote、无 commit 的一次性仓库；Orca 只登记它自己的 main worktree。初始夹具为 `README.md` 和 `probe-input.txt`，均未提交。

### 2. P1：真实协调者身份绑定

```sh
orca-ide terminal create \
  --worktree path:/tmp/orca-companion-m0-probe.AAo1Yz \
  --title "M0 probe coordinator" --command "zsh" --json

orca-ide orchestration run-create \
  --objective "Orca Companion M0 isolated control-loop probe for GitHub issue 8" \
  --from term_4d8b2d16-b685-435c-8375-b968c36ed442 --json
```

结果：`run-create` 成功，返回真实 coordinator handle、pane key 和 `consumer_generation: 1`。没有出现 `no_active_sender_terminal`、`stable_pane_required` 或 `consumer_fenced`。P1 通过。

### 3. 创建并启动唯一 Worker

Task 明确限制 Worker 只能访问一次性仓库，只能修改 `probe-input.txt` 和 `probe-report.json`，不得 commit、push、发布、部署、安装依赖或联网。它必须自报 Codex 标识，并且只能用 `CODEX_THREAD_ID` 的精确文件名后缀定位 rollout；匹配数不为 1 即失败，禁止用 cwd + mtime 猜测。

```sh
orca-ide orchestration task-create \
  --run run_ad0f923b4f69 \
  --from term_4d8b2d16-b685-435c-8375-b968c36ed442 \
  --task-title "Probe Codex session binding and control loop" \
  --display-name "M0 probe worker" \
  --spec '<bounded task envelope>' --json

orca-ide orchestration worker-start \
  --task task_9998557d8f08 \
  --worktree path:/tmp/orca-companion-m0-probe.AAo1Yz \
  --agent codex --run run_ad0f923b4f69 \
  --from term_4d8b2d16-b685-435c-8375-b968c36ed442 \
  --timeout-ms 60000 --json
```

结果：`worker-start` 返回 `state: ready`、`stage: input_accepted`，复用指定 worktree，创建唯一 agent terminal；`requested` 与 `effective` 均为 Codex，`residualResources` 为空。`request-show` 随后确认启动 request 为 `completed`，重放同一 request 会返回原收据而不会启动第二个 Worker。

### 4. 运行中读取与完成消息

```sh
orca-ide orchestration worker-show --dispatch ctx_825b15c42cc1 --json
orca-ide orchestration worker-read \
  --dispatch ctx_825b15c42cc1 --source transcript --limit 80 --json

orca-ide orchestration check \
  --terminal term_4d8b2d16-b685-435c-8375-b968c36ed442 \
  --run run_ad0f923b4f69 --wait \
  --types worker_done,escalation,question --timeout-ms 30000 --json
```

第一次 `worker-show` 证明 `observation.status: live` 且 `exactWorker: true`。强制 transcript 读取失败为：

```json
{
  "code": "transcript_required",
  "data": { "reason": "session_not_reported" }
}
```

两个 30 秒 wait window 仅产生 keepalive，按契约视为 checkpoint，不视为 Worker 失败，也没有重派发。第三个 window 收到唯一 `worker_done`；message 的 task/dispatch 与当前对象一致，outcome 为 `succeeded`，报告路径为 `/tmp/orca-companion-m0-probe.AAo1Yz/probe-report.json`。Task 和 Dispatch 随即自动变为 `completed` / `succeeded`。

### 5. Session Binding 证据

Worker 报告及 Controller 对 rollout 首行的独立核对结果：

| 字段 | 值 |
| --- | --- |
| `CODEX_THREAD_ID` | `01a0b12a-5543-7951-b0e7-4e00cb8bf70b` |
| `CODEX_SESSION_ID` | `01a0b12a-5543-7951-b0e7-4e00cb8bf70b` |
| rollout 文件名后缀 | `01a0b12a-5543-7951-b0e7-4e00cb8bf70b` |
| rollout 精确匹配数 | `1` |
| 首行类型 | `session_meta` |
| `session_meta.id` | `01a0b12a-5543-7951-b0e7-4e00cb8bf70b` |
| `session_meta.cwd` / Worker cwd | 均为 `/tmp/orca-companion-m0-probe.AAo1Yz` |
| Codex CLI / provider / originator | `0.154.0` / `openai` / `Codex Desktop` |

因此在本机当前 Codex 版本中，`CODEX_SESSION_ID` 实际与 `CODEX_THREAD_ID` 相同，可作为同一个 provider session id。Worker 自报 id + `CODEX_HOME` 后，Controller 能以精确文件名后缀和 rollout 首行 id + cwd 无歧义绑定当前 Dispatch。

这只证明 self-report 路径，不证明 Orca hook 路径。公共 `worker-show` 没有给出 hook `session_id`，`worker-read --source transcript` 始终报告 `session_not_reported`，所以无法独立比较“hook session_id”与上述四项。

### 6. 释放、归档与 Delivery 确认

```sh
orca-ide orchestration request-show \
  --request 9cb78bc1-038c-406d-ae3d-0dfe012a576b --json
orca-ide orchestration worker-release --dispatch ctx_825b15c42cc1 --json

orca-ide orchestration worker-read \
  --dispatch ctx_825b15c42cc1 --source auto --limit 20 --json
orca-ide orchestration worker-read \
  --dispatch ctx_825b15c42cc1 --source transcript --limit 20 --json

orca-ide orchestration check \
  --terminal term_4d8b2d16-b685-435c-8375-b968c36ed442 \
  --run run_ad0f923b4f69 --ack delivery_9fc9a0b6518d --json
```

结果：release 只关闭该 Dispatch 拥有的 agent terminal，返回 `state: released` 和 `processAction: closed_agent_terminal`；archive 为 `source: terminal, status: captured`。释放后 `worker-read --source auto` 能读取 `archived: true` 的精确 terminal archive，且 capability token 已脱敏；强制 transcript 则明确失败：

```text
Structured output is unavailable for released Dispatch ctx_825b15c42cc1:
the archive holds terminal output only.
```

这证明 terminal archive 在回收后仍可按 Dispatch 精确读取，但不等于 provider transcript pin/archive。处理完结果并释放 Worker 后，整批 Delivery 成功确认；随后收件箱为空。

### 7. 控制端重启模拟与去重对账

没有可重启的 Companion 产品进程，因此使用新的无进程内状态 CLI 调用重新绑定并重建快照；未重启全局 Orca runtime。

```sh
orca-ide orchestration run-use \
  --id run_ad0f923b4f69 \
  --from term_4d8b2d16-b685-435c-8375-b968c36ed442 --json
orca-ide orchestration run-current \
  --from term_4d8b2d16-b685-435c-8375-b968c36ed442 --json
orca-ide orchestration task-list \
  --run run_ad0f923b4f69 \
  --from term_4d8b2d16-b685-435c-8375-b968c36ed442 --json
orca-ide orchestration worker-list --run run_ad0f923b4f69 --json
orca-ide orchestration request-show \
  --request 9cb78bc1-038c-406d-ae3d-0dfe012a576b --json
orca-ide orchestration check \
  --terminal term_4d8b2d16-b685-435c-8375-b968c36ed442 \
  --run run_ad0f923b4f69 --json
```

恢复结果：原 Run 仍绑定同一 pane；恰好 1 个 completed Task、1 个 completed/succeeded/released Dispatch；启动 request 仍为 `completed`；收件箱为 0；一次性 worktree 只剩 Coordinator terminal。没有调用第二次 `worker-start`，也没有产生第二个 Dispatch。

## 判定矩阵

| 探针 | 结果 | 证据/限制 |
| --- | --- | --- |
| P1 协调者身份 | 通过 | CLI 创建的真实终端 handle 可执行 `run-create --from` |
| P2 组合启动与回执 | 通过 | `ready/input_accepted`，requested/effective 一致，request 对账为 completed |
| P3 消息投递、归属与确认 | 通过 | `worker_done` 的 task+dispatch 精确匹配；先处理/释放，后整批 ack |
| P4 Run/Dispatch 恢复 | 通过 | 新 CLI 进程找回同一 Run、Task、Dispatch、request；无重复派发 |
| P4 provider session/transcript 恢复 | 未通过 | self-report 可精确绑定；Orca hook 未报告 session，释放后只有 terminal archive |
| P5 迟到 `worker_done` fence | 未执行 | 本次只有一个 Dispatch、没有 replacement；为了制造迟到消息而额外启动 Worker 没有必要 |
| P6 PTY Worker 读取 | 部分通过 | exact terminal live/exited 状态与 archive 可读；provider transcript 不可读 |

## 无法验证项与后续输入

- `transcript_unavailable` 已有真实等价失败：运行中/完成后为 `session_not_reported`，释放后为 terminal-only archive。
- `transcript_partial` 未真实产生。当前公共接口连 provider transcript source 都未建立；人为截断或破坏 rollout 只会测试夹具破坏，不会证明正常控制链行为。
- `Recovery Budget` 是 Companion 的业务规则，不是 Orca 原语。产品 Controller 尚未实现，无法真实验证“一次恢复后再次中断即 blocked”；该项应在 M1 的 fake backend 行为测试和一次真实 session recovery 集成测试中验证。
- 未重启全局 Orca runtime，因此 runtime 重启后的 terminal handle remint 与 provider session 行为仍未验证。现有无关 live workload 且票据未授权该操作。
- 没有专门制造未知 mutation 结果；但启动 request 已用 `request-show` 对账为 completed，证明正常恢复路径可用。

这些事实直接作为 [*裁决 M0 可行性与后续路线*](https://github.com/leike0813/orca-companion/issues/12) 和 [*确定 Orca adapter DTO、错误与对账契约*](https://github.com/leike0813/orca-companion/issues/17) 的输入，无需新增重复 Decision Ticket。

## 保留与清理

一次性仓库 `/tmp/orca-companion-m0-probe.AAo1Yz`、三个未跟踪文件、Run、Task、Dispatch、回执、terminal archive 和专用 Coordinator terminal 均按票据要求保留供用户检查。Worker terminal 已通过 `worker-release` 精确释放。未删除仓库、未移除 Orca repo、未关闭 Coordinator terminal；清理需要另行授权。
