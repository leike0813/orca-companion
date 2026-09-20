## Why

现有十个实现 change 已经分别描述模块、DTO 与跨层调用，但字段来源、唯一 owner、扩展责任和调用约束仍散落在各自设计中。实施前先建立一份可由人类与 Agent 共同消费的架构及接口合同基线，可以让后续 change 只实现或扩展明确接缝，减少重复决策和局部兼容层。

## What Changes

- 新增规范性架构文档，以 Mermaid 图和责任表固定运行组件、代码模块、依赖方向、权威归属与关键跨系统流程。
- 新增字段级接口合同目录，为跨模块 DTO、port、projection 和持久化记录指定稳定合同 ID、唯一 owner、canonical path、消费者、字段来源、校验、版本、错误及副作用语义。
- 把当前十个实现 change 收敛到该合同基线：明确 create/extend/consume 关系、实施前漂移检查、文件所有权和升级条件；内部私有实现仍归各 change 决定。
- 将本 change 置于 `m0-orca-control-baseline` 之前；实施只修改文档、OpenSpec 配置与规划资产，不创建 `src/` 空接口、不增加依赖，也不改变产品运行时行为。

## Capabilities

### New Capabilities

- `architecture/module-interface-contracts`: 定义实现 change 必须遵守的模块依赖、唯一接口所有权、字段级合同完整性、合同扩展和测试接缝规则。

### Modified Capabilities

无。

## Impact

- 新增 `docs/architecture.md` 与 `docs/interface-contracts.md`。
- 更新 `AGENTS.md`、`README.md`、`openspec/config.yaml` 和现有十个 change 的规划资产。
- `m0-orca-control-baseline` 从 `current-head` 改为 `predecessor-contract`，其余直接前驱链不变。
- 不修改产品源码、依赖、数据库、Orca 上游或 `CONTEXT.md` 的领域词汇。
