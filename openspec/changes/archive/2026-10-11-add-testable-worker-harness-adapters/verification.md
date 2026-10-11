# Verification

## 验收对象

- Change：`add-testable-worker-harness-adapters`。
- 输入实现 HEAD：`1a3eaf7577a3fe62af3e8a35ba5451080ac34e47`。
- 最终验收 HEAD：`1a3eaf7577a3fe62af3e8a35ba5451080ac34e47`；实现未提交，HEAD 本身不代表工作区实现。
- 验收 Agent：Codex 主线程，按用户要求直接依据本对话上下文与既有验收记录汇总；限定独立审计由 Fermat（`gpt-6-luna`）完成。
- 固定实现：[检查点][checkpoint]记录 tracked binary diff 和 276 项 untracked manifest。diff SHA-256 为 `19c2c3a87067895087edfdf86889ec9d29c2d1612534331d27feeb2bd06fe7f3`，工作区指纹为 `64a3ab1b1a8ac322c96a0859103c0879f736af5f46cbaa0ad14b6d317c710dc1`。
- 上游 submodule：`cc5c85fb7a43ed52c6cd29157210020cd769d84c`，工作区干净；实际 Orca CLI/runtime 为 1.4.222。

本文件在固定检查点之后新增，属于验收文档，不在输入实现指纹内。本轮没有修改产品代码，也没有重新运行模型、全量测试或另起一次独立实现审查；下列结果来自此前已完成的实施、真实验收及限定审计。

## 结论

**PASS**，范围限本 change 在 Ubuntu x86_64 上的候选评估、通过候选接入、共享只读启动及已批准的 Controller 修复。

18 个候选已逐项评估；本轮正式纳入 **Command Code、Qwen Code**，保留 codex、claude、opencode、pi、omp，共七项显式注册。新增两项使用中国区 MiniMax M Plan 的 `MiniMax-M3.1-Flash-Preview`，完整 Worker 矩阵与独立混合 Controller 均通过。Controller 取得 `deliverable`，人工中断后的恢复、集成、私有 origin 推送及同 Scope 重启已证明。实施任务 10/10 完成，必要限定审计已结清。

PASS 不表示所有候选都可使用。MiniMax Code 缺 Orca 内置身份及完整精确 Session 接口；Antigravity 已以用户登录运行目标模型，但独立原生 Session 身份未获证明，未注册。Droid、Cline、Autohand、Copilot 保留待真实验证；其他候选按具体缺口排除。完整结论以[候选表][candidates]为准。

## 核验与修复证据

### Requirement / Scenario / IP-ID

| Requirement / Scenario / IP-ID | 证据或命令 | 结果 |
| --- | --- | --- |
| 应用层 WorkerHarness 端口与显式注册表：已注册 harness 进入既有生命周期；IP-02/03/04 | `src/application/ports/worker-harness.ts`、`src/bootstrap/worker-harness.ts`；[Worker 矩阵][matrix]、[Controller][controller] | 七项显式注册。新增两项进入既有角色、恢复和结算流程；原 Task/profile、业务 Attempt 与预算保持原语义。 |
| 未注册 harness 在派发前拒绝；IP-02/03 | `tests/application/worker-harness-registry.test.ts`、配置/授权既有测试；[最终检查][checks] | 未注册项结构化拒绝；不回退默认 harness，不改已批准绑定。 |
| 注册表唯一且显式；IP-02/03 | `src/bootstrap/worker-harness.ts`、registry 测试与全量回归 | 每个 ID 只有一个注册实现，无目录扫描或自动注册。 |
| 启动输入不含凭据与原生隔离；IP-02/03 | WorkerHarness 端口、原生 launcher/adapter 测试；[原生安全审计][native-audit] | Worker 不读取 Coordinator CredentialStore，继承真实环境；reporter/security 使用公开叠加接口，`expectedNative` 仅作核验。真实矩阵前后用户全局原生配置 hash 不变。 |
| 恢复按 adapter 的精确历史语义读取；IP-02/03/04 | 各 adapter 的 `readTranscriptIdentity`/`recoveryInstructions`；recovery 测试、[Worker 矩阵][matrix] | 身份复核及活动分支读取配方由 adapter 拥有。精确 resume、Validator 同 Session/context 续接与只读 Recovery 通过；缺身份或 transcript 保持不可证明。 |
| 新候选以真实能力证据纳入：完整证据后纳入；IP-01/03/04 | [候选表][candidates]、[Worker 矩阵][matrix]；模型选择/doctor 测试、[UI 证据][ui] | Command Code/Qwen 四角色、目标模型、精确 Session/native transcript、完整 coverage、原 Session 恢复、Validator 续接及 Recovery 均通过后正式注册；沿既有模型选择与 doctor 接缝。 |
| 缺必要能力时排除；IP-01/03 | [候选表][candidates]；[上游兼容记录][compatibility] | 18 项均有结论和来源。更新上游后，本次候选中 17 项有 builtin identity，MiniMax Code 没有；源码存在不等于本机支持或完整验收。缺必要证明者未注册，未伪造身份或修改 Orca DB。 |
| 未运行的验收如实保留；IP-01/04 | 候选表的 waiting 项；真实验收默认 skip；[最终检查][checks] | 登录/配置/完整真实运行未齐的项不计 PASS。Antigravity 的模型响应不扩大为完整资格；普通测试跳过真实开关，不产生外部验收操作。 |
| 生产只读启动：前台身份与只读防护同时成立；IP-03/04 | `tests/adapters/agents/read-only-execution-wrapper.test.ts`、[Worker 矩阵][matrix]、兼容记录 | bwrap 保留真实前台 Session/进程组；seccomp 拒绝 TIOCSTI/TIOCLINUX。真实 Orca 接管、仓库/Git/协调库拒写和精确 native state/工件可写均通过。 |
| 防护无法安装时拒绝启动；IP-03 | read-only wrapper 的 ABI/安装失败测试、全量回归 | 不支持的 ABI、x32/外来 ABI 或过滤器安装失败拒绝启动；不依赖可变 sysctl，不取消拒写挂载。 |
| D-06：批准范围内的 Controller 消息与恢复修复；IP-04 | [简明诊断][diagnosis]、[Controller 审计][controller-audit]；foreground-validator、execution-delivery、delivery-replay 等回归 | sender 按精确 Task/Dispatch 核验；问题确认后有界历史读取；退出 Validator 问题不再发许可；Capsule 沿统一整批确认；替代 Session 沿精确 Recovery 绑定读报告。unknown 不换 ID 重发，旧失败结算不回填。 |
| IP-04：独立混合 Harness Controller 闭环与重启 | [Controller 结构化证据][controller-json]；`tests/acceptance/worker-harness-controller.test.ts` | Command Code 规划/实现，Qwen 验证/恢复/Finalizer。公开回读证明人工关闭的原 Validator 已 exited，随后 Capsule、替代 Validator、集成、推送和 deliverable 通过。同 Scope 重启保留 5 bindings、1 Recovery、4 settlements 与预算，Recovery consumedBudget=1。 |
| IP-05：当前合同、支持名单和 #52 有界 UI 核验 | AGENTS.md、README、架构/接口/兼容文档、[候选表][candidates]、[UI 证据][ui] | 当前七项注册与能力边界已同步；沿 #52 现有布局、导航及返回约定。限定离线核验完成，不宣称六票完整人工视觉验收。 |
| IP-05：最终整合与固定检查点 | [最终检查][checks]、[固定实现][checkpoint]、下表 | 类型、lint、构建、全量测试、严格 change 校验及 diff 检查通过；无新增依赖、schema/持久化迁移、lab 业务变更或 Git 提交。 |

### 已执行命令

以下均为此前实际执行的结果；日志路径与更细范围见[最终检查][checks]。

| 命令 / 验收入口 | 结果 |
| --- | --- |
| `pnpm typecheck` | exit 0。 |
| `pnpm lint` | exit 0。 |
| `pnpm build` | exit 0；构建完成后再开始全量测试。 |
| `pnpm test --maxWorkers=1` | exit 0；204 文件通过、9 文件跳过；2394 测试通过、18 跳过；623.20 秒。 |
| `openspec validate add-testable-worker-harness-adapters --strict` | valid；最后一次在完成任务勾选后执行。 |
| `git diff --check` | exit 0。 |
| `tests/acceptance/worker-harness-matrix.test.ts`，显式真实验收开关与已配置的原生 profiles | 45 passed / 2 skipped，730.57 秒，exit 0；证据记载实际模型与精确资源身份。 |
| `tests/acceptance/worker-harness-controller.test.ts`，显式 mixed Controller 开关与原 Scope | 1 passed，46.15 秒，exit 0，最终 deliverable。 |
| `pnpm exec vitest run --maxWorkers=1 tests/recovery/delivery-replay.test.ts` | 14/14 通过，覆盖普通结果 confirmed/unknown 的精确确认 lane。 |
| `pnpm exec vitest run --maxWorkers=1 tests/bootstrap/execution-finalizer.test.ts` | 11/11 通过，包含已完整结算 Finalizer 的同 Scope 重启复用。 |

真实验收入口需要原生认证、Orca 和精确隔离身份；不复制已清理 fixture 的旧运行命令作为当前可直接重放的指令。未设置真实开关时如实 skip。

### 修复记录

本轮写入 verification 时新增修复：**无**。此前实施及审计修复包括：

- 原生 transcript 读取拒绝 symlink 替换与 malformed UTF-8，保留大小和身份边界。
- 共享只读启动以 seccomp 保留终端注入防护，同时让 Orca 识别真实前台 harness。
- Controller 消息身份、问题正文读取、退出 Validator 游标、Capsule 消费、替代派发顺序及首次授权租约接线。
- 工作包标题进入已有 instructions，最终 Validator 报告保留完整 evidence JSON。
- 替代 Validator 使用精确 Recovery launch 报告；已确认 Delivery 清除匹配旧 blocker，终态 frontier 不再投影为等待；完整结算的 Finalizer 重启复用既有事实。
- 验收中断增加公开 exact Worker exited 回读，不把关闭请求 accepted 当成退出证明。

修复复用既有授权、身份、预算、消费和结算事实，无新持久化状态。失败/unknown 现场保留原结论。

## 限定审计

必需范围：native-auth、exact-session、original-task-binding、readonly-overlap、catalog-provenance、bounded-transcript、unknown-reconciliation，以及获批扩展的 Controller 消息/恢复、旧 blocker 和已结算 Finalizer 重启路径。

[原生安全审计][native-audit]记录认证归属、精确 transcript 读取和 C/Q 原生权限边界；其指纹属于当时历史检查点，最终身份以本文件验收对象中的检查点为准。[Controller 限定审计][controller-audit]由 Fermat（gpt-6-luna）执行静态只读核验。发现的重复 Capsule ack、关闭后缺退出证明、普通结果 confirmed 但 laneKey 为空导致旧 blocker 无法清除，均已修复并有回归结果；最后复核未发现可证实新增问题，无必需审计待办。

独立审计没有复跑模型或测试。真实运行与最终检查由主线程完成，审计结论仅覆盖上述范围，不扩大为全仓审计。

## 后续注意事项

- 当前验证限 Ubuntu x86_64。Windows/arm64 未实测，不能标记为已支持。
- Command Code/Qwen 写角色使用原生 `--yolo`，没有额外 OS 文件隔离；只读角色使用生产 bwrap/seccomp。Command Code 原生 taste learning 可能产生范围外路径，严格任务需用户在原生项目设置中配置；Companion 保留原生配置并拒绝越界交接。
- 两项新增 harness 缺公开无 prompt 模型目录时允许手填 exact ID，effort/catalogSource 保持 null，不据模型名字推断能力。
- 待验证/排除候选未来需要补齐各自身份、恢复、认证或完整真实验收证据后才能注册。更新 submodule 不升级本机 Orca，也不自动扩大支持名单。
- 一次性现场已存证回收：累计 135 个终端、21 个 checkout。认证、native transcript 与归档保留；见[回收汇总][cleanup]。
- 本文件仅完成验收文档。实现和规格未提交、未同步主规格、未归档；这些操作不由本次写入自动触发。

[checkpoint]: ../../../artifacts/next-worker-harness-adapters/implementation-checkpoint-20261011.json
[checks]: ../../../artifacts/next-worker-harness-adapters/final-checks-20261011.md
[matrix]: ../../../artifacts/next-worker-harness-adapters/ip04-2026-10-11T05-08-24-154Z-7fc1a011-b14e-47d2-8e5a-e550e0635a8d.md
[controller]: ../../../artifacts/next-worker-harness-adapters/controller-20261011T085821980Z-89759c30-e5f4-4a09-8624-89e137fe85f5.md
[controller-json]: ../../../artifacts/next-worker-harness-adapters/controller-20261011T085821980Z-89759c30-e5f4-4a09-8624-89e137fe85f5.json
[candidates]: ../../../docs/research/next-worker-harness-candidates.md
[compatibility]: ../../../docs/orca-compatibility.md
[native-audit]: ../../../artifacts/next-worker-harness-adapters/limited-audit.md
[controller-audit]: ../../../artifacts/next-worker-harness-adapters/controller-limited-audit-20261011.md
[diagnosis]: ../../../artifacts/next-worker-harness-adapters/controller-blocker-investigation.md
[ui]: ../../../artifacts/next-worker-harness-adapters/ui/README.md
[cleanup]: ../../../artifacts/next-worker-harness-adapters/cleanup-summary-20261011.json
