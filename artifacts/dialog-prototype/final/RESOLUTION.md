## Resolution — 用户接受临时弹窗与执行图信息原型

2026-09-30，用户明确确认：“可以了，我觉得这张原型票可以结票了。请务必保存好源码和最终确定的样例，避免最后实现的时候又重新摸索”。据此结清“对比临时弹窗的选择、审阅与返回原型”。

确认的设计：

- 会话/选择子页保留身份摘要，选择区与信息区有明确分界；命令父目录使用左名称、右对齐短说明的紧凑列表。
- 模型配置页区分当前会话 Coordinator、Planning、Execution，每个 Worker 角色有独立选择器。角色页显示 provider/model/effort；模型菜单候选只有 provider/model，下方横向 effort 只列支持的选项。
- 所有动作按钮的当前选项采用反色色块，默认返回；授权、交接和 Cancel 使用字段分栏、信息栏目和有界滚动，交接先选接收方。Esc 逐层返回并保留原会话、草稿、滚动及调用位置。
- 联动 [对比执行图侧栏的分层视觉原型](https://github.com/leike0813/orca-companion/issues/43)：节点信息以分区卡片展示；全屏检查比侧栏更详细，包含依赖名称、执行依据、工作范围及完整身份。
- 图节点默认使用 Nerd Fonts Material 图标；动画复用现有 @inkjs/ui，保留 ASCII 图标、动画和连线回退。侧栏底部以普通文字提示；Ctrl+P → 选项 → ASCII 即时切换侧栏和全屏图，独立图原型按 O。图标使用单字形与间距，不采用括号扩框或跨字符点阵拼图。

**已保存的定稿资产**（相对于当前项目根目录）：

- `artifacts/dialog-prototype/final/README.md`：已确认的规则、运行/操作路径、样例索引、源码入口、恢复方法及正式合同缺口。
- `artifacts/dialog-prototype/final/source.tar.gz`：独立源码副本，保存完整 src/scripts、依赖清单及锁文件、工具配置、领域/架构/接口文档和采集入口，避免后续改动丢失这次定稿。
- 同目录 `source-files.txt`、`provenance.json`：源码清单、基线 HEAD、Node/pnpm 版本、保存时间与默认/回退模式。
- 同目录 84 组最终 PNG/同名终端文本，覆盖 120×40、80×24、50×40；`samples.json` 是完整清单。包含四类弹窗、模型/独立 effort、各审阅栏目、反色按钮、Nerd Fonts/ASCII 的侧栏及全屏图、图标选项和独立图入口。
- `artifacts/dialog-prototype/capture-final.mjs`：最终样例采集脚本，使用已安装 tuistory 与 ghostty-opentui，不运行完整行为测试集。
- 原始可操作源码仍位于 `src/interfaces/tui/dialog-prototype.tsx`、`project-panel-prototype.tsx`、`graph-sidebar-prototype.tsx`、`theme.ts`；工作台入口为 `scripts/tui-preview.mjs`。早期比较图保留，但后续实现应从 final 索引进入。

复现：交互式终端运行 `pnpm ui:dialog-prototype planning` 或 `execution`；独立图为 `pnpm ui:graph-prototype execution adaptive`。默认 Nerd Fonts，启动时可用 `ORCA_COMPANION_TUI_ICONS=ascii` 显式回退。

定稿保存时当前源码 `pnpm build` 成功，并完成真实 PTY 画面采集；代表 PNG 已人工查看。此前完整 PTY/lint 结果保留在原型说明，但不作为最后图标改动的复验。本次按用户此前要求，没有重跑完整验证集。

**远端可访问性：源码、归档和样例只在本机工作区，未提交或上传；GitHub 可访问本决议和路径说明，不能直接下载本机资产。** 不修改 Git 历史、切换分支或提交代码；归档保留这次实际未提交源码。

视觉与交互已裁决；本票不连接真实模型、Worker、Orca、tracker、数据库或 Git 副作用。可信 provider/model/effort 能力、独立 effort 保存、按阶段/角色的 Worker Profile、语义化授权/交接投影、图标偏好 owner/持久化及异步 unknown/恢复仍由 [制定 TUI 分批落地与验收顺序](https://github.com/leike0813/orca-companion/issues/46) 补齐；具体输入和命令分工仍由相应决策票处理。后续实现直接沿用定稿，不重开已确认的视觉比较。
