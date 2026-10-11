# 修复批 TUI 画面证据

change `repair-ledger-lab-verification-findings`（IP-08 / tasks 4.2）的独立画面证据。两个脚本，不改动任何既有源码、测试或文档：

- `fixture.mjs`：只从 `dist/` 导入生产组件（`ProviderLibraryEditor`、`StartupOnboarding`、`TuiApp`），应用端口来自 `dist/tests/tui/harness.js` 的合成 fake 与本文件的窄替身。协调工作区经公开出口（Ctrl+C / `exit`）卸载并退出进程。
- `capture.mjs`：在真实 PTY（tuistory + ghostty 渲染）里驱动 fixture，采集 120×40、80×24、50×40 三档，每档彩色 + Nerd 与 NO_COLOR + ASCII 两套，产物为本目录下的 `capture-<时间戳>/`：同名 PNG/TXT 与 `manifest.json`。

## 场景与合成条件

| 场景 | 合成条件 | 判定 |
| --- | --- | --- |
| `declare-candidate` | 1 个连接 + 1 个带 effortCapability 与窗口/模态的目录候选；候选选定即保存，随后只确认独立横向 effort | effort 步只有 Model 字段；默认值与显式选择 `medium` 两帧；显式选择「应用选择」后回到模型列表 |
| `declare-manual` | 同一端口，手填 `vendor/manual-model-x`，不发起目录查询，确认后才保存 | 手填步才有上下文窗口、输入模态与 `user_declared` 来源；模态切换帧；保存后回到模型列表 |
| `onboarding-route-create` | 逐项环境核验通过 → wizard → 模型步 → `routeMapInitialization.create()` 永不结算 | Route Map 空闲帧与创建在途的真实 spinner |
| `onboarding-final-busy` | `create()` 返回 #42；确认后 `verify` 只报告三项并保持未决 | 最终确认帧与五项 busy 核验帧 |
| `workspace-running` | `snapshot.sessions[0].turn = running` | 状态栏出现「运行中」段；三档均须出现 |
| `workspace-empty` | transcript 与 reading 端口都返回空页 | 「尚无对话记录」可读 |
| `workspace-pending` | 提交后 `execute` 永不结算 | pending 投影与已分离的原草稿 |
| `workspace-mouse` | 40 条历史 + 未提交草稿，PTY 发送完整 SGR 报告及间隔至少 150ms 的 `ESC[` / 报告体两段 | 两种报告均移动 transcript，协议字节不进入输入；草稿行逐字不变；composer 区域滚轮不改画面；overlay 打开时滚轮不滚动 transcript；Ctrl+C 退出且退出流中含 `?1006l`/`?1000l`（鼠标模式恢复） |

`manifest.json` 记录每张画面的尺寸、cursor 与语义片段检查，每场景的 `conditions`，以及全局 `failures`。片段缺失、等待文本超时、场景异常与 observed 判定不成立都会写入 `failures` 并以非零状态退出：证据不是「记录即通过」。

## 运行

先 `pnpm build`，再在仓库根目录执行：

```sh
node artifacts/ledger-lab/verification-repairs-20261010/capture.mjs
```

试跑可缩小范围（正式采集不设置）：`OCP_CAPTURE_ONLY=workspace-mouse`、`OCP_CAPTURE_SIZES=80x24`。场景失败时仍保存 `FAILURE-*` 帧。

## 证据边界

- 画面是 dist 中生产组件在真实 PTY 中的渲染；应用端口是合成替身，没有真实 Orca、GitHub、provider 凭据或网络调用。
- 呈现对照来源：#52 定稿 DialogFrame/反色动作/横向 effort、#47 above-input composer、#40 continuous transcript、#48 单行核心。自动画面不能替代人工视觉接受。
- 未覆盖：真实 provider 调用与 usage、真实 Orca Run/Task、真实 worker 终端、Windows、IME 人工反馈。
- 平台证据限本机 Ubuntu PTY。

## 状态

最终矩阵：[capture-2026-10-10T15-27-36.878Z](capture-2026-10-10T15-27-36.878Z)。独立审查修复后重新构建并采集，8 场景 × 3 尺寸 × 2 套 = 48 次场景全部通过，`manifest.json` 的 `failures` 为空。每格 19 帧（3+3+2+2+1+1+1+6），共 114 对 PNG/TXT，其中六格均包含分段 SGR 检查。样本文件名一律为「画面-尺寸-色彩-图标」。

[capture-2026-10-10T14-54-53.484Z](capture-2026-10-10T14-54-53.484Z) 是首次完整矩阵：48 场景通过、108 对画面。它早于独立审查修复，仅作过程证据。

以下目录保留但不作为正式证据：

- `capture-2026-10-10T14-39-01.467Z`：48/48 通过，但画面文件名缺少尺寸后缀，三档两套互相覆盖，只剩 50×40 NO_COLOR/ASCII 一套（脚本缺陷运行）。
- `capture-2026-10-10T14-44-07.433Z`：命名修复后的重跑被中断，只有部分文件。
- `capture-2026-10-10T14-50-34.503Z`：重跑再次被中断，且此时合成 `saveModel` 未按生产契约持久化 effort 能力，candidate effort 帧显示「Effort 不适用」。
- `capture-2026-10-10T14-52-52.575Z`：只跑 declare 两场景的 80×24 定向验证，用于确认能力持久化修复（判定通过但不构成矩阵）。
