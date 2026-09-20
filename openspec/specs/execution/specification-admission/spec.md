## Purpose

定义 Work Package 的 Specification Unit 如何由 Specification Planner Worker 以工具原生格式编写、如何被确定性接纳并绑定到确切内容，以及可选独立质量门在何时介入。

## Requirements

### Requirement: Specification Planner 在 Work Package 的 worktree 内编写工具原生 Specification Unit

Work Package 的 Specification Unit SHALL 由 Specification Planner 角色的 Worker 在该 Work Package 的 worktree 内，以所选 Specification Provider 的工具原生格式编写。Controller SHALL 拒绝由 Coordinator Agent 直接撰写、复制自 Planning Reference，或在 worktree 之外生成的 Specification Unit。

#### Scenario: Specification Planner 在 worktree 内产出原生规格

- **WHEN** Specification Planner 角色的 Worker Task 在其 Work Package 的 worktree 内完成
- **THEN** 该 worktree 中存在可通过 Specification Provider 读取的工具原生 Specification Unit，且其余工作区未因此变更

#### Scenario: 拒绝在 worktree 之外生成的规格

- **WHEN** Specification Unit 出现在 Work Package 的 worktree 之外，或由 Coordinator Session 直接写入
- **THEN** Controller 拒绝接纳该规格，并保持该 Work Package 处于未接纳状态

### Requirement: 确定性 Specification Admission 与 Spec Binding

Controller SHALL 以一个确定性检查接纳 Specification Planner 的就绪声明、Task Contract 与 Spec Binding，检查覆盖结构、版本、Scope Envelope、authority 与预算。接纳 SHALL 记录一个指向该 Specification Unit 确切内容快照的版本化绑定；检查未通过时 SHALL 拒绝接纳并说明失败项。Controller SHALL NOT 依据接纳结果宣告规格在语义上完备。

#### Scenario: 检查通过后记录版本化绑定

- **WHEN** Specification Planner 的就绪声明满足结构、版本、Scope Envelope、authority 与预算检查
- **THEN** Controller 记录该 Work Package 的 Spec Binding，并将其指向确切的 Specification Unit 内容快照与版本

#### Scenario: 超出 Scope Envelope 时拒绝接纳

- **WHEN** Specification Unit 描述的实现范围超出该 Work Package 的 Scope Envelope
- **THEN** Controller 拒绝接纳，并报告导致失败的具体检查项

### Requirement: 可选 Specification Validator 作为独立质量门

当工作流显式启用该质量门时，Controller SHALL 在接受 Specification Admission 之前，另派一个独立角色的 Worker 审查 Specification Unit。该质量门的结论 SHALL 以独立 Worker Result 表达，Controller SHALL NOT 以 Planner 的自审替代它；质量门未启用时，Controller SHALL NOT 派发该 Worker。

#### Scenario: 质量门启用时派出独立审查

- **WHEN** 工作流配置显式启用了 Specification Validator
- **THEN** Controller 在记录接纳之前派出一个独立角色的 Worker Task 审查该 Specification Unit

#### Scenario: 质量门未启用时不额外派发

- **WHEN** 工作流配置未启用 Specification Validator
- **THEN** Controller 不派发审查 Worker，接纳路径不因该质量门而阻塞
