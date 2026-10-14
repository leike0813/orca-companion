## Why

Worker Harness 的完整能力矩阵把可用的单次执行也挡在生产之外。用户批准改为最低真实能力准入、按证据递进分级，使历史读取和恢复缺口只限制需要这些能力的操作。

## What Changes

- 基础级支持单次 Planner/Implementation；增强级增加精确 Session、续接及只读角色；完整级增加历史恢复。
- **BREAKING**：新增真实 Orca Worker 执行绑定，基础角色不要求原生 Session；新授权使用 Manifest v5，允许显式关闭 Recovery。
- 能力声明与证据分离；模型回显、usage 和目录不作为等级条件。显式真实验收产出等级，运行时复核相关能力。
- v4 授权保持原合同与指纹读取，不自动降级。保留权限、预算、unknown 对账和结果归属约束。
- 只读作为任务级可选能力，不参与通用支持等级；Recovery Utility 与明确的纯分析任务单独核验它。
- Finalizer 获得显式授权后在独立项目级 worktree 修复并生成测试产物，核验实际改动、修复后的 HEAD 与测试证据，再经受控集成接受交付结论。既有无修复授权的 Finalizer 保持原权限。

## Capabilities

### New Capabilities

- `workers/harness-support`: 证据、递进等级与角色准入的唯一规则。

### Modified Capabilities

- `workers/harness-adapters`: 显式登记与可选能力组。
- `workers/harness-binding`: 基础 Orca 绑定及原生绑定。
- `planning/execution-authorization`: 等级授权与可关闭 Recovery。
- `execution/project-finalization`: 可写 Finalizer 与最终代码的交付依据。
- `orchestration/read-only-worker-execution`: 按任务核验只读能力。
- `tui/delivery-finalization`: 修复、复验及集成后的交付投影。

## Impact

影响 domain/application contracts、storage schema 22、bootstrap、doctor、模型设置、授权投影和验收矩阵。无新增依赖，不修改 Orca 上游。基于当前已实现的 add-next-worker-harness-adapters 接缝；该前驱尚未归档，用户明确批准此次独立实施。ledger-lab 业务验收不属于本 change。
