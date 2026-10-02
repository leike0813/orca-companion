# 项目面板组织与导航原型

对应 [对比项目面板的组织与导航原型](https://github.com/leike0813/orca-companion/issues/51)。用户已选定栏目切换方案：默认 sidebar，Ctrl+B 在原 sidebar 区域打开项目面板；窄屏打开时仅显示项目面板。这是固定假数据的临时原型。

在仓库根目录的交互式终端运行：

```sh
pnpm ui:project-prototype blocked tabs
```

最后一个参数可换成 `sections` 或 `menu`。场景可换成 `planning`、`execution`、`blocked`、`answer`、`idle`。入口沿用 `scripts/tui-preview.mjs`，场景复用状态行与执行图的固定快照；用真实 `projectTuiViewModel` 投影，复用 continuous transcript、composer 的选定输入框与 adaptive 图。聊天输入使用现有 `handleComposerKey`，聊天与回答分别保存草稿。

| 方案 | 如何找信息 | 需要试用的取舍 |
| --- | --- | --- |
| `tabs` 栏目切换 | 总览、待答列表、最近事件三个栏目；总览进入预算/授权、身份与工作依据 | 用户已选定；位置固定，当前栏目有方括号标记。 |
| `sections` 分区总览 | 处理事项、额度/权限、项目资料、事件分组排列；每项附一行解释 | 同页可发现所有入口，信息量较大时滚动选择。 |
| `menu` 目录导航 | 紧凑的操作目录；每个入口独立进入详情 | 页面更短，正文按需阅读。 |

默认主界面是对话、composer 和原 adaptive 图 sidebar。项目面板默认关闭，`Ctrl+B` 打开；120 列使用原 sidebar 的区域，对话与 composer 的宽度、位置保持不变，项目面板取得键盘焦点。80/50 列在主区域只显示项目面板，不同时显示对话或 sidebar；当前切换阈值为 100 列。关闭后恢复原布局、草稿、对话滚动和图选择。默认 sidebar 沿用原响应规则，50 列不挤占对话。

同一终端尺寸下，项目面板固定占满所在区域。切换栏目、查看空列表、长列表、工作详情或授权审阅时，外框位置、宽度、高度不变；超出的内容在内部浏览。只有终端 resize 才重新计算区域尺寸，并保留当前栏目与对象。授权审阅示例复用现有组件，在固定面板中显示；其他临时弹窗的比较由对应原型票处理。

图、已接受进度、当前工作/阶段、Worker 存活与阻塞摘要保留在 sidebar。项目面板补充跨会话待答、预算与授权、完整身份、工作记录/证据和最近事件。`Ctrl+G` 为独立图检查入口，其下钻提供完整依据，项目面板的栏目和总览不再复制图或状态摘要。

标题采用青色粗体与分组线；操作以箭头和粗体标识，选中项加紫色底色；解释为次要文字，详情字段名与值区分显示。当前栏目有方括号，无色时仍可区分标题、操作、正文与选中项。

## 操作与试用路径

| 按键 | 操作 |
| --- | --- |
| `Ctrl+B` | 开合项目面板，重开保留原栏目和选择 |
| `Ctrl+G` | 打开独立执行图检查，退出回原位置 |
| `Tab` | 项目面板中轮换总览、待答列表、最近事件 |
| `↑↓` / Enter / Esc | 选择或滚动、进入详情、逐层返回 |
| 图中的 `←→` | 选择一个直接前驱或后继；分叉时仍可用上下键逐节点检查 |
| `Ctrl+A` | 对话内进入当前会话问题的回答模式 |
| `Ctrl+R` | 回答后或取消回答后，回到原列表/会话 |
| `PageUp` / `PageDown` | 对话区浏览较早/较新消息 |
| `Ctrl+T` / `Ctrl+Y` | 切换方案 / 场景 |
| `Ctrl+N` / `Ctrl+U` | 模拟另一会话新消息 / 切换图和问题正文不可读 |
| `Ctrl+C` | 退出预览 |

场景切换用 `Ctrl+Y`：常规终端中 `Ctrl+M` 与 Enter 编码相同，不能作为独立的切场景按键。方案、场景切换键仅用于比较。

建议按以下顺序亲自试用：

1. `blocked tabs`：默认 sidebar 查看阻塞；`Ctrl+B` 打开项目面板，选择「工作记录与依据」，Enter 看完整记录，Esc 逐层返回。项目面板不重复阻塞状态摘要。
2. `execution tabs`：`Ctrl+G` 独立看图，上下选择节点、左右沿依赖移动，Enter 看完整依据；Esc 回图，再 Esc 回原入口。收起、重开或连续改变窗口大小，查看选择是否保留。
3. `planning tabs`：打开总览，按两次 Tab 看最近事件，Enter 读事件详情，Esc 回事件；关闭面板回 sidebar 核对当前状态。事件不替代当前快照。
4. `answer tabs`：先写一段 S-A 聊天草稿，打开总览的待答列表，选择 S-B 的问题；Enter 显式切到 S-B 并绑定回答。写回答后 Enter 模拟提交，或 Esc 取消；`Ctrl+R` 回原列表/S-A。收起面板看原聊天草稿。
5. 面板打开时 `Ctrl+N`：只增加事件/未读标记，保留会话、栏目与对象。`Ctrl+U`：图/工作记录不能读时显示不可读，问题正文不能读时拒绝进入回答。80/50 列下也能看到风险和待答数。
6. 总览的「查看候选授权」在固定面板中显示既有授权审阅组件，Esc 回原入口，外框保持不变。预览门禁关闭，只演示阅读与返回，不产生批准。

## 截图与复现

`<方案>-<场景>-<列数>x<行数>.png` 和同名 `.txt` 覆盖三方案、五场景、三档尺寸，共 45 组。`main-<方案>-120x40` 是默认收起面板的对话；`tabs-graph`、`tabs-details`、`tabs-pending`、`tabs-events`、`tabs-review` 展示关键下钻路径。

对比入口：[栏目切换](tabs-blocked-120x40.png)、[分区总览](sections-blocked-120x40.png)、[目录导航](menu-blocked-120x40.png)。另看 [宽屏工作详情](tabs-details-120x40.png)（与总览对照外框位置和尺寸）、[80×24 总览](tabs-blocked-80x24.png)、[50×40 工作详情](tabs-details-50x40.png)、[执行图](tabs-graph-120x40.png)、[跨会话待答列表](tabs-pending-80x24.png)、[最近事件](tabs-events-80x24.png)、[授权审阅](tabs-review-80x24.png)。

```sh
pnpm build
node artifacts/project-panel-prototype/verify.mjs --variant tabs
node artifacts/project-panel-prototype/verify.mjs --variant sections
node artifacts/project-panel-prototype/verify.mjs --variant menu
node artifacts/project-panel-prototype/verify.mjs --capture
```

检查脚本使用已安装的 tuistory 启动真实 PTY，以状态语义和草稿保留为断言，不比较整屏。采集每个尺寸都重新启动，避免旧缓冲帧混进截图。文本来自无颜色环境；PNG 是终端数据的渲染示意，不是无色文字的像素证据。

本机三方案各 12 项真实 PTY 检查通过，`pnpm build`、`pnpm lint`、`git diff --check` 通过。检查覆盖默认 sidebar、宽屏共用 sidebar 区域、窄屏仅显示面板，以及三档尺寸下空列表/事件/预算/工作详情/审阅之间的外框稳定性；同时验证草稿、事件、导航、回答和退出。只验证当前 Ubuntu 环境。

以上资产只保存在本地工作区，尚未提交或上传；GitHub 上的路径说明不能让远端直接访问图片。

## 来源与限制

全部运行数据都是假数据；以下区分哪些字段已有生产合同，哪些只为比较提供示例：

| 展示内容 | 来源与限制 |
| --- | --- |
| Scope、会话 ID、模式/控制、图版本/节点/依赖、角色/阶段、Worker liveness、worktree/baseline、验证/集成、依据与阻塞引用 | 生产 IC-11/IC-12 已有字段。本预览填入固定快照，并经现有投影；不是当前项目的运行事实。 |
| 图进度 | sidebar 与独立图检查复用完整示例图，示例为 9/20；项目面板不复制此摘要。图不可读显示不可用，不当作零。 |
| 工作依据 | 项目面板按明确 workPackageId 进入完整 ID/worktree/baseline/验证证据/集成引用/derivedFrom；不根据阻塞文案猜目标，也不重复阶段/存活摘要。 |
| 待答所属会话、interaction ID、expected revision | 合同已有；原型绑定后模拟回答，用单独草稿。问题正文和 S-B 对话是显式 fixture，不从真实 transcript 检索；没有测试真实过期 revision 拒绝。 |
| 仓库/分支名称、规划事项、模型/推理强度/上下文占比 | 硬编码示例，现有投影未提供完整展示来源。模型行的 62% 不是推算出来的真实占用；切不可读后展示不可用。 |
| 预算/授权 | consumed、approvedLimitRef、授权引用已投影；数值上限、费用/token usage、当前已批准 Manifest 正文均显示不可用。审阅内容是独立候选 fixture。 |
| 最近事件 | 内存窗口最多 50 条，标明本次启动及截断；初始事件为独立示例，切场景不重置窗口。重启清空，不是持久历史。 |

授权审阅复用现有组件，其措辞、长正文滚动及其余三类临时弹窗由 [对比临时弹窗的选择、审阅与返回原型](https://github.com/leike0813/orca-companion/issues/52) 比较；本原型只接通项目入口。composer 的 slash、图片和完整编辑比较仍在原入口，未重新实现；生产合同扩展归入后续实施规划。精确图形与动效仍待图形语法票裁决。未修改生产 Controller/合同、安装依赖、启动开发服务器或提交代码。
