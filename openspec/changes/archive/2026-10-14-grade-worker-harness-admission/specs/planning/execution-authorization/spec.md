## MODIFIED Requirements

### Requirement: Model-bound authorization and explicit model reapproval

新 Manifest v5 SHALL 固定角色模型、支持等级及资格证据引用，Recovery Utility 为显式配置或 null；null 表示历史恢复关闭。v4 SHALL 保留原合同与指纹读取，不转换为基础绑定或关闭恢复。v1/v2/v3 SHALL 拒绝。执行期限定重新授权 MAY 更新模型、支持绑定、Recovery 选择或并行额度，保持 Graph、Run、权限、其他上限与预算消费；取消、重规划及未决 mutation SHALL 拒绝。

#### Scenario: 重新批准生效于新任务
- **WHEN** 用户保存配置后审阅并批准完整新 Manifest
- **THEN** SHALL 追加唯一授权并推进当前指针；既有 Task 不重启且预算不重置

#### Scenario: 陈旧审阅或重复批准
- **WHEN** graph head 或 Scope revision 在审阅后变化，或重复提交原批准
- **THEN** 陈旧输入 SHALL 无部分更新地拒绝，同载荷重放 SHALL 回读原记录

#### Scenario: 旧 Manifest 明确拒绝
- **WHEN** 读取 Manifest v1、v2 或 v3
- **THEN** SHALL 以结构化原因拒绝，不补默认模型选择、不按当前配置推断

#### Scenario: 关闭恢复
- **WHEN** 用户批准 Recovery Utility 为 null 的 Manifest
- **THEN** 正常运行获准角色；中断需要历史恢复时明确阻塞并保留产出与预算

#### Scenario: 旧授权仍可读取
- **WHEN** 已有 v4 Task 返回结果
- **THEN** 沿原授权及原生 Session 合同结算，不使用新等级或当前 profile 改写其含义

## ADDED Requirements

### Requirement: Explicit project finalizer repair authorization

新授权 MAY 包含 `finalizerPolicy: {mode: 'repair', repairLimit}`；额度 SHALL 为正安全整数且不超过既有 Validator 修复上限，并同时要求 Finalizer 与 Git Integration 权限。授权审阅 SHALL 展示修复与复验、额度和受控集成。缺该字段的授权 SHALL 保持只读；v4 SHALL 拒绝携带该字段。已准入 Finalizer 的权限、模型与预算 SHALL 始终读取原授权。

#### Scenario: 原授权不扩大权限
- **WHEN** 读取缺 finalizerPolicy 的 v4 或 v5 授权
- **THEN** Finalizer SHALL 继续只读；不能按当前配置开启代码修改

#### Scenario: 修复准入重放
- **WHEN** 同一图世代的 Finalizer 准入被重放或执行授权被重新批准
- **THEN** SHALL 保留原基线与授权，不重复扣费、不重置已消费额度
