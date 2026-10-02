# TUI 实现进度与原型交接

> **硬约束：尊重已确认原型。任何 TUI change 必须明确对应的定稿原型，并按其布局、信息层级、视觉风格和交互约定实施、验收。未经用户明确批准，不得自行重新设计。交互正常或自动测试通过，不能替代原型一致性验收。**

状态日期：2026-10-02。接手 TUI 规划、实现或验收时先读本页，核对相关 change 与实际工作区，再更新对应进度。体验决策以用户当前指示和 Decision Ticket 最终决议为准；模块、领域与公共合同分别由 [CONTEXT.md](../../CONTEXT.md)、[architecture.md](../architecture.md) 和 [interface-contracts.md](../interface-contracts.md) 拥有。

## 1. 决策与定稿原型

Route Map 为 [#37](https://github.com/leike0813/orca-companion/issues/37)，分批基线为 [#46 最终决议](https://github.com/leike0813/orca-companion/issues/46#issuecomment-5946016892)。已关闭票的最终决议优先于早期比较稿；本页只记录来源和落地状态，不重新裁决设计。

| 界面 | 已确认方向与来源 | 本机参照 | 落地职责 |
| --- | --- | --- | --- |
| 聊天主区 | #40 选定 continuous；[#41 最终决议](https://github.com/leike0813/orca-companion/issues/41#issuecomment-5934328595) 规定标记、留白、紧凑活动及阅读语义 | [continuous 样例](../../artifacts/tui-prototype/continuous-v2b-80x24.png)、[源码](../../src/interfaces/tui/workspace-prototype.tsx) | 本纠偏项落实当前呈现；完整历史、阅读、详情/搜索由 3A、3B、第四批承接 |
| Composer | [#42 最终决议](https://github.com/leike0813/orca-companion/issues/42#issuecomment-5935340054)；已选 above-input 原型的输入框外观与独立上方候选 | [composer 资产](../../artifacts/composer-prototype/README.md)、[共享输入框源码](../../src/interfaces/tui/composer-prototype.tsx) | 本纠偏项落实输入框外观；slash 候选与命令体系由第六批承接 |
| 当前 Session 回答 | #41 的底部回答区与 #42 的独立草稿、精确提交；第二批已提供真实问答路径 | [第二批规格](../../openspec/changes/complete-tui-editor/specs/tui/session-interactions/spec.md)、composer 资产 | 本纠偏项统一视觉；跨 Session 返回、完整问答历史联动由第五批承接 |
| 项目面板 | [#51](https://github.com/leike0813/orca-companion/issues/51) 选定 tabs：宽屏在原 sidebar 区域，窄屏仅显示项目面板；外框固定、内部浏览 | [项目面板资产](../../artifacts/project-panel-prototype/README.md) | 第五批承接待答联动，第七批完成项目面板；同一既定布局贯穿各批 |
| 临时弹窗 | [#52 最终决议](https://github.com/leike0813/orca-companion/issues/52#issuecomment-5909125813)：紧凑命令目录、模型/effort 分区、字段审阅与反色动作 | [dialog final](../../artifacts/dialog-prototype/final/README.md)，含独立源码归档与配对 PNG/文本 | 第六批；不得重新发起同一轮视觉比较 |
| 顶栏与状态栏 | [#48 决议](https://github.com/leike0813/orca-companion/issues/48#issuecomment-5911794472)；当前选定 custom，最新直接保存与字段配色为 custom-direct | [custom-direct](../../artifacts/statusline-prototype/custom-direct/README.md)、[状态栏总说明](../../artifacts/statusline-prototype/README.md) | 第七批；可信模型、effort、context 与偏好 owner 必须真实接通 |
| 图与节点详情 | [#44 最终决议](https://github.com/leike0813/orca-companion/issues/44#issuecomment-5935645255) 与 dialog final 的 adaptive 图、分区节点卡、检查页及 ASCII 回退 | [工作台图说明](tui-workbench.md)、dialog final 图样例、[图源码](../../src/interfaces/tui/graph-sidebar-prototype.tsx) | 第八批；共享进度摘要及真实依据查询须有界 |

原型运行与采集入口统一见 [TUI 工作台](tui-workbench.md)。采集生产对照使用现有 `pnpm ui:preview` 入口，避免把原型启动入口误当生产组件。

### 参照时必须辨别的边界

- #41 已修订早期 continuous 的“思路摘要常驻”：普通时间线不复制原型注入的 thought；没有可信来源不展示模拟摘要、耗时或工具成功标记。
- #42 已将 Ctrl+A/E 定为行首尾；早期原型的 Ctrl+A 回答和追加式模拟光标不适用于生产。保留当前 Shift+Left、`/answer`、Palette 入口以及真实 Ink 原生光标。
- 完整编辑和粘贴块来自正式决议与第二批实现；单行演示输入、独立全文预览比较稿及模拟图片不替代已实现能力。slash 定稿为上方独立候选，不将 inside 比较稿落为默认。
- 默认 Nerd Fonts、显式 ASCII 回退和无色可辨识规则按相关批次落地；字体差异允许记录，不能据此改变已确认的信息组织。原型中的模型、context、预算、图与 Session 数据是 fixture，生产显示必须来自对应可信合同。
- `dialog-prototype/final`、`statusline-prototype/custom-direct` 的样例及独立源码归档作为参照保留；新增验收画面单独保存，不能覆盖原定稿资产。

## 2. 已有 changes 的状态

“实现完成”“正式验证”“Git 提交/归档”和“原型一致性验收”分别记录。归档 PASS 的覆盖范围以各自 verification 为准，不扩展成后续原型已落地。

| Change | 实现与已有验证 | Git / OpenSpec 状态 | 与当前定稿原型的关系 |
| --- | --- | --- | --- |
| `m2-deliver-planning-tui` | 14/14；[原报告 PASS](../../openspec/changes/archive/2026-09-23-m2-deliver-planning-tui/verification.md)，含原规划 TUI/PTY 范围 | 2026-09-23 已归档；报告绑定的工作树范围见原报告 | 原生产基线，早于本次体验定稿；不代表 continuous 等已迁移 |
| `m2-deliver-execution-tui` | [原报告 PASS](../../openspec/changes/archive/2026-09-29-m2-deliver-execution-tui/verification.md)，含隔离项目真实执行 PTY；限制见原报告 | 2026-09-29 已归档 | 执行功能基线；adaptive 图与新项目面板仍待落地 |
| `tui-debug-workbench-and-ui-migration` | 6/6；[原报告 PASS](../../openspec/changes/archive/2026-09-29-tui-debug-workbench-and-ui-migration/verification.md)，共享主题、现成组件及隔离预览 | 实现 `b4dfd3c`，归档提交 `e774b5a`；2026-09-29 已归档 | 工作台基础；不是后续整套定稿原型的生产迁移 |
| `protect-tui-input`（第一批） | 18/18；[原报告 PASS](../../openspec/changes/archive/2026-10-02-protect-tui-input/verification.md)，草稿隔离、CAS、提交快照与 unknown 保护 | 实现及归档包含于 `c1964d4`；2026-10-02 已归档 | 行为基础；完整编辑与原型外观由后继承接 |
| `complete-tui-editor`（第二批） | [任务 7/7](../../openspec/changes/complete-tui-editor/tasks.md)；[verification PASS](../../openspec/changes/complete-tui-editor/verification.md)，按用户要求复用实施证据，限第二批批准功能范围 | 仍在未提交工作区；报告已补充，尚未归档或同步主规格 | 功能推进符合决议；尚未完成明确的定稿原型一致性验收 |
| `align-tui-with-approved-prototypes`（本纠偏项） | [规划工件](../../openspec/changes/align-tui-with-approved-prototypes/proposal.md)；实现任务未开始 | 新建 active change；没有实现提交或正式验证 | 对齐当前聊天、输入、回答；后续批次必须继续沿用各自定稿 |

### 第二批已实现与已有证据

当前 HEAD 为 `c1964d4913343265d20c4076ff82c5643c6cd30e`。**第二批的实现位于 dirty 工作区，单独检出该 HEAD 得不到第二批成果。** 接手先检查 `git status --short` 与 change 文件，保留现有改动；不要覆盖、重置或重复实现。

- Grapheme 任意位置编辑、行首尾、多行有界 viewport、原生光标；超过 1000 code points 的原子粘贴块保存唯一全文及范围，`/paste` 有界阅读。
- 完整 UiDraft、聊天/回答隔离、CAS、提交前快照、稳定 submissionId、单活跃提交与 generation 防迟到清空。
- 真实 `ask_user` 创建/重放、可信身份与精确问题查询；两种模式及恢复注册接线。当前 Session 的底部回答、选项 Enter 提交、Tab 自由回答、Esc 恢复聊天已实现。
- UI schema 为 v2，保留并拒绝打开不支持的旧格式库；Coordination schema 为 14，问题正文由 Branch Store 拥有。新纠偏项不改变这些合同。

以下是第二批实施阶段已记录的结果，来源为 [implementation-plan 验收记录](../../openspec/changes/complete-tui-editor/implementation-plan.md#9-本轮验收记录2026-10-02)，本次文档工作没有重新运行这些检查：

| 证据 | 已记录结果与边界 |
| --- | --- |
| 类型、lint、构建 | `pnpm typecheck`、`pnpm lint`、`pnpm build` 通过 |
| 全量行为测试 | `pnpm test --maxWorkers=8`：145 文件通过 / 6 条件跳过；1369 项通过 / 12 条件跳过；不能将跳过项记为通过 |
| Ubuntu 真实 PTY | 120×40、80×24、50×40；中文、多行粘贴、resize、回答、Esc 草稿/光标恢复、无色、折叠查看、退出确认与终端模式恢复通过 |
| 真实 IME 人工反馈 | 用户原话：“我已完成人工验收，交互似乎是正常的。”终端与输入法名称未提供；字节注入没有充当 IME 证据 |
| 工件检查 | 第二批严格 OpenSpec 校验及 `git diff --check` 通过 |
| 原型一致性 | 缺少生产画面逐项对照记录，不能由上述交互证据推定通过 |

当前明确偏差：生产 transcript 仍逐条显示“你 / Coordinator”；composer 保留单顶边框与旧标题；回答面板尚无定稿视觉对照。顶栏、项目页签、命令/审阅、状态栏和图的整体迁移仍属后续批次。

## 3. 接续顺序与剩余职责

本轮用户批准在第二批与 3A 之间插入当前呈现纠偏项；不改变 #46 后续批次的职责和相对顺序。按需创建后续 change，不预建整串目录。

| 顺序 | 当前状态 | 后续实施必须完成 |
| --- | --- | --- |
| 第二批收尾 | 7/7；功能范围 verification 已补充，归档待做 | 按报告的工作区范围收尾、归档并同步主规格；Git 操作仍依用户授权 |
| 原型纠偏 | 仅规划 | continuous 当前呈现、圆角 composer、当前回答视觉；保留输入接缝，完成生产画面对照 |
| 3A 历史读写 | 未开后继 change | 有界增量写入/读取、稳定 keyset 与正文范围、正确恢复及生产消费者；完整保留内容可读取 |
| 3B 阅读视窗 | 未开后继 change | 稳定内容锚点、有界双重缓存、Markdown/流式尾部、前插/resize 定位；落实 #53 性能基线 |
| 第四批详情与搜索 | 未开后继 change | 活动关联、完整详情、F3 transcript 搜索与 Ctrl+R 当前 Session 普通发送历史；共用权威历史 |
| 第五批问题联动 | 部分能力已由第二批提前接线；整批未完成 | 问答历史/状态与原卡片联动、跨 Session 进入和返回、版本变化/unknown 核验，保护原阅读位置与草稿 |
| 第六批命令与弹窗 | 定稿原型已保存；生产迁移待做 | 共享命令定义、slash 采用/执行分离、dialog final、真实 provider/model/effort 和角色配置、授权/交接/取消审阅 |
| 第七批项目与状态栏 | 定稿原型已保存；生产迁移待做 | 固定外框 tabs、可信身份/模型/context/预算、用户级偏好及 custom-direct，复用共享验收摘要 |
| 第八批图与依据 | 定稿原型已保存；生产迁移待做 | adaptive 图、节点/版本/依据有界读取、真实状态/存活及稳定选中；全链路跨视图验收 |

性能基线采用 [#53 最终决议](https://github.com/leike0813/orca-companion/issues/53#issuecomment-5945507505)：1000/10000/100000 条记录；输入及已缓存导航 p95≤100ms。完整历史和性能验收不属于当前呈现纠偏，不能把样例短时间线通过当作这些能力完成。

## 4. 原型一致性验收与交接更新

每个 TUI change 在 implementation-plan 写明：受影响界面、对应最终决议/样例、必须保留的设计、该批尚未实现的合同，以及实际生产验收入口。纯呈现复用现有生产组件和主题；原型根组件包含 fixture 与演示状态，不能整体导入生产。

当前纠偏项在 `artifacts/tui-prototype-alignment/` 新存生产对照证据，记录 change、实施 HEAD/工作区范围、环境、终端尺寸、场景、原型路径、PNG/文本路径及逐项结论。针对聊天、输入、回答区域比较布局、边框、留白、标记、配色、选中态和焦点恢复；本批不把尚未迁移的项目/状态栏/图记为已对齐。

用现有生产组件预览覆盖 120×40、80×24、50×40；普通聊天、空/多行输入、中文混排、折叠粘贴、当前问题选项与自由回答、Esc 返回及提交不可用状态；彩色与 `NO_COLOR` 都检查。按目标尺寸独立启动取得干净样例，再单独验证 resize。读写端口使用隔离测试 fixture；预览画面不证明真实 Provider/Orca 合同通过。

行为测试复用已有 editor、workspace、输入路径、输入保护、无副作用与 PTY 用例，断言可观察内容、身份和提交行为。画面用逐项人工对照，不增加整屏 snapshot、像素精确断言或仅检查源码字符串的门禁。

更新进度时分别写明实现任务、运行过的检查、原型对照结论、提交/归档状态及剩余风险，并链接实际证据。完成实现后按项目规则固定验收对象再创建 verification；仅规划、假数据画面、历史报告或用户交互反馈都不能冒充该项正式验收。当前平台证据限 Ubuntu，Windows 未验证。
