## ADDED Requirements

### Requirement: 集成投影与执行完成事实一致

执行图、串行队列与机器快照 SHALL 从当前 Work Package 的完整集成事实投影状态。仅有 Validator 接受结果或部分 Git 步骤成功时 SHALL 显示等待集成；完整集成完成时 SHALL 显示 accepted，且其依赖节点可据此进入 Frontier。

#### Scenario: 已验证但只完成部分集成

- **WHEN** Work Package 的 Validator 已通过，Git commit 或 canonical merge 已成功，但 push 尚未被接受
- **THEN** Sidebar 与 `status --json` 仍显示等待集成，该包的依赖节点不因此获得可派发资格

#### Scenario: 完整集成后的投影

- **WHEN** Work Package 的完整集成已被接受
- **THEN** Sidebar 与 `status --json` 显示 accepted，该包退出 integration queue，依赖节点可据此推进
