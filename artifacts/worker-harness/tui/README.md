# 逐角色 Harness 与原生连接编辑画面证据

对应 [add-worker-harness-adapters](../../../openspec/changes/add-worker-harness-adapters/implementation-plan.md) 的 IP-12 与 delta spec [tui/planning-workspace](../../../openspec/changes/add-worker-harness-adapters/specs/tui/planning-workspace/spec.md) 的「三档生产画面对照」场景。本轮只重采模型子页，逐票布局仅涉及 #52 dialog final；其余五票的现行证据仍以 [model-configuration](../../model-configuration/README.md) 与 [graph-basis](../../graph-basis/README.md) 等目录为准。

## 真实范围

采集挂载生产 `TuiApp` 与生产 `ModelSettingsEditor`（`scripts/tui-preview.mjs alignment-planning`），使用隔离 fixture 端口；不连接 provider、tracker 或 Orca，不启动开发服务器。

fixture 边界必须与画面一起阅读：

- planner 角色的既有 profile 是 `harness=codex`，连接只有 codex 子集，没有预置 `nativeWorker`；
- preview 的 `modelSettings.save/apply` 端口无条件返回 saved，不做 harness 注册、native 必填字段或 revision 校验；
- 模型目录是静态假数据，不代表已注册 harness 的候选过滤。

因此本目录只证明生产组件的呈现、键位、遮罩与返回，不证明 schema 3 `nativeWorker` 校验、未注册 harness 拒绝、真实 harness 启动、effort 能力来源或执行绑定语义；那些由 change 的应用层/配置测试与真实隔离验收覆盖。自动断言（`checks.json`）也不能代替逐帧视觉验收。

## 采集命令

```sh
pnpm build
node artifacts/worker-harness/tui/capture.mjs frames                          # 全量 12 组合
node artifacts/worker-harness/tui/capture.mjs frames '^120x40-color-nerd$'    # 单组合核验
```

目标目录已有 PNG/TXT 时脚本拒绝写入，确需重采时显式 `FORCE_OVERWRITE=1`。采集前须确认 `pnpm build` 成功。

## 画面清单

[frames/](frames/) 共 147 对 PNG/同名 UTF-8 文本：12 帧 × 12 组合，加 3 张代表组合的连续 resize。完整清单见 [samples.json](frames/samples.json)，逐组合断言见 [checks.json](frames/checks.json)。组合键为 `<120x40|80x24|50x40>-<color|no-color>-<nerd|ascii>`。

| 帧 | 检查点 |
| --- | --- |
| `workspace` | 进入模型页前的普通草稿 `首尾`，光标在字间 |
| `roles` | Model Picker 角色分区（Coordinator / Planning / Execution） |
| `editor-coordinator` | Coordinator 编辑页不出现 Harness 与 native 字段，Codex 字段可见 |
| `editor-cjk` | `连接名称` 追加中文 `中文连接`，混排输入不丢字 |
| `harness-codex` | planner 的 `Harness` 字段聚焦为 `codex`，Codex providerId/baseUrl/wireApi 在列 |
| `native-fields` | 切到 `claude` 后 Codex 字段消失，只出现 native providerId/baseUrl/api |
| `native-filled` | 三个 native 字段已填（`anthropic` / `https://api.anthropic.com` / `anthropic-messages`） |
| `masked-key` | managed 凭据的 API Key 显示 `••••••••`，脚本核验明文字符串不上屏 |
| `saved` | Enter 保存后回到角色列表，顶部提示「已保存新的不可变记录，尚未应用」 |
| `effort` | 角色菜单 Tab 到独立水平 effort 并改值，列表/effort/动作三区仍在 |
| `reapproval` | 应用 Worker profile 打开 Execution Authorization Review，默认动作为返回 |
| `returned-draft` | 逐层 Esc 返回工作区，普通草稿仍为 `首中尾` |
| `resize-native` | 代表组合（120×40 彩色 Nerd）重开编辑页后 80×24 → 50×40 → 120×40 连续 resize |

## 与 #52 定稿的对照

弹窗沿用 #52 dialog final：标题、摘要身份行、内部分隔线、反色当前字段、底部键位提示与「默认返回」。逐角色差异只体现在字段集合：Coordinator 无 Harness/native；Worker 的 `harness=codex` 时保留 Codex 字段；切换到其他已注册 harness 时改显 native providerId/baseUrl/api（claude 的 api 只有 `anthropic-messages`）。三档尺寸、彩色/NO_COLOR、Nerd/ASCII 均已覆盖；Nerd/ASCII 只影响图区字形，弹窗本身两模式一致，可作无色/有色的成对核对。

## 明显不符合原型或无法由本轮画面证明的点

1. fixture 未预置 `nativeWorker`，画面只能从空值开始填 native 字段，不能证明「编辑既有原生角色时回填并保留原生连接」；该行为在 `app.tsx` 回填、由配置/界面测试覆盖。
2. fixture 的角色都带 harness，`Harness` 的空值态 `codex（默认）` 没有出现在画面里。
3. 未注册 harness、native 必填缺失、保存失败与「保存后执行绑定保持不变」的拒绝路径不在画面内：preview 端口无条件成功，只有应用层与配置测试能覆盖。
4. 候选列表（RoleModelMenu）不显示逐角色 harness；本目录使用静态模型目录，无法证明生产候选过滤。生产宿主按角色所选 harness 筛选连接，`tests/tui/host-wiring.test.ts` 核验候选隔离及原生连接应用。
5. 80×24 时字段列表按光标开窗只显示 5 行，`Harness` 行会滚出视窗；核对以左侧标签、反色行与 `n/14` 计数为准，不能按整屏判断字段缺失。
6. 50 列时摘要与字段值按显示宽度截断为 `…`，这是 #52 的窄屏规则；被截断的值不代表缺失，需结合同组合的 120 列画面阅读。
7. `resize-native` 只在代表组合采集，且 tuistory 截图可能带入旧尺寸缓冲帧（见 [TUI 工作台](../../../docs/dev/tui-workbench.md)）；三档静态对照以各自组合的画面为准。
8. `saved` 帧里编辑器已经关闭（实现是保存后逐层返回），「尚未应用」出现在工作区顶部提示而非弹窗正文；`preview/` 是脚本断言修正前的中断残留，`single/` 是 120×40 彩色 Nerd 的单组合核验，二者都不在 `frames/` 计数内。

## 验证边界

脚本断言覆盖：Coordinator 编辑页无 harness/native、非 codex harness 只出现 native 字段、key 明文不上屏、保存独立于应用、effort 区存在、重新授权审阅打开、返回后草稿 `首中尾`。这些断言与 `frames/` 画面都来自隔离 fixture；本轮没有真实 provider、Orca 或 harness 启动证据，也没有用户逐帧验收记录。
