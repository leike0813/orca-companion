# orchestration/read-only-worker-execution Specification

## Purpose

定义本机只读 Codex Worker 的可运行性与权限核验，让 Recovery Capsule Utility Worker 和 Finalizer 仅在受限命令确实可执行时派发，并在能力缺失时给出明确、可恢复的阻塞原因。

## Requirements

### Requirement: 只读 Worker 能力必须由实际执行证明

Companion MUST 使用与实际只读 Worker 相同的 Codex 权限配置核验本机能力。成功结论 MUST 同时证明受限命令可运行、允许读取指定输入、拒绝修改指定项目文件；版本、配置声明、Bubblewrap 可执行文件存在或会话启动成功本身均不足以证明该能力。探测失败、超时或结果无法核验时，能力 MUST 为不可用或未知，且 MUST 保留可诊断的阶段与原因。探测 SHALL 不调用模型、不使用真实项目文件作为写入目标，也不修改现有 Scope。

#### Scenario: 受限命令可用且拒绝写入

- **WHEN** 同一只读权限配置下的命令成功读取探针文件，且对探针文件的写入被拒绝、内容保持不变
- **THEN** Companion 将本机只读 Worker 能力标记为可用，并报告所核验的 Codex 版本与权限配置

#### Scenario: 会话能启动但命令不能执行

- **WHEN** Codex 会话启动成功，但受限命令因沙箱构建、命名空间或挂载错误无法运行
- **THEN** Companion 将能力标记为不可用，报告失败阶段与诊断，SHALL NOT 将会话启动视为可用

#### Scenario: 无法证明只读边界

- **WHEN** 探针写入成功、结果超时或无法确认写入是否被拒绝
- **THEN** Companion SHALL NOT 报告只读能力可用，也 SHALL NOT 自动改用更宽松的权限

### Requirement: doctor 与授权审阅暴露同一能力结论

`doctor` 在既有前置检查通过后 MUST 输出独立的只读 Worker 能力结论及其原因；只读能力缺失时 SHALL 以非零退出码结束。Execution Authorization 审阅 MUST 显示 Capsule Utility Worker 与 Finalizer 的实际只读配置、能力结论和诊断；该结论不可用或未知时，SHALL 阻止批准会依赖这两个角色的执行授权。Route Planning 本身 SHALL 仍可启动。授权审阅不能复用未核验的旧结论；环境或 Codex 版本变化后 MUST 重新核验。

#### Scenario: 授权前发现本机只读沙箱不可用

- **WHEN** 执行授权审阅时只读 Worker 能力不可用或未知
- **THEN** 审阅显示原因并阻止批准，且 `doctor` 报告对应失败检查项

#### Scenario: 环境修复后重新审阅

- **WHEN** 环境变化后重新运行能力核验且读写探针通过
- **THEN** 新审阅可显示能力可用；之前的失败结论 SHALL NOT 永久锁住该 Scope

### Requirement: 执行期按受限能力失败关闭

Capsule Utility Worker 与 Finalizer MUST 保持只读权限。派发前若当前只读命令能力不能核验，Controller MUST 产生带原因的 blocker，不得发起受限 Worker 派发、消耗 Recovery 预算或把 Scope 标为 deliverable。已派发 Worker 的结果仍按其原有 Dispatch、Session 与 Delivery 身份对账；能力结论变化不得创建第二次派发或替代既有事实。

#### Scenario: Recovery 前能力不可用

- **WHEN** 执行态中断需要 Capsule，且本机只读命令能力不可用
- **THEN** Recovery 记录可诊断的能力 blocker，不等待 Capsule 报告超时、不消耗恢复预算、不以更宽权限派发 Utility Worker

#### Scenario: Finalizer 前能力不可用

- **WHEN** 项目满足 Finalizer 门禁，但本机只读命令能力不可用
- **THEN** Controller 显示 Finalizer 能力 blocker，不派发 Finalizer，也不接受 Delivery Verdict

#### Scenario: 已派发角色遇到能力变化

- **WHEN** 受限 Worker 已派发，之后的能力检查失败或进程重启
- **THEN** Controller 按原身份核验该 Worker 的真实状态与结果；未知状态保持阻塞，SHALL NOT 换身份重试或伪造失败结果