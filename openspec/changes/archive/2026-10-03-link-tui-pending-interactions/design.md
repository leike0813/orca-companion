## Context

基线 `69f0aa1781265bb7623cb4bbb3e8ae5722e72bce`，直接前驱归档路径 `openspec/changes/archive/2026-10-03-inspect-and-search-coordinator-history` 已核验。IC-03 拥有 Q/A，IC-12 拥有可信 HistoryCall，IC-11 提供有界阅读，IC-13 拥有输入。第四批工具展开、来源锚点与搜索不改权威归属。

## Goals / Non-Goals

完成 #46 第五批的 Scope 待答、历史卡片与跨 Session 返回。沿用 #41/#42/#45/#50 决议、六票原型及原提交保护。后续配置、状态栏、Graph 和初始化批次、提交与归档不在范围内。

## Decisions

### D-01：有界查询与计数分离

Branch Store 增加展示 snapshot，类型与完整业务 snapshot 区分：交互只携带至多二十条摘要、完整 Scope open count 及 Session count。SQL 通过索引聚合完整计数，不读取正文；计数成本随索引规模变化，不能称为常数时间。完整业务 snapshot 保持原合同。执行投影采用去掉交互载荷的共同事实及显式完整计数，Finalizer 不使用页长。Scope/Session 待答页统一 keyset，owner 可选，精确详情保持 Scope/owner/ID 核验。历史摘要每批最多二十个指定 ID，问题/回答预览与字节数由 SQL 有界投影。拒绝不可读或非法查询，不将缺失算作已答。

### D-02：可信历史绑定与正文范围

应用模块导出 operationId 到 InteractionId 的现有正向派生，reader 只使用持久化 HistoryCall 的 operationId。工具参数和结果仍保留原展开能力；问题卡是同一调用的权威补充。摘要含 state、expectedRevision、answerRef、问题及回答预览/字节数。阅读来源增加 interaction Q/A part，其身份含 interactionId、owner、内容版本；问题版本使用 expectedRevision，回答版本绑定 answerRef。Branch Store 范围查询按 UTF-8 完整字符返回有限正文，Bootstrap 转接同一个 TranscriptReadingPort；不写入 checkpoint，不复制完整问答到摘要缓存。缺失、索引未就绪与读取失败分开呈现。正文与布局预算沿用各 8 MiB/64 项，单帧工作量仍有界。

### D-03：单次显式返回上下文

App 在成功保存输入后记录一个进程内返回上下文，包含 Session、来源锚点、detail/expanded、项目面板栏目/所选项/scroll、焦点及待答页。输入仍由 protection 管线持有。跨 Session 进入前精确读取问题并核验选中 owner/revision；异步请求有 generation 检查。Esc 只有保存成功才返回。受理后仅原输入结清且没有后来编辑、选题/Session 未改变时返回，未知或拒绝保留位置。显式 Session 切换销毁返回上下文；迟到结果仍结算其原 submission。返回列表保留原 selectedKey；消失时显示已变化状态，不选择下一题。Ctrl+R 继续普通输入历史。

### D-04：呈现与责任

主代理实现并按交接文件登记的六票最终源码和画面对照验收。历史 compact Q/state/A 使用 continuous 的轻量标记；F4 Enter 沿原活动展开，开放卡的回答入口复用绑定 handler。项目待答沿用 fixed frame 的用途标题、短预览、owner/state 和明确分页，不新增页面或快捷键。新事件只触发权威查询失效，不提供事实、不移动焦点。render/effect/resize 不提交或恢复模型。

## Risks / Trade-offs

Scope count 必须扫描相应索引，但避免 Q/A 解码和数组扫描。历史摘要分批读取增加少量查询，受当前调用窗口约束。关闭问题后的卡片变化不能改变固定 Q 锚点；A 采用独立版本。跨 Session 异步提交可能晚于编辑或返回，用既有 draft revision 和 request generation 守护。存储或身份核验失败保留原输入与视窗，不猜测结果。

## Migration Plan

Coordination schema 从 14 到 15，追加 `(coordination_scope_id,state,created_at,interaction_id)` 索引。UI/checkpoint 格式不变，不安装依赖。修正当前交接文档的前驱 active/dirty 漂移，保留历史报告。新增验收资产在 `artifacts/pending-interactions/`，原型和前批资产只读。

## Open Questions

无阻塞问题。用户已选择“受理且无后来编辑时自动返回”。
