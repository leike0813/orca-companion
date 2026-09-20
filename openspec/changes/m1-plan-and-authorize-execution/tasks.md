## 1. 规划领域类型与 tracker 读写

- [ ] 1.1 实现 IP-1：规划用例直接复用 `src/domain/coordination/mode.ts` 的 `CoordinationMode` 与 `ControlState`，不得在 planning 下新增同名类型；以 `pnpm exec vitest run tests/application/planning-mode.test.ts` 验证（覆盖 Requirement「Handoff gate, mode transition and execution lease」）
- [ ] 1.2 实现 IP-2：在 `src/domain/planning/route-map.ts` 定义 `RouteMapRef`、`RouteMapSection`、`DecisionTicket`、`PlanningReference` 与 `parseRouteMapSections`，在 `src/domain/planning/ticket-claim.ts` 定义 `TicketClaim` 与 `projectFrontier`；以 `pnpm exec vitest run tests/domain/route-map.test.ts tests/domain/ticket-claim.test.ts` 验证（覆盖 Requirement「Route Map authority and fixed-section updates」、Requirement「Ticket Claim binds a ticket to one Session」）
- [ ] 1.3 实现 IP-3：在 `src/application/planning/route-map-service.ts` 实现 `readRouteMap`、`updateRouteMapSection`、`claimTicket`、`releaseTicket`、`resolveTicket`，先落 Operation Intent 再写 tracker 并读回核验；以 `pnpm exec vitest run tests/application/route-map-service.test.ts` 验证
- [ ] 1.4 实现 IP-4：在 `src/adapters/tracker/gh-tracker.ts` 实现 `readIssue`、`updateIssueBody`、`assignIssue`，经 `gh` CLI 读写并做输出 schema 校验；以 `pnpm exec vitest run tests/adapters/gh-tracker.test.ts` 验证

## 2. 确定性图编译与世代

- [ ] 2.1 实现 IP-5：在 `src/domain/planning/execution-graph.ts` 定义 `ExecutionGraph`、`GraphVersion`、`WorkPackage`，在 `graph-compiler.ts` 与 `budget-policy.ts` 实现确定性编译和上限检查，在 `src/application/planning/graph-history.ts` 实现 `recordInitialGraph`/`loadCurrentGraph`；通过版本化 migration 建立追加历史，以 `pnpm exec vitest run tests/domain/graph-compiler.test.ts tests/domain/budget-policy.test.ts tests/application/graph-history.test.ts` 验证
- [ ] 2.2 实现 IP-5：在 `src/application/planning/graph-generation.ts` 实现 `startGraphGeneration`、`GraphGeneration` 与 `isCandidateStale`，绑定新 GraphId、空 Orca Run 与地图 revision；以 `pnpm exec vitest run tests/application/graph-generation.test.ts` 验证（覆盖 Requirement「Candidate graph binds to one Graph Generation」）

## 3. Manifest 与原子授权

- [ ] 3.1 实现 IP-6：在 `src/domain/planning/execution-authorization.ts` 定义 `ExecutionAuthorizationManifest`、`parseManifest`、`manifestFingerprint` 与全部有限预算默认值（含恢复、实现、Validator 修复、Graph Revision、Specification Revision），在 `authorization-service.ts` 实现批准与读取；后继不得再加预算字段。以 `pnpm exec vitest run tests/domain/execution-authorization.test.ts tests/application/authorization-service.test.ts` 验证
- [ ] 3.2 实现 IP-6：在 `src/application/planning/initialize-scope.ts` 实现 `initializeCoordinationScope`，单事务创建 Scope、Planning Cycle 与首个 Session，且不写 Run、Task、worktree、预算、权限或风险；以 `pnpm exec vitest run tests/application/initialize-scope.test.ts` 验证

## 4. 交接门禁、Lease 与规划责任交接

- [ ] 4.1 实现 IP-7：在 `handoff-gate.ts` 实现门禁，在 `lease-handoff.ts` 只实现 `transitionToExecution` 并组合既有 `lease-service.ts`；不得导出第二个 `acquireExecutionLease`。以 `pnpm exec vitest run tests/application/handoff-gate.test.ts tests/application/lease-handoff.test.ts` 验证
- [ ] 4.2 实现 IP-3：在 `src/application/planning/planning-handoff.ts` 实现 `preparePlanningHandoff`、`reviewPlanningHandoff`、`cutoverPlanningHandoff` 与 `PlanningHandoffProposal`，保证只在 cutover 转移规划责任且不触碰在途 Worker；以 `pnpm exec vitest run tests/application/planning-handoff.test.ts` 验证（覆盖 Requirement「Route Planning session handoff」）
- [ ] 4.3 实现 IP-3：在 `src/application/planning/planning-handoff.ts` 实现 `cancelPlanningHandoff`、`isProposalStale`、`resumePlanningHandoff`、`activationGate` 与 `HandoffActivation`，覆盖取消、过期、崩溃恢复与 `awaiting_user_prompt` 激活门；以 `pnpm exec vitest run tests/application/planning-handoff.test.ts` 验证（覆盖 Requirement「Handoff resilience and activation gate」）

## 5. 规划工具挂载与收口

- [ ] 5.1 实现 IP-8：在 `src/workflow/coordinator/planning-tools.ts` 实现 `planningToolset` 并在 `src/workflow/coordinator/graph.ts` 按模式动态注册，handler 重验 scope、ownership、revision、权限与预算；以 `pnpm exec vitest run tests/workflow/planning-tools.test.ts` 验证
- [ ] 5.2 实现 IP-7：只读核对 `CONTEXT.md` 与 `AGENTS.md` 已由前驱同步为 Coordinator Model Configuration，必要时停止并回到 planning；以 `! rg -n 'Coordinator Profile' CONTEXT.md AGENTS.md` 验证无匹配
- [ ] 5.3 运行 `pnpm typecheck` 与 `pnpm lint`，确认规划模块符合 strict 与既有限制
- [ ] 5.4 运行 `pnpm test` 与 `openspec validate m1-plan-and-authorize-execution --strict`，确认全部 Scenario 证据通过且校验为 strict 有效
- [ ] 5.5 按 implementation-plan 第 1 节复核前驱已归档、主规格已同步、四个冻结接缝仍匹配；不匹配则停止并回到 planning

## 6. 真实 provider 冒烟验收

- [ ] 6.1 实现 IP-9：在 `tests/integration/minimax-m3-planning-smoke.test.ts` 实现 `generateCapsuleSmoke`，用 MiniMax-M3 真实生成一次 Context Capsule，并保证未显式选择隔离项目与专用身份时不执行；以 `PLANNING_SMOKE=1 PLANNING_SMOKE_REPO=<isolated-project> PLANNING_SMOKE_IDENTITY=<dedicated-identity> pnpm exec vitest run tests/integration/minimax-m3-planning-smoke.test.ts --no-file-parallelism` 验证（覆盖 D20）
- [ ] 6.2 实现 IP-9：在同一冒烟中实现 `runPlanningHandoffSmoke`，用真实模型完成一次 prepare→review→cutover 的 Route Planning Handoff 并校验责任落盘与在途 Worker 不受影响；以同一命令验证（覆盖 Requirement「Route Planning session handoff」、D20）
- [ ] 6.3 实现 IP-9：确认跨库故障窗口（checkpoint 与 admission 之间崩溃、tracker 响应丢失、交接中途重启）仍由 `tests/application/planning-handoff.test.ts` 的 fake backend 覆盖，并确认冒烟在未设置 `PLANNING_SMOKE` 时默认跳过、不产生真实调用；以 `pnpm exec vitest run tests/application/planning-handoff.test.ts` 与 `pnpm test` 中该文件被跳过验证（覆盖 D20）
