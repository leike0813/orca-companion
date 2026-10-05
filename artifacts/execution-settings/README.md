# 执行并发设置：三档捕获与定稿对照

状态日期：2026-10-05。范围：第八批之后新增的「执行设置」入口（命令 /concurrency，命令面板「执行并发设置」）在
120x40 / 80x24 / 50x40 三档的呈现，以及与原定稿弹窗画面的对照。视觉与交互沿用已批准的 #52 final dialog
seam，不新增设计。

## 夹具语义（严格隔离，不接真实授权）

预览用 fake 端口：默认额度 3、当前批准额度 3。改默认额度为 5 并保存后，界面展示「已保存默认值 5」，但
「当前批准额度」保持 3。保存本身不激活执行额度，也不触碰任何授权记录；应用需重新批准。

## 键位与捕获顺序

1. 命令面板（Ctrl+P）→ 搜索 alias concurrency → Enter：打开「执行并发设置」。
2. Backspace 清空 → 输入 5 → Enter：保存默认额度（不授权）。
3. R：进入既有 Execution Authorization 完整审阅入口（复用现流程）。预览的 authorization 端口返回可审阅
   Manifest，但 approve 保持拒绝，因此只捕获审阅画面，不伪造批准。
4. Esc / Esc：逐层返回。

## 三档结果

| 尺寸 | 打开（default） | 保存后（saved） | 关键事实 |
| --- | --- | --- | --- |
| 120x40 | execution-settings-default-120x40.png | execution-settings-saved-120x40.png | 默认 3/批准 3 → 默认 5/批准 3 |
| 80x24 | execution-settings-default-80x24.png | execution-settings-saved-80x24.png | 窄屏字段不裁切 |
| 50x40 | execution-settings-default-50x40.png | execution-settings-saved-50x40.png | 最窄档事实、说明行、notice 与 footer 全部整行可读，无截断 |

每张图配同名 .txt 文本帧；记录见 frames/records.json。

## 文案（精炼后，不改布局）

- 说明行：保存只改默认值；重新批准后应用到当前执行。
- 保存 notice：已保存默认值 5；当前批准额度不变。
- footer：已保存 · R 重新审阅执行额度 · Esc 返回。

此前说明行较长，在 50x40 会被截断成「完整 Ma…」并把内部 Manifest 字样暴露出来；本次仅缩短文案，未改结构、
配色或键位。重捕后 50x40 saved 的第 11、13 行整行显示（见 execution-settings-saved-50x40.txt）。Esc 仍逐层
返回：从设置页按 Esc 关闭 overlay 并恢复 transcript 与 composer 原文。

## 与原定稿对照

- 组件复用 selection-list 的 DialogFrame（圆角边框、accent 标题、dim 摘要与分隔线、footer、反色动作），与
  #52 定稿弹窗同源。对照帧：artifacts/dialog-prototype/final/ 下的 commands / sessions / models /
  authorization-* 三档画面。
- 逐档核对：外边框列位置、标题所在行、分隔线宽度、footer 行与动作层级与 dialog-prototype/final 同尺寸帧一致；
  本次未改布局、层级、配色或返回约定。
- R 之后的完整审阅界面不是新画面：execution-settings-review-*.png 捕获的就是既有 AuthorizationReview
  （概览/权限/预算/工作范围/完整清单分栏、底部动作与「Tab 栏目 · ↑↓ 浏览 · ←→ 动作 · Enter/Esc」），
  与 dialog-prototype/final/authorization-* 及 artifacts/tui-prototype-alignment/repair-20261003/authorization-*-color.png
  同源同布局；本批未改审阅设计，只证明设置页 R 确实进入该现流程。

## 复现

pnpm build && node artifacts/execution-settings/capture.mjs

夹具端口位于 scripts/tui-preview.mjs（executionSettings），仅预览使用；保存只改默认值，不自动授权。
