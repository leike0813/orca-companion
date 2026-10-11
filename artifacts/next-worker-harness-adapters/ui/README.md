# 新 Worker harness IDs：#52 离线核验

2026-10-11；HEAD `1a3eaf7577a3fe62af3e8a35ba5451080ac34e47`，检查的是当时工作区源码（包含并行开发的未提交变更）。仅新建本目录工件，未修改 UI、测试、原型或 native 配置；没有运行服务器、Orca 或模型。

结论：正式注册的 `command-code`、`qwen-code` 共用现有原生 Worker 模型菜单。三档离线布局与 #52 的固定外框、候选/信息分区、独立 effort 和默认返回规则一致；生产 TuiApp 的隔离导航检查通过。这是限定范围的源码/合成画面对照，完整人工视觉接受尚未进行。模型与角色资格由独立[真实矩阵](../ip04-2026-10-11T05-08-24-154Z-7fc1a011-b14e-47d2-8e5a-e550e0635a8d.md)证明。

本轮正式新增 Command Code / Qwen Code。CodeBuddy 未完成生产资格，按 D-01 不注册；历史 captures 中 CodeBuddy 的源码 ID、菜单和导航结论均是采集时的 **provisional** 离线材料，不表示生产支持。所有历史 captures 原样保留。采集脚本已移除 CodeBuddy 输入，并按当前 ID 顺序核验 Command → Qwen、Qwen → Codex；下述最终证据为移除后重新采集。

CodeBuddy 只读权限调查收束：2.164.0 公开 `dontAsk` 会将未预批准动作的 ask 转为 deny，文件 allow 支持带路径 glob，CLI 窄 Orca reporting allow 属于 trusted 来源。这可表达受限原生文件任务，但没有授予通常 coding shell 的非交互能力；读取真实用户配置时已有 allow/hook 也不会因 dontAsk 自动失效，路径规则本身不等同 OS 文件隔离。没有实现或实测此方案，不能用 tiny 文件任务或扩大权限代替完整必要能力。来源为安装包 `dist/web-ui/docs/en%2Fcli%2Fpermission-modes.md` 的 dontAsk 节、`permissions.md` 的路径/规则节，以及 `dist-server/types/node/utils/permission-utils.d.ts`；版本包为 `@tencent-ai/codebuddy-code@2.164.0`。

## 定稿来源

先读 [TUI 交接](../../../docs/dev/tui-implementation-handoff.md)及[六票归档 design D-01/D-04/D-08](../../../openspec/changes/archive/2026-10-03-align-tui-with-approved-prototypes/design.md)。六票源码均已查阅，各看一张代表画面；当前核验只对 #52 的 Worker 模型选择作结论。

| 票 | 最终决议 | 源码及实际查阅画面 |
| --- | --- | --- |
| #40 | [continuous](https://github.com/leike0813/orca-companion/issues/40#issuecomment-5887651544) | `src/interfaces/tui/workspace-prototype.tsx`；`artifacts/tui-prototype/continuous-v2b-80x24.png` |
| #47 | [above-input](https://github.com/leike0813/orca-companion/issues/47#issuecomment-5893619686) | `src/interfaces/tui/composer-prototype.tsx`；`artifacts/composer-prototype/slash-above-all-80x24.png` |
| #51 | [tabs](https://github.com/leike0813/orca-companion/issues/51#issuecomment-5905223127) | `src/interfaces/tui/project-panel-prototype.tsx`；`artifacts/project-panel-prototype/tabs-pending-80x24.png` |
| #48 | [custom-direct](https://github.com/leike0813/orca-companion/issues/48#issuecomment-5911794472) | `src/interfaces/tui/statusline-prototype.tsx`；`artifacts/statusline-prototype/custom-direct/custom-restored-80x24.png` |
| #43 | [adaptive / final](https://github.com/leike0813/orca-companion/issues/43#issuecomment-5909174043) | `src/interfaces/tui/graph-sidebar-prototype.tsx`；`artifacts/dialog-prototype/final/sidebar-nerd-120x40.png` |
| #52 | [dialog final](https://github.com/leike0813/orca-companion/issues/52#issuecomment-5909125813) | `src/interfaces/tui/dialog-prototype.tsx`及 final 源码归档中的同文件；`models-120x40.png`、`planner-model-menu-80x24.png`、`planner-effort-50x40.png` |

[#52 final 索引](../../dialog-prototype/final/README.md)及[source.tar.gz](../../dialog-prototype/final/source.tar.gz)是本地定稿证据；归档只通过 stdout 读取，未解压覆盖。GitHub 链接来自本地已归档决议索引，本轮未重新联网核验评论。

归档 design D-08 的“Worker 角色未接通”是历史状态。当前交接页 2026-10-10 明确：Worker 只选择 harness/native model/effort；目录不可用可手填未验证 exact ID；不出现连接、凭据或任意 options。这里沿用当前合同，不复制旧原型的 Worker provider 编辑。

## 生产证据与结果

事实源：`src/domain/model-configuration.ts:23` 的 IDs 包含 `command-code`、`qwen-code`，不包含 CodeBuddy 或 Grok。`src/interfaces/tui/app.tsx:2525` 从角色当前 harness 查询目录，`:2815` 按同一 ID 列表循环；`components/model-picker.tsx:430` 提供 Worker 菜单，`components/selection-list.tsx:81/121` 提供固定框和反色动作。

| 检查 | 结果及边界 |
| --- | --- |
| 120×40、80×24、50×40 | 每档角色总览及两个新 harness 菜单，共 9 帧；彩色/无色各一套。宽度、高度未越界，无 Worker credential/API Key/baseUrl/options 字段 |
| 信息层级 | 身份摘要、harness/search、候选区、角色信息分界、model/生效对象、独立 effort、区域提示及动作依序显示；两家均用同一生产组件 |
| 长 ID | 80 列生效对象摘要省略；50 列搜索/手填输入行省略，下方完整模型 ID 仍可读，未截掉按钮；不是证明所有任意长度文本都可完整展示 |
| effort | 合成目录没有可信 effort 时显示“不适用”，Tab 从列表直接到动作；未添加虚构 effort 候选 |
| 导航 | 每家在生产 TuiApp（100 列、现有 fake ports）打开当前角色，查询精确 harness；Enter 前进、Tab 到动作；Command 右箭头切到 qwen-code，Qwen 右箭头切到 codex，并查询对应目录 |
| 返回 | 默认返回 Enter 回父 ModelPicker；重开后 Esc 回父层；退出弹窗后原聊天草稿保留。无 save/apply 调用 |
| 动作配色 | 彩色 `.ansi` 的返回按钮带 SGR 7/27 反色；无色仍有当前动作文字。PNG 只转换无色文本，不提供彩色视觉证据 |

最终两 ID 采集：[无色 evidence](capture-no-color-1791695606307/evidence.json)、[彩色 evidence](capture-color-1791695630611/evidence.json)。每套 9 对 `.txt/.ansi`，无色另有 9 张 PNG。代表画面：[80 列 Command](capture-no-color-1791695606307/command-code-menu-80x24.png)、[50 列 Qwen](capture-no-color-1791695606307/qwen-code-menu-50x40.png)、[120 列角色分区](capture-no-color-1791695606307/roles-120x40.png)。两轮各两家导航检查均通过；renderer 的 targeted ESLint 与 `node --check` 通过。

三 ID 历史采集：[无色 evidence](capture-no-color-1791693030660/evidence.json)、[彩色 evidence](capture-color-1791693032174/evidence.json)，各 12 帧与三家导航检查，保留采集时的 provisional 范围。

首轮 `capture-no-color-1791692879532` 未完成：采集驱动在 null effort 时多按一次 Tab，错误期待仍在动作区域；仅修正本目录脚本，UI 未改。该目录保留，不计成功。`capture-no-color-1791692902062` 是较早成功采集；最终结论使用上面两份增强后的 evidence。

既有 focused tests：`pnpm exec vitest run --maxWorkers=1 tests/tui/model-settings.test.tsx tests/tui/session-lifecycle.test.tsx`，2 文件 / 20 项通过，覆盖目录取消/迟到结果、手填 null effort、会话及模型准入。日志另存 [focused-tests-20261011.log](focused-tests-20261011.log)。采集脚本 `node --check` 通过。

## 复现及剩余缺口

运行 [offline-model-dialog.mjs](offline-model-dialog.mjs)：

```sh
NO_COLOR=1 FORCE_COLOR=0 node artifacts/next-worker-harness-adapters/ui/offline-model-dialog.mjs no-color
env -u NO_COLOR FORCE_COLOR=1 node artifacts/next-worker-harness-adapters/ui/offline-model-dialog.mjs color
```

脚本读取当前生产 TS/TSX，通过已安装 TypeScript 转译及现有隔离 TUI harness 渲染，写入本目录新的时间戳目录。没有 native 目录查询；`offline-fixture` 和模型 ID 都是明确的合成输入。PNG 使用已有终端图片依赖，不安装依赖。

尚未证明：两家真实目录响应/错误、真实保存及 Manifest 审阅应用、native TTY/IME/字体与跨平台、阅读锚点保持、连续 resize。导航仅在 100 列执行；其余尺寸是组件静态渲染。手填的 Qwen 画面证明显示方式，未单独验证其应用行为。现有通用测试通过不等于每家真实模型资格或整体六票视觉接受；本轮未发现需要改 UI 的新 ID 专属问题。

检查结束时源文件 SHA-256（用于区分并行修改，非运行时门禁）：

```text
7639a564efa5a6783cd988cf9561f95305da63f5c42de0e5b067d7b5e62ffebc  src/domain/model-configuration.ts
04627067428db6f1b1d175f1aa2fa644c8f0fefbff0b503ac4beebaa4dda0ee2  src/interfaces/tui/components/model-picker.tsx
79136ea6d6128973cf835b91b6675ee92887cd8e6ab1c327c04672db49433e81  src/interfaces/tui/components/selection-list.tsx
46790576dcdbbfd4e1a4a8cc9f7a12ae8681d2c4342b75698f00996106ab7a8e  src/interfaces/tui/app.tsx
cde193c168a898a7c6da029dc0316349cd23c0318fa60ca8ff9925bca8799c90  tests/tui/harness.ts
cafcdb77fa9b4a477e35ca8ae1b8fe3dbc1a21805eb141df305c38d7745452ad  artifacts/dialog-prototype/final/source.tar.gz
```
