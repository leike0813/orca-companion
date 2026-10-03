# 验收修复画面对照

2026-10-03，Ubuntu，HEAD `d3066e2bf805db3efdc6db1cf9b4d1a8af81c205` 加上修复后的未提交工作区。Node 24.12.0、pnpm 11.10.0、Ink 7.1.1、React 19.3.0、tuistory 0.11.0；TERM 为 xterm-256color，颜色及字体设置沿用 [full-map](../full-map/README.md)。入口挂载实际生产 TUI，后端与输入存储使用隔离 fixture，不代表真实 Orca/Provider。

从根目录运行 `pnpm build`，再运行 `node artifacts/tui-prototype-alignment/repair-20261003/capture.mjs`。本脚本只写此修复目录；原定稿、旧阶段及 full-map 画面保持原状。

[samples.json](samples.json) 登记 **96 对** PNG/同名文本，覆盖 120×40、80×24、50×40，彩色/NO_COLOR，Nerd 与实际选项切换后的 ASCII。[checks.json](checks.json) 记录三类审阅 × 三档 × 两色共 **18 组** Ctrl+P/B/G 拦截观察。[capture.mjs](capture.mjs) 保留操作序列；图片和文本由实际终端数据生成。索引无重复或缺失，文本行数和显示宽度均未越界。

限定审计修复滚动预算与列表位置提示后，再以 [capture-post-review.mjs](capture-post-review.mjs) 补采 **12 对** 当前总览/选中工作画面，登记在 [post-review-samples.json](post-review-samples.json)；两次共 **108 对**，没有覆盖前 96 对。例如 [80 列末项](post-review-work-selected-80x24-color.png) 显示位置范围、所选对象与原固定外框。输入分发与渲染共用有效密度、风险行数及详情视口，full/collapsed 两个回归都验证超量 Down 后一次 Up 即可回退，再 Down 回末页。

[details-probe-result.txt](details-probe-result.txt) 为最新构建上的辅助 tmux 220×80 固定投影探针记录：两个长 ID 节点、一条 Recovery 和 Finalizer 各字段，39 次滚动读到 verdictRecording，Esc/Enter 顶部重开及逐层返回通过。探针派生入口位于 `/tmp/orca-v04/`，不作为唯一长期证据；实际导航与字段合同保留在仓库中的 pty-execution、recovery、execution-handoff 与 finalizer 测试。它只核验投影呈现，不验证模型、真实 Worker 或 Controller 接受该 fixture 的资格。

| 原型与修复 | 定稿参照 | 修复后生产画面 / 结论 |
| --- | --- | --- |
| P-51 / V-02 总览分组 | [宽屏 tabs](../../project-panel-prototype/tabs-blocked-120x40.png)，project-panel-prototype 的 overviewRows/renderRows | [120 总览](project-overview-120x40-color.png)、[80 总览](project-overview-80x24-color.png)、[50 总览](project-overview-50x40-color.png)、[80 滚动](project-record-groups-80x24-color.png)、[无色](project-record-groups-80x24-no-color.png)：恢复需要处理、额度与权限、项目资料三组；用途标题/操作/说明及留白对齐，选中工作条目可滚到框内。 |
| P-52 / V-01 审阅键位 | dialog final 与 [#45 最终键位](https://github.com/leike0813/orca-companion/issues/45#issuecomment-5936017992) | [授权](authorization-guarded-80x24-color.png)、[执行交接](execution-handoff-guarded-80x24-color.png)、[规划交接](planning-handoff-guarded-80x24-color.png)、[50 无色](authorization-guarded-50x40-no-color.png)：Ctrl+P/B/G 后仍停在原审阅，未打开 Palette、图或项目面板；原默认返回保留。 |
| 固定框与其他入口 | P-51/P-52 原定稿，见 [design D-01](../../../openspec/changes/align-tui-with-approved-prototypes/design.md#d-01六张原型票直接作为设计参照) | [预算](project-budget-80x24-color.png)、[工作](project-work-80x24-color.png)、[选中工作](project-work-selected-80x24-color.png)、[危险确认](cancel-guarded-50x40-no-color.png)：框内有界，窄屏主区域独占，宽屏原 sidebar 区域不移动对话。 |
| 图标与上下文返回 | P-43 adaptive、P-47 完整输入 | [ASCII 项目](project-ascii-80x24-color.png)、[ASCII 图](inspector-ascii-80x24-color.png)、[返回](return-cursor-80x24-color.png)：切换后两区域可读；首尾中间插入得到首中尾，六组实际原生光标均可见且 x=6。 |

主 Agent 亲自对照三档分组、滚动与彩色/无色画面，核对审阅拦截后的固定框和默认返回。其余未受修复影响的 P-40/P-47/P-48/P-43 全场景证据沿用同一工作区基线的 full-map 与先前隔离重采集；当前结论以 [verification](../../../openspec/changes/align-tui-with-approved-prototypes/verification.md) 为准，旧 full-map 的阶段描述不替代本次修复验收。

完整历史、跨 Session 返回、角色/effort/custom 偏好和可信摘要仍按 D-10 留给后继合同。真实 Orca execution/handoff 条件检查未启用；本次没有新增 OS IME 人工证据，Windows 未验证。
