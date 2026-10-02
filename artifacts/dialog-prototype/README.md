# 临时弹窗选择、审阅与返回原型

用户已于 2026-09-30 确认结票。[定稿索引、最终 PNG/文本与独立源码归档](final/README.md) 是后续实现的入口；本目录 `refined-` 及更早前缀的画面保留为比较记录，不代表最终图标方案。

对应 [对比临时弹窗的选择、审阅与返回原型](https://github.com/leike0813/orca-companion/issues/52)。采用用户反馈指定的组合：命令父目录紧凑排列；会话与模型候选带身份摘要；角色模型和审阅页面分别组织。仍复用项目面板工作台、五场景、continuous transcript、composer 和每会话草稿/滚动状态。

在交互式终端运行：

```sh
pnpm build
pnpm ui:dialog-prototype planning
```

场景可换 `execution`、`blocked`、`answer`、`idle`。

## 操作路径

| 入口 | 内容和操作 |
| --- | --- |
| Ctrl+S | 搜索会话，↑↓ 选择；候选区与下方身份信息用横线分开。Enter 切换，Esc 保留原会话和草稿 |
| Ctrl+P | 紧凑命令目录：左侧名称、右侧简短说明，说明右对齐；输入名称或 ID 搜索 |
| 选项 · 图标 | 默认 Nerd Fonts；`Ctrl+P → 选项 → ASCII` 切换回退，侧栏底部用普通文字提示。两种模式的节点、动画、连线同步切换，选择保留到本次预览退出 |
| Model Picker | 当前会话 Coordinator 单独列出；Planning 区域为 Utility；Execution 区域为 Planner、可选 Spec Validator、Implementation、Validator、Finalizer、Recovery Utility |
| 模型选择器 | 角色页显示当前 provider / model / effort；进入菜单后候选行只有 provider/model。下方横向 Effort 只列该模型支持的选项；不支持时明确显示。Tab / Shift+Tab 在列表、effort、按钮之间切换，↑↓ 选模型，←→ 改 effort 或按钮，Enter 前进到下一块或执行按钮。确认只更新该项；Esc 丢弃菜单草稿并逐层返回 |
| Execution Authorization | 概览、权限、预算、工作范围、完整清单；字段按标签和值分列。保留完整候选 Manifest、revision 和 fingerprint |
| Handoff | 先明确选择接收方，再审阅交接概览、转移责任、绑定依据；返回先取消模拟提案，再回接收方列表 |
| Cancel | 影响范围与完整身份分栏；区分新工作停止、运行工作请求停止、未确认结果等待对账及已完成工作保留 |
| 审阅窗口 | Tab / Shift+Tab 切栏目，↑↓ / PgUp / PgDn 浏览，←→ 选择返回或确认，Enter 执行选中按钮；默认选中返回，当前按钮用反色色块表示 |
| 默认执行图侧栏 | 选中节点使用带边框的信息卡：标题、状态/Worker、依赖关系分区；前驱/后继保留准确编号 |
| 执行图检查 | 同一卡片扩展为完整页面，依赖显示编号和名称；增加执行依据（角色、尝试、工作区、验证/集成）、工作范围、完整身份（节点、图版本/代际、baseline）。Tab 切信息栏目，↑↓ 换节点，←→ 沿依赖导航，Enter 读完整详情 |
| Ctrl+B | 项目面板；总览的“查看候选授权”打开同一授权审阅；返回保留栏目和选中项 |
| Ctrl+C | 退出确认；确认只结束预览进程 |
| Ctrl+N / Ctrl+U | 模拟新消息 / 数据不可读；新消息保留选择，不可读时停止确认 |
| Ctrl+Y | 弹窗关闭后切换背景场景 |

模型候选 `config-rejected` 演示拒绝，原配置保持；`config-basic` 不支持 effort。A 的能力示例为 low/medium/high，B 为 low/medium；这些是原型 fixture，不代表任何真实模型能力。菜单保存每个候选的临时 effort，重新打开时定位当前模型并恢复已选值；取消保持原配置。执行/阻塞场景的 Coordinator 切换受假 ModelCatalog 准入约束。Worker 配置仅为原型展示态，不调用 Coordinator 切换接口。不可核验交接、不可读正文和非规划模式的授权不能确认。

参考 [MiniMax Code 的模型 picker](https://github.com/MiniMax-AI/minimax-code/blob/main/packages/tui/src/tui/features/model/picker.ts) 的模型列表与独立能力控件，以及 [OMP 的 model browser](https://github.com/can1357/oh-my-pi/blob/main/packages/tui/src/overlays/model-browser.ts) 的候选列表与选择详情分区。原型不引入它们的 provider 或配置实现。

## 检查与资产

```sh
pnpm build
pnpm exec eslint src/interfaces/tui/dialog-prototype.tsx src/interfaces/tui/project-panel-prototype.tsx scripts/tui-preview.mjs artifacts/dialog-prototype/verify.mjs
node artifacts/dialog-prototype/verify.mjs --capture
node artifacts/dialog-prototype/verify.mjs --graph-only --capture
node artifacts/project-panel-prototype/verify.mjs --variant tabs
git diff --check
```

`verify.mjs` 使用已安装的 tuistory 和 ghostty-opentui，在真实 PTY 检查会话/草稿隔离、模型与 effort 的独立选择及能力约束、拒绝/取消、动作按钮反色、授权/交接/取消/退出返回和确认、Coordinator 准入，以及侧栏/全屏节点信息和依赖导航。采集 120×40、80×24、50×40，并连续 resize；会话及准入检查使用 `NO_COLOR=1`，模型、按钮和图画面使用有色终端，直接核验 PTY 的 inverse 属性。

`--graph-only` 可仅复验全屏检查与独立 adaptive 图原型。选中动作与 effort 同时在提示行中明确写出，NO_COLOR 下仍可辨认；有色截图还原终端列宽与 inverse 的默认前景/背景。

图标定稿前的修订轮次：build、ESLint、完整 PTY 检查、项目面板原有 12 项检查与 diff 检查通过。保存 90 组修订 PNG/文本，并人工检查模型、反色按钮、80×24 全屏图和独立 adaptive 图等代表画面。无 TTY 启动明确拒绝，退出状态为 2。最后的 Nerd Fonts/ASCII 选项不在这轮完整检查范围内；定稿采集说明和最终样例见 `final/README.md`。


修订版资产使用 `refined-` 前缀，先前方案资产保留作参考：

- [命令父目录，80×24](refined-commands-80x24.png)
- [会话身份摘要，50×40](refined-sessions-50x40.png)
- [阶段与角色模型，120×40](refined-models-120x40.png)
- [Planner 模型候选，80×24](refined-model-menu-2-80x24.png)
- [独立横向 effort，80×24](refined-model-effort-80x24.png)
- [执行授权概览，80×24](refined-authorization-overview-80x24.png)
- [规划交接概览，80×24](refined-handoff-overview-80x24.png)
- [停止项目协调，50×40](refined-cancel-50x40.png)
- [取消确认按钮反色，80×24](refined-cancel-confirm-80x24.png)
- [默认侧栏节点卡片，120×40](refined-graph-sidebar-120x40.png)
- [全屏节点执行依据，120×40](refined-graph-inspector-execution-120x40.png)
- [全屏节点工作范围，80×24](refined-graph-inspector-scope-80x24.png)
- [独立 adaptive 图原型，80×24](refined-graph-adaptive-80x24.png)

所有源码、脚本及 PNG/文本只在当前工作区，未提交、未上传；GitHub 无法直接访问本机资产。业务端口仅返回内存模拟结果，不连接模型、Worker、Orca、tracker、数据库或实际 Git 操作。

## 正式实现需要补齐的合同

| 项目 | 已有依据与缺口 |
| --- | --- |
| 会话身份 | 复用 IC-11 / IC-12 的 Session ID、生命周期、配置、责任、lease、待答信息；可读标题为固定示例，正式需可信有界投影 |
| Coordinator 模型 | 复用 ModelCatalog、modelSwitchAdmission 和 Session/configurationRef 切换；provider/model/effort、supportedEfforts/defaultEffort 为展示示例。正式需可信配置和能力投影，不能靠 provider 名称猜选项；现有 ref 切换接口不保存独立 effort，本原型只更新展示态 |
| Worker 模型 | 当前项目配置只有共享 `workerModel`，没有按阶段/角色保存 provider/model/effort 的合同。正式实现需明确 Worker Profile 的唯一 owner、准入与持久化；本原型不改生产配置 |
| 授权栏目 | 完整正文仍由假 review port 提供，批准传 fingerprint/expectedRevision；原型按固定 fixture 位置分组。正式应由宿主提供语义分组，不按行号推断权限 |
| 交接 | 使用规划/执行各自 prepare/cancel/cutover 假端口；责任说明和绑定依据是固定示例。正式必须消费实际 review 投影及可移植性、安全边界判决 |
| 返回与异步 | 弹窗保留原搜索和角色选择，底层保留栏目、会话、草稿及滚动；正式仍需核验 unknown、迟到响应和恢复 |
| 节点信息 | 侧栏与全屏复用 AdaptiveGraphSidebar，消费已有 WorkPackageNodeView 的角色、尝试、Worker、Scope Envelope、验证/集成及事实引用，不制造缺失数据。全屏更详细，Enter 保留完整依据阅读路径；窄画面字段可裁切 |
| 图标偏好 | 默认 Nerd Fonts，显式 ASCII 回退；节点与动画共用所选模式，侧栏提供文本提示。原型仅在本次预览内保存，正式 owner 与持久化由实施规划明确 |
| 命令定义 | 目录只是原型入口；共享命令定义、slash 分工与完整准入由后续命令票决定 |

验证范围为当前 Ubuntu 本机假数据 PTY；真实协调副作用、生产恢复路径和其他平台未验证。用户已接受角色模型、审阅页面及图标方案；视觉裁决完成，正式合同补齐仍由后续实施规划处理。
