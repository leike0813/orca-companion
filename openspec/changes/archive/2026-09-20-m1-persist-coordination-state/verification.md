# Verification

## 验收对象

- Change：`m1-persist-coordination-state`
- 输入实现 HEAD：`12b8f478c95856414c6a8e78ededf8e5965287d4`（实现位于该 HEAD 之上的当前未提交工作树）
- 最终验收 HEAD：`12b8f478c95856414c6a8e78ededf8e5965287d4`（验收修复与本报告尚未提交）
- 验收 Agent：Codex（GPT-5）

## 结论

**PASS**。本结论覆盖 change 声明的 Branch Coordination Store、CAS revision、Session 注册、Runtime / Execution Coordination Lease、Operation Intent 与 `status` 只读 CLI；10/10 Requirements、23/23 Scenarios、IP-1 至 IP-9 和 11/11 tasks 均有实现与可运行证据。未发现 CRITICAL、WARNING 或 SUGGESTION，所有限定审计均已完成。

本结论不扩展到 change 明确排除的 LangGraph checkpointer、Execution Graph、Worker 生命周期、模型 loop、TUI、Windows 支持或真实 Orca 控制闭环。

### Summary

| Dimension | Status |
|---|---|
| Completeness | 11/11 tasks；10/10 Requirements；23/23 Scenarios |
| Correctness | 10/10 Requirements 与 23/23 Scenarios 均由实现和行为测试覆盖 |
| Coherence | 遵循 D1–D10、IC-01–IC-03、FLOW-01 与既定模块边界 |

### Issues

- CRITICAL：无。
- WARNING：无。
- SUGGESTION：无。

## 核验与修复证据

| Requirement / Scenario / IP-ID | 证据或命令 | 结果 |
|---|---|---|
| 只持久化不可重建的协调事实；写入可重建事实被拒绝；拆分两个存储职责；IP-2、IP-6 | `src/application/ports/branch-coordination-store.ts`；`src/adapters/storage/schema.ts:22`；`tests/coordination-store.test.ts:172`、`:191` | PASS：port 仅暴露闭合 query/transact；schema 不含 checkpoint、Git 或 Orca 事实表；未知写入 fail closed。 |
| 预期 revision 的乐观并发控制；过期 revision 被拒绝；短事务与事实一致性；IP-2、IP-6 | `src/domain/coordination/revision.ts:19`；`src/adapters/storage/coordination-store.ts:1397`；`tests/coordination-store.test.ts:140`、`:205` | PASS：`BEGIN IMMEDIATE` 内校验并推进 revision；stale writer 不覆盖已提交事实，失败整体回滚。 |
| 模式与 Planning Cycle 引用；非法模式被拒绝；控制状态不改变模式；IP-1、IP-2 | `src/domain/coordination/mode.ts:25`；`src/adapters/storage/coordination-store.ts:1052`；`tests/coordination-store.test.ts:242`、`:263` | PASS：模式为封闭联合，控制状态独立持久化。 |
| Coordinator Session 注册；多 Session 共存；跨 Scope 注册被拒绝；IP-1、IP-2 | `src/adapters/storage/schema.ts:58`；`src/adapters/storage/coordination-store.ts:1093`；`tests/coordination-store.test.ts:284`、`:307` | PASS：同 Scope 注册共存；全局 Session 唯一约束拒绝跨 Scope 归属。 |
| 副作用前先持久化意图；意图先于外部调用；重复 OperationId 被拒绝并返回既有记录；IP-3、IP-7 | `src/application/coordination/intent-service.ts:117`；`src/adapters/storage/coordination-store.ts:1173`；`tests/operation-intent.test.ts:182`、`:202` | PASS：只有 `registered` 才进入外部 mutation；重复 ID 返回既有事实且不创建第二条记录。 |
| 意图收尾与对账入口；确定结果收尾；unknown 保留未决；对账不确定时阻塞 lane；IP-3、IP-7 | `src/application/coordination/intent-service.ts:164`、`:215`、`:228`；`src/adapters/storage/schema.ts:128`；`tests/operation-intent.test.ts:225`、`:236`、`:273`、`:315` | PASS：accepted/rejected 收尾，unknown 保持 pending；结果身份不匹配被拒；未决 lane 由数据库原子唯一约束保护。 |
| Runtime Lease 生命周期与 fencing；过期接管；迟到写入拒绝；claim 保留；恢复沿用所有权；IP-1、IP-4、IP-8 | `src/domain/coordination/leases.ts:46`、`:54`、`:65`；`src/application/coordination/lease-service.ts:95`、`:138`；`tests/lease-fencing.test.ts:156`、`:178`、`:214`、`:245`、`:270` | PASS：接管递增 generation，旧/过期/释放 incarnation 无写权；心跳不推进 scope revision，长期所有权不随 Runtime Lease 过期释放。 |
| Execution Coordination Lease 唯一持有者；非持有者不得推进执行；持有者唯一；IP-1、IP-4、IP-8 | `src/adapters/storage/schema.ts:78`；`src/adapters/storage/coordination-store.ts:1028`、`:1298`、`:1362`；`tests/lease-fencing.test.ts:314`、`:423`、`:489` | PASS：数据库唯一约束与 holder 校验共同拒绝竞争者、非持有者图变更和预算消耗。 |
| status 提供只读快照；只读查询不改变状态；无 TTY 运行；IP-5、IP-9 | `src/interfaces/cli/status-command.ts:69`、`:183`；`src/bootstrap/composition.ts:107`；`tests/status-command.test.ts:186`、`:237`、`:353` | PASS：只读打开且不 migration、不续租、不对账；管道输出写 stdout，诊断写 stderr。 |
| status 输出 Scope 协调事实；输出必需字段；存储不可读或版本不符；IP-5、IP-9 | `src/interfaces/cli/status-command.ts:83`；`tests/status-command.test.ts:158`、`:218`、`:257`、`:288`、`:306` | PASS：输出 IC-12 版本化结构，只投影 open interactions；缺失、损坏、高版本库及多 Scope 歧义均非零失败，不输出空快照。 |
| IP-1 至 IP-9 与 tasks | `openspec/changes/m1-persist-coordination-state/tasks.md`；上述实现/测试映射 | PASS：11/11 tasks 完成；没有越过文件边界或新增运行时依赖。 |
| 前驱与冻结接缝 | `openspec/changes/archive/2026-09-20-m0-orca-control-baseline`；`openspec list --specs --json`；`src/application/ports/execution-backend.ts`；`src/application/dto/operation-outcome.ts` | PASS：M0 已归档，前驱主规格存在，ExecutionBackend 与三值 OperationOutcome 接缝保持不变。 |
| 定向行为测试 | `pnpm exec vitest run tests/coordination-store.test.ts tests/operation-intent.test.ts tests/lease-fencing.test.ts tests/status-command.test.ts` | PASS：4 files，38 tests passed。 |
| 全量质量门 | `pnpm typecheck && pnpm lint && pnpm test && pnpm build` | PASS：typecheck、lint、build 通过；9 files，94 tests passed，1 个显式选择的 M0 真实集成套件按环境门禁跳过。 |
| OpenSpec 与差异格式 | `openspec validate m1-persist-coordination-state --strict --json`；`git diff --check` | PASS：change valid，0 issues；差异格式检查通过。 |

验收阶段完成的修复：

- 所有普通共享写入统一要求已注册 Session 的活跃 Runtime Lease，并以 incarnation 与 fencing generation 拒绝迟到写入；仅保留 Scope/首 Session/首次 Runtime Lease 的显式 bootstrap 路径。
- `accepted` / `unknown` 的 `OperationOutcome` 必须与待收尾 intent 的 OperationId 和 target 一致，防止错误 intent 被结算。
- unresolved mutation lane 改由 SQLite partial unique index 原子保护，应用层只负责把并发约束失败投影为既有 OperationId 或 lane 状态。
- `status --json` 对齐 IC-12 顶层结构，只投影 open interactions；移除未登记的 `--scope` 选择参数。
- 复用 IC-01 branded ID，删除未登记 rejection variant、无用 helper 与 adapter 生命周期泄漏；补充数据库关闭后重开、无 lease writer、结果身份不匹配等回归测试。

## 限定审计

| 标签 | 范围与证据 | 结论 |
|---|---|---|
| `@M1-CAS-NO-OVERWRITE` | `coordination-store.ts:1397` 的立即事务/CAS；`coordination-store.test.ts:140`、`:205` 的 stale 与原子回滚用例 | PASS：并发写入不会静默覆盖。 |
| `@M1-LEASE-FENCE` | `leases.ts:65`；`coordination-store.ts:1432` 起的写入门禁；`lease-fencing.test.ts:178`、`:214`、`:453` | PASS：接管后 generation 单调递增，旧、过期或已释放 incarnation 写入均被拒绝。 |
| `@M1-INTENT-SAME-ID` | `intent-service.ts:117`、`:164`；`operation-intent.test.ts:202`、`:236`、`:273`、`:315` | PASS：重复登记与 unknown 对账沿用原 OperationId，不换 ID 重试，也不能用其它 OperationOutcome 收尾。 |

## 后续注意事项

- `node:sqlite` 在 Node.js 24 仍会输出 ExperimentalWarning；本结论只覆盖项目声明的 Ubuntu 本机基线。
- 当前实现与本报告尚未提交；归档或提交时必须保持本报告所验收的工作树内容一致。
- M0 真实 Orca 控制闭环测试需要显式隔离项目与专用身份，本次普通验收未启用该环境门禁；它不属于此 change 新增持久化行为的缺失证据。
