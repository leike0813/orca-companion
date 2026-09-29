# Implementation Plan

## 1. 实施基线与权威来源

- 模式：`predecessor-contract`。规划 HEAD：`013c83047247a1dcde3b1e7ce2a6aabc8d51932a`。
- 直接前驱：归档 `2026-09-29-m2-deliver-execution-tui`。实施前确认其归档目录、`openspec/specs/tui/execution-monitoring/spec.md`、`src/application/execution/execution-view.ts`、`src/bootstrap/foreground-planning-runtime.ts` 和 `src/workflow/coordinator/tool-node.ts` 仍与 D1–D3 所述接缝一致；漂移则更新本计划。
- 权威：Git 集成结论来自 Branch Coordination Store 的 Operation Intent 和 Git 读回；用户消息及工具结果来自 Session checkpoint。`docs/interface-contracts.md` IC-03/04/08/12 与 `docs/architecture.md` MOD-02/03/07 是固定边界。

## 2. 复用与接缝

| IP-ID | 现有或前驱文件与符号 | 复用方式 | 禁止复制的事实 |
|---|---|---|---|
| IP-01 | `integrateWorkPackage`、`integrationOperationIdsFor`、`buildSnapshot` | 复用原三步 OperationId 与同一批 intent 行，完成边界只看 push | 不建第二份集成状态表 |
| IP-02 | `deriveExecutionFacts`、`executionDerivation`、`buildStatusSnapshot` | 由 D1 的完成引用推导 TUI/CLI/调度 | 不以 Baseline Adoption 冒充正常集成 |
| IP-03 | `createToolsNode`、`pendingWorkFor`、checkpoint parser | 工具结果落盘后标记该条单次工作已处理 | 不用模型文案或内存标记恢复 |

## 3. 代码变更映射

| IP-ID | Task | Requirement/Scenario | 文件与符号 | 精确变化 | 不得改变 |
|---|---|---|---|---|---|
| IP-01 | 完成边界 | 完整集成以获批目标的推送结算为界／两个 Scenario；D1/D2 | `src/application/integrate-work-package.ts`、`src/application/ports/branch-coordination-store.ts`、`src/adapters/storage/coordination-store.ts`、`src/bootstrap/foreground-planning-runtime.ts`、`tests/bootstrap/{foreground-execution-runtime,execution-finalizer}.test.ts` | 共用稳定 ID；快照提供已接受 Git 意图；宿主只以当前包的 push 意图判断完成；Finalizer 夹具沿用生产 ID | ID 格式、Git 副作用顺序、unknown lane |
| IP-02 | 投影一致 | 集成投影与执行完成事实一致／两个 Scenario；D2 | `src/application/execution/execution-view.ts`、`tests/application/execution-view.test.ts` | 完整 push 后 accepted；部分步骤仍 waiting；既有 CLI/TUI/派发调用方共用快照 | liveness 与 Finalizer Verdict 边界 |
| IP-03 | 消息消费 | 已受理的单次图补丁声明只处理一次／两个 Scenario；D3 | `src/workflow/coordinator/{tool-definition,execution-tools,tool-node,state}.ts`、`src/domain/coordinator/session-state.ts`、`src/application/coordinator/actionable-work.ts`、`src/bootstrap/foreground-planning-runtime.ts`、`tests/workflow/coordinator-tool-loop.test.ts`、`tests/application/actionable-work.test.ts`、`tests/domain/coordinator-session-state.test.ts` | 受理且结果落盘才消费精确工作源，重启读标记；拒绝/未知保留 | 其它工具语义与 Wake Batch 身份 |
| IP-04 | 合同与门禁 | 上述全部；D4 | `docs/interface-contracts.md`、`README.md`、本 change 的 `tasks.md`/`verification.md` | 记录快照/消息字段与 M2 状态，运行门禁 | 不声明 Windows/后台支持 |

## 4. 调用与副作用顺序

1. 集成：Validator 已接受 → 授权/lease/expected HEAD 核验 → 已存在步骤按原 ID 回读 → 缺失步骤按 commit、merge、push 顺序执行 → push intent settled/accepted 后才投影完成。失败仍走既有 rejected/unknown/lane 路径。
2. 快照：一次读取 Scope 意图 → 分出未决与已接受 Git 记录 → 根据当前 Graph Generation、WorkPackageId 的 push ID 派生完成引用 → Controller 与 CLI 投影；不可读不显示 accepted。
3. 图补丁：模型提交可信 call → 工具执行并确认 `ok` → 同一 checkpoint 提交工具结果和完成标记 → 当前工作从本次图调用退出；重启从已提交标记重建队列。`rejected` 保留工作，`unknown` 保留未配对 call 并阻塞原身份。

## 5. Schema、状态与持久化落实

- `CoordinationSnapshot` 增加只读已接受 Git 意图切片，来源仍是现有 `operation_intents` 表；没有 migration 或新写入口。
- `CommittedMessageEntry` 的 tool 记录增加可选完成标记；解析器闭集校验，旧 checkpoint 无字段仍有效。
- Scope/Graph/Run/授权、预算、OperationId、Git 目标和消息提交身份均不变。错误按现有三值与 checkpoint 失败关闭处理。

## 6. 验收证据矩阵

| Requirement/Scenario | IP-ID | 测试文件 | Fixture/前置条件 | 关键断言 | 可运行命令 |
|---|---|---|---|---|---|
| 完整集成／commit 后中断、推送结算完成 | IP-01 | `tests/application/integrate-work-package.test.ts`、`tests/application/execution-view.test.ts`、`tests/bootstrap/execution-finalizer.test.ts` | 同包 commit/merge/push 意图 | 前两步不算完成，push 算完成并允许 Finalizer | `pnpm exec vitest run tests/application/integrate-work-package.test.ts tests/application/execution-view.test.ts tests/bootstrap/execution-finalizer.test.ts` |
| 集成投影／部分步骤、完整完成 | IP-02 | `tests/application/execution-view.test.ts`、`tests/tui/status-json.test.ts` | 验证通过、依赖节点与不同包意图 | 状态/queue/依赖正确 | `pnpm exec vitest run tests/application/execution-view.test.ts tests/tui/status-json.test.ts` |
| 图补丁消息／受理中断、拒绝未知 | IP-03 | `tests/workflow/coordinator-tool-loop.test.ts`、`tests/application/actionable-work.test.ts`、`tests/domain/coordinator-session-state.test.ts` | fake model/tool、checkpoint 解析与历史重建 | 受理不重提，拒绝/unknown 保留 | `pnpm exec vitest run tests/workflow/coordinator-tool-loop.test.ts tests/application/actionable-work.test.ts tests/domain/coordinator-session-state.test.ts` |
| 全部门禁 | IP-04 | 本 change `verification.md` | 当前工作区 | typecheck、lint、test、build、strict、diff check | `pnpm typecheck && pnpm lint && pnpm test && pnpm build && openspec validate m2-closeout-integration-and-wake --strict && git diff --check` |

## 7. 文件清单与升级条件

仅修改 §3 所列生产、测试、文档文件；新增本 change 的增量规格和验收记录。若发现必须更改旧 OperationId、持久表或 Orca 私有接口，先回到 design/specs 重新定案。

## 8. 验收 Agent 授权与限定审计

按上述文件与三个行为边界验收；特别核对未完成 push 不触发 Finalizer、tool result 落盘前中断不消费消息、CLI 无 TTY 行为不变。真实集成仅在明确隔离项目与专用 Orca 身份运行。
