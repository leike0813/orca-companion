## 1. 集成完成事实

- [x] 1.1 按 IP-01 统一 push OperationId 完成判定并扩展只读快照；运行 `pnpm exec vitest run tests/application/integrate-work-package.test.ts tests/coordination-store.test.ts`。
- [x] 1.2 按 IP-02 修正执行投影、CLI 与依赖 Frontier；运行 `pnpm exec vitest run tests/application/execution-view.test.ts tests/tui/status-json.test.ts tests/application/advance-execution.test.ts`。

## 2. 图补丁工作消费

- [x] 2.1 按 IP-03 持久化已受理图补丁的消息消费标记，拒绝与未知不消费；运行 `pnpm exec vitest run tests/workflow/coordinator-tool-loop.test.ts tests/workflow/coordinator-graph.test.ts`。
- [x] 2.2 按 IP-03 修正前台宿主重启后的待处理工作重建；运行 `pnpm exec vitest run tests/application/actionable-work.test.ts tests/domain/coordinator-session-state.test.ts`。真实运行时测试需隔离项目与专用身份，缺少该环境时记录跳过。

## 3. 收尾验证

- [x] 3.1 按 IP-04 更新合同与 README，运行 `git diff --check`。
- [x] 3.2 按 IP-04 串行运行 `pnpm typecheck && pnpm lint && pnpm test && pnpm build && openspec validate m2-closeout-integration-and-wake --strict && git diff --check`，记录 `verification.md`。
