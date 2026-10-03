## ADDED Requirements

### Requirement: Bounded local transcript viewport

Transcript SHALL 仅读取、解析和布局可见范围及有限前后缓冲，正文和布局缓存 SHALL 分别同时受 8 MiB 与 64 项约束，包含固定版本、可变尾部及派生结构。阅读位置 SHALL 绑定稳定来源身份、内容版本与原文位置；历史追加、流式更新、resize、工具展开及 Session 返回 MUST NOT 将阅读位置改为全历史行号。非当前 Session MUST NOT 预热正文；折叠工具 SHALL 只读取元数据。最旧/最新定位 SHALL 直接读取目标附近，不遍历中间正文。

#### Scenario: 长历史与巨型消息
- **WHEN** 用户阅读 1000、10000、100000 条不同记录或 1/5 MiB 的正文和工具输出
- **THEN** 实际布局只覆盖局部，缓存不随总历史增长，输入和已缓存导航 p95 SHALL 不超过 100ms；冷读取和 SDK 聚合成本单独记录

#### Scenario: 固定阅读版本与返回
- **WHEN** 用户回看后后台继续流式更新或完成响应，并调整终端宽度、开合工具或 overlay
- **THEN** 当前来源版本、原文锚点与草稿保持；回到最新才采用最新版本，迟到其他 Session 的读取被忽略

#### Scenario: 缓存与读取失败
- **WHEN** 缓存达到条数/字节上限或正文暂时无法取得
- **THEN** SHALL 先缩小预读和淘汰远处内容，不保留超限整条消息；失败保留当前画面和位置并允许重读

### Requirement: Range-aware Markdown and streaming preview

普通 Markdown SHALL 在有限块内解析并保留原文位置映射；跨范围的已知上下文 SHALL 延续。巨大或不支持的结构、未知中段上下文 SHALL 完整显示原文，MUST NOT 为每个范围伪造独立文档或在每次更新/finish/resize 解析整条响应。流式预览 SHALL 保留稳定前缀与有限可变尾部，合并刷新不得丢字。完成提交 SHALL 以可信身份关联正式原文；中断 SHALL 明确标记未提交。临时预览不具重启恢复权威。

#### Scenario: 跨范围 Markdown 与中文
- **WHEN** 代码围栏、引用或中英文/emoji 混排跨过正文范围，或者出现巨大单行、表格与列表
- **THEN** 已知上下文保持一致，原文不丢失，未知/巨大结构可读原文，处理范围有界

#### Scenario: 真流式完成与中断
- **WHEN** 真实模型多次分片返回、完整提交，或在途中失败/取消
- **THEN** TUI 可阅读实时前缀，完成后关联正式 entry；失败预览不冒充历史，不触发发送、模型恢复、工具执行或最近事件噪声
