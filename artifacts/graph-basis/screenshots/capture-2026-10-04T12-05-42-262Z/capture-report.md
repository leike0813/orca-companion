# IP05 Graph Basis 画面采集

状态：完成，`node artifacts/graph-basis/capture.mjs` exit 0。

- 覆盖：120×40、80×24、50×40 × color、NO_COLOR × Nerd、ASCII，共 12/12 组合。
- 产物：216 对 PNG/PTY 文本、216 条样本记录、144 条操作记录；语义失败 0。
- 操作：工作区、slash 候选采用/执行、Command Palette 与图标选择、项目总览/待答/事件、Inspector、全代际目录及翻页、原计划与 Route Map 正文、80→50→120 resize、逐层 Esc 返回。
- 运行边界：生产 TuiApp 与 GraphBasisService；fake ports、临时 SQLite、临时 OpenSpec 目录和内存 UI store。fixture 不证明真实 Worker/Orca 执行或业务状态。
- 独立真实 PTY h 未通过：旧 Finalizer 测试脚手架假设 project details 单页，与 5A/7 批准的有界分页契约不一致；主会话正在修复脚手架。本 capture 矩阵不覆盖此项，也不能抵销其失败。
- Orca 1.4.218 `worker-show` 的 `agentTerminalHandle` 字段漂移由主会话处理，等待 operation-catalog 范围确认；本画面任务没有调用 Orca。

六票逐项视觉判断与前驱内容态证据见 [`prototype-review.md`](../../prototype-review.md)。样本、操作和完整文本分别见 `samples.json`、`operations.json` 与同名 `.txt`。
