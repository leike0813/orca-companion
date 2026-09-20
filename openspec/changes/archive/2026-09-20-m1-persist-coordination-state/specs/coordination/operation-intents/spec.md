## Purpose

定义 Companion 自有副作用意图的持久化契约：在任何外部变更之前先记录稳定操作身份与预期目标，变更后核验并收尾，崩溃恢复时以同一操作身份对账，使「不确定就没有发生」的假设不被容忍。

## ADDED Requirements

### Requirement: 副作用前先持久化意图

在执行任何外部 mutation 之前，store SHALL 先持久化一条 Operation Intent，包含稳定 OperationId、目标、预期 revision、发起 Session 与时间；SHALL NOT 在执行外部变更后才补写意图。

#### Scenario: 意图先于外部调用

- **WHEN** controller 准备执行一次外部 mutation
- **THEN** store SHALL 在外部调用发生前已存在该 OperationIntent 记录

#### Scenario: 重复 OperationId 被拒绝

- **WHEN** 同一 OperationId 被再次登记且未处于可重入状态
- **THEN** store SHALL 拒绝并返回既有记录，SHALL NOT 创建第二条意图

### Requirement: 意图收尾与对账入口

外部 mutation 返回后，store SHALL 支持把意图标记为已收尾并记录其结果分类；当结果为未知或缺少可信结果时，store SHALL 保留该意图为未决，使恢复过程能按原 OperationId 对账，SHALL NOT 换 ID 重试。

#### Scenario: 确定结果收尾

- **WHEN** 外部 mutation 返回确定结果
- **THEN** store SHALL 把该意图标记为已收尾并记录结果分类

#### Scenario: 未知结果保留为未决

- **WHEN** 外部 mutation 结果未知或响应丢失
- **THEN** store SHALL 保留该意图为未决，恢复时 SHALL 按原 OperationId 对账

#### Scenario: 对账仍不确定时阻塞通路

- **WHEN** 对账后仍无法判定副作用是否发生
- **THEN** store SHALL 把该 mutation lane 标记为阻塞，且该 lane 上的新变更 SHALL 被拒绝
