## 1. 真实循环核心

- [x] 1.1 IP-01：必填可信配置、唯一重试分类与可取消退避；`pnpm exec vitest run tests/workflow`。
- [x] 1.2 IP-01：持久轮次与共享停止驱动、增量迁移；轮次/存储测试与 `pnpm typecheck`。
- [x] 1.3 IP-02：协调宿主全入口停止、明确恢复、结构化原因；`pnpm exec vitest run tests/bootstrap/foreground-planning-runtime.test.ts`。

## 2. 独立调试与输入

- [x] 2.1 IP-03：四种有界只读工具、路径边界与取消；工具 adapter 测试。
- [x] 2.2 IP-04：XDG 独立会话、配置复用与正式 SDK/debug host；debug-runtime 测试。
- [x] 2.3 IP-05：无 Scope 输入身份与未知提交保护；UI input store/protection 测试。
- [x] 2.4 IP-05/06：共用 conversation、debug shell、stop/retry SSOT、立即退出取消与CLI；`pnpm exec vitest run tests/tui tests/cli`。

## 3. 端到端与交接

- [x] 3.1 IP-06：真实 CLI/PTY/SDK/HTTP-SSE 核心回归与隐藏重试审计；`pnpm build` 和 integration tests。
- [x] 3.2 IP-06：新隔离 MiniMax 有限 smoke 与原型对照，保存实际证据及请求上限结果。
- [x] 3.3 IP-06：更新架构/合同/使用指南/交接/AGENTS；`pnpm typecheck`、`pnpm lint`、`pnpm build`、全量Vitest及严格OpenSpec验证。
