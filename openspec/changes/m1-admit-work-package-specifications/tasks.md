## 1. 基线与前驱接缝核验

- [ ] 1.1 核验直接前驱已归档且主规格存在：运行 `openspec list --json` 确认 active 列表不含 `m1-plan-and-authorize-execution`，检查其 archive 快照，并运行 `openspec list --specs --json`；任一接缝漂移即停止并回到规划（IP-A1）
- [ ] 1.2 核对规划提交 `cd29e2bcd8b0278d34ae19db64cb8ebdaf149279` 与实施 HEAD 的差异不涉及接缝文件；运行 `git diff --stat cd29e2bcd8b0278d34ae19db64cb8ebdaf149279 -- src/domain src/application src/adapters`（IP-A1）

## 2. 领域判定规则

- [ ] 2.1 实现 IP-A1 的 `evaluateDispatchCandidate` 纯函数与 `DispatchCandidateDecision` 判别联合；运行 `pnpm vitest run tests/domain/dispatch-candidate.test.ts`
- [ ] 2.2 实现 IP-A3 的 Task Envelope 与四种 Worker 报告领域类型，以及证据失效判定；运行 `pnpm vitest run tests/application/worker-report-dto.test.ts`
- [ ] 2.3 实现 IP-A5 的三值 liveness、可核验终态与 Session Segment migration；断言 Segment 可在重启后读取且不生成 Capsule、不创建替代 segment、不记录 Recovery Budget；运行 `pnpm exec vitest run tests/domain/worker-liveness.test.ts tests/coordination-store.test.ts`

## 3. 应用用例与边界校验

- [ ] 3.1 实现 IP-A2 的物化用例，含 worktree 复用、Operation Intent 顺序与 unknown 对账；运行 `pnpm vitest run tests/application/materialize-work-package.test.ts`
- [ ] 3.2 实现 IP-A3 的运行时 schema 校验入口，丢弃模型填写的 scope、身份、Run、consumer generation 与 operation identity 字段；运行 `pnpm vitest run tests/application/worker-report-dto.test.ts`
- [ ] 3.3 在 `src/application/ports/specification-provider.ts` 定义 IP-A4 的唯一新 port，并实现确定性接纳检查与内容摘要绑定的 Spec Binding；运行 `pnpm exec vitest run tests/application/specification-admission.test.ts`

## 4. Adapter 实现

- [ ] 4.1 实现 IP-A4 的 OpenSpec `SpecificationProvider`，读取 worktree 内的工具原生规格与角色特定工件转换；运行 `pnpm vitest run tests/application/specification-admission.test.ts`
- [ ] 4.2 实现 IP-A5 的 Codex Session Binding 与 transcript 引用，覆盖 Specification Planner、Implementation、Validator、Finalizer 及不可用阻塞路径；运行 `pnpm vitest run tests/adapters/agents/session-binding.test.ts`
- [ ] 4.3 实现 IP-A6：修改既有 `operation-catalog.ts`、`orca-backend.ts` 与 `execution-backend.ts`，新增 worktree 建立操作并复用已登记的 `task-create`/`worker-start`；运行 `pnpm exec vitest run tests/adapters/orca-cli/orca-backend.test.ts`

## 5. 全部检查与交接

- [ ] 5.1 运行全量检查并确认无回归；运行 `pnpm typecheck && pnpm lint && pnpm test`
- [ ] 5.2 固定实现 HEAD 并整理修改文件清单、覆盖的 Requirement/Scenario 与偏差，交给验收 Agent；运行 `git status --short` 与 `git rev-parse HEAD`
