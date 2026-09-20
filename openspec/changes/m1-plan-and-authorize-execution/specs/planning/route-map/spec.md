## Purpose

定义 Route Map 与 Decision Ticket 的权威归属、固定章节更新方式与 Ticket Claim 语义，使多个 Coordinator Session 能在同一 Scope 内安全地共同推进规划。

## ADDED Requirements

### Requirement: Route Map authority and fixed-section updates

Route Map SHALL 以 issue tracker 中的地图票据为唯一权威，Decision Ticket SHALL 以 tracker 票据为唯一权威，Companion SHALL NOT 在本地保存地图或票据的完整副本；地图更新 SHALL 只作用于配置的地图票据及其直属 Decision Ticket，并按固定章节结构写入 destination、resolved decisions、open Decision Tickets、dependencies、fog 与 scope boundaries。

#### Scenario: 本地不保存地图副本
- **WHEN** Companion 读取 Route Map
- **THEN** 内容 SHALL 来自 issue tracker，本地 SHALL 只保存地图与票据的外部引用

#### Scenario: 用户提供的计划只作参考
- **WHEN** 用户提供 roadmap、OpenSpec、任务列表或既有计划
- **THEN** Coordinator SHALL 将其视为 Planning Reference，SHALL NOT 直接执行、导入为权威成果或跳过正式规划

#### Scenario: 写入固定章节
- **WHEN** Coordinator 更新 Route Map
- **THEN** 更新 SHALL 落在固定章节内，SHALL NOT 改动配置地图之外的文件、代码、OpenSpec 或项目文档

#### Scenario: 复述已解决决策不新增章节
- **WHEN** 一个 Decision Ticket 被解决
- **THEN** 其结论 SHALL 写入 resolved decisions 章节，且 SHALL NOT 创建新的章节结构或平行的第二份地图

### Requirement: Ticket Claim binds a ticket to one Session

一个开放 Decision Ticket SHALL 同时最多由一个 Coordinator Session 持有；Claim SHALL 由 tracker assignee 与该 Session 的本地记录共同表达，并 SHALL 在 Runtime Incarnation 退出后继续存活。

#### Scenario: 已认领票据不出现在 Frontier
- **WHEN** 一个开放未阻塞票据已被某 Session 认领
- **THEN** 该票据 SHALL NOT 出现在其他 Session 的 Frontier 中

#### Scenario: 进程退出不释放认领
- **WHEN** 持有 Claim 的 Runtime Incarnation 退出
- **THEN** Claim SHALL 保持，只有完成、显式释放或用户授权转移才改变持有者
