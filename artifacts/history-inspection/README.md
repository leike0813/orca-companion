# 第四批：活动详情与历史搜索实施证据

2026-10-03，change：`inspect-and-search-coordinator-history`。实施基线为 `20f02996471adb3efca524faced20ef9ffa0136d`，实现和归档现已包含于 `69f0aa1781265bb7623cb4bbb3e8ae5722e72bce`。本轮按用户要求修复并重新核验，正式 [verification](../../openspec/changes/archive/2026-10-03-inspect-and-search-coordinator-history/verification.md) 结论为 PASS，完整扫描成本证据已补齐。以下保留第四批验收当时的记录与范围。

当前 Session 的可信只读调用可跨页组成活动，变更动作单列，紧凑态保留 rejected/unknown。参数与结果分别定位到原 entry/step/call，按 UTF-8 范围读取。Ctrl+T 切整体详细，F4 选择活动并原位开合；F3 搜索已提交正文、参数和结果，Esc 恢复原阅读状态与草稿。空输入↑召回普通输入；Ctrl+R 的 Enter 只采用，再次 Enter 才沿原提交管线发送。

调用索引仅保存身份、范围、配对和摘要；正文与参数没有 UI 镜像。初始化补齐由 Bootstrap 显式驱动。读取、重绘、resize 和搜索不执行模型或工具。旧结果和 unknown 观测沿原调用身份记录，未取得结果仍是 unconfirmed。

## 生产读取与性能

运行 [benchmark.mjs](benchmark.mjs)，原始结果见 [measurements.json](measurements.json)。Node `v24.12.0` / Ubuntu Linux；真实文件型 SQLite、生产 TranscriptReader 和 TuiApp，以及读取同一 store 的生产搜索器。Controller/backend 使用隔离替身，数据是合成历史，没有真实 provider 或 Orca Worker。

每种场景包含100次输入到显示、100次已缓存导航采样；后台搜索持续运行至取消，仅保留有限批次。随后使用原固定上界独立扫描至完成，累计标量计量并断言全部预期命中。巨大场景的参数JSON和结果正文各自恰好为1,048,576 / 5,242,880字节。

| 场景 | 输入 p95 / max (ms) | 缓存导航 p95 (ms) | 冷阅读 (ms) | 独立完整扫描 (ms) | 完整命中 / 批次 |
| --- | --- | --- | --- | --- | --- |
| 1,000 条 | 59.1 / 74.2 | 10.8 | 67.0 | 368.1 | 1,000 / 21 |
| 10,000 条 | 70.4 / 91.0 | 6.8 | 29.9 | 2,959.0 | 10,000 / 201 |
| 100,000 条 | 68.0 / 80.0 | 10.0 | 37.3 | 29,799.0 | 100,000 / 2,001 |
| 1 MiB 参数＋结果 | 68.2 / 86.4 | 0.9 | 103.0 | 151.3 | 3 / 36 |
| 5 MiB 参数＋结果 | 78.3 / 148.0 | 0.8 | 128.0 | 995.2 | 3 / 164 |

五行输入与缓存导航p95均≤100 ms。5MiB单次输入max为148 ms，冷读取约128 ms；冷读取和完整扫描不属于缓存导航指标。`scan`保留采样期间的连续搜索数据，`fullScan`另存独立完整扫描。1万/10万记录在响应采样结束时仍未完成的`scan.firstFullScanMs=null`如实保留；五个`fullScan.complete`均为true，不能将采样窗口充当全文耗时。

完整扫描分别为21/201/2001/36/164批，命中总数1000/10000/100000/3/3。实测单批峰值：100条元数据、50命中、65,536字节正文读回、6,050字节响应、416字节游标；均在100条/50命中/64KiB正文与响应/4096字节cursor限额内。搜索只保留有限元数据、命中、当前正文块和短尾部，累计`scannedItems`不是同时驻留项数。

阅读缓存实测正文≤34,088 字节/26 项，派生布局及上下文≤68,848 字节/49 项，均低于各自 8 MiB / 64 项的限制。RSS 包含测试数据、React/Ink 与进程分配，不代表展示缓存大小；原始文件保留这些观测。此次 fixture 是新写入后索引已就绪，旧历史重建的有限批次由 storage 行为测试覆盖，不能把 `index.scannedBytes: 0` 当作旧库重建成本。

## 原型与终端画面

[capture.mjs](capture.mjs) 使用真实 PTY 和生产 `scripts/tui-preview.mjs alignment`；检索场景接真实 SQLite/生产读取与搜索，外部协调事实仍由隔离替身提供。三档 `120×40 / 80×24 / 50×40`，彩色/NO_COLOR、Nerd/ASCII，共 12 个组合。每组 16 张，共 192 对 PNG/同名文本；[samples.json](samples.json) 保存实际 cursor，[checks.json](checks.json) 保存操作归属。

采集覆盖普通工作区、项目面板、Graph Inspector、Cancel 默认返回、slash 候选、原聊天光标恢复，以及 compact/details、F4 动作/跨页查询、F3 巨大参数命中、Ctrl+R 新旧历史/返回/采用。F3/F4 等待定位完成，Ctrl+R 等待内容加载，采集不以加载中标题作为完成依据。`--inspection-only` 可保留现有六种基线画面、重新采集十种检索画面；最后补采使用此参数。

六票的定稿源码、决议与画面引用沿用 [D-01 原型来源表](../../openspec/changes/archive/2026-10-03-align-tui-with-approved-prototypes/design.md#d-01六张原型票直接作为设计参照)。本轮直接查看六票原画面，并对照生产代表画面；原型源码和旧证据保留。

| 定稿 | 对照关注点 | 本批代表画面 |
| --- | --- | --- |
| #40 continuous | 消息标记、连续布局、工具层级、色边/留白、composer 可见 | [紧凑](activity-compact-80x24-color-nerd.png)、[详细](activity-detailed-80x24-color-nerd.png)、[搜索](search-arguments-80x24-color-nerd.png) |
| #47 above-input | 圆角真实输入框、有界上方候选、采用与执行分离 | [slash](slash-80x24-color-nerd.png)、[输入历史采用](input-history-adopted-80x24-color-nerd.png) |
| #48 custom-direct | 简短顶栏、单行核心状态、独立风险、字段配色 | [工作区](workspace-80x24-color-nerd.png)、[窄屏](activity-compact-50x40-no-color-ascii.png) |
| #51 tabs | 项目页签、固定 sidebar 区域、窄屏占主区域、返回光标 | [宽屏项目](project-120x40-color-nerd.png)、[窄屏项目](project-50x40-no-color-ascii.png)、[返回](return-cursor-80x24-color-nerd.png) |
| #52 dialog final | 反色动作、默认返回、Scope 控制确认、图标模式 | [取消审阅](cancel-review-80x24-color-nerd.png)、[ASCII](cancel-review-50x40-no-color-ascii.png) |
| #43 adaptive | 图/节点分区、关系选择、窄屏 Inspector 与返回 | [宽屏图](graph-120x40-color-nerd.png)、[窄屏图](graph-50x40-no-color-ascii.png) |

新增查找行位于 composer 上方；独立查询光标与聊天草稿分开。详情仍在 transcript 中，沿用现有层级。命中行复用 `›` 选择标记并反色，NO_COLOR 下仍能辨认。未取得的 effort/context/验收进度保持“不可用”。以上只验收第四批及其影响到的呈现；后继配置、跨 Session 回答和历史图功能仍按交接文档排期。

## 检查记录与边界

| 命令 / 范围 | 结果 |
| --- | --- |
| `pnpm typecheck` / `pnpm lint` / `pnpm build` | 最终修复后通过 |
| `pnpm test --maxWorkers=4` | 150文件/1498项通过，1项缓存预算用例超时；6文件/12项条件跳过。该轮与PTY采图并行 |
| `pnpm exec vitest run tests/tui/transcript-reader.test.ts` | 超时所属文件独立复跑9项通过 |
| `pnpm test --maxWorkers=2` | 151文件/1499项通过；6文件/12项条件跳过 |
| 存储、checkpoint、workflow、搜索、活动导航11文件 | 最终存储修复后173项通过 |
| 回答隔离及输入/宿主/副作用侧审8文件；workflow/domain侧审20文件 | 分别78项、239项通过，不累加到全套 |
| `node artifacts/history-inspection/benchmark.mjs` | 最终构建五场景响应及完整扫描断言通过 |
| `node artifacts/history-inspection/capture.mjs --inspection-only` | 最终构建12组合，192对画面与24条操作记录 |
| `openspec validate inspect-and-search-coordinator-history --strict` / `git diff --check` | 通过，含本轮最终报告与文档更新 |

本轮修复无调用历史反复读页、普通召回预览进入回答后误提交、unknown诊断理由变化导致写入失败，以及单次调用状态泄漏上界后的观测。搜索回归验证240条混合消息全部命中及读量线性增长；App回归确认召回发生后回答Enter不提交旧聊天；扩展既有storage用例复现并修复诊断变化与上界问题，原调用身份校验及无伪造结果保持。各次检查有重叠，不累计重复项；跳过不计通过。

平台证据限 Ubuntu。PTY 字节注入和图片对照不代替新一轮 OS 输入法人工验收；Windows 未验证。此次未启用隔离真实 Orca/provider 集成，不宣称真实 Worker 协调闭环重新验收。保留用户已有的交接报告归档移动；没有依赖变更、Git 提交、分支切换或上游修改。
