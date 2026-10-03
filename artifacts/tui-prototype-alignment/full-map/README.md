# 六票定稿与生产 TUI 对照

> **硬约束：尊重商议过程中确认的六张原型。布局、信息层级、导航与返回以定稿为准；交互检查通过不能替代画面对照。**

本轮范围是 P-40/43/47/48/51/52 的已有生产区域呈现。完整功能缺口统一见 [design D-10](../../../openspec/changes/align-tui-with-approved-prototypes/design.md#d-10逐项合同缺口与后续归属)，不能将本记录解释为六票全部功能完成。源码、最终决议和素材入口见 [D-01](../../../openspec/changes/align-tui-with-approved-prototypes/design.md#d-01六张原型票直接作为设计参照)。

## 对象与复查

2026-10-02 开始实施，最终画面采集于 2026-10-03，Ubuntu；基线 HEAD `d3066e2bf805db3efdc6db1cf9b4d1a8af81c205` 上的当前未提交工作区。Node.js 24.12.0、pnpm 11.10.0、Ink 7.1.1、React 19.3.0、tuistory 0.11.0。`TERM=xterm-256color`；彩色 `FORCE_COLOR=1` 且移除 `NO_COLOR`，无色 `FORCE_COLOR=0 NO_COLOR=1`。PNG 为实际 PTY 数据经 ghostty-opentui 渲染，JetBrains Mono Nerd Font/CJK fallback，14px、1.5 行高；比较终端布局与层级，不比较不同字号的像素。

入口 `scripts/tui-preview.mjs alignment|alignment-planning|planning|execution|empty|disabled` 挂载真实 `TuiApp → Workspace`。端口与输入存储为隔离 fixture，生产组件无 prototype flag。长身份、20 个多依赖节点、三个待答摘要及未知/阻塞状态供呈现验收；它们不代表真实项目、Provider 或 Orca 的运行证据。

从仓库根目录顺序运行：

```sh
pnpm build
node artifacts/tui-prototype-alignment/full-map/capture.mjs
node artifacts/tui-prototype-alignment/full-map/capture-walkthrough.mjs
```

[capture.mjs](capture.mjs) 保存 45 个场景 × 三档 × 两种颜色，共 270 对 PNG/文本；[capture-walkthrough.mjs](capture-walkthrough.mjs) 更新其中的实际回答返回、候选执行，再补一次连续 resize 的 7 对，共 **277 对有效样例**。两者仅写此目录，操作键与等待点保存在脚本内。[samples.json](samples.json) 列出 PNG、同名文本、尺寸、颜色模式和实际原生光标；目录中未列入索引的早期探针文件不计入本轮数量。

## 逐票结论

主 agent 亲自查看 D-01 定稿与下列实际生产画面；各场景另有同名 `.txt`。三档为 120×40、80×24、50×40，均有彩色与无色；`workspace-ascii`、`inspector-ascii` 是通过实际选项切换后的 ASCII，而非重新手绘。

| 原型 / 直接定稿 | 生产证据 | 本次呈现结论 / 功能差异 |
| --- | --- | --- |
| P-40 [continuous](../../tui-prototype/continuous-v2b-80x24.png) | [120](blocked-workspace-120x40-color.png)、[80](blocked-workspace-80x24-color.png)、[50 无色工具](tool-expanded-50x40-no-color.png) | 用户色边/标记、助手弱标记、留白、工具原位展开保留，无回合外框；显示真实正文，不复制模拟 thought/成功。全历史、活动分组、Markdown 和搜索仍缺合同。 |
| P-47 [above-input](../../composer-prototype/slash-above-all-80x24.png) | [120 候选](slash-120x40-color.png)、[80 采用](slash-adopted-80x24-color.png)、[50 无色](slash-50x40-no-color.png)、[执行](slash-executed-80x24-color.png)、[回答](answer-free-80x24-color.png)、[返回](answer-return-80x24-color.png) | 圆角输入/焦点/内边距，独立上方有界候选，首次 Enter 采用、再次 Enter 执行；保留全文编辑、实际光标与精确回答。完整命令搜索和跨 Session 返回协议未接通。 |
| P-51 [固定 tabs](../../project-panel-prototype/tabs-blocked-120x40.png) / [50 详情](../../project-panel-prototype/tabs-details-50x40.png) | [120 总览](project-overview-120x40-color.png)、[80 待答无色](project-pending-80x24-no-color.png)、[50 身份](project-identity-50x40-color.png)、[预算](project-budget-80x24-color.png)、[工作](project-work-80x24-color.png)、[事件](project-events-80x24-color.png) | Ctrl+B 在宽屏原 sidebar 区域切换，100 列以下独占主区；固定框内 tabs、详情和滚动，返回恢复聊天。事件只消费本次最多 50 条。可信 repo/Claim、批准后 Manifest 正文及跨 Session 一键回答未完成。 |
| P-52 [dialog final](../../dialog-prototype/final/commands-80x24.png) | [命令](commands-80x24-color.png)、[会话](sessions-80x24-color.png)、[模型](models-120x40-color.png)、[授权](authorization-80x24-color.png)、[交接](handoff-80x24-color.png)、[取消](cancel-50x40-no-color.png)、[退出](exit-80x24-color.png) | 固定框、标题/摘要/分隔/左右说明、有界字段分栏和反色动作；危险动作默认返回，明确确认后沿原指纹/revision；交接先显式选收件人。仅有真实 Coordinator catalog，provider/effort/Worker 角色与偏好持久化仍不可用。 |
| P-48 [整体与配色](../../statusline-prototype/custom-direct/custom-restored-80x24.png) | [120](blocked-workspace-120x40-color.png)、[80 无色](blocked-workspace-80x24-no-color.png)、[50](blocked-workspace-50x40-color.png)、[设置](options-80x24-color.png)、[空闲](empty-workspace-80x24-color.png)、[禁用](disabled-workspace-80x24-color.png) | 简短 Session/模式/控制状态/全局待答顶栏，Coordinator model/effort/context 与图的单行字段色，风险/notice 独立；完整 refs 进项目详情。effort/context 无可信值显示不可用；custom 格式/排序/直接保存及可信预算 metadata 未完成，未冒充定稿设置可保存。 |
| P-43 [sidebar](../../dialog-prototype/final/sidebar-nerd-120x40.png) / [Inspector](../../dialog-prototype/final/inspector-evidence-nerd-80x24.png) | [120 当前图](blocked-workspace-120x40-color.png)、[80 图](inspector-80x24-color.png)、[50 图无色](inspector-50x40-no-color.png)、[依据](inspector-evidence-80x24-color.png)、[范围](inspector-scope-80x24-color.png)、[身份](inspector-identity-50x40-color.png)、[多关系](inspector-relations-80x24-color.png)、[ASCII](inspector-ascii-80x24-color.png) | sidebar/Inspector 共享 adaptive 拓扑与节点卡；位置稳定、所选邻域有界，真实多分支先选择，执行依据/工作范围/完整身份可读。阶段、liveness、验证分开；只可信 live 可动画，未知不猜进度。共享 Validator 计数、历史版本与依据全文未完成。 |

额外长记录/缺失事实样例：`project-identity-scroll`、`project-other-question`、`project-event-detail`、`authorization-record`、`handoff-record`、`planning-handoff`、`planning-handoff-record`、`cancel-record`、`exit-record`。规划、执行、空闲、禁用各有三档两色；`alignment-planning-workspace` 验证多节点规划图。无色反选、符号和文字仍可辨识，状态不只靠颜色。

## 上下文与连续 resize

回答返回六组样例保留 `原草稿中文abc`，此前 Left 一次的真实 cursor x=14；独立中文自由回答/Alt+Enter 后 Esc，不发送、不覆盖普通草稿。采集显式等待实际原生 cursor 恢复，避免在布局完成前记录暂时隐藏状态；超时使采集失败。索引记录实际 cursor 和可见状态。

一次会话按 120→80→50 观察 [项目详情](resize-project-50x40-color.png)，再按 50→80→120 观察 [图的工作范围](resize-inspector-80x24-color.png)，所选节点和详情栏目不变。逐层 Esc 后 [首中尾](resize-return-120x40-color.png) 证明此前 `首尾` 的中间插入位置保留；行为由真实 tmux PTY 另行验证，截图不替代动作断言。

## 检查与证据边界

`pnpm exec vitest run tests/tui --maxWorkers=8`：27 文件/176 项通过，2 文件/2 项条件跳过；其中 13 项普通真实 PTY 通过。覆盖候选两步采用、当前回答与草稿/光标、项目固定框/事件稳定身份、连续 resize、多关系与首个活动节点选择、确认默认返回以及重绘无副作用。条件真实 Orca execution/handoff 未启用隔离环境开关，跳过不计通过。

`pnpm typecheck`、`pnpm lint`、`pnpm build` 通过；顶栏与四类弹窗最后整合后重新运行上述全范围检查。change 和四份主规格严格 OpenSpec、`git diff --check` 通过，150 个本地文档链接均可解析。AGENTS/IC-12/工作台/四份主规格已同步。没有依赖、schema 或业务状态机变更；未提交、未归档、apply 未创建 verification。

旧阶段一对工具图/文本误覆盖及用户接受丢失的说明见 [旧目录来源更正](../README.md)。六票商议原型源码、final/custom-direct 素材完整保留。本次没有新增真实 OS 中文输入法预编辑/候选窗人工证据，前批反馈不抵充；Windows 未验证。后继 change 按 D-10 补真实能力，沿用上述原型。
