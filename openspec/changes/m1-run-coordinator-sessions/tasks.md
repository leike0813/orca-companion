## 1. 领域类型、恢复准入与维护 lane

- [ ] 1.1 实现 IP-1：在 `src/domain/coordinator/session-state.ts` 定义 `CoordinatorSessionId`、`CoordinatorSessionState`、`CommittedModelStep`、`threadIdFor` 与 `parseCoordinatorSessionState`，校验拒绝凭据与外部事实字段；以 `pnpm exec vitest run tests/domain/coordinator-session-state.test.ts` 验证（覆盖 Requirement「Coordinator Session checkpoint isolation」、Requirement「Committed model step and durable resumption identity」）
- [ ] 1.2 实现 IP-2：在 `src/application/coordinator/runtime-guard.ts` 实现 `acquireIncarnation`、`assertFencingGeneration`、`resumeIncarnation` 与 `CheckpointUnrecoverableError`，复用前驱 lease 与 fencing 入口并在 checkpoint 不可恢复时阻塞；以 `pnpm exec vitest run tests/application/runtime-guard.test.ts` 验证（覆盖 Requirement「Single live Coordinator Runtime Incarnation」、Requirement「Committed model step and durable resumption identity」）
- [ ] 1.3 实现 IP-3：在 `src/application/coordinator/wake-admission.ts` 实现 `admitWakeBatch` 与 `admissionKeyFor`，并通过 `src/adapters/storage/schema.ts` 的可重入 migration 增加 `wake_admissions`；保证先写 checkpoint、再按 source revision 记 admission，且已提交 batch 不重复注入；以 `pnpm exec vitest run tests/application/wake-admission.test.ts tests/coordination-store.test.ts` 验证（覆盖 Requirement「Resumption requires admitted Actionable Work」）
- [ ] 1.4 实现 IP-4：在 `src/application/coordinator/actionable-work.ts` 实现 `projectActionableWork`，在 `src/application/coordinator/suspension.ts` 实现 `suspendSession` 与 `SuspensionState`；以 `pnpm exec vitest run tests/application/actionable-work.test.ts tests/application/suspension.test.ts` 验证
- [ ] 1.5 实现 IP-4：在 `src/application/coordinator/maintenance-lane.ts` 实现 `planMaintenance`、`runMaintenanceCycle`、`MAINTENANCE_CYCLE_LIMIT`、`yieldForActionableWork` 与 `stopMaintenance`，保证 keepalive 不产生 Wake Batch、Committed Model Step 或 transcript；以 `pnpm exec vitest run tests/application/maintenance-lane.test.ts` 验证（覆盖 Requirement「Suspension and best-effort maintenance lane」）

## 2. Checkpoint 持久化

- [ ] 2.1 实现 IP-5：在 `src/adapters/storage/checkpoint-store.ts` 实现 `openCheckpointStore`、`saveCheckpoint`、`loadCheckpoint`、`readCommittedMessages`，使用独立 `checkpoints.sqlite` 与同步耐久度；以 `pnpm exec vitest run tests/adapters/checkpoint-store.test.ts` 验证
- [ ] 2.2 实现 IP-5：在 `src/adapters/storage/checkpoint-store.ts` 实现 `saveNativeWindowOwner`、`loadNativeWindowOwner`、`savePortableCapsule`、`loadPortableCapsule`，使两类压缩产物分字段保存且互不损坏；以 `pnpm exec vitest run tests/adapters/checkpoint-store.test.ts` 验证（覆盖 Requirement「Bounded model input with separated checkpoint artifacts」）

## 3. Coordinator 模型循环与上下文维护

- [ ] 3.1 实现 IP-6：在 `src/workflow/coordinator/state.ts`、`graph.ts`、`nodes.ts` 组装 StateGraph 与 `modelNode`/`suspendNode`，按 D15 配置有限重试并关闭内层重试；以 `pnpm exec vitest run tests/workflow/coordinator-graph.test.ts` 验证
- [ ] 3.2 实现 IP-6：在 `src/workflow/coordinator/compaction.ts` 实现 `compactWithNativeFirst`、`CompactionPath`、`mechanicalShake` 与 `CompactionOutcome` 的 `compaction_degraded`/`context_exhausted`，在 `src/workflow/coordinator/context.ts` 实现 `carryOpaqueNativeWindow`、`deriveContextCapsule`、`reinjectInstructions`、`reinjectToolSchema`、`reinjectAuthoritativeFacts` 与 `ContextMaintenanceError`；以 `pnpm exec vitest run tests/workflow/compaction.test.ts tests/workflow/context-maintenance.test.ts` 验证（覆盖 Requirement「Native-first compaction with opaque native window and explicit degradation」、Requirement「Context failure fails closed」）

## 4. 模型装配、能力核验、配置切换与启动装配

- [ ] 4.1 实现 IP-7：在 `src/adapters/agents/chat-model-factory.ts` 实现 `resolveChatModel`，从 Coordinator Model Configuration 构造 chat model 实例且不设 allowlist、不保存凭据、不自动 fallback；以 `pnpm exec vitest run tests/adapters/chat-model-factory.test.ts` 验证（覆盖 Requirement「Coordinator Model Configuration injects a verified installed chat model」）
- [ ] 4.2 实现 IP-7：在 `src/adapters/agents/capability-probe.ts` 实现 `verifyModelCapabilities`，覆盖文本、流式、tool calling、取消与 usage；以 `pnpm exec vitest run tests/adapters/capability-probe.test.ts` 验证（覆盖 Requirement「Coordinator Model Configuration injects a verified installed chat model」）
- [ ] 4.3 实现 IP-7：在 `src/application/coordinator/model-config-switch.ts` 实现 `switchModelConfiguration`、`assertSwitchable` 与 `migrateNativeWindowToCapsule`，保证只在 suspended 且无在途操作时切换；以 `pnpm exec vitest run tests/application/model-config-switch.test.ts` 验证（覆盖 Requirement「Model Configuration switches only while suspended」）
- [ ] 4.4 实现 IP-8：扩展 M0 的 `src/bootstrap/doctor.ts` 与 `src/interfaces/cli/doctor-command.ts`，把模型能力检查合并进唯一 `runDoctor`/`DoctorReport`；在 `src/bootstrap/coordinator-runtime.ts` 实现 `startCoordinatorRuntime`，保证核验先于 Session 建立；以 `pnpm exec vitest run tests/doctor.test.ts tests/bootstrap/coordinator-runtime.test.ts` 验证

## 5. 术语迁移与收口检查

- [ ] 5.1 实现 IP-9：把 `CONTEXT.md` 与 `AGENTS.md` 中的 Coordinator Profile 术语同步为 Coordinator Model Configuration，不改动其余内容；以 `! rg -n 'Coordinator Profile' CONTEXT.md AGENTS.md` 验证无匹配
- [ ] 5.2 运行 `pnpm typecheck` 与 `pnpm lint`，确认新增模块符合 strict 与既有限制
- [ ] 5.3 运行 `pnpm test` 与 `openspec validate m1-run-coordinator-sessions --strict`，确认全部 Scenario 证据通过且校验为 strict 有效
- [ ] 5.4 按 implementation-plan 第 1 节复核前驱已归档、主规格已同步、四个冻结接缝仍匹配；不匹配则停止并回到 planning

## 6. 真实 provider 冒烟验收

- [ ] 6.1 实现 IP-10：在 `tests/integration/minimax-m3-coordinator-smoke.test.ts` 实现 `coordinatorSmoke`，用 MiniMax-M3 覆盖 suspend、缩短周期的 keepalive、手动 compact 与 Model Configuration 持久化，并保证未显式选择隔离项目与专用身份时不执行；以 `COORDINATOR_SMOKE=1 COORDINATOR_SMOKE_REPO=<isolated-project> COORDINATOR_SMOKE_IDENTITY=<dedicated-identity> pnpm exec vitest run tests/integration/minimax-m3-coordinator-smoke.test.ts --no-file-parallelism` 验证（覆盖 D19）
- [ ] 6.2 实现 IP-10：在 `collectCacheObservation` 中记录真实 provider 的 prompt cache 命中情况，只写入观测输出、不参与任何断言或失败判定；以 `COORDINATOR_SMOKE=1 COORDINATOR_SMOKE_REPO=<isolated-project> COORDINATOR_SMOKE_IDENTITY=<dedicated-identity> pnpm exec vitest run tests/integration/minimax-m3-coordinator-smoke.test.ts --no-file-parallelism` 验证（覆盖 D19）
- [ ] 6.3 确认冒烟在未设置 `COORDINATOR_SMOKE` 时默认跳过、不产生任何真实调用，并复核其只使用显式选择的隔离项目与专用身份；以 `pnpm test` 中该文件被跳过且无真实调用、`rg -n 'COORDINATOR_SMOKE' tests/integration/minimax-m3-coordinator-smoke.test.ts` 有匹配验证（覆盖 D19）
