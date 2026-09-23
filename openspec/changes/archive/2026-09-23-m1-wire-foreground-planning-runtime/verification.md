# Verification

## 验收对象

- Change：`m1-wire-foreground-planning-runtime`
- 输入实现 HEAD：`6d4cf3245d73e5adffb3cdd03a05c8f7de3cb8bc`（实现位于此 HEAD 上的未提交工作树）
- 最终验收 HEAD：`6d4cf3245d73e5adffb3cdd03a05c8f7de3cb8bc`（验收修复仍在未提交工作树；HEAD 未变）
- 验收 Agent：Codex（本次会话）

## 结论

**PASS**，限于本 change 的前台规划合同、fake provider/tracker 和本机 Ubuntu 门禁。11/11 项任务、8/8 项 Requirement、18/18 个 Scenario、IP-01～07 均有实现与行为证据；六项限定审计已完成。M2 4.3 的真实 MiniMax/PTY 规划 Handoff 留待下游 change 验收。

| 维度 | 结果 |
|---|---|
| 完整性 | 11/11 任务；8/8 Requirement；IP-01～07 |
| 正确性 | 18/18 Scenario 对应行为测试；修复工具、回答、票据和地图写入的恢复缺口 |
| 一致性 | D1～D10、IC-03/04/11/12 与 M2 接缝已核对；无未决限定审计 |

## 核验与修复证据

| Requirement / Scenario / IP-ID | 证据或命令 | 结果 |
|---|---|---|
| Branch State：不可重建事实、双库职责、登记绑定、旧记录；IP-01 | `src/adapters/storage/{schema,coordination-store}.ts`、`tests/coordination/scope-binding.test.ts` | 4/4 Scenario；schema 9→10 与旧记录显式 CAS 绑定已验证 |
| Versioned project configuration：精确 Scope、配置不可用；IP-01 | `src/bootstrap/project-config.ts`、`tests/bootstrap/project-config.test.ts`、`tests/bootstrap/foreground-planning-runtime.test.ts` | 2/2 Scenario；拒绝缺失/无效配置与错误分支绑定 |
| Foreground Runtime：租约失效、重绘无副作用、交互正文原子保存；IP-02～03 | `src/bootstrap/foreground-planning-runtime.ts`、`tests/bootstrap/foreground-planning-runtime.test.ts`、`tests/tui/no-side-effect.test.tsx`、`tests/application/controller-service.test.ts` | 3/3 Scenario；fencing、只读渲染、stale 回答零写入及已回答交互在重启后恢复；内部回答引用不出现在 transcript |
| User message admission：提交后崩溃、普通消息不回答交互；IP-03 | `src/application/coordinator/user-message.ts`、`tests/application/user-message.test.ts` | 2/2 Scenario；同 `submissionId` 重放与 WakeBatch 修复已验证 |
| Durable tool-call execution：实际执行、提交后崩溃、连续 100 次；IP-04 | `src/workflow/coordinator/{tool-node,planning-tools,graph}.ts`、`tests/workflow/coordinator-tool-loop.test.ts`、`tests/bootstrap/foreground-planning-runtime.test.ts` | 3/3 Scenario；`unknown` 停止、原 OperationId 对账、预算耗尽时仍可恢复已提交调用、重启续完工具回合已验证 |
| Explicit Session compaction：成功、不能收敛；IP-05 | `src/application/coordinator/compact-session.ts`、`tests/application/compact-session.test.ts`、`tests/workflow/context-maintenance.test.ts` | 2/2 Scenario；结果可恢复，耗尽门阻止模型请求 |
| Session-owned semantic events：非当前 Session 收到结果；IP-07 | `src/application/controller-service.ts`、`tests/application/controller-events.test.ts`、`tests/tui/session-picker.test.tsx` | 1/1 Scenario；归属、未读与噪声过滤已验证 |
| Planning handoff：Capsule 不能生成；IP-06 | `src/bootstrap/foreground-planning-runtime.ts`、`tests/bootstrap/planning-handoff.test.ts` | 1/1 Scenario；拒绝后保留 Source 责任 |
| 工程门禁；IP-01～07 | `pnpm typecheck`、`pnpm lint`、`pnpm build`、`openspec validate m1-wire-foreground-planning-runtime --strict`、`git diff --check` | 全部通过 |
| 全量行为测试；IP-01～07 | `pnpm test` | 114 文件、1004 测试通过；4 文件、7 测试按现有条件跳过 |

验收阶段修复：

- `src/workflow/coordinator/tool-node.ts`：`unknown` 与工具异常停在未配对 call，不继续后续调用或模型；`src/workflow/coordinator/planning-tools.ts` 与宿主先以原 OperationId 对账已有 Intent，再评估新调用的预算/revision。图中的恢复工具表保留已提交调用的 handler，而模型可见工具仍受预算门控制。
- `src/bootstrap/foreground-planning-runtime.ts`：只有无 tool call 的最终 assistant 回答才结束用户工作；重启后可恢复待配对调用。已回答交互从 Branch 权威记录同步稳定引用到 checkpoint，再把完整正文送给模型；transcript 隐藏内部引用。规划事实或 Intent 查询失败时阻塞，不把读取失败当作零预算消耗或新操作。
- `src/application/planning/route-map-service.ts`：tracker 写入核验后，先写本地 claim 与地图 revision，再把 Intent 收尾为 accepted；`resolve_ticket` 用独立 map OperationId 继续第二阶段，重启时不重复释放票据。
- `tests/workflow/coordinator-tool-loop.test.ts`、`tests/bootstrap/foreground-planning-runtime.test.ts`、`tests/application/route-map-service.test.ts`：加入 `unknown` 停机、原 ID 重放、真实 checkpoint 重启、回答崩溃窗口、解决票据分阶段继续及 accepted 意图出现时本地事实已持久化的回归；定向运行 44/44 测试通过。
- `tests/tui/pty.test.ts`：生命周期用例接受当前配置门槛的结构化 `config_unavailable` 状态；真实 PTY 定向运行 7/7 通过。
- `tests/recovery/acceptance/{budget-boundaries,capsule-verdicts}.test.ts`：三次 SQLite 场景在全量并行负载下超过默认 5 秒，两项用例延长至 15 秒；单独 17/17、最终全量通过，断言未变。
- `openspec/changes/m2-deliver-planning-tui/implementation-plan.md`：移除已删除的 `tui-capability-gaps.ts` 路径，保持后续 change 接缝与实际代码一致。

## 限定审计

| 范围 | 结论与证据 |
|---|---|
| `scope-identity` | 通过：`tests/coordination/scope-binding.test.ts` 覆盖完整 ref/canonical 路径、旧库不猜绑定和存活 lease 拒绝迁移。 |
| `wake-idempotency` | 通过：`tests/application/user-message.test.ts` 覆盖 checkpoint 已写、source admission 未写时按同 ID 补齐。 |
| `tool-side-effect` | 修复后通过：`tests/workflow/coordinator-tool-loop.test.ts` 覆盖 `unknown` 停机、已配对跳过、原 OperationId 对账和 100 个不同调用；宿主重启测试覆盖待处理工作恢复。`route-map-service` 先保存本地事实再标记 accepted。 |
| `fencing` | 通过：`tests/bootstrap/foreground-planning-runtime.test.ts` 与工具回合测试覆盖续约失败、旧 generation 停写。 |
| `answer-cas` | 修复后通过：`tests/application/controller-service.test.ts`、`tests/application/user-message.test.ts` 覆盖正文和解决状态同事务、stale 零写入；宿主重启测试覆盖已回答未处理时的完整正文恢复，transcript 不显示内部引用。 |
| `history-migration` | 通过：`tests/domain/coordinator-session-state.test.ts` 覆盖 v1→v2 顺序/身份与歧义拒绝；`tests/adapters/checkpoint-store.test.ts` 覆盖持久读回。 |

## 后续注意事项

M2 的真实 MiniMax/PTY Handoff 属后续 change 的 4.3；本次只运行 fake 模型/tracker 与 PTY 生命周期测试。4 个跳过文件和 7 个跳过测试不计作真实集成证据。
