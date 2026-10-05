## Purpose

定义用户可编辑的执行并发默认值、当前批准额度与显式重新授权之间的关系，确保配置修改不会悄悄改变正在执行的权限、身份或已消耗预算，并在降低额度时保留已有工作。

## ADDED Requirements

### Requirement: Configurable concurrency
项目 SHALL 默认允许 3 个并行 Work Package，用户 SHALL 可保存任意正安全整数作为默认额度，不设硬上限 3。保存 SHALL 做配置 revision CAS 并保留其他配置。界面 SHALL 展示默认值和当前批准值。

#### Scenario: More than three lanes
- **WHEN** 用户保存并批准额度 5，存在足够独立可执行包
- **THEN** 调度 SHALL 使用额度 5，不按默认 3 截断

#### Scenario: Invalid or stale edit
- **WHEN** 用户保存零、负数、非整数、非安全整数，或提交过期配置 revision
- **THEN** SHALL 拒绝写入并保留编辑内容

### Requirement: Explicit execution concurrency reapproval
执行期间额度变化 SHALL 在用户批准完整新 Manifest 后生效，SHALL 保持 Graph、Run、Task 绑定、其他权限与已消耗预算。保存本身 SHALL 不改变当前批准值。

#### Scenario: Decreased concurrency drains
- **WHEN** 已有 3 个活动包且用户重新批准额度 1
- **THEN** 已有包 SHALL 继续收尾，不接纳新包直到活动数低于 1

#### Scenario: Reapproval rejected
- **WHEN** 用户拒绝批准、审阅过期，或存在未决 mutation、取消或重规划
- **THEN** 当前执行 SHALL 保留原批准额度

