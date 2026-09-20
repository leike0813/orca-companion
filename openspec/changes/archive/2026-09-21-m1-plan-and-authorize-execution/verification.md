# Verification

## 验收对象

- Change：`m1-plan-and-authorize-execution`
- Schema：`orchestrated-delivery`
- 输入实现 HEAD：`d70bc8a73717b8c7dafabf0e8234efb15a1a8997`（含修复前未提交实现工作树）
- 最终验收 HEAD：`d70bc8a73717b8c7dafabf0e8234efb15a1a8997`（含修复后未提交工作树；本轮未创建提交）
- 验收 Agent：Codex（含原生 Subagent Goodall 的只读交叉审计）

## 结论

**PASS**（2026-09-21 由 D20 真实冒烟补证解除阻塞，见文末附录）。本轮发现的实现与证据映射缺陷已全部修复；19/19 tasks、10/10 requirements 和 38/38 scenarios 均有实现/测试映射，typecheck、lint、412 项普通测试与 OpenSpec strict 校验通过。

原结论（冒烟尚未运行时）：**BLOCKED**。最终结论当时被 D20 的真实 MiniMax-M3 冒烟阻塞：`PLANNING_SMOKE`、`PLANNING_SMOKE_REPO`、`PLANNING_SMOKE_IDENTITY` 均未设置，不能在未显式选择隔离项目与专用身份时代跑该外部验证。

### Summary

| Dimension | Status |
|---|---|
| Completeness | 19/19 tasks；10/10 requirements；38/38 scenarios 有证据映射 |
| Correctness | 本地静态与行为证据通过；真实 provider 的 2 项 D20 证据已补（见附录） |
| Coherence | 模块边界、前驱、冻结接缝与设计决策一致 |

### CRITICAL（已解除）

1. `real-provider-smoke` 当时尚未执行：修复后的普通测试只能确认该文件默认跳过且不产生真实调用，不能替代真实 Context Capsule 与 prepare→review→cutover 证据。**2026-09-21 已显式提供隔离工作区与专用身份并运行任务 6.1/6.2 的命令，6/6 通过，阻塞解除（证据见文末附录）。**

### WARNING

无。

### SUGGESTION

无。

## 核验与修复证据

| Requirement / Scenario / IP-ID | 证据或命令 | 结果 |
|---|---|---|
| IP-1；Scope 模式与正交控制状态 | `tests/application/planning-mode.test.ts` | PASS |
| IP-2/IP-3/IP-4；Route Map 权威、固定章节、Planning Reference、Ticket Claim/Frontier | `tests/domain/route-map.test.ts`、`tests/domain/ticket-claim.test.ts`、`tests/application/route-map-service.test.ts`、`tests/adapters/gh-tracker.test.ts` | PASS |
| IP-5；确定性编译、失败拒绝、预算/并发上限、Graph Generation 与过期 | `tests/domain/graph-compiler.test.ts`、`tests/domain/budget-policy.test.ts`、`tests/application/graph-generation.test.ts`、`tests/application/graph-history.test.ts` | PASS |
| IP-6；Manifest 完整性、候选图严格对应、原子批准、未批准无授权 | `tests/domain/execution-authorization.test.ts`、`tests/application/authorization-service.test.ts` | PASS；含 Orca Run、Graph Generation、map/plan revision 与批准时 stale binding 回归 |
| IP-6；默认恢复上限、初始化不写执行策略、改变上限重新授权 | `tests/application/authorization-service.test.ts`、`tests/application/initialize-scope.test.ts` | PASS；证据映射已修正 |
| IP-6；策略内操作与越界操作 | `tests/domain/execution-authorization.test.ts`、`tests/application/authorization-service.test.ts` | PASS；操作 category 使用闭集，未知 category fail closed |
| IP-7；开放票据/fog/interaction/mutation/编译/批准门禁 | `tests/application/handoff-gate.test.ts` | PASS；全部 open ticket 均阻塞，map revision 取持久化 Scope 值 |
| IP-7；模式、引用与 Execution Lease 同批切换及恢复 | `tests/application/lease-handoff.test.ts` | PASS |
| IP-3；prepare/review/cutover、取消、恢复、不触碰 Worker | `tests/application/planning-handoff.test.ts` | PASS；含 candidate 从 null 变为存在的过期回归 |
| IP-3；`awaiting_user_prompt` 激活门 | `tests/application/planning-handoff.test.ts`、`tests/workflow/planning-tools.test.ts` | PASS；提示满足后 Target 只获得 handoff review 权限 |
| IP-8；工具动态暴露、调用期重验与输入边界 | `tests/workflow/planning-tools.test.ts` | PASS |
| IP-9 / D20；普通运行默认不调用真实 provider | `pnpm test`：smoke 文件跳过 | PASS |
| IP-9 / D20；真实 MiniMax-M3 Capsule + handoff | `PLANNING_SMOKE=1`、`PLANNING_SMOKE_REPO`、`PLANNING_SMOKE_IDENTITY` 显式设置后运行冒烟命令 | PASS（见附录） |
| 前驱与冻结接缝 | archive 存在；`openspec list --specs --json`；符号检索；`! rg -n 'Coordinator Profile' CONTEXT.md AGENTS.md` | PASS |
| 全量静态与行为检查 | `pnpm typecheck`、`pnpm lint`、`pnpm test` | PASS：40 files passed、1 skipped；412 tests passed、3 skipped |
| OpenSpec | `openspec validate m1-plan-and-authorize-execution --strict` | PASS |
| 工作树卫生 | `git diff --check` | PASS |

### 验收阶段完成的修复

- `handoff-gate`：门禁改为统计全部开放 Decision Ticket，不再把 Frontier 当作“开放票据清空”；地图 revision 改读 `snapshot.scope.mapRevision`。
- `manifest-integrity`：Manifest 内操作改为闭集；未知 category 需要单独授权；Worker 派发必须携带角色。
- `manifest-integrity`：提案与批准落盘统一核对 GraphId/Generation/Version、Orca Run、map/plan revision、Scope 与 Planning Cycle；批准前重新读取当前候选图。
- `planning-handoff-stage`：候选图从无到有也会使提案过期；`graphId`/`graphVersion` 必须成对出现。
- `activation-gate`：新增受限 `handoff_review` 激活结果，Target 在提示满足后只能读取与复核交接，不能修改 Route Map。
- Route Map mutation 在读取/写入 tracker 前先用调用方 `expectedRevision` 建立 Operation Intent，拒绝旧快照覆盖；完成 claim 后返回最终本地 revision。
- 规划工具 handler 补齐固定章节闭集与非空 ID/结论校验。
- `implementation-plan.md` 修正“初始化不询问恢复上限”的实际证据路径。

## 限定审计

- `scope-mode`：PASS；复用唯一 `CoordinationMode` / `ControlState`。
- `ticket-claim`：PASS；Claim 生命周期与 Frontier 投影未被 Lease/Runtime 退出改变。
- `compile-determinism`：PASS；同输入拓扑稳定，失败不产出候选图。
- `manifest-integrity`：PASS；上述 fail-open 与 stale approval 缺陷已修复并有回归测试。
- `recovery-budget`：PASS；默认 1、耗尽停止、变更需新授权。
- `handoff-gate`：PASS；全部门禁条件与持久化 revision 来源已核对。
- `planning-handoff-stage`：PASS；阶段、过期与恢复路径有行为证据。
- `activation-gate`：PASS；等待提示与受限 review 权限分离。
- `lease-handoff`：PASS；模式、图/授权引用与唯一 Lease 同事务生效。
- `real-provider-smoke`：PASS（2026-09-21 补证，见附录）。

## 后续注意事项

- 当前实现工作树未提交，HEAD 只能标识基线提交；本报告同时以当前工作树为最终验收对象。
- 解除 BLOCKED 后应把真实冒烟命令、provider profile 与通过结果补入本工件；不得记录凭据、真实密钥或非隔离项目路径。

## 附录：D20 真实 MiniMax-M3 冒烟补证（2026-09-21）

由实现侧在显式选择隔离工作区（一次性空目录）与专用身份后运行任务 6.1/6.2 的冒烟命令，结果 **6 passed / 1 skipped**；跳过项是「未开启 `PLANNING_SMOKE` 时整个冒烟被跳过且不加载端点配置」这条默认行为断言，与开启冒烟互斥。

- 命令（工作区与身份为一次性取值，按本工件要求不记录其取值）：
  `PLANNING_SMOKE=1 PLANNING_SMOKE_REPO=<isolated-workspace> PLANNING_SMOKE_IDENTITY=<dedicated-identity> pnpm exec vitest run tests/integration/minimax-m3-planning-smoke.test.ts --no-file-parallelism`
- provider profile 与模型：`anthropic`（`@langchain/anthropic#ChatAnthropic` → `/v1/messages`）、`openai`（`@langchain/openai#ChatOpenAI` → `/v1/chat/completions`）、`openai-responses`（同集成 + `useResponsesApi` → `/v1/responses`）；模型 `MiniMax-M3`。端点地址与凭据沿用 `.env.smoke`，此处不记录取值。
- 每个 profile 的两项证据均通过：
  - `generateCapsuleSmoke`：真实模型产出被提交的 message step，据此派生 Context Capsule，并由真实 provider 接受这份有界输入（前导 system 消息恰好一条）；观察输出 `capsule=` 28 / 266 / 300 字符。
  - `runPlanningHandoffSmoke`：在生产 store 路径上完成 prepare→review→cutover，Route Planning 责任落盘转移给 Target Session，`resumePlanningHandoff` 为 `cutover_done`，且 Execution Coordination Lease 与 Ticket Claim 在交接前后完全一致。
- 回归确认：未开启 `PLANNING_SMOKE` 时该文件默认跳过、不加载 `.env.smoke`、不解析端点、不发起真实调用；`pnpm typecheck`、`pnpm lint`、`pnpm test`（40 files passed / 1 skipped；412 passed / 3 skipped）与 `openspec validate --strict` 均通过。

据此本工件结论由 BLOCKED 更新为 PASS；除本条阻塞外，本报告其余维度、发现与限定审计结论均未改动。
