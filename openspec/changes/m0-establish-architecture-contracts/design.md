## Context

仓库仍处于规划态，没有 `src/` 产品实现。模块布局与领域权威已由 `AGENTS.md`、`CONTEXT.md` 和十个 apply-ready change 确定，但公共合同分散在各 change 的 design 与 implementation plan 中：同一接缝常由一个 change 创建、多个后继扩展或消费，实施者需要跨文件拼出字段、调用顺序和失败语义。

本 change 是实现序列的第一项，直接以当前 HEAD `cd29e2bcd8b0278d34ae19db64cb8ebdaf149279` 为基线。它只把已经批准的语义整理成规范性架构与合同，不提前实现代码，也不改变 `CONTEXT.md` 的领域定义。

## Goals / Non-Goals

**Goals:**

- 建立人类可读、Agent 可检索的架构与接口合同事实源。
- 为所有跨 change 公共接缝指定唯一 owner、canonical path、字段级语义和允许的扩展方式。
- 用稳定合同 ID 约束十个实现 change，使每个实施者能在本 change 内完成前置核验。
- 通过图、表与 TypeScript-shaped 文档同时表达静态结构和关键时序。

**Non-Goals:**

- 不创建 TypeScript interface、DTO、空目录或合同测试脚手架。
- 不重新设计已由用户确认的领域模型、预算、恢复、授权或 TUI 行为。
- 不冻结单模块私有函数、类拆分、局部文件组织和 React 组件 props。
- 不新增 schema/codegen、绘图依赖、Markdown 工具或 CI 门禁。

## Decisions

### D1：两份规范文档分别拥有结构与字段合同

`docs/architecture.md` 是系统组成、模块职责、依赖方向、权威归属与关键时序的事实源；`docs/interface-contracts.md` 是公共接口、DTO 字段、owner 与演进规则的事实源。`AGENTS.md` 只保留触发指针与硬边界，后继 OpenSpec change 通过合同 ID 引用这两份文档，不复制完整定义。

理由：把全部内容塞进 `AGENTS.md` 会增加每次 Agent 运行的上下文负担；把每个接口拆成单独文件又会增加查找和同步成本。两份文档对应“结构”和“字段”两个稳定阅读分支。

### D2：术语按代码层级区分

本文使用 **module** 表示具有 interface 与 implementation 的代码单元，使用 **seam** 表示 interface 所在位置，使用 **adapter** 表示满足外部 seam 的具体实现。**运行组件**只表示进程或外部系统，**React 组件**只表示 TUI 渲染单元。一般编程术语不写入 `CONTEXT.md`。

理由：领域词汇继续由 `CONTEXT.md` 独占；架构词汇只服务实现，避免把“组件”同时用于进程、目录和 React 节点。

### D3：合同使用三类稳定 ID

- `MOD-nn`：模块职责与允许依赖。
- `IC-nn`：跨模块 interface 与字段族。
- `FLOW-nn`：跨接缝调用顺序和失败处理。

ID 一经被后继 change 引用即不重排。合同可补充描述，但改变公共字段、所有权、权威来源或失败语义必须通过新的 OpenSpec change 更新合同及全部受影响消费者。

理由：文件路径和标题会调整，稳定 ID 让计划与审计不依赖行号、标题措辞或内容 hash。

### D4：架构文档固定七个模块与四条关键流程

模块合同覆盖：Domain、Application、Workflow、Adapters、CLI、TUI、Bootstrap。外部运行组件包括用户终端、模型 provider、Orca、Worker Harness、issue tracker、Git/worktree 与两个 SQLite store。依赖方向为外层装配和适配内层 interface；Domain 不依赖框架或 I/O，Workflow 调用 Application，CLI/TUI 只调用 `ControllerService` 或一次性查询入口，Adapters 不拥有领域策略。

`docs/architecture.md` 使用 Mermaid 表达：系统上下文、module dependency、运行组件部署关系，以及 `FLOW-01` side-effect intent/unknown reconciliation、`FLOW-02` Wake admission、`FLOW-03` Delivery settlement、`FLOW-04` Execution Handoff。图旁必须有等价文字和失败关闭说明，避免渲染能力成为理解前提。

### D5：字段级合同采用固定条目结构

每个 `IC-nn` 条目包含：职责、owner change、canonical path、方法或判别联合、TypeScript-shaped 非执行定义、逐字段来源/类型/必填性/信任与校验、版本或 expected revision、结果与错误、调用顺序、事务/幂等/超时/取消、消费者与允许扩展者、测试 seam。字段表只列调用方必须知道的事实；实现内部缓存、SQL 列名和私有 helper 不进入合同。

理由：这些字段决定跨 change 兼容性；内部细节提前冻结只会把文档变成代码镜像。

### D6：接口合同目录覆盖十二组公共接缝

`docs/interface-contracts.md` 至少包含以下合同，且每组只有一个 owner：

1. `IC-01` Identity、revision 与引用字段族；
2. `IC-02` `ExecutionBackend`、`ExecutionScope`、`OperationRef`、`OperationOutcome` 与 Delivery transport；
3. `IC-03` `BranchCoordinationStore`、lease、fencing、Operation Intent 与版本化 migration；
4. `IC-04` Coordinator Session checkpoint、Wake Batch、Actionable Work 与 Context Capsule；
5. `IC-05` Route Planning、`ExecutionAuthorizationManifest`、`ExecutionGraphHistory` 与 planning handoff；
6. `IC-06` `SpecificationProvider`、Task Contract、Spec Binding 与 Specification Admission；
7. `IC-07` Worker Harness Adapter、Task Envelope、Session Binding、liveness 与候选 Worker reports；
8. `IC-08` Delivery settlement、Accepted Worker Result reference、Validation 与 Finalizer verdict；
9. `IC-09` Worker Session Recovery、Recovery Capsule、Scope control 与 Execution Handoff；
10. `IC-10` Graph Patch/Revision、Replanning、lineage 与 generation cutover；
11. `IC-11` `ControllerService`、`ControllerSnapshot`、`SemanticEvent` 与 Pending Interaction answer；
12. `IC-12` TUI projection、CLI machine output 与 process lifecycle。

该目录复用当前十个 change 已确认的语义。发现冲突时以 `CONTEXT.md` 的领域含义和 `AGENTS.md` 的产品边界为上位约束，并在本 change 内修正下游 planning artifact；不得创造兼容两套语义的第三种合同。

### D7：公共 seam 只为真实变化或信任边界存在

外部系统、持久化实现和生产/测试双实现可使用 port 与 adapter。纯领域规则直接导出类型和函数；只有一个实现且不存在信任、I/O 或替换需求的模块不增加 interface/factory。测试使用生产调用方的 seam，内部 seam 保持私有。

理由：这让接口深度来自隐藏复杂度和隔离外部变化，而不是为每个文件增加一层转发。

### D8：唯一 owner 决定 create/extend/consume

合同目录为每个 `IC-nn` 列出 owner change。Owner 负责首次创建 canonical symbol 和基本行为测试；登记的 extender 在同一路径增加判别联合成员、方法或投影字段，并运行原合同测试；consumer 只导入。多个 change 不能各建 repository、pipeline、结果类型、snapshot 或泛化 handoff。

实现发现合同不足时 fail closed：停止当前 IP-ID，更新设计基线和受影响 change 后再继续。不得用 `any`、可选字段、字符串匹配或 adapter 特判绕过。

### D9：十个后继 change 统一增加合同导入表

每个后继 design 引用相关 `MOD`、`IC`、`FLOW` ID，并删除与基线冲突的局部选择；每个 implementation plan 在基线节列出 create/extend/consume、canonical symbols、实施前漂移检查和升级条件。tasks 继续只引用 IP-ID，只有缺少可运行证据时才增加合同测试任务。

`m0-orca-control-baseline` 改用 `predecessor-contract`，直接前驱为本 change；其余直接前驱保持现有串行链。后继开始前必须确认本 change 已 archive 且 `architecture/module-interface-contracts` 主规格存在。

### D10：配置明确十一项串行实施

`openspec/config.yaml` 把规划包数量更新为十一：本 change 使用 `current-head`，其余十项使用 `predecessor-contract`。Apply guidance 仍只允许实施序列中第一个未归档 change；本 change verification PASS 并 archive 前，不开放 Orca 控制基线。

### D11：本 change 不产生运行时代码或依赖

Apply 只新增两份 `docs/` 文档并修改治理与规划资产。Mermaid 以 Markdown fenced blocks 保存，不生成图片、不增加渲染依赖。`CONTEXT.md` 不变，因为本 change 没有引入项目领域概念。

### D12：验收使用结构审计而不是产品测试

验收检查十一项 change 全部通过 OpenSpec validation；本 change 任务完成，其余十项仍 apply-ready；每个合同 ID 唯一、每个 `IC` 只有一个 owner、所有下游公共 symbol 可追溯、旧路径和重复定义无残留。再运行 Markdown 尾随空白扫描与 `git diff --check`。不运行与文档规划无关的产品测试。

## Risks / Trade-offs

- 字段合同过细会限制局部重构。通过只记录跨 seam 的调用者知识、排除内部实现来控制粒度。
- 文档可能与未来代码漂移。后继 change 的 predecessor gate 和合同测试是纠偏点；不增加易失真的 hash 门禁。
- Mermaid 渲染支持因客户端而异。每张图同时保留文字表述，源码本身也可由 Agent 读取。
- 一次更新十个 change 的审查面较大。改动按合同 ID 与 create/extend/consume 机械收敛，不顺带改变业务范围。

## Migration Plan

本 change 没有运行时数据迁移。Apply 时先写合同文档与治理指针，再按既有执行顺序更新十个 change，最后做全链审计。`m0-orca-control-baseline` 的 baseline mode 和直接前驱随本 change 一次切换；其余链路不重排。

## Open Questions

无。合同基线覆盖跨模块与跨 change 接缝；私有实现选择明确留给对应 owner change。
