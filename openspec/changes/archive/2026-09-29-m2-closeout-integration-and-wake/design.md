## Context

`integrationCompletedFor` 只按 `git-integration` 类别、目标和 settled/accepted 判定，故 commit 即可被误读为整次集成；`deriveExecutionFacts` 则只看 Baseline Adoption 的引用。`request_graph_patch` 的工具结果虽逐 call 写入 checkpoint，但模型节点与宿主只认最终无 tool call 的 assistant 消息为消费事实。

## Goals / Non-Goals

**Goals:** 同一份持久 Git 意图确定调度与展示；已受理的一次图补丁请求在崩溃后不重提。

**Non-Goals:** 改变 Git Integration Policy、添加数据库表、让任意只读工具自动完成用户消息、改变 TUI 页面或 Orca 协议。

## Decisions

### D1：完整集成以当前世代的 push OperationId 为唯一完成引用

把现有 `commit`/`integrate`/`push` 稳定 ID 派生移入 `src/application/integrate-work-package.ts`，供宿主与只读投影复用。完成判定须同时匹配当前 Scope、GraphId、generation、WorkPackageId 所派生的 push ID、目标和 settled/accepted。部分步骤不算完成；重入 `integrateWorkPackage` 仍逐步回读旧意图并继续未完成步骤。权威是 Branch Coordination Store 中的 Operation Intent 与 Git 回读，失败或缺记录时保持待集成。现有 ID 格式不变，以免旧 Scope 重启后重复动作。

### D2：协调快照只增加已结算 Git 意图的只读切片

`src/adapters/storage/coordination-store.ts` 读取同一批 scope intent，保留现有 `unresolvedIntents`，另投影 settled/accepted 的 Git 意图到 `CoordinationSnapshot`。`deriveExecutionFacts` 用 D1 判断完整集成，再决定 `accepted` 与依赖 Frontier；CLI/TUI 与调度均消费此投影。Baseline Adoption 仍按其自身 `integrationRef` 表达已采纳成果，但正常集成以 push 意图为准。查询失败则 fail closed，不推断 accepted。无需 schema migration；读取范围只限当前 Scope 已有意图。

### D3：受理图补丁的工具结果是持久消息消费点

在 `CoordinatorToolDefinition` 上为 `request_graph_patch` 标记“成功即完成当前工作”。受控 tools 节点仅对 `kind: ok` 的已落盘结果写入 `CommittedMessageEntry.completedWorkSource`（精确 source kind/id/revision）；拒绝或 unknown 不写。checkpoint parser 显式校验该字段只属于 tool 记录。宿主重建待处理消息时按该身份移除工作；同一次 invoke 以 `work_completed` 结束当前工作，不再让模型因同一声明重新调用该工具。若同一批次还有别的工作，宿主继续处理剩余项。权威是 checkpoint 中已提交的工具结果，未能提交时不消费；无需额外 store 表或跨库事务。

### D4：验证取最小可复现边界

扩展现有 `execution-view`、`integrate-work-package` 与 `coordinator-tool-loop` 测试，覆盖部分步骤、完整 push、依赖 Frontier、受理/拒绝/重启。常规 typecheck、lint、test、build 与 OpenSpec strict 校验串行运行。真实 PTY 已有 M2 验收证据，本 change 只在可用的隔离项目与专用身份下补充真实复核，不触碰用户主项目。

## Risks / Trade-offs

- 新快照会多读取已结算 Git 意图，但只在当前 Scope 内，且不新增跨系统读取。
- 图补丁受理后不强求模型再输出一句散文；已有 `graph-version-appended` 事件和工具结果承载该结论。
- 历史上已按部分步骤前进的 Scope，重启后会按真实 push 状态重新判定；若 Git 事实不可读，按既有 unknown/lane 规则阻塞。

## Migration Plan

仅扩展当前快照与 checkpoint 的可选消息字段；既有记录缺少新字段时按未完成处理，既有 OperationId 不变。无持久化表迁移。

## Open Questions

无。
