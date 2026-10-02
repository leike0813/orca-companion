## Context

MOD-06 的生产入口是 `TuiAppContent → Workspace → Transcript/Composer/AnswerPanel`。已选原型由工作台另行组合，生产没有直接消费其纯呈现规则。`complete-tui-editor` 已提供真实 editor、输入保护和当前 Session 问答；当前 HEAD 不包含其未提交实现。领域术语及归属沿用 CONTEXT.md、architecture.md MOD-06 与 IC-11/12/13。

## Goals / Non-Goals

**Goals:** 对齐当前聊天、输入和回答呈现，建立逐项生产画面验收，并通过交接页与 AGENTS.md 保持后续原型约束可发现。

**Non-Goals:** 不迁移完整原型根组件或 fixture；不提前实现 #46 的历史/Markdown/搜索、跨 Session 问答、完整命令/弹窗、项目页签、状态栏或 adaptive 图。既有业务语义、应用端口、数据库和依赖不变。

## Decisions

### D-01：原型来源与前驱合同

体验权威为本轮用户选定的“纠正当前界面”、#46 分批决议、#41/#42 最终语义及交接页列出的定稿资产。最终决议优先于旧样例：不复制常驻模拟思路、Ctrl+A 回答或模拟图片。各区域对应来源与未来职责统一登记在 [交接页](../../../docs/dev/tui-implementation-handoff.md)，AGENTS.md 保留简短必读入口。

基线为 `predecessor-contract`，直接前驱 `complete-tui-editor`。规划可先完成；apply 须等待前驱验证归档、同步主规格，并重新核对实际实现 HEAD 和冻结接缝。前驱未满足或接缝漂移时返回规划，不把当前 `c1964d4` 当作第二批实现基线。选择局部纠偏而非全套原型一次迁移，符合用户选择并保留 #46 合同依赖顺序。

### D-02：在生产 transcript 内复用 continuous 呈现

沿用现有 `Transcript` 的有界尾部展示与工具展开身份，对现有逐行渲染加入原型标记、色边及留白；不新建时间线、回合实体或 renderer 框架。用户首行采用色边与 `›`，后续行保持同一正文缩进；助手首行采用较弱标记，后续正文对齐；工具采用折叠箭头、名称和次要详情层级。标记与留白计入实际显示行列，继续服从 `maxLines`。

移除每条消息的角色标题，不添加每回合外框。颜色复用 `tuiColors`，无色仍有边线和标记。生产条目的 text、detail、entryId 与工具展开行为保持；没有可信结果字段就不从原型增加 `✓`，没有实际摘要就不注入 thought。完整历史、Markdown、活动分组与实时处理阶段属于后续批次，不在此通过装饰模拟。直接改现有组件优于导入包含假数据的 `PrototypeTranscript`。

### D-03：输入框外观与几何只有一份计算规则

`Composer` 沿用共享 `PrototypeComposerInput` 的圆角单框、焦点色和横向内边距，使用 `›` 与紧凑 Session/模式说明，去掉开发组件名称和 A/B 比较标题。回答标记仍绑定实际 interaction/revision，长说明按显示宽度裁切，裁切不修改目标身份。空输入提示、只读和不可提交原因保持可辨识。

正文继续使用现有 `composerViewport` 与完整 UiDraft：最多六个正文显示行，并保留终端高度约束和光标跟随。在既有 `render/width.ts` 中集中输入框内宽计算，生产 `TuiAppContent` 的上下移动、Workspace 的 viewport/高度预算及 Composer 的渲染共用；边框两列与左右内边距两列纳入宽度，避免输入键盘按旧 `width - 1` 换行而界面按新 `width - 4` 换行。

原生光标继续由 Ink `useCursor` 在本帧 render 发布，坐标来自实际 origin/box metrics，加上边框、内边距及模式行占用；overlay、只读或非输入焦点时撤销。Workspace 同时调整输入框、问题/选项/提示的实际占用预算，至少保留可见 transcript 与当前编辑区域，不能仅给新边框留旧高度常数。不修改纯 editor 的 grapheme、粘贴或提交规则，也不维护另一份文本或光标。

### D-04：当前回答面板复用同一视觉规则

`AnswerPanel` 和当前待答入口使用既有主题区分问题、题序、选项、提示及自由输入。当前选项使用定稿选择组件的反色高对比样式，同时保留文字/符号标记；提示为次要信息。正文阅读与选项窗口沿用前驱边界，自由回答直接复用同一 `Composer`。

只调整显示，不改变 Shift+左右、Tab、Enter、Esc 优先级，不改 owner、InteractionId、expected revision 或 submissionId。旧交互没有 question 时保留真实 subject/身份提示，不补造问题。新事件不打开面板；accepted/rejected/unknown 的判断仍由原管线提供，样式不把拒绝、过期或未知改成成功。跨 Session 进入/返回及已回答卡片历史联动仍由第五批承接。

### D-05：应用与持久化接缝冻结

IC-11 `TuiPorts`/Controller 查询、发送与回答应用命令，IC-13 UiDraft/UiInputStore、CAS、完整提交快照、单活跃提交和 generation 保护保持不变；UI schema v2、Coordination schema 14 及恢复流程不迁移。业务和存储不因视觉变更新增写入或副作用。内部纯内宽计算可被现有组件复用，不增加新的应用公共 API、端口、依赖或通用主题系统。

输入、显示与持久化的失败继续走既有保护：不可提交原因明确可见；unknown 保留原身份核验；render/effect/resize/remount 不保存草稿、不发送、不恢复模型或派发 Worker。任何实现若需要改这些接缝、引入新的可信数据字段或改动业务规则，先回到 change 设计。

### D-06：逐项画面对照与进度分开记录

使用真实生产组件预览和既有隔离端口，覆盖彩色/NO_COLOR、120×40/80×24/50×40，以及聊天、中文多行、折叠粘贴、问题选项/自由回答、Esc 返回和禁用状态。对照聚焦当前三类区域，不将未迁移的顶栏/项目/状态栏/图判为本批已完成。字体差异和较早样例的已修订语义逐项解释，不能笼统宣称“整体像原型”。

在新目录 `artifacts/tui-prototype-alignment/` 保存 PNG/文本、环境、实施 HEAD/工作区范围、参照路径和逐项结论。复用 tuistory/PTY 工具，不运行会覆盖原 final/custom-direct 样例的采集脚本，不增加像素或整屏 snapshot 测试。主 agent 亲自核对生产画面；行为测试不能替代此项。交接页在完成实现/验证/归档时分别更新状态、证据与迁移后的链接，不能将第二批人工交互反馈记为本批原型验收。

## Risks / Trade-offs

圆角框会减少内宽并增加外框占用，必须同时核对按键移动、换行、原生光标和三档高度；长 ID 与警告需要按实际宽度裁切。字体及颜色由终端决定，验收检查布局和语义，不要求跨字体像素相同。当前历史仅有原来的有界尾部窗口，本批呈现通过不意味着完整历史、Markdown 或 #53 性能通过。

## Migration Plan

无数据库、配置、依赖或业务 API 迁移。先核验已归档前驱，再串行修改生产组件与必要测试；原型源码和独立归档作为只读参照。新增画面对照单独保存；本轮工件创建保留用户已有未提交实现，不提交代码或自动归档前驱。

## Open Questions

无阻塞设计问题。实际实施 HEAD 与前驱归档路径在 apply 前按记录核验；当前不编造它们。
