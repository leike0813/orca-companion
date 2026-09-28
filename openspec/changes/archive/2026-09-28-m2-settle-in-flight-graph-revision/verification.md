# Verification

## 验收对象

- Change：`m2-settle-in-flight-graph-revision`
- 输入实现 HEAD：`c392e8de9fa0d643b586332a3bb2f00cff1f4e0b`（实现位于未提交工作区）
- 最终验收 HEAD：`c392e8de9fa0d643b586332a3bb2f00cff1f4e0b`
- 验收 Agent：Codex（GPT-6）

## 结论

**PASS**。7/7 项任务、2 条 Requirement、7 个 Scenario 与 IP-01～IP-05 均有实现和验收证据；限定审计已完成。验收中发现并修复了“修订必须改变规格内容摘要”的额外要求：图契约变更而规格内容不变时，Planner 仍可重新准入并重跑角色链。本轮没有重新启动真实 Orca 夹具；真实链路结论依据已有的隔离运行 `e2e48` 与 `e2e63`。

## 核验与修复证据

| Requirement / Scenario / IP-ID | 证据或命令 | 结果 |
|---|---|---|
| 在途 Graph Patch 修订／旧 Worker 仍在途／IP-03 | `src/application/execution/advance-execution.ts:377`；`tests/application/advance-execution.test.ts:944` | 已签发旧绑定未结算或 Worker 不可核验时不派发 |
| 旧派发结清后重跑 Planner／IP-02、IP-03 | `src/application/execution/revision-service.ts:196`、`src/bootstrap/foreground-planning-runtime.ts:4296`；`tests/application/advance-execution.test.ts` | 同一持有续办，Planner 许可有界 |
| 新规格准入并结算／IP-01、IP-02、IP-03 | `src/bootstrap/foreground-planning-runtime.ts:5297`、`src/adapters/storage/coordination-store.ts:5646`；`docs/orca-compatibility.md:126` | 真机 `e2e63`：持有 released、修订额度 1、新角色链结算 |
| 准入失败或额度耗尽／IP-01、IP-02 | `src/application/execution/revision-service.ts:331`、`src/adapters/storage/coordination-store.ts:5691`；`tests/coordination-store.test.ts:2273` | 事务内拒绝越额；持有不释放 |
| 重启后继续同一次修订／IP-03、IP-05 | `docs/orca-compatibility.md:126`；`tests/tui/pty-execution.test.ts:1800` | 真机 `e2e63` 重启后身份不变；本轮未重跑真实 PTY |
| 旧 Validator 已通过／IP-04 | `src/application/execution/execution-view.ts:434`、`src/bootstrap/foreground-planning-runtime.ts:5153`；`tests/application/execution-view.test.ts` | pending 无推进证据，released 只认持有之后签发的绑定 |
| 新角色链完成／IP-04、IP-05 | `docs/orca-compatibility.md:116,126`；`tests/tui/pty-execution.test.ts:1623` | 真机 `e2e48` 退场、`e2e63` 修订均为 `deliverable`，受控集成有持久事实 |
| 内容版本相同的修订／D3、D4、IP-04、IP-05 | `src/application/execution/execution-view.ts:434`；`tests/application/execution-view.test.ts:1123`；`tests/tui/pty-execution.test.ts:1635` | 旧角色证据仍被隔离；已删除真实 PTY 测试中与设计相反的版本差异断言 |
| 本轮命令 | 相关 Vitest 6 文件；`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`、`openspec validate m2-settle-in-flight-graph-revision --strict`、`git diff --check` | 修复前相关 Vitest 129 passed / 4 skipped；全量 1262 passed / 12 skipped。修复后相关 Vitest 61 passed / 1 skipped，typecheck、lint、build、OpenSpec validate、diff check 均通过。真实集成文件因未提供隔离项目和专用身份而跳过；沿用已有 `e2e48`/`e2e63` 证据 |

验收阶段修复：`src/domain/task-contract.ts` 删除要求 Planner 强行改变内容摘要的指令及仅为此存在的选项；`src/bootstrap/foreground-planning-runtime.ts` 删除该选项的传递并修正结算说明；`src/application/execution/revision-service.ts` 修正过时注释；`tests/tui/pty-execution.test.ts` 删除错误的版本差异断言；`tests/application/advance-execution.test.ts` 修正注释。原有 `tests/application/execution-view.test.ts:1123` 已覆盖内容版本相同的角色证据隔离，无需重复增加测试。

## 限定审计

| 范围 | 结论与证据 |
|---|---|
| 旧结果越权 | `currentContractSettlements` 被执行投影和宿主集成资格共用；持有期间返回空，释放后按本次持有登记时间筛选绑定。见 `src/application/execution/execution-view.ts:434`。 |
| 幂等与预算事务 | `release-revision-hold` 在同一事务核对来源、接纳版本、授权引用及额度；同源同版本重放不重复扣额。见 `src/adapters/storage/coordination-store.ts:5646`。 |
| Session / Run / Generation 绑定 | `src/bootstrap/foreground-planning-runtime.ts:620,3090,6490` 的物化绑定、精确 Session Segment 与执行权威检查；真实 `e2e63` 重启事实见 `docs/orca-compatibility.md:126`。 |
| 共享文件与用户改动 | 开始前 `git status --short` 显示本 change 及执行 TUI 的未提交文件；本轮未覆盖现有改动，未创建 Git worktree。 |

## 后续注意事项

- 正常执行的集成投影与持久 Git Operation 存在既有差异；本 change 的真实验收按持久事实判读，见 `docs/orca-compatibility.md:117`。
- 真实 Orca 验收曾遇到 Delivery 不结算和会话丢失后的保守阻塞；这两种情形未被当作交付成功，见 `docs/orca-compatibility.md:125-126`。
