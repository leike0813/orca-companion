## Purpose

定义 Execution Coordination 中 Work Package 由逻辑节点转为真实可派发 Worker 工作的时机与前置条件，使 worktree 与 Orca Task 只在运行时确有需要时创建，且部分失败不会留下无法对账的残留。

## ADDED Requirements

### Requirement: Work Package 的 worktree 只在进入调度时建立

Controller SHALL 仅在某个 Work Package 进入 Execution Frontier 且被选为当前 Dispatch Candidate 时，才为该 Work Package 建立并核验 worktree。在此之前，不得为其创建 worktree、占位 Orca Task 或容器 Task。当同一 Work Package 已存在通过核验的 worktree 时，后续派发 SHALL 复用该 worktree，不得重复建立。

#### Scenario: 选中候选时建立 worktree

- **WHEN** 某 Work Package 的图依赖已通过，且它被选为当前 Dispatch Candidate
- **THEN** Controller 在派发前为该 Work Package 建立一个绑定当前基线与 canonical 分支的 worktree，并在核验其身份后才继续

#### Scenario: 未进入 Frontier 的 Work Package 不产生 worktree

- **WHEN** 某 Work Package 的图依赖尚未通过，或它不是当前 Dispatch Candidate
- **THEN** 仓库中不存在属于该 Work Package 的 worktree、占位 Task 或容器 Task

### Requirement: Dispatch Candidate 物化恰好一个角色级 Orca Task

为 Dispatch Candidate 执行 Task Materialization 时，Controller SHALL 只创建一个角色级 Orca Task，并在创建前核验生命周期、图、规格、worktree、授权与预算前置条件。任一前置条件不成立时，SHALL 拒绝物化并保持 Execution Graph 与 worktree 不变。物化结果 SHALL 以 accepted、rejected、unknown 三值语义表达；结果为 unknown 时，SHALL 以同一 OperationId 对账该次调用，且在取得确定结论前不得创建第二个 Task。

#### Scenario: 前置条件不满足时拒绝物化

- **WHEN** 选定 Dispatch Candidate 的 Execution Authorization 已失效或其共享预算已耗尽
- **THEN** Controller 不创建 Orca Task，并为该候选记录拒绝原因与依据

#### Scenario: 物化结果未知时先对账

- **WHEN** Orca Task 创建调用返回 unknown
- **THEN** Controller 以原 OperationId 对账该次调用，且在取得确定结论前不再创建 Task

#### Scenario: 图未授权时不物化任何 Task

- **WHEN** 当前 Graph Generation 尚无有效的 Execution Authorization
- **THEN** Controller 不物化任何角色级 Orca Task，并报告该 Graph Generation 处于未授权状态

