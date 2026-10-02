# 终端依赖图与状态动效的可行表达

对应 ticket：[*调研终端依赖图与状态动效的可行表达*](https://github.com/leike0813/orca-companion/issues/39)（父地图 [#37](https://github.com/leike0813/orca-companion/issues/37)）。

结论先行：侧栏的绑定约束是**列宽**，不是行高。按本项目现有阈值，120x40 走 full（40 列）、80x24 走 compact（24 列）、50x40 直接 collapsed，因此「有依赖的工作图」在侧栏里只能退化成**缩进树 + 短 key + 行尾告警**，完整的跨依赖 DAG 交给全屏 Graph Inspector，或者导出成 DOT/Mermaid 在终端外看（Turbo、Graphviz 的做法）。状态动效有两条现成路径：Ink 7 内置 `useAnimation`（内部单一共享计时器，多个动效合并为一次 render），以及已安装的 `@inkjs/ui@2.0.0`（Spinner/ProgressBar 各自持有 `setInterval`）；两者混用会同时跑多个计时器。liveness 与生命周期必须保持两个独立字段，`unverifiable` 不得画成 `exited`，且任何状态编码都要符号加文字，不能只靠颜色。

## 1. 目标尺寸与实际可用空间

侧栏宽度是常量，不是响应式计算：`SIDEBAR_FULL_WIDTH = 40`、`SIDEBAR_COMPACT_WIDTH = 24`、`SIDEBAR_MIN_TERMINAL_WIDTH = 60`，full 的触发线是 60 + 40 = 100（`src/interfaces/tui/render/width.ts`）。侧栏外框是 `width + 2`、只保留左边框（`src/interfaces/tui/components/sidebar.tsx`）；主视图宽度为 `max(20, terminalWidth - sidebarWidth - 2)`（`src/interfaces/tui/screens/workspace.tsx` 的 `bodyWidth`）。

| 目标尺寸 | 侧栏密度 | 侧栏列数（含左框） | 主视图列数 | 行数 | 含义 |
| --- | --- | --- | --- | --- | --- |
| 120x40 | full | 42 | 78 | 40 | 宽度最高档；侧栏每个事实可以独占一行 |
| 80x24 | compact | 26 | 54 | 24 | 24 列放不下依赖标注；行数也紧，compact 图只列 6 行 |
| 50x40 | collapsed | 0（改为一行提示） | 48 | 40 | 行数充足，宽度不足；不给侧栏留列 |

`compactGraphRow` 的格式是：缩进 + `- ` + `shortKey` + 空格 + `state` + 告警 + 可选 ` <- deps`。depth 0 时 `- wp-1 implementing` 已占 19 列，再加一条 ` <- wp-2` 就是 27 列，超过 compact 的 24 列；也就是说**在 compact 下依赖标注基本必然被省略号吃掉**。full 的 40 列里，依赖和细节是拆成独立行的（`detailLines`），每条事实一行就是为此设计的。

行数不是主要矛盾，但要注意 compact 里 `compactGraphLines` 只取前 6 行、workers 取 5 行、blockers 取 4 行——这些上限是防止窄列下的垂直抢占，不是内容容量。

## 2. 依赖图在窄列下的成熟做法

**`git log --graph`** 是终端里最成熟的提交 DAG 画法：在输出左侧用 `*`、`|`、`/`、反斜杠、`_` 画分叉与合并，并在需要时插入额外行（`git help log` 的 `--graph` 段明确说明「可能插入额外行以便正确绘制」，且隐含 topo-order；见来源）。

**Turborepo** 把图交给终端外：`turbo run build --graph` 默认输出 DOT 到 stdout，也可写 `.svg` / `.html` / `.mermaid` / `.dot`；`.png`/`.jpg`/`.pdf`/`.json` 已弃用并需要本机 Graphviz（`turbo run` 参考文档的 `--graph <file name>`）。它不在 live 输出里画 DAG。

**Dagger** 把同一个流水线按能力分级渲染：`--progress` 取值 `auto | plain | tty | dots | logs | report`，完整 TUI 只在 `tty` 生效（Dagger CLI 参考）。这是「受限环境降级」的通用范式：图形视图、点状、纯日志三档。

**本项目现状**：`src/interfaces/tui/render/graph-layout.ts` 已经把上面两条缝成一条可维护的规则——

- 位置只由**编译后的稳定拓扑**决定（`position` = 编译顺序索引），状态变化不重排；
- `depth` 只用于缩进（每层 2 列），不参与排序；成环或前驱缺失时停在已求得深度，节点不消失；
- 过滤只写 `hidden`，被隐藏的节点保留原位置，因此隐藏中间节点不会让后面节点跳动；
- 细节（role/attempt/liveness/worktree/validation/reconciliation）在 full 密度下一事实一行，紧凑态用 `shortKey`（`workPackageShortKey`，超 8 字符取 `…` 加末 7 位）。

结论：**侧栏保持「稳定树 + 告警后缀」，跨依赖导航和完整拓扑交给 Graph Inspector**（`graph-inspector.tsx` 已有 `upstreamOf` 沿依赖读取，且过窄时不给 overlay、只提示扩宽）。若确实需要「看到全图」，正确做法是导出 Mermaid/DOT 或复用 Turbo/Graphviz 的路线，而不是把 `git log --graph` 式的多行连接符塞进 24 列——连接符在 2 列缩进级别的树旁会与文本争夺列宽，且要求行间严格对齐，窄列下反而更难读。

## 3. 进度、阻塞与注意力的优先级

本项目已经把优先级写进了 `src/interfaces/tui/components/status-line.tsx`：

- 一次性提示（拒绝原因、unknown 提示）排在最前，因为它会被按宽度裁切；
- 持久状态与执行摘要是**两行**：挤一行时后面的片段会先被执行摘要挤出屏幕，而危险态和 unknown 提示恰恰最需要可见；
- 有 blocker 时状态行用 error 色，有 notice 时用 warning 色；执行摘要在 reconciling 时用 warning 色。

执行图侧的信号：`src/interfaces/tui/state.ts` 的过滤预设把 `attention` 定义为 `blocked` 与 `unknown` 两个状态；`compactGraphRow` 对 `blockerRefs.length > 0` 或 `liveness === "unverifiable"` 追加 ` !`。也就是说「需要注意力」是**过滤维度 + 行内后缀**，不是单独的看板。

现成组件（已安装 `@inkjs/ui@2.0.0`，源码在 `node_modules/@inkjs/ui/build/components/`）：`StatusMessage`（图标 + 文案，`variant` 决定图标）、`Alert`（`variant` 加可选 `title`）、`Badge`（把字符串转大写并加两侧空格）。它们适合做「状态标签」，不是布局容器。GitHub CLI 的 checks 状态机可作语义参考：`pass | fail | pending | skipping | cancel`（`cli/cli` 的 `pkg/cmd/pr/checks` 的 `--json` 字段说明），其中 `cancel`/`skipping` 与失败的区分值得借用，避免把「未完成」和「失败」混为一谈。

一条硬约束（`theme.ts` 注释与 AGENTS.md 一致）：**所有状态同时保留文字或符号标记**，颜色只是辅助。

## 4. 状态动效：可稳定实现的部分

**Ink 7 内置 `useAnimation`**（`src/hooks/use-animation.ts`，readme 的 useAnimation 一节）：返回 `frame`（每个 interval 加 1）、`time`、`delta`、`reset`；`interval` 默认 100ms，`isActive=false` 停止并在重新激活时全部归零。文档明确「所有动画共用内部单一计时器，因此多个动效组件合并为一次 render cycle」。这是做 spinner 的首选。

**`@inkjs/ui` 的 `Spinner`**：`useSpinner` 直接从 `cli-spinners` 取帧表，每个组件自己 `setInterval(spinner.interval)`（`node_modules/@inkjs/ui/build/components/spinner/use-spinner.js`）。它不与 Ink 的共享计时器合并，多个 Spinner 就是多个 timer。`@inkjs/ui@2.0.0` 的 engines 是 `>=18`，未针对 Ink 7 发布。

**帧表**：`cli-spinners` 的 `dots` 为 `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`；charmbracelet `bubbles/spinner` 的 Dot 用同一组、Line 用 `| / - 反斜杠`，并各自声明 FPS（`bubbles/spinner/spinner.go`）。ASCII 兜底对 `TERM=dumb` 或字体缺失更安全。

**同步输出**：Ink 在 TTY 且 interactive 时用私有模式 2026 包住每次写入（`\u001B[?2026h` 到 `\u001B[?2026l`，`node_modules/ink/build/write-synchronized.js`）；这是消除高频重绘撕裂的终端侧机制，规范见 contour 的 `vt-extensions/synchronized-output.md`。非交互时 Ink 会跳过 ANSI 擦除、光标控制与同步输出。

设计约束（M2 规则 + 现有状态机）：动效只用于 spinner、短暂状态高亮、一次 attention；`state.ts` 里 `attention` 已是一次性布尔并由 `attention-cleared` 清零。可用的门控方式是给 `useAnimation` 传 `isActive`：只在当前 Execution Frontier 有 `live` 工作时转。当前 TUI 还没有任何 spinner（`src/interfaces/tui` 内无 `useAnimation`/`Spinner` 使用），`select` 组件的 `isActive` 是焦点标记，与动效无关。

## 5. liveness 与 unknown 的视觉保持

`WorkPackageNodeView` 把 `state`（生命周期）与 `liveness`（`live | exited | unverifiable | null`）定义为两个字段（`src/application/tui/view-model.ts`），`execution-view.ts` 明确「不可核验的 Worker 不得被读成已退出」。侧栏的 `livenessLabel` 分别为 `liveness 未知`（null）、`live`、`exited`、`unverifiable(待核验)`，是四个不同的可见取值。

因此任何动效或图标方案都必须满足：`unverifiable` 与 `exited` 用**不同的符号和文案**；`null`（尚未观察）不能说成已经退出；不能用一个旋转图标同时表示「在跑」和「状态未知」。这条与「状态不能只靠颜色」叠加后，实际可用的编码维度只剩符号形状、文字、是否动，颜色是第四位。

## 6. 重绘与性能边界

- `@inkjs/ui` 的 `ProgressBar` 用 `measureElement(ref)` 量宽，并在**渲染函数体里** `setWidth` 触发立即重渲染（`progress-bar.js`）。这类「渲染中改状态」在窄列加高频 resize 下需要警惕，M2 的「高频更新 DOM 必须专查性能」规则同样适用于 Ink 的 `measureElement` 路径。侧栏进度若做成进度条，建议直接用已知的 `width` 常量而不测量。
- Ink 的 `<Text wrap="truncate">` 可在容器宽度不足时截断，`hard` 会按列宽填满；本项目已有 Unicode 宽度工具（`render/width.ts` 的 `displayWidth`/`truncateToDisplayWidth`/`padToDisplayWidth`），覆盖 ASCII、CJK、韩文、零宽，依据是 Unicode East Asian Width（UAX #11）。复杂 emoji/ZWJ 按单码点算，是已知边界。
- Ink readme 明说：终端变窄时可能出现 ghost lines，取决于模拟器的 reflow——50 列这种窄宽 resize 要多看画面，不能只看 frame 文本。
- 只增不删的日志类内容应放 Ink 内置的 `<Static>`，避免每帧重排。

## 7. 侧栏候选手法（供原型取舍）

- full（40 列）：保持现有「稳定树 + 一事实一行」；依赖用独立行，不要把依赖塞进标题行。
- compact（24 列）：只显示缩进 + `shortKey` + `state`，依赖前缀在放不下时省略；告警用 `!` 后缀加 error 色，并在旁保留 `blocked`/`unverifiable` 文字。
- collapsed（小于 60 列）：只留一行计数或提示（现有 `SIDEBAR_COLLAPSED_MARKER`）；依赖关系整体交给 Graph Inspector 或导出。
- 动效：单个 `useAnimation` 驱动的 spinner 只挂在当前 `live` 节点；`attention` 只做一次性高亮，不常驻闪烁。
- 注意力排序：notice、blocker、reconciling、active，沿用 status-line 的两行拆分。

## 8. 未核验与不确定

- 本次没有真实渲染 120x40 / 80x24 / 50x40（未运行 `pnpm ui:preview` 或 `tuistory`）；密度映射由 `width.ts` 阈值推出，Yoga 换行与 ghost line 的实际画面需 PTY 截图确认（`docs/dev/tui-workbench.md` 已给出采集命令）。
- Dagger、Turborepo、charmbracelet 的结论来自各自官方文档或源码，未在本机运行。
- `@inkjs/ui@2.0.0` 未针对 Ink 7 发布，`useSpinner` 不共享 Ink 计时器这一差异来自本地源码，未做帧率实测。
- 复杂 emoji、ZWJ 序列与 Windows 终端的宽度/reflow 仍未验证（与 `ink-react-terminal-constraints.md` 的边界一致）。

## 来源

- Ink v7.1.1 源码与文档：<https://github.com/vadimdemedes/ink/tree/v7.1.1>
  - `src/hooks/use-animation.ts`（`useAnimation` 的 frame/time/delta/reset、interval 默认 100、共享计时器）
  - `src/write-synchronized.ts`（`\u001B[?2026h` / `\u001B[?2026l`、TTY + interactive 判定）
  - `readme.md`（`useAnimation`、`<Static>`、`<Spacer>`、`useWindowSize` 的 ghost line 提示、`<Text wrap>`、Useful Components）
- 已安装依赖的本地源码：`node_modules/@inkjs/ui/build/components/{spinner,progress-bar,badge,status-message,unordered-list,ordered-list,alert}/`、`node_modules/ink/build/write-synchronized.js`
- 本项目：`src/interfaces/tui/render/graph-layout.ts`、`render/width.ts`、`components/sidebar.tsx`、`components/graph-inspector.tsx`、`components/status-line.tsx`、`screens/workspace.tsx`、`state.ts`、`theme.ts`、`src/application/tui/view-model.ts`、`src/application/execution/execution-view.ts`、`src/domain/planning/budget-policy.ts`（`maxActiveWorkPackages: 8`、`concurrencyLimit: 1`）、`docs/dev/tui-workbench.md`
- git `--graph`：`git help log`（本机）与 <https://git-scm.com/docs/git-log>
- Turborepo `--graph`：<https://turborepo.dev/docs/reference/run>
- Dagger `--progress`：<https://docs.dagger.io/reference/cli/>
- charmbracelet `bubbles` spinner 帧表：<https://github.com/charmbracelet/bubbles/blob/master/spinner/spinner.go>
- GitHub CLI checks 状态枚举：<https://github.com/cli/cli/blob/trunk/pkg/cmd/pr/checks/checks.go>
- 同步输出模式 2026 规范：<https://github.com/contour-terminal/vt-extensions/blob/master/synchronized-output.md>
- Unicode East Asian Width（UAX #11）：<https://www.unicode.org/reports/tr11/>
