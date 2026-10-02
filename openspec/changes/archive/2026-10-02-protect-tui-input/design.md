## Context

现有 `TuiState` 只在进程内保存每 Session 草稿（`drafts`），提交由 `TuiApp.submit` 直接调用 `ports.execute`，`submissionId` 由宿主在 `foreground-planning-runtime` 用 `newId()` 生成，界面无法在重试时复用同一身份；本 change 改为界面生成该稳定身份并随 intent 传入宿主。`ports.ts` 的 `TuiPorts` 与 `ControllerService` 都不暴露提交核验，checkpoint port 只有整份 `saveCheckpoint`。回答 `answerRef` 目前由 `answerRefFor(interactionId)` 只按 interaction ID 派生（`src/application/coordination/pending-interaction.ts`）。本 change 在既有 IC-11/IC-12、MOD-06/07 接缝内扩展，不新建第二套状态机。

## Goals / Non-Goals

**Goals:** 用户输入跨重启可恢复；提交有稳定身份且可核验；旧 checkpoint 快照不覆盖并发受理的消息；slash 与消息严格分流；Exit 不静默丢失未保存输入；冲突与容量边界有明确、可恢复的行为。

**Non-Goals:** 完整字符/任意位置编辑与编辑视窗、粘贴块 UI 与块内查看、命令候选与统一命令目录、长 transcript 分页/虚拟化/懒加载、用户偏好配置、第二套命令别名目录、通用 UI 状态存储平台。

## Decisions

### D1 — 唯一 owner 与端口边界

UI 输入持久化的应用端口归 `src/application/ports/ui-input-store.ts`（新 IC-13），实现归 `src/adapters/storage/ui-input-store.ts`，装配归 `src/bootstrap/`。端口只暴露同步事务式读写；TUI 与组件 MUST NOT 打开数据库。`TuiPorts` 新增 required `inputStore: UiInputStore` 与 `submissionStatus: (query: SubmissionQuery) => Promise<SubmissionStatus>`。`doctor` 与无 TTY 的 CLI MUST NOT 加载 UI 或检查该 UI 库，也不新增基于该存储的启动门禁。

### D2 — canonical 存储位置

每仓库独立 `ui.sqlite`，位于 Git common dir 下 Companion 私有目录 `orca-companion/ui.sqlite`（与 `coordination.sqlite`、`checkpoints.sqlite` 同目录）。不复用、不迁移既有两个 store；无历史格式或兼容分支。

### D3 — 记录模型、key 与 CAS

每条 draft、submission 与冲突各自持有独立 key（JSON 元组字符串，避免分隔符歧义），不是每目标一条记录，因此同一目标可以同时保留当前 draft 与 pending submission：

- draft：`JSON.stringify(['draft', coordinationScopeId, coordinatorSessionId])`；回答草稿追加 `interactionId, expectedRevision`。
- submission：`JSON.stringify(['submission', coordinationScopeId, coordinatorSessionId, submissionId])`。
- conflict：`JSON.stringify(['conflict', coordinationScopeId, coordinatorSessionId, ...])`。

表 `ui_input(key TEXT PK, revision INTEGER, seq INTEGER, value TEXT, scope_id TEXT, session_id TEXT, kind TEXT, status TEXT, bytes INTEGER)`，配 tombstone（删除只把 `value` 置空并保留递增 `revision`）。**revision 按 key 单调**：写入与删除在同一 SQLite 事务内自增该 key 的 revision 并以 `expected_revision` 做 CAS，命中才写，未命中返回 `conflict`，删除后持有旧 revision 的写入必定冲突；ABA 由 per-key revision 与 tombstone 保证，不用全库单一 revision。**`seq` 全库单调**，只提供列表的稳定跨记录顺序，不参与 CAS，也不进入任何对外合同。既有记录不可解析时写入 fail closed，只能显式删除。容量按 `text` 与 `pasteBlocks` 的 UTF-8 载荷字节求和，不含 JSON 开销。

### D4 — 公共 schema

```ts
type UiMessageTarget = { kind: 'message'; coordinationScopeId: string; coordinatorSessionId: string };
type UiAnswerTarget = { kind: 'answer'; coordinationScopeId: string; coordinatorSessionId: string; interactionId: string; expectedRevision: number };
type UiInputTarget = UiMessageTarget | UiAnswerTarget;
type UiPasteBlock = { id: string; text: string };
type UiDraft = { text: string; cursor: number; pasteBlocks: readonly UiPasteBlock[] };
type UiSubmissionStatus = 'awaiting' | 'unknown' | 'rejected' | 'conflict';
type UiInputValue =
  | { kind: 'draft'; target: UiInputTarget; draft: UiDraft }
  | { kind: 'conflict'; target: UiInputTarget; draft: UiDraft }
  | { kind: 'submission'; target: UiInputTarget; draft: UiDraft; submissionId: string; status: UiSubmissionStatus; reason: string | null };
type UiInputRecord = UiInputValue & { key: string; revision: number };
type UiInputStore = {
  read(key: string):
    | { kind: 'record'; record: UiInputRecord | null; revision: number }
    | { kind: 'failed'; code: string; message: string };
  list(coordinationScopeId: string):
    | {
        kind: 'records';
        records: readonly UiInputRecord[];
        invalidRecords: readonly { key: string; revision: number }[];
        usage: { records: number; bytes: number };
      }
    | { kind: 'failed'; code: string; message: string };
  write(input: { key: string; expectedRevision: number; record: UiInputValue }):
    | { kind: 'saved'; record: UiInputRecord }
    | { kind: 'conflict'; current: UiInputRecord | null; revision: number }
    | { kind: 'failed'; code: string; message: string };
  remove(input: { key: string; expectedRevision: number }):
    | { kind: 'removed'; revision: number }
    | { kind: 'conflict'; current: UiInputRecord | null; revision: number }
    | { kind: 'failed'; code: string; message: string };
};
```

`read` 在 tombstone 上返回 `record: null` 与该 key 的当前 revision。`list` 返回该 Scope 的完整记录（总量受 32 MiB 上限约束），由 UI 只渲染有界行。adapter 的 `UiInputStoreHandle` 另外提供 `close()`，由 Bootstrap 管理生命周期。

### D5 — 保存时机与 timer 归属

保护模块只在用户编辑事件上启动约 250 ms 合并 timer，到期后经 `UiInputStore.write` 同步保存。粘贴、切换 Session、退出回答模式、正常退出与提交前固定快照都立即保存，不等待 timer。React effect SHALL 只做 readonly `read`/`list` 载入与查询；MUST NOT 在 effect 里持久写入、自动发送或恢复模型。

### D6 — slot dirty 保护

载入既有草稿与异步核验结果都写入独立 slot，并记录当前编辑 generation；只有 generation 未变化时才应用载入值，否则保留用户新输入并标记有未应用的外部版本，避免载入覆盖正在进行的编辑。

### D7 — 提交身份与 lane

普通消息与回答提交都必填 `submissionId`（界面生成，重试复用）。提交前先 `write` 一条独立 key 的 `submission` 记录（完整正文、粘贴展开、目标与回答绑定、状态 `awaiting`），再调用 `ports.execute`；`rejected` 时把该记录更新为 `rejected` 并释放 lane；不可核验或结果未知时更新为 `unknown`，继续占 lane；`accepted` 后由 D12 删除。同一 Session 同时最多一条 `awaiting`/`unknown` 提交（lane）；结果只结清原记录，不影响该 Session 的其他 draft 或另一 Session 的记录。

### D8 — 只读提交核验

新增 `src/application/coordinator/submission-status.ts`：

```ts
type SubmissionQuery =
  | { kind: 'message'; coordinatorSessionId: string; submissionId: string; content: string }
  | { kind: 'answer'; coordinatorSessionId: string; submissionId: string; content: string; interactionId: string; expectedRevision: number };
type SubmissionStatus =
  | { kind: 'accepted'; ref: { kind: string; id: string } }
  | { kind: 'not-found' }
  | { kind: 'conflict'; code: string; message: string }
  | { kind: 'unverifiable'; reason: string };
```

普通消息与回答的 `SubmissionQuery` 都必填 `coordinatorSessionId`、`submissionId` 与 `content`；回答在此基础上多出 `interactionId` 与 `expectedRevision`，没有 `answer` 或 owner 字段。

消息核验读取 checkpoint 中 `userEntryId(submissionId)` 的条目：存在且内容一致 → `accepted`（`ref` 为 `{ kind: 'user-message', id: entryId }`）；存在但内容不同 → `conflict`；不存在 → `not-found`；不可读 → `unverifiable`。回答核验读取 Pending Interaction 的 `answerRef`：`answerRef.id === JSON.stringify([interactionId, submissionId])` → `accepted`（`ref` 为 `{ kind: 'interaction-answer', id: answerRef.id }`）；被其他 submissionId 解决 → `conflict`；仍未解决 → `not-found`；不可读 → `unverifiable`。

`answerRefFor` 改为由 interaction ID 与 submissionId 共同派生（复用既有 `answerRef` 列，无 migration）。`ControllerService` 的 `ControllerQuery`/`ControllerQueryResult` 增加 `submission-status` 只读分支；生产接线必填，测试 fake 缺失时该查询返回 `unverifiable`。

### D9 — checkpoint 追加 seam

`CoordinatorSessionRecordPort` 增加 `appendModelStep` 与 `appendToolResult` 两个具体方法，二者复用 storage 侧既有「读取最新 core 后写入」的事务，在同一次写入中读取该 Session 最新已提交状态、校验稳定条目身份后追加，不另建新事务层。返回值复用既有 `CheckpointWriteResult`：成功与幂等重放都返回 `saved`，失败返回 `failed`；同一 `stepId`/条目身份重复追加不产生第二条记录。现有 commit／Wake admission 与恢复语义不变，不新增消费字段、不引入 `completedWorkSource` 或兼容分支；`nodes.ts` 与 `tool-node.ts` 从整份 `saveCheckpoint` 改为调用该 seam，`pending.shift` 路由保持不变。

### D10 — 严格 slash 分类与粘贴

composer 内容以 `/` 开头时按命令解析：命中既有 `COMMAND_IDS`/`COMMAND_LABELS` 且参数字面量合法才执行；未知命令、参数或多行格式错误保留输入并显示结构化提示；尚未接通的命令显示明确不可用，不回退发送。粘贴走 Ink `usePaste`，把全文插入光标处并立即保存，不触发发送。本批不改变现有回答入口键位（`Ctrl+A` 仍进入回答模式，完整编辑批次再统一按键归属）。

### D11 — 本批编辑边界

本批编辑 SHALL 只在末尾追加（append-only）：光标位置即 `text.length`，并与正文一起持久化，恢复时读回该属性供第二批使用；居中/任意位置编辑与真实光标渲染留待第二批。

### D12 — 恢复生命周期与非 React 持久化

Bootstrap 启动恢复流程（非 React effect）载入本仓库 pending 提交并调用 `submissionStatus` 只读核验：`accepted` 的记录在该生命周期内或由用户显式核验动作删除；`unverifiable`/`unknown` 保留待核验。React effect 只读展示与核验，可显示「已确认待清理」，但 MUST NOT 自身持久化或发送。普通消息的首次提交由用户显式回车触发；恢复流程与 effect 都 MUST NOT 自动 send。

### D13 — 记录管理入口

在 Command Palette 增加维护别名 `/inputs`（新 `CommandId`，不混入消息发送），打开 `input-record-manager` overlay：只渲染最多 20 行记录，正文用局部有界滚动查看，支持恢复、选择与删除，以及对待核验提交触发重新核验。列表本身不一次性渲染全部记录；完整记录读取仍受 32 MiB 上限约束。管理入口不打开数据库、不调用 Orca、不写业务状态。

### D14 — 容量与依赖

起始双上限为每仓库 32 MiB 内容载荷与 256 条记录，不做自动淘汰，不做后台压缩。不新增第三方依赖：SQLite 走既有 `node:sqlite` 用法，UI 走既有 Ink/React。

## Risks / Trade-offs

两个 SQLite 连接并发写同一目标时依赖 CAS 与部分唯一索引，冲突路径需要显式 UI；单活跃提交的 lane 由数据库约束保证，测试必须覆盖跨连接竞争。`answerRef` 语义变化影响既有回答核验断言，需要同步更新 `Pending Interaction` 相关测试但不改存储列。append seam 改动 workflow 两个真实生产节点，必须在不改 `pending.shift` 路由与消费字段的前提下回归 `tool-node`/`nodes`。

## Migration Plan

先落地 `UiInputStore` 端口、adapter 与保护模块，再接 `submission-status` 与 checkpoint append seam，然后接线 TUI 与 bootstrap，最后补文档与验证。无数据迁移，无依赖升级，无 Git 提交。
