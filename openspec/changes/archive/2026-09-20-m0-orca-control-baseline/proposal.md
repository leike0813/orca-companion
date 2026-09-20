## Why

直接前驱 `m0-establish-architecture-contracts` 已固定 module、接口字段、唯一 owner 与跨系统调用顺序，但 Companion 目前仍只有空骨架：仓库中没有任何 Orca 控制代码，`docs/orca-compatibility.md` 仍把协调身份、`--json` 契约、回执与对账列为未核验项，真实单 Worker 闭环只在一次性探针里跑通过一次。缺少可运行的 M0 控制基线，后续九个 change 就没有可信依赖。本 change 把这层基线从研究结论变成可执行、可对账、失败即阻断的硬门。

## What Changes

- 新增 ExecutionBackend：只经公开 Orca CLI 的封闭 `query` / `mutate` 判别联合，每次变更携带可信 ExecutionScope 与稳定 OperationId。
- 新增三值 OperationOutcome（`accepted` / `rejected` / `unknown`），并固定 unknown 对账以及 Delivery 的显式「读取但不确认 / 单独确认」传输原语；业务落盘、去重与确认编排由后续执行 change 负责。
- 新增受限进程执行器：参数数组、显式运行上下文、stdout 与 stderr 分离、输出上限、超时与取消。
- 新增 `orca-companion doctor`：核验 Orca 版本、runtime 可达性、host、协调身份与 M0 所需公开命令契约；缺失必需能力时以非零状态拒绝启动。
- 新增隔离真实探针：在一次性项目与专用身份中验证协调者身份与单 Worker 闭环，结论写回 `docs/orca-compatibility.md`。
- M0 硬门未通过时阻断 M1 与 M2 的实施，缺口记录为最小可复现问题，不通过伪造身份或直写数据库绕过。

本 change 不实现 TUI、Execution Graph、LangGraph agent loop、持久化协调状态（由 `m1-persist-coordination-state` 承担）与 Worker 角色编排。

## Capabilities

### New Capabilities
- `backend/orca-control`: 经公开 Orca CLI 的查询与变更控制契约，含三值 OperationOutcome、OperationId/receipt/ack 与 unknown 对账
- `backend/process-execution`: Companion 调用外部命令的受限进程边界与结果分类
- `cli/environment-diagnostics`: `orca-companion doctor` 的环境与能力核验
- `testing/isolated-control-probe`: 隔离项目与专用身份中的真实控制闭环探针

### Modified Capabilities

无。`openspec/specs/` 当前为空，本 change 只新增独立 capability。

## Impact

受影响区域：`src/application`（ports 与 DTO）、`src/adapters/orca-cli`、`src/interfaces/cli`、`src/bootstrap`、`tests/`、`docs/orca-compatibility.md`、`package.json`。

- 直接消费 `docs/architecture.md` 的 `MOD-04`/`FLOW-01` 与 `docs/interface-contracts.md` 的 `IC-01`/`IC-02`/`IC-12`，不得另建平行 backend、结果类型或 CLI projection。
- 不新增运行时依赖；CLI 输出解析只使用已有 TypeScript 与 Node.js 内置能力。
- 不触碰 `references/orca` submodule，不构建上游源码。
- `package.json` 需补 `build` 脚本以对齐 AGENTS.md 第 11 节的验证清单。
