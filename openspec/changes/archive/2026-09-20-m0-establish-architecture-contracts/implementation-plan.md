# Implementation Plan

## 1. 实施基线与权威来源

- **Baseline mode**: `current-head`
- **规划提交**: `cd29e2bcd8b0278d34ae19db64cb8ebdaf149279`
- **权威来源**: 本 change 的 proposal、`architecture/module-interface-contracts` spec 与 design D1–D12；根目录 `AGENTS.md` 的模块边界和完成标准；`CONTEXT.md` 的领域语言与权威归属；当前十个 change 已批准的 proposal、spec、design、implementation plan 与 tasks。
- **工作区事实**: 产品 `src/` 尚不存在；十个 change、`CONTEXT.md`、research 文档与 OpenSpec schema 是当前未提交规划资产，属于用户工作，不得覆盖或回滚。
- **实施前核对门**:
  1. `git rev-parse HEAD` 仍为规划提交；若 HEAD 已前移，先核对架构或规划相关差异。
  2. `openspec validate --all --json` 在编辑前不含既有失败。
  3. 十个 change 的直接前驱链、canonical paths 与任务数仍与本计划盘点一致。
  4. 目标文件若有本 change 之外的新改动，合并其语义，不整文件覆盖。

## 2. 复用与接缝

| IP-ID | 现有或前驱文件与符号 | 复用方式 | 禁止复制的事实 |
|---|---|---|---|
| IP-1 | `AGENTS.md` 的模块布局、`CONTEXT.md` 的权威归属、十个 design 的模块选择 | 汇总为 `MOD-01` 至 `MOD-07` 与 `FLOW-01` 至 `FLOW-04`，只保留一个详细结构事实源 | 不重写领域定义，不增加新模块层或运行组件 |
| IP-2 | 十个 implementation plan 已声明的公共 symbols、字段来源与调用顺序 | 归一为 `IC-01` 至 `IC-12`，为每项指定唯一 owner 和 canonical path | 不创建代码空壳、第二套 DTO、泛化 repository 或兼容层 |
| IP-3 | `AGENTS.md`、`README.md`、`openspec/config.yaml` | 增加精确触发指针并把实施序列更新为十一项 | 不把详细合同复制进常驻 Agent 指令，不修改 schema 工作流结构 |
| IP-4 | `m0-orca-control-baseline` 至 `m1-plan-and-authorize-execution` | 增加合同导入表；M0 改为本 change 的直接后继，其余前驱不变 | 不改变既有 capability、业务范围或测试目标 |
| IP-5 | `m1-admit-work-package-specifications` 至 `m1-evolve-execution-graph` | 固定 Worker、Delivery、Recovery 和图演进的 create/extend/consume 关系 | 不合并 Recovery Capsule 与 Context Capsule，不复制 Delivery/Wake/Graph 写路径 |
| IP-6 | 两个 M2 TUI change | 固定 `ControllerService`、projection、CLI/TUI 与 React 组件职责 | 不让界面直连 store/backend，不提前冻结私有 props |
| IP-7 | OpenSpec CLI 与 `rg`/Git 的只读检查 | 验证合同唯一性、引用完整性和 apply 状态 | 不增加自定义 validator、hash 门禁或新依赖 |

## 3. 代码变更映射

| IP-ID | Task | Requirement/Scenario | 文件与符号 | 精确变化 | 不得改变 |
|---|---|---|---|---|---|
| IP-1 | 1.1 | 架构基线完整表达系统组成与依赖方向 / 两个 Scenario；外部副作用通过拥有其语义的接缝 / response 丢失 | 新增 `docs/architecture.md` 的 `MOD-01`–`MOD-07`、`FLOW-01`–`FLOW-04` | Mermaid 系统/模块/部署图、职责矩阵、四条 sequence flow 与文字失败边界 | `CONTEXT.md` 领域定义、既有产品边界、外部权威归属 |
| IP-2 | 1.2 | 跨模块接口具有字段级合同 / 两个 Scenario；每个共享合同只有一个所有者 / 两个 Scenario；测试通过生产接口 / adapter Scenario | 新增 `docs/interface-contracts.md` 的 `IC-01`–`IC-12` | 为每组合同写非执行形状、字段表、owner/path、消费者、校验、版本、错误、时序与测试 seam | 不提前新增 source interface、依赖、数据库字段或公共扩展点 |
| IP-3 | 2.1 | 架构基线完整表达系统组成与依赖方向 / 定位职责；实现 change 显式导入相关合同 / 开始实施 | 修改 `AGENTS.md`、`README.md`、`openspec/config.yaml` | 增加何时读取两份文档的指针；改为十一项串行链和 baseline 规则 | `CONTEXT.md` 的 SSOT 地位、schema artifact 顺序、归档门禁 |
| IP-4 | 3.1、3.2 | 实现 change 显式导入相关合同 / 开始实施；共享合同唯一 owner / 后继扩展 | 修改前四个既有 change 的 proposal/design/implementation-plan，必要时最小修改 tasks | M0 指向新前驱；加入相关合同 ID、owner/extension/consumer、canonical symbols、漂移门 | capability 行为、D-ID 语义和原测试命令 |
| IP-5 | 3.3、3.4 | 同上；字段合同 / 未登记字段；外部副作用 / response 丢失 | 修改中间四个 M1 change 的 design/implementation-plan，必要时最小修改 proposal/tasks | 固定 Specification、Worker、Delivery、Recovery、Graph contracts 的唯一写路径和升级条件 | salvage 只属于 Worker transcript extraction；两类 Capsule 与两类 handoff 分离 |
| IP-6 | 3.5 | 同上；架构依赖 / 反向依赖 | 修改两个 M2 TUI change 的 design/implementation-plan，必要时最小修改 proposal/tasks | 明确只消费 `IC-11`/`IC-12`，React 组件只投影 view model 与提交 intent | TUI 行为、键位、TTY 与 CJK 验收范围 |
| IP-7 | 4.1、4.2 | 全部 Requirement/Scenario | OpenSpec artifacts 与全体 Markdown | 严格校验、apply 状态、合同 owner/引用/旧路径/重复 Requirement/尾随空白审计 | 不创建 `verification.md`，不改任务完成状态以外的产品证据 |

## 4. 调用与副作用顺序

1. 核对 HEAD、工作区和十个 change 的当前状态，保留用户未提交资产。
2. 写 `docs/architecture.md`，先确定 module 与 flow ID。
3. 写 `docs/interface-contracts.md`，把十个 change 的公共符号映射到唯一 `IC` owner。
4. 更新 `AGENTS.md`、`README.md` 与 OpenSpec 配置，使后续 Agent 能按触发条件读取合同。
5. 按实施序列更新十个 change；先改 M0 前驱，再逐 change 只加入本 change 所需合同引用和漂移门。
6. 校验全部 change；若合同冲突，修正文档和 planning artifact，不制造第三种语义。
7. 每个 IP-ID 验证通过后立即勾选对应 task。

所有变更都是仓库文本写入，没有外部 mutation、数据库事务或运行时权限变化。任一步失败保留已有文件并停止勾选该 task；恢复时从当前文件和 OpenSpec status 继续。

## 5. Schema、状态与持久化落实

- 本 change 新增一个开发者侧 capability；归档后主规格路径为 `architecture/module-interface-contracts`。
- `openspec/config.yaml` 的规划包计数从十改为十一；`current-head` 只属于本 change，十个后继均为 `predecessor-contract`。
- 不新增运行时 schema、状态、数据库表、migration、权限或审计记录。
- 合同 ID 是文档标识，不是运行时 ID，也不进入产品 DTO 或持久化记录。
- `verification.md` 仍只在任务完成且固定实现 checkpoint 后由验证流程创建。

## 6. 验收证据矩阵

| Requirement/Scenario | IP-ID | 测试文件 | Fixture/前置条件 | 关键断言 | 可运行命令 |
|---|---|---|---|---|---|
| 架构基线 / 定位职责与反向依赖 | IP-1、IP-3 | 文档结构检查 | `docs/architecture.md` 与 AGENTS 指针 | 七个 MOD 均有职责/允许依赖/禁区；依赖图只向内 | `rg -n 'MOD-0[1-7]|依赖方向|禁止' docs/architecture.md AGENTS.md` |
| 字段级合同 / 两个 Scenario | IP-2 | 合同目录检查 | `IC-01`–`IC-12` | 每项含 owner、path、字段/形状、校验、错误、版本与测试 seam | `rg -n '^## IC-(0[1-9]|1[0-2])' docs/interface-contracts.md` |
| 共享合同唯一 owner / 两个 Scenario | IP-2、IP-4、IP-5、IP-6 | owner 与下游引用审计 | 十个 change | 每个 IC 只有一个 Create owner；后继只 Extend/Consume | `rg -n 'Create|Extend|Consume|IC-[0-9]{2}' openspec/changes/*/{design.md,implementation-plan.md}` |
| 外部副作用 / response 丢失 | IP-1、IP-2、IP-5 | 流程与合同检查 | FLOW-01、IC-02/03/08/09 | unknown 沿原 OperationId 对账；无直连或换 ID 重试 | `rg -n 'FLOW-01|OperationId|unknown|对账' docs/architecture.md docs/interface-contracts.md` |
| 测试通过生产接口 / adapter Scenario | IP-2 | 测试 seam 表 | IC 合同目录 | 外部 seam 指定 fake/mock/真实隔离方式；内部 seam 不公开 | `rg -n '测试 seam|fake|mock|隔离' docs/interface-contracts.md` |
| 实现 change 显式导入合同 / 开始实施 | IP-4、IP-5、IP-6 | 十项 change 扫描 | 每个 design/plan | 每项均含合同基线引用和 create/extend/consume | `rg -l 'docs/interface-contracts.md' openspec/changes/*/implementation-plan.md` |
| 全部 Requirement/Scenario | IP-7 | OpenSpec 严格校验 | 十一项 change | 11 passed、0 failed | `openspec validate --all --json` |
| 规划与实现状态 | IP-7 | apply instructions | 新 change 已实施 | 本 change all_done；后继十项 ready | `openspec instructions apply --change m0-establish-architecture-contracts --json` |

## 7. 文件清单与升级条件

**新增**：`docs/architecture.md`、`docs/interface-contracts.md`，以及本 change 的 proposal、spec、design、implementation-plan、tasks。

**修改**：`AGENTS.md`、`README.md`、`openspec/config.yaml`；现有十个 change 的 proposal/design/implementation-plan/tasks 中与直接前驱、合同导入、文件所有权、漂移门和证据有关的最小部分。

**受保护**：`CONTEXT.md`、`package.json`、lockfile、TypeScript/ESLint/Vitest 配置、`src/`、`tests/`、`references/orca`、`docs/research/`、`docs/orca-compatibility.md`、OpenSpec schema 与 verification artifacts。

**升级条件**：发现需改变领域定义、运行时 capability、依赖、数据库、既有 Requirement/Scenario、预算上限、权限、外部操作或产品源码；发现两个已批准 change 对同一公共字段存在无法由上位规则消解的冲突；需要新建第三份规范文档或自定义校验工具。出现任一情况即停止实施并回到规划。

## 8. 验收 Agent 授权与限定审计

- **授权范围**：本 change 全部 Requirement/Scenario、D1–D12、IP-1–IP-7，以及第 7 节新增/修改清单。
- **受保护语义**：`CONTEXT.md` 的领域语言；Orca/Git/tracker/SQLite 的权威归属；OperationOutcome 三值；Delivery/Wake/Graph 唯一写路径；Recovery 与 salvage 边界；Planning/Execution Handoff 分离；TUI 无业务副作用。
- **限定审计标签**：`gate.single-contract-owner`、`gate.no-parallel-interface`、`gate.documented-field-provenance`、`gate.inward-dependencies`、`gate.original-operation-id`、`gate.no-runtime-scaffolding`。
