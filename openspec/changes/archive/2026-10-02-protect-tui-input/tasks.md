## 1. 输入存储与保护模块

- [x] 1.1 IP-01：在 `src/application/ports/ui-input-store.ts` 定义 `UiInputTarget`/`UiPasteBlock`/`UiDraft`/`UiInputValue`/`UiInputRecord`/`UiInputStore` 的 D4 契约（独立 key、`read/list/write/remove`；adapter handle 提供 `close`），并在 `src/adapters/storage/ui-input-store.ts` 用 `node:sqlite` 实现 `orca-companion/ui.sqlite` 的 CAS + tombstone + `bytes` 容量计量；运行 `pnpm typecheck && pnpm exec vitest run tests/adapters/ui-input-store.test.ts`。
- [x] 1.2 IP-01：在 `tests/adapters/ui-input-store.test.ts` 覆盖重启恢复、多目标隔离、CAS 冲突保双方、tombstone 拒旧版本、容量满额保留、`invalidRecords`；运行 `pnpm exec vitest run tests/adapters/ui-input-store.test.ts`。
- [x] 1.3 IP-01：在 `src/interfaces/tui/input/input-protection.ts` 实现保护模块（250 ms 编辑 timer、粘贴/切 Session/退出回答/退出立即保存、slot dirty 保护、lane 状态机、冲突记录、append-only cursor=`text.length`），只经 `UiInputStore` 同步事务读写；运行 `pnpm typecheck && pnpm exec vitest run tests/tui/input-protection.test.tsx`。
- [x] 1.4 IP-01：在 `tests/tui/input-protection.test.tsx`（真实组件行为）覆盖草稿/粘贴载荷恢复、effect 只读不写、载入不覆盖新编辑、连按只一次提交、旧结果不清新输入、rejected 释放 lane；运行 `pnpm exec vitest run tests/tui/input-protection.test.tsx`。
- [x] 1.5 IP-01：新增 `src/interfaces/tui/components/input-record-manager.tsx` 与 `tests/tui/input-record-manager.test.tsx`，实现最多 20 行列表、正文局部有界滚动、恢复/选择/删除与重新核验；运行 `pnpm exec vitest run tests/tui/input-record-manager.test.tsx`。

## 2. 提交核验与 checkpoint 追加（后端 worker）

- [x] 2.1 IP-02：新增 `src/application/coordinator/submission-status.ts` 实现 `SubmissionQuery`/`SubmissionStatus`（消息按 `userEntryId`，回答按 `JSON.stringify([interactionId, submissionId])` 派生 `answerRef`）；运行 `pnpm typecheck && pnpm exec vitest run tests/application/submission-status.test.ts`。
- [x] 2.2 IP-02：改 `src/application/coordination/pending-interaction.ts` 的 `answerRefFor` 由 interaction ID 与 submissionId 共同派生（复用既有列），并同步 `tests/application/controller-service.test.ts`、`tests/application/user-message.test.ts`；运行 `pnpm exec vitest run tests/application/controller-service.test.ts tests/application/user-message.test.ts tests/application/submission-status.test.ts`。
- [x] 2.3 IP-02：在 `src/application/controller-service.ts` 增加 `submission-status` 只读查询，`SendSessionMessageCommand` 必填 `submissionId`，`AnswerPendingInteractionCommand` 增必填 `submissionId`；运行 `pnpm exec vitest run tests/application/controller-service.test.ts`。
- [x] 2.4 IP-02：在 `src/application/coordinator/runtime-guard.ts` 的 `CoordinatorSessionRecordPort` 增加 `appendModelStep`/`appendToolResult`，在 `src/adapters/storage/checkpoint-store.ts` 复用既有最新-core 写入事务实现，并让 `src/workflow/coordinator/nodes.ts`、`src/workflow/coordinator/tool-node.ts` 改用它，保持 `pending.shift` 路由与消费字段不变；运行 `pnpm exec vitest run tests/adapters/checkpoint-store.test.ts tests/workflow/coordinator-tool-loop.test.ts`。

## 3. TUI 接线

- [x] 3.1 IP-03：在 `src/interfaces/tui/ports.ts` 增加 required `inputStore` 与 `submissionStatus` 端口，并在 `src/interfaces/tui/state.ts`/`app.tsx` 接入保护模块的每 Session 草稿读写与 required 端口；运行 `pnpm typecheck && pnpm exec vitest run tests/tui/session-lifecycle.test.tsx tests/tui/no-side-effect.test.tsx`。
- [x] 3.2 IP-03：在 `src/interfaces/tui/app.tsx` 让提交先写完整快照（含 `submissionId` 与 binding）再调用 `ports.execute`，结果只结清原记录；运行 `pnpm exec vitest run tests/tui/input-paths.test.tsx tests/tui/input-protection.test.tsx`。
- [x] 3.3 IP-03：在 composer 路径实现严格 slash 分类（未知/参数/多行错误保留输入、未接通命令明确不可用）与 `usePaste` 只插入即保存（涉及 `src/interfaces/tui/app.tsx`、`components/composer.tsx`），`input/keymap.ts` 与 `Ctrl+A` 回答入口本批不改；运行 `pnpm exec vitest run tests/tui/input-paths.test.tsx tests/tui/workspace.test.tsx`。
- [x] 3.4 IP-03：在 `src/interfaces/tui/app.tsx` 与 `components/control-bar.tsx` 实现退出前保存、失败默认留下与显式丢弃路径；在 `components/command-palette.tsx` 增加 `/inputs` 别名并由 `screens/workspace.tsx` 渲染 overlay；运行 `pnpm exec vitest run tests/tui/exit.test.tsx tests/tui/input-record-manager.test.tsx`。

## 4. 宿主、预览与文档

- [x] 4.1 IP-04：在 `src/bootstrap/tui-composition.ts`、`foreground-planning-runtime.ts` 的 `execute` 与 `tui-entry.ts` 注入 `inputStore`/`submissionStatus`，接收界面生成并随 intent 传入的 `submissionId`（宿主不自己生成）；在启动恢复 lifecycle（非 React effect）清理 accepted pending；运行 `pnpm exec vitest run tests/tui/host-wiring.test.ts tests/bootstrap/foreground-planning-runtime.test.ts tests/bootstrap/foreground-execution-runtime.test.ts tests/bootstrap/coordinator-runtime.test.ts`。
- [x] 4.2 IP-04：更新 `scripts/tui-preview.mjs` 的假端口以支持 required 端口，并补齐 `tests/tui/{harness.ts,pty.test.ts,pty-execution.test.ts,pty-handoff.test.ts}` 与 `tests/bootstrap/{foreground-planning-runtime.test.ts,foreground-execution-runtime.test.ts}` 等必需 fixture；运行 `pnpm build && pnpm exec vitest run tests/tui tests/bootstrap`。
- [x] 4.3 IP-04：更新 `CONTEXT.md`、`docs/architecture.md`、`docs/interface-contracts.md`（登记 IC-13 与 UI 窄端口）与 `AGENTS.md` 的输入存储归属；确认 `doctor` 与无 TTY CLI 不加载 UI；运行 `pnpm lint`。

## 5. 验证与限定审计

- [x] 5.1 IP-05：运行 `pnpm typecheck && pnpm lint && pnpm build && pnpm exec vitest run tests/tui tests/application tests/adapters && openspec validate protect-tui-input --strict && git diff --check`。
- [x] 5.2 IP-05：在隔离 tmux PTY 中检查 120/80/50 列、中文粘贴、退出与终端恢复，并核对界面只有只读 effect、无自动发送、`pending.shift` 与消费字段未变。

## 实施验证记录

- `pnpm typecheck && pnpm lint && pnpm build`：全部通过。
- `pnpm exec vitest run tests/tui tests/application tests/adapters`：69 个文件、622 项测试通过；2 个真实 Orca 测试因未显式开启隔离集成环境而跳过。
- `pnpm exec vitest run tests/application tests/adapters tests/bootstrap tests/workflow`：60 个文件、629 项测试通过。该次运行覆盖宿主重启清理已受理快照、保留未决提交且不自动发送，以及模型/工具追加不覆盖新消息；与上一行有重叠，不累加测试数。
- `openspec validate protect-tui-input --strict`、`git diff --check`：通过。
- `tests/tui/pty.test.ts` 的 11 项检查通过，包含独立 tmux server 中 120/80/50 列中文多行粘贴、resize、退出码与原 PTY 模式恢复。
- IP-03 复用现有 Composer 接口，粘贴与提交保护在 `TuiApp` 接线，无须修改 `components/composer.tsx`。IP-04 的 `tui-entry.ts` 已整体转交端口及生命周期，真实 Orca PTY fixture 也复用生产宿主，无须增加第二份装配。
- 本批未验证 Windows 或生产 Orca 集成；长 transcript 性能与完整编辑仍由后续 change 处理。未创建 `verification.md`，未提交或归档。
