# 顶栏与 statusline 原型

对应 [对比顶栏与 statusline 的信息分层和自定义原型](https://github.com/leike0813/orca-companion/issues/48)。用户已选择 custom，并确认字段、格式、排序和保存方案。新版遵循 [界面职责决议](https://github.com/leike0813/orca-companion/issues/50#issuecomment-5903702588)，复用已选定的栏目切换项目面板和 [弹窗/图节点定稿资产](../dialog-prototype/final/README.md)。当前仍是假数据工作台，正式实施由后续规划负责。

在项目根目录的交互式终端运行：

```sh
pnpm ui:status-prototype blocked custom
```

场景有 `planning`、`execution`、`blocked`、`answer`、`idle`；末项可以换成 `current` 或 `custom`。三方案使用相同快照、continuous transcript、composer、adaptive 图、项目面板、四类弹窗及导航状态。

| 方案 | 顶栏与风险 | Composer 下方 |
| --- | --- | --- |
| current 现有组件 | 现有 TopBar；长 Scope ID 会挤掉窄屏后的字段 | 现有 StatusLine 的 revision、密度、维护与执行摘要，供对照 |
| fixed 固定优先级 | 仓库/分支、选中会话、模式/控制、全局待答、不同的执行持有者；风险最多两行 | 模型、推理强度、可靠上下文占用，一行呈现 |
| custom 可配置 | 与 fixed 相同 | 模型、推理、上下文常驻；可勾选并排序图版本、规划票、执行工作包、验收进度与流程预算 |

`Ctrl+P` → 搜索“选项” → “状态栏”。核心信息支持模型名 / Provider＋模型、上下文已用比例 / 剩余比例 / 已用量与容量。推理强度保留明确标签；修改真实 effort 仍使用模型弹窗。附加字段使用空格勾选，已选字段用 `←→` 排序。进度可以显示数量或百分比；预算按工作包、实现尝试或恢复类别选择，仅展示可信已用量。

配置页实时预览当前主区域宽度；`↑↓` 移动、空格勾选，已选附加字段用 `←→` 排序，格式行用 `←→` 调整。`Enter` 在任意行直接保存并关闭弹窗，返回原对话或项目面板；`Esc` 取消并逐层返回。“恢复默认”是列表末项，空格恢复后按 Enter 保存。保存成功才应用，取消不影响原偏好。新消息与 resize 保留编辑草稿、选择和原会话。模式不适用的附加字段自动隐藏；宽度不足时从排序末尾让位，字段整体省略，规划票标题可缩短且保留票号。

设置列表、预览和主界面使用同一字段配色：模型/执行工作包青色，推理/规划票/预算紫色，上下文/验收进度绿色，图版本亮蓝色，分隔符灰色。字段保留明确标签和独立文字；无颜色终端仍显示相同信息。使用现有终端色，不新增主题或颜色配置系统。键位与类别着色参考 Codex 0.159.2 的 MultiSelectPicker 和 status_line_style；本项目核心字段仍遵守常驻决议。

原型偏好单独保存在 `${XDG_CONFIG_HOME:-~/.config}/orca-companion/prototypes/statusline.json`；只按 Enter 保存才写文件，重启恢复格式和排序，跨 Session 复用。可设置 `ORCA_STATUS_PROTOTYPE_CONFIG` 指向隔离文件。此文件不是正式产品配置、不进入业务 checkpoint 或共享协调状态。损坏配置回退默认并输出诊断；保存失败保留原设置和编辑草稿。

固定和自选同高。身份先为会话、控制与待答等事实保留宽度，再缩写仓库标签；完整身份在项目面板。状态栏优先保留模型名，空间不足先省略 Provider，再缩短模型名称。风险正常不占行，异常最多两行，超出后明确显示“另有 N 项”。执行详情继续由原 sidebar 和独立图检查承载。规划尚未授权是正常状态；没有图的空闲场景不填 active 0。

通知单独显示在输入框上方，不替换模型行、上下文或风险。通知示例同时写入本次启动的最近事件窗口。当前会话只展开一张待答卡；回答仍绑定原 interaction ID/revision，与普通聊天草稿隔离。

## 操作

| 按键 | 原型行为 |
| --- | --- |
| Ctrl+T | 循环 current / fixed / custom；不改会话、草稿或滚动 |
| Ctrl+Y | 切换五场景 |
| Ctrl+W | 显示/清除通知示例 |
| Ctrl+E | 轮换示例来源：已设置、未设置、不可用 |
| Ctrl+U | 模拟图/待答正文等来源不可读 |
| Ctrl+P / Ctrl+S | 命令目录 / 会话选择 |
| Ctrl+B / Ctrl+G | 项目面板 / 独立执行图检查 |
| Ctrl+N | 模拟其他会话新消息；只更新标记与事件 |
| PageUp / PageDown | 对话阅读位置 |
| Ctrl+A / Ctrl+R | 回答当前问题 / 回到原列表和会话 |
| Esc | 逐层返回，保留原栏目、焦点、阅读位置和草稿 |
| Ctrl+C | 已定稿的退出确认 |

比较和来源切换只用于原型。普通 `1`、`m`、`n`、`s` 会进入 composer，不再被旧原型快捷键截获。

120 列打开项目面板时复用原 sidebar 区域，对话与输入框不移动。80/50 列面板独占主区域；关闭后恢复原对话。打开弹窗、项目面板或独立图检查时，全局身份、待答和风险保留，内容区域按实际顶栏高度计算，不溢出终端。

建议试用：在 blocked 场景输入草稿，Ctrl+W 观察通知，Ctrl+T 对比方案，Ctrl+B 查看项目并关闭；再换 planning，通过 Ctrl+P 搜索 model，选择当前 Coordinator，试选 B 与独立 effort，逐层返回看模型行变化。切换到不支持 effort 的 D 时，模型行显示“不支持”。宿主拒绝示例 C 时原模型/effort 保留。

## 来源与合同缺口

| 内容 | 当前来源 |
| --- | --- |
| Scope/Session、模式/控制、执行持有者、待答归属/revision、图/Worker/阻塞/维护/压缩 | 既有 ControllerSnapshot → projectTuiViewModel；本原型注入固定快照 |
| 仓库/分支标签、待答正文 | 固定 fixture；正式需要可信、有界的应用投影 |
| 模型与 effort | 与已定稿模型菜单共用 modelInfo 示例目录；按选中会话保存在现有原型展示态，不是新的生产配置合同 |
| 上下文 | 明确的会话 fixture：S-A 62k/100k、S-B 28k/100k；可换已用/剩余比例。不是账单 token、费用或执行预算；来源不可用时不填零 |
| 切换模型后的上下文 | 原读数绑定旧模型配置；配置改变后显示不可用，不继承原百分比 |
| 推理强度 | 区分已设置、未设置、不可用与模型不支持；没有可信来源时不猜值 |
| 预算 | 按 budgetKey 查 consumed，不再取第一条；approvedLimitRef 是引用，不是数值上限。未登记类别明确显示未登记；不提供费用或猜测分母 |
| 规划票 | 选中 Session 的明确示例：S-A 为状态栏票，S-B 为信息清单票；idle 没有领取票。正式需要可信 Claim 投影 |
| 验收进度 | 当前 fixture 的 frontier 明确包含全部工作包及已接受状态，分母来自完整 topology；执行示例与 sidebar 一致为 9/20。不从折叠 sidebar 的 nodes 或 Task 完成推断；生产 frontier 不保证完整，正式需提供按 Accepted Validator Result 统计的专用摘要 |
| 普通字段偏好 | 用户级原型 JSON，由 preview host 校验、读取和显式保存；不进入 checkpoint 或协调状态 |

累计 Token、费用、Provider 限额没有真实数据合同，本轮不开放。仓库/分支、Session 名继续由顶栏承担；工作目录、完整 ID、状态 revision 和版本保留在详情/诊断，不占日常状态栏。默认三核心项＋图代际/版本。

正式合同仍由 [制定 TUI 分批落地与验收顺序](https://github.com/leike0813/orca-companion/issues/46) 归拢，命令定义与准入仍由 [命令分工决策](https://github.com/leike0813/orca-companion/issues/45) 裁决。本次不更改生产 Controller、模型/授权/交接合同、存储或 Worker 调度。

## 已选 custom 的画面与源码留存

Enter 直存、左右排序及字段配色的最新三档样例与独立源码入口见 [custom-direct/README.md](custom-direct/README.md)。配置、取消、保存、重启恢复、失败、Session 切换和 resize 的验证在新目录复用。此前 `custom/`、`resumed/` 和弹窗 `final/` 归档保留。

## 前轮三方案画面与源码留存

新版在 [resumed/](resumed/)：每张 PNG 有同名终端文本，[samples.json](resumed/samples.json) 为完整索引。样例使用真实 PTY，PNG 由 ghostty-opentui 的 Nerd Font 与中文后备字体绘制，字体细节可能与用户终端不同。原型操作条属于比较工具。

| 对照 | 120×40 | 80×24 | 50×40 |
| --- | --- | --- | --- |
| 固定阻塞 | [PNG](resumed/fixed-blocked-120x40.png) | [PNG](resumed/fixed-blocked-80x24.png) | [PNG](resumed/fixed-blocked-50x40.png) |
| 有限自选 | [PNG](resumed/custom-blocked-120x40.png) | [PNG](resumed/custom-blocked-80x24.png) | [PNG](resumed/custom-blocked-50x40.png) |
| 现有组件 | [PNG](resumed/current-blocked-120x40.png) | [PNG](resumed/current-blocked-80x24.png) | [PNG](resumed/current-blocked-50x40.png) |
| 通知 | [PNG](resumed/notification-120x40.png) | [PNG](resumed/notification-80x24.png) | [PNG](resumed/notification-50x40.png) |
| 项目入口 | [PNG](resumed/project-120x40.png) | [PNG](resumed/project-80x24.png) | [PNG](resumed/project-50x40.png) |
| 弹窗与风险 | [PNG](resumed/session-dialog-risk-120x40.png) | [PNG](resumed/session-dialog-risk-80x24.png) | [PNG](resumed/session-dialog-risk-50x40.png) |
| 模型切换 | [PNG](resumed/model-changed-120x40.png) | [PNG](resumed/model-changed-80x24.png) | [PNG](resumed/model-changed-50x40.png) |

另存五场景、其他会话、三种来源状态、不支持 effort 与三种自选字段。[source.tar.gz](resumed/source.tar.gz) 是此次可运行工作台的独立源码副本；[provenance.json](resumed/provenance.json) 记录工具版本、基线 HEAD 与保存时间。恢复应在独立空目录解压，使用归档的锁文件和工具版本，不覆盖当前工作区。此副本保存待裁决原型，不标记为用户定稿。

旧源码副本位于 `legacy-source/`，文件名将原路径的 `/` 改成 `__` 并附加 `.txt`，不进入源码/lint 扫描。旧截图仍保留在本目录。弹窗定稿的独立 source.tar.gz 与最终样例没有被覆盖。

```sh
pnpm build
node artifacts/statusline-prototype/verify.mjs
node artifacts/statusline-prototype/verify.mjs --capture
node artifacts/project-panel-prototype/verify.mjs --variant tabs
pnpm lint
git diff --check
```

新版检查覆盖三方案、五场景、120×40/80×24/50×40，连续 resize、中文、无色、通知与风险保留、来源缺失、模型/effort 切换及拒绝、普通字符输入、草稿/阅读位置和返回路径。现有项目面板 12 项检查复用；无 TTY 启动返回 2 且 stdout 为空。所有业务动作均为内存模拟，验收范围仅当前 Ubuntu 假数据工作台。

资产只在本机工作区，未提交或上传；GitHub 不能直接下载。本票仍开放，等用户试用后选定呈现方案，届时再记录 Resolution 和地图决议索引。

## 历史比较资产

以下文字说明旧截图与旧源码当时的比较内容；新版入口及规则以上文为准。

### 旧顶栏与状态行原型

按 [#49 已确认的信息与布局](https://github.com/leike0813/orca-companion/issues/49) 重新对照现有组件、固定优先级和有限自选。先运行 `pnpm build`，再运行 `pnpm ui:status-prototype blocked fixed`；场景可换成 `planning`、`execution`、`answer`、`idle`，末尾方案可换成 `current` 或 `custom`。运行中 `1/2/3` 换方案、`M` 换场景、`S` 换自选字段（Graph／预算已用／revision）、`N` 切换一次性通知、`Ctrl+B` 打开或关闭 Scope 详情、`Esc` 关闭详情、`Ctrl+C` 退出。切换器底行只供原型操作，不是产品键位。

| 对照 | 120×40 | 80×24 | 50×40 |
| --- | --- | --- | --- |
| 现有组件 | — | — | [阻塞](v2-current-blocked-50x40.png) |
| 固定优先级 | [执行](v2-fixed-execution-120x40.png) | [阻塞](v2-fixed-blocked-80x24.png) | [阻塞](v2-fixed-blocked-50x40.png) · [待答](v2-fixed-answer-50x40.png) · [Scope 详情](v2-details-blocked-50x40.png) |
| 有限自选 | — | [同一阻塞快照](v2-custom-blocked-80x24.png) · [预算已用字段](v2-custom-budget-80x24.png) | [同一阻塞快照](v2-custom-blocked-50x40.png) |

现有组件在 50 列先展示长 Scope ID，控制状态和对账告警被裁掉。两种新方案把可识别的仓库/分支、选中 Session、模式与控制状态保留在顶栏一行；选中 Session 不是执行 lease holder 时，另一持有者也可见。50 列使用 `orca-c/main` 的缩写，完整值在 `Ctrl+B` 详情中。安全、阻塞、降级告警按优先级排布，最多增加两行；溢出以“另有 N 项”提示。待答全局计数常驻顶栏，主工作区只展开选中 Session 的一张问题卡，其余问题从详情进入。80×24 下转录区仍有空间，紧凑侧栏先放当前工作包和 Worker，再放图摘要；50 列折叠侧栏，详情可查看完整身份、图、预算引用和待答列表。

底部状态行在规划场景给出当前票据，在执行场景给出活动工作包、阶段和 liveness；通知临时替换该行。有限自选只在该行末尾追加一个普通字段，放不下时让位，不能更改身份、待答或告警。相同阻塞快照下，它只比固定方案多一个 `G2 v3`；固定方案更省认知与设置成本，目前没有足够依据把普通字段自选做成持久配置。

原型通过真实 `projectTuiViewModel` 投影固定假快照，渲染和键位都没有 Controller 副作用。`ControllerSnapshot` 尚无仓库/分支显示名、Session 领取票据和待答正文，因此 `orca-companion/main`、`#48` 和卡片问题是**仅供原型的示例数据**；原型不伪造费用或预算上限数值。现有宽侧栏仍把预算已用量与 `approvedLimitRef` 排成 `3/authorization-v2`，实现时需改为不暗示数值上限的文案。截图在 `NO_COLOR=1` 的真实 PTY 中采集；旧版（#49 决策前）的截图保留在本目录，供追溯原方案。
