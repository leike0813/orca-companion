# TUI 调试工作台

按项目工具链准备依赖后运行 `pnpm build`。预览加载构建后的 `TuiApp` 与固定假端口，不连接外部 provider、Orca 或 tracker；输入与历史使用隔离内存 SQLite。基础场景的提交和 Scope 控制显示 `preview_read_only` 拒绝，alignment 场景仅在隔离内存端口中模拟。

`pnpm ui:preview history` 使用隔离内存 checkpoint store，覆盖全历史 keyset 与巨型原文范围；`pnpm ui:preview streaming` 使用本地假 chat model 的真实 stream、生产 graph 和临时 preview store。两者都挂载生产 TuiApp；不连接外部 provider 或 Orca。PgUp/PgDn 逐视窗阅读，Ctrl+Home/End 直达最早/最新，Esc 在 overlay 返回后回到最新；离底更新只标记，resize 保留原文位置。采集和性能命令见 [3B 证据](../../artifacts/bounded-transcript/README.md)。

在交互式终端运行 `pnpm ui:preview planning`。基础场景为 `planning`、`execution`、`blocked`、`empty`、`long-cjk`、`answer`、`disabled`，均挂载生产 `TuiApp`。`alignment` 与 `alignment-planning` 复用 20 节点及长身份夹具，增加待答/事件和可审阅的隔离假端口；仅在内存模拟意图，不装配生产 Controller、模型或 Orca。预览要求 stdin/stdout 都是 TTY；`Esc` 逐层返回，`Ctrl+C` 退出。改动源码后重新构建并启动预览。

生产组件的 Ctrl+B 打开固定项目面板，Tab 切总览/待答/最近事件，Enter 下钻、Esc 返回；120 列对话保持原位，80/50 列面板独占主区域。项目待答页可显式选择跨 Session 问题，进入其回答面板；返回恢复原入口、草稿与阅读锚点。Ctrl+G 打开三档可浏览的图检查：上下选择、左右选择真实关系、多关系明确确认、Enter 详情、Tab 栏目。命令候选在输入上方，第一次 Tab/Enter 填入，第二次 Enter 执行。审阅固定框内 Tab 切概要/完整记录、上下浏览，默认返回，左右选动作后 Enter；Cancel/Exit 同时保留 y/n 明确确认，无色以“当前操作”辨识。第七批沿 IC-15 接通 Ctrl+P → 选项的图标与状态栏保存恢复，状态和验收以 [原型交接](tui-implementation-handoff.md) 的当前任务记录为准。

生产工作区将草稿、粘贴载荷与提交快照保存到仓库 Git common dir 下的 `orca-companion/ui.sqlite`。`/inputs` 打开输入记录管理：选择记录后 `r` 恢复、`v` 核验、`d` 删除；恢复不会自动发送。退出时立即保存，失败则留在界面，明确确认后才丢弃未保存输入。预览使用独立内存输入库，退出即关闭，不影响生产记录。

主工作区临时原型运行 `pnpm ui:prototype planning`（同样可选上述场景）。`Ctrl+R` 打开消息历史，`Ctrl+T` 折叠或展开最新工具输出。原型内的思路摘要、消息和工具输出是固定假数据，不来自真实 Coordinator Session；原型代码位于 `src/interfaces/tui/workspace-prototype.tsx`。

执行图侧栏临时原型运行 `pnpm ui:graph-prototype execution`，也可选 `planning` 或 `blocked`。`Tab` 切换纵向分叉图与横向流向图，`M` 在三种场景间切换；节点位置只由固定依赖决定，运行态仅对当前 live 节点及入边施加短周期动效。使用固定的 Controller 快照假数据，经现有 `projectTuiViewModel` 投影，不连接真实执行后端。

图节点默认使用 [Nerd Fonts Material Design 图标](https://github.com/ryanoasis/nerd-fonts/blob/master/glyphnames.json)，图标后预留一个空格；运行动画通过项目已有 `@inkjs/ui` 的 `useSpinner` 驱动月相字形。侧栏底部提示图标异常时在选项中切回 ASCII。弹窗原型通过 `Ctrl+P → 选项 → ASCII` 切换；独立图原型按 `O` 打开图标选项。选择立即作用于图节点、运行动画和画布连线，切换会话或场景时保留本次打开的选择。ASCII 模式使用普通字符和 `-|/\\` 运行动画。启动时也可用 `ORCA_COMPANION_TUI_ICONS=ascii pnpm ui:dialog-prototype execution` 显式选择 ASCII。图标模式由用户选择，不依据终端环境猜测字体。此设置当前用于图原型，其他界面仍沿用现有符号。

更复杂的 12 节点图运行 `pnpm ui:graph-prototype execution large`。在 160 列及以上终端，侧栏图区域扩到 64 列；小终端沿用 40/24 列侧栏和折叠规则。其余场景与切换键位相同。

自适应压力原型运行 `pnpm ui:graph-prototype execution adaptive`：20 个节点，侧栏宽度随终端列数连续变化。图下保留带边框的选中节点卡片，区分标题、状态/Worker、依赖关系；前驱与后继显示准确编号。画布使用剩余高度，缩短层间距后围绕所选节点裁切，并显示图外节点数。当前节点与 blocker 保留在侧栏。`J/K` 逐节点移动焦点并高亮入边，`F` 回到当前执行节点，`Tab` 与 `M` 沿用布局/场景切换。项目面板与弹窗原型也复用这张卡片；全屏“执行图检查”显示依赖名称，并增加执行依据、工作范围和完整身份栏目，Tab 切信息，Enter 阅读完整详情。截图与检查见 `artifacts/dialog-prototype/README.md`。

Composer 的 slash 对照直接运行 `pnpm ui:composer-prototype slash above`，或把末尾改为 `inside`：B 在输入框上方显示独立候选框，A 在同一个输入框边框内展开候选。无参数时默认 B；`Ctrl+T` 切换方案，输入 `/` 后继续输入可过滤。B 列出所有匹配项，当前可用项反色高亮；↑↓ 改变高亮项，`Tab`／Enter 填入它，Esc 关闭。`Ctrl+P` 打开全局 Command Palette 作对照。长文、图片与待答背景场景仍可选 `typing`、`long`、`images`、`answer`，末尾可追加 `inline` 或 `review`；`Ctrl+N` 切换假 Session，`Ctrl+A` 切换绑定待答问题的回答模式，`Ctrl+L` 加载长文本，`Ctrl+O`／`Ctrl+D` 添加／移除模拟图片。图片仅用元数据演示，Enter 只显示模拟提交提示。此入口沿用固定 Controller 快照投影与 #40 continuous transcript 原型。截图和主流 CLI 对照见 `artifacts/composer-prototype/README.md`。

顶栏／状态行运行 `pnpm ui:status-prototype blocked custom`，可选 `planning`、`execution`、`blocked`、`answer`、`idle`；末尾保留 `current`、`fixed` 作对照，默认采用用户选定的 `custom`。此入口共用已选定的项目面板、四类弹窗、continuous transcript、composer 与 adaptive 图。`Ctrl+P → 选项 → 状态栏` 可设置模型名称、上下文格式，并勾选/排序图版本、规划票、执行工作包、验收进度和流程预算；三核心项常驻，附加项空间不足时按序让位。配置草稿实时预览主区域宽度；保存成功才应用并写原型专用用户 JSON，取消不落盘，重启恢复，跨 Session 复用。偏好文件可用 `ORCA_STATUS_PROTOTYPE_CONFIG` 隔离；不进入业务 checkpoint。

状态栏设置使用 `↑↓` 选择、空格勾选、`←→` 排序或切换格式，`Enter` 直接保存，`Esc` 取消；默认恢复是列表末项，空格重设、Enter 保存。设置列表、预览和主界面按字段类别使用同一套终端色，分隔符使用次要颜色，无颜色时仍保留全部标签和含义。

`Ctrl+T` 对比方案，`Ctrl+Y` 换场景，`Ctrl+W` 显示/清除通知，`Ctrl+E` 比较推理未设置及来源不可用；普通字符进入输入框。风险最多两行，跨会话待答及另一执行持有者保留。`Ctrl+B` 使用原项目面板，`Ctrl+P/Ctrl+S` 进入原弹窗，Esc 逐层返回并保留草稿/滚动。切换模型后旧上下文读数显示不可用。最新样例、独立源码副本、验证入口及 fixture/合同缺口见 [直存与配色交接资产](../../artifacts/statusline-prototype/custom-direct/README.md) 与 [状态行原型说明](../../artifacts/statusline-prototype/README.md)；旧截图与弹窗定稿归档保留。Token 累计、费用和 Provider 额度没有可信合同，本轮不开放。

项目面板原型运行 `pnpm ui:project-prototype planning tabs`，五种场景为 `planning`、`execution`、`blocked`、`answer`、`idle`。用户已选定 `tabs`（栏目切换），`sections` 和 `menu` 留作比较资产。默认界面保留原 adaptive 图侧栏；`Ctrl+B` 开合项目面板并保留原栏目。120 列时项目面板使用原 sidebar 区域，对话与 composer 保持原位；80/50 列时仅在主区域显示项目面板。面板外框在同一终端尺寸下保持位置、宽度和高度，栏目、列表、详情与审阅内容在内部切换或滚动。项目面板只承载待答、预算/授权、完整身份、工作依据和事件；图与进度/即时状态保留在默认 sidebar，`Ctrl+G` 打开独立图检查。`Ctrl+T` 切比较方案、`Ctrl+Y` 切场景；`Tab` 切总览/待答/事件，方向键选择、Enter 下钻、Esc 逐层返回。待答列表显式跳到所属会话回答，`Ctrl+R` 返回原列表和会话；`Ctrl+N` 模拟新消息、`Ctrl+U` 模拟图/问题不可读。标题用青色分组，操作用箭头/选中底色，说明用次要文字，详情区分字段与值；无色时仍有分组、箭头和当前栏目方括号。复现检查、截图及示例字段说明见 `artifacts/project-panel-prototype/README.md`。原型使用固定假数据。

临时弹窗原型运行 `pnpm ui:dialog-prototype planning`，仍使用项目面板的五场景、栏目导航、草稿、continuous transcript 与 adaptive 图。`Ctrl+S` 打开带分隔线的会话身份摘要；`Ctrl+P` 打开左名称、右说明的紧凑命令目录。Model Picker 按 Planning / Execution 列出角色的当前配置，Enter 打开该角色模型菜单：候选行只显示 provider/model，下方横向 effort 选择器只提供该模型支持的选项。Tab 切列表/effort/按钮，↑↓ 选模型，←→ 改 effort 或按钮，Enter 前进或执行，Esc 丢弃菜单草稿。授权、交接、Cancel 使用分栏字段审阅；Tab 切栏目，↑↓ 浏览，←→ 选择返回/确认，Enter 执行。动作按钮的当前选项用反色色块表示。项目总览的“查看候选授权”打开同一审阅弹窗。`Ctrl+N` 模拟新消息，`Ctrl+U` 模拟不可读，弹窗关闭后 `Ctrl+Y` 换场景；`Ctrl+C` 打开退出确认。所有业务意图只经内存假端口演示，角色配置与 effort 仅在原型展示态保存；截图、复现检查与生产合同缺口见 `artifacts/dialog-prototype/README.md`。

该弹窗原型已由用户确认定稿。[最终设计、源码归档和三档 Nerd Fonts/ASCII 样例](../../artifacts/dialog-prototype/final/README.md) 是实施规划的直接输入；不要将早期比较图当作定稿重新探索。源码归档单独保留当前工作台、假数据、依赖锁文件与合同文档。

6A 生产命令验收使用 `node artifacts/command-reviews/capture.mjs`（先 build），三档彩色/NO_COLOR × Nerd/ASCII，独立搜索、语义审阅、默认返回、键位拦截与连续 resize 的证据见 [command-reviews](../../artifacts/command-reviews/README.md)。采集挂载生产 App，Controller/model/backend 为隔离 fixture；真实宿主接线由 bootstrap 测试验证。

6B 模型配置使用 `/model` 或 Palette 的 Model Picker：当前 Coordinator、Planning 与 Execution 按角色分区，模型候选和水平 effort 独立选择，Tab 切区域，默认返回。未实现的 Planning Utility 与 Specification Validator 显示不可用原因。从角色页按 `e` 或通过“模型连接设置”命令编辑 provider、模型、选项与 key；编辑器中的 key 始终遮罩，不进入聊天草稿。Enter 保存新引用，保存结果明确标注尚未应用；随后显式应用 Coordinator 时走原模型切换，应用 Worker 时打开完整授权审阅，只有明确批准才改变新任务的配置。原任务的重试与恢复保留物化时的模型绑定。

运行 `pnpm build` 后，用 `node artifacts/model-configuration/capture.mjs release` 采集生产 App 的三档彩色/NO_COLOR、Nerd/ASCII 与连续 resize。该预览仍用隔离 fixture，不能证明模型实际启动。`node artifacts/model-configuration/real-launch.mjs` 单独在临时项目通过公开 Orca terminal 启动真实 Codex，读取精确 SessionStart/transcript 并保存非秘密启动证据；需要本机 `.env.smoke` 的显式模型和凭据，结果见 [模型配置证据](../../artifacts/model-configuration/README.md)。

## 检查组件

第七批 `complete-tui-project-statusline` 已随 `41b2f1e` 归档。其隔离预览、采集命令与证据见[归档证据说明](../../artifacts/project-statusline/README.md)；fixture 不证明真实 provider、tracker 或 Orca 能力，历史原型资产保留。

第七批历史采集命令为 `node artifacts/project-statusline/capture.mjs` 与 `node artifacts/project-statusline/capture-supplement.mjs`，性能命令为 `node artifacts/project-statusline/benchmark.mjs`；结果与逐票核对见[历史证据说明](../../artifacts/project-statusline/README.md)。第八批 `complete-tui-graph-basis` 仍在实施，其历史图与依据验收状态以当前 change 工件为准。

两个终端分别运行：

```sh
pnpm ui:devtools
DEV=true pnpm ui:preview execution
```

React DevTools 可检查组件树并临时调整 props；试出的值需再写回源码。`DEV=true` 只用于开发，不会让预览接入真实业务端口。

## 采集真实终端画面

第四批历史检查可用 `ORCA_COMPANION_HISTORY_INSPECTION=1 pnpm ui:preview alignment`。它使用隔离 SQLite 与生产 App，提供跨页查询活动、1MiB 参数、拒绝及 unknown 样例；全部调用是明确的预览数据。F3/F4、Ctrl+T/Ctrl+R 和召回的证据脚本为 `node artifacts/history-inspection/capture.mjs`，性能脚本为同目录 `benchmark.mjs`。运行前执行 `pnpm build`；预览不会连接真实模型或 Orca。

```sh
pnpm build
pnpm exec tuistory -s companion-ui --cols 120 --rows 40 -- node scripts/tui-preview.mjs long-cjk
pnpm exec tuistory -s companion-ui snapshot --trim
pnpm exec tuistory -s companion-ui screenshot
pnpm exec tuistory -s companion-ui resize 80 24
pnpm exec tuistory -s companion-ui snapshot --trim
pnpm exec tuistory -s companion-ui screenshot
pnpm exec tuistory -s companion-ui resize 50 40
pnpm exec tuistory -s companion-ui snapshot --trim
pnpm exec tuistory -s companion-ui screenshot
pnpm exec tuistory -s companion-ui close
```

画面中检查中文和长路径的裁切、Sidebar 折叠、焦点、选中项及警告文字。PNG 用于人工比较；字体和颜色取决于采集环境。`tests/tui/pty.test.ts` 使用同一个预览入口验收真实 resize 与终端恢复。
tuistory 连续 resize 后的截图可能带入旧尺寸的缓冲帧；需要干净的对比图时，关闭会话并按目标尺寸重新启动。旧帧是否残留在真实终端画面，以 PTY 用例的当前 pane 检查为准。
