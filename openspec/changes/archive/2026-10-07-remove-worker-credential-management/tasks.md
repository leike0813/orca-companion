## 1. 领域与配置

- [x] 1.1 IP-01：实现 WorkerModelSelection、项目/Manifest4、Worker 独立保存与可信来源核验；运行 `pnpm exec vitest run tests/configuration tests/domain/execution-authorization.test.ts`。

## 2. Worker adapters

- [x] 2.1 IP-02：删除共享 launcher/Codex 的凭据、隔离环境和配置文件管理，保留实际 roots/精确恢复/只读；运行 `pnpm exec vitest run tests/adapters/agents/codex-launch.test.ts tests/adapters/agents/codex-transcript.test.ts tests/adapters/agents/read-only-execution-wrapper.test.ts`。
- [x] 2.2 IP-02：Claude/pi/omp/OpenCode 使用原生环境与逐次参数、精确报告与恢复；运行 `pnpm exec vitest run tests/adapters/agents/native-worker.test.ts tests/adapters/agents/opencode-harness.test.ts`。
- [x] 2.3 IP-02：实现五 harness 原生有界取消模型目录及显式 registry/port；运行 `pnpm exec vitest run tests/adapters/agents/worker-model-catalog.test.ts tests/application/worker-harness-registry.test.ts`。

## 3. 生产接线

- [x] 3.1 IP-03：全部 Worker/Recovery/集成/Finalizer/doctor 接线只传 modelSelection；目录缓存与应用绑定原授权；运行 `pnpm exec vitest run tests/bootstrap`。

## 4. 角色模型界面

- [x] 4.1 IP-04：沿52原型移除 Worker 连接/凭据表单，加入原生 harness/model/effort/未验证手填与取消查询；运行 `pnpm exec vitest run tests/tui/model-settings.test.tsx tests/tui/host-wiring.test.ts`，核验三尺寸返回约定。

## 5. 文档与验证

- [x] 5.1 IP-05：同步当前领域/架构/合同/AGENTS/README/兼容性/TUI交接与preview/acceptance fixtures；`git diff --check`。
- [x] 5.2 IP-05：运行 `pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm test`、`openspec validate remove-worker-credential-management --strict`；完成六项限定审计与实际证据登记，未运行真实隔离矩阵明确skip。
