# Implementation Plan

## 1. 实施基线与权威来源

- 模式：`predecessor-contract`；规划 HEAD：`e774b5ab97aa103d1f3c160cd9c5e3d34413551e`。
- 直接前驱：`openspec/changes/archive/2026-09-29-tui-debug-workbench-and-ui-migration/`（已归档）。
- 冻结接缝（实施前核对，漂移即回到规划）：`src/interfaces/tui/app.tsx` 的 `TuiApp`/`submit`/`requestExit`、`src/interfaces/tui/ports.ts` 的 `TuiPorts`/`TuiIntent`、`src/interfaces/tui/state.ts` 的 `TuiState`/reducer、`src/application/controller-service.ts` 的 `ControllerQuery`/`ControllerCommand`、`src/application/coordinator/runtime-guard.ts` 的 `CoordinatorSessionRecordPort`、`src/adapters/storage/checkpoint-store.ts` 的 `CheckpointStore`/`CheckpointWriteResult`、`src/application/coordination/pending-interaction.ts` 的 `answerRefFor`、`scripts/tui-preview.mjs` 的假端口 fixture、`tests/tui/harness.ts`。
- 权威：IC-11（`controller-service.ts`）拥有查询/命令/事件；IC-12（`view-model.ts`、`src/interfaces/tui/`）拥有展示 DTO 与输入上下文；IC-04 拥有会话历史；本 change 新登记的 IC-13 拥有 UI 输入持久化。设计决策见本 change `design.md` D1–D14。

## 2. 复用与接缝

| IP-ID | 现有或前驱文件与符号 | 复用方式 | 禁止复制的事实 |
|---|---|---|---|
| IP-01 | `src/application/ports/` 现有端口风格、`node:sqlite` 既有用法、`src/interfaces/tui/state.ts` 的 `drafts` | 按现有 port/adapter 分层新增 UI 输入端口与 adapter；保护模块复用 `UiDraft` 与 state 草稿语义 | 不复制业务状态机、不新增第二套命令目录 |
| IP-02 | `checkpoint-store.ts` 的 append/read、`userEntryId`、`pending-interaction.ts` 的 `answerRefFor`、`controller-service.ts` 的 query/command 联合 | 在同一 canonical path 增加 append seam 与只读查询分支 | 不改 `pending.shift` 路由、不加消费字段、不做双格式兼容 |
| IP-03 | `TuiApp.submit`/`requestExit`、`WorkspaceActions`、`Composer`、`COMMAND_IDS`、`usePaste` | 复用现有提交/退出/命令路径，接入保护模块与端口 | 不重写输入路径、不提前改完整编辑或键位归属 |
| IP-04 | `tui-composition.ts`、`foreground-planning-runtime.ts` 的 `execute`、`tui-entry.ts`、`scripts/tui-preview.mjs`、`tests/tui/harness.ts` | 宿主补齐 scope/writer 与 required 端口，恢复流程在 bootstrap 生命周期执行 | 不让界面构造 scope/身份、不在 effect 持久化 |
| IP-05 | `openspec/config.yaml` 验证规则、现有 Vitest 与 PTY 入口 | 复用既有命令与隔离 PTY | 不新增第二套运行器、不做整屏 snapshot 门禁 |

## 3. 代码变更映射

| IP-ID | Task | Requirement/Scenario | 文件与符号 | 精确变化 | 不得改变 |
|---|---|---|---|---|---|
| IP-01 | 存储端口与 adapter | `tui/input-protection` 全部 6 个 Requirement | 新增 `src/application/ports/ui-input-store.ts`、`src/adapters/storage/ui-input-store.ts` | 实现 D3/D4 契约：each-record key、CAS + tombstone、`read/list/write/remove`，宿主持有 adapter `close`、32 MiB/256 条、`invalidRecords` | 不打开其他 store、不做通用 KV 平台、无 migration |
| IP-01 | 保护模块与管理组件 | 持久化与隔离／合并保存／提交快照／并发与容量／记录管理 | 新增 `src/interfaces/tui/input/input-protection.ts`（仅经 `UiInputStore` 同步事务读写）、`src/interfaces/tui/components/input-record-manager.tsx` | 250 ms 编辑 timer、立即保存时机、slot dirty 保护、lane 状态机、冲突记录、append-only cursor=`text.length`、`/inputs` overlay 最多 20 行 + 正文局部有界滚动 | 不在 effect 持久化或发送、不改回答键位、不做完整编辑 |
| IP-02 | 提交核验用例 | `权威提交核验` 四值结果、回答引用、重启先核验 | 新增 `src/application/coordinator/submission-status.ts`；改 `src/application/coordination/pending-interaction.ts` 的 `answerRefFor` | `SubmissionQuery`/`SubmissionStatus`；消息按 `userEntryId`，回答按 `JSON.stringify([interactionId, submissionId])`；复用既有 `answerRef` 列 | 不改 Pending Interaction 存储列、不把已关闭问题当成功 |
| IP-02 | checkpoint 追加 seam | `coordinator/session-runtime` 的 Committed model step | `src/application/coordinator/runtime-guard.ts`（`CoordinatorSessionRecordPort` 增 `appendModelStep`/`appendToolResult`）、`src/adapters/storage/checkpoint-store.ts`、`src/workflow/coordinator/nodes.ts`、`src/workflow/coordinator/tool-node.ts` | 追加方法复用既有读取最新 core 的写入事务，校验稳定条目身份，复用 `CheckpointWriteResult`（成功与幂等重放均 `saved`） | 不改 `pending.shift`、不加 `completedWorkSource` 或兼容分支、不改消费字段 |
| IP-02 | 控制器查询/命令 | `coordination/scope-control` 的 ControllerService 接缝 | `src/application/controller-service.ts` | `ControllerQuery` 增 `submission-status`，`SendSessionMessageCommand` 必填 `submissionId`，`AnswerPendingInteractionCommand` 增必填 `submissionId` | façade 不打开 store、不调用 Orca、不拥有状态转换 |
| IP-03 | TUI 输入接线 | `tui/planning-workspace`／`tui/session-interactions`／`tui/execution-control` | `src/interfaces/tui/ports.ts`、`state.ts`、`app.tsx`、`components/composer.tsx`、`components/control-bar.tsx`、`components/command-palette.tsx`、`screens/workspace.tsx` | `TuiPorts` 增 required `inputStore`/`submissionStatus`；每 Session 草稿读写保护模块；提交先写快照再 execute；严格 slash 分类；`usePaste` 只插入；Exit 前保存失败默认留下；`/inputs` 经 Command Palette 打开并由 workspace 渲染 overlay | composer/回答键位归属、全局键、Scope 级语义、零渲染副作用 |
| IP-04 | 宿主与预览接线 | 提交身份接线、恢复 lifecycle、管理入口 | `src/bootstrap/tui-composition.ts`、`foreground-planning-runtime.ts` 的 `execute`、`tui-entry.ts`、`scripts/tui-preview.mjs` | 界面生成 `submissionId` 并随 intent 传入宿主；宿主只补齐 scope/writer 并注入 `inputStore` 与 `submissionStatus`；启动恢复清理 accepted pending（非 React effect）；预览注入假端口 | 宿主不生成 `submissionId`、界面不构造 scope/身份、预览不加载真实后端、`doctor` 不加载 UI |
| IP-04 | 文档与合同 | 全部 | `CONTEXT.md`、`docs/architecture.md`、`docs/interface-contracts.md`（登记 IC-13）、`AGENTS.md` | 更新输入存储归属、依赖方向与 UI 窄端口说明 | 不写成既成事实、不重复 CONTEXT.md 术语 |
| IP-05 | 验证与限定审计 | 全部 | 本 change `tasks.md` | 运行 typecheck/lint/build/相关 Vitest/`openspec validate --strict`/`git diff --check`，真实 PTY 用隔离 tmux | 不提前创建 `verification.md`、不做整屏 snapshot |

## 4. 调用与副作用顺序

1. 编辑：用户按键 → 保护模块更新内存 slot 并启动/重置 250 ms timer → 到期或立即保存触发点经 `UiInputStore.write` 事务写入（CAS）。
2. 提交：界面生成 `submissionId` → 用户回车 → 校验 slash 分类 → 若该 Session 已有 `awaiting`/`unknown` lane 则拒绝新提交 → `write` 独立 submission 记录（含 `submissionId` 与 binding）→ 把该身份随 intent 传入宿主并调用 `ports.execute` → `rejected` 时更新为 `rejected` 并释放 lane；不可核验保持 `unknown`；`accepted` 等恢复流程或用户动作删除。
3. 核验：重启或用户 verify → 只读 `submissionStatus` → `accepted` 由 bootstrap 恢复流程或用户动作删除；其余保留并如实标记。
4. 追加：模型响应/工具结果 → `appendModelStep`/`appendToolResult` 在既有最新-core 事务内校验条目身份后追加；重复身份返回 `saved`。
5. 退出：Exit/Ctrl+C → 危险态确认 → 立即保存未保存输入 → 失败则留在界面，成功或明确丢弃后退出。

## 5. Schema、状态与持久化落实

- 新 store：`orca-companion/ui.sqlite`，表 `ui_input(key, revision, value, scope_id, session_id, kind, status, bytes)` 与 seq/tombstone；写/删单事务 CAS；`bytes` 计 `text` 与 `pasteBlocks` 载荷，不含 JSON 开销。
- 状态：`UiInputValue`（`draft` / `conflict` / `submission` + `awaiting|unknown|rejected|conflict`）；`accepted` 后删除记录，`rejected`/`conflict` 保留但释放 lane。
- 不变量：界面不填 scope/身份；`submissionId` 稳定；`answerRef` 由 interaction ID 与 submissionId 派生；checkpoint 追加从最新状态；`pending.shift` 路由不变。
- 无 migration、无配置迁移、无依赖变更。

## 6. 验收证据矩阵

| Requirement/Scenario | IP-ID | 测试文件 | 前置 | 关键断言 | 命令 |
|---|---|---|---|---|---|
| 持久化与隔离／重启恢复／多 Session 隔离 | IP-01 | `tests/adapters/ui-input-store.test.ts`、`tests/tui/input-protection.test.tsx` | 临时 `ui.sqlite` | 重启后草稿/光标/粘贴载荷完整且互不串 | `pnpm exec vitest run tests/adapters/ui-input-store.test.ts tests/tui/input-protection.test.tsx` |
| 合并保存与立即保存／载入不覆盖新编辑 | IP-01/03 | 同上、`tests/tui/no-side-effect.test.tsx` | fake 时钟 | 250 ms 合并、粘贴/切 Session/退出立即；effect 无写入 | `pnpm exec vitest run tests/tui/input-protection.test.tsx tests/tui/no-side-effect.test.tsx` |
| 提交快照／单活跃提交／结果只结清原快照 | IP-01/02/03 | `tests/tui/input-protection.test.tsx`、`tests/application/controller-service.test.ts` | fake ports | 连按只一次；旧结果不清新输入；rejected 释放 lane | `pnpm exec vitest run tests/tui/input-protection.test.tsx tests/application/controller-service.test.ts` |
| 权威核验四值／回答引用／重启不自动发 | IP-02 | `tests/application/submission-status.test.ts`、`tests/application/user-message.test.ts`、`tests/application/controller-service.test.ts` | fake checkpoint/store | accepted/not-found/conflict/unverifiable 正确；他人回答不算成功 | `pnpm exec vitest run tests/application/submission-status.test.ts tests/application/user-message.test.ts tests/application/controller-service.test.ts` |
| 并发冲突／容量／删除重建／失败留内存 | IP-01 | `tests/adapters/ui-input-store.test.ts` | 两个连接 | CAS 冲突保双方；tombstone 拒旧版本；满额保留内存输入 | `pnpm exec vitest run tests/adapters/ui-input-store.test.ts` |
| 记录管理／恢复／删除／重新核验 | IP-01/03 | `tests/tui/input-record-manager.test.tsx` | fake ports | 有界列表 ≤20 行、正文局部滚动、动作正确 | `pnpm exec vitest run tests/tui/input-record-manager.test.tsx` |
| 追加 seam 不被旧快照覆盖／幂等 saved | IP-02 | `tests/adapters/checkpoint-store.test.ts`、`tests/workflow/coordinator-tool-loop.test.ts` | 现有 fixture | 等待期间受理的消息保留；重复身份 `saved` | `pnpm exec vitest run tests/adapters/checkpoint-store.test.ts tests/workflow/coordinator-tool-loop.test.ts` |
| 严格 slash／粘贴不发送／退出保护 | IP-03 | `tests/tui/input-paths.test.tsx`、`tests/tui/exit.test.tsx`、`tests/tui/session-lifecycle.test.tsx` | 现有 harness | 未知命令不发送；粘贴只插入；退出失败留界面 | `pnpm exec vitest run tests/tui/input-paths.test.tsx tests/tui/exit.test.tsx tests/tui/session-lifecycle.test.tsx` |
| 宿主 required 端口与恢复清理／预览隔离 | IP-04 | `tests/tui/host-wiring.test.ts`、`tests/bootstrap/foreground-planning-runtime.test.ts`、`tests/tui/pty.test.ts` | 现有 bootstrap fixture | 端口必填；accepted 由 bootstrap 清理；预览假端口 | `pnpm exec vitest run tests/tui/host-wiring.test.ts tests/bootstrap/foreground-planning-runtime.test.ts tests/tui/pty.test.ts` |
| 全部门禁 | IP-05 | 本 change `tasks.md` | — | 类型/lint/构建/规格有效 | `pnpm typecheck && pnpm lint && pnpm build && pnpm exec vitest run tests/tui tests/application tests/adapters && openspec validate protect-tui-input --strict && git diff --check` |

## 7. 文件清单与升级条件

新增：`src/application/ports/ui-input-store.ts`、`src/adapters/storage/ui-input-store.ts`、`src/interfaces/tui/input/input-protection.ts`、`src/interfaces/tui/components/input-record-manager.tsx`、`src/application/coordinator/submission-status.ts`、`tests/adapters/ui-input-store.test.ts`、`tests/application/submission-status.test.ts`、`tests/tui/input-protection.test.tsx`、`tests/tui/input-record-manager.test.tsx`。

修改（主）：`src/interfaces/tui/{ports.ts,state.ts,app.tsx,screens/workspace.tsx,components/composer.tsx,components/control-bar.tsx,components/command-palette.tsx}`、`src/bootstrap/{tui-composition.ts,foreground-planning-runtime.ts,tui-entry.ts}`、`scripts/tui-preview.mjs`、`tests/tui/{harness.ts,input-paths.test.tsx,exit.test.tsx,session-lifecycle.test.tsx,no-side-effect.test.tsx,host-wiring.test.ts,pty.test.ts,pty-execution.test.ts,pty-handoff.test.ts,workspace.test.tsx}`、`tests/bootstrap/{foreground-planning-runtime.test.ts,foreground-execution-runtime.test.ts,coordinator-runtime.test.ts,execution-finalizer.test.ts,planning-handoff.test.ts}`、`CONTEXT.md`、`docs/architecture.md`、`docs/interface-contracts.md`、`AGENTS.md`。

修改（后端 worker）：`src/application/controller-service.ts`、`src/application/coordination/pending-interaction.ts`、`src/application/coordinator/runtime-guard.ts`、`src/adapters/storage/checkpoint-store.ts`、`src/workflow/coordinator/{nodes.ts,tool-node.ts}`、`tests/application/{controller-service.test.ts,user-message.test.ts,model-config-switch.test.ts}`、`tests/adapters/checkpoint-store.test.ts`、`tests/workflow/coordinator-tool-loop.test.ts`。

升级条件：若 `answerRef` 需要新存储列、若 append 必须改动 `pending.shift` 或消费字段、若界面必须在 effect 内持久化才能满足行为、或若 required 端口无法由既有 fake 满足，则停止实施并回到 design/specs。保留工作区既有未提交改动，不覆盖、不回滚。

## 8. 验收 Agent 授权与限定审计

验收范围限定为 UI 输入持久化、提交身份与核验、checkpoint 追加防覆盖、严格 slash 与粘贴、退出保护、宿主接线与文档一致性、容量与冲突边界。重点核对：界面只读 effect、无自动发送、`accepted` 清理发生在 bootstrap 生命周期或用户动作、`pending.shift` 路由与消费字段未变、旧快照不覆盖并发受理消息。生产 Orca 集成、Windows、真图片输入、完整编辑与长 transcript 性能不在本变更验收范围。
