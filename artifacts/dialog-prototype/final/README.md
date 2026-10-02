# 临时弹窗原型定稿

2026-09-30，用户确认“可以了，我觉得这张原型票可以结票了”，并要求保存源码和最终确定的样例。对应 [对比临时弹窗的选择、审阅与返回原型](https://github.com/leike0813/orca-companion/issues/52)，联动 [对比执行图侧栏的分层视觉原型](https://github.com/leike0813/orca-companion/issues/43)。后续实现以本目录的样例及源码归档为参照。

## 已确认的设计

| 区域 | 定稿规则 |
| --- | --- |
| 会话与选择子页 | 保留身份摘要；候选选择区与信息区用明确分界隔开。取消、Esc 与逐层返回保留原会话、草稿、滚动及调用位置 |
| 命令父目录 | 紧凑列表；左侧名称，右侧短说明，说明右对齐 |
| 模型配置页 | 当前会话 Coordinator 单列；Planning 与 Execution 分区，每个 Worker 角色各有选择器，显示当前 provider/model/effort |
| 模型菜单 | 候选列表只显示 provider/model；下方独立横向 effort，仅列当前模型支持的选项。Tab 切区域，方向键选择，Enter 前进或应用，Esc 丢弃草稿 |
| 动作按钮 | 当前按钮使用反色色块，包含返回、应用、授权、交接、停止项目和退出；默认选中返回。无色环境保留当前动作说明 |
| 授权、交接与取消 | 分栏字段审阅，区分概览、权限/责任、预算、范围及完整身份；交接先选择接收方。内容有界滚动，确认通过各自意图端口 |
| 图节点信息 | 侧栏使用分区卡片：标题、状态/Worker、依赖关系。全屏增加依赖名称、角色/尝试/工作区/验证/集成、工作范围和节点/图版本/代际/baseline |
| 图标 | 默认 Nerd Fonts Material 图标，单字形且后留间距；动画复用现有 `@inkjs/ui`。保留 ASCII 图标、动画和画布连线；不使用括号扩框或跨字符点阵拼图 |
| 图标选项 | 侧栏底部提示“图标异常？选项切ASCII”。`Ctrl+P → 选项 → ASCII` 即时切换侧栏及全屏图；独立图原型按 `O`。选择保留到本次预览退出，不随会话或场景切换重置 |

## 源码与复现

运行当前工作区：

```sh
pnpm ui:dialog-prototype planning
pnpm ui:dialog-prototype execution
pnpm ui:graph-prototype execution adaptive
```

场景还有 `blocked`、`answer`、`idle`。需要从启动就使用回退时：

```sh
ORCA_COMPANION_TUI_ICONS=ascii pnpm ui:dialog-prototype execution
```

源码入口：

- [弹窗与角色模型菜单](../../../src/interfaces/tui/dialog-prototype.tsx)
- [共享图形、节点卡片与独立图选项](../../../src/interfaces/tui/graph-sidebar-prototype.tsx)
- [工作台导航及共享图标选择状态](../../../src/interfaces/tui/project-panel-prototype.tsx)
- [Nerd Fonts/ASCII 字形与动画映射](../../../src/interfaces/tui/theme.ts)
- [假数据与启动入口](../../../scripts/tui-preview.mjs)

[source.tar.gz](source.tar.gz) 保存定稿时完整 `src/`、`scripts/`、依赖清单/锁文件、TypeScript 与 lint 配置、领域/架构/接口文档、工作台说明及采集脚本。它是独立源码副本，后续修改原型不会改写这份归档。[source-files.txt](source-files.txt) 列出内容，[provenance.json](provenance.json) 记录基线、工具版本与保存时间。需要恢复时在独立空目录解压，按归档的 packageManager 和 lockfile 安装依赖，再构建运行；不要覆盖已有工作区。

## 最终样例

每张 PNG 都有同名 `.txt`；[samples.json](samples.json) 记录所有样例及终端尺寸。截图是当前源码在真实 PTY 的最终画面，PNG 使用 ghostty-opentui 自带的 JetBrainsMono Nerd Font 与中文后备字体绘制；字体视觉细节可能与实际终端字体不同。50 列的默认侧栏按响应式规则折叠，完整图通过检查页查看。

| 样例 | 120×40 | 80×24 | 50×40 |
| --- | --- | --- | --- |
| 命令目录 | [PNG](commands-120x40.png) | [PNG](commands-80x24.png) | [PNG](commands-50x40.png) |
| 会话摘要 | [PNG](sessions-120x40.png) | [PNG](sessions-80x24.png) | [PNG](sessions-50x40.png) |
| 阶段与角色模型 | [PNG](models-120x40.png) | [PNG](models-80x24.png) | [PNG](models-50x40.png) |
| 模型候选 | [PNG](planner-model-menu-120x40.png) | [PNG](planner-model-menu-80x24.png) | [PNG](planner-model-menu-50x40.png) |
| 独立 effort | [PNG](planner-effort-120x40.png) | [PNG](planner-effort-80x24.png) | [PNG](planner-effort-50x40.png) |
| 执行授权 | [PNG](authorization-overview-120x40.png) | [PNG](authorization-overview-80x24.png) | [PNG](authorization-overview-50x40.png) |
| 规划交接 | [PNG](handoff-overview-120x40.png) | [PNG](handoff-overview-80x24.png) | [PNG](handoff-overview-50x40.png) |
| 反色确认按钮 | [PNG](cancel-confirm-120x40.png) | [PNG](cancel-confirm-80x24.png) | [PNG](cancel-confirm-50x40.png) |
| 图标选项 | [PNG](options-ascii-120x40.png) | [PNG](options-ascii-80x24.png) | [PNG](options-ascii-50x40.png) |
| Nerd Fonts 侧栏 | [PNG](sidebar-nerd-120x40.png) | [PNG](sidebar-nerd-80x24.png) | [折叠画面](sidebar-nerd-50x40.png) |
| ASCII 侧栏 | [PNG](sidebar-ascii-120x40.png) | [PNG](sidebar-ascii-80x24.png) | [折叠画面](sidebar-ascii-50x40.png) |
| 全屏执行依据 | [PNG](inspector-evidence-nerd-120x40.png) | [PNG](inspector-evidence-nerd-80x24.png) | [PNG](inspector-evidence-nerd-50x40.png) |
| 全屏工作范围 | [PNG](inspector-scope-nerd-120x40.png) | [PNG](inspector-scope-nerd-80x24.png) | [PNG](inspector-scope-nerd-50x40.png) |
| 全屏完整身份 | [PNG](inspector-identity-nerd-120x40.png) | [PNG](inspector-identity-nerd-80x24.png) | [PNG](inspector-identity-nerd-50x40.png) |
| ASCII 全屏图 | [PNG](inspector-ascii-120x40.png) | [PNG](inspector-ascii-80x24.png) | [PNG](inspector-ascii-50x40.png) |

目录另存授权的权限/预算/范围/完整清单、交接接收方/责任/绑定依据、取消范围/身份、退出及独立图原型的两种图标与选项画面。

重新采集当前工作区：

```sh
pnpm build
node artifacts/dialog-prototype/capture-final.mjs
```

采集会更新本目录同名样例；要留存本次用户确认的版本，应先复制目录或从独立源码归档恢复再采集。采集脚本不运行完整行为测试集。

## 实施时直接沿用与需要补齐的部分

沿用本次用户已裁决的信息组织、视觉规则、操作路径、图标默认与回退。正式实现应从以上原型提取界面规则，不重新发起同一轮视觉探索。合同缺口详见 [原型说明](../README.md#正式实现需要补齐的合同)，由后续实施规划解决：可信模型能力及独立 effort、按阶段/角色的 Worker Profile、语义化授权/交接投影、图标偏好的正式 owner 与持久化、共享命令准入，以及 unknown/迟到响应/恢复。

原型为固定假数据与内存状态，不连接真实协调副作用。定稿采集以当前源码构建为前提；完整 PTY、lint 等结果见此前修订记录，不能当作最后图标改动的复验结果。本次没有重跑完整测试集。

源码、归档、PNG 与文本保存在本机工作区；尚未提交或上传，GitHub 只能访问结票决议和路径说明。
