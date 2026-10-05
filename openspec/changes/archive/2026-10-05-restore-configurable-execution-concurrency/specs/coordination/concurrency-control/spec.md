## ADDED Requirements

### Requirement: Atomic Work Package lane admission
唯一 Execution Coordination Lease holder SHALL 按当前批准的并行包额度推进多个独立 Work Package，每包 SHALL 最多有一个在途角色 Worker。建立外部资源前 SHALL 原子占用额度，派发尚不可见、角色交接、恢复和待集成 SHALL 继续占用。unknown SHALL 沿原身份对账，只有可证明的完成或终止 SHALL 释放额度。

#### Scenario: Concurrent callers cannot oversubscribe
- **WHEN** 多个调用者争用最后一个额度
- **THEN** 至多一个新包 SHALL 被接纳，其余调用 SHALL 不建立外部资源

#### Scenario: Restart before worker observation
- **WHEN** 派发已接受但 Worker 列表尚不可见时进程重启
- **THEN** 原包 SHALL 继续占用额度，恢复 SHALL 不重复派发

#### Scenario: Prepared terminal title changes
- **WHEN** terminal-create 已被接受而 shell 或 TUI 改写显示标题
- **THEN** 恢复 SHALL 使用原创建回执的精确句柄，并在原 worktree 内重新核验资源；缺原句柄或资源失效 SHALL 阻塞所属 lane，不能重复创建或按标题猜身份

### Requirement: Lane-local blockers
包级未知、恢复和修订 SHALL 仅冻结受影响包及依赖后继，独立包 SHALL 继续推进。全局共享事实不可证明及 Scope 控制 SHALL 保持全局门禁。

#### Scenario: One blocked lane
- **WHEN** 一个包的外部操作未知但其他独立包的事实完整
- **THEN** 其他包 SHALL 在额度内继续工作
