# Implementation Plan

## 1. 实施基线与权威来源

- 模式：`predecessor-contract`；规划 HEAD：`967bf51970b4b2f122ab9a4ea99e445810ec55ec`。
- 直接前驱：`openspec/changes/archive/2026-09-29-m2-closeout-integration-and-wake/`。实施前核对其归档状态、`openspec/specs/tui/planning-workspace/spec.md`、`src/interfaces/tui/app.tsx` 和 `tests/tui/pty.test.ts`；接缝漂移时先更新本计划。
- 权威：ControllerSnapshot、TuiApp 端口和 IC-11/IC-12 仍定义生产行为；预览只有固定假数据。`docs/architecture.md` MOD-06 定义 UI 依赖边界。

## 2. 复用与接缝

| IP-ID | 现有文件与符号 | 复用方式 | 禁止复制的事实 |
|---|---|---|---|
| IP-01 | `TuiApp`、`projectTuiViewModel`、现有 PTY fixture | 复用完整界面和投影，将 PTY fixture 移成独立预览入口 | 不复制 Controller 或业务状态机 |
| IP-02 | `Workspace`、`ModelPicker`、`SessionPicker`、`ControlBar`、`TuiApp.useInput` | 仅迁移两个选择器和危险确认，根输入保留全局键与 Esc | 不复制模型准入或 Scope 控制规则 |
| IP-03 | 现有 TUI 状态、焦点与行为测试 | 单一主题提供色彩，测试可观察交互 | 不以颜色代替状态语义 |

## 3. 代码变更映射

| IP-ID | Task | Requirement/Scenario | 文件与符号 | 精确变化 | 不得改变 |
|---|---|---|---|---|---|
| IP-01 | 预览与采集 | 隔离且可复现的 TUI 预览／执行态、误触写操作；终端画面和组件可检查／缩窄后采集、检查组件属性 | `scripts/tui-preview.mjs`、`tests/tui/pty.test.ts`、`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`docs/dev/tui-workbench.md` | 提取假端口；固定五个场景；允许 DevTools 所需 Electron 安装；提供预览、DevTools、tuistory 用法和 120×40、80×24、50×40 采集流程 | 真实入口和 Controller 写路径 |
| IP-02 | 控件迁移 | 状态与焦点的可辨识视觉层级／彩色终端切换选择、无彩色危险状态 | `src/interfaces/tui/{app.tsx,screens/workspace.tsx,components/model-picker.tsx,components/session-picker.tsx,components/control-bar.tsx,components/selection-list.tsx}`、`tests/tui/{input-paths,control,session-picker,session-lifecycle,no-side-effect,execution-graph,execution-handoff,host-wiring,interaction-card,workspace}.test.tsx` | Select 接管两个 Picker 的移动与新选择；共用输入观察补齐再次确认当前项和拒绝后重试；ConfirmInput 接管 y/n；根输入避免重复提交；更新直接构造组件与焦点标记的测试属性 | composer、palette、Graph Inspector、回答绑定、Scope 级语义 |
| IP-03 | 主题与展示 | 状态与焦点的可辨识视觉层级／两个 Scenario；终端画面和组件可检查／组件属性 | `src/interfaces/tui/theme.ts`、`src/interfaces/tui/{app.tsx,components/top-bar.tsx,components/status-line.tsx,components/sidebar.tsx,components/interaction-card.tsx}`、`docs/architecture.md` | 一处定义语义色和组件库主题，展示层保留文字/符号状态 | IC-11/IC-12 数据结构与业务状态 |
| IP-04 | 验证与使用说明 | 上述全部 | `README.md`、本 change 的 `tasks.md` | 文档、脚本、已有行为与 PTY 验证 | 不声称浏览器或 Windows 已验收 |

## 4. 调用与副作用顺序

1. 预览：校验场景和双 TTY → 加载已构建 TuiApp → 注入固定快照与假端口 → 用户输入仅改变本地展示态；写端口统一返回 `preview_read_only`。构建缺失、非法场景与无 TTY 均非零退出。
2. 选择：根输入识别全局键/Esc；激活 Select 时跳过方向键和 Enter；Select 只调用现有 `switchModel`/`selectSession` 回调一次，宿主继续核验模型准入。
3. 确认：根输入保留 Esc；ConfirmInput 接收显式 y/n，关闭待确认态后调用原有控制意图；Enter 不提交危险操作。
4. 采集：tuistory 管理独立预览 PTY 的尺寸、快照与 PNG，不经业务端口写入。

## 5. Schema、状态与持久化落实

无公共 DTO、持久化 schema 或配置迁移。预览场景是开发脚本内部固定数据；模型列表、Session 列表、图和 transcript 仅作为展示输入。生产 TUI 的状态来源和 Controller/CLI 合同保持不变。

## 6. 验收证据矩阵

| Requirement/Scenario | IP-ID | 证据 | 关键断言 | 命令 |
|---|---|---|---|---|
| 预览／执行态、误触写操作 | IP-01 | `tests/tui/pty.test.ts`、开发文档 | 执行图可见；误触返回拒绝；不加载真实后端 | `pnpm exec vitest run tests/tui/pty.test.ts` |
| 采集／缩窄终端、组件属性 | IP-01/03 | tuistory 与 DevTools 人工流程 | 宽窄布局可见，属性改动不触发业务动作 | `pnpm ui:preview execution`; `pnpm exec tuistory --help` |
| 状态与焦点／彩色选择、无彩色危险确认 | IP-02/03 | 现有 TUI 输入、控制、Session、零副作用测试及 PTY | 一次选择/确认；Enter 不确认；文字标记仍在 | `pnpm exec vitest run tests/tui/input-paths.test.tsx tests/tui/control.test.tsx tests/tui/session-picker.test.tsx tests/tui/session-lifecycle.test.tsx tests/tui/no-side-effect.test.tsx tests/tui/pty.test.ts` |
| 全部门禁 | IP-04 | 本 change `tasks.md` | 类型、lint、构建、相关测试、规格有效 | `pnpm typecheck && pnpm lint && pnpm build && openspec validate tui-debug-workbench-and-ui-migration --strict && git diff --check` |

## 7. 文件清单与升级条件

仅修改 §3 所列文件和本 change 工件。若 Select 无法保留批量输入语义、ConfirmInput 会双重提交，或预览必须加载生产 bootstrap，回到 design/specs 决定替代实现。

## 8. 验收 Agent 授权与限定审计

验收范围限定为 TUI 展示、输入归属、预览隔离、DevTools/PTY 工作流和文档；重点核对真实写端口不可从预览触达、危险操作须显式确认、渲染/resize 不引起副作用。生产 Orca 集成与 Windows 不在本变更验收范围。
