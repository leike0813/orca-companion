## Context

基线 b15ff20 已将权威消息正文分块，keyset 最多 100 项/64 KiB、正文范围最多 64 KiB、持久块 16 KiB。Transcript 当前仍 flatMap 整页换行，numeric scrollOffsets 无原文身份；模型节点 invoke 完整返回，没有预览。IC-04/11/12 为扩展接缝，IC-13 保持不变。

## Goals / Non-Goals

完成 #46 的 3B 生产阅读与流式接线。第四批的活动分组/详情、F3 搜索、Ctrl+R 历史和后续配置不进入本 change。

## Decisions

### D-01：原型和前驱

采用 predecessor-contract；前驱 `paginate-coordinator-history` 已在 `archive/2026-10-03-paginate-coordinator-history` 归档，主规格已同步。六票最终决议、源码与代表画面直接沿用 [纠偏 design D-01](../archive/2026-10-03-align-tui-with-approved-prototypes/design.md#d-01六张原型票直接作为设计参照)，主代理逐票读源与看图。P-40 continuous、P-47 above-input、P-51 tabs、P-52 final、P-48 custom-direct、P-43 adaptive 的布局不重设计。语义以该表链接的 #41/42/44/45/50 为准；性能以 [#53](https://github.com/leike0813/orca-companion/issues/53#issuecomment-5945507505)、批次以 [#46](https://github.com/leike0813/orca-companion/issues/46#issuecomment-5946016892) 为准。

### D-02：应用读取与来源身份

Application 复用 HistoryMetadataPage/HistoryBodyRange，Controller 增加独立窄查询，TUI 不读取 storage。正式来源绑定 Session/entryId/contentRevision=1/UTF-8 offset；临时来源绑定 Session/previewId/append revision/offset。历史元数据与正文分离，折叠工具不取正文。anchor 不依赖数组索引或全历史高度。读失败不改变旧 frame，异步结果按 Session 和 request generation 拒绝。render/effect/resize 可查询局部正文，不写业务事实。

### D-03：深阅读模块与有界缓存

MOD-06 的 transcript-reader 拥有来源导航、局部换行、Markdown 和双 LRU，不分散到 app。正文/布局各 8 MiB/64 项，保守计入字符串、位置索引和派生结构；固定阅读和可变尾部计入同一额度。仅当前 Session 有正文缓存，其他 Session 只保存标量锚点。可见前后各一视窗缓冲，读取以 16 KiB 为基本块、最多 64 KiB；有限工作轮次让出 event loop。工具展开、resize 和更新均从当前原文锚点局部求行，不计算总高度。PgUp/PgDn、Ctrl+Home/End、Esc 沿 #41，overlay 先消费 Esc。

### D-04：有限 Markdown

Marked 17.0.1 是用户批准的直接生产依赖。普通块最多 64 KiB，有已知上下文时延续 fenced-code 等有限状态；冷读中段、巨大单段/表格/列表显示原文，避免扫描完整前缀。行携带原文范围，复用现有显示宽度与 grapheme 规则。确认的稳定块复用布局，可变尾部最多 16 KiB，迟到引用定义只失效有限块或采用原文。finish/resize 不触发完整重解析。拒绝按整条消息保留 AST 或引入固定行高虚拟列表。

### D-05：真实流式与临时存储

Workflow 通过 application 的 TranscriptStreamObserver 发布 started/delta/interrupted/committed，宿主信任地生成 step/attempt/preview 身份，模型不提供。节点调用 stream，等待 SDK handleLLMEnd（_awaitHandler=true）的唯一聚合响应，不另 concat。完整响应沿既有原子 appendModelStep 接受后发布 committed 并继续工具；预览失败不重试模型。纯 metadata/usage chunk 可为空。

storage 的临时 preview adapter 用 runtime 临时目录、分块追加与范围读取，容量 64 MiB/64 个响应，不作为 checkpoint 或重启事实。旧预览被固定时仅引用同一 append-only 前缀，版本不复制正文。容量/文件故障明确 not_saved；先淘汰未固定终态，仍不足则停用该预览而不阻止正式提交。订阅只发来源失效通知并合并到约 30fps，不进入最近事件、不重新读全 Scope。正式文本一致时关联可信 entry；结构化块沿已有 JSON 原文规则，不能伪造预览与正式原文的偏移对应，离底固定预览直到显式返回最新。

### D-06：预算、取消和 usage

output.maxResponseBytes 默认 8 MiB，context.maxReadBytes 默认 16 MiB，均有限正整数；配置缺省由 bootstrap 归一化。Storage 选项接收读取预算；正文、元数据及 capsule/native window 保持受限，SQL 的固定读取界限随配置调整，既有 maxInputTokens 和 4096 项保持。输出字节涵盖文本/内容块及工具参数，超限 abort 且非重试，历史不接受片段。既有结构化元数据预算仍有效。

Runtime 持有每 Session 调用的 AbortController，signal 经 graph/node 传递。Scope Cancel 持久意图后调用注入 stopModels 端口，再请求 Worker 停止；fencing 和 close 中止活跃调用，Pause 不中止。AbortError、ModelAbortError、输出超限和 fenced 均不重试；其他故障仍最多三次。

usage 只有单个可确认的完整报告才记录；多个有值片段不猜合并，usage=null。缺失/不确定显示不可用。SDK/其完整响应聚合和输入上下文内存单独测量，不声称全进程 RSS 固定。

### D-07：验收与文件归属

主代理拥有 TUI、应用读取/预览接口、preview store、Bootstrap、文档和验收。独立 agent 只实现 workflow 流式调用，另一 agent 只实现配置/上下文 storage；文件不交叉。所有委派用 minimax-cn/MiniMax-M3.1-Flash-Preview。

扩展已有行为测试，真实 streaming fake 经同一生产 graph/reader，不以接口 demo 或整屏 snapshot 代替接线。1千/1万/10万不同记录与 1/5 MiB 正文、工具输出各测输入/已缓存导航至少 100 次，p95≤100ms；冷读、commit、SDK 聚合、双缓存、RSS 分开。三档/彩色与无色/Nerd与ASCII画面对照六票来源，保留后续缺口。

## Risks / Trade-offs

任意冷读 Markdown 中段不能无界重建全文语义，原文回退保持可读性。LangChain 自身仍聚合完整响应，8 MiB 是输出硬界而不是 RSS 保证。临时预览可以丢弃，正式已提交原文仍为唯一权威。有限上下文超限继续阻塞，不自动扩大或截断。

## Migration Plan

串行创建工件，检查前驱，按 IP 实施后更新文档/工件报告。保持 checkpoint schema 2、UI schema 2、Coordination schema 14；未发布首版不构建历史兼容层。保留用户工件迁移，不提交/归档，不提前创建 verification。

## Open Questions

无阻塞项；Marked、两项默认预算及不明确 usage 留空已由用户确认。
