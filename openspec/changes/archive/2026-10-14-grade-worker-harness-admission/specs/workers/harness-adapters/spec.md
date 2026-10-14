## MODIFIED Requirements

### Requirement: 应用层 WorkerHarness 端口与显式注册表

Companion SHALL 经应用端口访问显式登记的 adapter，登记与准入分别表达。启动和原生模型查询为公共能力，精确会话、只读、续接和恢复 SHALL 按可选能力组提供。未登记身份 SHALL 在派发前拒绝。启动 SHALL 继承真实用户环境，不接收 Coordinator 凭据、不覆盖原生认证；能力不足 SHALL 结构化拒绝，不自动回退。

#### Scenario: 已注册 harness 进入既有生命周期
- **WHEN** Manifest 绑定的角色 profile 引用一个已注册 harness
- **THEN** Controller 用该注册实现完成启动、恢复与绑定，生命周期、预算与验收语义不变

#### Scenario: 未注册 harness 在派发前拒绝
- **WHEN** 配置或 Manifest 引用未注册 harness id
- **THEN** Controller 在派发前以结构化原因拒绝，且不修改已批准绑定或产生任何外部操作

#### Scenario: 注册表唯一且显式
- **WHEN** bootstrap 装配 Worker Harness 端口
- **THEN** 每个 harness id 只对应一个显式实现，不按目录扫描或运行时自动注册

#### Scenario: 启动输入不含凭据与原生隔离
- **WHEN** 任一注册项准备启动或恢复
- **THEN** 启动输入不含凭据或可覆盖原生环境的隔离 root；resume 携带的 `expectedNative` 只作核验，真实 launch 环境不被改写

#### Scenario: 恢复按 adapter 的精确历史语义读取
- **WHEN** Recovery 需要复核 transcript 身份并读取原 Session 历史
- **THEN** 使用该注册项的身份复核与读取配方，无法证明时阻塞，不把其它 harness 的格式或活动分支语义套入原 transcript

#### Scenario: 已登记但未验证
- **WHEN** adapter 已实现而基础真实证据缺失
- **THEN** 可展示其身份及未验证原因，但不能派发

### Requirement: 新候选以真实能力证据纳入

候选 SHALL 按 harness-support 的等级合同取得准入，不要求基础角色通过全部角色、完整历史和 Recovery。证据 SHALL 保留版本、环境、资源身份及缺口且不包含秘密。缺少原生模型目录 MAY 手填 exact ID，不捏造 effort。

#### Scenario: 完整证据后纳入候选
- **WHEN** 新候选在独立测试项目中通过全部必要能力与真实角色、恢复和隔离验证
- **THEN** 将已登记 adapter 的支持等级提升为 complete，并提供一致的模型选择、支持等级与 doctor 能力结果

#### Scenario: 缺必要能力时排除
- **WHEN** 候选无法证明基础级必要能力（输入、精确 Orca 归属、Planner 与 Implementation 结果及产出核验）
- **THEN** 记录证据与准入拒绝原因，不授予 basic、不派发、不伪造身份、不放宽权限；更高等级的能力缺口只限制需要这些能力的操作，其他候选继续验证

#### Scenario: 未运行的验收如实保留
- **WHEN** 登录、安装或真实测试尚未完成
- **THEN** 该项标记待验证，不把官方接口说明或历史 PASS 当作本轮运行证据

#### Scenario: 模型响应不回显 ID
- **WHEN** 启动固定获批 exact ID、基础任务通过，而 provider 不回显模型或 usage
- **THEN** 按执行证据准入并显示模型/usage 未验证，不推算费用

### Requirement: 隔离启动与精确 provider session 身份

adapter SHALL 在 harness 真实用户环境启动，非秘密 runtime roots 由真实 launch 环境解析。增强和完整级 SHALL 使用独立核验的精确 provider session 与 transcript，不按 cwd/mtime/最近会话推断；基础级 MAY 只使用真实 Orca Worker 执行绑定。原生证据冲突 SHALL 阻塞原生能力操作，不伪造原生身份。

#### Scenario: 四个 harness 各自给出精确绑定
- **WHEN** claude、pi、omp 或 opencode 的增强或完整级 Dispatch 报告其 hook、extension 或公开 metadata 身份
- **THEN** adapter 只在该 harness 的 id、path 与观察窗口一致且候选唯一时签发原生 Session Binding，否则返回不可用

#### Scenario: opencode 不以数据库或终端猜身份
- **WHEN** opencode Dispatch 需要读取输出或 transcript
- **THEN** adapter 只使用 `--standalone` 子进程的公开 metadata 与分页消息接口，不直接打开其 SQLite 存储、不按屏幕输出猜 session

#### Scenario: 陈旧观察不推进绑定
- **WHEN** 某次观察早于该 Dispatch 的启动窗口，或同一 Dispatch 出现多个候选 session
- **THEN** adapter 判定绑定不可用并阻塞该 Dispatch，不用较旧或较新的候选替代

#### Scenario: runtime roots 只含非秘密路径
- **WHEN** 启动报告登记进程实际使用的原生根目录
- **THEN** 报告只含路径与标识等非秘密字段，可被恢复与只读包装器复用，不落整份环境变量

#### Scenario: 基础级没有 SessionStart
- **WHEN** 已获准基础任务未提供原生 Session 报告
- **THEN** 按真实 Orca 执行绑定结算，不填造 Session 或 transcript
