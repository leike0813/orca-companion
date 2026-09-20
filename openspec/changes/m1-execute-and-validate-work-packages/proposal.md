## Why

Work Package 一旦被接纳并物化，Controller 才开始面对整个 M1 最危险的一段：判断一个 Worker 声称的完成是否真的完成，判断失败能否重试，判断哪些代码可以进入 canonical 分支，以及项目到底能不能交付。这段决定目前只有零散原则，没有可核验的时序与失败关闭行为。本 change 把它冻结下来，让 M1 的串行闭环可以在不猜测身份、代际与证据的前提下跑通。

## What Changes

- 新增 Work Package 交付行为：固定 Delivery 的读取、核验、去重、Orca 接受与回读、本地引用落盘、最后确认顺序；Worker 报告必须经身份、代际与版本核验后才成为 Accepted Worker Result，结果正文归 Orca，本地只保存去重键与引用；实现尝试与 Retry Attempt 保持 WorkerTask、contract 与 revision 不变。
- 新增独立验证行为：Validator 以独立角色验证，只能在该任务已授权范围与修复预算内直接修复并复验；同一「验证—修复—复验」必须复用同一真实 Session，session 丢失时形成 blocker，或在条件成立时按正常 Retry Attempt 重开。
- 新增受控 Git 集成行为：只有 Validator 接受结果后，Execution Coordination Lease holder 才可按 Execution Authorization 的 Git Integration Policy 创建普通 commit、集成 canonical 分支并推送唯一获批 remote/ref。
- 新增项目收尾行为：全部 Work Package 通过后，Finalizer 以新的只读项目级 Session 检查整个项目并给出 Delivery Verdict，Controller 记录被接受的结论或阻塞原因。
- 不在本 change 内实现：物化时机与 Specification Admission、Worker Session Recovery、Recovery Capsule 生成、Recovery Budget 计数、Graph Patch/Revision 与 Replanning、TUI 呈现、真实 Orca 端到端验收与 M2 能力。Recovery 能力统一留给直接后继 Change 7。

## Capabilities

### New Capabilities

- `execution/work-package-delivery`: Worker 报告的身份与代际核验、Accepted Worker Result 记录、实现尝试与 Retry Attempt 边界。
- `execution/validation`: 独立 Validator 的同 Session 验证、范围内修复与复验，session 丢失时的 blocker/正常 Retry Attempt，以及修复导致的证据失效处理。
- `execution/git-integration`: 授权范围内的普通 commit、canonical 分支集成与唯一获批 remote/ref 推送。
- `execution/project-finalization`: 只读 Finalizer 的项目级检查与 Delivery Verdict 接受。

### Modified Capabilities

无。当前规划包只新增独立 capability，不依赖尚未归档的主规格。

## Impact

影响 `src/domain/`（结果核验、证据失效、集成前置、Delivery Verdict 规则）、`src/application/`（Delivery 处理、结果结算、Validator 生命周期、集成与收尾用例）、`src/adapters/orca-cli/`（Dispatch、Attempt 与 Accepted Worker Result 事实读写）、`src/adapters/agents/`（Validator 会话复用）、Branch Coordination Store 的版本化 migration 与 `tests/`。不新增依赖，不改 `openspec/schema`、`openspec/config.yaml`、CLI 子命令或 `AGENTS.md`、`CONTEXT.md`。
