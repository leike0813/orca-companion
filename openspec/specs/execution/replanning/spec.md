## Purpose

定义从执行协调回到重新规划的受控过渡，以及代际切换与旧成果进入新规划的采用边界。

## Requirements

### Requirement: Replanning Transition 必须结清在途工作并释放 Lease

进入 Replanning Transition 时，系统 SHALL 停止新派发与新的 Graph Patch 或 Revision，结清在途 Worker、Delivery、Pending Interaction 与 Operation Intent，并 SHALL 在 Route Planning 开始前释放 Execution Coordination Lease。该过渡 SHALL 支持两种收尾方式：等待在途 Worker 自然 drain 至可核验终态，或由用户显式触发 cancel-and-reconcile；两种方式下，结果都只记录在被挂起的代际上。

#### Scenario: 目标变化触发重规划

- **WHEN** 目标或全局约束变化，或用户明确要求重规划
- **THEN** 系统停止新派发，结清在途工作与未决交互，然后释放 Lease 并建立新的 Planning Cycle

#### Scenario: 以 drain 收尾

- **WHEN** 过渡期间已派发 Worker 可自然结束
- **THEN** 系统等待其到达可核验终态，并把结果记录在被挂起的代际上

#### Scenario: 以显式取消收尾

- **WHEN** 用户显式选择 cancel-and-reconcile
- **THEN** 系统请求停止并按其取消语义对账，未确认时保持 cancelling 或 unverifiable，且不伪造已停止

### Requirement: Generation Cutover 必须原子替换代际并让新代际全新开始

Generation Cutover SHALL 在用户授权后以一个不可分割的变更替换被挂起的 Graph Generation，并 SHALL 同时改变 active Planning Cycle、GraphId、Run、Execution Authorization、预算引用与 Execution Coordination Lease，或全部不变。新代际 SHALL 使用全新的 Graph、Run、WorkPackageId 与 worktree，MUST NOT 复用前代标识或 worktree。Cutover 之后前代 SHALL 成为不可恢复的不可变历史；来自前代 Run 的后续事件 MAY 补全其历史，但 MUST NOT 影响当前代际。

#### Scenario: 授权后切换代际

- **WHEN** 候选代际通过完整 Execution Authorization 并且用户授权
- **THEN** 上述引用同时切换到新代际，新代际使用全新 Graph、Run、WorkPackageId 与 worktree

#### Scenario: 切换前的重规划取消

- **WHEN** 用户在选择 Cutover 之前取消重规划
- **THEN** 系统在重验基线、预算、Worker 结果与未决操作之后恢复被挂起的代际，并记录刷新后的 Execution Authorization

#### Scenario: 前代迟到事件

- **WHEN** Cutover 之后到达来自前代 Run 的事件
- **THEN** 系统只用它补全前代历史，不改变当前代际状态

### Requirement: 旧成果必须按采用规则进入并由 lineage 继承已消耗额度

新 Work Package SHALL 只按 Baseline Adoption、Migration Material 与 Planning Reference 三条规则之一使用旧代际成果，并且 MUST NOT 复制旧完成状态。Baseline Adoption SHALL 要求旧结果已表示在 Replanning Baseline 中且证据仍适用，由 Coordinator Agent 做语义判断、Controller 校验引用；出现矛盾事实时 SHALL 阻塞而不是猜测。当新 Work Package 明确延续一个未完成的旧责任时，系统 SHALL 以 Work Package Lineage 记录该延续，并 SHALL 继承旧责任已消耗的实现、修复、Graph Revision 与 Specification Revision 额度。

#### Scenario: 采用已有能力

- **WHEN** 旧代际的已接受结果已包含在 Replanning Baseline 中且其证据仍有效
- **THEN** 该能力按 Baseline Adoption 视为既有代码，新图不为它创建完成节点

#### Scenario: 以材料形式复用

- **WHEN** 旧代际的结果、规格或未集成的 worktree 需要作为新工作的输入
- **THEN** 系统把它作为只读 Migration Material 提供，新 Work Package 使用基于 Replanning Baseline 的新 worktree 并显式迁移与重新验证

#### Scenario: 延续未完成责任

- **WHEN** 新 Work Package 明确延续一个已消耗部分额度的旧 Work Package
- **THEN** 系统记录 Work Package Lineage，并不把已消耗额度重置为新值

#### Scenario: 事实相互矛盾

- **WHEN** Git、Orca 与旧图对某个代际成果给出相互矛盾的结论
- **THEN** 系统阻塞该采用，而不是选择其中一个事实继续