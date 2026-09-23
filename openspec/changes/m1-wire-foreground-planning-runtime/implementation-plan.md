# Implementation Plan

## 1. 实施基线与权威来源

- **基线模式**：`predecessor-contract`；规划 commit `76906d010c8b5e6b9122664eb2893604fd83e8d1`。直接前驱 `m1-evolve-execution-graph` 已归档；apply 前确认其主规格存在、记录实际 HEAD，并保留当前 `m2-deliver-planning-tui` 的未提交改动。后者的已实现 UI 不是本 change 的代码基线权威。
- **冻结接缝**：IC-03 `ScopeRecord`/`initialize-scope`/schema 9，IC-04 `CoordinatorSessionState` v1/`admitWakeBatch`/`startCoordinatorRuntime`/`buildCoordinatorGraph`，IC-05 `initializeCoordinationScope`/`PlanningToolServices`/`planning-handoff`，IC-11 `ControllerService` 命令与事件、IC-12 TUI ports。实施首步核对这些符号与 `docs/interface-contracts.md`；不匹配即返回规划。
- **权威**：Git 提供当前 common dir/full ref/canonical worktree；项目 `orca-companion.json` 提供配置与上限；tracker 提供 Route Map/票据；IC-03 提供 Scope 注册绑定、规划 tracker intents/已用次数、交互和 lease；IC-04 提供 Session 消息/工具/压缩；Orca 提供其运行事实。
- **范围**：本 change 的五份 delta spec 与设计 D1–D10；`m2-deliver-planning-tui` 的 UI/P TY 收尾仍由该 change 验收。`package.json` 已有 `typecheck`、`lint`、`test`、`build`；使用现有 Zod/LangGraph/Vitest，不加依赖。

## 2. 复用与接缝

| IP-ID | 现有或前驱文件与符号 | 复用方式 | 禁止复制的事实 |
| --- | --- | --- | --- |
| IP-01 | `resolveGitCommonDir`、`ScopeRecord`、`initializeCoordinationScope`、`schema.ts` | 用当前 Git 身份核验后登记不可变 Scope 绑定；schema 只追加 v10 | 不缓存 HEAD、dirty paths 或复制 Git 状态 |
| IP-02 | `startCoordinatorRuntime`、`renewRuntimeLease`、`assertFencingGeneration`、`createControllerService`、`createGhTracker` | Bootstrap 单点装配、按需 Session lease 与心跳 | 不新建第二 Runtime 状态机或 UI 直连 store |
| IP-03 | `admitWakeBatch`、`answerPendingInteraction`、checkpoint store | 用户消息在 checkpoint 中一次落盘；回答在 IC-03 单事务解决 | 不用进程内队列充当消息权威 |
| IP-04 | `planningToolset`、`buildCoordinatorGraph`、`toDurableMessage`、`buildBoundedModelInput` | 增加受控 tools 节点和真实 ToolMessage 历史 | 不让模型指定 OperationId 或直接调用 tracker |
| IP-05 | `compactWithNativeFirst`、`switchModelConfiguration`、`ControllerSnapshot.compaction` | Session 手动维护与当前配置切换 | 不复制上下文或 provider 凭据 |
| IP-06 | `prepare/review/cutoverPlanningHandoff`、`deriveContextCapsule` | 宿主读取 map/plan/Capsule/Target 真实输入 | 不由界面猜 revision 或伪造 Capsule |
| IP-07 | `ControllerNotification`、TUI reducer、M2 artifacts | 发布带 owner 的语义事件并更新合同/M2 接缝 | 不建持久通用事件 inbox |

## 3. 代码变更映射

| IP-ID | Task | Requirement/Scenario | 文件与符号 | 精确变化 | 不得改变 |
| --- | --- | --- | --- | --- | --- |
| IP-01 | 1.1–1.2 | 配置不可用、当前分支没有匹配 Scope；branch-state 四场景 | 新建 `src/bootstrap/project-config.ts`；修改 `src/application/ports/branch-coordination-store.ts`、`src/application/planning/initialize-scope.ts`、`src/adapters/storage/{schema,coordination-store}.ts`、`src/bootstrap/composition.ts`；新建 `tests/bootstrap/project-config.test.ts`、`tests/coordination/scope-binding.test.ts` | Zod v1 配置、Git 身份查询、Scope immutable binding、schema 10、旧记录显式 CAS 绑定、唯一 full ref；`pending_interactions.answer_text` 同版迁移 | 不自动从 cwd 绑定旧 Scope，不写当前 Git 工作状态 |
| IP-02 | 2.1 | Foreground Runtime 的租约失效、渲染不触发动作 | 新建 `src/bootstrap/foreground-planning-runtime.ts`、`tests/bootstrap/foreground-planning-runtime.test.ts`；修改 `src/bootstrap/{coordinator-runtime,tui-composition,tui-entry}.ts` | 解析配置与 tracker/model、核验后按需启动 Session、10 秒 heartbeat、fenced 后停写、退出清理；真实 TUI ports 委派给 ControllerService | 不在组件 render/effect 创建模型恢复；不启动后台进程 |
| IP-03 | 2.2–2.3 | User message admission 两场景；回答保留正文并绑定交互 | 新建 `src/application/coordinator/user-message.ts`、`tests/application/user-message.test.ts`；修改 `src/application/coordinator/{actionable-work,wake-admission}.ts`、`src/application/coordination/pending-interaction.ts`、`src/application/controller-service.ts`、`src/adapters/storage/{checkpoint-store,coordination-store}.ts`、`src/interfaces/tui/ports.ts`、`src/bootstrap/tui-composition.ts` | `submissionId`、原子消息/WakeBatch、跨库 admission 修复、Pause/Cancel 门；`answer:string` 与 interaction 正文同事务 CAS，回答源可唤醒模型 | stale 回答零写入；普通消息不解决 interaction |
| IP-04 | 3.1–3.2 | Durable tool-call execution 三场景 | 新建 `src/workflow/coordinator/tool-node.ts`、`tests/workflow/coordinator-tool-loop.test.ts`；修改 `src/workflow/coordinator/{graph,nodes,state,planning-tools,context}.ts`、`src/domain/coordinator/session-state.ts`、`src/adapters/storage/checkpoint-store.ts`、`src/bootstrap/foreground-planning-runtime.ts`；调整既有 `tests/workflow/{coordinator-graph,planning-tools,context-maintenance}.test.ts` 与 `tests/domain/coordinator-session-state.test.ts` | v2 durable entry/旧版读迁移；model→tools→model；保存内部 OperationId、逐 call 配对结果和真实 ToolMessage；沿用原 ID 对账；100 次连续调用 | 不重启整张图、不复制业务状态机、不扩大工具权限 |
| IP-05 | 4.1 | Explicit Session compaction 两场景；现有模型切换 requirement | 新建 `src/application/coordinator/compact-session.ts`、`tests/application/compact-session.test.ts`；修改 `src/bootstrap/foreground-planning-runtime.ts`、`src/application/controller-service.ts`、`src/adapters/storage/checkpoint-store.ts`、`src/domain/coordinator/session-state.ts` | 挂起时手动压缩、持久化最近 outcome、snapshot 投影、耗尽门；从 D1 配置装配原有模型切换用例 | 不丢完整历史，不自动切换模型/Session |
| IP-06 | 4.2 | Planning handoff 的 Capsule 不能生成；现有三阶段交接 | 新建 `tests/bootstrap/planning-handoff.test.ts`；修改 `src/bootstrap/foreground-planning-runtime.ts`、`src/bootstrap/tui-composition.ts`、`src/interfaces/tui/ports.ts` | Target 来自显式 Session 选择；map/plan/graph/Capsule 从权威读；prepare/review/cutover 委派既有用例 | 不在失败时转移责任，不造计划 revision |
| IP-07 | 5.1 | Session-owned semantic events 两场景；合同同步 | 新建 `tests/application/controller-events.test.ts`；修改 `src/application/controller-service.ts`、`src/bootstrap/foreground-planning-runtime.ts`、`src/interfaces/tui/{app.tsx,state.ts}`、`docs/interface-contracts.md`、`README.md`、`openspec/changes/m2-deliver-planning-tui/{proposal,design,implementation-plan,tasks}.md` | 带 Scope/Session owner 的事件、噪声过滤、对应 Session 未读；更新 IC-03/04/11/12 与 M2 前驱/Home/能力接缝、说明配置格式 | 不提前勾选 M2 4.3/4.4，不改主规格或用户既有 UI 逻辑 |

## 4. 调用与副作用顺序

1. `Home` 查 Git common dir、完整 symbolic ref、top-level/canonical worktree → 查 IC-03 Scope 绑定；无匹配进入向导，旧未绑定记录进入显式迁移 Review，冲突/非 canonical/detached 阻塞。向导核验配置、tracker、Orca 与模型后调用已有 `initializeCoordinationScope`，bootstrap writer 在单事务创建 Scope/Cycle/Session 与绑定。
2. 恢复 Session：配置核验 → `startCoordinatorRuntime` 取得 lease → 读 checkpoint/未决 intent → 启动心跳与有界 Actionable Work 投影 → WakeBatch 同步提交 → source admission → LangGraph invoke。无工作 suspend；heartbeat 不推进 Scope revision。
3. 普通消息：验证 Scope/Session/控制状态 → checkpoint 原子写 `submissionId` 对应 entry+WakeBatch → IC-03 source admission → 若未暂停则模型 invoke。崩溃后先按相同 ID 修复 admission；不可恢复 checkpoint 或 fenced 则阻塞。待答回答先用 interaction ID/revision 校验，再单个 IC-03 CAS 写正文与 solved 状态；结果从 Branch 投影为工作。
4. 模型响应：完整返回后保存 assistant step、每个 call 的可信 OperationId → tools 节点串行重新准入并调用应用 handler → 每条结果以 `toolCallId` 保存 → 再次模型调用。`unknown` 停在原 mutation lane，对账后续行；重启先读已提交 call/result/intent，缺结果只对原 ID 核验。
5. `/compact`、模型切换和规划交接都由 Controller 命令在 lease/fencing 下执行；压缩产物与 outcome 属 checkpoint，模型绑定属配置+Session registry，交接提案属 IC-03。成功提交并读回后才发布语义事件；订阅无回放保证，刷新快照即可重建显示状态。

## 5. Schema、状态与持久化落实

- `coordination.sqlite` schema 9→10 只追加列、索引与受控 `bind-scope-identity` command；`full_branch_ref`/`canonical_worktree_path` 对旧行 nullable，对新行必填；唯一索引保护同一 common dir 的完整 ref。`answer_text` 仅在回答 CAS 成功时落到对应 interaction，旧记录维持 null。业务 revision 只在实际共享事实变更时推进。
- `CoordinatorSessionState` v1→v2：按既有 step 顺序迁移旧 assistant entry；新增 `entryId`、tool call 可信 OperationId、tool result 配对字段与 `lastCompactionOutcome`。`CHECKPOINT_SCHEMA_VERSION` 是 SQLite 内部格式，只有实际表结构变化才升；Session payload 版本单独校验。两个库不伪装原子提交。
- 所有用户输入与外部 JSON 在边界校验；配置密钥只可为引用。消息文本有有限大小，空白消息拒绝；同 `submissionId` 内容不同拒绝。`OperationId` 来自提交 assistant step 的宿主生成值；同 call 重放只核验原 intent/receipt。工具 `rejected` 作为配对结果可返回模型，`unknown` 停住并保留对账，损坏/错配阻塞。
- 规划写入剩余额度从项目上限减去该 Scope 的 distinct tracker mutation Operation Intent 数目；`unknown` 计入已用，重试同一 ID 不重复消耗，任何新 ID 在额度耗尽时拒绝。此额度不写第二份计数器，也不复用 Execution Authorization 预算。
- 事件是进程内已提交事实通知，不是审计日志或权威源；启动与订阅后通过快照恢复。项目配置变更不静默改现有 Session 绑定；切换须走受控用例。

## 6. 验收证据矩阵

| Requirement/Scenario | IP-ID | 测试文件 | Fixture/前置条件 | 关键断言 | 可运行命令 |
| --- | --- | --- | --- | --- | --- |
| Versioned project configuration / 当前分支没有匹配 Scope、配置不可用；branch-state / 全部四场景 | IP-01 | `tests/bootstrap/project-config.test.ts`、`tests/coordination/scope-binding.test.ts` | 临时 Git worktree、schema 9 旧库、多个 Scope | 精确 ref 命中、无猜测迁移、唯一约束、拒绝凭据值 | `pnpm exec vitest run tests/bootstrap/project-config.test.ts tests/coordination/scope-binding.test.ts` |
| Foreground Runtime / 租约失效、渲染不触发动作 | IP-02 | `tests/bootstrap/foreground-planning-runtime.test.ts`、`tests/tui/no-side-effect.test.tsx` | fake model/store/clock，已有 TUI 测试 | 续约、fencing 停写、挂起进程仍可查、重绘无副作用 | `pnpm exec vitest run tests/bootstrap/foreground-planning-runtime.test.ts tests/tui/no-side-effect.test.tsx` |
| User message admission / 提交后崩溃、普通消息不回答交互；回答保留正文并绑定交互 | IP-03 | `tests/application/user-message.test.ts`、`tests/application/controller-service.test.ts` | 两库故障注入、stale interaction | 同 ID 一次消息/唤醒、崩溃补齐、回答 CAS 原子、stale 零写入 | `pnpm exec vitest run tests/application/user-message.test.ts tests/application/controller-service.test.ts` |
| Durable tool-call execution / 全部三场景 | IP-04 | `tests/workflow/coordinator-tool-loop.test.ts`、`tests/workflow/planning-tools.test.ts` | fake model 的 100 个不同 call、response/tool 崩溃点 | 工具真实执行、ToolMessage 配对、原 OperationId 对账、无低 step 误停 | `pnpm exec vitest run tests/workflow/coordinator-tool-loop.test.ts tests/workflow/planning-tools.test.ts` |
| Explicit Session compaction / 手动压缩成功、压缩不能收敛；模型切换 | IP-05 | `tests/application/compact-session.test.ts`、`tests/workflow/context-maintenance.test.ts` | v1/v2 checkpoint、过窗历史 | 结果重启可见、历史保留、耗尽阻止调用、切换只在 suspended | `pnpm exec vitest run tests/application/compact-session.test.ts tests/workflow/context-maintenance.test.ts` |
| Planning handoff / Capsule 不能生成 | IP-06 | `tests/bootstrap/planning-handoff.test.ts` | fake tracker/Session、缺 Capsule/过期 revision | 失败不转责任、Target 显式选择、成功走三阶段 | `pnpm exec vitest run tests/bootstrap/planning-handoff.test.ts` |
| Session-owned semantic events / 非当前 Session 收到结果；渲染不触发动作 | IP-07 | `tests/application/controller-events.test.ts`、`tests/tui/session-picker.test.tsx` | 两 Session、事件与噪声混合 | 只标对应未读、不抢 composer、噪声过滤 | `pnpm exec vitest run tests/application/controller-events.test.ts tests/tui/session-picker.test.tsx` |
| 全部 Requirements 与现有回归 | IP-01–07 | 全套 | 本机，无真实用户项目 mutation | 类型/lint/test/build 与 change 严格验证全绿 | `pnpm typecheck && pnpm lint && pnpm test && pnpm build && openspec validate m1-wire-foreground-planning-runtime --strict` |

## 7. 文件清单与升级条件

**新增**：`src/bootstrap/{project-config,foreground-planning-runtime}.ts`、`src/application/coordinator/{user-message,compact-session}.ts`、`src/workflow/coordinator/tool-node.ts`，及第 6 节列出的八个新测试文件。**修改**：第 3 节各 IP-ID 明列的现有文件，以及合同、README、M2 artifacts。**删除**：当全部对应端口真实可用时，删除 `src/bootstrap/tui-capability-gaps.ts` 中已解决的占位分支；剩余执行阶段控制 gap 保留并明确归 M2 第二项。**保护**：`references/orca`、`openspec/specs/`、无关 change 与用户未提交的其他实现。

升级条件：前驱或符号漂移；需新公开字段、额外 migration、依赖或文件超出本表；旧 checkpoint 无法唯一迁移；真实 tracker/Orca 缺失既有用例要求的能力；全量门禁存在无法区分的新旧失败。先复现并更新设计/合同，再实施，不在 adapter 中私加语义。

## 8. 验收 Agent 授权与限定审计

验收可修改第 3 节列出的实现、测试与文档；可在显式隔离的临时 Git 项目使用 fake tracker/模型。必须定向审计 `scope-identity`（branch/canonical 绑定与旧库）、`wake-idempotency`（两库崩溃点）、`tool-side-effect`（call/result/OperationId 对账）、`fencing`（续约失败）、`answer-cas`（stale 零写入）和 `history-migration`（v1 读取）。真实 MiniMax/PTY Handoff 属 M2 4.3，不以本 change 的 fake 验证替代。实施完成后固定 checkpoint 供 verification agent 核验；apply 不提前写 `verification.md`。
