# workers/harness-support Specification

## Purpose

定义 Worker Harness 的证据状态、递进支持等级与角色准入，让已验证的最小执行能力可独立使用，同时准确保留只读、精确会话及历史恢复的实际限制。

## Requirements

### Requirement: Evidence-derived progressive support

Companion SHALL 从真实能力证据推导 unavailable、basic、enhanced、complete 递进等级。basic SHALL 要求输入、精确 Orca 归属、Planner 与 Implementation 结果及产出核验；enhanced SHALL 增加精确原生 Session、续接及 Validator/Finalizer 实测；complete SHALL 增加完整历史、Recovery 与 mixed Controller。只读 SHALL 为任务级可选能力，不参与通用等级推导。缺失、失败和未运行 SHALL 分别记录；模型回显、usage 与目录 SHALL 仅展示，不作为等级门槛。

#### Scenario: 缺少只读不降低通用等级

- **WHEN** harness 满足增强或完整级证据，但没有只读能力
- **THEN** 保留相应通用等级；仅拒绝需要只读的 Utility 或纯分析操作

#### Scenario: 可用单次能力独立准入

- **WHEN** 基础证据齐备而历史恢复未验证
- **THEN** 正常开放单次 Planner/Implementation，不能派发不受支持的角色或恢复操作

#### Scenario: 环境变化复核

- **WHEN** 运行环境或公开接口变化
- **THEN** 保留历史证据，复核受影响能力；失败或不确定阻塞相关操作，不自动换 harness 或重新派发

#### Scenario: 显式真实验收

- **WHEN** 启动或 doctor 检查环境
- **THEN** 只做轻量能力复核；真实任务资格验收由显式操作运行，不自动消耗模型费用