## Context

基线20f0299：checkpoint schema 2 的正文16KiB分块，历史页100项/64KiB，范围64KiB；参数只存在entry metadata，普通summary不含calls。生产Ctrl+T只开合最后一个工具，Ctrl+R未接通。四批消费3B阅读器和IC-13，不改执行状态机。

## Goals / Non-Goals

完成语义活动、有界保留详情、F3搜索和普通发送历史。第五批待答联动及后继配置/偏好不进入；不引入全文索引、第二正文、正则输入或新增依赖。

## Decisions

### D-01：来源与原型

直接前驱 archive/2026-10-03-render-bounded-transcript；六票参照沿纠偏design D-01，语义沿#41/#42/#53、批次沿#46。主代理读源码和画面对照，不导入原型fixture。查找行置于composer上方，保留原边框/留白和三档布局；没有新详情页面。

### D-02：窄读取合同

Application新增history-inspection.ts，拥有CallPosition(sequence/ordinal)、HistoryCall、InspectionSnapshot、CallPageQuery/Page、UserHistoryQuery、参数范围/搜索DTO。TranscriptReadingPort增加可选inspection能力(snapshot/calls/users)；独立消费者未装时明确不可用，生产Bootstrap必须装配。正文source新增arguments分支(entryId/stepId/callId/revision=1)，使用同一body接口；offset/end是参数JSON原文UTF-8字节。调用清单最多100项/64KiB，参数/正文每次64KiB，普通用户页按role=user直接keyset，不先读全体再筛选。Controller增加封闭inspection查询并做schema校验、Scope/Session绑定。

### D-03：轻量关联索引与唯一正文

storage新增可重建调用索引，保存可信call身份/ordinal/category/group及参数在原metadata JSON中的byte range；参数仍在原entry且不复制。参数读取直接substr(CAST(metadata AS BLOB))，不先json_each/json_extract巨大对象。写入已持有本次完整对象时建立定位，提交/索引同事务。已有记录由Bootstrap发起有限补齐：每次≤64KiB metadata、≤100条索引工作，逐16KiB读原JSON并用有限token/span扫描器提取定位，不整条JSON.parse。索引水位显式读回；读取不自发补齐、重建或改业务状态。持久权威格式/schema版本保持，增量索引初始化由adapter/Bootstrap拥有。

### D-04：可信分类与未确定观测

CommittedToolCall增加可选activityKind(query/action/unclassified)，由响应接受点根据同一注册definition.mutating填写，模型不提供。未知分类单列。相邻query合组，user/非空assistant正文/action结束；group identity绑定首call，index只追加/关联当前组，不回扫全历史。完整结果是原tool entry；工具节点在unknown时经原fencing检查，调用可选recordToolObservation端口记录step/call/operation/kind/reason，再沿原blocked返回；观测不补配对结果、不让工具重跑。未观察且无结果为unconfirmed，已配对结果优先。ok/rejected取结构化工具结果摘要，accepted不冒充Worker完成。缺失/未读/失败与调用结果语义独立。

### D-05：活动与局部阅读

transcript-reader唯一拥有source导航、局部布局、Markdown和双缓存；新增活动call元数据，详情包含有限调用头、参数来源与结果来源。Ctrl+T只切全局详细，手动展开集合独立；F4按可信活动身份选择/展开，Esc仅退出导航。跨页组沿index group identity，在固定upperSequence版本内读取成员，不以加载页制造新组。source anchor扩展可指向arguments；工具展开/搜索临时展开/resize仍按原文位置重排。call元数据、组及临时展开结构计入派生8MiB/64项，不预载另一Session。

### D-06：独立有界搜索

Application history-search模块消费history/body/inspection，不依赖Ink。SearchQuery绑定Session、固定upperSequence、target(transcript/user)、literal、direction与位置游标；SearchPage返回≤50命中/64KiB、continuation、complete、实际读回计量。单批正文含重叠≤64KiB、metadata≤100项/64KiB；扫描逐块让出，signal在批/块间检查。搜索workspace≤1MiB/64项，保留有限结果页和scalar游标，不保留全部hits；不写展示缓存。字面使用转义Unicode /iu 简单折叠，不额外NFKC/去重音或ß→ss；查询最多256 code points，跨块保留最多查询长度-1个完整code point，offset从原文匹配映射，重叠不重复命中。F3首轮从最早保留记录开始，Enter向新/Shift+Enter向旧，边界明确提示不循环；只有complete且无hit才无匹配。输入改变新generation，读取失败保留原cursor重试。

### D-07：查询上下文与返回

F3持有独立短查询草稿、保存原anchor/detail/manual expansions，命中仅临时展开并read(anchor)；Esc恢复完整阅读状态及composer。Search启动固定已提交上界，预览不搜，显式重搜才纳新内容。活动导航、F3、Ctrl+R、overlay/确认互斥，最上层先消费键位，查询粘贴只编辑查询；取消/切Session/关闭丢弃旧generation结果。新事件不抢焦点，不推进模型或Worker。

### D-08：普通输入历史

users直接role=user，回答system引用不混入。↑空输入召回，browse仅在未修改且光标处全文首/尾时继续；↓越过最新恢复保存UiDraft。Ctrl+R从最新向旧搜索，↑旧/↓新，Enter只采用全文且cursor在尾，之后普通Enter经旧提交管线。历史只预览，不改变persistent draft；编辑召回内容或显式采用后才经旧composerChange保护。原草稿全文/cursor/pasteBlocks取消精确恢复；回填不伪造历史粘贴身份，完整原文作为新草稿。完整回填遵守MAX_USER_MESSAGE_CHARS，失败/超限不截断或清输入。只读/回答/overlay期间普通历史入口不可用。

### D-09：验证与交付

复用store/workflow/TUI测试补稳定边界。性能真实SQLite+生产App，1千/1万/10万及1/5MiB，搜索期间输入/已缓存导航各≥100采样p95≤100ms，扫描成本/真实工作量/缓存/RSS单列。PTY三档两色/Nerd/ASCII并逐票画面对照；证据另存artifacts/history-inspection。完成types/lint/tests/build/strict/diff，修正文档3B归档漂移；不提交/归档，不提前verification。

## Risks / Trade-offs

全文扫描总成本随保留历史增加，单批/工作区有限；索引补齐期间明确关联处理中。参数JSON原文与正文是不同source坐标；不从parameter offset伪造body offset。同步SQLite语句不可中途中止，只在有限语句/块之间取消。简单折叠不承诺完整Unicode扩展折叠。缺少历史观测保持unconfirmed。

## Migration Plan

保持权威entry、step、Wake和UI格式；只增加可重建关联索引及可信调用观测，不建旧格式兼容路径或自动重写原文。保留用户工件归档移动；实施先核对前驱和基线。

## Open Questions

无阻塞问题；用户已确认完整第四批和忽略大小写字面搜索。
