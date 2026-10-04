# IP05：六票生产画面对照

日期：2026-10-04（Ubuntu，生产 TUI，经 tuistory/Ghostty PTY）

## 结论与证据边界

本报告逐项对照已归档 [align-tui-with-approved-prototypes design D-01](../../openspec/changes/archive/2026-10-03-align-tui-with-approved-prototypes/design.md#d-01六张原型票直接作为设计参照) 的六票定稿源码和代表画面，并结合当前 IP05 生产采集与前驱生产画面。结论只评估布局、层级、配色、键位和返回体验；六票代表的是产品完整设计，单次功能批的覆盖仍按实际证据限定。

本批全矩阵目录为 [`capture-2026-10-04T12-05-42-262Z`](screenshots/capture-2026-10-04T12-05-42-262Z/)，矩阵覆盖 120×40、80×24、50×40 × color、NO_COLOR × Nerd、ASCII。每种组合均以生产 `TuiApp` 和生产 `GraphBasisService` 运行；端口为本地 fake ports，历史记录在临时 SQLite，规格在临时目录，UI 输入库为内存 SQLite。所有图、授权、Route Map、Worker 与对话内容均为明确的预览 fixture；这些画面不能证明真实 Worker 执行、Orca 闭环、项目验收或业务状态。

本轮又新增两个生产采集目录：`screenshots/statusline-final-20261004/` 与 `screenshots/reviews-final-20261004/`。两者都是本批新采，不是任何前驱的重跑，都以生产 `TuiApp` 加隔离 fake ports 运行，不接模型与 Orca。`reviews-final-20261004` 由仓库内的 `artifacts/graph-basis/capture-reviews-final.mjs` 驱动（预览场景 `alignment-planning`）；`statusline-final-20261004` 由 `node artifacts/project-statusline/capture.mjs ../graph-basis/screenshots/statusline-final-20261004` 生成（退出码 0），该脚本按 `process.argv[2]` 相对 `artifacts/project-statusline` 解析输出目录。

P-51 内容态随后单独补采于 `screenshots/project-content-2026-10-04T14-06-32.782Z/`，生产 `TuiApp` 加隔离 SQLite 问答与 fixture `scope-control-changed` 语义事件，不接模型与 Orca，退出码 0。三个画面组（`pending-content`、`events-content`、`event-detail`）× 12 组合 = 36 条样本记录、36 对独立 PNG/TXT，记录与文件一一对应；`checks.json` 12 条的 `pendingContent`、`semanticEventContent`、`eventDetailReturn` 均为真。

计数按文件而非样本记录核对，与早先的写法有出入，在此更正：

| 目录 | 样本记录 | 独立 PNG/TXT 对 | 说明 |
| --- | --- | --- | --- |
| `capture-2026-10-04T12-05-42-262Z` | 216 | 192 | 12 个 `basis-body-resize-*` 文件各被记录 3 次（三次 resize 写同名文件），多出 24 条记录 |
| `basis-path-2026-10-04T13-15-53-509Z` | 96 | 96 | 记录与文件一一对应 |
| `statusline-final-20261004` | 116 | 114 | `project-budget-planning-120x40-color-nerd.png` 与 `project-identity-planning-120x40-color-nerd.png` 各被记录两次，是同名覆盖而非两帧 |
| `reviews-final-20261004` | 108 | 108 | 无重复记录 |
| `project-content-2026-10-04T14-06-32.782Z` | 36 | 36 | 无重复记录 |

`statusline-final-20261004` 的 `checks.json` 逐条标记 `productionApp: true`、`isolatedPorts: true`；`reviews-final-20261004` 的 12 条检查记录 `draftCursorText`、`directoryQueryReturned`、`reviewBlocksNavigation`、`exitKeepsReview` 均为真。两批各覆盖 12 组合。

### 与固定前驱 41b2f1e 的差异归属

`41b2f1e`（feat: complete tui project statusline）即当前 HEAD，本 change 的 TUI 改动全部是未提交的工作区内容。`git diff 41b2f1e -- src/interfaces/tui` 只涉及六个文件：`app.tsx`、`components/graph-inspector.tsx`、`components/project-panel.tsx`、`ports.ts`、`screens/workspace.tsx`、`state.ts`。逐票列出的 UI 差异按此归属如下，以便区分本批回归与沿用前驱：

| 报告中的差异 | 归属 | 依据 |
| --- | --- | --- |
| 五个弹窗标题为纯英文 | 沿用前驱 | `authorization-review.tsx:44`、`handoff-review.tsx:76`、`control-bar.tsx:80`、`session-picker.tsx:54` 与 41b2f1e 逐字节相同，且都不在改动集内；双语写法只存在于原型入口 `dialog-prototype.tsx` |
| Command Palette 无 `n/m` 计数与第二行提示 | 沿用前驱 | `command-palette.tsx:42` 与 41b2f1e 逐字节相同，footer 自始只有 `↑↓ 选择 · Enter 确认 · Esc 返回`；`1/12` 与 `搜索目录项 · 新消息保留当前输入` 只在未改动的 `dialog-prototype.tsx:406,408` |
| `当前操作` 缺 `行 N–M` | 非差异，条件渲染 | `selection-list.tsx:110` 与 41b2f1e 逐字节相同，`· 行 N–M/total` 仅在 `wrapped.length>budget` 即换行后超出可见行预算时追加；本批审阅正文短，未触发 |
| 状态栏 `上下文 已用 62%` | 沿用前驱 | `status-line.tsx:92` 与 41b2f1e 逐字节相同 |
| 设置页/审阅弹窗无 `来自 对话` 面包屑 | 沿用前驱 | 41b2f1e 的生产组件中本就没有该行，该文案只存在于原型入口 |
| 50 列省略 `图` 字段 | 沿用前驱 | 字段裁剪在未改动的 `status-line.tsx` 内，宽度公式未变 |
| 120 列项目面板比 80/50 列窄 | 沿用前驱 | `screens/workspace.tsx` 的 `projectWidth:terminalWidth>=100?terminalWidth-width:terminalWidth` 与 41b2f1e 相同；该文件本批只加了 GraphBasis 投影分支 |
| 待答列表第 10、11 项顺序在两次运行间互换 | 不由本批 UI 引入 | `project-panel.tsx:22` 按 `view.pendingPage.items` 原序渲染，组件内无排序；keyset 分页与 `pending-interactions` 合同自 41b2f1e 未变；条目文案来自 `scripts/tui-preview.mjs` fixture |
| 回答面板用 `Shift+←` 而非 `Ctrl+A` | 沿用前驱 | `answer-panel.tsx:35`、`interaction-card.tsx:36` 与 41b2f1e 逐字节相同 |
| idle 相位顶栏与 planning 相同 | 沿用前驱，且符合 CONTEXT | 见 P-48 段的更正说明 |

除上表最后两行所述的证据边界外，本批没有引入新的 UI 差异；本报告不重新设计任何界面，只登记归属与观感。

## 按票对照

### P-40 / #40：continuous 对话与输入

定稿：[workspace-prototype.tsx](../../src/interfaces/tui/workspace-prototype.tsx)，[80×24 continuous](../../artifacts/tui-prototype/continuous-v2b-80x24.png)、[50×40 continuous](../../artifacts/tui-prototype/continuous-v2b-50x40.png)。

本批查看：[120×40 工作区](screenshots/capture-2026-10-04T12-05-42-262Z/workspace-baseline-120x40-color-nerd.png)、[50×40 slash 已采用](screenshots/capture-2026-10-04T12-05-42-262Z/P47-slash-adopted-50x40-no-color-ascii.png)、[80×24 正文](screenshots/capture-2026-10-04T12-05-42-262Z/plan-body-first-range-80x24-color-nerd.png)。

主区仍以连续 transcript 和底部圆角 composer 为主，P47 候选位于输入框上方；图与依据阅读在独立工作区承载，没有将来源正文插入 transcript，也没有增加常驻 thought。三档中窄屏保留输入位置，No Color 仍可辨识选中项。长计划以来源 breadcrumb、版本和偏移标识正文；原始 plan 按 JSON 原结构展示，符合“保留原文”的合同，但可读性弱于原型中的普通对话文本，这是来源格式而非排版回归。依据页 Esc 逐层返回至原工作区，实际操作记录在 `operations.json` 的“逐层 Esc 返回”。本票本批结论：**布局与返回符合；历史搜索、Markdown、完整历史/流式行为沿用前驱验收范围，不由本批截图重验。**

### P-47 / #47：above-input 候选

定稿：[composer-prototype.tsx](../../src/interfaces/tui/composer-prototype.tsx)，[80×24 候选](../../artifacts/composer-prototype/slash-above-all-80x24.png)、[50×40 候选](../../artifacts/composer-prototype/slash-above-all-50x40.png)。

本批查看：[80×24 候选](screenshots/capture-2026-10-04T12-05-42-262Z/P47-slash-candidates-80x24-color-nerd.png)、[50×40 采用后](screenshots/capture-2026-10-04T12-05-42-262Z/P47-slash-adopted-50x40-no-color-ascii.png)。候选区域在 composer 上方，Tab 采用、Enter 执行、Esc 返回；三种宽度及两种图标/颜色环境都跑过该序列。选中行仍用反色标识，NO_COLOR 下保留字符与位置提示。当前 fixture 用 `/op` 得到单项 `/options`，所以展示的是窄候选状态，不代表复杂搜索、无结果或禁用项覆盖。本票本批结论：**候选层级与两步操作符合；完整候选状态另由前驱画面证据补足。**

### P-51 / #51：固定项目面板与三栏目

补充的前驱生产画面：[工作记录入口](../../artifacts/tui-prototype-alignment/repair-20261003/project-work-120x40-color.png)、[工作记录选中态](../../artifacts/tui-prototype-alignment/repair-20261003/project-work-selected-120x40-color.png)、[记录分组](../../artifacts/tui-prototype-alignment/repair-20261003/project-record-groups-120x40-color.png)。待答和事件内容态引用已归档生产 TUI PTY 采集：[待答页](../../artifacts/graph-basis/screenshots/capture-2026-10-04T11-34-18-308Z/P51-project-pending-80x24-no-color-ascii.png)、[事件页](../../artifacts/graph-basis/screenshots/capture-2026-10-04T11-34-18-308Z/P51-project-events-80x24-color-ascii.png)、[跨 Session 回答](../../artifacts/pending-interactions/sessions-120x40-color-nerd.png)。`project-panel-prototype` 下 PNG 是原型素材，只用于设计比照，不作为生产证据。

定稿：[project-panel-prototype.tsx](../../src/interfaces/tui/project-panel-prototype.tsx)，[120×40 总览](../../artifacts/project-panel-prototype/tabs-blocked-120x40.png)、[80×24 待答](../../artifacts/project-panel-prototype/tabs-pending-80x24.png)、[50×40 详情](../../artifacts/project-panel-prototype/tabs-details-50x40.png)。

本批查看：[120×40 总览](screenshots/capture-2026-10-04T12-05-42-262Z/P51-project-overview-120x40-color-nerd.png)、[80×24 待答页](screenshots/capture-2026-10-04T12-05-42-262Z/P51-project-pending-80x24-no-color-ascii.png)、[50×40 最近事件](screenshots/capture-2026-10-04T12-05-42-262Z/P51-project-events-50x40-color-ascii.png)。宽屏项目面板占用固定右栏，50 列时独占主工作区；总览、待答和事件通过 Tab 在同一外框切换，Ctrl+B 返回原工作区。本专项 fixture 不包含 pending interaction 或语义事件，截图仅呈现运行空态；内容态只引用上段前驱生产 PTY 证据，不以原型素材代替。

IP05 补采在生产 `TuiApp`、项目详情和 GraphBasis 端口中真实操作项目工作入口 → 工作详情 → GraphBasis 根页 → 当前 Route Map 来源 → 正文，执行 80×24、50×40、120×40 resize 与四层 Esc，确认回到项目总览后 Ctrl+B 返回原工作区。画面见 [basis-path 补采](screenshots/basis-path-2026-10-04T13-15-53-509Z/capture-report.md)：12 组合（3 尺寸 × color/NO_COLOR × Nerd/ASCII），每组合 8 对 PNG/PTY 文本，合计 96 对独立文件。原 13:00 采集因 resize 文件名重复，96 条样本只对应 72 对文件；修正命名后另存本次采集，旧证据保留。画面状态与正文来自临时 SQLite/fake tracker fixture，不代表真实项目或 Worker。逐票查看确认正文按可用列宽换行；窄屏来源摘要按组件规则省略，没有正文横向裁切。该补采仅覆盖入口路径，不是整个 P51 的新全矩阵。

本轮新采 `statusline-final-20261004` 补了 P-51 的总览、身份、预算与回答面板画面，逐张查看：[120×40 总览](screenshots/statusline-final-20261004/project-overview-planning-120x40-color-nerd.png)、[80×24 身份详情](screenshots/statusline-final-20261004/project-identity-planning-80x24-color-nerd.png)、[50×40 预算详情无色](screenshots/statusline-final-20261004/project-budget-planning-50x40-no-color-ascii.png)、[120×40 回答面板](screenshots/statusline-final-20261004/answer-panel-answer-120x40-color-nerd.png)。总览沿用定稿的固定右栏、`项目面板 · 总览` 标题、`[总览] 待答列表 最近事件 · Tab` 栏目行、三个分组与 `↑↓ 选择 · Enter 打开 · Esc 返回` 底部键位，选中行反色、不可用行用文字说明而非仅靠颜色；80 列与 50 列时面板独占主区域并保留同一外框，50 列正文按宽度换行没有横向裁切。回答面板在主区底部替换 composer，显示 `回答 1/2 · Shift+</> 切题 · Esc 返回`、问题正文、反色选中选项与提交提示。

**P-51 待答列表与最近事件的内容态已由 `project-content-2026-10-04T14-06-32.782Z` 补齐**，该目录以生产 `TuiApp`、隔离 SQLite 问答和 fixture `scope-control-changed` 语义事件运行，不接模型与 Orca，退出码 0；`pending-content`、`events-content`、`event-detail` 三组各跑满 12 组合，36 条样本记录对应 36 对独立文件，无重复记录，`checks.json` 12 条的 `pendingContent`、`semanticEventContent`、`eventDetailReturn` 全为真。逐张查看的代表：[待答 120×40](screenshots/project-content-2026-10-04T14-06-32.782Z/pending-content-120x40-color-nerd.png)、[待答 80×24 无色 ASCII](screenshots/project-content-2026-10-04T14-06-32.782Z/pending-content-80x24-no-color-ascii.png)、[待答 50×40 ASCII](screenshots/project-content-2026-10-04T14-06-32.782Z/pending-content-50x40-color-ascii.png)、[事件 120×40](screenshots/project-content-2026-10-04T14-06-32.782Z/events-content-120x40-color-nerd.png)、[事件 80×24 无色 ASCII](screenshots/project-content-2026-10-04T14-06-32.782Z/events-content-80x24-no-color-ascii.png)、[事件 50×40](screenshots/project-content-2026-10-04T14-06-32.782Z/events-content-50x40-color-nerd.png)、[事件详情 120×40](screenshots/project-content-2026-10-04T14-06-32.782Z/event-detail-120x40-color-nerd.png)、[事件详情 80×24](screenshots/project-content-2026-10-04T14-06-32.782Z/event-detail-80x24-color-nerd.png)、[事件详情 50×40 无色](screenshots/project-content-2026-10-04T14-06-32.782Z/event-detail-50x40-no-color-ascii.png)。

三档表现与定稿一致：120 列时项目面板占固定右栏（约 38 列），80 与 50 列时独占主区域并保留同一外框；标题行为 `项目面板 · 待答列表` / `· 最近事件` / `· 最近事件 · 详情`，栏目行用方括号标出当前页（`总览  [待答列表]  最近事件 · Tab`）；待答页有 `第 1 页 · PgUp/PgDn 翻页` 与 `显示 1–14/20` 的有界分页，当前会话项用 `›`、跨会话项用 `→` 并各带 `session-x · 待回答` 子行；事件页写明 `本次启动 · 最近至多 50 条`，条目为 `[control] scope-control-changed -> blocked`；详情页给出 `事件 ID: fixture-event-3` 与 `所属会话: Scope`，底部 `↑↓ 浏览 · Esc 返回列表`，与 `eventDetailReturn` 一致。NO_COLOR 下全部文字与 `›`/`→` 标记保留，选中行反色，状态不靠颜色单独表达。跨 Session 精确进入、回答面板与原提问处的 Q/A 在同一帧的对话区可见（`Q · 已回答` 与 `Q · 待回答` 各一条，`tool ask_user · 1 次 · ok`）。

本组与定稿的可见差异，均已按固定前驱 41b2f1e 核对归属（见开头归属表），没有一项由本批 UI 代码引入；均未改动代码，交由主会话判断：

1. 120 列固定右栏比 80/50 列独占主区域更窄，最宽屏反而省略更多。待答页底部键位被截成 `显示 1–14/20 · ↑↓ 选择 · Enter 打开 ·…`，`Esc 返回` 提示在该宽度不可见；事件列表首行的目标被截成 `-> …`，`blocked` 丢失；80 与 50 列两处都完整。宽度来自 `screens/workspace.tsx` 的 `projectWidth:terminalWidth>=100?terminalWidth-width:terminalWidth`，与 41b2f1e 相同，本批该文件只增加了 GraphBasis 投影分支。定稿 P-51 要求固定 sidebar 区域，这一取舍属前驱布局合同范围，此处只记录观感，不在本批重新设计。
2. 同一 fixture、同一页的待答列表顺序在两次运行间不稳定：120×40 与 50×40 的 Nerd 运行为 `9 → 10 → 11`，ASCII 运行为 `9 → 11 → 10`，80×24 两次一致，差异只落在第 10、11 两项之间。归属核对结论是不由本批 UI 引入：`project-panel.tsx:22` 按 `view.pendingPage.items` 原序渲染、组件内没有排序，`loadScopeQuestions` 的 keyset 分页与 `pending-interactions` 合同自 41b2f1e 未变，条目文案全部来自 `scripts/tui-preview.mjs` fixture。屏幕上也确实没有可见的排序键。若要为待答列表约定一个显式排序键，那属于独立的设计决定，不在本批视觉复核范围内。
3. 顶栏 `待答 25` 与待答列表 `1–14/20` 的分母不同，画面未说明两者关系（25 可能含已回答项）。此处只登记待澄清，不判为缺陷。
4. 事件页与详情页在 Nerd 与 ASCII 之间逐字节相同，说明这两处不渲染图标；待答页两种图标模式存在差异，但差异来自上述第 10、11 项顺序，不是图标渲染。

本票本轮结论：**三栏目固定外框、栏目切换、有界分页、跨 Session 标记、事件聚合计数与详情返回在三档宽度和两种颜色环境下都符合定稿；120 列右栏更窄导致键位与事件目标被省略、待答列表顺序在两次运行间不稳定，是两项确定差异待决。**

回答面板键位与定稿画面上的 `Ctrl+A 回答` 不同，但与项目当前约定一致（Ctrl+A/E 为行首尾，进入回答面板用 Shift+Left 或 `/answer`），此项按现行合同记录，不算原型回归。

2026-10-04 真实 PTY h 的 Finalizer 脚手架分页问题由主会话独立处理；本次画面采集未触碰真实现场，也不能抵销该问题。

### P-52 / #52：四类弹窗与图标呈现

定稿：[dialog-prototype.tsx](../../src/interfaces/tui/dialog-prototype.tsx)，[命令](../../artifacts/dialog-prototype/final/commands-80x24.png)、[会话](../../artifacts/dialog-prototype/final/sessions-80x24.png)、[授权](../../artifacts/dialog-prototype/final/authorization-overview-80x24.png)、[交接](../../artifacts/dialog-prototype/final/handoff-overview-80x24.png)、[取消](../../artifacts/dialog-prototype/final/cancel-confirm-80x24.png)。

本批查看：[Command Palette](screenshots/capture-2026-10-04T12-05-42-262Z/P52-command-directory-80x24-color-nerd.png)、[图标设置](screenshots/capture-2026-10-04T12-05-42-262Z/P47-slash-executed-P52-options-80x24-color-nerd.png)。Command Palette 保持固定圆角框、上方搜索、左右信息、底部键位；Nerd/ASCII 即时选择经全矩阵运行，弹层 Esc 返回 composer。四类已有弹窗中的授权、交接、Cancel/Exit 不在本批 IP05 逐一重开；其三档生产采集和默认返回证据沿用前驱 [command-reviews README](../../artifacts/command-reviews/README.md)：[授权审阅](../../artifacts/command-reviews/authorization-overview-80x24-color-nerd.png)、[交接审阅](../../artifacts/command-reviews/handoff-overview-80x24-color-nerd.png)、[Cancel 确认](../../artifacts/command-reviews/cancel-default-return-80x24-color-nerd.png)、[Exit 确认](../../artifacts/command-reviews/exit-default-return-80x24-color-nerd.png)。前驱报告记录 120/80/50 列及色彩/图标矩阵、审阅栏目和返回恢复；本批不把图标选择误作四类弹窗全新复验。本票本批结论：**目录与图标选择符合；四类弹窗以已归档前驱生产证据补齐。**

本轮新采 `reviews-final-20261004` 首次在当前 dist 上把四类弹窗与两个选择器全部重开，108 对独立文件、12 组合，无重复记录。7 组概览画面（目录、选项、会话、模型、授权概览、交接概览、Cancel）各跑满 12 组合；8 组子栏目与 resize 画面（授权权限/预算/工作范围/完整清单、交接责任/绑定、Exit、压缩搜索）各 3 对 color/nerd。逐张查看的代表：[目录 80×24](screenshots/reviews-final-20261004/directory-search-80x24-color-nerd.png)、[Cancel 50×40 无色 ASCII](screenshots/reviews-final-20261004/cancel-default-return-50x40-no-color-ascii.png)、[授权概览 80×24](screenshots/reviews-final-20261004/authorization-overview-80x24-color-nerd.png)、[授权预算 50×40](screenshots/reviews-final-20261004/authorization-budget-50x40-color-nerd.png)、[交接概览 120×40](screenshots/reviews-final-20261004/handoff-overview-120x40-color-nerd.png)、[交接绑定 80×24](screenshots/reviews-final-20261004/handoff-binding-80x24-color-nerd.png)、[Exit 120×40](screenshots/reviews-final-20261004/exit-default-return-120x40-color-nerd.png)、[会话 50×40 无色](screenshots/reviews-final-20261004/session-search-50x40-no-color-ascii.png)、[模型 80×24 无色](screenshots/reviews-final-20261004/model-search-80x24-no-color-ascii.png)、[图标选项 120×40 Nerd](screenshots/reviews-final-20261004/options-search-120x40-color-nerd.png) 与 [同帧 ASCII](screenshots/reviews-final-20261004/options-search-120x40-color-ascii.png)、[压缩搜索 50×40](screenshots/reviews-final-20261004/resize-search-50x40-color-nerd.png)。

符合定稿的部分：固定圆角外框、标题行、绑定身份行、栏目行、底部分隔线、黄色 `当前操作` 行、`[返回]` 反色加次要动作、`Tab 栏目 · ↑↓ 浏览 · ←→ 动作 · Enter/Esc` 底部键位，三档宽度都保持同一外框不塌陷；反色动作与默认返回一致，Esc 逐层退回搜索与工作区（`checks.json` 的 `reviewBlocksNavigation`、`exitKeepsReview` 为真）。身份行改为绑定精确对象（`graph graph-prototype · revision 7`、`session-long-中文规划-2026 ➜ session-b`、`Scope · active`），比定稿的通用 `来自 对话` 更贴合来源绑定合同。图标偏好在选项弹窗以文字呈现：Nerd 帧写 `当前图标 nerd`，ASCII 帧写 `当前图标 ascii`；`statusline-final-20261004` 另给出 [保存成功](screenshots/statusline-final-20261004/icon-saved-planning-120x40-color-ascii.png) 与 [保存失败保留草稿](screenshots/statusline-final-20261004/icon-failed-save-retained-planning-120x40-color-ascii.png) 两帧，失败时顶栏写明 `图标已切换但未保存：fixture_write_failed`，弹窗保持打开且不丢选择。

本批与定稿画面的可见差异，全部沿用前驱 41b2f1e，本批未改动任何相关组件（见开头归属表）；均未改动代码，交由主会话判断：

1. 五个弹窗标题为纯英文：`Execution Authorization Review`、`Handoff Review`、`Cancel Scope`、`Exit Companion`、`Session Picker`；同批 `Command Palette · 命令目录` 与 `Model Picker · 模型配置` 仍是双语。定稿画面是 `Execution Authorization · 执行授权`、`Handoff · 责任交接`、`Cancel · 停止项目协调` 这样的双语标题。来源是生产 `DialogFrame` 的 title 写法：`authorization-review.tsx:44`、`handoff-review.tsx:76`、`control-bar.tsx:80`、`session-picker.tsx:54` 自 41b2f1e 起就是英文且本批未改，双语文案只存在于原型入口 `dialog-prototype.tsx`。因此这是沿用前驱的差异，不是本批回归；本批不重新设计标题。
2. Command Palette 底部没有 `n/m` 位置计数和 `搜索目录项 · 新消息保留当前输入` 提示行。`command-palette.tsx:42` 自 41b2f1e 起 footer 只有 `↑↓ 选择 · Enter 确认 · Esc 返回`，本批未改；那两行只存在于未改动的 `dialog-prototype.tsx:406,408`，即原型预览入口才有。同批 Model Picker 的 `1/8` 来自 `dialog-prototype.tsx` 的 models 分支，属同一来源。结论同上是沿用前驱的入口差异，不是本批回归。
3. 审阅弹窗的 `当前操作：返回` 没有 `行 1-8/9` 区间。这不是差异：`selection-list.tsx:110` 的 `· 行 N–M/total` 只在 `wrapped.length>budget`、即换行后的正文超出可见行预算时追加，该文件与 41b2f1e 逐字节相同；本批审阅正文行数少，未触发该条件。底部 `←→ 按键`（原型）对 `←→ 动作 · Enter/Esc`（生产）同样自 41b2f1e 起如此。
4. 目录弹窗右侧说明与内框只留 1 列间距，右对齐标签紧贴边框。这与定稿间距一致（定稿 `切换会话 │` 同样是 1 列），不是回归；50 列时标签按可用宽度截断，会话选择器用 `…` 收尾。此项仅作记录。
5. 除选项弹窗外，本批全部审阅与选择器画面在 Nerd 与 ASCII 之间逐字节相同，说明这些弹窗当前不渲染图标。图标切换在本批只能由选项弹窗的 `当前图标` 文字、以及 `statusline-final-20261004` 中 80×24 图侧栏的 `♡`/框线对 `+--+`/`+2` 差异证明。

本票本轮结论：**四类弹窗的布局、层级、反色默认返回与三档宽度符合定稿；标题、Command Palette 位置计数与提示沿用固定前驱，未由本批改变。图标切换在本批的可观察范围仅限选项弹窗与图侧栏。**

### P-48 / #48：custom-direct 顶栏与状态栏

场景状态的前驱生产画面：[planning](../../artifacts/project-statusline/release/workspace-planning-120x40-color-nerd.png)、[execution](../../artifacts/project-statusline/release/workspace-execution-120x40-color-nerd.png)、[blocked](../../artifacts/project-statusline/release/workspace-blocked-120x40-color-nerd.png)、[idle](../../artifacts/project-statusline/release/workspace-idle-120x40-color-nerd.png)、[当前待答回答](../../artifacts/project-statusline/release/answer-panel-answer-120x40-color-nerd.png)。全矩阵与内容态分布见[release 样本清单](../../artifacts/project-statusline/release/samples.json)及[前驱报告](../../artifacts/project-statusline/README.md)。这些链接补齐场景参考，不作为本批新运行结果。

定稿：[statusline-prototype.tsx](../../src/interfaces/tui/statusline-prototype.tsx)，[custom-direct 索引](../../artifacts/statusline-prototype/custom-direct/README.md)，[整体布局](../../artifacts/statusline-prototype/custom-direct/custom-restored-80x24.png)、[字段配色](../../artifacts/statusline-prototype/custom-direct/field-colors-80x24.png)、[无色字段](../../artifacts/statusline-prototype/custom-direct/field-monochrome-80x24.png)。

本批查看：[120×40 主工作区与状态栏](screenshots/capture-2026-10-04T12-05-42-262Z/workspace-baseline-120x40-color-nerd.png)、[50×40 无色窄屏](screenshots/capture-2026-10-04T12-05-42-262Z/workspace-baseline-50x40-no-color-ascii.png)。顶栏保持单行，显示 scope/branch/session/模式与控制状态；statusline 显示示例模型、effort、context 与当前图。窄屏按宽度省略字段，没有把细节搬到多行；有色字段区分清楚，NO_COLOR 仍保留语义文本。当前 capture 使用 project-statusline 预览 ports，数值是 fixture，不能证明模型/context 真实度量，也不覆盖 custom 格式、排序和持久保存。前驱第七批 [生产画面索引](../../artifacts/project-statusline/README.md) 及 [custom 偏好采集](../../artifacts/statusline-prototype/custom-direct/README.md) 提供偏好编辑、保存/失败与配色状态的既有证据。本票本批结论：**常驻布局符合；真实 metadata 与 custom 持久化沿用前驱合同证据，不由 fixture 冒充。**

本轮新采 `statusline-final-20261004` 覆盖定稿 custom-direct 的全部五个场景相位（blocked、planning、execution、answer、idle），三档尺寸 × 彩色/NO_COLOR × Nerd/ASCII 的 12 组合都在生产 `TuiApp` 下运行，114 对独立文件。逐张查看的代表：[120×40 规划](screenshots/statusline-final-20261004/workspace-planning-120x40-color-nerd.png)、[120×40 阻塞](screenshots/statusline-final-20261004/workspace-blocked-120x40-color-nerd.png)、[120×40 执行](screenshots/statusline-final-20261004/workspace-execution-120x40-color-nerd.png)、[120×40 空闲](screenshots/statusline-final-20261004/workspace-idle-120x40-color-nerd.png)、[80×24 Nerd](screenshots/statusline-final-20261004/workspace-planning-80x24-color-nerd.png)、[80×24 ASCII 无色](screenshots/statusline-final-20261004/workspace-planning-80x24-no-color-ascii.png)、[50×40 阻塞](screenshots/statusline-final-20261004/workspace-blocked-50x40-color-nerd.png)、[50×40 无色 ASCII](screenshots/statusline-final-20261004/workspace-planning-50x40-no-color-ascii.png)、[设置 120×40](screenshots/statusline-final-20261004/statusline-settings-planning-120x40-color-nerd.png)、[设置 80×24](screenshots/statusline-final-20261004/statusline-settings-planning-80x24-color-nerd.png)、[设置 50×40 无色](screenshots/statusline-final-20261004/statusline-settings-planning-50x40-no-color-ascii.png)、[中文草稿光标 120×40](screenshots/statusline-final-20261004/cjk-cursor-planning-120x40-color-nerd.png)。

符合定稿的部分：顶栏保持单行，显示 scope/branch/session、模式、控制状态与待答数；风险不挤进顶栏，而是像定稿那样另起独立行——阻塞相位下是 `! reconciling · 原操作结果未知，待对账` 与 `! Worker 状态待核验 · 另有 2 项`，执行相位下是 `! Worker 状态待核验` 与 `! worker_status_unverifiable: wp-13 …`，没有风险时不占行。状态栏一行显示模型、推理强度、上下文与图版本，字段按定稿配色区分：上下文绿色、图版本亮蓝、分隔符灰色。设置页与定稿的 direct-options 同构：圆角框、`状态栏设置` 标题与身份行、`状态栏 · ↑↓选择 · 空格切换 · ←→排序/格式` 提示、九个字段（模型名称、推理强度、上下文已用比例、图代际与版本、当前规划票、当前执行工作包、验收进度、流程预算、预算类别）加末项 `恢复默认（空格）`、`核心信息常驻；这里只调整展示格式` 说明、实时预览行与 `Enter 保存 · Esc 取消`。字段勾选框 `[x]`/`[ ]` 在 NO_COLOR 下保留，50 列无色帧仍能读出全部字段。定稿的保存失败、跨 Session 与重启覆盖证据在本批继续成立：`icon-failed-save-retained`、`icon-saved`、`icon-restart-env-override` 三帧对应 `preference-verification.json` 的 `transientOverridePersisted: false`。

本批与定稿的可见差异，全部沿用前驱 41b2f1e 且本批未改动相关组件（见开头归属表）；均未改动代码，交由主会话判断：

1. 上下文字段的值格式是 `上下文 已用 62%`，定稿画面是 `上下文 62k/100k`。字段名与位置一致，只是承载值的写法不同。
2. 设置页身份行是 `示例仓库 · refs/heads/main · session-long-中文规划-2026`，定稿是 `orca-companion / main · S-A · 来自 对话`。生产给出的是更精确的仓库、分支与 Session 身份，但定稿里的 `来自 对话` 这个来源面包屑在设置页和审阅弹窗中都不再出现，返回上下文只能靠 Esc 逐层感知。
3. 50 列状态栏省略 `图` 字段（`示例模型 A · 推理 high · 上下文 已用 62%`），80 与 120 列保留 `图 G1-v3`；设置页预览行在 80 列写 `图 G1·v3`、50 列整字段消失。按宽度省略符合合同，记录在此。
4. 状态栏设置、项目详情与审阅弹窗的画面在 Nerd 与 ASCII 之间逐字节相同，这些区域当前不渲染图标；本批的图标差异只在 80×24 图侧栏明显可见。

关于 idle 相位需要更正本报告早先的判断，并按 CONTEXT 的领域语言重述。idle 与 planning 两帧在顶栏和状态栏上完全相同，只有图侧栏不同（idle 为 `图未建立`、`验收摘要不可用`、`所选节点不可用`）；50 列不渲染图侧栏，于是 `workspace-idle-50x40-*` 与 `workspace-planning-50x40-*` 四个文件逐字节相同。按 [CONTEXT.md](../../CONTEXT.md)，Coordination Scope 的显式模式是 `route_planning`，其定义就是与用户交互式规划并形成 Execution Graph 候选；这里的 idle 场景是 `route_planning` 模式加 Scope 的 active 控制状态，再叠加 CONTEXT 定义的 **Coordinator Session Suspension**——「a Coordinator Session has no active model loop and awaits new Actionable Work while the Controller and Workers may continue running」。也就是说 idle 描述的是 Session 循环的挂起，不是第三种控制状态；此时没有已建立图，图侧栏显示 `图未建立`、`验收摘要不可用` 正是该状态的正确表现。核对已归档第七批生产证据确认这是既有基线：前驱 `artifacts/project-statusline/release/` 的 `workspace-idle-120x40-color-nerd.png` 顶栏同样写 `规划 · active · 待答 0`，且其 `workspace-idle-50x40-color-nerd.png` 与 `workspace-planning-50x40-color-nerd.png` 的 MD5 完全相同。因此本报告不把窄屏下无图当作设计缺陷，也不提出新增 idle 控制状态；这条只作证据边界记录。

本票本轮结论：**顶栏单行、独立风险行、状态栏字段配色与设置页结构符合定稿，三档宽度与两种颜色/图标环境都跑过；idle 与 planning 顶栏一致属于第七批既有基线，只作证据边界记录。**

### P-43 / #43：adaptive 图、Inspector 与历史依据

定稿：[graph-sidebar-prototype.tsx](../../src/interfaces/tui/graph-sidebar-prototype.tsx)、[final 索引](../../artifacts/dialog-prototype/final/README.md)，[默认侧栏](../../artifacts/dialog-prototype/final/sidebar-nerd-120x40.png)、[依据 Inspector](../../artifacts/dialog-prototype/final/inspector-evidence-nerd-80x24.png)、[工作范围 Inspector](../../artifacts/dialog-prototype/final/inspector-scope-nerd-80x24.png)。

本批查看：[120×40 adaptive 工作区](screenshots/capture-2026-10-04T12-05-42-262Z/workspace-baseline-120x40-color-nerd.png)、[全屏 Inspector](screenshots/capture-2026-10-04T12-05-42-262Z/inspector-baseline-120x40-color-nerd.png)、[依据根入口](screenshots/capture-2026-10-04T12-05-42-262Z/basis-root-80x24-color-nerd.png)、[全代际目录第二页](screenshots/capture-2026-10-04T12-05-42-262Z/all-generations-next-page-120x40-color-nerd.png)、[来源目录](screenshots/capture-2026-10-04T12-05-42-262Z/current-source-directory-120x40-color-nerd.png)、[原计划正文](screenshots/capture-2026-10-04T12-05-42-262Z/plan-body-first-range-80x24-color-nerd.png)、[tracker 正文](screenshots/capture-2026-10-04T12-05-42-262Z/tracker-body-pinned-continuation-50x40-no-color-ascii.png)。生产图仍复用 adaptive 画布和分区节点卡，Inspector 仍是原图、卡片和三栏目，没有增加第四栏目。新历史目录跨 G0/G1/G2 分页，显示各自图身份与登记代际状态；原计划、accepted patch、授权/规格/Route Map 的来源身份分开，正文沿 UTF-8 范围连续读取。计划以 JSON 原结构显示，Route Map 明确标为当前非历史快照。三档 resize 保留来源身份与阅读位置；Esc 从正文、目录、依据入口与 Inspector 逐层回到主区。50 列检查 Inspector 为主区布局，80 列和 120 列保持既定布局；color/NO_COLOR、Nerd/ASCII 全矩阵均已采集。

退役节点额外证据沿用 [退休历史专项](screenshots/retired-history-2026-10-04T11-23-33-460Z/retired-work-package-historical-version-120x40-color-nerd.png)：隔离 SQLite fixture 中 accepted revision 明确移出 `wp-d`，画面能说明历史依据仍可读；该选择和 patch 都是合成记录。本批图/依据结论：**入口、历史拓扑和有界来源阅读的呈现符合；不证明真实执行/patch/retire 业务闭环，真实验收由主会话独立记录。**

## 全链路观察与差异

144 条操作记录均无语义失败；每配置执行工作区 → P47 候选采用/执行 → P52 Command Palette/图标选择 → P51 三栏目 → Inspector → 图历史目录及下一页 → 初始计划与当前 Route Map 正文 → 80×24、50×40、120×40 连续 resize → Esc 返回工作区。每配置保存 18 帧；操作日志还记录中间导航。P52 其余审阅弹窗与 planning/execution/blocked/idle 场景已由本轮两个新目录在当前 dist 上补齐；P51 待答/事件内容态由 `project-content-2026-10-04T14-06-32.782Z` 单独补齐。

画面差异与处理：

- P51 待答页和事件页在 IP05 批次只呈现空/不可用态，因为 GraphBasis 专项 preview fixture 未构造真实 pending interaction 或语义事件；`statusline-final-20261004` 也没有采到这两个栏目的内容。`project-content-2026-10-04T14-06-32.782Z` 用隔离 SQLite 问答与 fixture 语义事件补齐了内容态，事件条目全部是合成的 `scope-control-changed`，不能当作真实业务事件。
- 独立真实 PTY h 因 Finalizer 脚手架仍假设项目详情单页，而 5A/7 的批准契约使用有界分页而失败。主会话修复脚手架；本报告的隔离画面矩阵不覆盖、也不能清除此项失败。
- Orca 1.4.218 的 `worker-show` `agentTerminalHandle` 字段漂移已获用户批准并修复，60项既有 adapter/launch/probe 回归通过；本视觉复核未调用 Orca，不据此推断真实闭环完成。
- P52 的授权、handoff、Cancel 与 Exit 弹窗在 IP05 批次未再次打开，当时引用第六批 command-reviews 的生产 PTY 证据和操作报告。本轮 `reviews-final-20261004` 已在当前 dist 上把这四类弹窗连同子栏目全部重开，上一节的差异清单以本轮画面为准。
- P48 当前顶栏字段和值取自隔离预览投影，布局/省略可看，fixture 数字不是能力证据。本轮 `statusline-final-20261004` 补了五个相位与设置/保存失败/重启覆盖的新画面，custom 编辑、保存失败与配色仍与第七批已有证据一致。
- 原始计划以 JSON 原结构显示。tracker 正文在补采的 120、80、50 列画面中按可用宽度换行；resize 后重新排版并保留来源身份。此前“长行横向裁切”的判断有误，逐票查看 PNG 后已更正。窄屏来源标题/摘要按组件规则省略，正文没有横向裁切。
- 所有新 capture 都是生产 UI + fake ports/临时 SQLite。图版本、退役、tracker、授权和 Worker 事实不可用于证明真实 Orca 执行或用户项目状态。

### 本轮场景覆盖结论

本轮两个新目录把六票里最缺画面的 P-48 与 P-52 补成了当前 dist 上的生产证据，场景覆盖如下。

| 票 | 本轮新采覆盖 | 仍缺 |
| --- | --- | --- |
| P-48 | blocked/planning/execution/answer/idle 五相位 × 12 组合；状态栏设置 12 组合；项目身份 12、项目预算 12、回答面板 12；中文草稿光标、Inspector、编辑/草稿/恢复默认/保存返回、slash 草稿返回、图标保存成功与失败、重启环境覆盖各 1 帧；预算与草稿 resize 各 3 帧 | 真实 effort/context/Claim/预算 metadata 的可信测量；custom 格式排序的完整生产复验沿用第七批 |
| P-52 | 目录、选项、会话、模型、授权概览、交接概览、Cancel 七组概览各 12 组合；授权权限/预算/工作范围/完整清单、交接责任/绑定、Exit、压缩搜索各 3 帧 color/nerd | 弹窗本身不渲染图标；标题与 Command Palette 计数沿用前驱，归属见开头表格 |
| P-51 | 总览、身份详情、预算详情、回答面板（`statusline-final-20261004`）；待答列表、最近事件、事件详情各 12 组合共 36 对（`project-content-2026-10-04T14-06-32.782Z`） | 真实 ask_user 交互产生的问答与事件；本批事件全部是 fixture `scope-control-changed`；跨 Session 回答的完整返回证据仍沿用第五批 |
| P-43 | 120×40 全屏 Inspector 一帧 | 三档 resize、历史图与依据正文本轮未重采，沿用本报告前段矩阵与 basis-path 补采 |
| P-40 / P-47 | 中文草稿与光标、slash 草稿返回各 1–3 帧 | 本轮未重采连续 transcript、候选两步与历史分页，沿用前段矩阵 |

所有评价只覆盖布局、层级、配色与导航。真实 Orca 闭环、Worker 执行、项目验收和业务状态仍未验收，本报告不因画面齐备而改变这一边界。

### 逐张实际查看的图像

已批准原型代表图（10 张）：`statusline-prototype/custom-direct/custom-restored-80x24.png`、`field-colors-80x24.png`、`field-monochrome-80x24.png`、`direct-options-colors-120x40.png`、`project-panel-prototype/tabs-blocked-120x40.png`、`tabs-pending-80x24.png`、`dialog-prototype/final/commands-80x24.png`、`authorization-overview-80x24.png`、`handoff-overview-80x24.png`、`cancel-confirm-80x24.png`。

本轮生产新采（31 张）：`statusline-final-20261004/` 下 `workspace-planning-120x40-color-nerd`、`workspace-blocked-120x40-color-nerd`、`workspace-execution-120x40-color-nerd`、`workspace-idle-120x40-color-nerd`、`answer-panel-answer-120x40-color-nerd`、`statusline-settings-planning-120x40-color-nerd`、`statusline-settings-planning-80x24-color-nerd`、`statusline-settings-planning-50x40-no-color-ascii`、`workspace-planning-80x24-color-nerd`、`workspace-planning-80x24-no-color-ascii`、`workspace-blocked-50x40-color-nerd`、`workspace-planning-50x40-no-color-ascii`、`project-overview-planning-120x40-color-nerd`、`project-identity-planning-80x24-color-nerd`、`project-budget-planning-50x40-no-color-ascii`、`graph-inspector-planning-120x40-color-nerd`、`cjk-cursor-planning-120x40-color-nerd`、`icon-saved-planning-120x40-color-ascii`、`icon-failed-save-retained-planning-120x40-color-ascii`；`reviews-final-20261004/` 下 `directory-search-80x24-color-nerd`、`authorization-overview-80x24-color-nerd`、`authorization-budget-50x40-color-nerd`、`handoff-overview-120x40-color-nerd`、`handoff-binding-80x24-color-nerd`、`exit-default-return-120x40-color-nerd`、`cancel-default-return-50x40-no-color-ascii`、`session-search-50x40-no-color-ascii`、`model-search-80x24-no-color-ascii`、`options-search-120x40-color-nerd`、`options-search-120x40-color-ascii`、`resize-search-50x40-color-nerd`。

P-51 内容态新采（9 张）：`project-content-2026-10-04T14-06-32.782Z/` 下 `pending-content-120x40-color-nerd`、`pending-content-80x24-no-color-ascii`、`pending-content-50x40-color-ascii`、`events-content-120x40-color-nerd`、`events-content-80x24-no-color-ascii`、`events-content-50x40-color-nerd`、`event-detail-120x40-color-nerd`、`event-detail-80x24-color-nerd`、`event-detail-50x40-no-color-ascii`。

为复核 idle 判断另外查看已归档第七批前驱画面（2 张）：`project-statusline/release/workspace-idle-120x40-color-nerd.png` 与 `workspace-planning-120x40-color-nerd.png`。

另按同名 PNG 的 MD5 逐组核对了三批的画面内容：确认 `reviews-final-20261004` 除 options 外全部 Nerd/ASCII 同名帧逐字节相同，`statusline-final-20261004` 的 idle 与 planning 在 50 列逐字节相同（第七批前驱同样如此），`project-content-2026-10-04T14-06-32.782Z` 的事件页与详情页 Nerd/ASCII 同名帧逐字节相同，而待答页在 120×40 与 50×40 的两次运行间只有第 10、11 项顺序不同。这些重复是同名覆盖或无内容差异，不另计为独立证据。

## 运行记录

- 命令：`node artifacts/graph-basis/capture.mjs`
- 退出码：0
- 输出：192 对独立 PNG/TXT（216 条样本记录，其中 12 个 `basis-body-resize` 文件各记 3 次）；12/12 组合；144 条操作记录；0 个语义失败。
- 矩阵：`120×40 / 80×24 / 50×40` × `color / no-color` × `nerd / ascii`。
- 最新画面及操作报告：[capture-report.md](screenshots/capture-2026-10-04T12-05-42-262Z/capture-report.md)、[samples.json](screenshots/capture-2026-10-04T12-05-42-262Z/samples.json)、[operations.json](screenshots/capture-2026-10-04T12-05-42-262Z/operations.json)。
- 项目入口专项补采：[capture-report.md](screenshots/basis-path-2026-10-04T13-15-53-509Z/capture-report.md)、[samples.json](screenshots/basis-path-2026-10-04T13-15-53-509Z/samples.json)、[operations.json](screenshots/basis-path-2026-10-04T13-15-53-509Z/operations.json)：12/12 组合、96 对独立 PNG/TXT，项目→依据→resize→逐层返回路径完成。
- 本轮新采：`reviews-final-20261004` 由 `node artifacts/graph-basis/capture-reviews-final.mjs` 生成；`statusline-final-20261004` 由 `node artifacts/project-statusline/capture.mjs ../graph-basis/screenshots/statusline-final-20261004` 生成，退出码 0，该脚本按 `process.argv[2]` 相对 `artifacts/project-statusline` 解析输出目录。两者均为生产 `TuiApp` + 隔离 fake ports，不接模型与 Orca。
- 状态栏与项目面板新采：[statusline-final-20261004](screenshots/statusline-final-20261004/)：12/12 组合、114 对独立 PNG/TXT（116 条样本记录，`project-budget-planning-120x40-color-nerd` 与 `project-identity-planning-120x40-color-nerd` 各被记录两次）；`checks.json` 全部 `productionApp: true`、`isolatedPorts: true`；`preference-verification.json` 记录 `iconMode: ascii`、`transientOverridePersisted: false`。
- 弹窗与审阅新采：[reviews-final-20261004](screenshots/reviews-final-20261004/)：12/12 组合、108 对独立 PNG/TXT，无重复记录；`checks.json` 12 条的 `draftCursorText`、`directoryQueryReturned`、`reviewBlocksNavigation`、`exitKeepsReview` 均为真。
- P51 内容态新采：`screenshots/project-content-2026-10-04T14-06-32.782Z/`，退出码 0；12/12 组合、36 对独立 PNG/TXT，`samples.json` 36 条记录对应 36 个文件；`checks.json` 12 条的 `pendingContent`、`semanticEventContent`、`eventDetailReturn` 均为真；生产 `TuiApp` + 隔离 SQLite 问答 + fixture `scope-control-changed`，无模型与 Orca。
- 差异归属核对：`41b2f1e` 为 HEAD；`git diff 41b2f1e -- src/interfaces/tui` 只涉及 `app.tsx`、`components/graph-inspector.tsx`、`components/project-panel.tsx`、`ports.ts`、`screens/workspace.tsx`、`state.ts`。逐票差异的归属见开头「与固定前驱 41b2f1e 的差异归属」表；表中列出的组件均与 41b2f1e 逐字节相同或不在改动集内。本批未改动任何生产代码。
- 本报告不新增 `verification.md`，不提交、不归档、不安装依赖、不调用 Orca，也不使用 thread 类工具；代码差异只报告不修改。
- 本报告记录画面和导航证据，不对 IP05 真实执行、GraphChangeRequest 的 retire 语义或整个 change 作 PASS 判断；真实执行由主线单独验收。
- 此项不覆盖 IP05 真实执行验收；真实环境结果及全 change 结论由主会话另行记录。
