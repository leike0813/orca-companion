## Context

根因在 advanceExecution 全局 occupied 门禁、bootstrap 首候选选择、单活动包 DTO 及仅 FF 集成路径。IC-03/05/07/08/09/11/12 为现有 seam；控制操作保持确定性串行，Orca 后台 Worker 可并行。

## Goals / Non-Goals

恢复用户可配置多 lane、本机可恢复闭环与 TUI 编辑。不建设通用 scheduler、不增加依赖、后台模式或旧 Scope 升级。

## Decisions

### D-01 额度唯一来源

ExecutionLimits 使用 maxActiveWorkPackages=3、maxWorkPackages=8、integrationReconciliations=2；全部为正安全整数且可配置。删除 concurrencyLimit 及图中的额度副本。WorkPackageBudget 增加 integrationReconciliations。配置 schema3、Manifest3、status JSON3、Coordination schema19。当前用户选择和 #13 多 lane 决议覆盖串行 AGENTS。图容量不限制用户填写的并行额度，空额度自然闲置。

### D-02 原子包准入

Branch Store 保存最小 lane reservation（scope/generation/package、稳定准入身份、基线、准入授权）。新包在创建外部资源前通过短事务 CAS、fencing、当前授权额度检查取得 reservation。同包后续角色复用；派发前单包 Worker 互斥沿实时事实及未决意图核验。终止/完整集成可证明后才释放。reservation 不是第二份工作流状态机。模型工具和自动驱动共用准入，按图顺序遍历有界候选，跳过包级阻塞。无法归属的 canonical 漂移为全局门禁。真实运行中 terminal 标题会被 shell/TUI 改写；原创建回执句柄随 Operation Intent 结算保存，恢复以精确 worktree 列举核验句柄，缺失时阻塞。已有操作只对账，不重复执行或结算。

### D-03 多分支集成

串行 canonical 集成，在包 worktree merge 当前已归属 canonical --no-commit；原 Validator 复验精确树，再由 Controller 普通提交并以 expected HEAD FF canonical。每轮独立有限 reconciliation，身份关联原 Validator Attempt、Session、原接受结果、目标 HEAD/树及续接 Task/Dispatch。复用已核验原 terminal；退出后仅以原 CODEX_HOME 和精确 UUID resume。不可核验不猜会话、不以 retry-of 重试已完成 Task。接纳/ack 沿 IC-08 原 pipeline；原结果不可改写。budget 消费随稳定轮次注册原子提交。全图集成完成且无在途 lane/unknown 后 Finalizer 冻结集成。

### D-04 设置与限定重新授权

复用 ProjectConfigurationStore CAS 保存，新增 ExecutionSettings 应用用例与 TUI port，编辑只含 maxActiveWorkPackages。默认值保存不改变执行；按现有完整 Manifest review/CAS 显式批准额度。提高补槽，降低只阻止新包，已有包可完成后续角色。拒绝/过期/未决 mutation 保持旧授权。复用模型重新授权公共部分，以封闭模型/额度更新替代任意 Manifest patch。

### D-05 UI 事实与边界

activeWorkPackageIds + activeWorkPackageCount 取真实 reservation/生命周期，不截断至一项；Worker liveness 单独展示。状态栏显示多包摘要，包预算只投影精确选中包。TUI 使用六票既有 P-43 adaptive 图、P-48 statusline、P-51 固定项目区域及 P-52 final dialog；设置入口沿现有命令目录与返回约定，不改布局。异步保存失败保留内存输入，render/effect/resize 不写入。

## Risks / Trade-offs

并行暴露 canonical 分叉、会话续接和派发未可见竞态，必须通过隔离真实闭环验证；不以假 backend 或 prompt 字符串代替会话证明。等待集成仍占包额度，可能闲置 Worker，换取可证明有界工作集。

## Migration Plan

项目未发布，直接更新合同，不回填旧运行 reservation，不建设旧 Scope 升级。历史归档工件保留当时证据。不存在待决技术选项。
