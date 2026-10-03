## Context

基线 `8af15029d22ba364985abcf2cb8edbf30cc85bf2` 已包含并归档前驱原型纠偏。IC-04 当前整体 JSON 与 IC-11 的尾部切片是同一性能根因；MOD-03 的图通道已不复制历史，可继续复用。领域语言见 CONTEXT.md；权威决议为 [#46](https://github.com/leike0813/orca-companion/issues/46#issuecomment-5946016892)、[#53](https://github.com/leike0813/orca-companion/issues/53#issuecomment-5945507505)、[#41](https://github.com/leike0813/orca-companion/issues/41#issuecomment-5934328595)。

## Goals / Non-Goals

**Goals:** 完成 3A 的权威增量读写、有效上下文与精确恢复、真实 keyset/正文范围及正式 TUI 全原文读取。

**Non-Goals:** 3B 的跨帧稳定内容版本、虚拟布局/缓存/Markdown/流式预算，第四批活动与搜索，其他批次数据/configuration。保留前驱的布局、输入与 Scope 控制。

## Decisions

### D-01：单一权威正文与增量事务

`checkpoint-store.ts` 的 schema 2 将 Session 控制 JSON、entry 元数据、16 KiB UTF-8 正文块、step 元数据和 Wake 分表关联，Session 内单调序号不可重排。step.messages 仅读时从关联 entry 重建，不另存正文；tool calls 由 assistant entry 拥有。LangGraph SqliteSaver 的表与 durability 不变。旧整体 schema 明确拒绝、保留文件；首版不升级旧历史。

初始化/测试 fixture 可显式提供完整状态；生产更新使用窄 `updateCheckpoint`、`appendMessage`、现有 append/commit 方法。普通追加只核验本次载荷、原身份及控制行，BEGIN IMMEDIATE 内提交并读回必要事实，任何失败抛出后回滚。同身份语义相同幂等，异载荷拒绝。

每条工作输入与处理响应的关系保存在原 entry 上，仅作为已提交处理事实的索引，正文不复制，不另建调度队列。普通无 tool 的响应结清队首；完成工作工具按 source 结清准确条目。待处理投影只读取未配对输入（最多现有 Actionable Work 上限），沿用应用投影语义。

### D-02：按目的读取与唯一预算

IC-04 `loadCheckpoint` 增加读取目的 metadata/context/tools/pending/migration；默认完整读取仅供显式 fixture/诊断，生产调用全部声明目的。metadata 读取控制与压缩产物；context 在 SQL 范围排除 Capsule 已替换正文，独立预算 4 MiB/4096 条，超过即不可恢复并明确预算原因；tools 只读最后 step 及同 step 结果，保持配对身份；pending 仅读未处理输入；migration 为原生窗口转 Capsule 读取有限原文。先索引读取长度，再物化预算内内容，原生窗口记录覆盖序号并保留之后的新消息。Wake 写入结果只携带本次 batch 与必要控制，核验按 submission 精确读 entry。公共 DTO/port 归 application，adapter 不泄露 SQL handle。

原文完整读取仍由同一记录的范围合同提供。压缩与模型输入消费 context；模型切换的原生迁移与首次交接派生消费 migration。结论与图位置只更新控制字段；宿主回答引用增量追加，已存在身份精确检查。各产物分别校验，无关产物损坏不改变另一方的精确读数；完整恢复损坏则关闭。有效模型输入预算和原文保留预算不同，不以显示范围截断模型语义。

Capsule 总结实际替换的完整时间区间，包含工具执行期间交错受理的用户/回答引用；前缀选择不得拆开在保留尾部再次出现的 step。派生器使用所选前缀中终点 step 的最后片段。storage 在保存时固定 from/to 序号，同 ID 同载荷重放保留原边界，后来的同 step 条目继续留在有效区间。源 Session 首次交接派生使用 migration 的有限原始条目，不能只总结 model step 而排除用户与工具结果。

### D-03：keyset 与正文范围

新增 `application/coordinator/history.ts`，拥有 metadata 页、body range、游标 schema 和限额。元数据最多 100 条/64 KiB，正文一次最多 64 KiB，块16 KiB；body offsets 是 UTF-8 字节位置，只接受完整字符边界。entryId/content revision=1/sequence/byteLength/role/stepId/tool identity 保持稳定；缺失和错误明确区分。游标绑定 Session、稳定序号、正文 offset 与方向，运行时 schema 校验；oldest/latest 直接索引查询，不使用 OFFSET。history-body 可按精确身份独立调用，工具完整结果复用同一来源。

现有 transcript façade 返回有界可读片段及 older/newer 游标和正文范围，不把 fragment 当成新消息；默认最新范围。TUI 每次仅持有当前页及加载状态，不积累全部旧页；页内可滚动，跨边界再按 cursor 获取旧/新页，工具默认折叠。失败保留旧页，重复请求合并，Session/request generation 拒绝迟到结果；回看期间新事件只显示有新内容，Esc/Ctrl+End 回到最新。基础分页不替代3B的连续局部视窗。

### D-04：呈现来源与验证

P-40 使用 [continuous 定稿](../../../artifacts/tui-prototype/continuous-v2b-80x24.png)、[窄屏](../../../artifacts/tui-prototype/continuous-v2b-50x40.png)、`src/interfaces/tui/workspace-prototype.tsx`；其余六票参照沿用前驱 design D-01。主代理亲自实现及对照，正文/工具 mark、留白、composer 和 sidebar 不重新设计。新增必要键位与有界状态提示，不新增历史阅读页。

复用 storage/Wake/workflow/Bootstrap/TUI 测试；观察实际记录条数与 UTF-8 字节、SQLite失败回滚、旧cursor追加稳定、精确恢复/100工具、压缩原文可读、真实宿主分页和Ubuntu PTY三档/CJK/无色/resize。性能记录读写计量，本次不声明3B的10万项导航p95与SDK/RSS目标已完成。独立只读审计覆盖生产调用未保留整体扫描、原子性/工具身份与TUI迟到/失败边界。

## Risks / Trade-offs

行式存储与目的读取改变公共 seam，必须一起接全部宿主调用。字节范围处理不能破坏 UTF-8；稳定 sequence 与内容身份使后继3B可直接消费。有效上下文超限会显式关闭，保留完整正文供阅读和交接，不猜压缩。测试 fixture 的完整状态 API 不得继续进入日常生产路径。

## Migration Plan

按首版重建当前格式，没有旧 JSON 搬迁/双读。旧库打开明确拒绝且不修改；新库正常建立。前驱主规格与IC-13保持，全部生产消费者切换后同步IC-04/11/12和交接。无依赖/权限扩展，无Git提交/归档。

## Open Questions

无阻塞问题。
