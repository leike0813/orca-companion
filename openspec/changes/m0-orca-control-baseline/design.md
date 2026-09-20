## Context

直接前驱 `m0-establish-architecture-contracts` 已归档且 `architecture/module-interface-contracts` 主规格存在，才允许实施本 change。它冻结了 `docs/architecture.md` 的 `MOD-04`、`FLOW-01`，以及 `docs/interface-contracts.md` 的 `IC-01`、`IC-02`、`IC-12`；本 change 是这些合同的首个代码 owner，不得改变其字段来源、三值结果、原 OperationId 对账和 CLI/TUI 分层。

仓库目前只有目录骨架（`src/**` 全是 `.gitkeep`），没有任何 Orca 调用代码。可用的一手材料是 `docs/research/orca-public-control-contracts.md`、`docs/research/m0-isolated-control-loop-probe.md` 与 `docs/orca-compatibility.md`，它们把公开命令面、错误词表、身份约束和一次真实隔离闭环记录成了可核对的事实。做这件事的时机由依赖决定：后续九个 change 的持久化、派发、恢复和 TUI 都建立在同一层 Orca 控制契约上，先做这一层能避免把 CLI 细节复制到每个用例。

约束来自 `AGENTS.md` 与 `CONTEXT.md`：只使用公开 Orca CLI，不直接读写 Orca 数据库或私有 RPC；boundary DTO 与 CLI JSON 必须做运行时校验；Mutation 结果保留三值语义；不得引入新依赖，不构建 `references/orca`。

### 架构合同导入

| 关系 | 合同 | 本 change 的责任 |
|---|---|---|
| Create | `IC-01` | 首次实现共同 identity/revision/reference 类型与边界校验 |
| Create | `IC-02`、`FLOW-01` | 首次实现 `ExecutionBackend`、ExecutionScope、OperationOutcome、Delivery transport 与受限进程 adapter |
| Create | `IC-12` 的 CLI 基线 | 首次实现无 TTY doctor/CLI 入口；不实现 TUI projection |
| Consume | `MOD-04` | Adapter 只转换 transport/schema，不拥有业务策略 |

## Goals / Non-Goals

**Goals:**

- 用一个封闭的 `query` / `mutate` 判别联合把 Orca 公开命令收进单一 adapter，并把三值 OperationOutcome、稳定 OperationId 与 unknown 对账路径固化下来。
- 提供受限进程执行边界，使所有外部调用走同一套参数数组、输出分离、输出上限、超时与取消规则。
- 提供可在无 TTY 环境运行的 `doctor`，在能力缺失时以非零状态拒绝启动。
- 在隔离项目与专用身份中留下一次真实单 Worker 闭环的证据，并把已核验事实与缺口写回兼容性文档。

**Non-Goals:**

- 不实现共享协调状态持久化、CAS revision、Runtime/Execution Lease 与 intent 表（`m1-persist-coordination-state`）。
- 不实现 LangGraph loop、Coordinator 工具、Execution Graph、TUI 与 Worker 角色编排。
- 不实现 provider transcript 的精确 Session Binding；探针只记录该能力的当前边界。
- 不重启全局 Orca runtime，不清理用户既有的终端、Run 或 worktree。

## Decisions

### D1 变更操作只接受 controller 签发的 ExecutionScope

`mutate` 的入参携带 controller 构造的 ExecutionScope（协调者终端身份、目标对象、期望 revision、超时），adapter 不提供「无 scope 也能跑」的重载，模型侧工具也不暴露 scope 字段。理由：`docs/research/orca-public-control-contracts.md` 第 3 节证明 Orca 认身份不认意图，`consumer_fenced` 与 `stable_pane_required` 都要求调用方先有可证明身份；把 scope 放在模型可填的位置等于允许越权。

曾被考虑的替代做法是由 adapter 在内部解析当前终端身份。放弃的原因是它会让「谁在调用」依赖进程环境，测试与 TUI 都无法显式注入，且与 `AGENTS.md` 第 5 节「模型和 Worker 不得填写 scope、身份、Run、consumer generation 或 operation identity」相反。

### D2 操作目录是唯一入口，未声明的操作直接拒绝

操作目录（`operation-catalog.ts`）把每个受支持命令登记为「操作 ID → argv 构造 + JSON 解析器 + 是否可变」的一条记录，adapter 只按操作 ID 取值，不接受拼接后的 argv。未登记的 ID 在构造 argv 之前返回 `rejected`。

替代做法是暴露一个通用 `run(argv)`。放弃它是因为那等于把「任意 Orca 命令」交给上层，正是 `AGENTS.md` 第 5 节禁止的无约束状态修改。冷启动成本由 M0 首批需要的命令承担，新增命令是一次显式目录改动，可审查。

### D3 三值结果与 Orca 词表的固定映射

- `accepted`：Orca 给出确定结果，包括确定失败（错误码属于输入不合法、阶段不允许、scope 错误、能力缺失）。
- `rejected`：能证明副作用未发生，即请求未离开 transport（例如本地目录缺失、身份未配置而请求根本没有抵达 runtime）。
- `unknown`：`start_unknown`、`stop_unknown`、`outcome_unknown`、`release_unknown`、`release_pending`，以及带 `orchestrationRequestId` 的 `runtime_unavailable`、`runtime_timeout`、`invalid_runtime_response`。

映射写在 adapter 一处。放弃「用布尔成功位加错误消息」的做法，因为 `AGENTS.md` 第 5 节要求 accepted 不等于 Worker 完成，且 unknown 必须按同一 OperationId 对账。

### D4 OperationId 与后端请求 ID 的分工

OperationId 由 controller 生成并在调用前登记为意图；Orca 打印的 `orchestrationRequestId` 是后端侧凭据，只用于对账与 `--retry-request`。adapter 负责把二者关联在 OperationRef 中，但不得把后端 request ID 当作 Companion 的操作身份。

`docs/research/coordinator-state-recovery.md` 第 5 节给出了同一条边界：回执属于「我方是否有过这个意图」，Orca receipt 属于「副作用是否落地」，两者用同一个请求 ID 关联而不是互相复制。M0 只实现类型与关联逻辑；意图表的持久化归 `m1-persist-coordination-state`。

### D5 进程执行边界收在 `src/adapters/orca-cli/` 内

`AGENTS.md` 第 4 节把「进程/JSON」明确划给 `src/adapters/orca-cli/`，因此参数数组执行、stdout/stderr 分离、输出上限、超时与取消都放在该目录，不新建顶层进程工具模块。执行器本身不解析 Orca 语义，只返回退出码、标准输出、标准错误与截断标记。

替代做法是引入通用 `exec` 辅助包或使用 shell。放弃的理由是 shell 拼接会让参数注入成为可能，而新依赖违反项目的最小模块取向。

### D6 运行时校验采用手写窄校验器

boundary JSON 按字段逐项校验：必需字段缺失、控制流枚举出现未知取值、类型不符时 fail closed，返回 `rejected` 并保留原始错误。不引入 schema 依赖，因为当前没有安装校验库，而 `AGENTS.md` 禁止未经授权新增依赖；这里需要的判定集很小，手写校验器可读且不需要生成代码。

### D7 输出与保活处理

标准输出按单个 JSON 文档解析；`check --wait` 在标准错误上的 `_keepalive` 行按噪声丢弃，不计入失败也不计入输出上限的截断判定。输出上限同时按字节与行数限制，超限时截断并置位截断标记，调用方必须检查该标记后再信任数组长度。

理由：`docs/research/orca-public-control-contracts.md` 第 2.4 节记录保活行走 stderr，而长会话输出可能无界；伪造一个「读完了」的结果比截断更危险。

### D8 `doctor` 的检查项与退出码

doctor 依次核验：Orca 可执行文件与版本、`status --json` 的 runtime 可达性、`host list` 的本地 host、协调身份可取得性（专用终端 handle 与绑定型命令可用性）、M0 依赖的公开命令是否存在于当前版本。任一项缺失即非零退出，输出区分「不可达」「版本不符」「能力缺失」三类原因。

doctor 不尝试修复环境，也不在缺能力时退化为只读提示。放弃「警告后继续」的原因与 `AGENTS.md` 第 2 节对 provider 能力核验的要求一致：缺失必需能力时拒绝启动。

### D9 身份以专用终端 handle 表达

协调者身份通过 `terminal create` 建立专用终端，再以 `--from <handle>` 执行绑定型命令。handle 是 runtime 作用域的，每次进程启动重新解析，不写入配置也不缓存到磁盘。

`docs/research/m0-isolated-control-loop-probe.md` 的 P1 已证明 CLI 创建的真实终端可以承担该身份，因此 M0 不再保留「只有 Orca UI 终端能当协调者」的备选方案；若探针在隔离目标中无法复现这一点，按 D12 记录缺口并阻断。

### D10 隔离探针作为显式开启的集成测试

探针是一个默认跳过、由环境变量显式开启的 Vitest 文件（`ORCA_M0_PROBE=1`），运行时自行 `mktemp` 一次性仓库、创建专用终端与 Run，并通过 Worker Profile 显式把真实 Codex Worker 固定为 `minimax-cn/MiniMax-M3`。结束后保留现场供用户检查，不自动清理、不触碰主项目、不重启全局 runtime；模型未显式固定时在派发前失败。

放弃独立脚本目录的原因是 `AGENTS.md` 第 4 节没有 `scripts/` 位置，而 `AGENTS.md` 第 11 节要求真实集成测试显式选择隔离项目；用现有 runner 加显式开关同时满足两点，也不引入第二套运行器。

### D11 模块归属与依赖方向

port 与 DTO（`ExecutionBackend`、`ExecutionScope`、`OperationRef`、`OperationOutcome`）放在 `src/application/`，Orca adapter 实现放 `src/adapters/orca-cli/`，CLI 入口放 `src/interfaces/cli/`，环境探测组合放 `src/bootstrap/`。领域层不出现 Orca 术语的实现细节，CLI 不直接调用 adapter。`src/interfaces/cli/main.ts` 必须能在不加载 Ink/React、不要求 TTY 的前提下运行。

### D12 M0 硬门与后续阻断

`doctor` 结论、探针结论与兼容性文档三者构成 M0 门禁。任一必需能力缺失时，实施停止并把最小可复现缺口写入 `docs/orca-compatibility.md`；`m1-persist-coordination-state` 与其余 change 在此之前不进入实施。禁止的绕过方式包括伪造终端身份、直写 Orca 数据库、调用私有 RPC 与依赖 `orchestration reset`。

## Risks / Trade-offs

- **操作目录冷启动不全。** M0 只登记首批命令，后续 change 新增命令需要一次目录改动。取舍是换掉「任意命令可达」的风险，代价是每次扩展都要显式审查。
- **手写校验器的维护成本。** 上游字段变化时校验器需要同步。收益是零新增依赖与 fail-closed 的明确行为；校验器集中在单文件，改动面小。
- **`node:sqlite` 与探针的真实性边界。** M0 不写数据库，但探针依赖 Node 24 的类型剥离与子进程行为；这些在有平台差异时会在 Ubuntu 之外的平台暴露。当前支持声明只限本机 Ubuntu。
- **探针会留下现场。** 一次性仓库、Run、Dispatch 与 archive 按设计保留，需要用户授权后才清理；这是可审计性换来的空间占用。

## Migration Plan

无既有行为需要迁移：`src` 与 `tests` 目前只有占位文件，`openspec/specs/` 为空。`docs/orca-compatibility.md` 的「已核验」与「尚未验证」两节按探针结果更新，属于本 change 的交付物。

## Open Questions

无需要在本 change 前解决的问题。provider transcript 的精确绑定、runtime 重启后的句柄重解析与 Windows 行为都保留为未核验项，不由本 change 决定；它们分别属于 `m1-recover-execution`、`m1-run-coordinator-sessions` 与 M3 的评估范围。
