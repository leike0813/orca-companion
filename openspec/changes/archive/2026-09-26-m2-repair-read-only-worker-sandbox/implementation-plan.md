# Implementation Plan

## 1. 实施基线与权威来源

**模式：`predecessor-contract`。** 直接前驱为已归档的 `m2-wire-execution-runtime`；`m2-deliver-execution-tui` 为并行项，本 change 消费其已固定接缝，为其真实验收解阻塞。本 change 先验收、归档，执行 TUI 随后补齐剩余真实场景。原规划 HEAD 为 `d2ea092d936841e803d933792d75dc5f7eedbb64`，本次核验基线为 `1fb068caa41b536c21fd02419ee5fd822fb20c22` 加已审查的未提交实现。保留当前修改，不覆盖回规划时版本。

冻结接缝：执行 TUI 并行项的 Finalizer 投影、`readOnlyProfile` blocker、授权审阅 `manifestRows`/`gate`、真实 PTY 隔离项目入口；已归档前驱的 Capsule/Finalizer 派发与 Operation Intent/Delivery 对账。权威按 proposal、[新 capability spec](specs/orchestration/read-only-worker-execution/spec.md)、[design D1–D6](design.md)、`CONTEXT.md`、`docs/architecture.md`、`docs/interface-contracts.md` 和实际代码依次核对。

**实施前门禁：** 确认 `m2-wire-execution-runtime` 已 archive，`coordinator/foreground-execution-runtime`、`execution/project-finalization` 与 `recovery/worker-sessions` 主规格存在；重读前驱、执行 TUI 并行项与本 change 的 artifacts，比较实际 `createCodexWorkerLaunch`、`runDoctor`、`reviewAuthorizationForDisplay`/`approveAuthorization`、Capsule 与 Finalizer 派发入口及相关测试。固定共享接缝并避免两个 agent 同时编辑同一文件。若接缝漂移，返回规划，不按旧路径硬套。保留用户未提交修改。环境修复与系统权限不是 apply 的隐式许可。

## 2. 复用与接缝

| IP-ID | 现有或前驱文件与符号 | 复用方式 | 禁止复制的事实 |
|---|---|---|---|
| IP-01 | `src/adapters/agents/codex-launch.ts` 的 `createCodexWorkerLaunch`；`src/adapters/orca-cli/process-runner.ts` 的 `runProcess` | 共用只读 profile 定义、配置冲突规则和有界子进程调用 | 不另写一份只读权限或 shell 拼接规则 |
| IP-02 | `src/bootstrap/doctor.ts` 的 `DoctorProbe`/`runDoctor`；`src/interfaces/cli/doctor-command.ts` | 增加独立检查项，沿现有 stdout JSON、stderr 诊断与退出码 | 不复制 Orca/模型能力检查 |
| IP-03 | `src/bootstrap/foreground-planning-runtime.ts` 的 `reviewAuthorizationForDisplay`、`approveAuthorization`、`authorizationManifestRows` | 在现有审阅和提交门检查能力；沿现有 blocked 与 gate | 不把探针结论写进 Manifest 或新建 TUI DTO |
| IP-04 | `src/bootstrap/execution-runtime.ts` 的 Capsule 派发；`src/bootstrap/foreground-planning-runtime.ts` 的 Finalizer 入口；`src/adapters/agents/utility-worker.ts` 的 `findDispatchedUtilityWorker` | 新派发前检查，已派发路径沿原身份对账 | 不复制 Recovery/Finalizer 状态机，不更换 OperationId |
| IP-05 | `tests/tui/pty-execution.test.ts`、`tests/recovery/acceptance/real-validator-partial.test.ts` 的隔离项目门；`docs/orca-compatibility.md` | 环境修复后沿现有入口强化真实成功断言并记录证据 | 不在 Companion 中管理 `/tmp`、升级 Codex 或修改 Orca |

## 3. 代码变更映射

| IP-ID | Task | Requirement/Scenario | 文件与符号 | 精确变化 | 不得改变 |
|---|---|---|---|---|---|
| IP-01 | 共享只读 profile，建立命令探针 | 只读 Worker 能力必须由实际执行证明：三个 Scenario | 修改 `src/adapters/agents/codex-launch.ts`；新增 `src/adapters/agents/codex-read-only-probe.ts`；调整 `tests/adapters/agents/codex-launch.test.ts`，新增 `tests/adapters/agents/codex-read-only-probe.test.ts` | 移除无效 Landlock flag；在隔离临时目录用当前 Codex/profile 做宿主可写、沙箱读、沙箱拒写及回读验证；返回三态/阶段/版本/有限诊断 | `:read-only`、网络控制配置、Codex Session Binding、常规 Worker 沙箱策略 |
| IP-02 | doctor 报告 | doctor 与授权审阅暴露同一能力结论：授权前发现不可用 | 修改 `src/bootstrap/doctor.ts`、`tests/doctor.test.ts` | 在原检查完成后组合 IP-01，输出独立检查项；失败非零，Route Planning 启动门不接该项 | 现有 Orca/模型检查顺序与机器输出边界 |
| IP-03 | 审阅与批准复核 | doctor 与授权审阅暴露同一能力结论：两个 Scenario | 修改 `src/bootstrap/foreground-planning-runtime.ts`、`tests/bootstrap/execution-authorization.test.ts`、必要时 `tests/tui/authorization-review.test.tsx` | 审阅显示配置及本次能力，失败在现有 blocked/gate 上解释；批准时重探测，旧成功不生效；保持原指纹/revision 机制 | Manifest schema、风险批准、TUI 页面及授权记录 |
| IP-04 | 运行期失败关闭 | 执行期按受限能力失败关闭：三个 Scenario | 修改 `src/bootstrap/execution-runtime.ts`、`src/bootstrap/foreground-planning-runtime.ts`；扩展 `tests/recovery/capsule-dispatch.test.ts`、`tests/bootstrap/execution-finalizer.test.ts` | 只在确认没有既有派发/unknown intent 后探测；失败给现有 blocker，零新 Task/Dispatch，预算不动；已派发按原事实对账 | Recovery/Finalizer 领域判决、Delivery ack 顺序、120 秒成功路径、OperationId |
| IP-05 | 环境与真实闭环证据 | 上述全部 Scenario 的本机可运行性 | 修改 `docs/orca-compatibility.md`、`tests/tui/pty-execution.test.ts`；按需调整 `tests/recovery/acceptance/real-validator-partial.test.ts` 的启动参数 | 修复 PTY 用例在环境可用时仍接受 blocker 的宽松断言，分别验证中断模式的真实 Capsule 与不中断模式的真实 deliverable；记录修复前失败、环境措施和探针结果 | 不把未取得的 `deliverable` 写成已验证 |

## 4. 调用与副作用顺序

1. **探针：** 建立项目树外的临时目录与共享只读 profile → 宿主证明哨兵可写 → 以 argv 数组调用 `codex sandbox` 执行读取 → 执行写入负向探针 → 宿主回读 → 归类三态并清理。每步有超时与有限输出；探针不调用模型、不建 Orca Task，不读取真实项目机密。若写入成功，能力立即不可用；探针自身清理失败记录诊断。
2. **doctor：** 原 Orca/模型检查完成后调用探针；输出机器可读的独立检查。能力失败只使 doctor 非零，不能阻止前台 Route Planning 启动。
3. **授权：** 审阅时探测并显示受限角色配置与结论；提交批准时重读规划事实、Manifest、revision、指纹及能力。任何一项失败均不写授权、不切模式。探针不属于 Manifest 指纹；版本/环境变化通过提交时重查处理。
4. **执行：** 新 Capsule/Finalizer 派发前先查询原 intent/Task/Dispatch；已有派发继续对账。确实没有派发时才探测；不可用即已有 blocker 路径返回，零新 mutation。可用才按现有 intent → Orca mutation → 读回 → Delivery/报告验收顺序推进。期间环境变化仍由现有 unknown/blocked 语义处理；不自动重派发。
5. **环境恢复：** 操作人员在隔离环境修复主机或采用已验证上游版本 → 重跑 doctor 与实际隔离项目闭环 → 记录 Codex 版本、权限配置、宿主文件系统、诊断和 verdict。若未修复，保持环境阻断，不以产品测试的 mock 成功充当真实通过。

## 5. Schema、状态与持久化落实

- **接口：** 探针返回 `{ kind: 'available' | 'unavailable' | 'unknown', stage, reason, codexVersion, profile }` 一类的有限、结构化事实；错误原因不包含凭据、完整 transcript 或任意子进程 stdout。只有 bootstrap/adapter 能调用探针。`doctor` 扩展现有 check ID；若机器输出字段有变，按既有 schemaVersion 规则调整并核对消费者。
- **状态：** 探针结果仅限当前调用，不保存第二份权威。Recovery blocker 使用既有记录，Finalizer blocker 使用既有投影；可用性变化不重置预算或尝试次数。Route Planning/Execution Coordination 模式规则不变。
- **持久化/交易：** 无新表、migration、跨库交易。探针不进入 Operation Intent；真实 Worker 副作用仍受原 Intent、CAS、receipt 与 Delivery 对账保护。
- **权限：** Capsule `authority.write=false`；Finalizer 新只读项目级 Session；均使用相同 `:read-only` profile。普通 Worker 的 `codexSandbox` 与 accepted risk 仍按原 Manifest 绑定。
- **错误与幂等：** 探针不可用/未知阻止新派发。已派发或 unknown mutation 保留原 OperationId 和证据，不重试新身份。重新运行探针是只读环境检查，不等于重试外部 Worker mutation。
- **审计/迁移：** `doctor`、授权 blocker 与执行 blocker 记录阶段/原因；不记录敏感命令输出。旧运行记录不迁移，直接按旧身份对账。

## 6. 验收证据矩阵

| Requirement/Scenario | IP-ID | 测试文件 | Fixture/前置条件 | 关键断言 | 可运行命令 |
|---|---|---|---|---|---|
| 能力证明：可运行且拒写、命令失败、边界不可证 | IP-01 | `tests/adapters/agents/codex-read-only-probe.test.ts`、`tests/adapters/agents/codex-launch.test.ts` | fake 子进程结果及临时哨兵；当前只读 profile | 成功必须有宿主可写、沙箱读、拒写与回读；沙箱错误/超时/意外写入均失败；无 Landlock flag | `pnpm exec vitest run tests/adapters/agents/codex-read-only-probe.test.ts tests/adapters/agents/codex-launch.test.ts` |
| doctor/授权：不可用阻断、恢复后重审 | IP-02、IP-03 | `tests/doctor.test.ts`、`tests/bootstrap/execution-authorization.test.ts` | 注入失败→成功的探针；原 Manifest 事实 | doctor 非零且有独立检查；审阅/批准重查；无授权写入时可继续规划 | `pnpm exec vitest run tests/doctor.test.ts tests/bootstrap/execution-authorization.test.ts` |
| Recovery 前能力不可用、已派发身份保持 | IP-04 | `tests/recovery/capsule-dispatch.test.ts` | 无派发、既有派发、unknown intent 三种代表事实 | 无派发时零 Orca mutation/预算消耗；既有派发原身份对账 | `pnpm exec vitest run tests/recovery/capsule-dispatch.test.ts` |
| Finalizer 前能力不可用、已派发身份保持 | IP-04 | `tests/bootstrap/execution-finalizer.test.ts` | 门禁满足、失败探针；既有 Finalizer | 无新派发或 deliverable；blocker 可见；既有运行可对账 | `pnpm exec vitest run tests/bootstrap/execution-finalizer.test.ts` |
| 本机只读命令与真实 Capsule/Finalizer | IP-05 | `tests/recovery/acceptance/real-validator-partial.test.ts`、`tests/tui/pty-execution.test.ts` | 显式隔离项目与专用 Orca 身份；`minimax-cn/MiniMax-M3`；先 `pnpm build`；PTY 的两种模式各用全新隔离项目 | Capsule 真实报告、Finalizer 只读结论及 deliverable、重启无重复派发；环境仍坏则明确阻断 | `pnpm build` 后分别运行 `ORCA_COMPANION_REAL_HARNESS=1 ORCA_COMPANION_REAL_REPO=<isolated-project> ORCA_COMPANION_REAL_IDENTITY=<dedicated-identity> ORCA_COMPANION_REAL_WORKER_MODEL=minimax-cn/MiniMax-M3 pnpm exec vitest run tests/recovery/acceptance/real-validator-partial.test.ts --no-file-parallelism` 与 `ORCA_COMPANION_REAL_HARNESS=1 ORCA_COMPANION_REAL_REPO=<fresh-isolated-project> ORCA_COMPANION_REAL_IDENTITY=<fresh-dedicated-identity> ORCA_COMPANION_COORDINATOR_MODEL=minimax-cn/MiniMax-M3 pnpm exec vitest run tests/tui/pty-execution.test.ts --no-file-parallelism`（PTY 再以 `ORCA_COMPANION_PTY_RECOVERY_INTERRUPT=0` 于另一新项目运行一次） |
| 全量门禁与规划校验 | IP-01～IP-05 | 全项目 | 普通自动测试不启动真实 Worker | typecheck、lint、test、build 和严格规格校验通过 | `pnpm typecheck && pnpm lint && pnpm test && pnpm build && openspec validate m2-repair-read-only-worker-sandbox --strict` |

## 7. 文件清单与升级条件

**新增：** `src/adapters/agents/codex-read-only-probe.ts`、`tests/adapters/agents/codex-read-only-probe.test.ts`。

**修改：** `src/adapters/agents/codex-launch.ts`、`src/bootstrap/{doctor,execution-runtime,foreground-planning-runtime}.ts`、`tests/adapters/agents/codex-launch.test.ts`、`tests/doctor.test.ts`、`tests/bootstrap/{execution-authorization,execution-finalizer}.test.ts`、`tests/recovery/capsule-dispatch.test.ts`、`tests/tui/pty-execution.test.ts`、`docs/orca-compatibility.md`。`tests/recovery/acceptance/real-validator-partial.test.ts` 仅在其启动参数依赖 Landlock 时调整。只有当现有授权组件不能显示 blocked 原因时才调整 `tests/tui/authorization-review.test.tsx` 和对应现有组件。

**删除：** 无。**保护：** `references/orca`、`src/domain/`、数据库 schema、其它 active change 的未提交修改、真实项目与全局 Orca runtime。

**升级条件：** 前驱未归档或主规格未同步；共享 profile 无法在 `codex sandbox` 中无模型复现；现有 blocker/授权 DTO 无法容纳诊断；探针成功却真实受限角色仍不能运行；需要改系统挂载、升级依赖或修改上游才能继续验收。遇到这些条件要回到规划或单独获得环境操作授权，不把放宽权限当作自动降级。

## 8. 验收 Agent 授权与限定审计

验收范围仅为上述新增/修改文件及显式隔离项目的真实测试。审计重点：`read-only-enforcement`（宿主可写但沙箱拒写）；`no-permission-fallback`（没有全权限回退）；`no-duplicate-dispatch`（已派发与 unknown 原身份对账）；`zero-budget-on-preflight-failure`；`doctor-vs-planning-start`；`no-unverified-deliverable`；`no-host-mutation`。环境不满足时，本 change 的产品代码可通过自动门禁，但真实 `deliverable` 验收仍标记阻断，不把它算作完成。
