## Context

现有 `startCoordinatorRuntime` 只解析模型、核验能力、打开 checkpoint 并取得 Runtime Lease；`buildCoordinatorGraph` 只含 model/suspend 节点。`planningToolset` 已定义受控 handlers，却没有生产服务装配，也没有执行模型 tool calls 的图节点。`tui-composition.ts` 因此只提供只读投影。当前 Scope 记录没有 branch/worktree 注册绑定，Home 的「common dir 内唯一 Scope」规则会误接其他分支。

直接前驱 `m1-evolve-execution-graph` 已归档。本 change 扩展 IC-03/04/11/12，并以现有 M2 工作树为基线；不回滚用户改动。`initializeCoordinationScope` 已使用 `#bootstrap` writer 在一个事务里创建 Scope，无需先取得 Runtime Lease；报告所述初始化阻塞原因需在 M2 文档中纠正。

## Goals / Non-Goals

**Goals:** 使一个前台进程能从项目配置核验并恢复规划 Session；用户消息、模型工具、上下文维护、待答交互、模型切换和交接经现有应用层形成可恢复闭环；Home 精确识别 Scope；事件有 Session 归属。

**Non-Goals:** 执行 Worker 调度与 Scope 控制 UI 属 `m2-deliver-execution-tui`；本 change 不加后台 controller、headless 协议、provider 网关、新依赖、任意 shell 或新规划工具品类。

## Decisions

### D1：项目配置是唯一的长期配置源

在 canonical worktree 根目录读取用户维护、纳入版本控制的 `orca-companion.json`，由 `src/bootstrap/project-config.ts` 用现有 Zod 校验。v1 闭集字段为 `schemaVersion: 1`、`coordinatorModels: CoordinatorModelConfiguration[]`、`defaultCoordinatorModelRef: string`、`tracker: { kind: 'github'; routeMapIssueNumber: positive integer }`、`planning: { maxMutations: nonnegative integer }`、`context: { maxInputTokens: positive integer }`。配置引用唯一，默认引用必须存在；`credentialRefs` 只存名称，已知密钥字段在配置边界拒绝。`maxMutations=0` 表示规划只读；已用次数从 IC-03 中 distinct 的规划 tracker Operation Intent ID 派生，unknown 也占用一次，重启或 Replanning 不清零；不新建第二个计数器。选择 root JSON 以便项目审阅，复用现有 `createModuleIntegrationResolverAsync`、`resolveChatModel`、`createGhTracker`，不增加配置框架。缺文件、未知字段、模型解析/核验或 tracker 探测失败时向导阻塞；不生成默认配置。

### D2：Scope 保存注册绑定，Git 保存实时身份

IC-03 `ScopeRecord` 增加 `fullBranchRef` 和 `canonicalWorktreePath`；Git common dir 是存储位置，不在每行重复保存。schema 由 9 升至 10：`scope` 表新增两个 nullable 列，迁移不猜旧值；新 Scope 必填且同一 common dir 的 full branch ref 唯一。`pending_interactions` 同版增加 nullable `answer_text`，使回答正文与 CAS 解决结果同事务提交。初始化用例把当前 `git symbolic-ref --quiet HEAD` 的完整 ref、`git rev-parse --show-toplevel` 的真实路径与用户登记值一起核验并原子写入。Home 仅在当前路径恰为登记的 canonical worktree、当前 ref 匹配、非 detached HEAD 时恢复。旧未绑定记录只可在用户选定该 Scope、确认当前 canonical worktree/完整 ref、且无存活 Runtime Lease 时调用一次 CAS 绑定；重复或冲突绑定拒绝。`status` 对旧记录可只读显示 blocker。注册绑定是用户选择，不镜像 HEAD 或 dirty paths。备选的「从 common dir 选唯一 Scope」无法保证跨分支安全，舍弃。

### D3：前台宿主拥有 Runtime、Controller 和事件源

`src/bootstrap/foreground-planning-runtime.ts` 是唯一进程装配点：先加载配置并核验 Git/Orca/tracker/model，再打开可写 IC-03，初始化走既有 bootstrap writer；恢复时调用 `startCoordinatorRuntime`，为活跃 Session 每 10 秒调用 `renewRuntimeLease`（TTL 30 秒），所有命令与节点在写入前通过 `assertFencingGeneration`。续约失败立即停止本 Session 新模型调用和写入，发布 blocker；不以新 incarnation 偷偷续跑。Session 按需取得 lease，退出清理 timer、checkpoint/store 与订阅，不自动 Pause/Cancel。`createControllerService` 仍是 TUI/CLI 唯一应用入口；host 注入已有用例与只读 projection，React 不获得 store/backend。TUI 端口在 M2 收尾时消费同一宿主。

### D4：用户提交有稳定身份，先持久化再唤醒

`SendSessionMessageCommand` 增加 `submissionId`（UI 在一次提交时生成并在同一次重试中复用）；host 核验目标 Session/Scope、激活门与内容上限，为用户消息分配 durable entry。checkpoint 一次写入该消息、对应稳定 WakeBatch 与待处理标记；随后沿用 IC-04 `admitWakeBatch` 记录 source admission，再调用图。跨库中断时根据原 `submissionId`/WakeBatchId 补齐；checkpoint 已有消息则只补 admission。Pause 接受持久消息但不恢复模型；Cancel 拒绝新消息。普通消息绝不消耗 Pending Interaction。回答命令将 `answerRef` 改为 `answer: string`；应用用例先验证 interaction ID 与 expected revision，再在 IC-03 同一 CAS 事务里写入 `answer_text` 并解决该 interaction，稳定引用仍是 `pending-interaction:<id>`。回答通过新的 Actionable Work 从 Branch 权威注入模型，不把它伪装成普通 Session 消息；stale 回答零写入。备选的进程内消息队列和跨库先写回答都会留下丢答或半回答，舍弃。

### D5：工具调用由一个图节点串行处理

`buildCoordinatorGraph` 增加 `tools` 节点：完整模型响应先原子保存 `CommittedModelStep` 与其标准化 tool calls；有调用则保持当前 Actionable Work 未消费，逐个执行工具、保存配对结果，最后回到 model；只有没有未决 tool calls 的最终响应才消费工作。每个 call 必须有稳定 provider call ID、已注册名称及可校验参数；缺失时阻塞并保留历史。`planningToolset` 仍决定可见性和 handler 准入；执行时重新读取当前事实，串行避免同 revision 并发写。绑定到模型的工具 schema 不直接执行副作用。提交模型响应时 host 为每个 call 生成并一同持久化可信 `OperationId`；handler 从内部执行上下文取得该 ID，模型不提供。`unknown` 停止后续调用并等待原 ID 对账；已接受调用恢复时读取 intent/receipt 与配对 tool result，不换 ID 再做副作用。Handoff 的 `proposalId` 与 `capsuleRef` 也由宿主从此上下文和 checkpoint 生成/读取，模型只选择合法 Target。`recursionLimit=1000` 保持技术保险；用 100 个不同调用的行为测试验证，不增加另一套循环状态机。

### D6：已提交消息是会话历史唯一顺序源

`CoordinatorSessionState` 升至 v2：`committedMessages` 中每条 durable entry 有 `entryId`；tool result 带 `toolCallId` 与 `toolName`，assistant call 保存已校验的 `{id,name,args,operationId}`；另存 `lastCompactionOutcome`。`committedModelSteps` 仍仅保存完整模型响应与 usage，不镜像所有消息。`buildBoundedModelInput` 从 `committedMessages` 顺序形成片段，按对应 entry/step ID 保持 Capsule 边界；`fromDurableMessage` 对 tool entry 还原真正的 `ToolMessage`，不能当 `HumanMessage`。v1 checkpoint 在读取时按既有模型 step 顺序补稳定 entry ID，首次受 fencing 保护的写入升级至 v2；无法唯一对应时阻塞，不丢弃旧历史。checkpoint 继续只保存会话事实，不存 tracker/Git/Orca 副本。

### D7：手动压缩与模型切换复用现有维护规则

`CompactSession` 由应用用例核验 Session 已挂起或因 `context_exhausted` 阻塞、无在途模型操作及有效 lease，调用 workflow 的同一 `buildBoundedModelInput`/`compactWithNativeFirst`。自动和手动维护都把最近 `CompactionOutcome` 及可用产物写入该 Session checkpoint，再投影为 IC-11 `compaction`。`context_exhausted` 拒绝普通 composer/model invoke，但允许用户再次手动维护或交接；`compaction_degraded` 只告警。`SwitchModelConfiguration` 从 D1 的配置集合选择，复用 `switchModelConfiguration`、provider 核验与 native-window Capsule 迁移；registry 绑定变更前不得向 UI 报成功。无自动 fallback。

### D8：交接事实由宿主读取，目标由用户选择

交接命令由宿主核验 Source/Target 都在当前 Scope，读取当前 Scope `mapRevision`、候选 GraphVersion 的 `planRevision`（尚无候选图时为 0）、tracker open tickets 与 checkpoint Capsule。Source 无可移植 Capsule 时从已提交历史派生并先写 checkpoint；失败即拒绝 prepare。提案引用、review 与 cutover 仍调用现有三阶段用例并按 CAS 核验。Target 从 Session registry 显式选取，M2 的 Handoff 入口须提供选择；cutover 后的 `awaiting_user_prompt` 取应用激活门投影，不用 UI 推断。无候选图时交接仍可发生，`planRevision=0` 只表示当前没有计划，不伪造计划版本。

### D9：事件只是已落盘事实的进程内通知

IC-11 `SemanticEvent` 增加统一 envelope：`eventId`、`coordinationScopeId`、`coordinatorSessionId: string | null` 与现有 kind/payload。宿主在用户消息、模型/工具结果、交互和交接已读回权威状态后发布；来源于 Scope 的事件用 null。事件发布失败不回滚已提交状态；重启从快照恢复，不重放伪事件。`keepalive`、stderr、timeout、无变化对账继续过滤。TUI reducer 只用 Session ID 设置对应未读标记。备选的持久化通用事件 inbox 增加第二权威，舍弃。

### D10：合同与 M2 接缝同步

在 `docs/interface-contracts.md` 登记 IC-03 的 Scope 绑定/migration、IC-04 的消息/tool/压缩、IC-11 的命令字段与事件归属、IC-12 的精确 Home 解析。`m2-deliver-planning-tui` 的直接前驱改为本 change；删除与 D2/D7 冲突的 fail-closed 假设，保留它的界面实现和未完成 PTY/全量门禁任务。真实 PTY Handoff 仍须显式隔离项目/专用身份。改动仅在文档与前台宿主，不引入后台 controller。

## Risks / Trade-offs

- IC-03 旧 Scope 缺少注册绑定，自动推断会跨分支接错状态；一次性用户确认迁移增加启动步骤。
- 会话 v1 历史若无法按 model steps 唯一恢复 entry 顺序会阻塞；显示可诊断原因，避免默默丢消息。
- 两个 SQLite store 与 tracker 无跨系统原子事务；稳定提交/操作身份及原 ID 对账是恢复边界。
- 当前 M2 代码仍是部分完成状态；本 change 的验证以自身端口行为和 fake/隔离集成为准，M2 的 PTY 与全量门禁在其 apply 收尾时完成。

## Migration Plan

1. IC-03 执行 schema 10 单事务迁移，旧 Scope 保留 nullable 绑定；新 Scope 只写完整绑定。受控一次性绑定命令在用户 Review 后执行。
2. IC-04 读取 v1 checkpoint 时保留原始记录，受 fencing 保护在首写升级为 v2；升级失败维持原记录并阻塞。
3. 更新 M2 artifacts 的直接前驱与接缝；先实施、验证并归档本 change，再继续 M2 未完成任务。

## Open Questions

无。
