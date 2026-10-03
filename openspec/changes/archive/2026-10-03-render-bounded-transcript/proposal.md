## Why

3A 已归档并接通权威历史的增量读写，但当前 Transcript 仍将整个正文页换行后裁切，生产模型调用也没有流式预览。地图 #37/#46 的下一批 3B 必须让长历史、巨大正文与流式更新保持局部、有界且可阅读。

## What Changes

- 用来源身份、内容版本和 UTF-8 位置建立局部视窗，保持阅读锚点，分离 metadata 与正文范围读取。
- 使用 Marked 17.0.1 解析有限 Markdown 块；巨大结构和未知上下文保留原文；正文/布局缓存各限 8 MiB、64 项。
- 生产模型节点消费真实 stream；稳定前缀与有限尾部预览不构成已提交历史，完整响应原子接受后才执行工具。
- 输出预算默认 8 MiB，上下文读取预算默认 16 MiB，均可配置；不明确的流式 usage 留空。取消与退出终止前台调用，Pause 保留在途调用。
- 采集生产链路性能、真实 PTY 和原型一致性证据，修正 3A 交接状态。

## Capabilities

### New Capabilities

无；扩展既有合同。

### Modified Capabilities

- `tui/planning-workspace`: 局部阅读、稳定锚点、有界 Markdown/缓存与流式预览。
- `coordinator/session-runtime`: 实际流式调用与未提交预览的隔离、取消及准确 usage。
- `coordinator/model-configuration`: 有限输出/上下文读取预算。

## Impact

直接前驱为 `paginate-coordinator-history`（2026-10-03 已归档），实施基线 `b15ff20`。采用 predecessor-contract，冻结 IC-04/11 权威历史、IC-13 输入保护及 Scope/Wake/fencing 语义；按登记扩展 IC-04/11/12。Marked 是唯一新增依赖，已获用户批准。

影响 MOD-02/03/04/06/07 的窄读取端口、model node、临时存储、TUI 阅读和 Bootstrap。保持六票已定稿布局；不实施第四批搜索/活动详情、跨会话回答或设置。本次交付未提交实现与验收证据，正式 verification 在实现 HEAD 固定后创建。
