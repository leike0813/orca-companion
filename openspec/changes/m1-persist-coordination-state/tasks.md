## 1. 领域类型与存储契约

- [ ] 1.1 实现 IP-1：在 `src/domain/coordination/mode.ts`、`leases.ts`、`revision.ts` 定义模式、控制状态、租约类型与 ExpectedRevision，保持控制状态与模式正交；运行 `pnpm typecheck`
- [ ] 1.2 实现 IP-2：在 `src/application/ports/branch-coordination-store.ts` 定义 port，在 `src/adapters/storage/schema.ts` 与 `coordination-store.ts` 实现 schema 版本、迁移、CAS 写入、Session 注册与三项唯一约束；运行 `pnpm test -- tests/coordination-store.test.ts`
- [ ] 1.3 实现 IP-3：在 `src/application/dto/operation-intent.ts` 与 `src/application/coordination/intent-service.ts` 实现意图登记、按 OperationOutcome 收尾与 lane 阻塞；运行 `pnpm test -- tests/operation-intent.test.ts`

## 2. 租约与 CLI 快照

- [ ] 2.1 实现 IP-4：在 `src/application/coordination/lease-service.ts` 实现 Runtime Lease 心跳与接管、fencing generation 推进、Execution Coordination Lease 唯一持有，且过期不释放 claim；运行 `pnpm test -- tests/lease-fencing.test.ts`
- [ ] 2.2 实现 IP-5：在 `src/interfaces/cli/status-command.ts` 与 `src/bootstrap/composition.ts` 实现只读 status 快照与存储失败时的非零退出，并接入 `src/interfaces/cli/main.ts` 分发；运行 `pnpm test -- tests/status-command.test.ts`

## 3. 行为测试

- [ ] 3.1 实现 IP-6：补齐 `tests/coordination-store.test.ts` 覆盖可重建事实被拒、过期 revision 被拒、多表同事务、模式与注册约束；运行 `pnpm test -- tests/coordination-store.test.ts`
- [ ] 3.2 实现 IP-7：补齐 `tests/operation-intent.test.ts` 覆盖意图先于外部调用、重复 ID 拒绝、确定结果收尾、unknown 保留未决与 lane 阻塞；运行 `pnpm test -- tests/operation-intent.test.ts`
- [ ] 3.3 实现 IP-8：补齐 `tests/lease-fencing.test.ts` 用可注入时钟覆盖心跳、过期接管、旧 generation 拒绝、claim 保留与 lease 唯一；运行 `pnpm test -- tests/lease-fencing.test.ts`
- [ ] 3.4 实现 IP-9：补齐 `tests/status-command.test.ts` 覆盖必需字段、只读性、无 TTY、存储不可读与版本不符；运行 `pnpm test -- tests/status-command.test.ts`

## 4. 前驱接缝核对与交付

- [ ] 4.1 核对 IP-1 至 IP-9：确认 `m0-orca-control-baseline` 已 archive、`openspec/specs/` 存在前驱主规格、`ExecutionBackend` 与 `OperationOutcome` 形状与冻结接缝一致；漂移则停止实施并回到规划；运行 `openspec list --specs --json`
- [ ] 4.2 交付核对：运行 `pnpm typecheck && pnpm lint && pnpm test` 并在交付说明中列出修改文件、覆盖的 Requirement/Scenario、命令结果与未决风险
