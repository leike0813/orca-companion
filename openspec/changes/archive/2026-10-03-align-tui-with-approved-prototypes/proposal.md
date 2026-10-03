## Why

本 change 原稿将“尊重已确认原型”缩成聊天、输入和当前回答三个区域，遗漏同一 Route Map #37 中已定稿的项目面板、临时弹窗、顶栏/statusline 与 adaptive 图。局部实现和测试通过不能证明整套原型已被遵守。按用户本轮要求重新起草：逐票绑定参照，纠正现有生产界面的布局与导航，并显式登记尚缺的可信数据合同。

## What Changes

- 在 design.md 直接引用 #40 continuous、#43 adaptive、#47 above-input、#48 custom-direct、#51 tabs、#52 dialog final 的最终决议、源码和画面；#41/#42/#44/#45/#50 的最终语义优先于旧演示。
- 保留已有聊天、圆角 composer、当前回答和原生光标改动，放入完整工作区布局重新验收。
- 落地固定外框项目面板：Ctrl+B 宽屏复用 sidebar 区域，窄屏独占主区域；总览、待答列表、最近事件和详情共用外框。
- 对齐既有命令、Session/模型选择、授权/交接及危险确认界面；slash 候选位于输入框上方，采用与执行分开，共用现有操作定义和准入。
- 对齐简短顶栏、常驻单行 statusline、独立风险提示；消费现有可信字段，缺失 effort/context 等显示不可用。
- 对齐当前图的 adaptive 拓扑、分区节点卡与全屏检查，三档尺寸可导航；阶段与 liveness 分开，未知不显示完成。
- 建立六票逐项生产画面对照和剩余依赖清单；更新交接页，重新打开扩展后的实施任务。

**BREAKING（TUI 导航合同）：** Ctrl+B 由折叠 Sidebar 改为开合项目面板；最近事件归项目页签；Ctrl+G 在窄屏也打开可用的检查视图。只改变 UI 入口，不改变 CLI、业务权限或应用命令身份。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `tui/planning-workspace`：主区域分配、项目面板、命令候选、弹窗、顶栏/statusline 和六票验收。
- `tui/session-interactions`：当前回答的统一视觉、精确绑定及返回保护。
- `tui/graph-inspection`：adaptive 全屏图检查、分区详情及准确依赖导航。
- `tui/execution-monitoring`：执行信息重新分层、有界 adaptive sidebar，保留执行事实与串行语义。
- `tui/recovery-observability`：Recovery/Segment/Capsule 事实在项目工作详情与最近事件可读，常驻风险保留 blocker 摘要。
- `tui/delivery-finalization`：Finalizer 门禁、只读核验、前后工作区和 Delivery Verdict 在项目工作详情可读。

## Impact

直接前驱 `complete-tui-editor` 已归档于 2026-10-02，7/7 任务、功能范围 verification PASS，主规格已同步。基线 HEAD 为 `d3066e2bf805db3efdc6db1cf9b4d1a8af81c205`；其上已有本 change 的未提交局部实现，必须保留。

范围扩展到 MOD-06 的生产工作区、展示态、命令定义、图布局、现有预览和行为/PTY 检查；实施时同步 AGENTS.md、IC-12 与工作台说明中的旧 UI 合同。IC-11 应用命令/查询、IC-13 输入存储、数据库、依赖和业务状态机保持。

完整历史/Markdown/搜索、跨 Session 回答返回协议、真实角色模型/effort 能力、用户级 custom 偏好、可信身份/context/验收摘要与历史依据查询仍需 #46 对应功能批次补合同。它们在 design.md 逐项登记；本 change 不得声称六张原型票的全部功能已完成，也不得以这些缺口为由继续保留现有区域的旧布局。
