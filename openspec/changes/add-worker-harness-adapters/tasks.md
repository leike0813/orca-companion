## 1. 端口、注册表与 Codex 回归

- [x] 1.1 按 IP-01 新建 `src/application/ports/worker-harness.ts` 与 `src/bootstrap/worker-harness.ts`，显式注册五个 harness，未注册 id 结构化拒绝；运行 `pnpm exec vitest run --maxWorkers=2 tests/application/worker-harness-registry.test.ts`
- [x] 1.2 按 IP-02 新建 `src/adapters/agents/codex-harness.ts` 并把 `session-binding.ts` 改为逐 harness 校验；运行 `pnpm exec vitest run --maxWorkers=2 tests/adapters/agents/session-binding.test.ts tests/adapters/agents/codex-launch.test.ts`
- [x] 1.3 按 IP-03 替换五个 bootstrap runtime 的 `harness !== 'codex'` 与字面量绑定为 profile.harness 解析；运行 `pnpm exec vitest run --maxWorkers=2 tests/bootstrap/foreground-planning-runtime.test.ts tests/bootstrap/foreground-execution-runtime.test.ts tests/bootstrap/graph-patch-worker.test.ts tests/bootstrap/baseline-reconciliation-runtime.test.ts tests/bootstrap/integration-reconciliation-runtime.test.ts`

## 2. 四个新 harness adapter

- [x] 2.1 按 IP-04 实现 claude adapter（SessionStart hook、exact path、`--session-id`/`--resume`）；运行 `pnpm exec vitest run --maxWorkers=2 tests/adapters/agents/native-worker.test.ts`
- [x] 2.2 按 IP-05 实现 opencode adapter（隔离 XDG、`--standalone` 私有子进程、公开 `GET /api/session` 与 v2 分页消息、原生项目认证）；运行 `pnpm exec vitest run --maxWorkers=2 tests/adapters/agents/opencode-harness.test.ts`
- [x] 2.3 按 IP-06 实现 pi adapter（`session_start` extension、id/path/activebranch）；运行 `pnpm exec vitest run --maxWorkers=2 tests/adapters/agents/native-worker.test.ts`
- [x] 2.4 按 IP-07 实现 omp adapter（extension 等待真实文件、fullpath resume、身份回读）；运行 `pnpm exec vitest run --maxWorkers=2 tests/adapters/agents/native-worker.test.ts`

## 3. 认证与隔离状态

- [x] 3.1 按 IP-08 实现隔离状态根与认证来源（managed env / harness_login 副本），核验全局配置零写入；运行 `pnpm exec vitest run --maxWorkers=2 tests/adapters/agents/native-worker.test.ts tests/adapters/agents/codex-launch.test.ts`

## 4. 只读包装器与 doctor

- [x] 4.1 按 IP-09 新建 `read-only-execution-wrapper.ts` 并让探针与生产共用，核验 coordination.sqlite 拒写；运行 `pnpm exec vitest run --maxWorkers=2 tests/adapters/agents/read-only-execution-wrapper.test.ts`
- [x] 4.2 按 IP-10 改造 doctor 与授权审阅为逐 harness 结论；运行 `pnpm exec vitest run --maxWorkers=2 tests/doctor.test.ts tests/bootstrap/doctor-model-configuration.test.ts`

## 5. 配置与 TUI

- [x] 5.1 按 IP-11 增加 schema 3 additive `nativeWorker`、逐角色 harness 与 `SaveModelSettingsInput.harness` 语义；运行 `pnpm exec vitest run --maxWorkers=2 tests/bootstrap/project-config.test.ts tests/configuration`
- [x] 5.2 按 IP-12 扩展模型设置界面（逐角色 harness/provider、适用字段、遮罩），保持 #52 布局与显式保存；运行 `pnpm exec vitest run --maxWorkers=2 tests/tui`

## 6. 恢复与验证接缝

- [x] 6.1 按 IP-13 把 Recovery/Validator 同会话修复与集成续接切换到注册表 resume/prove，核验原授权固定、unknown 不重复 launch；运行 `pnpm exec vitest run --maxWorkers=2 tests/adapters/agents/validator-continuity.test.ts tests/adapters/agents/utility-worker-recovery.test.ts tests/bootstrap/validation-runtime.test.ts tests/bootstrap/execution-delivery.test.ts`

## 7. 测试与真实隔离验收

- [x] 7.1 按 IP-14 补齐参数化合同与真实回归缺口（精确身份、陈旧观察、缺失/截断历史、迟到首 transcript、unknown 不重复 launch、固定原授权、同会话修复与集成、认证隔离）；运行 §6 矩阵中的定向命令
- [x] 7.2 按 IP-15 在显式隔离的 Orca 项目与专用身份运行四个固定模型的 p-i-v-f、resume/recovery 与混合角色；只在取得真实 usage 时记录费用；运行 `ORCA_COMPANION_REAL_ACCEPTANCE=1 pnpm exec vitest run --maxWorkers=1 --testTimeout=1800000 tests/acceptance/worker-harness-matrix.test.ts`

## 8. 文档、门禁与收口

- [x] 8.1 按 IP-16 同步 `AGENTS.md`、`docs/architecture.md`、`docs/interface-contracts.md` 的 IC-07/08/09/14 与 domain 文档
- [x] 8.2 按 IP-16 更新 `docs/orca-compatibility.md`（四 harness 版本、能力、隔离与只读包装器实测）与 `docs/dev/tui-implementation-handoff.md`（逐角色 harness 画面批次）
- [x] 8.3 按 IP-17 运行 `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`、`git diff --check` 与 `openspec validate add-worker-harness-adapters --strict`，确认无无关文件改动
