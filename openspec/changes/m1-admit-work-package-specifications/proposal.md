## Why

M1 的执行闭环在获得授权后立刻要回答两个问题：新的 Work Package 何时、以什么前置条件变成真实可派发的 Worker 工作，以及 Planner 写出的规格凭什么被接纳。这两个答案目前只存在于对话与 AGENTS.md 的散落规则里，没有可核验的行为契约。本 change 把它们冻结成规格与接缝，让后面的交付与验证 change 不必再猜物化时机、契约字段和 harness 会话身份。

## What Changes

- 新增 Work Package admission 行为：Work Package 只有在进入 Execution Frontier 且被选为当前 Dispatch Candidate 时才建立并核验 worktree，随即物化恰好一个角色级 Orca Task；物化失败不留下半个 Task。
- 新增 Specification Admission 行为：Specification Planner Worker 在 Work Package 的 worktree 内以工具原生格式编写 Specification Unit，由确定性检查接纳并记录指向确切内容快照的 Spec Binding；可选 Specification Validator 作为独立质量门。
- 新增 Task Contract 与 Worker 报告契约：Task Envelope 固定 scope、authority、预算、Spec Binding 与期望证据；Specification Unit 与 Spec Binding 即 Planner → Implementation 的明确输入，不复用 Route Planning Session 的交接提案；Worker 以结构化 Worker Result、Worker Question、Worker Escalation 与 Evidence Record 回报，且这些回报只算候选结果。
- 新增 Harness Session Binding 前置事实：Specification Planner、Implementation、Validator 与 Finalizer 的每个 Dispatch 都与确切的 Worker Harness session 及可引用 transcript 来源绑定；Worker 存活按三值判定，终态必须可核验，会话中断只记录 Session Segment 事实。
- 不在本 change 内实现：Validator 的独立验证、范围内修复与证据失效判定，交付核验与 Accepted Worker Result 记录，实现尝试重试，Git 集成与 Finalizer，Worker Session Recovery、Recovery Capsule 生成、Recovery Budget 计数，以及 TUI 呈现和真实 Orca 派发闭环的端到端验收。前三项恢复能力统一留给 Change 7；在此之前 session 丢失只能形成 blocker，或由后继 Change 6 按正常 Retry Attempt 处理。

## Capabilities

### New Capabilities

- `execution/work-package-admission`: frontier 即时 worktree 建立与角色级 Orca Task 物化的时机、前置条件与失败关闭行为。
- `execution/specification-admission`: 工具原生 Specification Unit 的编写方式、确定性接纳检查、Spec Binding 与可选独立质量门。
- `workers/task-contracts`: Task Contract、Task Envelope、Spec Binding 的稳定性与结构化 Worker 报告契约。
- `workers/harness-binding`: 四个主要 Worker 角色的 Dispatch 与真实 harness session、可引用 transcript 的精确绑定，以及 liveness、可核验终态与中断 Segment 事实。

### Modified Capabilities

无。当前规划包只新增独立 capability，不依赖尚未归档的主规格。

## Impact

影响 `src/domain/`（物化前置、规格接纳、Task Contract、Worker 报告、liveness 与终态规则）、`src/application/`（SpecificationProvider 与 harness binding port、admission 与物化用例）、`src/adapters/orca-cli/`（在既有 `orca-backend.ts` 与操作目录上扩展 worktree 建立并复用 Task mutation）、`src/adapters/agents/`（四个主要角色的 Codex Session Binding 与 transcript 引用）、`src/adapters/specification/`（OpenSpec `SpecificationProvider`）、`src/adapters/storage/`（Session Segment 与物化绑定 migration）以及 `tests/`。不新增依赖，不改 `openspec/schemas`、`openspec/config.yaml`、CLI 子命令或 `AGENTS.md`、`CONTEXT.md`。
