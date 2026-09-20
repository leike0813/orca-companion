## Purpose

为 Orca Companion 的实现序列提供统一、可核验的架构与接口合同，使人类和 Agent 能在修改代码前确定模块职责、依赖方向、字段来源、唯一所有者及跨系统失败语义，而不需要从多个 change 重新推断。

## ADDED Requirements

### Requirement: 架构基线必须完整表达系统组成与依赖方向

架构基线 SHALL 展示用户、Companion 运行组件、外部系统和代码模块之间的关系，并 SHALL 为每个模块声明职责、允许依赖、禁止承担的职责及其外部接缝。运行组件、代码模块和 React 组件 SHALL 使用可区分的术语。

#### Scenario: 实施者定位一个职责

- **WHEN** 实施者需要确定某项行为应落在哪个模块
- **THEN** 架构基线给出唯一职责归属、允许的依赖方向和对应外部接缝，无需从多个 change 猜测

#### Scenario: 候选实现引入反向依赖

- **WHEN** 候选实现要求领域或应用模块依赖 workflow、adapter、CLI、TUI 或数据库实现
- **THEN** 架构合同将其判定为不符合基线，并要求修改实现方案而不是增加跨层捷径

### Requirement: 跨模块接口必须具有字段级合同

每个跨模块或外部系统接口 SHALL 有稳定合同标识，并 SHALL 定义输入、输出、字段类型、字段来源、信任与校验边界、必填性、版本或 revision 语义、错误结果、调用顺序以及适用的事务、幂等、超时和取消约束。未定义的公共字段或枚举值 MUST NOT 由实现 change 自行补入。

#### Scenario: 实现一个边界 DTO

- **WHEN** 实现 change 创建跨模块 DTO 或解析外部载荷
- **THEN** 每个字段都能追溯到一个合同标识及其可信来源、校验规则和失败行为

#### Scenario: 实现需要未登记的公共字段

- **WHEN** 实现过程中发现必须增加合同基线未登记的公共字段、枚举或错误分类
- **THEN** 该 change 停止实施并返回规划，不以可选字段、宽泛类型或局部兼容层吸收差异

### Requirement: 每个共享合同必须只有一个所有者

合同目录 SHALL 为每个共享接口指定唯一 owner change、canonical path、允许的扩展者和只读消费者。Owner change SHALL 创建合同；扩展者只能在登记的维度上扩展同一接口；消费者 MUST NOT 创建平行类型、repository、pipeline 或状态权威。

#### Scenario: 后继 change 扩展既有接口

- **WHEN** 后继 change 需要为既有接口增加已登记的操作或投影
- **THEN** 它修改同一 canonical path，保持原不变式，并由原合同的行为测试覆盖扩展

#### Scenario: 两个 change 声称创建同一合同

- **WHEN** 合同审计发现多个 change 将同一职责标为 create
- **THEN** 规划包不得通过验收，直到保留唯一 owner 并把其余 change 改为 extend 或 consume

### Requirement: 外部副作用必须通过拥有其语义的接缝

对 Orca、Git、tracker、模型、Worker Harness 和持久化存储的访问 SHALL 只通过合同目录指定的应用接缝与 adapter。合同 SHALL 区分权威事实、Companion 控制记录和派生投影，并 SHALL 为不确定结果保留 fail-closed 与原身份对账路径。

#### Scenario: 外部 mutation 响应丢失

- **WHEN** 外部 mutation 已发出但其确定结果无法证明
- **THEN** 调用方保留原 operation identity 并通过指定接缝对账，不直接访问外部存储、不换身份重试，也不把未知结果投影成失败或成功

### Requirement: 测试必须通过生产调用方使用的接口观察行为

每个共享接口 SHALL 指定最小测试替身或真实隔离验证方式。行为测试 SHALL 从生产调用方使用的同一接口观察结果；内部 seam 只服务所属模块，不得为测试便利扩展成公共接口。

#### Scenario: 为外部 adapter 编写测试

- **WHEN** 一个应用模块通过 port 访问外部系统
- **THEN** 行为测试使用满足同一接口的 fake 或 mock adapter，真实集成验证只补充已声明的外部契约，不复制应用状态机

### Requirement: 实现 change 必须显式导入相关合同

每个后继实现 change SHALL 在 design 与 implementation plan 中列出它创建、扩展和消费的合同标识，并 SHALL 在开始编辑前核验其直接前驱已归档、主规格存在、canonical symbol 与冻结语义未漂移。合同不匹配时 MUST 返回规划。

#### Scenario: 后继 change 开始实施

- **WHEN** 实施 Agent 准备执行一个后继 change
- **THEN** 它能从该 change 的合同导入表确定前置文件、符号、字段与验证命令，并在任一项漂移时停止
