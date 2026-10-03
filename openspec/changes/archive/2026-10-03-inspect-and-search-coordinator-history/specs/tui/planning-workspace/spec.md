## ADDED Requirements

### Requirement: Semantic activities and retained details

Transcript SHALL 将相邻且语义兼容的只读查询合为探索活动，将变更动作单列；正文或用户消息 SHALL 结束活动组。跨页 SHALL 保持原 call/结果身份和顺序，MUST NOT 将页边界制造为新活动。Ctrl+T SHALL 切整体紧凑/详细，F4 SHALL 进入活动导航，方向键选择、Enter 原位展开/收起，Esc 返回 composer。详情 SHALL 按需读取完整保留参数与结果并保持有界；已知失败和 unknown SHALL 在紧凑态可见，accepted MUST NOT 表示 Worker 完成。

#### Scenario: 跨页查询与变更动作
- **WHEN** 连续查询跨过元数据页，随后发生变更动作或出现正文
- **THEN** 查询仍属于同一活动、调用顺序可审查，变更动作单列且正文结束该组

#### Scenario: 两种详情与失败
- **WHEN** 用户局部展开或切整体详细，并遇到巨大结果、失败或 unknown
- **THEN** composer 保持可见，完整保留内容可局部阅读，紧凑态不隐藏异常，resize 保持原文锚点

#### Scenario: 未加载与缺失
- **WHEN** 关联还在构建、详情未加载、读取失败或确实没有配对结果
- **THEN** 各状态明确区分，读取失败保留原画面并可重试，不猜测执行成功或失败

### Requirement: Independent bounded transcript search

F3 SHALL 打开当前 Session 独立查询，按字面且忽略大小写搜索全部保留已提交消息、参数和结果，包括折叠及未加载内容。搜索 SHALL 固定启动时的已提交历史上界，分批、有界、可取消，不以前置完整布局或全文 Markdown 为条件，不灌满展示缓存。命中 SHALL 映射原文位置并临时展开详情；Enter/Shift+Enter SHALL 切下一个/上一个匹配，Esc SHALL 恢复原阅读锚点、显示模式和手动展开偏好，聊天草稿不变。扫描未完成、失败与无匹配 SHALL 区分；仅查完才报告无匹配。

#### Scenario: 跨块 Unicode 和折叠详情
- **WHEN** 中文、emoji 或大小写折叠匹配位于正文块边界或未加载的工具参数/结果
- **THEN** 通过有限扫描正确命中原文范围，定位只布局附近内容，退出恢复原显示态

#### Scenario: 固定上界与取消
- **WHEN** 搜索中追加消息、改变查询、切 Session 或取消搜索
- **THEN** 本轮不纳入上界之后的记录，旧请求停止推进且迟到结果不覆盖当前界面；聊天草稿与位置保留

#### Scenario: 失败与继续查找
- **WHEN** 一批扫描没有命中但还有历史，或读取失败
- **THEN** 分别显示继续查找或失败/重试，不冒充没有匹配，恢复沿原搜索边界

#### Scenario: 长历史搜索不阻塞输入
- **WHEN** 用户在1000/10000/100000条记录或1/5 MiB详情中搜索
- **THEN** 每批和搜索工作区受限，输入及已缓存导航 p95≤100ms，完整扫描总成本单独记录
