## Purpose

定义 M0 真实控制闭环探针的隔离边界与结论要求：探针必须在一次性项目与专用协调身份中证明协调者身份与单 Worker 闭环可用，并把已核验事实与未核验缺口写回兼容性文档，作为后续 change 的实施前置门。

## Requirements

### Requirement: 探针只在隔离目标中运行

探针 SHALL 在一次性创建的隔离仓库、专用协调者身份与专用 Run 中运行；其中真实 Codex Worker SHALL 通过 Worker Profile 显式使用 `minimax-cn/MiniMax-M3`，不得继承本机默认模型。探针 SHALL NOT 修改用户主项目、SHALL NOT 重启全局 Orca runtime、SHALL NOT 读取或影响无关的既有终端与 workload。

#### Scenario: 使用专用身份

- **WHEN** 探针创建协调者终端与 Run
- **THEN** 探针 SHALL 使用本探针专有的终端、Run 与 worktree，SHALL NOT 复用用户或其它 workload 的身份

#### Scenario: 触碰隔离边界之外

- **WHEN** 探针需要修改主项目、重启全局 runtime 或影响无关 workload 才能继续
- **THEN** 探针 SHALL 停止并报告缺口，SHALL NOT 越界执行

#### Scenario: 未显式固定 Worker 模型

- **WHEN** 探针准备启动真实 Codex Worker，但 Worker Profile 未显式绑定 `minimax-cn/MiniMax-M3`
- **THEN** 探针 SHALL 在派发前失败，SHALL NOT 使用本机默认模型继续

### Requirement: 证明协调者身份与单 Worker 闭环

探针 SHALL 在隔离目标中验证：协调者终端身份可执行绑定型命令、Task 可被创建并启动一个受监督 Worker、Worker 回报的完成消息按 task 与 dispatch 正确归属、结果被处理后可确认且确认后不再重放、进程重连后能找回同一 Run 与 Dispatch 且不重复派发。

#### Scenario: 闭环成功

- **WHEN** 协调者创建 Run 与 Task 并启动一个 Worker，Worker 提交完成消息
- **THEN** 探针 SHALL 观察到完成消息的 task 与 dispatch 归属与当前对象一致，并在处理后再确认

#### Scenario: 重连后不重复派发

- **WHEN** 探针以无进程内状态的新调用重新绑定原 Run
- **THEN** 探针 SHALL 找回同一 Run、Task 与 Dispatch，收件箱为空，且 SHALL NOT 产生第二个 Dispatch

### Requirement: 探针结论回写兼容性文档

探针 SHALL 把已核验事实、未核验项与失败原因写入 `docs/orca-compatibility.md`；当协调者身份无法证明时，探针 SHALL 记录最小可复现缺口并据此阻断 M1 与 M2，SHALL NOT 通过伪造身份、直写数据库或私有接口绕过。

#### Scenario: 硬门失败时阻断后续

- **WHEN** 探针无法在隔离目标中证明协调者身份
- **THEN** 文档 SHALL 记录该缺口，且后续 M1 与 M2 的实施 SHALL 被阻断直至缺口解决

#### Scenario: 部分能力未验证

- **WHEN** 某项能力（如 provider transcript 绑定或 runtime 重启后的句柄行为）未被验证
- **THEN** 文档 SHALL 将其保留为未核验项，SHALL NOT 记为已支持