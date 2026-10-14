## MODIFIED Requirements

### Requirement: Finalizer 使用新的只读项目级会话

Finalizer SHALL 使用新的独立项目级 Session。显式批准 finalizerPolicy 的授权 SHALL 允许 Finalizer 在项目级隔离 worktree 内修复已批准 Scope Envelope 内的缺陷并生成测试产物；修复后 SHALL 复验并报告最终代码版本与证据。原授权缺少修复 policy SHALL 继续保持原只读权限，不能由当前配置自动补写。

#### Scenario: 全部通过后派发只读 Finalizer
- **WHEN** 所有 Work Package 已通过验证并完成集成且没有未决工作
- **THEN** 按原授权 policy 派发新的 Finalizer；有修复授权时可写，旧只读授权仍为只读

#### Scenario: 存在未决工作时不予收尾
- **WHEN** 有工作包未通过、未集成、交互或未结算 mutation
- **THEN** 不派发 Finalizer，保持未收尾

#### Scenario: 授权范围内修复并生成测试产物
- **WHEN** Finalizer 在授权范围内修复缺陷
- **THEN** 支持测试缓存/构建/报告写入 ignored 或临时目录，核验实际 Git 路径、最终干净 HEAD、复验命令与预算，再受控集成

#### Scenario: 准入重放与重启
- **WHEN** 原 Finalizer 已准入或已派发后重启
- **THEN** 复用原授权、基线、Task/Dispatch/worktree 与 Session，不重复消费预算或换 ID 派发

### Requirement: Delivery Verdict 由独立结论构成并被确定性接受

Controller SHALL 核验独立 Finalizer 的精确身份、覆盖范围、实际改动、最终验证 HEAD/tree 与复验证据。Worker 普通提交后 SHALL 验证最终干净 HEAD，宿主只复用已批准 Git Policy 的 integrate/push 并核验 canonical 最终版本后接受 deliverable。旧 Work Package 验证记录保持历史语义，不能替代对修复后代码的复验；结论 SHALL 持久绑定最终 HEAD/tree，不接受与最终代码不符的旧证据。

#### Scenario: 接受可交付结论
- **WHEN** Finalizer 复验最终代码且授权、范围、预算、集成及精确版本均通过
- **THEN** 记录绑定最终版本的 Delivery Verdict 并投影可交付

#### Scenario: 阻塞结论保持不可交付
- **WHEN** Finalizer 返回阻塞项或修复/复验未通过
- **THEN** 保留真实产出和证据，记录阻塞，不标记可交付

#### Scenario: 发现不一致时阻塞
- **WHEN** 最终 HEAD/tree、范围、预算、身份或证据无法核验或不一致
- **THEN** 拒绝结算或集成，不以旧通过记录掩盖变化

#### Scenario: 交付后版本变化
- **WHEN** 当前 canonical HEAD/tree 或工作区偏离持久交付版本
- **THEN** 展示版本 blocker 与原结论失效，保留历史验证身份
