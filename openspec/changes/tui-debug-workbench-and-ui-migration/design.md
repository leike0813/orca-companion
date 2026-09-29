## Context

现有 `TuiApp` 集中处理按键，`Workspace` 只接展示 DTO 与回调；M2 已有组件测试、真实 tmux PTY 验收和一份内嵌于 PTY 测试的假端口 fixture。公共边界仍以 IC-11、IC-12 为准。本 change 不更改领域事实或写路径。

## Goals / Non-Goals

**Goals:** 隔离且可复现的完整界面预览；组件属性检查与真实终端截图；统一高对比视觉层级；在保持已验收语义的前提下迁移适合的交互组件。

**Non-Goals:** 改造 Controller/CLI DTO、迁移数据库、替换 Ink、多行 composer 或 Command Palette 的专用输入逻辑；引入浏览器预览、拖拽设计器、开发服务器或无人值守运行。

## Decisions

### D1 — 固定依赖，限制运行时影响

运行依赖仅增加 `@inkjs/ui@2.0.0`；`react-devtools@7.0.1`、`react-devtools-core@7.0.1` 与 `tuistory@0.11.0` 是开发依赖。DevTools 仅在显式 `DEV=true` 时连接。已在工作区外用项目的 Ink 7.1.1 / React 19.3.0 组合验证 Select、ConfirmInput 和 Badge 的基本渲染与按键；完整交互仍由项目测试验证。浏览器预览会引入另一套渲染环境，本轮不采用。

### D2 — 一处主题事实源

`src/interfaces/tui/theme.ts` 拥有语义色与 `@inkjs/ui` 主题。采用终端标准色：青色强调、品红焦点、绿色成功、黄色警告、红色错误、灰色次要信息、蓝色边框；标签、图标和确认文字始终存在。`TuiApp` 根节点提供主题，展示组件只读这些值，不从颜色推断业务状态。无彩色环境下保留文本和符号。视觉计算仍在 TUI 模块，不进入 IC-11/IC-12。

### D3 — 有界迁移输入所有权

Model Picker 和 Session Picker 交给组件库 Select 处理方向键与新选择；Select 对已选值不再触发 `onChange`，两个 Picker 共用一层输入观察补齐再次确认当前项与拒绝后重试。危险态 Cancel/Exit 使用 ConfirmInput，`submitOnEnter=false`。`TuiApp` 保留全局键、Esc、Home、Command Palette、Graph Inspector 与多行 composer 路由，并在库控件激活时跳过同一普通按键，避免双重提交。确认回调先清空待确认态，再调用既有意图。Model Picker 的宿主准入仍是唯一可提交判据；Session Picker 只改变展示态。保留 Command Palette 的同步光标以维持成批输入的既有行为。

### D4 — 独立假端口预览

`scripts/tui-preview.mjs` 只导入构建后的 `TuiApp`，在启动前检查双 TTY；场景参数为 `planning`、`execution`、`blocked`、`empty`、`long-cjk`，非法值非零退出。它提供静态快照、transcript 与 Model Catalog，所有写端口返回结构化 `preview_read_only` 拒绝，绝不加载 bootstrap、Orca 或持久化 adapter。现有 PTY 测试改用同一 fixture。tuistory 只包裹此预览进程做 resize、snapshot、screenshot；截图为临时开发产物。失败关闭：构建缺失、无 TTY 或未知场景均明确失败，不退回真实应用。

### D5 — 只验证稳定行为

扩展既有选择、确认、零副作用与 PTY 测试；断言操作次数、状态语义、可见焦点及几何边界，不精确锁定完整文案、ANSI 序列或 PNG 像素。开发文档说明人工 DevTools/截图检查步骤；`docs/architecture.md` 更新 TUI 依赖说明。无需迁移或部署步骤，生产 CLI 接口保持不变。

## Risks / Trade-offs

组件库 Select 和 ConfirmInput 自行监听键盘，若父容器遗漏停用对应按键，会重复执行；现有输入路径测试需覆盖这一边界。上游组件库的开发基线较旧，虽通过独立探针，仍须通过项目 typecheck、组件及真实 PTY 回归。tuistory 的截图颜色与字体取决于终端渲染环境，故 PNG 用于人工观察，不作像素门禁。

## Migration Plan

先新增主题与假数据预览，再迁移两个 Picker 和确认控件，最后更新展示样式与文档。依赖安装和 lockfile 固定在同一 change；不创建持久化记录或配置迁移。
