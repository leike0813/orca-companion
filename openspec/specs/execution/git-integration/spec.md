# execution/git-integration Specification

## Purpose

定义在 Validator 接受结果之后，Execution Coordination Lease holder 如何按 Execution Authorization 的 Git Integration Policy 执行受控的普通 commit、canonical 分支集成与唯一获批 remote/ref 推送。

## Requirements

### Requirement: 集成以 Validator 接受的结果为前提

Controller SHALL 仅在某个 Work Package 的 Validator 接受了结果、且该 Work Package 处于已接受状态之后，才为该结果执行 Git 集成。Controller SHALL NOT 集成未验证、被拒绝或仅处于实现完成状态的成果。集成的每一侧效应 SHALL 具备可信 Execution Scope、稳定 OperationId、明确目标、expected HEAD、超时与可核验结果。

#### Scenario: 已接受结果才可集成

- **WHEN** 某 Work Package 的 Validator 接受结果，且 Execution Coordination Lease 由当前 Session 持有
- **THEN** 允许为该结果按 Git Integration Policy 创建集成操作

#### Scenario: 未验证结果不集成

- **WHEN** 某 Work Package 仅完成实现但尚未通过验证
- **THEN** Controller 不执行任何 Git 集成或推送

### Requirement: 集成操作限制在授权范围内

Controller SHALL 只在 Execution Authorization 的 Git Integration Policy 允许的范围内创建普通 commit、集成 canonical 分支并推送唯一获批的 remote 与 ref。force-push、历史改写、发布与部署 SHALL 不在默认权限内，需要时 SHALL 取得单独授权。

#### Scenario: 越界 Git 操作被拒绝

- **WHEN** 某次集成请求指向未获批的 remote、ref 或要求 force-push
- **THEN** Controller 拒绝该请求并报告越界的部分

#### Scenario: 授权内的普通集成执行

- **WHEN** 集成请求落在获批 remote、ref 与普通 commit 范围内
- **THEN** Controller 执行该集成并按 expected HEAD 核验结果

### Requirement: 未归属的 canonical 分支变化暂停派发

当 canonical 分支 HEAD 或 worktree 发生无法归属到某条已记录 Integration Operation Intent 与其已接受来源的变化时，Controller SHALL 将该情况判定为 Unattributed Drift，并暂停新的派发，直到确定该变化是否仍落在当前授权内。

#### Scenario: 检测到未归属变化后暂停派发

- **WHEN** canonical 分支 HEAD 前进但无法对账到任何 Integration Operation Intent
- **THEN** Controller 暂停新派发，并报告需要确认该变化是否在授权范围内