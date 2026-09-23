## 1. 配置与 Scope 身份

- [x] 1.1 按 IP-01/D1 实现 `orca-companion.json` v1 加载、边界校验与模型/tracker 引用核验；运行 `pnpm exec vitest run tests/bootstrap/project-config.test.ts`。
- [x] 1.2 按 IP-01/D2 追加 IC-03 schema 10、Scope 精确绑定与旧记录显式迁移；运行 `pnpm exec vitest run tests/coordination/scope-binding.test.ts tests/coordination-store.test.ts`。

## 2. 前台运行与用户输入

- [x] 2.1 按 IP-02/D3 建立前台 Session 装配、lease heartbeat/fencing 与 Controller ports；运行 `pnpm exec vitest run tests/bootstrap/foreground-planning-runtime.test.ts tests/bootstrap/coordinator-runtime.test.ts`。
- [x] 2.2 按 IP-03/D4 实现普通消息的稳定提交、WakeBatch 准入与崩溃补齐；运行 `pnpm exec vitest run tests/application/user-message.test.ts tests/application/wake-admission.test.ts`。
- [x] 2.3 按 IP-03/D4 将 Pending Interaction 回答正文与解决状态原子保存；运行 `pnpm exec vitest run tests/application/user-message.test.ts tests/application/controller-service.test.ts`。

## 3. 模型工具闭环

- [x] 3.1 按 IP-04/D6 升级 Session 消息格式、v1 读取迁移与真实 ToolMessage 还原；运行 `pnpm exec vitest run tests/domain/coordinator-session-state.test.ts tests/workflow/context-maintenance.test.ts`。
- [x] 3.2 按 IP-04/D5 接入 model→tools→model、可信 OperationId、逐 call 结果与恢复对账；运行 `pnpm exec vitest run tests/workflow/coordinator-tool-loop.test.ts tests/workflow/planning-tools.test.ts tests/workflow/coordinator-graph.test.ts`。

## 4. 会话维护与交接

- [x] 4.1 按 IP-05/D7 接入 `/compact` 的请求、持久结论、耗尽门及已有模型切换用例；运行 `pnpm exec vitest run tests/application/compact-session.test.ts tests/workflow/context-maintenance.test.ts`。
- [x] 4.2 按 IP-06/D8 用当前 map/plan/Target/Capsule 组装规划交接，失败保留原责任；运行 `pnpm exec vitest run tests/bootstrap/planning-handoff.test.ts tests/application/lease-handoff.test.ts`。

## 5. 事件、合同与门禁

- [x] 5.1 按 IP-07/D9–D10 接入有 Session 归属的事件并同步 IC-03/04/11/12、README 与 M2 前驱/接缝；运行 `pnpm exec vitest run tests/application/controller-events.test.ts tests/tui/session-picker.test.tsx`，核对 M2 的 4.3/4.4 仍未勾选。
- [x] 5.2 按 IP-01–07 运行 `pnpm typecheck && pnpm lint && pnpm test && pnpm build && openspec validate m1-wire-foreground-planning-runtime --strict`；定位所有失败，记录 M2 真实 PTY 验收仍待其 change 完成。
