# 3A 会话历史验收证据

日期：2026-10-03；Ubuntu、Node v24.12.0。Change：[`paginate-coordinator-history`](../../openspec/changes/paginate-coordinator-history/proposal.md)。基线 `8af15029d22ba364985abcf2cb8edbf30cc85bf2`；实现对象为该 HEAD 加 [implementation.diff](implementation.diff)，没有提交或归档。用户原有交接报告归档移动不在补丁内。

## 行为检查

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck`、`pnpm lint`、`pnpm build` | 通过 |
| `pnpm test --maxWorkers=8` | 145 文件、1392 项通过；6 文件/12 项条件跳过 |
| `pnpm exec vitest run tests/tui --maxWorkers=8` | 最后翻页修复后 27 文件、184 项通过；2 条件跳过 |
| `openspec validate paginate-coordinator-history --strict`、`git diff --check` | 通过 |
| `node artifacts/coordinator-history/measure.mjs` | 真实文件 SQLite 的三档记录计量完成 |
| `node artifacts/coordinator-history/capture.mjs` | 正式 TuiApp 的真实 PTY，45 对 PNG/文本 |

关键行为在既有测试中扩展：十万条历史；巨型 CJK 正文分块完整重建；稳定游标/直接起点；响应失败回滚和同身份重放；双连接受理不丢消息；损坏已压缩旧正文不影响当前上下文与恢复；超限明确拒绝而原文可分页读；精确工具配对；压缩穿插用户/工具和迟到结果；原生窗口迁移保留用户记录；正式宿主超过 200 条的分页；失败/新事件保留位置和草稿；真实切 Session 拒绝迟到结果；跨页向新从页首、向旧从页尾接续。

## 实际存储计量

来源：[measure.mjs](measure.mjs)、[storage-measurements.json](storage-measurements.json)。采用正式 storage adapter 和 history reader；历史 fixture 是有完整正文的 entry，不伪称已有十万个 model step。计量与全量测试并行，时间仅为一次观测。

| 历史条数 | 元数据页条数 / UTF-8 字节 | 有效原文条数 | 新响应正文块 / 字节 | 追加 / context / metadata（ms） |
| --- | --- | --- | --- | --- |
| 1,000 | 100 / 10,910 | 1 | 1 / 9 | 96.55 / 3.86 / 15.85 |
| 10,000 | 100 / 11,109 | 1 | 1 / 9 | 118.37 / 1.20 / 8.83 |
| 100,000 | 100 / 11,308 | 1 | 1 / 9 | 98.60 / 1.80 / 10.15 |

三档查询计划均使用 `conversation_visible (coordinator_session_id, seq)` 索引。正文只保存一次；step 关联原 entry，在读取时重建消息。生产调用目的的只读复核见 [audit.md](audit.md)。此计量不构成 #53 的输入/缓存导航 p95、RSS、虚拟视窗或流式渲染性能结论。

## 原型与 PTY

定稿来源：[#40 continuous 80×24](../tui-prototype/continuous-v2b-80x24.png)、[50×40](../tui-prototype/continuous-v2b-50x40.png)，六票来源与返回约定见[交接文档](../../docs/dev/tui-implementation-handoff.md)。主代理逐项核对角色标记/色边/留白、工具层级、composer、sidebar 和返回；新增分页不改变定稿工作区。

采集入口：`node scripts/tui-preview.mjs history`。正式 TuiApp/Controller 分页 façade 使用独立内存 checkpoint 库，320 条历史、中部巨型中文正文；端口不连接 Orca、Coordinator 模型或业务 mutation。存储、宿主和工具语义另由上面的行为测试核验。

每个 120×40、80×24、50×40 的彩色/NO_COLOR 组合采集：latest、oldest、page-down、page-up、cross-page-next、reading、return-cursor，共 42 对。另有 120→80→50→120 resize 的 3 对，共 45 对。[samples.json](samples.json) 保存每张画面的原生 cursor 坐标和可见性。

操作：输入“首尾”→Left→Ctrl+Home→PgDown/PgUp→连续 PgDown 跨页→Ctrl+End→PgUp→Esc→输入“中”。返回后显示“首中尾”，证明阅读未改变聊天光标。跨页画面从第 100 条开始，未跳到新页尾部。

代表画面：[最早 80 彩色](oldest-80x24-color.png)、[向新跨页 80 彩色](cross-page-next-80x24-color.png)、[返回 50 无色](return-cursor-50x40-no-color.png)、[resize 50 彩色](resize-return-50x40-color.png)、[最新 120 彩色](latest-120x40-color.png)。同名 `.txt` 保存终端文本，不能用截图代替原文完整性测试。

## 边界

3B 的局部视窗、内容锚点/缓存、Markdown、流式与输入/缓存导航 p95 待后继。首版旧整体 checkpoint 格式拒绝打开并保留，不提供搬迁。真实 Orca/provider 条件检查未启用；没有新增人工 IME 预编辑证据，Windows 未验证。
