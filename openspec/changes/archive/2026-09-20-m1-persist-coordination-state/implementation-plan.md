# Implementation Plan

## 1. 实施基线与权威来源

- **基线模式**：`predecessor-contract`。
- **直接前驱**：`m0-orca-control-baseline`（本 change 的规划 commit 为 `cd29e2bcd8b0278d34ae19db64cb8ebdaf149279`；实施时以当时的实际 HEAD 为准并在交付说明中记录）。
- **架构合同基线**：`docs/architecture.md` 的 `MOD-01`、`MOD-02`、`MOD-04`、`FLOW-01`；`docs/interface-contracts.md` 的 `IC-01`–`IC-03`。本 change Create `IC-03`，只 Consume `IC-01`/`IC-02`。
- **冻结接缝**（来自前驱 artifacts，本 change 只消费不重定义）：
  - `ExecutionBackend` 的 `query` / `mutate` 判别联合（前驱 `specs/backend/orca-control/spec.md`「封闭的操作边界与可信执行上下文」与 `design.md` D1–D2）；
  - `OperationOutcome<T>` 的三值与 `OperationRef` 形状（前驱 `design.md` D3–D4）；
  - OperationId 与后端 request ID 的分工，以及 `unknown` 必须按原 ID 对账（前驱 `design.md` D4）；
  - Delivery 的 `readDeliveryBatch` / `ackDelivery` 分离原语与稳定 `DeliveryIdentity`（前驱 `specs/backend/orca-control/spec.md`「投递读取与确认是分离的传输原语」）。
- **实施前漂移检查**（任一不成立即回到规划，不在本 change 内绕过）：
  1. `m0-orca-control-baseline` 已 archive，且 `openspec/specs/` 中存在前驱四个 capability 的主规格；
  2. `docs/orca-compatibility.md` 的 M0 门禁结论为通过；
  3. 实际 `src/application/ports/execution-backend.ts` 与 `src/application/dto/operation-outcome.ts` 的导出名与字段与上述冻结接缝一致；
  4. `src/adapters/orca-cli/process-runner.ts` 的 `ProcessResult` 仍提供退出码、stdout、stderr 与截断标记。
  5. `IC-03` 的 owner、canonical paths、短事务、CAS 与 migration 合同未漂移，且没有前驱已创建平行 coordination repository。
- **权威来源**：本 change 的 `specs/` 四个 capability 与 `design.md` D1–D10；`CONTEXT.md` 的 Branch Coordination Store、Runtime Lease、Execution Coordination Lease、Operation Outcome 与 Pending Interaction 定义；`AGENTS.md` 第 2、4、5、8、9 节。
- **apply 门禁**：不创建 `verification.md`；未通过第 1 节漂移检查时不得开始编辑。

### 合同 create/extend/consume

| 关系 | 合同与 canonical symbols | 漂移检查 |
|---|---|---|
| Create | `IC-03`：`branch-coordination-store.ts`、`coordination-store.ts`、`schema.ts` | port 只有闭合 query/transact seam；写入校验 expected revision 与 fencing |
| Consume | `IC-01` | ID、revision、generation 语义不重定义 |
| Consume | `IC-02`、`FLOW-01` | intent 不复制 receipt；accepted/rejected 收尾，unknown 保持 pending |

## 2. 复用与接缝

| IP-ID | 现有或前驱文件与符号 | 复用方式 | 禁止复制的事实 |
|---|---|---|---|
| IP-1 | `src/domain/.gitkeep`、前驱 `src/application/dto/operation-outcome.ts` 的 `OperationRef` | 领域层定义模式、控制状态、lease 类型与协调事实类型，复用前驱的 OperationRef 作为 intent 引用 | 不把 SQL、文件路径或 Orca 术语带进领域层 |
| IP-2 | `src/adapters/storage/.gitkeep`、Node 24 `node:sqlite` 的 `DatabaseSync` | 用内置同步接口实现事务化 store，不引入原生依赖 | 不复制 checkpointer 契约；不在 store 内实现对账逻辑 |
| IP-3 | IP-2 的 write 通道、前驱 `execution-backend.ts` 的 `mutate` | 应用层把 `OperationOutcome` 映射为 intent 收尾分类 | 不新增第四种结果分类；不复制 Orca receipt 内容 |
| IP-4 | 前驱 `src/interfaces/cli/main.ts` 与 `doctor-command.ts` 的命令分发 | 复用同一无 TTY CLI 入口与输出约定 | 不让 status 触发租约续约或对账 |
| IP-5 | `src/bootstrap/.gitkeep`、前驱 doctor 的探测结果 | 复用路径解析模式，在 bootstrap 中解析 Git common dir 并注入 store | 不在领域层解析路径 |
| IP-6 | 前驱 `tests/doctor.test.ts` 的假探测模式、`vitest.config.ts` | 复用假 store 与临时目录夹具写行为测试 | 不断言 SQL 细节或内部调用顺序 |

## 3. 代码变更映射

| IP-ID | Task | Requirement/Scenario | 文件与符号 | 精确变化 | 不得改变 |
|---|---|---|---|---|---|
| IP-1 | 1.1 | 模式与 Planning Cycle 引用（全部）；Coordinator Session 注册（全部）；Runtime Lease 生命周期与 fencing（全部）；Execution Coordination Lease 唯一持有者（全部） | `src/domain/coordination/mode.ts` 的 `CoordinationMode`、`ControlState`；`src/domain/coordination/leases.ts` 的 `LeaseKind`、`LeaseRecord`、`FenceViolation`；`src/domain/coordination/revision.ts` 的 `ExpectedRevision` | 定义模式、控制状态与租约类型；控制状态与模式正交表达 | 不把暂停/取消表达成第三种模式；不引入领域层依赖 |
| IP-2 | 1.2 | 只持久化不可重建的协调事实（全部）；预期 revision 的乐观并发控制（全部）；Coordinator Session 注册（全部） | `src/adapters/storage/coordination-store.ts` 的 `openCoordinationStore`、`CoordinationStore`；`src/adapters/storage/schema.ts` 的 `SCHEMA_VERSION`、`migrate`；`src/application/ports/branch-coordination-store.ts` 的 port | 建库与 schema 版本、迁移、CAS 写入、Session 注册与 scope 记录读写；唯一约束承载三项不变式 | 不提供无 expected revision 的写入重载；不镜像 tracker/Git/Orca 事实 |
| IP-3 | 1.3 | 副作用前先持久化意图（全部）；意图收尾与对账入口（全部） | `src/application/dto/operation-intent.ts` 的 `OperationIntent`、`IntentState`；`src/application/coordination/intent-service.ts` 的 `beginIntent`、`settleIntent`、`blockLane`、`resolveLane` | 意图登记与收尾映射；未决意图按原 OperationId 保留并把 lane 标记阻塞 | 不换 ID 重试；不把 unknown 当作确定失败 |
| IP-4 | 2.1 | Runtime Lease 生命周期与 fencing（全部）；Execution Coordination Lease 唯一持有者（全部） | `src/application/coordination/lease-service.ts` 的 `acquireRuntimeLease`、`renewRuntimeLease`、`acquireExecutionLease`、`releaseExecutionLease` | 心跳续约、接管时推进 fencing generation、过期不释放 claim 与 execution lease | 不让心跳推进 `scope.revision`；不让过期租约自动释放 claim |
| IP-5 | 2.2 | status 提供只读快照（全部）；status 输出 Scope 协调事实（全部） | `src/interfaces/cli/status-command.ts` 的 `runStatus`、`StatusSnapshot`；`src/bootstrap/composition.ts` 的 `createCoordinationStore` | 组装只读快照输出；存储不可读或版本不符时非零退出 | 不在 status 内续约、对账或推进状态；不输出空快照 |
| IP-6 | 3.1 | 预期 revision 的乐观并发控制（过期 revision 被拒绝 / 短事务与事实一致性） | `tests/coordination-store.test.ts` | 以临时目录建库，覆盖并发 CAS 拒绝与多表同事务 | 不断言 SQL 语句文本；不锁定内部实现顺序 |
| IP-7 | 3.2 | 副作用前先持久化意图（全部）；意图收尾与对账入口（全部） | `tests/operation-intent.test.ts` | 覆盖意图先于外部调用、重复 ID 拒绝、unknown 保留未决、lane 阻塞 | 不以函数调用顺序作为断言目标 |
| IP-8 | 3.3 | Runtime Lease 生命周期与 fencing（全部）；Execution Coordination Lease 唯一持有者（全部） | `tests/lease-fencing.test.ts` | 用可注入时钟覆盖心跳、过期接管、旧 generation 拒绝、claim 保留、lease 唯一 | 不断言真实时钟或等待；不使用 sleep 等待过期 |
| IP-9 | 3.4 | status 提供只读快照（全部）；status 输出 Scope 协调事实（全部） | `tests/status-command.test.ts` | 覆盖必需字段、只读性、无 TTY、存储不可读与版本不符 | 不断言整屏文案；只断言退出状态与结构化字段 |

## 4. 调用与副作用顺序

写入顺序（所有共享状态变更共用）：解析 scope → 打开 store 并核验 schema 版本 → 校验调用方提供的 expected revision → 开始短事务 → 校验 fencing（如涉及租约）→ 应用变更并推进 revision → 提交。任一步失败即整体回滚，不留下部分写入。

intent 顺序：生成 OperationId → 事务内登记 intent（未决）→ 执行外部 mutation → 按 `OperationOutcome` 分类：`accepted` / `rejected` 收尾并记录分类；`unknown` 保留未决并记录 `OperationRef` → 若后续对账仍不确定则把 lane 标记阻塞。恢复路径只读未决 intent 并按原 OperationId 对账，不产生新 ID。

status 顺序：解析路径 → 只读打开 → 校验 schema 版本 → 读取 scope、leases、claims、interactions → 输出快照。全程不进入写事务。

## 5. Schema、状态与持久化落实

SSOT 边界：本 store 是共享协调事实的唯一写入点；Git、Orca、issue tracker 与项目配置的事实 SHALL NOT 进入本库（spec: 只持久化不可重建的协调事实）。状态转换：模式在 `route_planning` 与 `execution_coordination` 之间显式切换；控制状态独立字段。租约状态为活跃或过期，fencing generation 单调递增。intent 状态为未决、已收尾或阻塞。

约束与事务：三项唯一约束见 design D3；写入使用短事务与立即事务模式；schema 版本与迁移见 D2。权限：本库位于 Git common dir 的 Companion 私有目录，不由 Worker 或模型直接访问。迁移：首次打开建立 schema；版本高于实现即拒绝启动。可观测性：`status --json` 暴露只读快照；不新增日志格式约定。

## 6. 验收证据矩阵

| Requirement/Scenario | IP-ID | 测试文件 | Fixture/前置条件 | 关键断言 | 可运行命令 |
|---|---|---|---|---|---|
| 只持久化不可重建的协调事实 / 写入可重建事实被拒绝 | IP-2 | `tests/coordination-store.test.ts` | 临时目录建库 | 写入被拒绝且库内容不变 | `pnpm test -- tests/coordination-store.test.ts` |
| 只持久化不可重建的协调事实 / 拆分两个存储的职责 | IP-2 | 同上 | 检查表集合 | 库中不存在会话消息与图位置表 | 同上 |
| 预期 revision 的乐观并发控制 / 过期 revision 被拒绝 | IP-2, IP-6 | 同上 | 两次基于同一 revision 的写入 | 第二次被拒绝，第一次保持不变 | 同上 |
| 预期 revision 的乐观并发控制 / 短事务与事实一致性 | IP-2, IP-6 | 同上 | 需要多表同事务的写入 | 事务原子生效或整体回滚 | 同上 |
| 模式与 Planning Cycle 引用 / 非法模式被拒绝 | IP-1, IP-2 | 同上 | 写入未声明模式 | 拒绝且原模式保留 | 同上 |
| 模式与 Planning Cycle 引用 / 控制状态不改变模式 | IP-1, IP-2 | 同上 | 暂停与取消各一次 | 模式字段不变，控制状态单独变化 | 同上 |
| Coordinator Session 注册 / 多 Session 共存 | IP-2 | 同上 | 同 Scope 注册两个 Session | 两条记录均存在 | 同上 |
| Coordinator Session 注册 / 跨 Scope 注册被拒绝 | IP-2 | 同上 | 伪造 Scope 引用 | 注册被拒绝 | 同上 |
| 副作用前先持久化意图 / 意图先于外部调用 | IP-3, IP-7 | `tests/operation-intent.test.ts` | 记录型假 backend | 外部调用发生时 intent 已存在 | `pnpm test -- tests/operation-intent.test.ts` |
| 副作用前先持久化意图 / 重复 OperationId 被拒绝 | IP-3, IP-7 | 同上 | 同 ID 二次登记 | 拒绝且不产生第二条记录 | 同上 |
| 意图收尾与对账入口 / 确定结果收尾 | IP-3, IP-7 | 同上 | `accepted` 与 `rejected` 结果 | intent 标记已收尾并记录分类 | 同上 |
| 意图收尾与对账入口 / 未知结果保留为未决 | IP-3, IP-7 | 同上 | `unknown` 结果 | intent 保持未决并带 OperationRef | 同上 |
| 意图收尾与对账入口 / 对账仍不确定时阻塞通路 | IP-3, IP-7 | 同上 | 对账返回不确定 | lane 标记阻塞，该目标新变更被拒 | 同上 |
| Runtime Lease 生命周期与 fencing / 过期租约被接管 | IP-4, IP-8 | `tests/lease-fencing.test.ts` | 可注入时钟推进过期 | 新运行时取得更大 generation | `pnpm test -- tests/lease-fencing.test.ts` |
| Runtime Lease 生命周期与 fencing / 迟到进程写入被拒绝 | IP-4, IP-8 | 同上 | 旧 generation 写入 | 写入被拒绝且状态不变 | 同上 |
| Runtime Lease 生命周期与 fencing / 运行时退出后 claim 保留 | IP-4, IP-8 | 同上 | 租约过期 | claim 仍有效 | 同上 |
| Runtime Lease 生命周期与 fencing / 恢复沿用原所有权 | IP-4, IP-8 | 同上 | 同一 Session 重新取得租约 | 继承原 claim 与 lease 关系 | 同上 |
| Execution Coordination Lease 唯一持有者 / 非持有者不得推进执行 | IP-4, IP-8 | 同上 | 非持有者提交图变更与预算消耗 | 请求被拒绝 | 同上 |
| Execution Coordination Lease 唯一持有者 / 持有者唯一 | IP-4, IP-8 | 同上 | 两个 Session 竞争 | 仅一个取得，另一个明确拒绝 | 同上 |
| status 提供只读快照 / 只读查询不改变状态 | IP-5, IP-9 | `tests/status-command.test.ts` | 存在未决 intent 的 Scope | 输出反映状态且库内容不变 | `pnpm test -- tests/status-command.test.ts` |
| status 提供只读快照 / 无 TTY 运行 | IP-5, IP-9 | 同上 | 管道调用 | 机器输出在 stdout，诊断在 stderr | 同上 |
| status 输出 Scope 协调事实 / 输出必需字段 | IP-5, IP-9 | 同上 | 已初始化 Scope | 输出含模式、控制状态、Session、claim、lease 与交互字段 | 同上 |
| status 输出 Scope 协调事实 / 存储不可读或版本不符 | IP-5, IP-9 | 同上 | 损坏库与高版本库 | 非零退出且不输出空快照 | 同上 |

## 7. 文件清单与升级条件

允许新增：

- `src/domain/coordination/mode.ts`、`leases.ts`、`revision.ts`
- `src/application/ports/branch-coordination-store.ts`、`src/application/dto/operation-intent.ts`、`src/application/coordination/intent-service.ts`、`lease-service.ts`
- `src/adapters/storage/coordination-store.ts`、`schema.ts`
- `src/interfaces/cli/status-command.ts`、`src/bootstrap/composition.ts`
- `tests/coordination-store.test.ts`、`tests/operation-intent.test.ts`、`tests/lease-fencing.test.ts`、`tests/status-command.test.ts`

允许修改：`src/interfaces/cli/main.ts`（增加 `status` 子命令分发）、`package.json`（仅在需要新增脚本时；预计不需要）。

禁止触碰：`AGENTS.md`、`CONTEXT.md`、`openspec/config.yaml`、`openspec/schemas/**`、`references/orca`、前驱 change 目录与其它 change 目录、M0 已冻结的 `src/application/dto/operation-outcome.ts` 与 `src/adapters/orca-cli/**`（除测试引外不改）。

升级条件（必须停下来询问或上报）：

- 前驱尚未 archive，或 `openspec/specs/` 中缺少前驱 capability 的主规格；
- M0 交付的 `ExecutionBackend` / `OperationOutcome` / `OperationRef` 形状与第 1 节冻结接缝不一致；
- `doctor` 的 M0 门禁结论不是通过；
- `node:sqlite` 在本机无法完成所需事务或唯一约束行为；
- 需要修改本 change 已批准的初始 schema、`AGENTS.md`、`CONTEXT.md`，或需要在共享状态里保存可重建事实；后继 change 通过版本化 migration 扩展 schema 不属于本条；
- 需要新增运行时依赖。

## 8. 验收 Agent 授权与限定审计

授权范围：本 change 允许新增与修改的文件清单，以及上表全部测试文件；验收可运行 `pnpm typecheck`、`pnpm lint`、`pnpm test`。

保护边界（需要上报而非自行决定）：`scope.revision` 的推进语义、三项唯一约束、Runtime Lease 过期不释放 claim 与 Execution Coordination Lease 的规则、intent 未决时的 lane 阻塞粒度。

限定审计标签：`@M1-CAS-NO-OVERWRITE`（并发写入不出现静默覆盖）、`@M1-LEASE-FENCE`（旧 fencing generation 写入一律被拒）、`@M1-INTENT-SAME-ID`（未决 intent 对账不出现换 ID 重试）。
