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

### Requirement: 完整集成以获批目标的推送结算为界

Controller SHALL 仅在当前 Work Package 的完整 Git 集成已按获批 remote/ref 推送、结果确定并被接受后，将该包判为集成完成。commit 或 canonical merge 的单步成功 SHALL NOT 代替完整结论；中断后 SHALL 沿稳定操作身份核验并继续剩余步骤。

#### Scenario: commit 后中断

- **WHEN** commit 已被接受，但 canonical merge 或 push 尚无已接受结论时进程中断
- **THEN** 恢复后该 Work Package 仍待集成，已完成步骤沿原身份核验，未完成步骤在授权与对账门禁满足后继续

#### Scenario: 推送结算完成

- **WHEN** 当前 Work Package 的 push 到获批 remote/ref 已确定结算并被接受
- **THEN** Controller 将其判为集成完成，后续触发不会为该包创建第二次集成

### Requirement: Merged-tree validation before serial integration
Work Package SHALL 可乱序完成，canonical 集成 SHALL 串行。canonical 前移后，该包 SHALL 合并已归属的新 HEAD，并由原 Validator Session 在原 Validation Attempt 内处理范围内冲突和复验。接受证据 SHALL 绑定该轮、原结果、目标 HEAD 与已复验树；通过后 Controller SHALL 创建普通 merge commit，并以 expected HEAD 核验推进 canonical。

#### Scenario: Independent package finishes later
- **WHEN** 另一包已推进 canonical，当前包验证完成
- **THEN** 当前包 SHALL 同步并复验合并树后集成，不因分支分叉永久阻塞

#### Scenario: Session or evidence mismatch
- **WHEN** 无法核验原会话、当前树与接受证据不一致，或 canonical 再次前移
- **THEN** SHALL 不集成未经复验的树；再次同步受独立预算限制

#### Scenario: Canonical inputs are distinct from Validator repairs
- **WHEN** canonical 合入其他已授权包的文件，Validator 复验合并树
- **THEN** 验证证据 SHALL 可覆盖这些输入；冲突路径与报告的 filesModified SHALL 单独按本包授权范围核验，越界修复 SHALL 阻塞

### Requirement: Bounded integration reconciliation
每包 SHALL 默认有 2 次可配置集成复验额度，独立于 Validator 修复预算。每轮 SHALL 持久关联原 Validation Attempt 与唯一续接 Task/Dispatch，重启和重放 SHALL 不重复消费或伪造原 Dispatch 的新完成结果。

#### Scenario: Budget exhausted
- **WHEN** 所需同步次数超过批准上限
- **THEN** 当前包 SHALL 阻塞并升级，不重置预算