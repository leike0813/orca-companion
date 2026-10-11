## Why

已归档 `simplify-ledger-lab-lifecycle` 的真实首次启动暴露了模型编辑、对话展示、提交反馈与导航缺陷，回收接口也存在核验与按名称删除之间的竞态。本 change 修复该 verification.md 记录的全部问题，使普通与 debug 路径共享可靠行为。

## What Changes

- 修复手填模型提交，沿 #52 定稿呈现 Coordinator 菜单；支持有来源的推理预设、上下文窗口及输入模态声明，并保存不可变快照。
- 消费真实协议 usage，区分当前精确测量与上次请求用量；配置窗口限制有效输入预算。
- 初始化异步步骤显示真实进度，新注册空会话可读。
- 提交快照落盘后立即清空原草稿、展示待受理消息，保护后续输入。
- 保留原始协议块与续接数据，增加有界可见文本投影；接通真实轮次状态、串行导航、到底跟随及区域鼠标滚轮。
- 远程删除前立即复核原身份、删除后证明原目标缺失才继续本地回收。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `configuration/model-settings`: 不可变模型元数据与协议预设。
- `configuration/provider-catalog`: 搜索与手填分离、目录 metadata 来源。
- `coordinator/session-runtime`: 空历史、有界显示投影与真实轮次观察。
- `coordinator/model-configuration`: 固定协议推理映射。
- `coordinator/context-maintenance`: 模型窗口与真实 usage。
- `tui/planning-workspace`: 文本展示、导航、鼠标与上下文标识。
- `tui/input-protection`: 即时提交投影与后续草稿保护。
- `tui/scope-initialization`: 初始化异步反馈与空会话。
- `agent/debug-harness`: 共用上述行为。
- `testing/ledger-lab-rehearsal`: 删除复核与后置对账。

## Impact

直接前驱为 `openspec/changes/archive/2026-10-10-simplify-ledger-lab-lifecycle`，基线 HEAD `e6203fb43269a49005888daa8bda78735c34907f`。允许与 active lab 并存，共享文件串行编辑；原 lab 完整业务验收保持其独立任务。本 change 涉及 model/config adapters、checkpoint/history、Controller/Bootstrap、TUI 与 cleanup；不加依赖，不提交或归档，不上传附件、不重做原型、不运行付费模型或真实远程删除。
