# IP-05 真实隔离验收（D06）

本目录是 `complete-tui-graph-basis` 唯一新增的真实验收现场目录。既有 `artifacts/*` 下的历史报告与原型
素材一律不改写；每次运行的新证据写在这里。

## 当前状态

**状态：真实隔离闭环的行为与证据已完成，独立正式核验PASS。** 用户指定的新现场使用 `minimax-cn/MiniMax-M3.1-Flash-Preview`，旧 `gpt-6-luna` 现场保持原授权绑定。n/o 的实际执行、补丁、恢复与历史阅读结果见下方收尾表。原失败退出码和人工督办单列，未将旧 GB01 的 unknown 或10项全跳过改写成通过。

暂停前完成的 Cutover 复验见 `cutover-only-ip05-cutover-20261004b.log`：exit 0，1 passed / 9 阶段跳过。专用身份 `term_dc1f1d09-f914-4647-968f-7d613969c644`，Scope `ip05-ip05-cutover-20261004b-scope`；前代 Run `run_614647aab5d0` 冻结，候选 Run `run_2c195b3312b0` 激活，前代 358 字节原始计划仍可读。该阶段没有 Worker 或模型调用，不证明执行、补丁、退役或 Recovery。

共享模型参数已改为 sandbox 与 Worker 共用的 `-c model=...`，32 项现有 launch/probe 测试通过。后续探针显示 Codex 0.159.0-alpha.3 拒绝 `wire_api=chat`，也拒绝覆盖内置 `openai` provider。新 fixture 脚本改用自定义 `companion-oauth` 和 `responses`；现场 `ip05-exec-20261004e` doctor 全部通过，见 `doctor-ip05-exec-20261004e.json`。h 测试已结束（6 passed / 2 failed / 2 skipped，exit 1），尚无闭环结论。

e/f 原测试失败保留：首个 Pause 实际包含模型能力核验，测试却只等 5 秒即失败；后续操作落入原弹层形成连锁失败。f 原身份的单次 Pause 复验在约 13 秒完成并落盘，见 `pause-probe-ip05-exec-20261004f.txt`，没有 Worker 派发。g 现场控制检查通过，随后旧版「门禁: 通过」文案断言失败；当前五栏审阅显示准入后的 `[批准授权]` 动作。脚手架已按当前可观察契约调整，没有改产品控制规则。g 未批准授权、未派发 Worker。

h 已经批准授权、创建独立 worktree 和角色 Task，并由 Orca 派出 `ctx_c5b9ab14d998` / `task_61f8f382e07a`，终端 `term_146233d4-fde0-4d2d-a1c4-f9621c511259`。精确 launch 私有状态目录中的真实 `turn_context` 模型为 `gpt-6-luna`，见 `usage-ip05-exec-20261004h-model.json`；请求数不可证明，未报告费用。公开 `worker-show` 返回 `observation.exactWorker: true` 与 camelCase `worker.agentTerminalHandle`，而 adapter 读取 snake_case 后得到空绑定，留下原 workerStart intent。原 OperationId 与失败状态保留于 `intents-ip05-exec-20261004h.json`；不换身份重试这个未知操作。adapter 范围扩展随后获批并完成下述回归。

h 的两个 PTY 失败分别为：授权返回仍打开项目面板却等待默认 sidebar、旧工作详情读取没有遍历分页且依赖旧文案。它们不能用来判定整个执行闭环已经失败或通过。读取现场的 `basis-ip05-exec-20261004h.json` 已通过生产端口完整读回 v1 图、计划、批准授权和保留 Task 记录（6 项正文），Scope revision 不变；尚无已接纳的原生规格或 patch/retire/Recovery 证据。

用户已批准第二项范围扩展。adapter 现按公开 `worker.agentTerminalHandle` 读取，既有 adapter/launch/probe 三文件共 60 项通过，build、typecheck 与受影响 ESLint 通过。修正后的 PTY driver 逐层关闭授权返回面板，并遍历工作详情的全部有界页面，按结构化字段核验 Finalizer/Recovery。

`worker-ip05-exec-20261004h-after.json` 是修复后对原 Dispatch 的只读观察：原 Worker 已在 Orca 中 succeeded/completed，仍为 exactWorker，终端保持 external/retained；Companion 的原 workerStart 意图依旧 blocked。它没有 backendRequestId，自动对账不能从 receipt 证明结论，不写库补身份，也不重派同一 Task。该现场保留待后续对账。

独立现场 `ip05-exec-20261004i` 使用专用身份 `term_fe6ca06d-c9f3-40fa-8e56-15a69afe2d89` 与 Scope `ip05-ip05-exec-20261004i-scope`。doctor 全部通过（`doctor-ip05-exec-20261004i-cwd.json`），原 execution/retire 驱动已停止，实际结果见下文。它是独立测试，不是 h 原操作的换 ID 重试；所有角色固定 `gpt-6-luna`。首次 doctor 错误传入路径参数的 exit 2 保留于 `doctor-ip05-exec-20261004i.stderr`，随后在 fixture cwd 正确运行 exit 0。

已准备但未执行的 `ip05-exec-20261004c` 和 `ip05-exec-20261004d` 现场及身份记录保留，二者均未派发 Worker。恢复时以实际配置核验决定是否新建现场，不覆盖旧证据。

## 与既有脚手架的差异（两处，都是当前产品合同要求的）

1. **Coordinator 使用已验证的 loopback OAuth proxy。** 显式验收模型通过 `@langchain/openai#ChatOpenAI`
   指向 `http://127.0.0.1:10100/v1`，模型列表需在 setup 时实际包含该 ID。连接使用 OpenAI-compatible
   Chat Completions。Worker 的 Codex 连接独立使用自定义 provider `companion-oauth` 与 `wireApi: responses`，待恢复后核验。代理本机 OAuth 负责上游认证，不从环境或配置读取 secret。
2. **SDK key 兼容占位值隔离保存。** OpenAI SDK 构造器要求 `apiKey`；生产 `CredentialStore` 里保存固定的
   非秘密 `loopback-oauth-proxy`，仅用于 SDK 兼容，不用于代理认证。用户凭据目录不读写。Worker 使用同一
   同一显式验收模型和 `harness_login`，其认证由隔离的 Codex harness 登录态提供。

## 文件

| 文件 | 作用 | 调用模型 |
| --- | --- | --- |
| `setup-fixture.mjs` | 建隔离 Git 仓库、写 schema 2 配置、登记 Orca、建专用协调身份、打印导出块 | 否 |
| `collect-usage.mjs` | 从隔离 `CODEX_HOME` 的 rollout 与协调库统计每角色请求量与 token | 否 |
| `read-basis.mjs` | 通过生产 GraphBasisPort 和公开 worktree 查询完整读回真实图/依据，记录身份与范围 | 否 |
| `fixture-<name>.json` | 每次运行的身份记录（无 secret） | 否 |

## 2026-10-04 恢复后的实际结果

- `ip05-exec-20261004i` 两包已取得 Accepted Validator Result，并完成受控 Git 集成；GraphVersion 2 的 Accepted Graph Patch 为 revise，修订持有已 released。原请求虽然要求 retire，但九字段声明没有携带变化正文，Planner 没有收到该要求。本轮不能算 retire 通过；公共输入合同随后获批，现已完整传递有界变化说明。
- i 的原 Vitest 驱动与人工补答键位交错；已停止该驱动，exit 143，不作为通过。保留原 Scope、Run、OperationId 和 Worker，沿精确 interaction/revision=145 的 TUI 回答入口提交“恢复执行”，待答已清零。续跑仍未取得 Finalizer Verdict，随后经生产 Pause 停止新调度并退出前台。没有重新派发已有 Task。
- i 的生产 GraphBasisPort 已读回 2 个版本、62 项完整正文。并发运行时的两次报告 Scope revision 改变，不据此推断阅读写入。停调度后的独立回读另存 `basis-ip05-exec-20261004i-paused.json`。
- `ip05-recovery-20261004j` 首条 Recovery 为 recovered，Capsule 与替代 Session 精确绑定同一业务 Attempt，已耗预算 1/1。替代 Worker 的公开状态为 succeeded，但 Companion 尚无它的 Accepted Worker Result settlement；替代 Segment 又有第二条 pending Recovery，尚未额外派发或耗预算。详见 [只读审计](recovery-ip05-recovery-20261004j-audit.md)。本轮不能算完整 Recovery 通过。
- PTY 阅读失败已限定为脚手架问题：40 列 footer 被裁为“Esc 返回…”，旧判断要求完整文案；翻页还曾把 loading 帧当成正文。已改为详情标题定位并等待正文就绪。原 j 现场复验完整读取 7 页，i 现场读取 12 页，Finalizer/Recovery 字段可见；新脚本为 `read-project-details.mjs`。脚本重启生产前台以读取，启动本身会取得 Runtime Lease；只有阅读输入，不表示整个进程没有持久化行为。
- 验收摘要原先把逻辑 Dispatch ID 与真实 `ctx_…` 直接比较，导致 0/2。IP-03 内通过精确可核验 Session Segment 映射，原 i 记录重新投影为 2/2；没有改业务结算。现有 execution-view 测试 28 项、含宿主的 3 文件 47 项通过。
- 固定 Worker 字段修复后的全量为 162 文件/1748 项通过，6 文件/12 项条件跳过，exit 0。上述摘要修复之后的最新全量单独记录，不合并或替换此前原始日志。

## l/m 解阻塞与 MiniMax 复验

- `ip05-retire-20261004l`（gpt-6-luna）：真实图v2 retire `readme-banner`，只保留已验证/集成的 `notes-basics`，revision hold 已 released。Planner 的正文澄清曾通过公开 orchestration reply 回答；驱动 Pause 窗口导致的 Coordinator 待答问题经绑定 TUI 入口回答，过程保留。Finalizer 先发了错误 pane 的回报，Orca 保留拒绝诊断，随后正确 pane 已发有效 JSON；宿主先选择诊断而阻塞。原测试6通过/2失败/2阶段跳过，exit1。用户批准的 locator 修复排除拒绝诊断，现有3文件38项通过；两条原消息及修复后读取分别保留于 `finalizer-delivery-*.json`、`finalizer-carrier-*.json`。生产依据停调度回读2版本/38完整正文、Scope revision不变。
- `ip05-recovery-20261004m`（MiniMax）：真实中断 Implementation 后 Capsule、替代 Dispatch/Session 同一业务Attempt，预算1/1，替代 Implementation 结果已接受。旧 launch 未错绑替代 Dispatch，没有第二条误生成 Recovery；随后合法 Utility 绑定因 `role:null` 被误判legacy而阻挡Validator。原驱动在确定缺口后停止，Vitest记录SIGTERM导致worker错误，exit1，4通过/2阶段跳过，不算完整通过。现场经生产Pause后退出；只读依据回读1版本/13完整正文、Scope revision不变。
- Utility 读取现使用既有 `identity` 判定旧记录，3文件58项通过；无schema/权限/预算变化。原j/m历史不回填。`ip05-retire-20261004n` 与 `ip05-recovery-20261004o` 是修复后的新隔离现场，全部角色显式绑定 `minimax-cn/MiniMax-M3.1-Flash-Preview`，原身份分别见 fixture JSON；收尾见下方表格。
- o 已由替代 Implementation 的 Accepted Worker Result 进入 Validator，并接受验证结果、完成 `notes-basics` 的受控 Git 集成；后续仍需核验图修订、最终结论和重启。`usage-ip05-recovery-20261004o-validating.json` 保留过程用量与实际模型，无法证明的请求数仍为 unavailable。
- o 后续已接受 GraphVersion 2 revise 补丁。驱动的 Pause 窗口触发 Coordinator 待答问题；主会话短暂冻结测试驱动，在绑定问题/revision=157 的生产回答面板选择“解除暂停，继续推进 planner 修订”，确认待答清零后恢复驱动。`answer-ip05-recovery-20261004o-continue.json` 保留人工回答与状态，不通过普通聊天或直接写库完成回答。
- n 的 Implementation 模型回合在读取规格后结束，未返回 Worker Result。主会话向原 Dispatch 发送公开督办消息 `msg_8f1aabfb0df0`，再通过公开 `terminal send` 提醒读取该消息，沿用原 Task/Dispatch/Attempt，不改变范围或写入结算；回执分别保留于 `follow-up-ip05-retire-20261004n-implementation.json` 与 `follow-up-ip05-retire-20261004n-submit.json`。本现场需标注人工督办，不能声称无人工介入。

## 运行顺序

### n/o 收尾与原现场复验

| 项目 | n：retire | o：Recovery/revise |
| --- | --- | --- |
| 真实结果 | v2移出readme-banner，notes-basics验证/集成，Finalizer deliverable | 原Implementation中断，Capsule与替代Session同Task/Attempt，预算1/1；Validator续办，两包验证/集成，v2 revise，独立基线补救verified，Finalizer deliverable |
| 原PTY驱动 | exit1；6通过/2失败/2阶段跳过 | exit1；6通过/2失败/2阶段跳过 |
| 失败边界 | 旧位置查找reconcile，以及并排对话插进长verdict ID | 同左 |
| 原现场显示复验 | 80列生产详情6页，完整kind与verdict ID可见 | 80列生产详情13页，完整Recovery/kind/verdict ID可见；当前节点Inspector显示canonical_advance及精确所需基线 |
| 历史依据 | 2版本，38完整正文，revision不变 | 2版本，82完整正文，revision不变 |
| 重启后的持久事实 | 原Task/Dispatch/Attempt、Segment、结算、预算、Verdict不变 | 同左；仅1条Recovery，未新增替代派发 |

证据为 `runtime-*-final.json`、`basis-*-final.json`、`project-details-*-final.json`、`inspector-ip05-recovery-20261004o-final.json` 与 `verified-*-final.json`；对应脚本均exit0。已退役节点只提供历史拓扑与保留来源，不叠加当前reconcile。原驱动④/⑥的重启与退出检查均通过，⑤/⑤b原失败未覆盖；复验直接读取同一批保留事实并检查上述身份未变，不重新派发Worker。

n 经公开消息督办一次、并在绑定问题/revision143的TUI入口回答继续；o在绑定问题/revision157的入口回答继续。各回执保留，本轮为人工监督的前台流程。只读UI探针会启动前台并取得Runtime Lease，不声称整个启动无持久化；Scope保持paused，阅读输入不恢复模型或派发Worker。用量见 `usage-*-final.json`，实际modelIds均为MiniMax；未精确按launch绑定的会话保持unbound，请求数和费用不推断。

### 可复用命令

前置：`pnpm build`（`setup-fixture.mjs` 用 `dist/` 里的生产 `JsonCredentialStore` 与
`parseProjectConfig`，不手搓 JSON），并把 `~/.cache/orca-acceptance/acceptance-bin` 前置到 `PATH`——
Orca 包装器保证 Worker 落到隔离的 Codex alpha，宿主能力探针与只读 profile 依赖它。

```sh
# 1. 建立新隔离现场；setup 先匿名检查 loopback /models，再用生产 parser 校验配置
node artifacts/graph-basis/real-acceptance/setup-fixture.mjs <fixture> <name> --dry-run
node artifacts/graph-basis/real-acceptance/setup-fixture.mjs <fixture> <name>

# 2. Companion doctor（有界）；能力探针会实际访问已配置模型，存在少量模型调用成本
timeout 45s env XDG_CONFIG_HOME=<fixture>-xdg \
  dist/src/interfaces/cli/main.js doctor

# 3. 零模型成本阶段：新 Scope + Replanning Cutover + 多代际 + 前代依据可读
ORCA_COMPANION_PTY_PHASE=cutover-only \
ORCA_COMPANION_REAL_HARNESS=1 ORCA_COMPANION_REAL_REPO=<fixture> \
ORCA_COMPANION_REAL_IDENTITY=<identity> \
ORCA_COMPANION_REAL_SCOPE=<fixture-scope> \
ORCA_COMPANION_COORDINATOR_MODEL=minimax-cn/MiniMax-M3.1-Flash-Preview \
pnpm exec vitest run tests/tui/pty-execution.test.ts --maxWorkers=1 --no-file-parallelism

# 4. 真实执行阶段：execution/Graph Patch/retire/restart/recovery
ORCA_COMPANION_PTY_PHASE=execution \
ORCA_COMPANION_PTY_RETIRE_NODE=1 ORCA_COMPANION_PTY_RECOVERY_INTERRUPT=0 \
ORCA_COMPANION_REAL_HARNESS=1 ORCA_COMPANION_REAL_REPO=<new-fixture> \
ORCA_COMPANION_REAL_IDENTITY=<new-dedicated-identity> \
ORCA_COMPANION_REAL_SCOPE=<new-fixture-scope> \
ORCA_COMPANION_COORDINATOR_MODEL=minimax-cn/MiniMax-M3.1-Flash-Preview \
pnpm exec vitest run tests/tui/pty-execution.test.ts --maxWorkers=1 --no-file-parallelism

# 5. 用量实测（每角色请求量与 token）
node artifacts/graph-basis/real-acceptance/collect-usage.mjs <fixture>

# 6. 真实历史依据读取；新输出文件须不存在
node artifacts/graph-basis/real-acceptance/read-basis.mjs <fixture-identity.json> <new-report.json>
```

每次运行必须新建目录、专用 Orca identity、Scope 和 OperationIds。子进程环境过滤继承的
`ORCA_TERMINAL_HANDLE`、`ORCA_WORKER*`、`ORCA_TASK*`、`ORCA_RUN*` selector，再显式绑定 fixture identity；
不查询、停止或重启无关 runtime/workload。退出前台进程不释放 Runtime Lease（产品语义）。

`basis-ip05-cutover-20261004b.json` 已用生产端口读回两代图和四项完整正文，历史图无当前运行态覆盖，Scope revision 前后相同。原始 Cutover 日志与此只读复验分别保存。

## Cutover 阶段（⑦）覆盖什么

`tests/tui/pty-execution.test.ts` 的第 ⑦ 个用例不派发任何 Worker、不调用任何模型，走的是生产应用用例：
`beginReplanningTransition` → `completeReplanningTransition` → `proposeExecutionGraph`（它自己经
`ExecutionScope` 分配真实空 Run 并把归一化原计划与 v1 同事务落盘）→ `record-authorization` →
`commitGenerationCutover`。断言全部落在持久事实上：

- 前代代际 `frozen`、候选代际 `active`，两条记录并存（真实多代际）；
- 候选代际的 Orca Run 与前代不同，GraphId 与 WorkPackageId 全新；
- Scope 的图、Planning Cycle、模式与授权引用整体切到候选；
- 冻结之后前代仍可读：`graph-version-index` 是跨代际目录（每页 ≤ 20 项、只读元数据），前代每一项都标
  `frozen`；`graph-basis-range` 能按 `(graphId, generation, version)` 精确读回前代的原始计划正文。

## 证据记录要求

用量脚本仅按已留存 launch binding 识别角色；无法精确绑定的 Session 标为 unbound。token 从最后一个结构化累计快照读取，无法证明的请求数标为 unavailable。零 Worker Cutover 现场已核验脚本可读，实际 Worker 用量解析待真实执行后核验。

每次运行后在本目录留下：命令与退出码、隔离项目路径、协调身份句柄、前代与候选的
`(graphId, generation, orcaRunId, baselineHead)`、每个 Work Package 的 worktree 路径、`collect-usage.mjs`
的输出、以及所有 skip 与其原因。**不记录任何 secret**：凭据只以 `credentialRef` 出现，rollout 只统计行数、
模型 id 与 token 计数。失败与条件跳过分别记录，不把跳过读成通过。

## 已核对的环境事实（2026-10-04）

- Orca CLI `1.4.218`；实际版本与公开字段已更新到 `docs/orca-compatibility.md`，submodule SHA 保持原样。
- `orchestration run-create --objective --from`、`run-use --id --from`、`worker-list --run` 在当前版本存在；
  `coordinator-start` / `coordinator-stop` 已退役，与文档一致。
- 真实闭环的现场与历史结论仍以 `docs/orca-compatibility.md` 为准；本目录不重述它们。
