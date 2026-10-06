# Verification

## 验收对象

- Change：`add-worker-harness-adapters`
- 输入实现 HEAD：`c1f9a0a`（实施基线；直接前驱 `complete-coordination-runtime-wiring` 的归档提交）
- 最终验收 HEAD：`75ff1ed`（`feat(worker-harness): add claude, opencode, pi and omp harness adapters`）。验收阶段的产品修复全部收敛在该提交内；本文件所在提交只增加 verification.md
- 验收 Agent：MiniMax-M3.1-Flash-Preview（主代理，按 `openspec instructions verification` 执行；未由独立验收子代理复核）

## 结论

**PASS**，边界为 `75ff1ed` 这棵确定的树。7 份 delta spec 的 15 条 Requirement、IP-01—IP-17 与 implementation-plan §8 声明的五个限定审计标签都已逐条核验；验收阶段发现的一处产品缺陷、三处验收脚手架缺陷已就地修复并复跑受影响检查。结论只对该提交成立，后续产品改动需重新验收。

真实运行部分的结论边界：只对 Orca 1.4.218、Claude Code 2.1.289、OpenCode 2.0.21、pi 1.0.0、OMP 18.4.10 与四个已批准模型成立。本次真实验收是 harness 级证据（角色派发、精确 Session 绑定、同会话恢复、混合角色），不是完整 Controller 闭环。

## 核验与修复证据

### 行为合同

| Requirement / Scenario / IP-ID | 证据或命令 | 结果 |
|---|---|---|
| 应用层 WorkerHarness 端口与显式注册表（已注册 harness 进入既有生命周期 / 未注册 harness 在派发前拒绝 / 注册表唯一且显式）/ IP-01、IP-02 | `src/bootstrap/worker-harness.ts:59` 是唯一的显式 `new Map([...])` 五项注册；`tests/application/worker-harness-registry.test.ts:14`（未注册在派发前拒绝）、`:24`（报告读取拒绝冲突身份、损坏尾行与超限输入）；`src/domain/model-configuration.ts:23` 的 `WORKER_HARNESS_IDS` 是配置侧唯一清单，`src/application/configuration/model-settings.ts:167` 与模型设置编辑器共用它 | 通过 |
| Dispatch 与真实 harness session 精确绑定（精确绑定成功 / 四个主要角色均要求精确绑定 / 无法证明 session 身份时阻塞 / harness 身份不匹配时不绑定）/ IP-02、IP-03 | `src/adapters/agents/session-binding.ts` 改为逐 harness 校验，`tests/adapters/agents/session-binding.test.ts` 覆盖 Codex 回归与不匹配分支；五个 bootstrap runtime 去掉 `harness !== 'codex'` 与字面量 `'codex'` 绑定，改按 `profile.harness` 解析注册表，`tests/bootstrap/graph-patch-worker.test.ts`、`baseline-reconciliation-runtime.test.ts`、`execution-finalizer.test.ts` 回归 | 通过 |
| 隔离启动与精确 provider session 身份（四个 harness 各自给出精确绑定 / opencode 不以数据库或终端猜身份 / 陈旧观察不推进绑定）/ IP-04—IP-08 | `tests/adapters/agents/native-worker.test.ts` 以 claude/pi/omp 参数化覆盖精确 id/path、陈旧观察、缺失与截断历史、迟到首 transcript；`tests/adapters/agents/opencode-harness.test.ts` 只经公开 `POST /api/session` 回读、`session.list --param` 穷尽与 raw GET 分页消息取身份，不打开数据库、不连用户 server | 通过 |
| 精确恢复与新建 Session 的身份回读（按原身份恢复 / omp 新建会话的身份回读 / 拒绝模糊恢复）/ IP-04—IP-07、IP-13 | 注册项 `prepareResume`/`proveSession` 替代原 resume 实现，原身份不可证明即阻塞；真实验收中 4 个 harness 各一次恢复全部 `sameSession=true`（见证据 JSON 的 `resume.sameSession`）；既有 `tests/recovery/capsule-dispatch.test.ts` 随注册表接线一并回归 | 通过 |
| 认证来源隔离与秘密边界（managed 秘密只进子进程环境 / harness_login 使用隔离登录态 / 凭据不可用时阻塞）/ IP-08 | `src/adapters/agents/native-worker.ts:147` 是启动前的配置门禁，`:165`/`:166` 对 connection 与 model 两级 options 拒绝宿主保留键；真实验收窗口内 8 个用户级配置/认证文件的 size+mtime 快照均未变化，adapter 不写用户全局资产 | 通过 |
| 只读角色共用受限包装器（生产与探针共用包装器 / 状态根可写而协调库不可写 / 包装器不可用时阻塞）/ IP-09 | `src/adapters/agents/read-only-execution-wrapper.ts:478` 的探针与 `:556` 的可用性断言被 Finalizer 与 Capsule 启动共用；`tests/adapters/agents/read-only-execution-wrapper.test.ts`（12 个用例）核验协调库拒写、状态根可写、包装器缺失即阻塞 | 通过 |
| doctor 核验环境与公开契约、缺失时拒绝启动 / doctor 与授权审阅暴露同一能力结论 / 执行期按受限能力失败关闭 / IP-10 | `tests/doctor.test.ts` 与 `tests/bootstrap/doctor-model-configuration.test.ts` 逐 profile 输出结论，未配置角色不假装核验，未知或缺失 native 连接 fail closed | 通过 |
| Immutable versioned model settings（保存与应用独立 / 冲突和文件失败保留输入 / 旧记录与旧指纹兼容 / 非法 nativeWorker 组合被拒绝）与 Per-role harness selection（显式选择角色 harness / 省略时保留或取默认 / 角色 harness 不自动生效）/ IP-11 | `src/domain/model-configuration.ts:68` 的判别联合与 `:116` 的 optional 字段是 additive，旧 fingerprint 不变；`tests/bootstrap/project-config.test.ts`、`tests/configuration/model-settings.test.ts` 覆盖兼容与拒绝路径；`tests/tui/host-wiring.test.ts` 参数化 codex/pi，核验候选按 harness 隔离、应用后 harness、nativeWorker 与凭据引用不变 | 通过（含本轮修复） |
| Approved role model settings and independent effort（effort 不复制候选 / 角色配置编辑与返回 / 执行模型更新审阅 / 逐角色 harness 与原生连接编辑 / 三档生产画面对照）/ IP-12 | `tests/tui/model-settings.test.tsx` 覆盖字段可见性、遮罩、保存与应用分离、重新授权审阅与逐层返回；`artifacts/worker-harness/tui/` 采集 12 帧 × 12 组合的生产画面，其 README 已写明该目录不证明候选过滤、schema 校验与真实启动 | 通过（含本轮修复：候选按 harness 过滤） |
| Worker Session Recovery 先尝试精确恢复且不得凭不完整信息推断退出 / Recovery Capsule 必须由受限 Utility Worker 生成且按角色门判定 / IP-13 | `src/bootstrap/worker-harness.ts` 的注册项替换 resume/prove 实现，Segment、替代 Dispatch 与 Recovery 预算结构未变；`tests/adapters/agents/utility-worker-recovery.test.ts`、`tests/bootstrap/validation-runtime.test.ts`、`tests/bootstrap/execution-delivery.test.ts` 沿用既有回归并在本提交中保持通过 | 通过 |

### 工程检查（最终树 `75ff1ed`）

| 检查 / IP-ID | 命令 | 结果 |
|---|---|---|
| 全量回归 / IP-17 | `pnpm test --maxWorkers=8 --testTimeout=30000 --hookTimeout=30000` | 182 文件通过、7 跳过；2138 通过、16 跳过；372.63s |
| 真实隔离矩阵 / IP-15 | `ORCA_COMPANION_REAL_ACCEPTANCE=1 pnpm exec vitest run --maxWorkers=1 --testTimeout=1800000 tests/acceptance/worker-harness-matrix.test.ts` | 15 通过、1 跳过；690.91s |
| 类型 / IP-17 | `pnpm typecheck` | 通过（退出码 0） |
| 静态检查 / IP-17 | `pnpm lint` | 通过（退出码 0） |
| 构建 / IP-17 | `pnpm build` | 通过（退出码 0） |
| 差异卫生 / IP-17 | `git diff --check` | 通过，无空白错误 |
| change 严格校验 / IP-08、IP-17 | `openspec validate add-worker-harness-adapters --strict` | `Change 'add-worker-harness-adapters' is valid` |

真实矩阵明细：claude `MiniMax-M3.1-Flash-Preview`、opencode `minimax-cn-coding-plan/MiniMax-M3.1-Flash-Preview`、pi `minimax-cn/MiniMax-M3`、omp `minimax-code-cn/MiniMax-M3.1-Flash-Preview`。实际模型取自已核验 transcript 的 assistant 记录，不是回读传入的配置；20 次角色运行的产物、coverage 与实际模型全部符合预期，4 次恢复均为同一 Session，混合流程 `claude → opencode → pi → omp` 在同一 Run 内共存并各自使用自己的绑定模型。证据为 `artifacts/worker-harness-adapters/ip15-2026-10-06T05-02-57-524Z.json` 与同名摘要。

一次全量运行曾报 `native-worker.test.ts` 的保留选项用例失败。该运行与测试文件编辑并发，同一断言在随后的定向运行与最终树全量重跑中均通过，那份计数不采信。

### 验收阶段完成的修复

1. 产品缺陷：`src/bootstrap/foreground-planning-runtime.ts` 的 `roleModelViews` 没有按角色所选 harness 过滤候选，`saveRoleProfile` 也没有把连接的 `nativeWorker` 透传给保存用例。非 Codex 角色因此会在模型菜单里看到别的 harness 的连接，应用后写出的 profile 无法启动。修复为按 `currentWorkerProfile(role).harness ?? execution.harness` 过滤候选（`:3710`）并在应用路径透传 `nativeWorker`（`:10344`）；未注册 harness 时把该角色标为不可用并给出原因，而不是给出空列表。补测 `tests/tui/host-wiring.test.ts` 的参数化 codex/pi 用例。
2. 验收脚手架：Finalizer 完成标记原从 `worker-read` 的终端输出窗口读取，claude 与混合流程的 OMP Finalizer 因此被判失败（真实运行 13 项中 2 项失败）。改为只读精确 transcript 的 assistant 文本，并在 `worker_done` 早于最后一条响应落盘时有界重读；实测该 token 确实在 claude Finalizer 的 assistant 响应中，是取证方式错误而非产品缺陷。
3. 验收脚手架：夹具清理失败时先删目录再抛错，使公开 Orca selector 失效、无法事后排错。改为失败即保留目录并让验收失败。
4. `tests/acceptance/worker-harness-matrix.test.ts` 的 `afterAll` 吞掉清理错误，改为始终抛出。
5. `tests/adapters/agents/native-worker.test.ts` 的保留选项断言参数化为 `thinking`、`id`、`model_id`。
6. 文档：`docs/orca-compatibility.md` 更正 doctor 与探针的关系（共用实现而非复用结论）；`docs/interface-contracts.md` 补写候选只含所选 harness 的连接、应用保留 `nativeWorker`；`artifacts/worker-harness/tui/README.md` 更正画面证据不覆盖候选过滤的边界。

## 限定审计

implementation-plan §8 声明的五个标签全部触发，范围为只读代码核验加对应行为测试，未修改任何规划工件。

| 审计范围 | 结论 | 证据 |
|---|---|---|
| `harness-identity` | 通过 | 身份判定只有一条来源：`WorkerHarness.proveSession`/`inspectTranscript`，由 `src/bootstrap/worker-harness.ts` 按注册项分派，调用方不再自带分支。全仓已无 `harness !== 'codex'` 形态的运行时判断。冲突身份、多 id、损坏尾行与超限报告由 `readLatestHarnessSessionReport`（`:15`）统一判为不可读并阻塞，而不是沿用最近一次观察。真实验收的 20 次角色绑定与 4 次同会话恢复是这条路径的端到端证据 |
| `readonly-wrapper` | 通过 | 探针与生产共用 `read-only-execution-wrapper.ts` 的同一描述符构造，没有第二份参数表；`/run` 保持根挂载只读以保留 DNS symlink，仅在 workspace/stateRoot 位于 `/tmp` 之下时才加 tmpfs。`tests/adapters/agents/read-only-execution-wrapper.test.ts` 覆盖协调库拒写、状态根可写与包装器缺失三条边界 |
| `config-compat` | 通过 | `nativeWorker` 是 optional 的判别联合（`src/domain/model-configuration.ts:68`/`:116`），旧记录解析后表示不变、旧 fingerprint 不变，未知字段与非法组合在 schema 层拒绝。`SaveModelSettingsInput.harness` 省略时保留角色既有 harness、仅首次配置取 `execution.harness`，因此一次换模型不会把角色悄悄换回默认。`coordination.sqlite` 保持 schema 20，Manifest 与绑定仍以 JSON blob 存储，无迁移 |
| `auth-isolation` | 通过 | managed secret 只在 launcher 组装子进程 env 时注入，`harness_login` 只把来源资产复制进隔离状态根并以 symlink/副本方式使用，两个分支都不写用户全局目录。`src/adapters/agents/native-worker.ts:165`/`:166` 在写盘前拒绝宿主保留选项。真实验收在最终运行窗口内比对 8 个用户级配置与认证文件的 size+mtime，全部未变；fixture 的隔离 CredentialStore 随目录一起删除 |
| `real-acceptance` | 通过 | `tests/acceptance/worker-harness-matrix.test.ts` 在未开启 `ORCA_COMPANION_REAL_ACCEPTANCE` 时不读凭据、不调用 Orca，只留一条 skip 记录（该断言本身是「默认跳过」的可观察形式）。开启后 15 通过、1 跳过，覆盖每个 harness 的 p-i-v-f、implementation 会话的原身份 resume，以及跨 harness 混合角色；实际模型与产物均从精确来源读取。现场已按公开接口回收，回读 worktree/setup/project/active worker 均为零残留 |

## 后续注意事项

以下不影响本结论的边界：

- 真实结论绑定 Orca 1.4.218 与四个 CLI 的本机版本。升级任一 CLI、更换验收模型或改动原生启动参数后，必须重跑 `tests/acceptance/worker-harness-matrix.test.ts`，不能沿用本文件。
- 本次是 harness 级验收。完整 Controller 闭环（Route Planning、Execution Authorization、Graph Patch、Replanning）由其它 change 覆盖，不要把本结论读成端到端可用性。
- implementation-plan §5 已声明的已知上限：普通 native 角色的 per-launch 私有状态根仍位于 Git common dir 的 Companion 私有目录，退出后需显式清理。真实验收显式传入私有 state root，因此本仓库 git common dir 下没有产生 `companion/` 目录（已核验）。
- Orca 侧的 Run/Task/Dispatch 历史与 durable project 记录没有公开删除入口。开发期 46 个一次性 project setup 已经 `project setup-delete` 注销、46 个 fixture 目录已删除；剩余的运行历史按设计保留。
- 费用未记录：本次真实运行没有取得可核验的 usage，按合同不推断金额。
