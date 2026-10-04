## MODIFIED Requirements

### Requirement: 探针只在隔离目标中运行

探针 SHALL 在一次性创建的隔离仓库、专用协调者身份与专用 Run 中运行；其中新派发的真实 Codex Worker SHALL 通过 Worker Profile 显式使用用户当前批准的模型与已核验的连接，不得继承本机默认模型。后续新现场模型为 `minimax-cn/MiniMax-M3.1-Flash-Preview`，已启动现场 SHALL 保持原授权绑定。探针 SHALL NOT 修改用户主项目、SHALL NOT 重启全局 Orca runtime、SHALL NOT 读取或影响无关的既有终端与 workload。

#### Scenario: 使用专用身份

- **WHEN** 探针创建协调者终端与 Run
- **THEN** 探针 SHALL 使用本探针专有的终端、Run 与 worktree，SHALL NOT 复用用户或其它 workload 的身份

#### Scenario: 触碰隔离边界之外

- **WHEN** 探针需要修改主项目、重启全局 runtime 或影响无关 workload 才能继续
- **THEN** 探针 SHALL 停止并报告缺口，SHALL NOT 越界执行

#### Scenario: 未显式固定 Worker 模型

- **WHEN** 探针准备启动真实 Codex Worker，但 Worker Profile 未显式绑定本次用户批准的模型与已核验的连接
- **THEN** 探针 SHALL 在派发前失败，SHALL NOT 使用本机默认模型继续
