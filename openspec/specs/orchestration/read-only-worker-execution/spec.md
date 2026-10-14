# orchestration/read-only-worker-execution Specification

## Purpose

定义本机只读 Worker Harness 的可运行性与权限核验：只读作为任务级可选能力，只对实际需要只读的操作在派发前核验受限命令确实可执行，并在能力缺失时给出明确、可恢复的阻塞原因。

## Requirements

### Requirement: 只读 Worker 能力必须由实际执行证明

Companion MUST 使用与各只读角色实际启动相同的 harness 权限配置与受限包装器核验本机能力。成功结论 MUST 同时证明受限命令可运行、允许读取指定输入、拒绝修改指定项目文件；版本、配置声明、bwrap 可执行文件存在或会话启动成功本身均不足以证明该能力。探测失败、超时或结果无法核验时，能力 MUST 为不可用或未知，且 MUST 保留可诊断的阶段与原因。探测 SHALL 不调用模型、不使用真实项目文件作为写入目标，也不修改现有 Scope；包装器 SHALL 使仓库、Git 事实、Git common dir 与协调库只读，只允许该 harness 真实原生 state 目录与 Companion 工件目录写入，coordination.sqlite 不可写；native 可写根与拒写根重叠且无法分离证明时 MUST 判为不可用，SHALL NOT 改用更宽权限。

#### Scenario: 受限命令可用且拒绝写入

- **WHEN** 同一只读权限配置与包装器下的命令成功读取探针文件，且对探针文件的写入被拒绝、内容保持不变
- **THEN** Companion 将本机只读 Worker 能力标记为可用，并报告所核验的 harness 版本与权限配置

#### Scenario: 会话能启动但命令不能执行

- **WHEN** harness 会话启动成功，但受限命令因沙箱、命名空间或挂载错误无法运行
- **THEN** Companion 将能力标记为不可用，报告失败阶段与诊断，SHALL NOT 将会话启动视为可用

#### Scenario: 无法证明只读边界

- **WHEN** 探针写入成功、结果超时或无法确认写入是否被拒绝
- **THEN** Companion SHALL NOT 报告只读能力可用，也 SHALL NOT 自动改用更宽松的权限

#### Scenario: 多 harness 只读能力分别成立

- **WHEN** 执行授权绑定的只读角色使用不同 harness
- **THEN** 每个被引用的 harness 分别以生产同一包装器核验，任一不可用只阻塞依赖它的角色

### Requirement: doctor 与授权审阅暴露同一能力结论

`doctor` 与 Execution Authorization 审阅 SHALL 暴露同一只读能力结论：只读是任务级可选能力，只对实际需要只读的操作（Recovery Utility、只读 Graph Patch/规划辅助操作、原授权 policy 为只读的 Finalizer）在派发前核验对应 harness 的能力组与真实拒写探针。普通 Validator 与可写 Finalizer MUST NOT 因缺少只读能力而被拒绝；不参与等级推导，也不因此降低通用等级。

#### Scenario: 授权前发现本机只读沙箱不可用

- **WHEN** 启用 Recovery Utility 的授权所绑定 harness 缺少只读能力
- **THEN** 对应检查拒绝，不影响关闭 Recovery 的普通可写角色

#### Scenario: 环境修复后重新审阅

- **WHEN** 当前只读探针重新通过
- **THEN** 按实际新结果审阅，不永久锁住 Scope

### Requirement: 执行期按受限能力失败关闭

只读 Task SHALL 在派发前单独核验 readOnly 能力组及真实拒写探针。失败仅阻塞依赖它的任务，不能降低通用等级、自动更换 harness 或扩大权限。已派发 Worker 的结果仍按其原有 Dispatch、Session 与 Delivery 身份对账；能力结论变化不得创建第二次派发或替代既有事实。

#### Scenario: Recovery 前能力不可用

- **WHEN** Recovery Utility 不能证明当前只读能力
- **THEN** 派发前阻塞，零新 Task/Dispatch，不以更宽权限执行

#### Scenario: Finalizer 前能力不可用

- **WHEN** 可写 Finalizer 没有只读能力但满足自身准入和授权
- **THEN** 正常派发；旧只读 policy 仍单独要求只读能力

#### Scenario: 已派发角色遇到能力变化

- **WHEN** 任务已派发后环境变化
- **THEN** 以原身份对账，不换 ID 重试或编造终态