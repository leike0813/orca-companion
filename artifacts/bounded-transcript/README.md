# 3B 有界对话阅读与流式证据

2026-10-03，Ubuntu / Node 24.12.0 / pnpm 11.10.0。实施基线 `b15ff20d4fe7d42a218c7259fb0ebc793f24d2ae`，当前实现未提交。对应 [render-bounded-transcript](../../openspec/changes/render-bounded-transcript/implementation-plan.md)，承接已归档3A；已按用户要求基于现有工作区与留存证据撰写 [verification PASS](../../openspec/changes/render-bounded-transcript/verification.md)，撰写时未重新运行核验。

生产 App 已消费独立 metadata/body/preview 读取端口，Transcript 绘制有限 frame。阅读器拥有原文锚点、局部 Markdown/宽字符布局及双缓存；当前 Session 正文和派生缓存各限8 MiB/64项，派生上下文计入额度，临时来源总额64 MiB/64项。模型真实 stream 的完整响应只来自 SDK end callback；原子接受前核验 signal/fencing，未接受片段不进入历史或工具执行。

默认输出8 MiB、上下文读回16 MiB，可通过项目配置调整为有限正整数。读取仍保留4096项限制；输出超限、取消及失去 fencing 不重试。Pause保留在途响应，Cancel先保存意图再abort并请求Worker停止，Exit只结束前台资源。Usage仅采用单个完整非空报告。

## 性能

[benchmark.mjs](benchmark.mjs) 运行真实文件 SQLite、生产 TranscriptReader 和生产 TuiApp，假端口只隔离外部业务。每行包含100次实际字符输入至可见渲染、100次已缓存 PgUp/PgDn 方向导航；工具输出在阅读器及App中展开。巨型正文精确为1/5 MiB，内容含中文/emoji和巨型单段。数据见 [measurements.json](measurements.json)。

| 来源 | 输入 p95 ms | 已缓存导航 p95 ms |
| --- | ---: | ---: |
| 1000条不同记录 | 51.28 | 9.73 |
| 10000条不同记录 | 67.77 | 5.64 |
| 100000条不同记录 | 70.57 | 7.63 |
| 1 MiB正文 | 68.94 | 0.16 |
| 1 MiB工具输出 | 71.44 | 0.18 |
| 5 MiB正文 | 86.66 | 0.17 |
| 5 MiB工具输出 | 77.62 | 0.17 |

输入和缓存导航均达到 #53 的 p95≤100ms。冷读、resize、原子提交和finish另列，部分冷读/finish/提交超过100ms。此门槛不适用于所有操作或单次最大值。测量进程还持有夹具、React/Ink与数据库资源；累计RSS最高约667 MiB，不是缓存上限，也不证明全进程内存恒定。

[stream-benchmark.mjs](stream-benchmark.mjs) 使用生产graph、真实SQLite、临时preview store与SDK逐16 KiB流式模型。每次确认流中没有权威assistant，完整接受后恰好一条正式entry；脚本不保留delta数组或自建聚合器。独立 [stream-measurements.json](stream-measurements.json) 中1/5 MiB模型调用约70/323ms，原子接受约27/196ms，观测RSS峰值约147/220 MiB。`aggregateAfterChunkMs` 包括最后chunk后的SDK、合同解析和同步接受，并非纯SDK计时；独立接受时间可单独查看。这些数字不属于输入/导航100ms门槛。

## 原型与真实PTY

主代理直接核对六票定稿决议、源码和画面，参照表见 [原型交接](../../docs/dev/tui-implementation-handoff.md)。[capture.mjs](capture.mjs) 挂载生产App，使用tuistory真实PTY，保存81对PNG/同名文本及 [samples.json](samples.json)、[checks.json](checks.json)。覆盖120×40、80×24、50×40，彩色/NO_COLOR和Nerd/ASCII的12种组合；另含历史跨页、resize、真实graph流式预览、固定阅读版本及完成返回。12组项目/图/Cancel返回均保留“首中尾”插入位置。

| 定稿来源 | 本轮直接对照 | 观察 |
| --- | --- | --- |
| #40 continuous | [80列工作区](workspace-80x24-color-nerd.png) | 用户色边/首行标记、Agent圆点、工具折叠和消息留白保留；已修复首行标记遗漏 |
| #47 above-input | [上方候选](slash-80x24-color-nerd.png) | 有限候选位于圆角composer上方，采用与执行仍分开 |
| #51 tabs | [120列项目面板](project-120x40-color-nerd.png) | 使用原sidebar区域，对话位置不变；窄屏独占主区域 |
| #52 final | [Cancel审阅](cancel-review-80x24-color-nerd.png) | 固定审阅框、默认返回、反色动作、Esc逐层返回保留 |
| #48 custom-direct | [工作区状态行](workspace-80x24-color-nerd.png) | 顶栏/风险/会话核心分层与字段配色保留，缺失metadata显示不可用 |
| #43 adaptive | [50列ASCII图检查](graph-50x40-no-color-ascii.png) | 邻域、节点卡与关系导航保持；图独立于正文阅读 |

流式画面：[实时尾部](stream-live-80x24-color-nerd.png)、[固定版本](stream-pinned-80x24-color-nerd.png)、[resize](stream-resized-120x40-color-nerd.png)、[完成返回](stream-finished-120x40-color-nerd.png)。该预览使用本地假chat model真实SDK stream/生产graph，未连接外部provider或Orca；生产宿主接线另由真实临时Git仓库与SQLite行为测试核验。

## 复现与边界

```sh
pnpm typecheck
pnpm lint
pnpm test --maxWorkers=4
pnpm build
node artifacts/bounded-transcript/benchmark.mjs
node artifacts/bounded-transcript/stream-benchmark.mjs
node artifacts/bounded-transcript/capture.mjs
openspec validate render-bounded-transcript --strict
git diff --check
```

类型、lint、build、OpenSpec strict 与 diff 检查均通过。全库复验通过 147 个测试文件、1433 项测试，6 个文件中的 12 项测试按条件跳过。随后补充的 3 项有界 Markdown 回归用例通过，最终 TUI 复验通过 28 个文件、193 项测试，另有 2 个文件中的 2 项测试按条件跳过。真实 PTY 检查通过；行为检查覆盖原文范围、中文/emoji、metadata-only 工具折叠、缓存上限、预览固定版本、存储失败、Cancel/Pause/close/fencing 及 usage。

未知Markdown中段、巨型或不支持结构采用可读原文，不从全文前缀重建语法；有已知上下文的围栏使用有限状态。临时预览不提供重启恢复权威；读失败保留原画面，真实文件不可用时不能伪造原文。12项条件跳过不计通过；本次无外部provider/Orca集成、OS输入法预编辑人工或Windows验证。第四批活动分组/完整详情/F3搜索/Ctrl+R历史及后继配置仍未实施。
