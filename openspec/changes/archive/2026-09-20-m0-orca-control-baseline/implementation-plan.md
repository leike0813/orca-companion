# Implementation Plan

## 1. 实施基线与权威来源

- **基线模式**：`predecessor-contract`。
- **直接前驱**：`m0-establish-architecture-contracts`。
- **规划 commit**：`cd29e2bcd8b0278d34ae19db64cb8ebdaf149279`（工作区另有用户未跟踪的规划资产，实施时保持不动）。
- **冻结接缝**：`docs/architecture.md` 的 `MOD-04`、`FLOW-01`；`docs/interface-contracts.md` 的 `IC-01`、`IC-02`、`IC-12`；`architecture/module-interface-contracts` 主规格。
- **实施前对账**：确认直接前驱已 archive、主规格存在，且上述合同的 owner、canonical path、字段来源、三值结果与原 OperationId 对账语义未漂移；再确认 `src/**` 与 `tests/**` 仍只有占位、`package.json` 与 `tsconfig.json` 未变、`orca --version` 仍为 `1.4.198`。任何一项漂移即回到规划。
- **权威来源**：本 change 的 `specs/` 四个 capability；`design.md` 的 D1–D12；`docs/research/orca-public-control-contracts.md` 与 `docs/research/m0-isolated-control-loop-probe.md` 的命令与词表事实；`AGENTS.md` 第 4、5、6、9、11 节与 `CONTEXT.md` 的 Execution Scope / Operation Outcome 定义。
- **apply 门禁**：不创建 `verification.md`；M0 门禁未通过时，`m1-persist-coordination-state` 及其后所有 change 不得进入实施（D12）。

### 合同 create/extend/consume

| 关系 | 合同与 canonical symbols | 漂移检查 |
|---|---|---|
| Create | `IC-01`：`src/application/dto/identity.ts` 及领域 ID 引用 | 无平行 ID 类型；unknown kind 与无效 revision fail closed |
| Create | `IC-02`：`execution-backend.ts`、`operation-outcome.ts`、`operation-catalog.ts`、Delivery transport | `query`/`mutate` 封闭；scope 必填；accepted/rejected/unknown 与 FLOW-01 一致 |
| Create | `IC-12` CLI 基线：`doctor-command.ts`、CLI `main.ts` | 无 TTY 可运行，不加载 Ink/React，不在查询时产生写入 |
| Consume | `MOD-04`、`FLOW-01` | Application 不导入 adapter；unknown 不换 OperationId 重试 |

## 2. 复用与接缝

| IP-ID | 现有或前驱文件与符号 | 复用方式 | 禁止复制的事实 |
|---|---|---|---|
| IP-1 | `src/application/.gitkeep`、`tsconfig.json`（strict、`verbatimModuleSyntax`、`erasableSyntaxOnly`） | 在既有严格编译约束下新建 port 与 DTO；不新增编译选项 | 不复制 Orca 状态机；不定义第二套错误码词表 |
| IP-2 | `design.md` D1–D4、`orca-public-control-contracts.md` 2.1–2.6 错误码表 | 把已核验错误码映射为三值分类；操作目录按该文档命令面登记 | 不重新解释未知枚举；不把 dispatch completed 当作任务通过 |
| IP-3 | `src/adapters/orca-cli/.gitkeep`、Node 24 `node:child_process` 与 `node:path` | 用标准库实现进程边界；不新建顶层工具模块（D5） | 不经 shell；不复制 Orca 的 transport 重试策略 |
| IP-4 | `src/bootstrap/.gitkeep`、IP-1/IP-3 产物 | 复用 backend 的只读查询做环境核验 | 不在 doctor 内重建身份探测以外的业务逻辑 |
| IP-5 | `src/interfaces/cli/.gitkeep`、`package.json` `scripts` | 复用现有 lint/typecheck/test 脚本；新增 `build` 与 `bin` 对齐 AGENTS.md 第 9、11 节 | 不加载 Ink/React；不要求 TTY |
| IP-6 | `tests/.gitkeep`、`vitest.config.ts` | 用现有 runner 写行为测试与显式开启的隔离探针（D10） | 不新增第二套运行器；不镜像实现状态机 |
| IP-7 | `docs/orca-compatibility.md` 现有两节结构、`docs/research/m0-isolated-control-loop-probe.md` 结论 | 按探针结果更新「已核验 / 尚未验证」两节与验证环境表 | 不把未核验能力写成既成事实；不复制探针全文 |

## 3. 代码变更映射

| IP-ID | Task | Requirement/Scenario | 文件与符号 | 精确变化 | 不得改变 |
|---|---|---|---|---|---|
| IP-1 | 1.1 | 封闭的操作边界与可信执行上下文（全部 Scenario）；三值操作结果与未知结果对账（全部 Scenario） | `src/application/ports/execution-backend.ts` 的 `ExecutionBackend`、`ExecutionScope`、`OperationRef`；`src/application/dto/operation-outcome.ts` 的 `OperationOutcome<T>`、`ReconcileResult` | 建立 port 与 DTO；`query` / `mutate` 判别联合以操作 ID 索引；scope 为 `mutate` 必填 | 领域层不得引用 Orca 术语实现；不得出现 scope 可选重载 |
| IP-2 | 1.2 | 封闭的操作边界与可信执行上下文（未声明操作 / 缺失 scope）；三值操作结果与未知结果对账（各 Scenario） | `src/adapters/orca-cli/operation-catalog.ts` 的 `ORCA_OPERATIONS`；`src/adapters/orca-cli/orca-backend.ts` 的 `createOrcaExecutionBackend`；`src/adapters/orca-cli/error-classification.ts` 的 `classifyOrcaFailure` | 登记 M0 首批命令（版本、状态、host、worktree current、terminal create/list/show/read/wait、orchestration run-create/run-use/run-current/run-list/run-show、task-create/list/update、worker-start/show/read/list/stop/abandon/release、check、request-show）；实现封闭解析与三值分类 | 不得新增未登记命令；不得把 `absent` 或缺失 host scope 读作未发生 |
| IP-3 | 2.1 | 参数数组执行、显式运行上下文与输出分离（全部 Scenario）；退出状态、错误分类、超时与取消（全部 Scenario） | `src/adapters/orca-cli/process-runner.ts` 的 `runProcess`、`ProcessResult` | 参数数组调用、必填 cwd/env、stdout 与 stderr 分离、字节与行数上限加截断标记、有限超时、可取消、超时或取消判未知 | 不得经 shell；不得隐式重试；不得无界缓冲或记录敏感值 |
| IP-4 | 2.2 | 投递读取与确认是分离的传输原语（全部 Scenario） | `src/adapters/orca-cli/delivery-reader.ts` 的 `readDeliveryBatch`、`ackDelivery`、`DeliveryIdentity` | 读取与确认分离；读取保留 Delivery、Task、Dispatch、Attempt 与 consumer generation 身份字段；确认沿用三值结果 | 不得隐式确认、执行业务落盘、推进生命周期或建立持久化去重 |
| IP-5 | 3.1 | doctor 核验环境与公开契约，缺失时拒绝启动（全部 Scenario） | `src/bootstrap/doctor.ts` 的 `runDoctor`、`DoctorReport`；`src/interfaces/cli/doctor-command.ts`、`src/interfaces/cli/main.ts` | 核验版本、runtime 可达、host、协调身份可取得性、必需命令存在；区分不可达 / 版本不符 / 能力缺失；无 TTY 可运行 | 不得在缺能力时自动回退或报告成功；不得在 CLI 入口引入 TTY 或 UI 依赖 |
| IP-6 | 3.2 | doctor 核验环境与公开契约，缺失时拒绝启动（无 TTY 运行） | `package.json` 的 `bin` 与 `scripts.build` | 注册 `orca-companion` 可执行入口并补 build 脚本 | 不新增运行时依赖；不改变现有脚本语义 |
| IP-7 | 4.1 | 参数数组执行、显式运行上下文与输出分离（特殊字符 / 保活 / 超限） | `tests/process-runner.test.ts` | 以小型测试夹具覆盖参数原样传递、stderr 噪声、截断标记 | 不断言具体文案与内部调用顺序 |
| IP-8 | 4.2 | 封闭的操作边界与可信执行上下文（全部）；三值操作结果与未知结果对账（全部） | `tests/orca-backend.contract.test.ts` | 用记录型假 transport 覆盖未声明操作拒绝、缺失 scope 拒绝、三值分类、原 ID 对账、不确定时阻塞 | 不复制 Orca 状态机；不精确断言完整错误文案 |
| IP-9 | 4.3 | 投递读取与确认是分离的传输原语（全部） | `tests/delivery-transport.test.ts` | 覆盖读取零确认、身份字段保留与独立确认的三值结果 | 不测试业务落盘、生命周期推进或持久化去重 |
| IP-10 | 4.4 | doctor 核验环境与公开契约，缺失时拒绝启动（全部 Scenario） | `tests/doctor.test.ts` | 用假探测结果覆盖成功、无 TTY、身份不可取得、版本或 runtime 不可用四类出口 | 不断言整屏文案；只断言退出状态与结构化字段 |
| IP-11 | 5.1 | 探针只在隔离目标中运行（全部）；证明协调者身份与单 Worker 闭环（全部） | `tests/m0-isolated-probe.integration.test.ts` | 以 `ORCA_M0_PROBE=1` 显式开启；自行建一次性仓库与专用终端；Worker Profile 显式使用 `minimax-cn/MiniMax-M3`；验证身份、单 Worker 闭环、确认后不重放、重连不重复派发 | 不触碰主项目；不重启全局 runtime；不继承默认模型；未开启时跳过 |
| IP-12 | 5.2 | 探针结论回写兼容性文档（全部 Scenario） | `docs/orca-compatibility.md` | 按 IP-11 结果更新验证环境、已核验、尚未验证三部分并记录缺口 | 不把未核验项写成已支持；不修改 `references/orca` 记录 |

## 4. 调用与副作用顺序

只读顺序（doctor 与查询）：核验可执行文件与版本 → `status --json` → `host list` → 协调身份探测 → 必需命令存在性 → 输出报告。任一失败即停止，不继续后续检查。

变更顺序（后续 change 复用，本 change 只实现到 transport 层）：

1. controller 生成 OperationId 并登记意图（持久化在 `m1-persist-coordination-state`）；
2. adapter 校验 ExecutionScope 与操作目录成员资格，非法即 `rejected` 且不产生进程；
3. 构造参数数组并执行，stdout 解析、stderr 丢弃、输出超限标记；
4. 按 D3 分类为 `accepted` / `rejected` / `unknown`；
5. `unknown` 时以同一 OperationId 调用 `request-show` 对账；仍不确定即报告阻塞并保留 lane；
6. Delivery 读取与确认保持为两个独立调用；上层只有在业务落盘并回读后才调用确认。

失败处理不变量：任何步骤都不得以新 ID 重试（D4）；`rejected` 只在能证明无副作用时使用；adapter 不替上层决定何时确认 Delivery（IP-4）。

## 5. Schema、状态与持久化落实

本 change 不建立任何持久化存储，不写 SQLite，不改动 Orca 数据库。Delivery 去重、业务落盘与 persist-before-ack 编排不属于 M0；本 change 只交付可被上层安全编排的读取/确认原语。boundary DTO 的运行时校验按 D6 手写：必需字段、类型、控制流枚举三类判定，未知枚举与缺失必填字段一律 fail closed 并返回 `rejected`。Identity 与 handle 属 runtime 作用域，不落盘（D9）。operation intent 表的 schema 与事务边界留给 `m1-persist-coordination-state`，本 change 只固定 `OperationRef` 的字段形状与关联规则（D4）。

## 6. 验收证据矩阵

| Requirement/Scenario | IP-ID | 测试文件 | Fixture/前置条件 | 关键断言 | 可运行命令 |
|---|---|---|---|---|---|
| 封闭的操作边界与可信执行上下文 / 未声明的操作被拒绝 | IP-1, IP-2 | `tests/orca-backend.contract.test.ts` | 记录型假 transport | 结果为 `rejected` 且记录到零次进程调用 | `pnpm test -- tests/orca-backend.contract.test.ts` |
| 封闭的操作边界与可信执行上下文 / 缺失 scope 时不发起变更 | IP-1, IP-2 | 同上 | 无 scope 的 mutate 请求 | `rejected` 且无 mutation 记录 | 同上 |
| 三值操作结果与未知结果对账 / 确定失败仍是 accepted | IP-2 | 同上 | 假 transport 返回确定失败错误码 | 结果为 `accepted` 且带原错误码 | 同上 |
| 三值操作结果与未知结果对账 / 不确定结果分类为 unknown | IP-2 | 同上 | 假 transport 返回 `start_unknown` / `outcome_unknown` | 结果为 `unknown` 且含 OperationRef | 同上 |
| 三值操作结果与未知结果对账 / 对账仍不确定时阻塞该通路 | IP-2 | 同上 | `request-show` 返回 `pending` / `absent` | 结论为阻塞且未发生第二次 mutate | 同上 |
| 投递读取与确认是分离的传输原语 / 读取不会隐式确认 | IP-4 | `tests/delivery-transport.test.ts` | 记录型假 transport | 读取返回稳定 identity 且确认调用数为零 | `pnpm test -- tests/delivery-transport.test.ts` |
| 投递读取与确认是分离的传输原语 / 确认是独立 mutation | IP-4 | 同上 | 单独提交 Delivery identity | 只确认目标 identity 且保留三值结果 | 同上 |
| 参数数组执行、显式运行上下文与输出分离 / 参数含空格与特殊字符 | IP-3 | `tests/process-runner.test.ts` | `process.execPath` 加参数数组 | 参数原样到达子进程 | `pnpm test -- tests/process-runner.test.ts` |
| 参数数组执行、显式运行上下文与输出分离 / 机器输出与保活信息混合 | IP-3 | 同上 | 子进程 stdout 单文档 + stderr 保活行 | 解析只取 stdout | 同上 |
| 参数数组执行、显式运行上下文与输出分离 / 输出超出上限 | IP-3 | 同上 | 超限输出脚本 | 截断标记为真 | 同上 |
| 退出状态、错误分类、超时与取消 / 非零退出保留错误码 | IP-3 | 同上 | 以退出码 1 并输出 JSON 错误的脚本 | 保留退出码与错误载荷 | 同上 |
| 退出状态、错误分类、超时与取消 / 后端不可达分类 | IP-3 | 同上 | 不可达类错误码 | 归类为不可达而非输入不合法 | 同上 |
| 退出状态、错误分类、超时与取消 / 超时或取消 | IP-3 | 同上 | 睡眠子进程 | 终止并判未知，无隐式重试 | 同上 |
| doctor 核验环境与公开契约 / 环境完整 | IP-5 | `tests/doctor.test.ts` | 假探测全部成功 | 退出码 0 且各项结论齐备 | `pnpm test -- tests/doctor.test.ts` |
| doctor 核验环境与公开契约 / 无 TTY 运行 | IP-5, IP-6 | 同上（管道运行） | 无 TTY 的标准流 | 退出码 0 且诊断在 stderr | `pnpm test -- tests/doctor.test.ts` |
| doctor 核验环境与公开契约 / 协调身份不可取得 | IP-5 | 同上 | 身份探测失败 | 非零退出且该项标记缺失 | 同上 |
| doctor 核验环境与公开契约 / Orca 版本或 runtime 不可用 | IP-5 | 同上 | 版本不符与 runtime 不可达两组 | 非零退出且区分两类原因 | 同上 |
| 探针只在隔离目标中运行 / 使用专用身份与固定模型 | IP-11 | `tests/m0-isolated-probe.integration.test.ts` | `ORCA_M0_PROBE=1`、Orca 可用且 Worker Profile 显式绑定 `minimax-cn/MiniMax-M3` | 使用探针自建终端与 Run；缺少模型绑定时派发计数为零 | `ORCA_M0_PROBE=1 pnpm test -- tests/m0-isolated-probe.integration.test.ts` |
| 探针只在隔离目标中运行 / 触碰隔离边界之外 | IP-11 | 同上 | 模拟越界条件 | 停止并报告缺口 | 同上 |
| 证明协调者身份与单 Worker 闭环 / 闭环成功 | IP-11 | 同上 | 一次性仓库与专用终端 | 完成消息归属匹配且处理后确认 | 同上 |
| 证明协调者身份与单 Worker 闭环 / 重连后不重复派发 | IP-11 | 同上 | 无进程内状态的新调用 | 找回同一 Run/Task/Dispatch，收件箱为空 | 同上 |
| 探针结论回写兼容性文档 / 硬门失败时阻断后续 | IP-12 | 人工核对 `docs/orca-compatibility.md` | 探针结论 | 缺口已记录且后续 change 被阻断说明在案 | `rg -n "阻断|缺口" docs/orca-compatibility.md` |
| 探针结论回写兼容性文档 / 部分能力未验证 | IP-12 | 同上 | 未验证项清单 | 仍列在「尚未验证」 | `rg -n "尚未验证" docs/orca-compatibility.md` |

## 7. 文件清单与升级条件

允许新增：

- `src/application/ports/execution-backend.ts`、`src/application/dto/operation-outcome.ts`
- `src/adapters/orca-cli/operation-catalog.ts`、`orca-backend.ts`、`error-classification.ts`、`process-runner.ts`、`delivery-reader.ts`
- `src/bootstrap/doctor.ts`
- `src/interfaces/cli/main.ts`、`doctor-command.ts`
- `tests/process-runner.test.ts`、`tests/orca-backend.contract.test.ts`、`tests/delivery-transport.test.ts`、`tests/doctor.test.ts`、`tests/m0-isolated-probe.integration.test.ts`

允许修改：`package.json`（`bin` 与 `scripts.build`）、`docs/orca-compatibility.md`。

禁止触碰：`AGENTS.md`、`CONTEXT.md`、`openspec/config.yaml`、`openspec/schemas/**`、`references/orca`、`src/domain/**`（本 change 不需要领域逻辑）、其它 change 目录。

升级条件（必须停下来询问或上报）：

- 需要新增运行时依赖，或需要使用 `node:sqlite`；
- Orca 当前安装版本缺少本计划登记的任何必需命令，或其错误词表与 D3 不一致；
- 探针无法在隔离目标中证明协调者身份（D12 硬门失败）；
- 需要修改 `AGENTS.md` / `CONTEXT.md` / schema，或需要触碰上述禁止清单中的文件；
- 探针所需的隔离边界（一次性仓库、专用终端）无法在不影响用户既有 workload 的前提下建立。

## 8. 验收 Agent 授权与限定审计

授权范围：本 change 允许新增与修改的文件清单，以及上表全部测试文件；验收可运行 `pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm test`，并可在显式开启 `ORCA_M0_PROBE=1` 时运行隔离探针。

保护边界（需要上报而非自行决定）：OperationOutcome 三值语义与 D3 映射表、ExecutionScope 的必填性、Delivery 读取/确认分离、`docs/orca-compatibility.md` 中「已核验 / 尚未验证」的划分。

限定审计标签：`@M0-PROBE-DOC-SYNC`（文档与探针结论一致性）、`@M0-UNKNOWN-RECONCILE`（unknown 对账路径未出现换 ID 重试）。
