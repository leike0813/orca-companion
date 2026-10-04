## ADDED Requirements

### Requirement: 命令连按与待核验恢复
同一目标的在途控制/维护/确认调用 SHALL 不因连按重复提交。unknown SHALL 保留可信结果引用并沿原引用核验；没有可证明终态时 SHALL 保持待核验，MUST NOT 换操作身份盲重试。UI SHALL 只读既有业务记录，不建立复制业务状态的持久命令账本。最上层审阅/确认 SHALL 拦截无关全局导航；Ctrl+C SHALL 仍走原退出规则。

#### Scenario: 连按与未知响应
- **WHEN** 用户连按确认或控制键，宿主返回 unknown
- **THEN** 只提交一次，持续呈现待核验并保护原输入；核验读取原引用，不产生第二次 mutation

#### Scenario: 审阅键位不穿透
- **WHEN** 用户在审阅或危险态确认中按 Ctrl+P/B/G 或取消返回
- **THEN** 不执行底层导航或批准，Ctrl+C 仅调用原退出流程，返回恢复原上下文
