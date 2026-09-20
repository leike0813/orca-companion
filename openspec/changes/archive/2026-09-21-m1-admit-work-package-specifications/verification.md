# Verification

## 验收对象

- Change：`m1-admit-work-package-specifications`
- 输入实现 HEAD：`c0cf426cc664ed8a71261104e6d158e124e34044`（含当前工作树实现）
- 最终验收 HEAD：`c0cf426cc664ed8a71261104e6d158e124e34044`（修复位于当前工作树，未提交）
- 验收 Agent：Codex（GPT-5）

## 结论

**PASS**。13/13 项任务已完成；10/10 条 Requirement、26/26 个 Scenario 均有实现与行为证据。首次验收发现的 6 项关键缺陷和 3 项警告已在范围内修复，补充检查发现的跨主机 worktree 列举风险与 OperationId 文档漂移也已关闭。OpenSpec 严格校验、typecheck、lint 与全量测试全部通过。

| Dimension | Status |
|---|---|
| Completeness | PASS：13/13 tasks；10/10 requirements；26/26 scenarios |
| Correctness | PASS：权限、幂等、对账、路径边界、Task Envelope、质量门均有回归证据 |
| Coherence | PASS：Application 只依赖 port；三个限定审计全部通过 |

## 首次验收发现与修复

| 问题 | 修复与证据 | 结果 |
|---|---|---|
| Dispatch Candidate 未校验角色授权 | 候选事实携带 `RoleAuthorities`，按当前角色及对应预算字段在副作用前判定；增加未授权角色和无关预算耗尽用例 | PASS |
| Task binding 晚于 Worker 启动，重试可能重复建 Task | 创建 Task 后、结算 intent 与启动 Worker 前持久化 Materialization Binding；重试优先复用绑定 | PASS |
| unknown 请求仅显示 completed 时提前结算 | 没有可恢复资源结果时保持原 OperationId 与 lane 阻塞，不换 ID 重试 | PASS |
| Specification Admission 忽略 exclude 与非规范路径 | include/exclude 共同判定；拒绝绝对路径、上跳与反斜杠逃逸，同时保留目录尾斜杠语义 | PASS |
| Task Envelope 只有静态类型，没有运行时派发边界 | 增加白名单式运行时解析；身份、角色由 Controller 归因；物化时绑定已核验的实际 worktree 后序列化给 `task-create` | PASS |
| 可选 Specification Validator 未形成独立质量门 | 启用时必须先取得 validator Worker Result，失败结果阻止 admission；关闭时不额外派发 | PASS |
| Application 反向依赖 Orca adapter | 对账逻辑移到 `ExecutionBackend` port，只通过封闭 query 契约访问后端 | PASS |
| OpenSpec provider 可经符号链接越出 worktree | 使用 realpath 核验真实目标仍在真实 worktree 根目录内，并覆盖 symlink 逃逸用例 | PASS |
| revision 以计数冒充版本 | contract/tracking revision 改为内容派生的确定值，Spec Binding 继续携带完整内容摘要 | PASS |
| worktree 列举可能截断或遗漏执行主机 | 解析 `totalCount`、`truncated`、`hostScope`，物化查询使用有界高上限；覆盖范围不可证明时 fail closed | PASS |
| 设计文档误写多个 mutation 共用 OperationId | design 与 implementation plan 改为每次外部 mutation 使用独立稳定 OperationId，并明确 binding/intent 顺序 | PASS |

## Requirement / Scenario 证据

| 能力区域 | 主要实现与测试 | 结果 |
|---|---|---|
| Work Package admission 与恰好一个角色级 Task | `src/domain/dispatch-candidate.ts`、`src/application/materialize-work-package.ts`、对应 domain/application tests | PASS |
| Specification Unit、Admission、Spec Binding 与可选质量门 | `src/application/specification-admission.ts`、`src/adapters/specification/openspec/provider.ts`、对应 tests | PASS |
| Task Envelope、结构化 Worker report 与证据边界 | `src/domain/task-contract.ts`、`src/domain/worker-report.ts`、`src/application/worker-report-dto.ts`、对应 tests | PASS |
| Session Binding、liveness 与 Session Segment | `src/adapters/agents/session-binding.ts`、`src/domain/worker-liveness.ts`、Branch Coordination Store reopen tests | PASS |
| Orca 封闭操作与 worktree 覆盖事实 | `src/application/ports/execution-backend.ts`、`src/adapters/orca-cli/operation-catalog.ts`、adapter contract tests | PASS |

## 验证命令

| 命令 | 结果 |
|---|---|
| `openspec status --change m1-admit-work-package-specifications --json` | PASS：规划与 verification 工件完整，change complete |
| `openspec validate m1-admit-work-package-specifications --strict --json` | PASS：1 passed，0 failed |
| `pnpm vitest run tests/application/materialize-work-package.test.ts tests/application/specification-admission.test.ts tests/application/worker-report-dto.test.ts tests/domain/dispatch-candidate.test.ts tests/adapters/orca-cli/orca-backend.test.ts tests/orca-backend.contract.test.ts` | PASS：6 files，76 tests |
| `pnpm typecheck && pnpm lint && pnpm test` | PASS：47 files passed、1 skipped；475 tests passed、3 skipped |
| `git diff --check` | PASS |

## 限定审计

- `oracle-source-of-truth`：**PASS**。Controller 归因身份与角色；Scope include/exclude、真实 worktree 边界和 Orca host 覆盖事实均在准入处执行。
- `transaction-boundary`：**PASS**。Intent 先于 mutation；Task binding 先于 intent 结算和 Worker 启动；unknown 且无资源结果时保持 lane 阻塞。
- `permission-escalation`：**PASS**。候选角色、Task Envelope authority、规格产出角色与可选 validator 结果都在副作用或接纳前校验。

## 后续注意事项

- 本 change 按计划使用 fake backend 与 CLI contract tests 验证故障边界；真实 Orca 隔离端到端闭环由后继 M1 集成变更负责。
- 当前仅在 Ubuntu 环境验证，未据此声明其他平台已受支持。
