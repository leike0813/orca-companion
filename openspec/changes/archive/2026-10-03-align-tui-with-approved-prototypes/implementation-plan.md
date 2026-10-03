# Implementation Plan

## 1. 实施基线与权威来源

baseline: `predecessor-contract`。直接前驱 `complete-tui-editor` 位于 `openspec/changes/archive/2026-10-02-complete-tui-editor/`，任务 7/7、功能 verification PASS，已同步主规格。实施 HEAD：`d3066e2bf805db3efdc6db1cf9b4d1a8af81c205`。本轮重稿时其上已有旧范围未提交实现，保留并复用，不能覆盖或把该 HEAD 当作包含它们。

体验来源的唯一登记入口是 [design.md D-01](design.md#d-01六张原型票直接作为设计参照)，包含 P-40/43/47/48/51/52 的最终决议、源码与画面；相关语义由 #41/42/44/45/50 约束。冻结/缺口分别见 D-05/D-10。旧范围的 54 组证据和测试结果是阶段记录，新任务全部按扩展范围重新核验。

apply 前运行 `git rev-parse HEAD`、`git status --short`、`openspec list --json`，读取前驱 tasks/verification 和主规格 planning-workspace、input-protection、session-interactions、coordinator/user-questions；核对实际 UiDraft、editComposer/composerViewport、输入保护、问题/回答和提交调用者。若前驱、owner/revision/submissionId 或保护接缝漂移，先更新设计，不能静默绕过。

## 2. 复用与冻结接缝

| IP-ID | 复用的实现 | 实施边界 |
| --- | --- | --- |
| IP-01 | Transcript、entryId 工具展开、当前 continuous 改动 | 新工作区几何中保留真实内容，无 fixture thought/成功 |
| IP-02 | Composer、composerContentWidth、composerViewport、handleComposerKey、现有输入保护 | 一份全文/光标；候选和布局不复制编辑器 |
| IP-03 | AnswerPanel、InteractionCard、questions 和回答提交管线 | 当前 Session 精确绑定、独立草稿及 Esc 恢复 |
| IP-04 | Workspace、state/reducer、宽字符/高度预算、生产 preview、PTY/tuistory | 统一固定主区域和上下文返回，串行集成 |
| IP-05 | Sidebar、EventDrawer、snapshot 的 budget/interactions/身份/ref | 项目 tabs 与有界详情，事件只用现有 50 条窗口 |
| IP-06 | COMMAND_METADATA、parse/handler、SelectionList、Session/Model Picker、review、ControlBar | 同一操作定义与准入、候选采用分离、四类固定弹窗 |
| IP-07 | TopBar、StatusLine、ModelCatalog 与已载入 graph/scope | 常驻核心和独立风险，缺失数据不可用 |
| IP-08 | GraphView、graph-layout、Sidebar/GraphInspector、theme 图标 | 当前图稳定拓扑/选择/真实依赖，无历史查询或验收猜数 |
| IP-09 | 现有 TUI 测试、preview fixture 和原型资产 | 六票生产对照及交接，证据不覆盖定稿 |

IC-11 命令、IC-13 全文/CAS/提交快照、稳定 submissionId、单活跃提交、generation、accepted/rejected/unknown 与恢复均冻结。数据库/UI schema v2、Coordination schema 14、依赖与业务状态机不变。允许现有字段在 TUI 组件间传递，不修改 Controller DTO。

## 3. 代码变更映射

以下文件均相对于 `src/interfaces/tui/`；任务与场景按真实可观察合同关联，不要求逐条新增测试。

| IP-ID / D-ID / 参照 | Task | Requirement / Scenario | 文件与符号、具体改动 | 保护 |
| --- | --- | --- | --- | --- |
| IP-01 / D-02 / P-40 | 1.1、2.1 | continuous 两场景；主视图/工具折叠 | `components/transcript.tsx` Transcript：复用现有呈现并适配新的 maxLines；`screens/workspace.tsx` 预算 | 真实正文/detail/entryId、展开与读取边界 |
| IP-02,04 / D-03,05 / P-47 | 2.2 | 完整编辑、窄屏/禁用；候选采用分离 | `components/composer.tsx`、`render/width.ts`、`screens/workspace.tsx`、`app.tsx`：同源正文内宽，候选/框/回答占用及实际 cursor metrics | grapheme/粘贴全文/保存/提交语义 |
| IP-03 / D-04 / P-47,52 | 2.3 | 当前回答三场景 | `components/answer-panel.tsx`、`interaction-card.tsx`、`app.tsx`：保留前一阶段主题，在新容器核对选项/自由输入与返回 | owner/revision/submissionId、无抢焦点 |
| IP-04,05 / D-07 / P-51 | 3.1–3.2 | 固定框三场景；信息分层 | `state.ts`、`screens/workspace.tsx`、`app.tsx`；新增 `components/project-panel.tsx`：进程内页签/选择/详情/滚动/返回态，100 列布局分界；复用 `event-drawer.tsx` 的有界内容 | 不新增事件仓库、问题权威、持久导航或跨会话返回协议 |
| IP-06 / D-03,08 / P-47,52 | 4.1 | 命令候选两个场景；严格 slash | `components/command-palette.tsx` COMMAND_METADATA 与现有 parser、`app.tsx` handler、`state.ts`：补短说明/目标，可用性同源，project/events 指向页签，采用与执行状态分开，Help 同源 | Controller 准入与危险确认；错误输入不发出 |
| IP-06 / D-08 / P-52 | 4.2–4.3 | 弹窗两场景；选择/确认/逐层返回 | `components/selection-list.tsx`、`command-palette.tsx`、`session-picker.tsx`、`model-picker.tsx`、`authorization-review.tsx`、`handoff-review.tsx`、`control-bar.tsx`；Workspace Overlay：固定有界框、分区/分栏、反色动作、默认返回 | 原收件方、配置 ref、指纹/revision；缺失角色/effort 不可用 |
| IP-07 / D-09 / P-48 | 5.1 | 顶栏/statusline 两场景；授权连续性 | `components/top-bar.tsx`、`status-line.tsx`、Workspace/app：选中 Coordinator catalog，三核心+图，风险独立，完整 refs 转项目详情，按字段省略 | 不猜身份/context/effort/数值，不冒充 custom 保存 |
| IP-08 / D-09 / P-43 | 5.2–5.3 | adaptive 三场景；准确关系/零副作用；Frontier | `render/graph-layout.ts`、`components/sidebar.tsx`、`graph-inspector.tsx`、`theme.ts`、`state.ts`、app：共享 adaptive/节点卡，所选邻域有界、多关系显式选择、栏目切换；纯 UI 选项即时同步 Nerd/ASCII | position/WorkPackageId、事实分层、无图/业务写入 |
| IP-09 / D-01,06,10 | 6.1–6.3 | 原型证据两个场景及全部回归 | 现有测试、`scripts/tui-preview.mjs`；新 full-map 证据；AGENTS/IC-12/工作台/交接更新 | 原定稿/阶段证据只读，不能报告缺口为完成 |

## 4. 调用与失败顺序

用户导航键 → reducer 更新局部展示态 → Workspace 按实际尺寸计算固定区域 → 组件只渲染已载入数据。项目/弹窗关闭只恢复调用上下文，不自行切 Session、发送、保存业务状态或查询整库。需要读取既有问题/模型/review 时仍经原有窄端口，UI 不直接读 tracker/Git/store/provider。

编辑 → 原 IC-13 保存管线；候选采用也是显式编辑，由原管线保存 UiDraft，但候选的查询/高亮本身不保存。调用前按原定义重验可用性；普通发送/回答先存完整快照再调用用例，再按原 generation 结清。review 的明确确认仅传原目标/指纹/revision。错误命令、不可用、CAS 冲突、stale/unknown 保留原输入和绑定，不能换 ID 重试。

IME 确认/粘贴不能作为执行键；overlay 优先消费，键位不穿透。图多关系先显示候选再明确选择；没有关系不改节点。关系/版本失效仅提示事实变化，不自动选别的对象。候选/正文/图及详情都按高度预算有界，隐藏区不算不可见详情。

## 5. 状态、Schema 与权限

新增进程内展示态：项目开合/页签/选中 key/详情与滚动、调用位置、候选高亮及采用状态、图详情栏目/关系选择、iconMode。统一归 state/app，不进入 checkpoint 或 IC-13。草稿只由现有 UiDraft 拥有，返回上下文只存引用/位置，不存第二份正文。

现有 theme 图标集和字段色复用，不引入主题系统、路由框架、新依赖或通用配置。用户级 custom 格式/排序/持久保存与图标恢复不在本次实现，按 D-10 保持不可用标记及明确后续 owner。ControlBar/确认、Session 选择、模型切换仍经原 port 权限。CLI machine schema 和不加载 UI 的核心入口不变。

## 6. 验收证据矩阵

| IP-ID / 场景 | 现有检查与 fixture | 必须观察 | 可运行命令 |
| --- | --- | --- | --- |
| IP-01–03：continuous/编辑/当前回答 | 现有用户/工具、中文/emoji、>1000 code points 粘贴、问题查询及拒绝/unknown fixture | 正文与块载荷、cursor、精准提交、Esc 恢复、最小尺寸空间 | `pnpm exec vitest run tests/tui/workspace.test.tsx tests/tui/composer-editor.test.ts tests/tui/width.test.ts tests/tui/input-paths.test.tsx tests/tui/input-protection.test.tsx tests/tui/interaction-card.test.tsx` |
| IP-04,05：项目框/事件/返回 | workspace/event-drawer/session-lifecycle；隔离生产预览扩展三页签与长详情 | 120 列对话不动、80/50 列仅项目、resize 保持对象、同框滚动、无自动换 Session | `pnpm exec vitest run tests/tui/workspace.test.tsx tests/tui/event-drawer.test.tsx tests/tui/session-lifecycle.test.tsx tests/tui/pty.test.ts` |
| IP-06：候选/四类弹窗 | input-paths/session-picker/authorization-review/execution-handoff/control/exit | 采用无动作、错误不发出、不可用不可采用、默认返回、确认精准一次、Esc 上下文恢复 | `pnpm exec vitest run tests/tui/input-paths.test.tsx tests/tui/session-picker.test.tsx tests/tui/authorization-review.test.tsx tests/tui/execution-handoff.test.tsx tests/tui/control.test.tsx tests/tui/exit.test.tsx` |
| IP-07：常驻状态/缺口 | workspace/execution-workspace/unknown-state/recovery；catalog/current graph fixture | 核心不被 notice 覆盖，数据未知不零，完整 refs 可读 | `pnpm exec vitest run tests/tui/workspace.test.tsx tests/tui/execution-workspace.test.tsx tests/tui/unknown-state.test.tsx tests/tui/recovery.test.tsx` |
| IP-08：图/分支/图标 | graph-inspector/execution-graph/frontier；多依赖、未知 liveness、revision/filter | 选择稳定、真实多分支、窄屏可读、图标同步、无虚构进度/动画 | `pnpm exec vitest run tests/tui/graph-inspector.test.tsx tests/tui/execution-graph.test.tsx tests/tui/execution-frontier.test.tsx tests/tui/no-side-effect.test.tsx` |
| IP-09：六票视觉与整合 | 实际生产组件、三档独立启动、彩色/NO_COLOR、Nerd/ASCII，规划/执行/阻塞/待答/空闲 | D-01 逐票画面对照，固定框/配色/返回、全部缺口真实记录 | `pnpm build`；`pnpm exec vitest run tests/tui --maxWorkers=8`；下述 tuistory 入口 |
| 全范围 | 现有检查，不构建 Orca | 类型/lint/构建/工件通过，重绘与 remount 零副作用 | `pnpm typecheck`、`pnpm lint`、`pnpm build`、`openspec validate align-tui-with-approved-prototypes --strict`、`git diff --check` |

优先调整已有测试；对固定框、两步采用、多分支和窄屏返回等新稳定行为，在上述对应测试中补代表性用例。不新增只断言完整提示、空白或 snapshot 的测试。真实 Orca 两项集成只有显式隔离开关才运行，跳过不可记为通过；本次 UI fixture 不是 Provider/Orca 验证。

生产采集使用既有 tuistory，例如：

```sh
pnpm exec tuistory -s tui-align-full --cols 80 --rows 24 -- node scripts/tui-preview.mjs planning
pnpm exec tuistory -s tui-align-full snapshot --trim
pnpm exec tuistory -s tui-align-full screenshot -o /tmp/tui-align-full.png
pnpm exec tuistory -s tui-align-full close
```

分别启动 120×40、80×24、50×40，以 planning/execution/answer/disabled 和新增隔离长详情 fixture 覆盖场景；NO_COLOR 与 ASCII 用既有环境入口。按真实入口打开项目栏目、弹窗、slash 与 Inspector，留 PNG/同名文本和操作序列；再单独验证连续 resize。图片/文本保存到 `artifacts/tui-prototype-alignment/full-map/`，README 逐票列 P-ID、定稿路径、画面、环境/HEAD/工作区、通过项及 D-10 缺口。主 agent 亲自核对，不能只看菜单或局部截图。

## 7. 文件清单与升级条件

- 修改 MOD-06：第 3 节列出的 `app.tsx`、`state.ts`、`screens/workspace.tsx`、`theme.ts`、`render/width.ts`、`render/graph-layout.ts` 和对应现有 components；新增一个 `components/project-panel.tsx`，用于固定面板及详情。复用小型纯布局/节点卡确有重复时可合并到现有 graph-layout/selection-list，不预建框架。
- 修改现有 tests/tui 中证据矩阵列出的行为和 PTY 用例；前一阶段调整过的 input-record-manager、pty-execution、pty-handoff 保留并回归。preview 仅新增隔离事实场景/尺寸，不调用真实后端。
- 修改 `AGENTS.md` 第 9 节、`docs/interface-contracts.md` IC-12、`docs/dev/tui-workbench.md`、`docs/dev/tui-implementation-handoff.md`：同步 Ctrl+B、项目事件、窄屏图和进度；不改历史 verification。更新 change 工件并新增 full-map 证据。
- 只读：已确认 prototype 源码/final/custom-direct/source.tar.gz、旧 54 组证据、前驱归档、业务/application/workflow/adapters/bootstrap、依赖锁与 `references/orca`。

需要 D-10 的真实数据/配置能力、修改 IC-11/13、持久化或业务权限时回到对应合同设计，不以 UI 私读/假值代替。保留已有改动，不提交、切分支、自动归档或启动开发服务器。

## 8. 验收范围与阶段记录

验收覆盖六份 delta specs、D-01–10、IP-01–09；其中 Recovery/Finalizer 两份 delta 同步已批准的信息归属，事实、身份与业务合同保持。限定审计：六票来源、全工作区固定几何、候选采用、上下文返回、真实事实/未知、图依赖、输入保护/原生光标、零副作用及证据范围。允许在本 allowlist 内修复并复验，禁止越界补业务能力。

前一阶段（旧 IP-01–04）已实现 continuous、圆角输入与当前回答，54 组局部画面对照；TUI 27 文件/172 项通过，2 文件/2 项条件跳过，普通真实 PTY 12 项通过；typecheck/lint/build/strict/diff 通过。这些结果保留，不等同于重稿后的整套验收。扩展范围的实现与证据另记下节。

重稿阶段已完成；当前实现、行为验证、每票视觉状态、完整功能缺口、提交和归档分开登记于下节。apply 不创建 verification，正式验收时再固定实际对象和报告。Windows 仍未验证。

## 9. 本轮实现记录（2026-10-02）

实施对象为 `d3066e2` 上的当前未提交工作区，保留前一阶段输入/聊天/回答改动。本轮落实六票所有已有生产区域的呈现：固定项目 tabs 与详情、上方候选两步采用、四类 dialog、简短顶栏和单行状态栏、共享 adaptive 图与分区节点卡；入口、层级和逐层返回均按 D-01 定稿。缺失数据显示不可用，完整功能缺口仍由 D-10 统一登记。

跨组件复用命令定义、DialogFrame/字段布局、图布局与节点选择；没有新增依赖、业务 DTO、数据库迁移或状态机。IC-11/13、UiDraft/CAS、提交快照与稳定 submissionId、generation、防迟到与 accepted/rejected/unknown 合同保留。项目事件限既有 50 条窗口，新增事件不抢焦点；所选事件被移出窗口时明确失效，不冒选另一条。

行为验证：`pnpm exec vitest run tests/tui --maxWorkers=8` 为 27 文件/176 项通过，2 文件/2 项条件跳过；其中 13 项普通真实 tmux PTY 通过。包括中文/长粘贴、候选采用不执行、危险默认返回、准确多关系导航、项目/Inspector 连续 resize、原草稿与任意位置光标恢复、重绘无副作用。隔离真实 Orca execution/handoff 未启用开关，未计为通过。最后的顶栏字段预算与规划交接/Cancel/Exit 接线修复后重新运行全范围检查；危险确认统一复用原确认入口，动作栏与 y/n 均只提交一次。`pnpm typecheck`、`pnpm lint`、`pnpm build`、change/四份主规格严格 OpenSpec、`git diff --check` 通过，本地证据链接可解析。

实施任务 15/15 完成。主 agent 的六票实际画面对照、三档彩色/无色和 Nerd/ASCII、操作路径及原生光标记录见 [full-map README](../../../artifacts/tui-prototype-alignment/full-map/README.md)。2026-10-03 最终索引为 277 对有效 PNG/文本，文件齐全、显示宽度无越界；六组回答返回的实际 cursor 均可见且 x=14，连续 resize 返回保留首中尾。它使用实际生产组件及隔离 fixture，不证明真实 Provider/Orca 或本次真实 IME。新采集脚本仅写入 full-map。

旧阶段 `tool-expanded-50x40-no-color.png/.txt` 被临时脚本误覆盖，无备份；用户明确接受其丢失。该对文件退出旧阶段原始证据，来源说明见 [旧目录 README](../../../artifacts/tui-prototype-alignment/README.md)。商议定稿的六票源码/素材完整保留，未修改前驱 verification。

当前未提交、未归档；apply 未创建 verification。AGENTS、IC-12、工作台、交接及四份主规格已同步呈现合同。下一批按 D-10 的 owner 接真实能力，继续遵守定稿；Windows 和本次 OS 输入法预编辑/候选窗仍未经验证。

## 10. 验收修复（2026-10-03）

按 verification V-01–04 与用户“直接修复”授权实施 tasks 第 7 节：关闭审阅快捷键例外，恢复总览用途分组与行预算，同步执行概要/节点详情及 Recovery/Finalizer 的六份规格和 IC-12；真实执行 PTY 迁移到项目工作详情入口并保留原事实断言。架构预览说明区分拒绝写入与隔离内存模拟场景。

限定审计发现 F-01：app 与渲染器的详情宽度/末页预算不一致。`Workspace.workspaceLayout/bodyWidth` 与 `ProjectPanel.projectDetailViewport` 统一几何、风险占用及真实可见 offset；输入从该 offset 加减，resize 或超量 Down 不累积不可见滚动。保留定稿列表位置提示；交接身份测试改从项目工作/预算详情读取。复用现有输入路径测试，以 full/collapsed 两个代表用例验证末页往返，无业务或持久化变化。

新增证据另存 [repair-20261003](../../../artifacts/tui-prototype-alignment/repair-20261003/README.md)：96 对修复画面、18 组审阅观察及审计后 12 对补采；原定稿及 full-map 只读。最终复验为 TUI 181 项通过、2 项条件跳过，13 项普通 PTY 通过；typecheck/lint/build、六份规格严格校验及 diff 通过。完整结论由 verification 和交接页登记。
