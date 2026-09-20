## Why

M0 只解决「能不能安全地调用 Orca」，没有地方存放 Companion 自己必须记住的事：副作用意图、Session 注册、Ticket Claim、Runtime 与 Execution lease、fencing 代数，以及无法从 tracker、Git、Orca 重建的共享协调事实。缺这层持久化，恢复只能靠猜测，并发 Session 也无法安全共享一个 Coordination Scope。本 change 建立 `coordination.sqlite` 与 CAS revision，为后续每个 change 提供稳定的共享事实源。

## What Changes

- 新增 Branch Coordination Store：在 Git common dir 的 Companion 私有目录建立 `coordination.sqlite`，保存模式、Planning Cycle 引用、Session 注册、claims、pending interactions、operation intents、lease 与 fencing、共享预算与 CAS revision。
- 新增带预期 revision 的乐观并发控制：写入必须携带 `expected revision`，不匹配即拒绝；不使用项目级长期单写者锁，事务保持短小。
- 新增 Runtime Lease 与 Execution Coordination Lease：短租约加心跳续约；Runtime Lease 过期不释放 Ticket Claim 或 Execution Coordination Lease；递增 fencing 代数拒绝迟到进程写入。
- 新增 Operation Intent 生命周期：副作用前写 intent，外部 mutation 后核验并收尾；崩溃恢复时以原 OperationId 对账，无法判定则阻塞对应 mutation lane。
- 新增 `orca-companion status [--json]`：一次性只读查询，输出 Scope 状态与待处理交互。
- 消费直接前驱 `m0-orca-control-baseline` 冻结的接缝（`ExecutionBackend`、`OperationOutcome`、OperationId、分离的 Delivery 读取/确认原语），不重新定义它们。

本 change 不实现 Execution Graph、Worker 生命周期、模型 loop 与 TUI。

## Capabilities

### New Capabilities
- `coordination/branch-state`: 共享协调状态的持久化、模式与 Planning Cycle 引用、Session 注册与 CAS revision
- `coordination/concurrency-control`: Runtime 与 Execution Coordination lease、心跳续约与 fencing
- `coordination/operation-intents`: 副作用意图的记录、收尾与未知结果对账入口
- `cli/scope-status`: `orca-companion status` 的只读快照输出

### Modified Capabilities

无。`openspec/specs/` 目前为空，本 change 只新增独立 capability。

## Impact

受影响区域：`src/domain`（协调事实类型）、`src/application`（store port、DTO 与用例）、`src/adapters/storage`（SQLite 实现）、`src/interfaces/cli`、`src/bootstrap`、`tests/`。

- 使用 Node 24 内置 `node:sqlite` 的同步接口，不新增运行时依赖；该 API 属实验性，实施时以本机实测行为为准。
- 不写 Orca 数据库；`coordination.sqlite` 只保存 Companion 无法从其它来源重建的事实。
- 不修改 `AGENTS.md`、`CONTEXT.md`、schema 与 `references/orca`。
