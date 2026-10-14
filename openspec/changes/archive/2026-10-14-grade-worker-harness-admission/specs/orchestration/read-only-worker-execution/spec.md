## MODIFIED Requirements

### Requirement: doctor 与授权审阅暴露同一能力结论

doctor 与授权审阅 SHALL 对实际需要只读的 Recovery Utility/纯分析任务核验对应能力。普通 Validator 与可写 Finalizer 不因只读能力缺失而拒绝。旧只读 Finalizer 按原授权继续核验。

#### Scenario: 授权前发现本机只读沙箱不可用
- **WHEN** 启用 Recovery Utility 的授权所绑定 harness 缺少只读能力
- **THEN** 对应检查拒绝，不影响关闭 Recovery 的普通可写角色

#### Scenario: 环境修复后重新审阅
- **WHEN** 当前只读探针重新通过
- **THEN** 按实际新结果审阅，不永久锁住 Scope

### Requirement: 执行期按受限能力失败关闭

只读 Task SHALL 在派发前单独核验 readOnly 能力组及真实拒写探针。失败仅阻塞依赖它的任务，不能降低通用等级、自动更换 harness 或扩大权限。

#### Scenario: Recovery 前能力不可用
- **WHEN** Recovery Utility 不能证明当前只读能力
- **THEN** 派发前阻塞，零新 Task/Dispatch，不以更宽权限执行

#### Scenario: Finalizer 前能力不可用
- **WHEN** 可写 Finalizer 没有只读能力但满足自身准入和授权
- **THEN** 正常派发；旧只读 policy 仍单独要求只读能力

#### Scenario: 已派发角色遇到能力变化
- **WHEN** 任务已派发后环境变化
- **THEN** 以原身份对账，不换 ID 重试或编造终态
