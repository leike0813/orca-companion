## 1. 基线与原生能力

- [x] 1.1 IP-01 核验前驱、冻结接缝、七家当前原生报告/恢复/导出事实，记录版本与缺口。

## 2. 独立报告安装

- [x] 2.1 IP-02 实现 install/status/uninstall 与启动只检查，验证保留用户配置、普通启动无动作及拒绝边界。

## 3. 完整 adapter 与离线验证

- [x] 3.1 IP-03 实现 Antigravity 的精确 Session/恢复/覆盖/目录/Recovery 与离线验证。
- [x] 3.2 IP-03 实现 Kilo、Kimi 的完整 WorkerHarness 与离线验证。
- [x] 3.3 IP-03 实现 Hermes 的完整 WorkerHarness 与离线验证。
- [x] 3.4 IP-03 实现 Cline 的完整 WorkerHarness 与离线验证。
- [x] 3.5 IP-03 实现 Muse、Cursor 的完整 WorkerHarness 与离线验证，记录后续真实验收任务。

## 4. 真实验收与注册

- [x] 4.1 IP-04 Antigravity 使用已登录订阅探索完整四角色、resume、Validator续接、Recovery及生产只读/foreground资格；通过或形成有原生证据与重验前置条件的延期结论。
- [x] 4.2 IP-04 Kilo/Kimi/Hermes/Cline 使用中国 MiniMax M Plan 逐家探索同一真实矩阵；各自通过或记录具体原生阻塞、已尝试路径与重验前置条件后延期。
- [x] 4.3 IP-04 新通过项参与 mixed Controller、人工中断及同Scope重启闭环，存证后回收测试资源。

## 5. 最终集成与报告

- [x] 5.1 IP-05 仅注册真实通过者，更新受影响caller/fixture、当前合同、支持文档与OpenSpec上下文。
- [x] 5.2 IP-05 完成types/lint/build/full tests/strict/diff与限定审计，verification如实记录四级状态。

当前为 12/12 tasks，独立 verification 结论 PASS，见 [verification.md](verification.md)。
六家未注册候选的逐家进展、延期原因、保留现场和续办条件见 [handoff.md](handoff.md)。
新增生产注册 1（Antigravity），总八家。七家实现与离线验证完成；Antigravity 1.3.4
已通过 TUI 四角色、Implementation resume、Validator 同 Session 续接与新 Recovery，
其他六家按具体原生阻塞或账号/CLI前置条件延期。延期不作为真实资格通过。

2026-10-14 第二轮 mixed Controller 完整通过：Scope
`ip04-mixed-controller-33ba70e3-434f-4925-8c91-20003d91e78e`、Run
`run_ca667d0144a9`；Qwen 0.25.1 精确 Validator 中断后完成 Capsule、替代 Session、
验证 passed、集成、私有 origin 推送与 Finalizer deliverable。同 Scope 重启保持
5 个 binding、1 次 Recovery、4 项结算及已消耗预算；真实测试 1 passed/exit0。
本轮 5 个已结算 prepared 外部终端与两个空闲 fixture shell 已按精确身份公开关闭，
仓库文件保留供独立验证。证据 `controller-20261014T033336705Z-09c8d325-3fc7-4e49-bcd9-aebad90db5e1.json`
与 `controller-cleanup-20261014.json`。旧失败轮次及 Qwen 菜单风险保留原范围。
注册复用 canonical ID、registry、通用 probe executable 和原生目录 owner，既有
registry/probe/Antigravity 测试 53 passed，types/lint/build 通过；最终全量
2551 passed / 18 skipped，独立限定审计 no findings、125 项相关回归通过。doctor 的原生目录查询已改经所属
harness.queryModels，结果回归通过且不读取 Coordinator 凭据。真实无 executable override 的通用 probe
available/host-verify，自报 agy 1.3.5（Controller 结束后本机二进制替换）；
新版本探针不替代完整 1.3.4 角色资格。
5.2 包含独立 verification，apply 不创建该文件；以下记录保留各轮当时范围。

当前约束（2026-10-13）：用户禁止 patch Orca，只由本项目适配公开 CLI/runtime。
此前独立源码副本修复路线停止，补丁保留为历史诊断证据，不继续匹配或构建安装版。
stream 单轮桥接通过，但完整矩阵失败于 composer 就绪与持久身份复核，该实现已取消。
IP-03 当前实现为原生 TUI、系统 script PTY 和封闭于 Antigravity 的有界重复输入协议
过滤；保留真实 stdin、其他输出、bwrap/seccomp 与 Orca 的 preamble 提交归属。
原生 summary 按完整 ID 只读核验工作区，已配对工具 ERROR 允许作为终态，RUNNING
与未知仍拒绝完整覆盖。TUI 原型的真实监督、精确 Session 和覆盖已通过。
2026-10-14 矩阵沿原 Run、ready Task 和终端恢复，原生信任菜单确认后四个句柄均
取得公开 tui-idle satisfied/running。完整矩阵与 mixed Controller 继续验收；
4.3/5.1/5.2 保持未勾选，具体状态见研究记录「原生事实与当前验收」。

2026-10-14 TUI 方案四角色、Implementation resume、Validator 原 Session 标记
续接与新只读 Recovery 均通过。有界前台读取配方及夹具最终 assistant 证据等待
修正后，新恢复链的 complete/source/EROFS 全部通过；首轮后台 RUNNING 派发保留
为失败证据，覆盖判定未放宽。mixed Controller 已运行，Scope
`ip04-mixed-controller-f7c116b9-3be3-42b9-aedd-08246186e9b2`、Run
`run_f00be143e685`；原 prepared 公开就绪，Planner/Implementation 已接纳。
Qwen Validator 的原生 provider 更新菜单与启动/激活重合，精确 sidecar 存在、
transcript 缺失、report 为空，绑定窗口到期。宿主已准确停止，原 Task/终端保留，
未知输入不重发；证据见 `controller-qwen-startup-20261014.json`。
中断/Recovery、集成、Finalizer deliverable 和同 Scope 重启仍待验证。
当前 TUI 全量回归 2547 passed / 18 skipped，types/lint/build/strict/diff 通过；
不替代真实 Controller。资格证据见 `antigravity-tui-qualification-20261014.json`。

Antigravity + Qwen 的 mixed Controller 已建立隔离 fixture，Scope
`ip04-mixed-controller-485da76f-4ba2-4c13-941a-ff479dde1049`。验收宿主现经
`toChildEnvironment` 去除主终端身份环境，同 Scope 和原授权恢复通过。
原生工作区信任菜单确认后，原 prepared terminal 的公开 `tui-idle` 等待仍超时；
paneRuntimeId=-1、rendererGraphEpoch=0，不能用可见输入框代替 satisfied/running。
测试进程已停止，没有 Worker turn 在途，原终端与授权保留等待精确核验。
4.3、生产注册与独立最终 verification 保持未完成，不提前勾选。

2026-10-13 在 Orca 1.4.224 续接核验时，原 prepared 与协调 handle 均为
`terminal_handle_stale`，两个精确 worktree 的终端列表为空；原 worktree、Run 和
ready Planner Task 仍可读。公开打开桌面后复查不变，已请求 GUI 恢复已有资源。
不将空列表推断为退出，不新建终端或改写已接受创建记录；Controller 未重跑。
Antigravity/Worker launch 现有回归 20 项通过。当前阻塞和恢复条件见
`artifacts/next-worker-harness-adapters/controller-recovery-20261013.json`。
GUI 显示后读到一个 incarnation 不同的 orphaned 新句柄，列举遗漏 local host，
原句柄仍失效、新句柄 `tui-idle` 超时。原 launch 连续性不可证明；
用户已批准保留原现场并另建隔离 fixture；新验收不改写原 Scope/launch 身份或原创建记录。

获批的新 fixture `/var/tmp/orca-ip04-mixed-controller-lO3X04` 已建立授权、Run 和
ready Planner Task；Controller 恢复后仍无 Worker 派发。共享身份过滤已补
structured agent session 三项环境键，既有 doctor 回归与全量测试通过。
当前 Orca 1.4.224 / Antigravity 1.3.4 的原 prepared 资源可核验，公开 screen
匹配 composer 规则，但输出时钟持续前移，停止 Controller 前后均未取得 3 秒静默
佐证，公开就绪等待超时。具体原始输出及内部判定不可见，不伪称已锁定根因。
本轮测试父子进程已 SIGINT 停止，原生终端与两轮现场保留；恢复须沿本轮原身份取得
exact `tui-idle` satisfied/running。4.3、5.1、5.2 保持未勾选，详见新现场就绪记录。

继续探索已独立捕获 Antigravity 每约 2 秒重申的 22 字节输入协议设置；Orca 每个
原始数据块都更新输出时钟，持续打断 3 秒静默。捕获时序与离线回放确认该阻塞机制，
诊断终端已公开关闭，原现场保留。用户已批准在独立源码副本实现修复，固定 SHA
补丁和限定验证证据已产出：原 ingestion/lifecycle 三项回归失败，修复后 279 项限定
验证与核心严格类型检查通过；原始捕获从第 12 秒轮询起可接受固定可信 composer。
原 submodule、安装版与弱就绪策略未改。源码 package 1.4.214 与安装版 1.4.224 不同，
完整上游 build、实际 public tui-idle 和 Controller 尚未验证，任务状态保持 9/12。

本轮 typecheck、lint、build、OpenSpec strict、diff 通过；全量
`pnpm exec vitest run --maxWorkers=4` 最终为 2521 passed / 18 skipped，
212 文件通过、9 文件跳过。静态回归不代替真实 Controller。
独立限定审计发现的 Kimi 安装解析与 Muse 身份/覆盖缺陷已修复并独立复核关闭；
没有新增生产注册，完整 Controller 与 schema 要求的最终 verification 仍待完成。

当前资格、延期与恢复条件见：
- `docs/research/next-worker-harness-adapters.md`
- `artifacts/next-worker-harness-adapters/exploration-20261012.json`
- `artifacts/next-worker-harness-adapters/controller-preparation-20261012.json`
- `artifacts/next-worker-harness-adapters/controller-recovery-20261013.json`
- `artifacts/next-worker-harness-adapters/controller-readiness-20261013.json`
- `artifacts/next-worker-harness-adapters/tui-idle-protocol-output-20261013.json`
- `artifacts/next-worker-harness-adapters/tui-idle-repair-20261013.json`
- `artifacts/next-worker-harness-adapters/orca-tui-idle-activity-20261013.patch`
- `artifacts/next-worker-harness-adapters/audit-20261013.json`
- `artifacts/next-worker-harness-adapters/antigravity-stream-bridge-20261013.json`
- `artifacts/next-worker-harness-adapters/antigravity-tui-filter-20261013.json`

历史尝试及原 OperationId/unknown 回执保留于研究记录和各轮 evidence；
未重放旧 unknown，未放宽身份、覆盖、权限或 prepared terminal 就绪条件。
