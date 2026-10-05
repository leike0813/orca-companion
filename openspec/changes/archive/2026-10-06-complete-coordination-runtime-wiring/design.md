## Context

直接前驱恢复了可配置并行额度、包级准入与串行 Git 集成，本轮基于同一 HEAD 上尚未提交的修复补录设计。领域术语沿 `CONTEXT.md`；模块归属沿 `docs/architecture.md` 与 IC-02/03/04/05/07/08/09/10/11/12/14。bootstrap 负责装配已有应用用例，业务准入与状态迁移仍由 application/domain/store 拥有。

## Goals / Non-Goals

**Goals:** 使已有协调合同具有真实生产入口；以确定事实约束重试、预算、所有权与唤醒；记录本轮实现的 schema、恢复边界与验证证据；消除主规格中的单包串行漂移。

**Non-Goals:** 后台 Controller、远程控制、通用调度平台、新 Harness、依赖变化、TUI 重新设计、真实上游 runtime 修改或将未运行的真实集成标成通过。

## Decisions

### D-01：重规划沿现有领域过渡和真实 drain 事实推进

`replanning-service.ts` 拥有 begin/complete/cancel，`lease-handoff.ts` 与 store 拥有授权后的原子 Cutover。宿主从 Run、Worker 三值 liveness、Delivery、Pending Interaction 与 Intent 派生 drain，不接受模型提供“已结清”事实。开始立即停止新派发，现有工作结算只归前代；结清后释放 Lease 并建立新 Planning Cycle。重复 begin/complete/cancel 沿已记录身份恢复。

新候选走完整 Manifest 审阅；取消重规划在 Cutover 前重新核验原 Run、基线、预算和结果，并要求显式批准刷新授权。`select-bound-run.ts` 沿稳定 Intent 选择 Run；响应丢失只核验同一身份，不重发已可能接受的操作。候选有 predecessor 时只能 Cutover，不允许普通初始模式切换绕过前代冻结。拒绝另建 bootstrap 状态机或以通用 Resume 代替重规划取消。

### D-02：旧成果采用来自原接受记录、Git 与 Orca

`baseline-adoption.ts` 与 `graph-history.ts` 拥有预检/登记，`plan-continuations.ts` 提供生产可信事实读取器。先验证前代图链与成员、Task 结果回读、精确 Session Segment、同包同代际集成 Intent、祖先关系及证据覆盖路径，再创建候选 Run。矛盾或读取失败关闭采用；零预算消费也不能掩盖矛盾 lineage。

Baseline Adoption 不复制完成节点；Migration Material 只提供只读引用，新 worktree 显式迁移复验。未完成责任的 lineage 沿有效消费量继承实现、修复与修订额度。拒绝把 Worker 自述、别包的 push 或当前授权当作旧结果证明。

### D-03：Validator 的步骤协议只续接原真实 Session

`run-validation.ts` 拥有验证与修复门禁；`validation-runtime.ts` 装配有界 typed ask/reply。原 Task、Envelope Dispatch、真实 Orca Dispatch、Attempt、UUID 和精确 worktree 必须能经 Session Segment 对应。稳定步骤与原初消费量先持久化，恢复只回读记录的最多 20 个消息引用；缺失原消息或会话证明即 blocker。

修复许可前工作区必须干净，HEAD 记入原 Reply Intent；修复后读取从该 HEAD 起的提交、index、未提交与未跟踪项目路径，合并 Worker 自报路径，由同一 scope/evidence 规则核验。缺 HEAD、工作区变化不可证明或范围越界时拒绝 finish。成功结果需已接受的终结许可；确定失败结果可结算为失败，不能伪装通过。拒绝通过新 Session、自报路径或迟到终态绕过步骤链。

### D-04：准入是预算消费和 Retry 身份的唯一边界

store 在 `record-materialization-binding` 的同一短事务内消费新的 Implementation Attempt；修复用稳定 step admission 同事务消费 `validatorRepairs`。同值重放幂等，异值拒绝；准入后启动失败或 unknown 不返还已消费预算。有效消费包括 lineage，旧授权锚定计数在同图/代际/Run 且该预算上限一致的重新批准后继续有效。

Retry 仅在确定失败有精确结算/Segment 证明时创建新 Attempt/Dispatch，复用原 WorkerTask、Orca Task、创建 Intent、契约、worktree 和运行依据。历史 outcome 缺失不推断失败。禁止把扣减散落在模型工具、TUI 或外部启动完成后。

### D-05：Session Claim 唯一性和交接由 store 原子维护

保留 per-ticket 唯一约束，增加同 Scope/Session active Claim 部分唯一索引；route-map 用例先核验 Session 已有 Claim，事务约束防竞态。规划 cutover 同事务转移 Claim 与规划责任；执行 cutover 同事务转移 Claim、Lease、相关交互与后续事件责任。Target 已持不同 Claim 时整体拒绝。运行身份与预算保持。

执行 Target 的 `awaiting_user_prompt` 由下一条真实普通 Prompt 激活；旧消息重放、Worker 进度或 Wake 准入不能代替用户激活。拒绝依赖各 Session 共用的 tracker assignee 判断所有权。

### D-06：确定性前台对账与模型唤醒分离

宿主定时 pump 在 Scope 内串行化，继续对账 Delivery、Session Binding、步骤、结果和重规划收尾；关闭时清除定时器。普通 Worker 问题/升级先核验实际发送方与当前身份，再经 `projectActionableWork`、`admitWakeBatch` 落盘；步骤报告走确定性通道。已接受 Verdict 与确定失败只给当前责任方准入，前代或旧 Attempt 只补历史。

Wake 保留稳定 source revision/batch 身份和跨库补齐规则，checkpoint 与 Branch Store 不假装原子。`reply-worker-question.ts` 统一普通答复与 Validator 许可的 Intent/receipt/unknown 路径；不因回执缺失换 OperationId 重试。拒绝每个 tick 唤醒模型或由 UI effect 驱动执行。

### D-07：维护依赖可信 provider 能力并保留有限边界

installed integration 可选提供 native compaction/keepalive；keepalive 默认关闭，显式启用后按 provider 的可信间隔运行，每次挂起最多 8 次，真实 Actionable Work 后重新计数。Pause/Cancel/Exit、fencing 或新工作立即取消/让位；不写模型历史，不创建 Wake，不推进业务。

原生压缩只在输入需要有界化或显式请求时调用；不支持时走 Capsule。Shake 记录绑定有效输入区间、配置与产物身份，持久保存已 shake 的原始 step IDs；无新进展的重启不能重复执行。拒绝永久假报 unavailable、固定 `shaken: false` 或用近似测量冒充可信 context。

### D-08：checkpoint blocker 与凭据装配有唯一 owner

Runtime guard 在原 Session checkpoint 不可恢复时持久写入 blocked 与结构化原因；执行 Lease holder 同时阻塞 Scope。显式 Resume 必须先验证原 checkpoint 的 pending/tools/context，再完成对账；不创建替代历史。规划 Session 的独立损坏不自动停止其他规划 Session。

CredentialStore 仅由 bootstrap 创建：前台宿主复用一个注入实例，独立 doctor bootstrap 可创建其单次命令实例。chat-model factory、Worker launcher 和模型设置均不自行 fallback 构造；原路径、权限、锁和 CAS 不变。模型配置绑定属于 `coordination.sqlite.session_registry`，不再误归 checkpoint。

## Risks / Trade-offs

- 历史缺失 outcome、Validation cursor、修复许可 HEAD 或运行依据时保守阻塞，不能凭新字段为旧行补证明。
- 唯一索引迁移遇到真实重复 Claim 会拒绝启动；需要显式解决所有权，而不是自动删除用户记录。
- provider 可选能力缺失时保活正常停止，压缩按原合同降级；接通能力不等于所有 provider 都具备能力。
- fake backend、真实 SQLite 与临时 Git worktree 回归已验证；真实 Orca/provider 验收未运行。这一边界必须保留在任务与正式验收中。

## Migration Plan

Branch Store schema 19 → 20 在同一迁移事务内新增 Claim 唯一约束、Session blocked reason、nullable 结算 outcome/verdict、Validation admission/cursor，并重建支持同 Task 多 Attempt 的 materialization 主键。既有重复 Claim 整体回滚；历史结果列保持 null，不推断回填。checkpointer 产物 schema 3 保存机械 Shake 状态，历史正文和凭据不迁入共享 store。项目配置与 Manifest 版本保持 3。

## Open Questions

实现合同无未决问题。正式 verification 等实现 checkpoint 固定后再建立；真实隔离验收环境与凭据需届时显式选择，不在本次补录中发起外部操作。
