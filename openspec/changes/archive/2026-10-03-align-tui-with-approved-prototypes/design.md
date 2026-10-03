## Context

生产入口是 MOD-06 的 `TuiAppContent → Workspace`，消费 IC-11/12 投影和 IC-13 输入保护。前驱 `complete-tui-editor` 提供真实完整编辑、持久草稿和当前 Session 问答，已归档并包含于 `d3066e2`。领域与边界见 [CONTEXT.md](../../../CONTEXT.md)、[MOD-06](../../../docs/architecture.md#mod-06-tui)、[接口合同](../../../docs/interface-contracts.md)。

旧版只对齐三个区域，现有未提交代码及 [54 组画面](../../../artifacts/tui-prototype-alignment/README.md) 保留为阶段成果。这里重新定义整个生产工作区的呈现范围，不能沿用旧 6/6 结论。原型素材在本机，GitHub 决议只能说明来源，不能替代本地源码与画面。

## Goals / Non-Goals

**Goals:** 按下面六张原型票纠正所有已有生产区域，并补齐遵守布局所需的项目面板、候选列表、局部导航与有界视窗。每项任务都可从本文件找到定稿参照；每票分别记录已对齐区域和未接通能力。

**Non-Goals:** 不重开已裁决的视觉比较，不导入带 fixture 的原型根组件，不用假数据补合同；不在本次建立完整历史、跨 Session 回答协议、provider/Worker 配置能力或持久展示偏好。缺口按 D-10 登记，不等同于整票验收通过。

## Decisions

### D-01：六张原型票直接作为设计参照

> **硬约束：尊重已确认原型。实现前必须阅读对应定稿源码和画面；生产布局、信息层级、导航与返回必须逐项对照。测试通过不能替代原型验收。**

Route Map 为 [#37](https://github.com/leike0813/orca-companion/issues/37)。以下六项都是本 change 的呈现参照，没有“只实施第一张”的范围解释；source.tar.gz 仅用于恢复定稿，不安装其中依赖或覆盖生产源码。

| 参照 ID / 原型票 | 用户选定版本与最终决议 | 定稿源码 / 索引 | 直接画面参照 |
| --- | --- | --- | --- |
| P-40 / 聊天 #40 | [continuous](https://github.com/leike0813/orca-companion/issues/40#issuecomment-5887651544) | [workspace-prototype.tsx](../../../src/interfaces/tui/workspace-prototype.tsx) | [80×24](../../../artifacts/tui-prototype/continuous-v2b-80x24.png)、[50×40](../../../artifacts/tui-prototype/continuous-v2b-50x40.png) |
| P-43 / 图 #43 | [adaptive 及最终节点卡/图标定稿](https://github.com/leike0813/orca-companion/issues/43#issuecomment-5909174043)；以联动 #52 的 final 为准 | [graph-sidebar-prototype.tsx](../../../src/interfaces/tui/graph-sidebar-prototype.tsx)、[final 索引与独立源码](../../../artifacts/dialog-prototype/final/README.md) | [默认侧栏](../../../artifacts/dialog-prototype/final/sidebar-nerd-120x40.png)、[检查页依据](../../../artifacts/dialog-prototype/final/inspector-evidence-nerd-80x24.png)、[工作范围](../../../artifacts/dialog-prototype/final/inspector-scope-nerd-80x24.png)、[完整身份](../../../artifacts/dialog-prototype/final/inspector-identity-nerd-80x24.png) |
| P-47 / 输入 #47 | [above-input](https://github.com/leike0813/orca-companion/issues/47#issuecomment-5893619686) | [composer-prototype.tsx](../../../src/interfaces/tui/composer-prototype.tsx)、[样例索引](../../../artifacts/composer-prototype/README.md) | [上方独立候选](../../../artifacts/composer-prototype/slash-above-all-80x24.png)、[窄屏](../../../artifacts/composer-prototype/slash-above-all-50x40.png) |
| P-48 / 顶栏与状态栏 #48 | [custom / Enter 直接保存与字段配色](https://github.com/leike0813/orca-companion/issues/48#issuecomment-5911794472) | [statusline-prototype.tsx](../../../src/interfaces/tui/statusline-prototype.tsx)、[custom-direct 索引与源码](../../../artifacts/statusline-prototype/custom-direct/README.md) | [整体布局](../../../artifacts/statusline-prototype/custom-direct/custom-restored-80x24.png)、[字段配色](../../../artifacts/statusline-prototype/custom-direct/field-colors-80x24.png)、[无色](../../../artifacts/statusline-prototype/custom-direct/field-monochrome-80x24.png)、[设置与保存](../../../artifacts/statusline-prototype/custom-direct/direct-options-colors-80x24.png)、[保存失败](../../../artifacts/statusline-prototype/custom-direct/custom-save-failed-80x24.png) |
| P-51 / 项目面板 #51 | [tabs / 固定外框 / sidebar 区域](https://github.com/leike0813/orca-companion/issues/51#issuecomment-5905223127) | [project-panel-prototype.tsx](../../../src/interfaces/tui/project-panel-prototype.tsx)、[样例索引](../../../artifacts/project-panel-prototype/README.md) | [宽屏总览](../../../artifacts/project-panel-prototype/tabs-blocked-120x40.png)、[同框详情](../../../artifacts/project-panel-prototype/tabs-details-120x40.png)、[窄屏待答](../../../artifacts/project-panel-prototype/tabs-pending-80x24.png)、[50 列详情](../../../artifacts/project-panel-prototype/tabs-details-50x40.png) |
| P-52 / 临时弹窗 #52 | [dialog final / 四类弹窗 / 反色动作](https://github.com/leike0813/orca-companion/issues/52#issuecomment-5909125813) | [dialog-prototype.tsx](../../../src/interfaces/tui/dialog-prototype.tsx)、[final 索引与独立源码](../../../artifacts/dialog-prototype/final/README.md) | [命令](../../../artifacts/dialog-prototype/final/commands-80x24.png)、[会话](../../../artifacts/dialog-prototype/final/sessions-80x24.png)、[模型分区](../../../artifacts/dialog-prototype/final/models-120x40.png)、[授权](../../../artifacts/dialog-prototype/final/authorization-overview-80x24.png)、[交接](../../../artifacts/dialog-prototype/final/handoff-overview-80x24.png)、[取消](../../../artifacts/dialog-prototype/final/cancel-confirm-80x24.png) |

相关决策票也必须读取：[#41 时间线语义](https://github.com/leike0813/orca-companion/issues/41#issuecomment-5934328595)、[#42 编辑与历史](https://github.com/leike0813/orca-companion/issues/42#issuecomment-5935340054)、[#44 图形与动效](https://github.com/leike0813/orca-companion/issues/44#issuecomment-5935645255)、[#45 命令分工](https://github.com/leike0813/orca-companion/issues/45#issuecomment-5936017992)、[#50 子界面与常驻信息](https://github.com/leike0813/orca-companion/issues/50#issuecomment-5903702588)。[#46 分批依赖](https://github.com/leike0813/orca-companion/issues/46#issuecomment-5946016892) 与 [#53 性能](https://github.com/leike0813/orca-companion/issues/53#issuecomment-5945507505) 约束后续能力。#49 的信息清单保留，区域归属以较新的 #50 为准。

选择直接在 design 登记，避免只靠交接页或记忆寻找来源；交接页引用本表。早期比较稿、当前生产旧样式和功能测试均不构成另一个设计事实源。

### D-02：continuous 聊天保留前一阶段成果（P-40）

生产 Transcript 保留用户色边/`›`、助手弱标记、留白、紧凑工具和按 entryId 原位展开；不恢复逐条角色标题或回合外框。实际 text/detail 是唯一内容来源，缺少可信结果不补 `✓`、耗时或常驻模拟 thought。#41 修订过的活动分组与历史能力按 D-10 登记。

在现有逐行渲染中维护有界窗口，复用宽字符计算；主区域调整后重新核对可读正文和工具展开。无需另建 timeline 实体或 renderer 框架。

### D-03：above-input 候选与真实 composer 共存（P-47）

沿用现有圆角框、焦点色、横向内边距、紧凑模式说明及前驱完整编辑器。正文宽度共用 `composerContentWidth`，边框、提示、候选、回答区均计入实际高度；原生光标来自 box origin/metrics，遮挡或只读时撤销。禁止第二份正文、模拟光标和追加式编辑。

为现有操作增加独立上方候选：方向键选择，有界滚动，Tab/Enter 先采用可用别名，之后 Enter 才调用；不可用项展示原因且不可采用。Esc 收起候选但不把 slash 输入改成聊天。严格前缀规则同时适用于回答，粘贴和 IME 确认不得触发采用、执行或发送。

复用 `COMMAND_METADATA`/命令解析与现有 handler，补名称、短说明、目标和可用性展示；Palette、slash、Help 使用同源定义。加入纯 UI 的 project/events 入口；events 打开同一个项目页签。缺少功能的 model/options/statusline 子项明确不可用，不伪造 handler。候选查询仅为 UI 状态，不进入 UiDraft 或提交记录。完整搜索与角色配置仍按 D-10。

### D-04：当前回答与返回保护（P-47、P-52）

当前回答仍位于底部输入区域，保留 transcript；问题、题序、选项、次要说明和自由输入沿用统一视觉。选项用反色色块及文字/符号标记，自由输入复用 Composer。Shift+左右、Tab、Enter 和 Esc 沿既有精确问题/输入合同；#42 的 Ctrl+A/E 行首尾优先于旧原型 Ctrl+A 回答。

owner、InteractionId、expected revision、submissionId、草稿隔离及 unknown 处理保持。新问题只更新提示；Esc 保存回答并恢复聊天正文、光标、粘贴和阅读位置。跨 Session 返回协议未完成，不借换样式宣称实现。

### D-05：模块、失败与持久化归属保持

MOD-06 只新增展示态和纯呈现。IC-11 的命令/问题查询与 IC-13 的完整 UiDraft、CAS、提交快照、单活跃提交、generation 防迟到结果保持；UI schema v2、Coordination schema 14 不迁移。现有接口可传递现有字段给组件，不新增 Controller 数据字段或业务写入。

render/effect/resize/remount 不保存、不提交、不恢复模型、不派发。读取或提交失败沿原 rejected/unknown/stale 处理，保留原身份和草稿。候选、面板和图选择都是进程内 UI 状态；禁止借原型引入另一套持久化或数据库读取。缺少真实事实显示不可用，不能填零、取“最近对象”或猜成功。

### D-06：六票验收和功能进度分别记录

主 agent 必须对照 D-01 的真实定稿画面与生产组件。覆盖 120×40、80×24、50×40、彩色/NO_COLOR、Nerd/ASCII、规划/执行/阻塞/unknown/待答/空闲；包括项目各页签/详情、四类现有弹窗、slash 采用、图选择与返回。

旧 `artifacts/tui-prototype-alignment/` 的 54 组证据只覆盖前三个区域；扩展证据另存 `artifacts/tui-prototype-alignment/full-map/`，原定稿和旧阶段样例均只读。报告逐票列：参照、生产画面、已对齐规则、差异原因、D-10 缺口和实际验收状态。字段缺失允许诚实展示不可用，**不允许把该票的全部功能标为完成**；任何已有区域布局偏离仍是本 change 未完成任务。

不用像素门禁、整屏 snapshot 或源文本匹配代替人工核对；行为检查聚焦输入保护、导航、固定框、准确关系和无副作用。第二批 IME 反馈不能替代本次画面验收。

### D-07：固定项目面板替换旧 Ctrl+B 行为（P-51）

采用 tabs：总览、待答列表、最近事件；总览按“需要你处理 / 额度与权限 / 项目资料”用途分组，保留青色标题、操作名、次要说明三层结构，下钻预算/授权、身份、工作记录/依据。默认保留 adaptive sidebar，不用项目面板替代它。以 100 列为边界：宽屏 Ctrl+B 在原右侧区域切换，左侧 transcript/composer/statusline 的位置与宽度不变；80/50 列只显示项目主区域，保留全局身份/风险/待答，关闭恢复原布局。

相同尺寸下各页签、列表、空状态和详情固定位置/宽高，内部滚动；resize 保留页签、所选对象和返回层级。将既有 Event Drawer 的本次启动最多 50 条事件迁入最近事件，标明窗口范围/截断，旧入口指向该页，不建第二个事件仓库。项目总览不重复图、执行进度、阶段/liveness/blocker 摘要。

以现有 snapshot 的 interaction 摘要展示 owner/state/revision；当前 Session 的问题可走原精确查询进入回答，列表/详情打开不自动发送。跨 Session 问题可查看摘要，通过显式 Session Picker 进入所属会话的现有回答流程；完整一键跳转/返回协议按 D-10。缺少正文、批准后 Manifest 或身份标签时明确不可用，候选 review 不能冒充批准后的正文。

展示态集中于 state/app，最小新增 `components/project-panel.tsx`；复用现有 event/selection/review 组件，不新建页面路由系统。旧“三态宽度”和纯展示密度可保留内部计算，Ctrl+B 不再切密度；可用 Palette 的既有纯展示操作调整密度。

### D-08：四类现有弹窗沿用 dialog final（P-52）

会话/选择页保留身份摘要，列表与说明明确分区；命令紧凑左名称/右短说明，按终端预算有界浏览。模型页依 final 分区组织，现有 ModelCatalog 只提供 Coordinator 的 configurationRef/model；Planning/Execution 角色与 effort 尚无对应能力，只能明确未接通，不能虚构可保存选项。

授权、规划/执行交接与 Cancel/Exit 使用固定框、字段分栏/栏目、有界正文和反色动作。审阅默认返回，用户明确选择确认才走原权限/指纹/revision 校验；危险确认保留既有门禁。收件方只能来自真实现有交接查询。无法拆成结构化字段的既有 review 行仍保留原始可信内容，在同一有界正文内读取，不能按文案猜字段。

Esc 逐层回调用位置，保留 Session、正文/光标/滚动及项目页签；审阅/确认期间 Ctrl+P/B/G 不穿透，Ctrl+C 沿原退出流程。notice 与风险不得被弹窗盖成安全态。复用现有 SelectionList/组件和 Ink 布局，只有实际重复的固定框规则需要合并，不建设通用 modal 框架。

Nerd 为默认、ASCII 为显式回退；复用 theme 现有图标集，在纯 UI 选项中即时同步 sidebar/Inspector。进程内选择明确不表示已实现用户级偏好恢复，持久 owner 按 D-10。

### D-09：常驻信息与 adaptive 图纠偏（P-48、P-43）

顶栏以一行为目标，显示现有可信 Session/模式/控制状态、全局待答和风险；repository/branch 与持有者展示标签缺口不拿 cwd 或 fixture 代替。完整 ID、revision、授权引用和维护细节移入项目详情。风险出现时独立有界区域至多两行；提示不得覆盖核心状态。

composer 下方 statusline 保持一行：选中 Coordinator 的实际模型、effort 状态、可靠 context 状态；默认图代际/版本。ModelCatalog 无能力时“模型不可用”，effort/context 缺来源显示“不可用”，不等同未设置。复用 custom-direct 字段颜色及整体字段省略顺序，按主区域宽度先让附加项让位；不再以 revision/sidebar 密度/通知和第二行执行计数占据此处。custom 格式/排序/保存页完整合同按 D-10，本次不以常驻布局通过冒充 custom 功能完成。

sidebar 与全屏 Inspector 复用一份当前 GraphView 拓扑布局及分区节点卡。按稳定 position/WorkPackageId 保留选择，呈现真实依赖；多分支关系由用户选择，不自动沿第一个邻居跳转。卡片区分状态/Worker、依赖、依据、范围、身份；缺少依据只显示引用或不可用。80/50 列 Inspector 仍可浏览选中邻域和详情，不再只提示扩宽终端。

Sidebar 的版本定位编号、阶段/Worker、依赖与队列是概要。角色/attempt、Validation/Integration、worktree/baseline/Evidence 在 Inspector 栏目及项目工作详情读取；Recovery 的 Segment/预算/Capsule/superseded 与 Finalizer 的门禁/只读/冻结/前后工作区/Evidence/Verdict 在项目工作详情汇总。blocker 保留常驻风险摘要，相关事件归最近事件；完整身份和原结果语义不因区域迁移改变。

动态效果只用于已确认 live 的运行节点、既有 spinner/attention，不给未知节点或边制造流动动画。Validation 与 integration/liveness 分开；验收数量必须等到共享可信摘要合同，不能把 accepted、Task done、局部可见节点或 fixture 9/20 当作已接受 Validator 进度。

### D-10：逐项合同缺口与后续归属

这些是功能缺口，不能整张原型票一概“留给以后”。本 change 先对齐已有区域/入口/布局；以下能力仍需 #46 对应批次完成后再次沿用同一原型验收。

| 缺口 / 受影响参照 | 当前事实与本次处理 | 后续 owner / #46 批次 |
| --- | --- | --- |
| 全历史、活动分组、Markdown、搜索（P-40） | 当前有界 transcript/工具 detail 保留；不注入演示 thought | IC-11 历史窄查询及 MOD-06 阅读；3A/3B/第四批，#53 性能 |
| 跨 Session 回答一键进入/返回、历史卡片（P-51/P-47） | 摘要可读，当前 Session 精确回答复用；跨会话用显式 Session 选择，不冒充完整返回协议 | 问题用例/IC-11 与 MOD-06；第五批 |
| provider/effort/角色模型和完整命令搜索（P-52/P-47） | 现有 Coordinator 配置与操作可用，缺失项说明原因；不另造模型 catalog | model configuration/Worker Profiles 与 IC-11，命令 UI；第六批 |
| repository/branch 标签、Claim、effort/context、批准后 Manifest、预算上限 metadata（P-48/P-51） | 消费已有 ID、configurationRef/model、consumed/ref；缺失事实不可用，候选审阅与已批准正文分开 | 应用只读投影 IC-11/12；第七批 |
| custom 展示格式/排序/直接保存、图标跨重启偏好（P-48/P-52） | 保留已选 custom 设计，当前仅标准布局和进程内图标切换；设置入口显示未接通 | 用户级 UI 配置 port、storage adapter、Bootstrap，独立于 IC-13/业务 checkpoint；第七批 |
| 共享 Validator 验收摘要、历史图版本、关联依据全文（P-43/P-48/P-51） | 当前图/节点事实和真实 refs 可读；缺失摘要/历史能力不可用，不从局部图猜数 | 应用有界派生与读取 IC-11/12；第七/八批 |

新的可信字段、偏好 port/schema/path 或业务权限需要对应后继 change 定义后再实现，不在本次以 UI 私读绕过。报告必须保留这些未完成状态。

## Risks / Trade-offs

完整工作区几何变化可能破坏原生光标或最小尺寸输入空间。采用同一正文内宽/高度预算，保留 Ink 普通输出末尾换行行，并用真实 PTY 核验。固定框内部滚动与返回层级是新行为，复用现有 reducer 和选择身份，避免模块各自维护一套草稿。允许缺字段意味着部分原型票仍未全功能落地；验收必须呈现这个边界。

## Migration Plan

保留基线上的局部成果，串行整合布局、项目/命令/弹窗、状态栏与图，再采集全范围证据。实施同步六份主规格的 Ctrl+B/最近事件/窄屏图及 Recovery/Finalizer 归属约束和 AGENTS.md、IC-12、工作台说明；旧历史报告保留原验收范围。当前生产实现与检查见 [implementation-plan 第 9 节](implementation-plan.md#9-实施记录2026-10-02)，验收修复见第 10 节；change 不归档、不提交。

## Open Questions

无影响本次呈现方案的阻塞问题。D-10 的功能合同由后继批次设计，其缺口不能导致当前已定稿布局被重新裁决。
