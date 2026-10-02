## Why

首版尚未闭环，用户输入只在 TUI 进程内保留：崩溃、切换 Session、粘贴大段内容或提交后界面刷新都会丢内容，待核验提交也没有稳定身份，重启后无法判断一次提交是否已被受理。同时两个异步 workflow 节点用整份会话快照写回 checkpoint，会覆盖执行期间已受理的新消息。第一批先保护输入本身，作为后续完整编辑与历史读取批次的前置合同。

## What Changes

- 新增 `tui/input-protection`：每仓库独立 `ui.sqlite` 保存聊天与回答草稿、粘贴全文、光标和待核验提交快照；编辑约 250 ms 合并保存，粘贴、切 Session、退出回答与正常退出前立即保存。
- 普通消息与回答提交都携带稳定 `submissionId`；同一 Session 同时只有一条待确认提交，结果只结清原提交快照，不清掉后来输入或另一 Session 草稿。
- 新增只读提交核验查询，区分已受理、未发现、内容冲突与不可核验；回答绑定 InteractionId、expected revision 与 submissionId，问题被他人关闭不证明本次成功。
- 修复 checkpoint 并发覆盖：模型响应与工具结果改为从最新已提交状态追加，不再整份覆盖。
- TUI 以 `/` 开头一律按命令解析，未知或格式错误的命令保留输入；粘贴只插入并立即保存、不触发发送；未保存输入下的 Exit 需明确处理。
- 提供有界输入记录管理入口，支持查看、恢复、选择与删除，并核验既有提交。

## Capabilities

### New Capabilities

- `tui/input-protection`: 用户输入草稿、粘贴载荷与待核验提交的持久化、稳定身份、提交核验、并发冲突与容量管理。

### Modified Capabilities

- `tui/session-interactions`: 每 Session 草稿从进程内改为跨重启持久化，回答绑定增加稳定提交身份。
- `tui/planning-workspace`: composer 严格区分 slash 命令与普通消息，粘贴只插入不发送。
- `tui/execution-control`: 前台 Exit 与 `Ctrl+C` 在存在未保存输入时的处理。
- `coordination/scope-control`: ControllerService 受理普通消息必填 `submissionId`，新增只读提交核验查询。
- `coordinator/session-runtime`: 模型响应与工具结果必须从最新已提交状态追加，防止旧快照覆盖并发受理的消息。

## Impact

直接前驱为已归档的 `tui-debug-workbench-and-ui-migration`；本 change 属于 M2 后的输入保护批次，不扩展执行并发、后台控制或跨平台支持，不实现完整字符/任意位置编辑、粘贴块界面、命令候选与长 transcript 性能改造（留待后续批次）。影响 `src/application/ports/`、`src/application/controller-service.ts`、`src/application/coordination/`、`src/application/coordinator/`、`src/adapters/storage/`、`src/workflow/coordinator/`、`src/interfaces/tui/`、`src/bootstrap/`、`scripts/tui-preview.mjs`、相关测试与 `CONTEXT.md`、`docs/architecture.md`、`docs/interface-contracts.md`、`AGENTS.md`。不新增第三方依赖，不改变领域授权、状态权威或 Orca 合同。
