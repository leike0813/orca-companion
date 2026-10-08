# Orca Companion 接口合同

本文定义跨 module、跨 change 和外部系统 seam。架构与依赖方向见 [`architecture.md`](architecture.md)，领域词义见 [`CONTEXT.md`](../CONTEXT.md)。所有 TypeScript 片段都是规范形状，不是待复制的源码；owner change 应在 canonical path 实现，后继只能按登记关系 Extend 或 Consume。

每个合同只有一个 `Owner (Create)`。公共字段、枚举、错误分类、所有权或权威来源发生变化时，先更新该合同和所有受影响的 OpenSpec change；实现不得用 `any`、额外可选字段或局部 adapter 特判吸收漂移。

## 所有权总表

| Contract | Owner (Create) | Extenders (Extend) | 主要 Consumers (Consume) |
|---|---|---|---|
| IC-01 | `m0-orca-control-baseline` | 无 | 全部后继 change |
| IC-02 | `m0-orca-control-baseline` | Change 5 增加物化操作；Change 7 增加对账 query | 所有外部控制用例 |
| IC-03 | `m1-persist-coordination-state` | Changes 3–8 增加各自最小记录与 query/command variant；`m1-wire-foreground-planning-runtime` 增加 Scope 注册绑定、交互回答正文与 Session 模型绑定更新；`m2-wire-execution-runtime` 将物化绑定扩展为角色/Attempt 历史 | Controller、status、recovery、TUI projection |
| IC-04 | `m1-run-coordinator-sessions` | `m1-wire-foreground-planning-runtime` 增加用户消息、工具结果与压缩结论 | Planning、Recovery、ControllerService、TUI |
| IC-05 | `m1-plan-and-authorize-execution` | Change 8 只扩展 `ExecutionGraphHistory.appendAcceptedRevision`；`remove-worker-credential-management` 将 Manifest 升为 v4 并改绑 `modelSelection` | Specification、Execution、Recovery、TUI |
| IC-06 | `m1-admit-work-package-specifications` | Change 8 使用同一 provider 实施 Specification Revision | Execution、Recovery、Graph evolution |
| IC-07 | `m1-admit-work-package-specifications` | `m2-wire-execution-runtime` 增加 Planner 的固定规格目标路径；Recovery 创建替代 Dispatch/Segment；`remove-worker-credential-management` 移除启动输入中的凭据与隔离根，增加 runtime roots 与原生模型目录查询 | Execution、Recovery、Graph evolution |
| IC-08 | `m1-execute-and-validate-work-packages` | 无；Recovery 重放同一 pipeline | Recovery、Graph evolution、TUI |
| IC-09 | `m1-recover-execution` | `m2-wire-execution-runtime` 接通前台宿主的 Recovery 事实装配（workspace / 原终态 / 存活 / 绑定 / 替代派发）与回执解释的异步 seam | Graph evolution、TUI |
| IC-10 | `m1-evolve-execution-graph` | 无 | ControllerService、TUI |
| IC-11 | `m1-recover-execution` | Change 8 增加图演进 projection/commands；`m1-wire-foreground-planning-runtime` 增加消息/回答字段与事件归属；`m2-deliver-planning-tui` 增加只读投影；`m2-deliver-execution-tui` 增加执行投影、Finalizer 与执行交接投影；`complete-tui-project-statusline` 增加可信 metadata、全图验收摘要及有界项目详情 | CLI、TUI |
| IC-12 | `m0-orca-control-baseline` | `m1-wire-foreground-planning-runtime` 登记精确 Home 解析；`m2-deliver-planning-tui` 增加 planning 投影与组件；`m2-deliver-execution-tui` 增加执行态字段与组件；`complete-tui-project-statusline` 接通可信展示与 IC-15 编辑/返回 | CLI machine output、TUI React components |
| IC-13 | `protect-tui-input` | 无 | Bootstrap、TUI 输入保护与记录管理 |
| IC-14 | `complete-tui-model-configuration` | `remove-worker-credential-management` 收缩为 Coordinator-only，并把 Worker 选择改为 `modelSelection` | chat model factory、Coordinator 模型设置与 `doctor` |
| IC-15 | `complete-tui-project-statusline` | 无 | Bootstrap、TUI 展示设置 |

## IC-01 Identity、revision 与引用字段族

- **Owner (Create)**: `m0-orca-control-baseline`
- **Canonical path**: `src/application/dto/identity.ts`；领域专属 ID 可定义在对应 `src/domain/**` 文件并从 DTO 引用
- **Extenders (Extend)**: 无；后继可新增领域 ID 类型，但不能改变共同身份规则
- **Consumers (Consume)**: 全部后继 change

```ts
type StableId = string;
type Revision = number;

type EntityRef<Kind extends string, Id extends string = string> = {
  kind: Kind;
  id: Id;
};

type VersionedRef<Kind extends string, Id extends string = string> =
  EntityRef<Kind, Id> & {
    version: number;
  };
```

| 字段 | 来源与合同 |
|---|---|
| `id` | 由拥有该实体的 controller 或外部权威产生；非空、不可重用，Worker/模型载荷中的同名字段不可信 |
| `kind` | 封闭字面量；未知值在边界 fail closed |
| `version` | 实体自身单调版本，不能与 `scope.revision`、GraphVersion 或 schema version 混用 |
| `expectedRevision` | 调用方最近读取的 `scope.revision`；调用方不能提交“新 revision” |
| `fencingGeneration` | lease 接管时单调增加；旧 generation 的共享写入一律拒绝 |

`CoordinationScopeId`、`CoordinatorSessionId`、`RuntimeIncarnationId`、`PlanningCycleId`、`GraphId`、`GraphGeneration`、`GraphVersion`、`WorkPackageId`、`WorkerTaskId`、`DispatchId`、`AttemptId`、`ValidationAttemptId`、`SessionSegmentId`、`OperationId`、`RecoveryId` 和 `InteractionId` 均为语义不同的 branded string/number，不得相互赋值或从 cwd、mtime、terminal 输出推断。

- **版本/错误**：解析失败返回结构化 validation error；禁止以空字符串、负 revision 或 unknown kind 进入领域层。
- **测试 seam**：边界 parser 的表驱动测试覆盖缺失、类型错误和未知枚举；领域测试使用显式 fixture ID，不 mock 字符串实现。

## IC-02 ExecutionBackend、ExecutionScope 与三值结果

- **Owner (Create)**: `m0-orca-control-baseline`
- **Canonical paths**: `src/application/ports/execution-backend.ts`、`src/application/dto/operation-outcome.ts`
- **Extenders (Extend)**: `m1-admit-work-package-specifications` 增加 worktree/task/worker mutation；`m1-recover-execution` 增加 OperationId reconciliation query
- **Consumers (Consume)**: 所有 Orca 查询、控制、Delivery 和对账用例

```ts
type ExecutionAuthority =
  | { kind: 'route_planning' }
  | {
      kind: 'execution_coordination';
      graphGeneration: number;
      authorizationId: string;
      runId: string;
      consumerGeneration: number;
    };

type ExecutionScope = {
  coordinationScopeId: string;
  coordinatorSessionId: string;
  runtimeIncarnationId: string;
  fencingGeneration: number;
  backendIdentityRef: string;
  operationId: string;
  target: EntityRef<string>;
  expectedRevision: number;
  timeoutMs: number;
  authority: ExecutionAuthority;
};

type OperationRef = {
  operationId: string;
  backendRequestId?: string;
  target: EntityRef<string>;
};

type OperationOutcome<T> =
  | { kind: 'accepted'; operation: OperationRef; value: T }
  | { kind: 'rejected'; code: string; message: string }
  | { kind: 'unknown'; operation: OperationRef; reason: string };

interface ExecutionBackend {
  query(input: ExecutionQuery): Promise<ExecutionQueryResult>;
  mutate(input: ExecutionMutation, scope: ExecutionScope): Promise<OperationOutcome<unknown>>;
}
```

| 字段 | 来源、信任与校验 |
|---|---|
| Scope/Session/Incarnation/fencing | Controller 从 IC-03 当前 lease 和 Session registry 组装；模型与 Worker 不可填写 |
| `backendIdentityRef` | Bootstrap 核验并注入的协调身份引用；adapter 解析成当前 Orca terminal handle，不持久化 handle |
| `operationId` | Controller 在 IC-03 intent 落盘前生成；重放和对账保持不变 |
| `target` | 应用用例从已校验资源引用构造；必须与 operation variant 相容 |
| `expectedRevision` | IC-03 最近读回的 scope revision；stale 时在发出外部请求前拒绝 |
| `timeoutMs` | 版本化项目配置或 operation catalog 的有限值；模型不可放宽 |
| execution authority 字段 | Execution Authorization、Orca Run 和 consumer binding；route planning variant 不携带这些字段 |
| `backendRequestId` | Orca response/receipt；仅用于对账，不替代 OperationId |

`ExecutionQuery` 与 `ExecutionMutation` 是封闭判别联合；每个 variant 在 `src/adapters/orca-cli/operation-catalog.ts` 登记 argv 构造、JSON parser、输出上限与是否可变。未登记 variant 在启动进程前 `rejected`。`readDeliveryBatch` 与 `ackDelivery` 是 transport 原语：读取不隐式确认，确认只接受稳定 DeliveryIdentity。

- **结果语义**：`accepted` 包含外部系统记录的确定失败；`rejected` 只表示能证明请求未产生副作用；响应丢失、超时或 receipt 不足为 `unknown`。
- **顺序/幂等**：遵循 FLOW-01；unknown 仅以同一 OperationId/OperationRef 查询或 `--retry-request` 对账。
- **答复对账**：`request-show` 的可选原始 `receipt` 透传到 `ReconcileResult`；`completed` 只表示有确定结果。Worker reply 必须核验原 question ID 与 answered 回执才结算成功，确定失败结算为 rejected，缺失回执仍保留阻塞及原 backend request 引用。
- **取消**：进程取消只取消等待；除非能证明请求未发送，否则结果仍是 unknown。
- **测试 seam**：应用测试使用 fake `ExecutionBackend`；adapter contract test 覆盖 argv、stdout/stderr、schema、error passthrough；真实 Orca 只在隔离项目和专用身份验证。

## IC-03 BranchCoordinationStore、lease 与 Operation Intent

- **Owner (Create)**: `m1-persist-coordination-state`
- **Canonical paths**: `src/application/ports/branch-coordination-store.ts`、`src/adapters/storage/coordination-store.ts`、`src/adapters/storage/schema.ts`
- **Extenders (Extend)**: Changes 3–8 通过版本化 migration 增加各自最小记录和闭合 query/command variant；`m1-wire-foreground-planning-runtime` 追加 schema 10 的 Scope 注册绑定、交互回答正文、一次性绑定命令与 Session 的 Coordinator Model Configuration 绑定更新
- **Consumers (Consume)**: Application services、status projection、startup reconciliation、ControllerService

```ts
interface BranchCoordinationStore {
  query(input: CoordinationQuery): CoordinationQueryResult;
  transact(input: CoordinationCommand): CoordinationCommandResult;
}

type CoordinationCommandBase = {
  coordinationScopeId: string;
  expectedRevision: number;
  writer: {
    coordinatorSessionId: string;
    runtimeIncarnationId: string;
    fencingGeneration: number;
  };
};

type CoordinationCommandResult =
  | { kind: 'committed'; revision: number }
  | { kind: 'rejected'; code: 'stale_revision' | 'fenced' | 'constraint' | 'invalid_state' };
```

| 记录族 | 必需字段与权威边界 |
|---|---|
| Scope | 用户登记且不可原地改写的完整 branch ref/canonical worktree 绑定、mode、orthogonal control state、Planning Cycle/current graph/current authorization refs、revision；不保存 Git HEAD、工作树当前内容、图体或 tracker 正文 |
| Session registry | Session ID、Coordinator Model Configuration ref、生命周期状态；不保存 provider credential/object |
| Lease | lease kind、holder Session/Incarnation、expiry、fencing generation；Runtime expiry 不自动释放长期 claim/Execution Lease |
| Ticket claim | ticket ref、Session、state；正文和 tracker assignee 仍归 tracker |
| Pending Interaction | InteractionId、owner Session、scope ref、expected revision、state、answer ref；回答引用绑定 interaction 与 submissionId，受控正文与状态在同一 CAS 事务写入，普通聊天不能满足 |
| Operation Intent | OperationId、target、expected revision、state、outcome class、backend request ref；不复制 receipt 正文 |
| Budget counters | budget key、approved limit ref、consumed count；重启/恢复/patch 不重置 |
| 后继记录 | wake admission、graph/auth refs、bindings、dedupe refs、Recovery/Handoff/lineage；只存不可重建最小事实 |

`CoordinationSnapshot.unresolvedIntents` 只含 pending/blocked；`settledGitIntegrationIntents` 只读投影当前 Scope 已结算且被接受的 Git 步骤。完整集成须匹配当前 Graph Generation、Work Package 的 **push OperationId**，commit 或 canonical merge 意图不足以证明完成。两者来自同一张 Operation Intent 表，不新增写入权威。

`m2-wire-execution-runtime` 的 schema 11 将 Materialization Binding 按 Scope、Work Package、角色和 Attempt 留存。每条新记录绑定一个 Orca Task、创建 OperationId、Task Envelope 的 WorkerTaskId/DispatchId/AttemptId、真实 worktreeId，以及已接纳的 Spec Binding；Planner 首次创建规格时改存固定 `specificationUnitPath`，Spec Binding 为空。Delivery 用这条持久绑定和精确 Session Segment 核验可信归属，不能从 Worker 自报 payload 补全。迁移前旧行保留但新增身份字段为空，读取时阻塞，不作猜测。

schema 12 起每条物化绑定还记录这次派发使用的 **Worker launch 身份**（`launchId`）：它是补记 Session Binding 的唯一定位事实（报告文件按 launchId 派生）。Session Binding 的建立分两处，共用同一份签发实现：派发路径在 `bindingWindowMs` 窗口内读 Codex SessionStart 报告；每次执行触发在推进之前对「物化绑定已 issued 且有 launchId、但图内还没有对应 Session Segment」的角色再读一次同一路径的报告（Orca Dispatch 身份按已记录的 Orca Task 从列举事实匹配，不猜），校验通过才补记 Segment，读不到就什么都不做（保持 fail-closed：Delivery 结算会以 `dispatch_record_missing` 呈现）。补记不派发新 Worker、不改 Attempt、不消耗预算。schema 12 之前写入的行没有 `launchId`：读取方在需要补记时按不可补记处理，绝不重建派生编码。

补记不依赖 Segment ID 的生成方式。相同 Work Package、角色、WorkerTask 与 Attempt 已有 Segment 时，相同实际 Orca Dispatch 不重复记录，不同 Dispatch 不复用原 launch 报告。没有 Segment 的首次补记还要求该 Orca Task 只有一个派发观察；多派发时保持未绑定。Recovery 的替代 Segment 与精确 Session 由 Recovery receipt 路径记录，不能从原物化 launch 的 SessionStart 报告补建。

schema 16 再把这次派发的**运行依据**钉进同一条记录：`authorization_id`、`authorization_version` 与 `worker_profile_ref`。换模型只影响之后物化的 Task；已派发的 Task 按这条绑定取原授权与 profile，结算与恢复据此判断权限与模型配置。写入时缺任一项即拒绝。schema 16 之前写入的行这三项为空，读取方按不可证明阻塞，不退回「当前授权」。Recovery Utility 使用独立 `utility_role`，与四主角色的 `role` 互斥；同 Scope/Work Package/Utility Attempt 的绑定唯一，领域 `WorkerRole` 闭集保持四主角色。

schema 17 新增 nullable `graph_versions.initial_plan_json`。`record-graph-version` 的 `initial` 记录必须同时提供通过 schema 解析的 `initialPlan`，其 `planRevision` 必须等于记录的 `planRevision`；初始计划与 v1 图记录在同一事务写入。`accepted_revision` 禁止携带或覆盖初始计划。迁移只新增可空字段，既有行维持 `null`，不从当前计划或 tracker 正文推断历史。

schema 20 用 partial unique index 强制每个 Scope/Session 只有一个 active Claim；迁移发现既有重复时回滚并拒绝打开，不替用户选择保留票。`session_registry.blocked_reason_json` 保存 Session blocked 的结构化原因。`delivery_settlements.outcome` 与 `validation_verdict` 的历史缺失值保持 null，缺少成功证明不推进生命周期。物化绑定支持同一创建操作下多个 Attempt，原 Task、合同和授权保持固定。`admit-validation-step` 按稳定 stepId 同事务保存修复准入并累计 validatorRepairs，重放只读既有准入；实现尝试随派发准入原子扣减。预算继承沿持久 Work Package Lineage 累计，重新授权、重启与代际切换保持已消耗额度。计数保留首次授权锚点；只有同图、同代际、同 Run 且该预算上限相同的重新授权可继续消费原计数，展示与准入都读取该责任的有效累计值。

schema 13 给修订持有（`revision_holds`）加上内容版本边界：`prior_contract_revision` 是被替换掉的契约内容版本，`admitted_contract_revision` 是重新准入接纳的版本，两者都可为空（旧行与尚未准备/结算的行）。它们回答两个此前只能靠时间戳猜的问题——「内容是否真的变了」与「修订完成前与完成后的角色结果如何区分」。两条命令与图版本事务共同维护这一边界：

- `prepare-revision-hold` 只在来源与当前 pending 持有逐项一致的持有上写旧版本（没有既有 Specification Unit 时记 0）；同源重放读回同一个值，值不同即拒绝——版本边界不因重放而漂移。
- `release-revision-hold` 可携带 `expectedSourceRef`、`admittedContractRevision` 与成对给出的 `budgetConsumption` + `approvedLimit`：同一事务里核对来源、拒绝 `consumed + amount > approvedLimit`，然后记录接纳版本、释放持有并计一次额度。接纳版本与被替换版本**允许相同**（只改契约的修订、或 Planner 原样交付同一份内容），因此不能用内容版本当释放条件。已释放持有的重放只在来源与接纳版本都一致时幂等成功。
- 重新登记持有（`record-revision-hold` 与 `record-graph-version` 共用同一处写入）清空两列并**刷新 `created_at`**：新来源替换掉了哪一版内容、后来接纳了什么，都还没有事实；而 `created_at` 是「当前这次持有」的登记时刻，`released_at` 随释放写入。修订 Planner 的派发与它的先后关系靠这一对时刻判定（被替换版本的 Planner 派发一定早于持有，修订 Planner 一定晚于它），因此派发门禁只在「持有登记**之后**还没有**已结算**的 Planner 交付」时给出许可；这样的交付已经存在时再派一次，会让「旧派发是否已结算」与「持有是否该结算」两个判定互相锁死——真实运行 `orca-companion-e2e56` 就是这样永久停在 `revision_pending` 的。反过来，同一条判据也要求重新登记真的刷新登记时刻：两处写入曾经分叉（图版本事务保留了旧时间戳），于是第二次接受的修订被读成「已交付」，而结算又因为内容版本未准备而跳过，Scope 同样永久停在 `revision_pending`（真实运行 `orca-companion-e2e64` 实测）。
- 新旧角色结果的边界是**持有登记时刻**而不是内容版本：`revision_holds.created_at` 记录「当前这次持有」的登记时刻（重新登记时刷新），released 之后只有在该时刻**之后签发**的物化绑定所产生的结算才算数。Graph Patch 可以只改该 Work Package 的契约（例如依赖），修订 Planner 也可能交付与旧版相同的内容——两种情况下角色链都必须重跑，而内容版本分不出「之前」与「之后」，因此 `admitted_contract_revision` 只作记录，不再充当边界。

**当前有效角色结果**的边界是持有登记时刻（见 IC-11 的派生规则）；持有仍 pending 时该节点的旧结果不构成任何推进证据，released 之后只认登记之后签发的绑定所产生的结算。旧库（schema ≤ 12）在可写打开时按可重入 migration 升级，已 released 的历史行没有登记边界时沿用原有投影规则。

所有写入是短事务；唯一约束保护活跃 Runtime Lease、Execution Coordination Lease 和 Ticket Claim。`scope.revision` 只由成功共享事实写入推进；lease heartbeat 只更新 lease 行，不推进业务 revision。Schema version 高于实现时拒绝启动，低于实现时按可重入、单事务 migration 顺序升级。

`m1-wire-foreground-planning-runtime` 把 schema 9 升为 10：新 Scope 必有完整 ref 与 canonical worktree，旧 Scope 的 nullable 绑定只可经用户确认、Git 身份核验及无存活 Runtime Lease 的一次性 CAS 命令（`bind-scope-identity`）补齐；不得从 cwd 猜测。当前 Git 身份始终由 Git 读取，注册绑定不是 Git 当前状态的镜像。同一 common dir 内一个完整 branch ref 至多属于一个 Scope。

模型切换的持久化同样落在本合同的现有记录上：`update-session-model-configuration` 只按 CAS 更新 `session_registry.coordinator_model_configuration_ref`，不改写身份字段，也不创建第二份配置记录；项目配置仍是可用配置集合的唯一来源。

- **错误/事务**：stale revision、fenced writer、唯一约束和非法状态结构化拒绝；不自动重试业务 command。
- **测试 seam**：使用临时真实 SQLite adapter 测试事务、约束、migration 与重开；Application 用例可使用内存 fake，但不得测试一套不同状态机。

## IC-04 Coordinator Session checkpoint、Wake 与 Context maintenance

- **Owner (Create)**: `m1-run-coordinator-sessions`
- **Canonical paths**: `src/domain/coordinator/session-state.ts`、`src/adapters/storage/checkpoint-store.ts`、`src/application/coordinator/{actionable-work,wake-admission,suspension}.ts`
- **Extenders (Extend)**: `m1-wire-foreground-planning-runtime` 增加用户消息准入、tool-call 配对结果与最近压缩结论；后继通过同一路径消费
- **Consumers (Consume)**: Planning、Recovery、ControllerService、TUI lifecycle

```ts
type WakeBatch = {
  wakeBatchId: string;
  coordinationScopeId: string;
  coordinatorSessionId: string;
  sourceRevisions: readonly SourceRevisionRef[];
  actionableWork: readonly ActionableWorkRef[];
};

type CoordinatorSessionState = {
  schemaVersion: number;
  coordinatorSessionId: string;
  committedMessages: readonly unknown[];
  graphPosition: string;
  committedModelSteps: readonly CommittedModelStep[];
  wakeBatches: readonly WakeBatch[];
  contextMaterial?: ContextMaterial;
};
```

Session payload 为 v2：每条已提交消息有稳定 `entryId`；tool result 包含配对的 `toolCallId` 与名称，assistant call 的可信 `OperationId` 在模型响应提交时由宿主分配；`lastCompactionOutcome` 是该 Session 最近一次维护结果。普通用户消息以 `submissionId` 与 WakeBatch 原子落盘后补记 source admission；交互回答正文属于 IC-03。

`paginate-coordinator-history` 扩展 IC-04，历史 DTO/限额的 canonical path 为 `src/application/coordinator/history.ts`。checkpoint 库 schema 为 3，schema 2 以短事务升级，旧整体 JSON 库明确拒绝打开并保留。`coordinator_sessions` 只保存控制字段；entry、16KiB UTF-8 正文块、model step metadata 与 Wake 关联追加。正文只由 entry 的块记录拥有；step 引用该 entry，不再保存另一份正文。独立的小型 summary metadata 用于有界列表，工具参数仍由原 entry 拥有。Mechanical Shake 的尝试身份与派生压缩载荷单独持久保存，原始消息和模型历史保持追加。

生产读取必须显式选择 `metadata`（控制）、`context`（有效输入）、`tools`（最新 step 及配对结果）、`pending`（最多 32 条未处理输入）或 `migration`（原生窗口转 Capsule 所需的有界原文）。后四种读取受 4096 条与 `context.maxReadBytes`（缺省 16 MiB）的共同预算约束，正文、metadata、steps 与 Context Material 计入同一次读回的总额；超限返回 `unrecoverable/context_exhausted`。压缩区间由索引排除后才读取正文。原生窗口保存覆盖序号，之后的新消息仍进入有效上下文。`full` 与无范围 `readCommittedMessages` 只用于测试/诊断，生产不调用。

单次模型输出受 `output.maxResponseBytes`（缺省 8 MiB）约束，文本、内容块和工具参数均计入。生产 stream 的完整响应只由 SDK end callback 提供，原子接受之前重新核验 signal/fencing；取消、输出超限或失去 fencing 不重试。Usage 仅记录单个完整非空报告，多片段或缺字段保留 null；不从分片推测合计。项目配置的两项字节预算为有限正整数，Bootstrap 注入 Scope 与 Session 的所有 store 及模型调用点。

`appendMessage` 保存稳定回答引用，`updateCheckpoint` 只更新控制字段，均使用短事务；提交核验通过 `readEntry` 精确读取提交身份。`commitUserMessage`/`commitWakeBatch` 的 `state` 是控制字段和本次提交的条目或 batch，不是全历史快照。entry 的 `handled_by` 是已提交消费事实的索引，Application 仍拥有 Actionable Work 投影和调度。

`HistoryReadPort.readHistoryPage` 使用 Session/sequence keyset，至多 100 条且 metadata 合计 64KiB；先读取长度与身份，再按剩余预算物化 metadata。`readHistoryBody` 绑定 Session、entry、revision=1 与 UTF-8 byte offset，每次至多 64KiB 正文，拒绝越界与非字符边界。两者独立读取，不加载整个 Session 后切片。

历史检查的 canonical path 为 `src/application/coordinator/history-inspection.ts`。`HistoryInspectionStorePort` 的 snapshot/calls/users/arguments 只读；`prepareHistoryInspection` 由 Bootstrap 初始化生命周期分批调用，每次 ≤64KiB metadata/100 项。调用与活动索引保存原 entry/step/call/operation 身份、参数原 metadata byte range 与摘要，正文和参数不复制。参数 source 为 `arguments(entryId, stepId, callId, contentRevision=1)`，offset/end 属于参数 JSON 原文，单次范围 ≤64KiB。调用页以 `(sequence, ordinal)` keyset、固定 upperSequence、精确 entry/call 或活动身份查询，≤100 项/64KiB；users 直接按 `role=user` 和 Session 过滤，不含回答引用。

分类在模型响应接受时由同一可信注册表的 `mutating` 填入 `CommittedToolCall.activityKind`；缺失分类单列。`recordToolObservation` 绑定原 Session/entry/step/call/operation，只记录经 fencing 核验的真实 unknown。相同身份重放保留首次观测，诊断理由变化不重复计数或拒绝恢复。观测绑定记录时的已提交序号，单次调用与活动摘要按同一 upperSequence 读取。无结果与无观测为 unconfirmed，配对结果优先；ok 不表示 Worker 完成。观测不补配对 tool entry，不改变恢复或副作用策略。

IC-11 的 `history-inspection`、`history-calls`、`user-history`、`history-search` 与扩展 `transcript-body` 经 schema 和 Bootstrap Scope/Session 绑定查询。搜索固定已提交 upperSequence，只搜保留的正文与参数，不搜 preview；escaped literal `/iu` 提供 Unicode 简单折叠，不进行兼容归一化或扩展折叠。查询 ≤256 code points，每批正文（含跨块重叠）≤64KiB、metadata ≤100 项/64KiB、结果 ≤50 项/64KiB，工作区 ≤1MiB/64 项。游标绑定查询身份并保留精确来源位置，取消或失败不产生无匹配结论。

Ctrl+T 切换整体详细，手动展开独立；F4 选择/开合活动，Esc 返回输入。F3 从最早保留记录查找，Enter 向新、Shift+Enter 向旧，Esc 恢复原阅读与展开状态。Ctrl+R 从最新普通输入向旧查找，Enter 只采用原文，再次 Enter 沿原提交管线。空草稿 ↑ 召回；未编辑预览在全文首尾才能继续 ↑/↓，越过最新或 Esc 恢复原 UiDraft。预览不持久写入，采用或文本编辑复用 IC-13；超限、读失败保留原草稿，不截断。

Capsule 的替换区间在保存时绑定固定序号边界；摘要包含实际被替换的全部条目，包括交错的用户输入和工具结果。压缩前缀保留完整最新 step，同载荷重放保持原边界，后续追加不会扩大已替换区间。

`CoordinatorSessionRecordPort.appendModelStep` 与 `appendToolResult` 在既有 storage 事务中读取最新 core、核验稳定条目身份并追加。相同身份与内容的重放返回 `saved`，身份相同但内容冲突返回 `failed`；等待期间受理的用户消息与 Wake Batch 保留。Workflow 使用这两个方法提交响应和工具结果，路由与消费字段维持原语义。

受理当前工作的 `ok` 工具结果可以携带 `completedWorkSource`（完整 source kind/id/revision），表示该次工作已处理。拒绝、unknown 与未落盘结果不带此字段；宿主按精确来源重建待处理工作。该字段只允许出现在 tool 消息中。外部 Actionable Work 通过 `commitWakeBatch` 同事务追加带 `workSource` 的 system 来源引用条目，不复制外部正文；Worker 问答、已确认的角色失败与项目交付结论按精确来源完成或由最终 assistant 响应消费。

| 字段 | 合同 |
|---|---|
| `thread_id` | 由 CoordinatorSessionId 确定性映射；不同 Session 永不共享 checkpoint |
| committed messages/steps | 只含完整提交的模型响应与 tool steps；stream draft 不进入历史 |
| `sourceRevisions` | Authoritative Fact/Control Record 的稳定引用，不复制 Delivery 或外部正文 |
| Native Compacted Window | provider-native 不透明项与 owner metadata；跨 model configuration 不兼容时先迁移 |
| Context Capsule | Coordinator 历史的派生可移植摘要；不是 Recovery Capsule 或业务权威 |

恢复遵循 FLOW-02：取得 Runtime Lease → 读 checkpoint → 对账 pending intent → 投影 Actionable Work → 同步写 Wake Batch → IC-03 写 source admission → 模型 loop。无 Actionable Work 时 suspend；maintenance 不创建 Wake Batch 或 Committed Model Step。

已安装的 provider integration 可显式提供 `nativeCompaction` 与带可信 `intervalMs` 的 `keepalive` 能力；缺失能力按 unavailable 呈现。`context.keepaliveEnabled` 默认为 false，前台维护定时器只在当前 fencing、active 控制状态及无 Actionable Work 时调用保活，每次挂起至多 8 个 cycle；新工作、控制状态变化、失去租约或退出会中止它。Mechanical Shake 的源版本与派生产物先持久保存，恢复同一有效输入边界时复用原产物，不重复 shake。

- **失败**：checkpoint 不可恢复时阻塞同一 Session，不创建替代 Session；跨库中途崩溃按 WakeBatchId/source revision 补齐。
- **测试 seam**：LangGraph SqliteSaver 使用临时 `checkpoints.sqlite`；fake model 测试提交/重放；不少于 100 个连续工具调用验证无固定业务 step 上限。

## IC-05 Planning、Authorization 与 ExecutionGraphHistory

- **Owner (Create)**: `m1-plan-and-authorize-execution`
- **Canonical paths**: `src/domain/planning/`、`src/application/planning/graph-history.ts`、`planning-handoff.ts`、`initialize-scope.ts`
- **Extenders (Extend)**: `m1-evolve-execution-graph` 增加 `appendAcceptedRevision`；`complete-tui-graph-basis` 增加只读历史/依据端口，不改变 ProjectDetails revision 语义
- **Consumers (Consume)**: Specification admission、execution、recovery、ControllerService/TUI

```ts
interface ExecutionGraphHistory {
  recordInitialGraph(input: InitialGraphRecord): Promise<GraphVersionRef>;
  loadCurrentGraph(graphId: string): Promise<ExecutionGraphSnapshot>;
  appendAcceptedRevision(input: AcceptedGraphRevision): Promise<GraphVersionRef>;
}

type ExecutionAuthorizationManifest = {
  manifestVersion: number;
  coordinationScopeId: string;
  planningCycleId: string;
  destinationRef: VersionedRef<'destination'>;
  routeMapRef: VersionedRef<'route-map'>;
  implementationPlanRef: VersionedRef<'implementation-plan'>;
  graph: { graphId: string; generation: number; version: number };
  baselineHead: string;
  orcaRunId: string;
  workerProfiles: readonly WorkerProfileRef[];
  recoveryUtilityProfile: RecoveryUtilityProfile;
  permissions: RoleAuthorities;
  limits: ExecutionLimits;
  workspacePolicy: WorkspacePolicy;
  gitPolicy: GitIntegrationPolicy;
  dependencyPolicy: DependencyPolicy;
  acceptedRisks: readonly string[];
};
```

Manifest v4 的每个 Worker Profile 用 `modelSelection`（harness、native model、effort 及其目录来源，见 IC-14）替代完整模型配置；v1–v3 读取即拒绝。`ExecutionLimits` 必须包含 active Work Package、实现尝试、Validator 修复、Graph Revision、Specification Revision 和每 Worker Attempt Recovery 的有限上限；缺失字段即拒绝。Graph Compiler 只校验 schema、引用、无环、Scope Envelope、预算和可信配置，不评判规划语义。

`PlanningHandoffProposal` 持有 proposal ID、Source/Target Session、地图/计划/候选图 revision、责任集合、phase、expected revision 和可移植 Coordinator Context Capsule ref。prepare/review 不转移责任，cutover 才 CAS；它不触碰在途 Worker 或 Execution Coordination Lease。

- **权威/版本**：图拓扑只经 `ExecutionGraphHistory` 追加；历史 GraphVersion 不改写。Manifest 内容变化产生新版本与新批准。Manifest 对图的绑定是**批准时刻的那张图**：GraphId 与 Generation 必须与当前图相同，绑定时刻的 GraphVersion 必须仍在当前图的追加链上（`graphVersionChain`）。图会随 accepted revision 前移，因此**不要求**绑定版本等于当前版本——要求相等会让每一次合法的图修订之后的所有派发都不成立；派发门禁（`advance-execution.ts`）、图修订请求（`request-graph-patch.ts`）与界面 readiness 投影（`controller-service.ts`）共用这一条规则。
- **schema 17 原始计划**：初始图 v1 的 `initialPlan` 与图记录同事务保存，revision 必须相等；旧记录为 NULL 且明确缺失，修订不覆盖。`graph-version-index` 每页至多 20 条轻量 metadata；`graph-head` 精确读取指定 GraphId 的 head；`graph-version-membership` 只返回请求版本追加链上的成员事实。依据范围由 `graph-basis-range` 从指定记录读取，单次至多 64 KiB UTF-8，不能先读取整条历史再切片。
- **schema 17 查询与正文存储**：`graph-version-index` 使用跨 generation 的 keyset metadata；`graph-head` 和 `graph-version-membership` 分别读取精确 head 与追加链成员；`graph-basis-range` 按来源判别联合定位唯一列，以 SQLite BLOB `length`/`substr` 取至多 64 KiB 范围。初始计划保留 JSON 原结构，范围读取不先把整份 JSON 编码进应用内存。代际状态只取登记的 generation row；缺失为 `not_recorded`，不按旧版本或 Scope 当前指针推断为 frozen。
- **历史图与依据**：IC-11 的独立 `GraphBasisPort`（canonical path `src/application/tui/graph-basis.ts`，实现 `src/application/tui/graph-basis-service.ts`）拥有历史版本、拓扑、来源目录和正文范围查询。普通 Controller snapshot 只携当前拓扑。历史图只展示所选版本可证明的节点与 generation 状态，不叠加当前 frontier、Worker、预算或 Validator 汇总。保留的 Orca Task/Dispatch/Attempt 是 Work Package 级来源，属于 `retained_task`；没有版本绑定时不得按时间归属到某 GraphVersion。
- **ProjectDetails 边界**：IC-11 第七批 ProjectDetails 继续以当前 Scope revision 绑定当前身份、工作和批准详情；不可变历史来源由 GraphBasisPort 按 graph/generation/version 或 authorization ID/version 定位，不复用 ProjectDetails 的 `seenRevision` 或快照。历史依据正文与派生布局缓存各限 8 MiB/64 项，导航返回只保存标量来源身份与位置。
- **测试 seam**：纯 Graph Compiler 使用表格 fixture；history 使用 IC-03 adapter；tracker 使用 fake gateway 和显式真实隔离 smoke。

## IC-06 SpecificationProvider、Task Contract 与 Admission

- **Owner (Create)**: `m1-admit-work-package-specifications`
- **Canonical paths**: `src/application/ports/specification-provider.ts`、`src/application/specification-admission.ts`、`src/domain/{task-contract,worker-report}.ts`
- **Extenders (Extend)**: `m1-evolve-execution-graph` 通过同一 provider 区分 Contract Revision 与 Tracking Revision；`complete-tui-graph-basis` 增加可选有界文件目录/范围读取
- **Consumers (Consume)**: Implementation、Validation、Recovery、Graph evolution

```ts
interface SpecificationProvider {
  readUnit(input: SpecificationUnitLocator): Promise<SpecificationUnitSnapshot>;
  readRoleTransition(input: RoleTransitionQuery): Promise<RoleTransitionState>;
  readFiles?(input: SpecificationFileListingQuery): Promise<SpecificationReadResult<SpecificationFileListing>>;
  readFileRange?(input: SpecificationFileRangeQuery): Promise<SpecificationReadResult<SpecificationFileRange>>;
}

type SpecBinding = {
  provider: 'openspec';
  relativePath: string;
  contentDigest: string;
  providerVersion: string;
  contractRevision: number;
  trackingRevision: number;
};

type TaskContract = {
  schemaVersion: number;
  workPackageId: string;
  graphGeneration: number;
  dependencies: readonly string[];
  scopeEnvelope: ScopeEnvelope;
  baselineHead: string;
  authority: RoleAuthorities;
  budget: WorkPackageBudget;
  acceptanceEvidence: readonly EvidenceRequirement[];
  resultSchemaVersion: number;
};
```

Provider 只读取工具原生 unit 与角色转换，不写业务状态、不做 plugin registry。Spec Binding 路径只用于定位，身份由内容摘要和版本确定；Tracking Revision 也生成新 snapshot，但不改变 contract content。Admission 校验结构、版本、Scope、authority、预算和绑定，不宣称语义完整。

IC-11 图依据读取可选使用 `readFiles` 与 `readFileRange`。调用必须沿已记录的 `workPackageId`、`orcaTaskId`、原 `SpecificationUnitLocator` 和 `contractRevision` 绑定到同一原生 unit；目录来源 ref 同时携 task/package/locator，范围读取校验 locator、路径与已见 `sourceVersion`。tracking revision 单独显示，不使 contract binding 失效。路径越界、来源改变或 provider 缺少读取能力时返回结构化拒绝/过期状态，不选择“最新”工件。

- **失败**：越界、stale binding、未知 provider version 或缺工件时阻塞并保留 worktree；不消耗实现预算或自动清理。
- **测试 seam**：OpenSpec adapter 使用临时 worktree fixture；Application admission 经 `SpecificationProvider` fake 测试同一 interface。

## IC-07 Worker Harness、Task Envelope、Session Binding 与候选报告

- **Owner (Create)**: `m1-admit-work-package-specifications`
- **Canonical paths**: `src/application/ports/worker-harness.ts`、`src/bootstrap/worker-harness.ts`、`src/adapters/agents/`、`src/domain/{task-envelope,worker-report,worker-liveness}.ts`
- **Extenders (Extend)**: `add-worker-harness-adapters` 增加显式注册表与逐 harness 的精确会话证明；Recovery 只新建符合该合同的 Dispatch/Session Segment
- **Consumers (Consume)**: Execution、Validation、Recovery、Graph evolution

```ts
type TaskEnvelope = {
  schemaVersion: number;
  workerTaskId: string;
  dispatchId: string;
  attemptId: string;
  role: WorkerRole;
  taskContract: TaskContract;
  specBinding: SpecBinding | null;
  specificationUnitPath?: string;
  /** 宿主写出的角色指令（Worker 只读，不参与身份判定）；没有额外指令时为空数组。 */
  instructions: readonly string[];
  workspace: WorkspaceBinding;
  authority: RoleAuthorities;
  budget: WorkerBudget;
  expectedEvidence: readonly EvidenceRequirement[];
};

type SessionBinding = {
  harness: string;
  role: WorkerRole;
  workerTaskId: string;
  dispatchId: string;
  attemptId: string;
  providerSessionId: string;
  transcriptRef: string;
  runtimeRoots: readonly string[];
  observedAt: string;
};

type WorkerLiveness = 'live' | 'exited' | 'unverifiable';
type WorkerReport = WorkerResult | WorkerQuestion | WorkerEscalation;
```

Planner 首次派发固定 `specificationUnitPath` 并将 `specBinding` 置空：路径名由 Work Package 身份派生为**文件系统安全**的 slug（非字母数字字符折成 `-`）加 8 位内容哈希后缀，因此跨平台可写、人能照着写、不同 Work Package 不会撞名；百分号编码不可用（Worker 会自然写成解码后的形式，真实运行里正因此错过了固定路径）。Envelope 的 `instructions` 由宿主按角色写出，Planner 必须收到三条产出纪律（写在固定路径、单元必须含 `specs/`、不得自行归档或改名）——真实运行里 Planner 两次自选路径或漏写 `specs/`，Admission 只能 fail closed，因此位置与结构必须由 Envelope 明示而不是留给 Worker 猜。指令是正文，不是身份：回传的镜像不参与任何判定。其完成后宿主用精确 Session Binding 和该路径执行 Specification Admission。Implementation/Validator 的 `specBinding` 必须是 Admission 接纳的内容身份。`SpecificationProvider` 按工具原生布局解析该路径：change 仍活跃时读活跃目录，被工具按自身惯例归档（OpenSpec 的 `changes/archive/<date>-<name>`）后读同名归档目录，同名匹配不唯一或不存在即拒绝，绝不挑选。定位变化不改变单元身份——身份仍是内容摘要与两个 revision，Binding 记录宿主声明的规范路径。角色工件转换状态同样按该固定路径读取，不按「worktree 内唯一活跃 change」猜测。可选的独立规格质量门只在明确启用时增加审阅 Worker。Task Envelope 中的 scope、Run、consumer generation、OperationId 与协调身份由 Controller/adapter 注入，不接受 Worker 回传值覆盖。Session Binding 必须来自精确 harness 能力；terminal 输出、cwd、mtime 和“最新 transcript”不能作为绑定。Worker report 是候选载荷，边界 parser 先做 schema/role/version 校验。WorkerHarness 启动输入不含 CredentialStore、凭据路径或可覆盖原生环境的隔离 root：launch 只指定 Companion 工件目录，resume 的 `expectedNative` 只用于核验；端口另提供逐 harness 的原生模型目录有界查询。

Session Segment 记录角色、Task、Dispatch、Attempt、Binding、最后 transcript 位置与可核验终态。信息不足时 liveness 为 `unverifiable`，不能推断退出或触发重复派发。

- **测试 seam**：Worker Harness Adapter contract tests 覆盖 codex、claude、opencode、pi、omp 五个注册项的合同（使用托管 hook/HTTP fixture），并指定四个隔离 probe（claude/opencode/pi/omp 各自的批准模型）在显式隔离项目中验证精确 binding；只有实际运行产生的 artifact（hook/extension 报告、精确 transcript、真实 usage）才计入验证结论，未运行的 probe 如实记录为未验证，不得据此写全 PASS。领域层测试 Task Envelope parser 和三值 liveness。

## IC-08 Delivery settlement、Validation 与 Finalizer

Worker Harness 注册项为 codex、claude、opencode、pi、omp。各角色、Recovery Utility 与 Validator 集成续接使用已固定 profile 的 harness；结果结算不按当前默认 harness 解释历史。注册实现返回已有 PreparedTerminalStrategy，创建、激活、Orca 接管及 unknown 对账仍由既有用例拥有。Validator 续接与集成续接真正需要重新 launch 时使用注册项的 `prepareResume`（精确 session 身份），沿用原 Task/Dispatch/Attempt、原绑定与预算；不需要重新 launch 的恢复只重观察原 terminal。原生只读 Finalizer 与 Utility 的启动和探针共享 bwrap 包装器；包装器仅开放真实 native state 目录与 Companion 工件目录，仓库、Git、Git common dir、coordination.sqlite 与 checkpoints.sqlite 拒写，可写根与拒写根重叠且无法证明时不可用。

- **Owner (Create)**: `m1-execute-and-validate-work-packages`
- **Canonical paths**: `src/application/delivery/process-delivery.ts`、`record-worker-result.ts`、`src/application/validation/`、`src/application/finalization/`
- **Extenders (Extend)**: `m2-wire-execution-runtime` 增加 Delivery 载荷的两条入口形状（Companion 形状与 Orca 规范形状）；`m1-recover-execution` 启动时调用同一 pipeline 重放
- **Consumers (Consume)**: Recovery、Graph evolution、ControllerService/TUI

```ts
type DeliveryIdentity = {
  runId: string;
  consumerGeneration: number;
  deliveryId: string;
  workerTaskId: string;
  dispatchId: string;
  attemptId: string;
};

type AcceptedWorkerResultRef = {
  delivery: DeliveryIdentity;
  orcaResultRef: string;
  role: WorkerRole;
  contractRevision: number;
  acceptedAt: string;
};

type DeliveryVerdict =
  | { kind: 'deliverable'; evidenceRefs: readonly string[] }
  | { kind: 'blocked'; blockerRefs: readonly string[] };
```

正常 pipeline 固定为 FLOW-03：read without ack → identity/version validation → dedupe → Orca accept/readback → local dedupe/ref/readback → ack。旧 generation/attempt 只补历史引用，不能推进当前 lifecycle。Accepted Worker Result 正文只归 Orca；本地不保存正文。

Delivery 消息的载荷有两条登记形状，归属的**唯一**权威都是 Companion 自己的记录：

- **Companion 形状**：载荷带 `result` 正文与全套归属字段（`workerTaskId`/`dispatchId`/`attemptId`/`role`/`runId`/`consumerGeneration`/`graphGeneration`/`authorizationId`/`specBinding`/`worktreeId`），逐项与已记录的 Session Segment / 物化绑定核对。
- **Orca 规范形状**（真实 Codex Worker 实际投递的 `worker_done` 载荷）：只带 `taskId`/`dispatchId`/`outcome`/`filesModified`，叙述在消息 `body`。这种消息只作为 **locator**：`materialization_bindings.orcaTaskId` 定位 Orca Task 与角色，Session Segment 按 Orca Dispatch 定位同一次派发，两者必须逐项一致（Work Package / 角色 / Attempt / Task），任一不一致或定位不到即阻塞。归属字段由解析出的记录重建，结果正文归一化为 `{ outcome, filesModified, summary }` 后写回 Orca Task 并回读核验——不要求 Worker 回显 Companion 身份。

Validator 在同一 Validation Attempt/真实 Session 内验证、范围内修复、复验；代码变化使受影响 Evidence Record 失效。`src/application/run-validation.ts` 拥有步骤顺序和修复准入，`src/bootstrap/validation-runtime.ts` 将步骤接到原 Task/Dispatch/Attempt 的 `orca orchestration ask/reply` 通道。Worker 按 Envelope 明示的 typed JSON 提交步骤并等待宿主许可；修复先按稳定 stepId 持久准入及扣预算，再回复许可。许可前核验精确 worktree 干净，将固定 HEAD 保存于原答复 Intent；修复后以该 HEAD 回读提交、暂存、未暂存和未跟踪路径，联合 Worker 报告核验范围并使证据失效。基线缺失或 Git 事实不可读即停止。`validation_attempts` 只保存固定 Session 身份、不可变的初始有效修复消耗、有序消息引用（最多 20 项）和终止许可问题引用；消息正文仍由 Orca 拥有。恢复按原顺序从有界 inbox 回读引用，缺失即阻塞，步骤重新核验精确 transcript 与该次 SessionStart 身份。成功结算要求原 Attempt 的 finish 答复已确定受理，重放不重扣修复预算。普通提问经 Wake admission 处理，步骤报告经确定性 Validator 通道处理，两者都在写入消费证明后才确认整批 Delivery。

Finalizer 使用新只读项目级 Session，从当前 Run 的成功角色结算与完整 push 意图读取项目依据，项目级绑定的 Spec Binding 为 null。结果要求精确 Task/Dispatch/Attempt、发送者与 canonical 工作区只读证明；先记录 Verdict，再写 Orca Accepted Result 与本地 settlement，读回后确认 Delivery，最后准入交付 Wake。恢复缺少原运行的只读证明时保持阻塞。

- **失败/幂等**：任何持久化或回读 unknown 都不 ack；重放同一 DeliveryIdentity 不产生第二正文或生命周期推进。
- **测试 seam**：fake transport + fake Orca result store 覆盖每个崩溃窗口；真实隔离闭环验证 transport 契约而非故障注入。

受控 Git 集成是同一 Owner 的副作用 pipeline：`GitIntegrationPort` 接受交接提交、canonical 快进、推送，以及包内合并 canonical 与合并提交；生产实现（`src/adapters/git/integration.ts`）只以 argv 数组与显式 cwd 调用 `git`，不经 shell，不 force-push、不 reset、不 rewrite 历史。

宿主、执行投影与 CLI 使用同一 `completedIntegrationRef`：仅当前 Scope/Graph Generation/Work Package 的 push 意图 settled/accepted 才表示完整集成。部分步骤在重启后沿原 OperationId 回读并继续，Finalizer 不得以部分步骤通过集成门禁。

```ts
type GitStepRequest = {
  step: GitIntegrationStep;
  workPackageId: WorkPackageId;
  sourceWorktreePath: string;   // 精确 Worker worktree
  branch: string;
  remote: string | null;
  ref: string | null;
  expectedHead: string;
  commitMessage: string | null;
};

type GitReadbackTarget =
  | { kind: 'source'; worktreePath: string }
  | { kind: 'canonical' }
  | { kind: 'remote'; remote: string; ref: string };

type GitIntegrationPort = {
  run(request, scope: ExecutionScope): Promise<GitStepOutcome>;
  reconcile(request, scope: ExecutionScope): Promise<GitStepOutcome>;  // 只按同一 OperationId 对账，不创建新操作
  readHead(target: GitReadbackTarget): Promise<GitHeadRead>;           // 只读回读指定目标的 HEAD
};

type IntegrationWorkspace = { canonicalWorktreePath: string; workPackageWorktreePath: string };
```

分目标读回：每步只核验自己的目标——`commit` 在 `sourceWorktreePath` 核验并回读 source HEAD，`integrate_canonical` 在 canonical worktree 核验并回读 canonical HEAD，`push` 核验 canonical HEAD 后回读获批 `{ remote, ref }` 的目标 commit。回读不可用或与步骤自报 HEAD 不一致时阻塞该 lane；步骤 `unknown` 保持原 OperationId 对账，不换 ID 重试、不继续后续步骤。`commit` 步接受**真实 Worker 已自行提交交接成果**的情形：source HEAD 不等于所记录 expected HEAD 时，只在能证明它是 expected HEAD 的后继（`merge-base --is-ancestor`）时才按「已经提交」继续，否则仍以 `source_head_mismatch` 拒绝——历史被替换或改写过的 HEAD 不会进入集成。Finalizer 的运行前后工作区事实（HEAD、index revision、dirty paths）由 `readWorkspaceFacts` 从目标 worktree 只读产出。

既有 pending/blocked Git 意图只调用 `GitIntegrationPort.reconcile`，沿用原 OperationId 与持久化 expected HEAD；结果与目标回读一致后才结算或解除阻塞。push 对账同时核验 canonical HEAD 等于原 expected HEAD、获批 remote/ref 指向同一 commit，不能把后来产生的 HEAD 归到原操作。

`openspec/` 是 **Specification Pipeline 流程目录**，包含工具原生 Specification Unit、归档、主规格与工具配置：Planner 在这里创建单元，后续角色勾选任务，工具维护配置，因此它们不参与 Scope Envelope 越界判定。普通 Worker 与集成复验统一使用 `envelopeCheckedPaths`；单元身份仍由内容摘要与 Spec Binding 约束。

`dirtyPaths` 里属于 Worker Harness / agent 工具状态目录（`.agents/`、`.codex/` 等）的路径不是项目改动：它们既不构成 Scope Envelope 越界证据，也不让 canonical 工作区被算作「不干净」，更不参与 Finalizer 的运行前后比较——工具自己写技能、报告与会话材料是正常行为。项目路径仍然必须落在 Scope Envelope 内。该规则只有一处实现（`projectChangedPaths`），越界判定、canonical 干净性与 Finalizer 比较都走它。

## IC-09 Recovery、Scope control 与 Execution Handoff

原 Session 的 harness 从原物化绑定的授权版本和 profile 读取。各注册项通过精确 transcript 重新证明 provider session；仍存活的 exact Worker 只重观察原 terminal/session，保持原 Session/Segment，不创建 Dispatch、不消费 Recovery Budget，也不登记新 Segment。已退出或身份不可证明时才走原替代路径：新建替代 Dispatch/Binding/Segment，并按原规则消费 Recovery Budget。真正需要重新 launch 时精确 resume 使用 Claude UUID、OpenCode session id 或 pi/omp 完整 session path（注册项 `prepareResume`），沿用原启动报告的 runtime roots，`expectedNative` 只核验不覆盖，随后重新证明同一身份。Capsule 覆盖证据由原 harness 的 transcript inspector 提供，Utility 自报不能覆盖它；恢复、修复及集成续接保持原 Attempt、授权和预算。

- **Owner (Create)**: `m1-recover-execution`
- **Canonical paths**: `src/application/recovery/`、`src/domain/recovery/`、`src/application/coordination/scope-control-service.ts`、`src/application/handoff/execution-handoff.ts`
- **Extenders (Extend)**: `m2-wire-execution-runtime`（前台宿主的 Recovery 事实装配与回执解释的异步 seam）
- **Consumers (Consume)**: Graph evolution、ControllerService、execution TUI

```ts
type RecoveryState = {
  recoveryId: string;
  workerTaskId: string;
  businessAttemptId: string;
  sourceSegmentId: string;
  replacementDispatchId?: string;
  replacementSegmentId?: string;
  status: 'pending' | 'recovering' | 'recovered' | 'blocked' | 'cancelled';
  consumedBudget: number;
  capsuleRef?: string;
};

type RecoveryCapsule = {
  coverage: 'complete' | 'partial';
  readableRange: TranscriptRange;
  gaps: readonly TranscriptGap[];
  lastCompleteEventRef?: string;
  openActions: readonly OpenAction[];
  sourceRefs: readonly string[];
  unknowns: readonly string[];
};

type ExecutionHandoffState = {
  handoffId: string;
  sourceSessionId: string;
  targetSessionId: string;
  graphGeneration: number;
  responsibilitySet: readonly HandoffResponsibility[];
  phase: 'prepared' | 'reviewed' | 'cutover' | 'cancelled' | 'blocked';
  expectedRevision: number;
  coordinatorContextCapsuleRef?: string;
};
```

Worker Session Recovery 先尝试精确恢复原 session：仍存活时只重观察并重新证明同一身份，不产生新 Dispatch/Segment，也不消费 Recovery Budget；仅确认退出或不可恢复后才创建替代 Dispatch/Binding/Segment，并保留 Worker Task、contract/revision 和业务 Attempt。Recovery Budget 按 Worker Attempt 创建替代 Segment 时消费，重启不重置。`salvage` 只指 Utility Worker 从精确 Worker transcript 提取 Recovery Capsule 的动作；它不是生命周期或角色。

前台宿主的 Recovery 事实来源固定为：中断归属由原 harness 的精确 transcript 或公开 session metadata 重新读出（provider session 身份不从 `worker-show` 猜），存活由 `worker-list` + `terminal-list` 的列举判定，workspace 由 `worktree-list` 的归属注释 + `readWorkspaceFacts` 的真实 HEAD 对账，原会话终态只认已结算的 Orca 结果，替代派发复用注册项的 prepared-terminal 策略并要求 `worker-start` 回执与 harness 会话证明共同确认精确 Binding（回执解释因此是异步 seam）。任何一项读不到都返回结构化 `unavailable` 并保持未决，不把「没读到」读成「已退出」或「已恢复」。Recovery Capsule 的正文只能由受限 Utility Worker 经 IC-08 Delivery pipeline 回到应用层；精确 transcript 不可用时以 `transcript_unavailable` 阻塞。

Session Binding 的补记（schema 12 的 `launchId` + 每次触发对「已派发未绑定」角色的重读）在 Recovery 判定之前执行：只有绑定成立之后，「这条会话有没有结果」才有可判定的归属。

补记必须同时匹配角色、WorkerTask、业务 Attempt 与当前 Orca Dispatch；相同 Attempt 的原 Segment 不能证明替代 Dispatch 已绑定。原 launch 的 SessionStart 报告仅在 Orca Task 与 Dispatch 记录能够证明原派发身份时用于补记；替代 Session 由 Recovery 保存的精确 Binding/Segment 证明。原派发报告缺少这种证明时保持未绑定，不把旧 Session 绑定到新 Dispatch。

原生 Worker 回报的身份读取共用 `bootstrap/execution-runtime.ts` 的 locator。带 `_orcaLifecycleRejection` 的 Orca 消息仅是被拒绝回报的诊断，不提供可结算结果或 Finalizer Verdict；随后有效回报仍需完整匹配 Task、Dispatch、角色与证据合同。

角色 Task 的物化读取按 `MaterializationBindingRecord.identity` 判定 `legacy` 缺身份记录并阻塞；`issued` 的 Recovery Utility 绑定以 `recoveryUtilityRole` 证明辅助角色，不能因四主角色列 `role:null` 误判为旧记录。Utility 绑定不被复用为主角色 Task。

「会话丢失」必须由事实证明，只有两条入口可以启动或续办 Recovery：**未确认 Delivery 里没有这条 Dispatch 的结果**（结果还挂在 Orca 的 Delivery 上时会话并没有丢，结算那条 Delivery 才是它的正常完成路径；未确认 Delivery 读不到时不启动），且**同角色同业务 Attempt 还没有已接受结果**。反过来说，一条非终结的 Recovery 在原会话结果已结算后前提即不成立：续办路径 SHALL 以 `recovered` + `source_completed` 收口并 supersede 原 Segment，而不是为一条已经交付的会话再派 Utility Worker，也不占住替代派发 lane。

Recovery Capsule 与 Coordinator Context Capsule 不相同。Finalizer 不依赖 Recovery Capsule，而从权威输入重跑。Pause/Resume/Cancel/Exit 是 Scope 正交控制状态。Execution Handoff 遵循 FLOW-04，不复用 PlanningHandoffProposal，也不把 suspend/Wake 当作责任转移。

- **失败**：transcript 不可用、预算耗尽、角色门失败或 cutover CAS 失败时保持 blocker/Source owner；不伪称原 session 连续恢复。
- **测试 seam**：fake Utility Worker、fake backend 与临时 stores 覆盖 complete/partial/unavailable、迟到结果和 cutover 崩溃；生产事实装配用脚本化只读查询 + 一次性 Git 仓库 + 真实 rollout 文件验证（`tests/bootstrap/execution-delivery.test.ts`），真实隔离测试只验证一次 partial transcript Recovery。

## IC-10 Graph evolution、Replanning 与 Generation Cutover

- **Owner (Create)**: `m1-evolve-execution-graph`
- **Canonical paths**: `src/domain/execution/`、`src/application/execution/`，并 Extend `src/application/planning/graph-history.ts`
- **Extenders (Extend)**: 无
- **Consumers (Consume)**: ControllerService、execution TUI、Finalizer input projection

```ts
type GraphPatch = {
  baseGraphVersion: number;
  operationId: string;
  add: readonly NewWorkPackage[];
  revise: readonly WorkPackageRevision[];
  retire: readonly WorkPackageId[];
};

type GenerationCutover = {
  predecessorGraphId: string;
  candidateGraphId: string;
  candidateGeneration: number;
  candidateRunId: string;
  authorizationId: string;
  baselineHead: string;
  expectedRevision: number;
};
```

Graph Patch 原子执行 `add + revise + retire`：add 新 ID/worktree，revise 保持未接受 WorkPackageId/worktree 并追加 Graph Revision，retire 只移出未接受节点。已派发节点先进入 revision pending，运行至可核验终态后再修订。Retry Attempt 不改 Task Contract 或 revision，只创建新 Dispatch/Attempt。

`GraphChangeRequest.changeInstruction` 是必填的非空业务说明，最多 4,000 个 Unicode 码点，由 `change-routing.ts` 定义唯一上限与校验。Coordinator tool schema/parser 和 `requestGraphPatch` 在副作用前核验，完整说明经现有 DTO 接线传到 `graphPatchPlannerInstruction`；原分类声明与权限规则保持原合同，分类器不读取说明。该文本不能提供可信 Scope、Run、OperationId 或其他执行身份。

Replanning 停止新派发并结清在途/Delivery/Interaction/Intent，建立新 Planning Cycle；Generation Cutover 同批切换 Planning Cycle、GraphId/Generation、Run、Authorization、budget ref 和 Execution Lease。旧完成状态不复制，旧成果只按 Baseline Adoption、Migration Material 或 Planning Reference 进入新规划。

前台 Controller 与 Coordinator 语义工具共用 begin/complete/cancel 入口；结清条件由当前 Run、Worker、Delivery、Interaction 和 Intent 事实派生。新 Cycle 提交后，以稳定 Cycle 身份准入 `replanning_ready` Wake。批准带 predecessor 的候选图必须走 Generation Cutover，事务中冻结前代并取得新代际 Execution Lease。取消只在完整审阅并重新批准挂起代际的原 Manifest、保持原 Run/任务/预算且对账完成后恢复；默认审阅新 Cycle 的候选，显式 `suspended_generation` 审阅恢复依据。恢复前经原 OperationId 选择并读回原 Orca Run，unknown 不换身份重发。

`src/bootstrap/plan-continuations.ts` 在建立候选 Run 前回读旧图成员、Orca Accepted Worker Result 摘要、已结算 push 意图与真实 Git 基线关系；任一声明不可证明即停止。Baseline Adoption 的集成 commit 必须属于候选基线且其影响路径保持适用；Migration Material 的引用进入新 Task Envelope 的只读输入，新包仍以新 worktree 开始并独立验收。Lineage 使用旧责任的有效累计消耗，不接受计划自填计数。

- **失败/版本**：所有 patch 以 baseGraphVersion + expected revision + OperationId 提交，任一步失败不追加 history；Cutover 前可取消，Cutover 后前代永久冻结。
- **测试 seam**：纯 compiler/patch normalization 使用表格测试；history/CAS 使用 IC-03；真实 Orca 只验证隔离候选 Run binding。

## IC-11 ControllerService、Snapshot、SemanticEvent 与用户 intent

命令结果引用由 `src/application/tui/command-result.ts` 拥有；`accepted` 与 `unknown` 可携带 `resultRef`。闭合引用覆盖 Scope 控制、Session 模型绑定、规划/执行交接与授权，宿主从确定写入/回读产生 ID 和版本。`TuiPorts.commandStatus(ref)` 校验 schema 和绑定 Scope，精确读取原记录。交接必须匹配记录 revision/phase，Scope/模型绑定须匹配产生结果时的 Scope revision；后续写入覆盖事实后保持 unknown。授权按 ID/version 读取原记录。引用证明已记录事实，不证明 Worker 完成或整个执行成功。UI 的 `refreshFailed` 单独表达已受理后的展示读取失败，保留受理事实和原输入；防重发覆盖精确读取与刷新，核验只重读状态。压缩没有独立调用结果身份；无可证明引用的异常保持不可核验。

`ModelCatalogPort.load(SessionId)` 精确读取当前 Scope 的该 Session，不替换为规划责任方。交接 `prepare` 返回本次 ID；`read(id)` 复用 Controller 投影；`cutover/cancel(id, expectedRecordRevision)` 校验用户所见提案版本。规划接收方异步读取事实后、review 写入前重验版本，cutover 仅沿用本次 review 的返回版本。授权审阅字段由宿主投影为 `ReviewSection[]`，批准仍只回传 fingerprint 与 Scope revision。

`render-bounded-transcript` 的生产 TUI 使用独立 `session-history`、`transcript-body`、`transcript-previews` 查询。`TranscriptReadingPort` 的 DTO 与运行时 schema 位于 `src/application/coordinator/history.ts`：history 来源绑定 entryId/revision=1，preview 来源绑定可信 previewId/append revision；offset/end 为 UTF-8 字节位置。宿主每次核验当前 Scope 的 Session 登记。metadata 最多 100 项/64 KiB，body 每次最多 64 KiB；折叠工具只读 metadata。

临时预览仅属于当前 Runtime。旧 append revision 表示同一临时文件的固定前缀，pin 只保留引用；committed 后离底阅读仍保持旧来源，显式返回最新才换成正式历史。容量/存储故障明确不可用，未接受响应不写 checkpoint。`subscribe` 只通知 Session 来源失效，合并更新；预览不进入 SemanticEvent、输入存储或 Wake。正文/布局缓存各 8 MiB/64 项，有限上下文和位置结构计入布局额度；请求代际丢弃迟到响应，失败保留旧 frame。

`paginate-coordinator-history` 扩展 transcript reader：`null` 读取最新片段，`oldest` 通过首序号直达最早；其余游标为经 schema 核验的 `[SessionId, sequence, byteOffset, direction]`，跨 Session 拒绝。`ControllerTranscriptPage.nextCursor` 指向更早原文，`newerCursor` 指向更晚原文；message 携带稳定 `entryId`、sequence、offset/end 与总 byteLength。每页至多 100 条、64KiB 原文，巨型单条可跨页完整读取。正文权威和范围限额由 IC-04 拥有，Controller 与 TUI 不复制历史。

- **Owner (Create)**: `m1-recover-execution`
- **Canonical path**: `src/application/controller-service.ts`
- **Extenders (Extend)**: `m1-evolve-execution-graph` 增加图 patch/replanning projection 与 command variants；`m1-wire-foreground-planning-runtime` 增加提交身份、回答正文与事件归属；`m2-deliver-planning-tui` 增加候选图拓扑、压缩状态与规划交接提案投影；`m2-deliver-execution-tui` 增加执行投影、Finalizer 与执行交接投影；`m2-wire-execution-runtime` 增加有界的 Execution Authorization 命令（propose-graph / review / approve），不新增快照字段
- **Consumers (Consume)**: CLI、planning TUI、execution TUI

```ts
interface ControllerService {
  query(input: ControllerQuery): Promise<ControllerQueryResult>;
  execute(input: ControllerCommand): Promise<ControllerCommandResult>;
  subscribe(listener: (event: SemanticEvent) => void): Unsubscribe;
}

type ControllerQuery =
  | { kind: 'snapshot'; coordinationScopeId: string; selectedSessionId?: string }
  | { kind: 'session-transcript'; coordinatorSessionId: string; cursor?: string }
  | { kind: 'session-history'; query: HistoryPageQuery }
  | { kind: 'transcript-body'; query: TranscriptBodyQuery }
  | { kind: 'transcript-previews'; coordinatorSessionId: string }
  | { kind: 'submission-status'; coordinationScopeId: string; query: SubmissionQuery }
  | { kind: 'pending-interactions'; coordinationScopeId: string; coordinatorSessionId: string; after?: InteractionPageCursor }
  | { kind: 'pending-interaction'; coordinationScopeId: string; coordinatorSessionId: string; interactionId: string };

type ControllerCommand =
  | SendSessionMessage
  | CompactSession
  | SwitchModelConfiguration
  | PlanningHandoffCommand
  | ScopeControlCommand
  | AnswerPendingInteraction
  | ExecutionHandoffCommand
  | GraphEvolutionCommand;
```

`ControllerSnapshot` 只包含已验证的领域/控制投影和外部事实引用：Scope/mode/control/revision、Session summaries、budgets、graph/frontier、Worker/liveness、blockers、Pending Interactions、handoff/recovery/maintenance 状态，以及下面两项 planning TUI 只读投影。它不携带 receipt、Accepted Worker Result 正文、provider object、credential 或任意 adapter handle。

`m2-deliver-planning-tui` 的 Extend 只增加三个投影字段，不改变任何既有字段的形状与语义：

```ts
type ControllerGraphNodeView = {
  workPackageId: string;
  title: string;
  dependsOn: readonly string[];
  scopeEnvelope: { include: readonly string[]; exclude: readonly string[] };
};

type ControllerGraphReadinessView = {
  /** 该图所属代际的当前状态；没有登记代际时为 null。 */
  generationStatus: GraphGenerationStatus | null;
  /** 已批准的 Execution Authorization 是否仍覆盖这张图（同一 GraphId，且绑定版本仍在追加链上）。 */
  authorizationBound: boolean;
};

type ControllerGraphTopologyView = {
  graphId: string;
  graphVersion: number;
  generation: number;
  nodes: readonly ControllerGraphNodeView[];
  readiness: ControllerGraphReadinessView;
};

type ControllerCompactionView = {
  status: 'not_needed' | 'compacted' | 'compaction_degraded' | 'context_exhausted';
  path: string | null;
  reason: string | null;
  stillOverBudget: number | null;
};

type ControllerPlanningHandoffView = {
  proposalId: string;
  sourceSessionId: string;
  targetSessionId: string;
  phase: PlanningHandoffPhase;
  mapRevision: number;
  planRevision: number;
  capsuleRef: string | null;
  proposalRevision: number;
};

type ControllerSnapshotExtend = {
  /** 当前 GraphId/Generation 的拓扑投影；历史图由独立 GraphBasisPort 按需精确读取。 */
  graphTopologies: readonly ControllerGraphTopologyView[];
  /** Session checkpoint 中最近一次压缩结论的只读投影；从未压缩时为 null。 */
  compaction: ControllerCompactionView | null;
  /** Route Planning Handoff 提案投影；确认与取消仍走既有 PlanningHandoffCommand。 */
  planningHandoffs: readonly ControllerPlanningHandoffView[];
};
```

`graphTopologies` 与 `compaction` 都由调用方从权威来源读好后注入 `ControllerSnapshotFacts`；façade 不读 store、不推断、不补全。它们是**投影**而非新的权威状态：`/compact` 的准入、执行与终止仍属于 Coordinator Runtime，本 facade 不新增执行路径。

`m2-deliver-execution-tui` 的 Extend 把执行阶段事实并入**同一** `ControllerSnapshot`，不新增第二份快照、也不新增事件通道：

```ts
/** 原为 { workPackageId, status: string }；现在承载完整执行投影。 */
type ControllerFrontierEntry = {
  workPackageId: string;
  /** 闭集：waiting|admitting|specifying|implementing|validating|repairing|waiting_integration|
   *  reconciling|revision_pending|blocked|unknown|accepted|retired|cancelled */
  state: WorkPackageExecutionState;
  role: WorkerRole | null;
  attemptId: string | null;
  /** 与生命周期分列：执行主机无法核验时是 'unverifiable'，绝不读作已退出。 */
  liveness: WorkerLiveness | null;
  worktreePath: string | null;
  baselineHead: string | null;
  validation: {
    state: 'validating' | 'validated' | 'rejected' | 'blocked' | 'unknown';
    acceptedResultRef: string | null;
    evidenceRefs: readonly string[];
  } | null;
  integration: {
    state: 'waiting' | 'integrating' | 'integrated' | 'blocked' | 'unknown';
    ref: string | null;
  } | null;
  /** 推出该状态所依据的持久事实引用；为空数组表示没有可用依据。 */
  derivedFrom: readonly string[];
  blockerRefs: readonly string[];
};

type ControllerSnapshotExecutionExtend = {
  finalizer: {
    gate: { ready: boolean; blockers: readonly string[] };
    coversWorkPackageIds: readonly string[];
    worktreePath: string | null;
    readOnlyProfile: 'enforced' | 'unenforceable' | 'unverified';
    integrationFrozen: 'frozen' | 'unknown';
    workspace: {
      before: { head: string; indexRevision: string; dirtyPaths: readonly string[] };
      after: { head: string; indexRevision: string; dirtyPaths: readonly string[] };
    } | null;
    evidenceRefs: readonly string[];
    verdict: { verdictId: string; kind: 'deliverable' | 'blocked'; refs: readonly string[] } | null;
  };
  /** 「重启先对账」的门：pending 为真时界面不显示任何可推进状态。 */
  executionReconciliation: {
    pending: boolean;
    unresolvedIntentCount: number;
    activeWorkerCount: number;
    reasons: readonly string[];
  };
  /** 扩展字段：workPackageId/businessAttemptId/consumedForAttempt/budgetLimit/remainingBudget/
   *  capsule/supersededSegmentId/acceptedResultRef；仍只保存引用，正文留在 Orca。 */
  recoveries: readonly ControllerRecoveryView[];
};
```

派生规则是纯函数，canonical path 为 `src/application/execution/execution-view.ts`（Owner: `m2-deliver-execution-tui`）：输入是 IC-03 快照、当前 GraphVersion 的节点与调用方读到的 Orca 只读观察，输出上面的投影。每个状态都带 `derivedFrom`；推不出确定结论时停在 `unknown`；`finalizer.gate` 复用 `planFinalizerDispatch` 的判决，只有被接受的 Delivery Verdict 才呈现 deliverable。

修订会换掉这份契约，因此「哪些角色结果还算数」由修订持有决定，规则只有一处实现（同一 canonical path 的 `currentContractSettlements`），只读 Frontier、宿主的 Git 集成资格与 Finalizer 门禁共用它：持有仍 `pending` 时该节点的角色结果不构成任何推进证据（集成与 Finalizer 门禁因此不成立，节点显示 `revision_pending`）；持有已 `released` 时只认**本次持有登记之后签发**的物化绑定所产生的结算——边界取登记时刻而不是内容版本，因为只改契约的修订（例如依赖）与 Planner 原样交付的内容在版本上与旧链无法区分，却同样要求角色链重跑；`admitted_contract_revision` 仅记录本次接纳的内容版本。被替换版本与本次之前的结算保留为历史但不再是证据——旧 Validator 的通过不得冒充新修订已完成。从未有过持有的节点不设边界，沿用全部结算。`src/domain/dispatch-candidate.ts` 的 `DispatchCandidateFacts.revisionPlanner` 是这条冻结上唯一的例外：在途修订节点在满足 `revisionPlannerFacts` 的全部条件后允许**一次** Specification Planner 派发（许可携带匹配的持有来源），其余角色与后代继续被挡住。

生产装配（`src/bootstrap/foreground-planning-runtime.ts`）在 Execution Coordination 模式下读取当前 Run 的 worktree、Worker 与 Delivery 事实，执行启动对账，并按受控工具意图单步推进 Frontier。Task 物化、Worker 派发、Delivery 结算、集成与 Finalizer 由各自应用用例执行；UI 只读投影和提交用户意图。`ScopeControlCommand` 接到 `createScopeControlService`：Pause 落盘，Resume 先对账再恢复，Cancel 保存意图并按 exact Worker stop verdict 决定已停止或不可核验；同一服务的 `reconcile` 只对账并重放未确认 Delivery、不改变控制状态，供需要「Run 静止且 Delivery 已结清」的受控操作（图修订请求）在等待期复用同一个对账用例。`ExecutionHandoffCommand` 接到 `src/application/handoff/execution-handoff.ts` 的四个用例，不经过 `PlanningHandoffProposal`。

`m2-wire-execution-runtime` 的 Extend 增加一条有界的授权命令与对应端口，不新增快照字段、不改既有命令语义：

```ts
/** ControllerScopeFields = { coordinationScopeId, writer }；scope 与写入者由宿主补齐。 */
type ExecutionAuthorizationCommand = ControllerScopeFields &
  (
    | { kind: 'execution-authorization'; action: 'propose-graph'; plan: unknown }
    | { kind: 'execution-authorization'; action: 'review' }
    | {
        kind: 'execution-authorization';
        action: 'approve';
        fingerprint: string;
        expectedRevision: Revision;
      }
  );
```

`propose-graph` 只接受 Coordinator 提出的结构化 Implementation Plan：世代、空 Orca Run、OperationId 与预算上限由宿主从权威事实补齐——`run-create` 先落 Operation Intent，再按专用协调身份读回 Run，结果不可判定时保持未决并沿用同一 OperationId 对账。`review` 是只读的：宿主从 Scope、候选图记录、世代记录、Git 身份与版本化项目配置组装完整 Manifest，返回 Manifest 正文、内容指纹、候选图引用、Scope revision 与门禁判决。`approve` 只携带该指纹与用户看到的 Scope revision：宿主重读全部权威输入、比对指纹、写入批准记录、以刚写入的授权重判门禁后同事务切换；指纹不符时零写入且不派发。这三条命令都不接受调用方提供的 scope、Run、consumer generation 或 operation identity。

Execution Authorization Manifest 的长期字段（Worker Profile 及其 `modelSelection`、Recovery Utility Profile、角色权限、预算上限、Git 与 Dependency Policy、accepted risks）来自版本化项目配置的 `execution` 段（`src/application/configuration/project-config.ts`，见 README）；Manifest 仍是唯一的授权事实，配置只提供待批准的候选值，批准是用户对完整 Manifest 的一次决定。`execution.codexSandbox` 只影响角色级 Session 的 Codex 沙箱模式：设为 `danger-full-access` 时审阅要求 `acceptedRisks` 含 `codex-sandbox-danger-full-access`（并把该模式显示为 `Worker Sandbox` 一行），角色级派发与替代 Session 还要求**已批准 Manifest** 携带同一风险；Finalizer 始终以 `read-only` 运行。

`SemanticEvent` 是 UI 可投影的封闭联合；keepalive、stderr、poll timeout、无变化 reconciliation 和诊断日志不发布。`AnswerPendingInteraction` 必须含 InteractionId、expected revision、submissionId 和 answer payload；普通 Session message 不满足 interaction。

`m1-wire-foreground-planning-runtime` 的 Extend：`SendSessionMessage` 增加稳定 `submissionId`；`AnswerPendingInteraction` 以 `answer: string` 进入应用用例，IC-03 由 interaction ID 与提交身份生成稳定 answer ref 并原子存正文。语义事件统一携带 `eventId`、`coordinationScopeId` 与可空 `coordinatorSessionId`，只在对应权威事实已提交并读回后发布。TUI 只用归属 ID 设置未读标记，重启后依快照恢复。

Service 只委派既有用例，不打开 store、不调用具体 adapter、不拥有状态转换。Scope 初始化继续使用 `initializeCoordinationScope`，不塞入 façade。

- **错误/取消**：command 返回结构化 accepted/rejected/unknown 或领域拒绝；stale revision 零副作用。订阅取消只移除 listener。
- **测试 seam**：注入 fake use cases，断言每个 variant 委派一次；snapshot/event contract tests 只断言字段与语义，不锁定内部调用顺序。

## IC-12 Presentation projection、CLI 输出与进程生命周期

正式 continuous transcript 保留当前有界页。PgUp/PgDn 先在当前页阅读，到边界再使用权威游标；Ctrl+Home/End 分别直达最早/最新，Esc 在关闭更高层界面后返回最新。离开底部时新事件保留当前页与输入；失败保留原页并展示原因，切 Session 或更晚请求使迟到响应失效。entry ID 用于工具展开身份。视口高度改变仅调整本地滚动位置，不查询或持久写入。此处是 3A 基本阅读合同，Markdown、局部解析、缓存和流式性能由 3B 实现。

- **Owner (Create)**: `m0-orca-control-baseline`
- **Canonical paths**: `src/application/tui/view-model.ts`、`src/interfaces/cli/`、`src/interfaces/tui/`
- **Extenders (Extend)**: `m2-deliver-planning-tui` 在同一合同内实现 planning 投影与 TUI；`m2-deliver-execution-tui` 增加执行态分区；`m2-wire-execution-runtime` 增加 Execution Authorization 审阅 overlay 与 `authorize-execution` 命令，不新增页面或键位
- **Consumers (Consume)**: CLI machine users、React components、PTY tests

```ts
type TuiViewModel = {
  scope: ScopeView;
  selectedSession: SessionView;
  transcript: TranscriptView;
  budgets: BudgetView;
  graph: GraphView;
  workers: readonly WorkerView[];
  blockers: readonly BlockerView[];
  interactions: readonly InteractionView[];
  maintenance: MaintenanceView;
  handoff?: HandoffView;
};

type StatusJson = {
  schemaVersion: number;
  snapshotRevision: number;
  scope: ScopeView;
  sessions: readonly SessionSummaryView[];
  graph?: GraphView;
  workers: readonly WorkerView[];
  blockers: readonly BlockerView[];
  /** schemaVersion 2 增加：执行阶段只读分区（`m2-deliver-execution-tui`）。 */
  execution?: ExecutionSnapshotView;
};
```

`projectTuiViewModel` 是从 IC-11 `ControllerSnapshot` 到展示 DTO 的纯函数；CLI `status --json` 复用同一公共投影规则但输出独立版本化 machine DTO。CLI 的 `projection` 字段声明该投影覆盖的事实范围：`scope: 'store-only'` 与 `missing: ['execution-blockers', 'worker-liveness', 'delivery-intake']` 表示它不调用 Orca，执行期 blocker（例如 `repo_not_found`、Delivery 无法归因）与 Worker 存活只有宿主自己的快照能看到——不要把这里缺少 blocker 读成「没有阻塞」。TUI 内部只保存选中 Session、scroll、sidebar 密度、overlay 和每 Session 草稿；业务状态来自 snapshot/event。

`m2-deliver-planning-tui` 的 Extend 把 `TuiViewModel` 拆成可复用的纯展示 DTO（`ScopeView`、`SessionSummaryView`、`GraphView`、`WorkerView`、`BlockerView`、`BudgetView`、`InteractionView`、`MaintenanceView`、`CompactionView`、`TranscriptView`）并登记 Home 解析规则：

- **Home 解析**：以 Git common dir 定位 Branch Coordination State，再以当前完整 branch ref 和登记的 canonical worktree 精确匹配 Scope。无匹配则进入初始化向导；旧未绑定记录须经显式迁移 Review（`bind-scope-identity` 一次性补齐绑定后本进程才登记当前 Scope）；linked worktree（git dir 不等于 common dir）或 detached HEAD 阻塞。不得以 common dir 下 Scope 数量推断当前身份。
- **Session 选择**：选中 Session 与 Sidebar 密度都是进程内展示态。重启后按「存在 Pending Interaction 的 Session 优先，否则最近活动」重新选择；M1 没有「上次选择」的持久来源，本 change 不新增表、文件或 migration。
- **工作区布局**：Ctrl+B 开合固定项目面板（总览、待答列表、最近事件），100 列及以上替换原右侧区域，更窄时独占主区域。事件沿用本次启动最多 50 条的窗口，旧事件入口进入同一页签；Ctrl+G 在三档尺寸均打开只读 adaptive 检查。面板/栏目/详情/关系选择均为进程内展示态，关闭恢复原会话、草稿、光标与阅读位置；图标与 statusline 的显式保存值由 IC-15 拥有。
- **命令与审阅**：Palette、slash 与 Help 共享操作元数据和可用性；上方候选采用与执行分开，不可用与错误 slash 保留输入。选择页及审阅使用固定有界框，审阅默认返回；确认沿用 IC-11 的目标/指纹/revision 校验。顶栏、单行会话核心、独立风险与项目详情消费应用只读投影，缺失数据明示不可用；custom 和图标偏好沿 IC-15，可信 metadata 与共享验收摘要沿下述第七批扩展。
- **信息归属**：项目总览按需要处理、额度与权限、项目资料分组；Sidebar 保留图定位编号、阶段、Worker/liveness、串行队列和风险摘要。角色/attempt、Validation/Integration、worktree/baseline/Evidence 在 Inspector 节点栏目与项目工作详情读取；Recovery 的 Segment/预算/Capsule/superseded 和 Finalizer 的门禁/只读/集成冻结/前后工作区/Evidence/Verdict 在项目工作详情读取。相关语义事件进入最近事件，完整 WorkPackageId 在详情核对，定位编号仅用于当前图版本。审阅/确认期间 Ctrl+P/B/G 不穿透；Esc 逐层返回，Ctrl+C 沿原退出流程。
- **`StatusJson` 形状不变**：`schemaVersion` 仍为 1，字段与既有 machine DTO 一致；`status --json` 改为经同一 `ControllerSnapshot` 投影规则构造，不再自行从 store 记录逐字段映射。

`m2-deliver-execution-tui` 的 Extend 只增加执行态分区与相应组件，不新增页面、不新增键位、不改动 transcript/composer 主视图：

- **`TuiViewModel.execution`**：`activeWorkPackageIds`、`activeWorkPackageCount`（含派发待核验与集成等待占位）、`integrationQueue`（串行队列，顺序取拓扑顺序）、`finalizer`、`reconciliation`（重启对账门）、`hazards`（危险态判定，含不可核验 Worker）、`recoveries`、`handoffs`。
- **节点布局**：`WorkPackageNodeView.position` 是编译顺序的索引，状态变化只更新标识；`hidden` 只由过滤决定。依赖缩进与紧凑态文本在 `src/interfaces/tui/render/graph-layout.ts`。
- **Scope 级控制**（`src/interfaces/tui/components/control-bar.tsx`）：组件没有 Work Package 参数，因此结构上不存在单包控制入口。Pause 永不确认；Cancel 与 Exit 在危险态下先确认，确认后仍只提交一次意图。`cancelling` 只能来自 Controller 已持久化的控制状态。
- **Finalizer 面板**（`src/interfaces/tui/components/finalizer-panel.tsx`）：门禁不满足、只读未核验/无法强制或运行前后工作区变化时只显示 blocker；只有被接受的 Delivery Verdict 才显示 deliverable。
- **Execution Handoff**：复用 `handoff-review.tsx`，但主题是 `ExecutionHandoffState`（overlay `execution-handoff-review`），不复用 `PlanningHandoffProposal`。
- **Execution Authorization Review**（`m2-wire-execution-runtime` 的 Extend，`src/interfaces/tui/components/authorization-review.tsx`，overlay `authorization-review`，Command Palette 的 `authorize-execution`）：界面只显示宿主读好的完整 Manifest 展示行、候选图引用、Scope revision、指纹与门禁判决。它不组装 Manifest、不计算指纹，也不把自由文本解释成批准；批准只回传用户看到的那份内容的指纹与 revision，门禁未通过或事实不可读时不提供批准入口。推进仍走 `execution-authorization` 命令，不新增页面与控制粒度。
- **`StatusJson`**：`schemaVersion` 为 **3**，`execution` 分区包含 `workPackages`/`integrationQueue`/`activeWorkPackageCount`/`activeWorkPackageIds`/`reconciliations`/`finalizer`/`executionReconciliation`，并填充 `workers`/`blockers`。`status` 不调用 Orca，因此其中 Worker liveness 等外部事实保持不可核验。

顶层 CLI 只识别 `[repository-path]`、`status [--json]`、`doctor`。启动 TUI 前同时检查 stdin/stdout TTY；无 TTY 在挂载 Ink 前非零退出。Exit/Ctrl+C 只退出进程，不隐式 Pause/Cancel。React render/effect/resize/remount 不调用 IC-11 command。

- **版本/可访问性**：状态不能只靠颜色；宽字符按显示宽度裁切。`StatusJson.schemaVersion` 变化时消费者可 fail closed；字段顺序不是合同。
- **测试 seam**：纯 projection 单测、Ink 组件交互测试、真实 PTY 的 TTY/CJK/resize/终端恢复测试；不使用整屏大 snapshot。

## IC-13 UI 输入存储

- **Owner (Create)**: `protect-tui-input`
- **Canonical paths**: `src/application/ports/ui-input-store.ts`、`src/adapters/storage/ui-input-store.ts`
- **Consumers (Consume)**: Bootstrap、TUI 输入保护与输入记录管理

`UiInputStore` 是同步窄端口，提供 `read(key)`、`list(scopeId)`、`write({key, expectedRevision, record})` 和 `remove({key, expectedRevision})`。Bootstrap 注入 `TuiPorts.inputStore`，TUI 不打开数据库。adapter 生命周期的 `close` 由宿主拥有。

目标为普通消息的 Scope/Session，或回答的 Scope/owner Session/InteractionId/expected revision。`targetDraftKey` 使用 JSON tuple，草稿、冲突副本和提交分别有独立 key。`UiDraft.text` 是唯一展开正文；cursor 为 UTF-16 grapheme 边界，`pasteBlocks` 只保存 `{id,start,end}`。块身份唯一，范围有序且不重叠，光标不能进入块内。`UiInputRecord` 是 `draft`、`conflict` 或带 submissionId、reason 和 `awaiting|unknown|rejected|conflict` 状态的 `submission`，附 key/revision。边界使用运行时 schema；无效数据报告失败或有界 `invalidRecords`，可显式删除，不静默丢弃。UI schema 版本为 2，不支持的版本保留原库并拒绝打开，不自动重建。

SQLite 位于 Git common dir 的 `orca-companion/ui.sqlite`。短事务中完成 CAS、容量检查和写入；删除保留单调版本标记，拒绝删除前的旧写入。同一 Scope/Session 最多一条 awaiting/unknown 提交；明确拒绝与冲突记录保留但释放等待位置。每仓库双上限为 256 条有效记录和 32 MiB UTF-8 展开正文，涵盖冲突与快照，同一记录不重复计粘贴载荷，不包含 SQLite/WAL 文件尺寸；不自动淘汰。单次发送沿用 `MAX_USER_MESSAGE_CHARS`，超限输入保留，不截断。

用户编辑触发约 250 ms 合并保存；粘贴、切 Session、退出回答、提交和正常退出立即保存。发送前持久化完整快照与稳定 submissionId；保存失败不发送。结果只结清原快照，新输入和其他草稿不被清空。确认受理后删除快照，删除失败保留供再次核验。拒绝、冲突或不可核验内容由用户恢复或删除。并发草稿冲突保留双方供用户选择；容量不足时保留内存输入与原持久记录。

恢复时先通过 IC-11 查询核验既有提交；Bootstrap 生命周期可删除已确认快照，React effect 只读。用户可经 `/inputs` 查看、恢复、删除和核验记录；恢复草稿不自动发送。退出保存失败默认留在界面，只有再次明确确认才丢弃未保存输入并退出。

### `protect-tui-input` 对 IC-03/04/11/12 的扩展

- **IC-03 回答引用**：`answerRefFor(interactionId, submissionId)` 派生 `{kind:'interaction-answer', id:JSON.stringify([interactionId,submissionId])}`，与正文和解决状态沿现有事务持久化。同身份、同 expected revision、相同正文重放幂等；他人的关闭或回答不算本次成功。复用既有字段。
- **IC-04 追加**：`CoordinatorSessionRecordPort.appendModelStep`、`appendToolResult` 由 storage 同步读取最新状态，按稳定条目身份校验并追加，返回 `CheckpointWriteResult`。两个异步 workflow 节点消费该接缝，保留执行期间新受理的消息、Wake 与上下文；路由、消费语义和 schema 不变。
- **IC-11 核验**：普通消息与回答都必填 submissionId。`submission-status` 查询以 Scope、Session、submissionId、精确正文及回答绑定返回 `accepted`（含权威 ref）、`not-found`、`conflict` 或 `unverifiable`。它只读权威 checkpoint/交互记录，不取得 Runtime Lease、不启动模型；未知不能推断为未发生。
- **IC-12 输入**：`TuiPorts.submissionStatus` 为必填只读端口；slash 前缀严格分流，未知/参数/多行格式错误保留输入，不进入聊天或回答；粘贴只插入并立即保存。管理入口及展示不复制业务受理规则。完整 draft 经保护模块保存；编辑、viewport 与粘贴原子范围由 TUI 的 composer-editor 拥有。

### `complete-tui-editor` 对 IC-03/11/12/13 的扩展

- **IC-03 问题权威**：Pending Interaction 的精确详情增加可空 `question: {text,options:[{label,description?}]}`；Scope snapshot 保持身份摘要。`pending-interactions` 按 Scope/owner Session/open 状态，以 `(createdAt,interactionId)` keyset 返回最多 20 条摘要和 nextCursor；`pending-interaction` 精确读取绑定详情。Coordination schema 14 复用现有事务迁移新增 question 列和分页索引。
- **Coordinator `ask_user`**：规划、执行和恢复注册表共用工具协议。一题至多八项，标签唯一非空，总文字沿用消息上限；Scope/owner/subject 来自可信 runtime，InteractionId 为 `JSON.stringify(['ask_user',operationId])`。应用用例负责验证、CAS 写入、回读和同载荷重放；异载荷冲突。写后核验成功才发布 interaction-opened，不自动 suspend。
- **IC-11/12 查询**：Controller façade 委派窄问题查询；生产 `TuiPorts.questions` 由 Bootstrap 注入 Scope，未提供能力时明确拒绝。精确详情包含原问题、answerRef 与可空回答正文，核验 Scope/owner/ID，不返回其他 Session 的问题或数据库 handle。组件 render/effect 仍只读。
- **IC-13 编辑**：保护模块接收完整 UiDraft；超过 1000 code points 的单次粘贴折叠，CRLF/CR 归一 LF，保留 tab/缩进/末尾空行。移动和删除跨整块，发送展开正文；250 ms 合并保存、立即保存节点、CAS、单活跃提交与 generation 规则不变。
- **IC-12 面板**：Shift+Left、`/answer`、Palette 打开当前 Session 底部回答面板；Shift+左右切问题，Tab 切选项/自由输入，Enter 直接提交标签或输入。Esc 保存回答并恢复聊天完整草稿与阅读位置；新问题不抢焦点。`/paste` 和 Palette 查看完整折叠块，视口有界，退出恢复原位置。

### `link-tui-pending-interactions` 对 IC-03/11/12 的扩展

- **IC-03 展示读取**：`CoordinationPresentationSnapshot` 与完整 `CoordinationSnapshot` 类型分开，使用 `presentation-snapshot` 查询；交互分区为至多20条 `InteractionSummary`、完整 Scope `openCount` 与分 Session count。生产宿主选中 Session 后只查询该 owner 的摘要；Scope 待答页独立读取。SQL 聚合只扫描 open 索引，不解码问答载荷。业务完整 snapshot 保持原合同，`openInteractionCount` 为完整事实或完整聚合计数，Finalizer 不使用页长。CLI 用 `pending-interaction-identities` 保留公开 JSON 的全部开放身份列表，该专用查询不返回问答正文或预览；TUI 不消费此查询。
- **IC-03 查询**：`pending-interactions` 的 owner 可选，省略时是当前 Scope 页；keyset 为 `(createdAt,interactionId)`，每页20条及 nextCursor。`interaction-summaries` 只读取同 Scope/owner 的至多20个指定 ID，附160 Unicode字符预览和正文 byteLength，包含 answerRef，不携带完整正文。`interaction-body` 精确按 Scope/owner/ID、question/answer part、内容版本读取UTF-8范围；maxBytes 为4–65536，非法边界返回 `invalid_utf8_offset`，版本不符/缺失返回 null。Q 含文字与选项，版本绑定 expectedRevision；A 版本绑定稳定 answerRef。Coordination schema15只追加Scope分页索引，UI/checkpoint schema不变。
- **IC-11 历史关联**：`userQuestionInteractionId(operationId)` 统一正向身份派生；已持久化 HistoryCall 的 operationId 是 reader 的关联输入。`TranscriptReadingPort.interactions` 是只读指定摘要查询；正文经同一 body 端口读取，`TranscriptSourceRef` 增加 interactionId/part/contentRevision，anchor 的 Session 即 owner。Q/A 权威继续属于 Branch Store，不写入 checkpoint 或通用事件载荷。
- **IC-12 呈现/返回**：历史原调用处紧凑显示 Q/state/A，F4 Enter 原位开合；开放提问在活动导航内以 Shift+Left 进入同一回答管线。项目 Scope 列表 PgUp/PgDn 翻页，Enter 精确核验 owner/revision 并保存输入后进入。单次进程内返回上下文保存原 Session、来源锚点、展开模式、栏目/selectedKey/scroll 和焦点，草稿留在 IC-13。Esc 保存成功返回；受理且没有后续编辑或选题/Session变化才自动返回。显式切会话使旧返回失效；unknown/拒绝/保存失败保持原绑定与输入。消失的 selectedKey 明确显示变化，不自动选择下一题。Ctrl+R 仍是普通输入历史。
- **读取失效**：交互事件只触发摘要重读及有界 snapshot/原锚点 refresh，不作为问题或受理权威，不开回答或抢焦点。render/effect/resize 仍无 command、副作用或持久写入。

## IC-14 CredentialStore 与模型设置

schema 5 的 ProviderConnection 只描述 Coordinator 连接：connectionRef、label、providerId、固定协议 providerIntegration、baseUrl 与 credential（managed API Key 引用）；Worker-only 的 `codex` 与 `nativeWorker` 字段被删除，出现即拒绝。Worker Profile 改为 `modelSelection`：`{model, effort, effortCapability: {values, source} | null, catalogSource: string | null}`；effortCapability 非空要求 catalogSource 非空，effort 非空必须属于 capability.values，catalogSource 为 null 表示手填未验证 native exact ID 且 effort 为 null。SaveModelSettingsInput 对 Worker 角色是只含 harness、model 与 effort 的判别联合，连接、秘密与任意 options 字段明确拒绝；服务经 `verifyWorkerSelection` 绑定本次显式原生目录查询的有界缓存核验来源。保存追加不可变 profile，应用沿完整 Manifest v4 审阅。Coordinator 仅使用 API Key，Worker 启动不读取 CredentialStore。

- **Owner (Create)**: `complete-tui-model-configuration`
- **Canonical paths**: `src/application/ports/credential-store.ts`、`src/adapters/storage/credential-store.ts`、`src/application/configuration/model-settings.ts`、`src/domain/model-configuration.ts`
- **Extenders (Extend)**: `remove-worker-credential-management` 收缩为 Coordinator-only 并把 Worker 选择改为 `modelSelection`
- **Consumers (Consume)**: chat model factory、Coordinator 模型设置用例与 `doctor` 的 Coordinator 凭据解析；Worker launcher 与原生目录查询不解析凭据

`CredentialStore` 是同步窄端口：`metadata()` 返回 `{revision, refs}`，`read(credentialRef)` 返回 secret，`save({expectedRevision, secret})` 返回 `{revision, credentialRef}`；任何失败都是 `rejected{code,message}`，不抛异常、不回显原始异常或 secret 载荷。metadata 只含引用集合，不含 secret。

文件按 XDG 规则落在 `orca-companion/credentials.json`（`XDG_CONFIG_HOME` 优先，缺省 `~/.config`），格式为 `{schemaVersion:1, revision, entries:[{credentialRef, secret}]}`。`credentialRef` 是不可变 UUID；写入在短 exclusive 文件锁内重读并做 revision CAS，随后 0600 临时文件 → fsync → rename → 目录 fsync → 回读。锁忙、revision 已变、权限不安全、符号链接、非普通文件、损坏内容与超限一律结构化拒绝：不自动破锁、不 chmod 既有用户目录、不猜测其它凭据。读上限 1 MiB、条目上限 256、单条 secret 上限 16 KiB；store 缺失按 revision 0 与空引用处理，按引用读取缺失返回 `credential_missing`。

凭据是**明文**保存在这一份文件里，这是用户确认的取舍，它取代了「Companion 不保存密钥」的旧约束。隔离靠三件事：owner-only 权限、其它位置只保存不透明引用、以及严格的输出边界——项目配置、checkpoint、UI 输入存储、命令参数、诊断与证据中都不出现 secret 值。secret 只在编辑内存、CredentialStore 与必要的 Coordinator 模型调用环境中存在。

`ProjectConfigurationStore`（`src/application/ports/project-configuration-store.ts`）拥有同一 namespace 的项目侧：连接的 `credentialRef` 必须是 UUID，出现已知密钥字段名即拒绝整份配置；短锁、CAS 与原子替换与凭据文件同构，但不做权限收紧——它纳入版本控制。锁内还核验既有 connection、model、Coordinator configuration 和 Worker profile 原样保留，拒绝同引用改写或删除，当前选择指针可前移。parser 核验 Coordinator 连接快照与模型引用一致，以及 Worker Profile 的 harness 与 modelSelection 来源约束（capability 非空要求 catalogSource 非空，effort 必须属于 values）。两者之间没有跨文件事务：Coordinator 连接编辑先校验候选、先写凭据并回读，再 CAS 追加用户级库；项目通过 modelRef 解析并复制完整连接/模型快照；Worker 角色选择只 CAS 追加 `execution.workerProfiles` 的新引用，零凭据访问。项目保存失败保留输入，可能留下未被引用的孤立 secret，但不会激活配置。查询返回非秘密 snapshot；保存不自动应用。

连接 URL 不得携带 userinfo、fragment 或凭据查询参数；查询参数的凭据字段判定复用领域层的密钥键名规则。普通 API 版本等非秘密查询参数保留。

## `complete-tui-model-configuration` 对 IC-03/04/05/07/08/09/11/12 的扩展

- **IC-03 物化绑定**：`record-materialization-binding` 增加 `authorizationId`、`authorizationVersion` 与 `workerProfileRef`（不透明字符串，落库为 `worker-profile` 引用），缺任一项即拒绝，不留下无运行依据的新行。Coordination schema 16 追加这三列，schema 16 之前的历史行保持 `null`；需要这些事实的读取方按不可证明阻塞，不按当前授权推断回填。
- **IC-04 项目配置**：项目配置为 schema 5，保存 `revision`、`providerConnections`、`models` 与 `execution.workerProfiles`/`workerProfileRefs`；Worker Profile 使用 `modelSelection`，ProviderConnection 只描述 Coordinator 连接；旧版本明确拒绝且不自动改写。引用唯一性与交叉引用、effort 的目录来源都由同一 parser 判定。会话模型绑定沿用既有 `update-session-model-configuration` 记录。
- **IC-05 授权**：Manifest 为 v4，`workerProfiles[].modelSelection` 为必填（harness、model、effort 及其目录来源），并单独绑定 `recoveryUtilityProfile`；缺任一项的授权无法证明 Worker 用什么模型运行，解析即拒绝，v1–v3 不被当作包含模型授权。执行期换模型或并行额度时以完整 Manifest 指纹与 Scope revision 重新批准，保持 Graph Generation、Run、Task、权限、其他上限与已消耗预算，不创建 Graph Revision；Replanning、cancelling 或未决派发 mutation 时拒绝重新授权。
- **IC-07/IC-08 运行依据**：Task 物化时把当时的授权身份、版本与 profile 钉进绑定。Retry 沿已有 WorkerTask 的绑定取原授权与 profile，结算按该绑定判断权限与配置，不读当前配置；旧任务缺绑定时按不可证明阻塞。Worker 启动继承真实 launch 环境，不注入 secret、不生成原生 provider 配置；公开 terminal 命令与 CLI 参数只含非秘密描述符，认证由 harness 自己提供，不自动 fallback。
- **IC-09 恢复**：替代 Session 沿原 WorkerTask 绑定的 profile 派发，Validator 的修复/复验与原任务同 profile；新 Recovery Utility Task 固定创建时的授权配置。transcript 不可用或恢复预算耗尽仍按不可证明阻塞。
- **IC-11/IC-12 界面**：模型设置提供只读 load、显式 save 与按角色显式 apply 三条意图；Coordinator 角色的项目保存输入仅为 modelRef、effort 与 expected revision；用户库拥有连接保存和可信模型定义，Worker 角色只含 harness 与 modelSelection（含显式目录查询与来源），scope/writer/profile 身份由宿主补齐。界面只消费非秘密 snapshot，key 以遮罩显示且只存在于编辑器内存，不进 IC-13。保存不改变 Session、已批准 Manifest、Task 与预算；apply 走既有 switch 或完整授权重新审阅。异步结果仍按原 invocation/Session 归属。

## `remove-worker-credential-management` 对 IC-05/07/08/09/11/12/14 的扩展

- **IC-14 模型设置**：项目 schema 5；ProviderConnection 为 Coordinator-only 的固定协议/API Key 连接；Worker Profile 只带 harness 与 `modelSelection`，保存经显式原生目录查询缓存核验来源，零 CredentialStore 访问。
- **IC-07 Worker Harness**：启动输入不含 CredentialStore、凭据路径或可覆盖原生环境的隔离 root；`worker-runtime.ts` 从真实 launch 环境解析非 secret runtime roots 并写入精确 Session 报告，`runtimeReportPath` 只承载非秘密路径；端口增加逐 harness 原生模型目录查询（codex `debug models`、Claude streamJSON control_request `list_models` 无 prompt、OpenCode `models --standalone`、pi 公开 availability/thinking API、omp `models --json` 实际 thinking）。查询总时限 30 秒，最多 4096 项、1 MiB/20000 行；控制协议经既有 process-runner 的可选 stdin 传入（最多 1 MiB），使用参数数组并支持取消。
- **IC-08/IC-09 恢复与只读**：恢复按原 launch report/binding 的精确身份与 runtime roots，`expectedNative` 只核验；bwrap 继续让仓库、Git、common dir 与协调库拒写，真实 native state 目录与 Companion 工件目录可写，重叠不可证明即 unavailable。
- **IC-11/IC-12 界面**：#52 定稿下 Worker 角色只编辑 harness 与原生目录候选（model/effort），无连接、凭据、API key 或任意 options；Coordinator 表单使用服务/地区产品线或自定义协议、地址、隐藏Key与模型选择；目录查询失败可手填 exact ID（未验证、无 effort），迟到结果仍按原入口归属。

## 第七批 IC-11/12 展示扩展

Owner 为 `complete-tui-project-statusline` 的 Extend，canonical DTO 在 `src/application/tui/project-presentation.ts`。`ControllerSnapshot.projectPresentation` 与 `TuiViewModel.projectPresentation` 消费同一形状，不在组件内复制业务判断。

- **metadata 权威**：repository/fullBranchRef 来自注册 Scope；模型/provider/effort 来自选中 Session 的准确不可变 configuration；Ticket 是该 Session 精确 Claim 的 tracker summary，只查 title/ref、不读取 body。当前 Work Package 来自当前 Dispatch/Attempt。缺少来源保留 null/unavailable，effort 区分 configured/not_configured/not_supported/unavailable。
- **context**：installed integration 的可选精确测量能力接收完整有效输入和 tools、返回实际 used 与可信 capacity；观察绑定 Session/configuration/effective input revision。每次准备真实请求都会取得新输入版本，包含当次 Actionable Work；版本校验同时检查已提交历史位置、完整 Context Material、压缩结论、系统指令、权威事实和工具定义。能力由 `ProviderIntegration.exactContext` 表达，模块导出的模型构造函数可显式提供静态 `companionExactContext.measure({model,messages,tools,signal})`；一般 `BaseChatModel` 不被当作具备精确能力。消息/tool step 接受、压缩、换模型后失效。读取快照不测量；不使用近似 tokenizer、字符估算、上一轮/累计 usage、配置读回预算替代窗口。未提供能力的 adapter 为 unavailable。
- **验收摘要**：唯一 application owner 从当前 GraphId/generation/version 全部未 retire Work Packages 与 `currentContractSettlements` 派生 `{validatedCount,totalCount}`；精确当前合同 Validator 接受结果每包一次，状态栏/Sidebar/Inspector 共同消费。Task done、Implementation 或 integration 状态、局部窗口不能派生分子。
- **预算**：明确类别 work-packages/implementation-attempts/recovery，各自携 consumed、limit、subject 与 approvedLimitRef。work-packages 是当前未 retire 数/maxWorkPackages；implementation-attempts 读取精确包的 budget counter，recovery 复用按 businessAttemptId 汇总的 Recovery records，以上限对应的批准引用核验。缺少 ledger 或原 Task 的授权绑定显示不可用，不取 ledger 首项或当前配置上限冒充原授权。
- **projectDetails**：Bootstrap 绑定 Scope，UI 请求精确 Session/object/seen revision/cursor。每次20项、64KiB总正文；长字段按UTF-8完整字符边界续读，游标跨对象/版本拒绝。批准后 Manifest 精确读取已批准 ID/version，候选入口独立。页面失败/失效保留原入口，迟到结果仅属于原对象；查询不产生业务动作。
- **IC-03 详情来源**：`project-detail-session` 精确读取所选 Session 注册、active Claim 与当前执行 Lease；`project-detail-json-field` 按当前 GraphId/version 或批准 authorization ID/version 读取一个字段及其 UTF-8 范围，不向宿主传回完整 graph/Manifest。工作包 Task 与 Accepted Result 依据当前包的可信绑定关联，预算计数可按批准引用筛选。读取只复用现有 schema16 记录，不新增持久副本或迁移。
- **补充观察**：宿主只保留当前展示 Session/revision 的既有 Recovery、Finalizer、Frontier、维护与压缩投影引用。工作详情将这些字段与存储范围接入同一20项/64KiB分页，观察不匹配则要求刷新后重读；正文和业务事实仍归原 owner，详情不启动外部观察或建立第二份持久状态。

## 第八批 IC-03/05/06/11/12 图历史与依据阅读扩展

Owner 为 `complete-tui-graph-basis` 的 Extend。IC-05 拥有图版本与追加链权威，IC-03 schema 17 提供 metadata、membership 和正文范围查询；IC-11 的只读应用端口是 `src/application/tui/graph-basis.ts` 的 `GraphBasisPort`，实现由 `src/application/tui/graph-basis-service.ts` 拥有。此读取端口与第七批 ProjectDetails 独立；ProjectDetails 仍按当前 Scope revision 读取当前详情。

`GraphBasisPort` 全部方法是 Promise 查询。每次按 Bootstrap 闭包中的 Coordination Scope 与当前 Session registry 核验调用身份；读取无需 Runtime/Execution lease，也不写协调状态、不恢复模型、不派发 Worker。来源 ref 由 `kind` 判别联合定义并按严格 schema fail closed；该 seam 只提供只读目录、精确来源与正文范围，没有通用文件编辑接口。

```ts
type GraphBasisPort = {
  listVersions(input: { coordinatorSessionId: string; after: string | null }): Promise<BasisReadResult<{ items: readonly GraphVersionSummary[]; nextCursor: string | null }>>;
  readVersion(input: { coordinatorSessionId: string; graph: GraphVersionRef }): Promise<BasisReadResult<{ summary: GraphVersionSummary; graph: GraphView; retiredWorkPackageIds?: readonly string[] }>>;
  listSources(input: { coordinatorSessionId: string; graph: GraphVersionRef; workPackageId: string | null; after: string | null; orcaTaskId?: string }): Promise<BasisReadResult<{ items: readonly BasisSource[]; nextCursor: string | null }>>;
  readSource(input: { coordinatorSessionId: string; source: BasisSourceRef; sourceVersion: string | null; offset: number; maxBytes: number }): Promise<BasisReadResult<BasisBodyRange>>;
};
```

来源 ref 是 `kind` 判别联合；接收侧按封闭 schema 校验，未知 variant 或额外字段拒绝。Session、Scope 与 adapter 都由 Bootstrap 注入/闭包绑定，调用方不能在来源对象中指定其他 Scope。

- **目录与拓扑**：跨全部代际的图版本目录每页最多 20 条，只返回 metadata；选择后精确读取指定 GraphVersion。head 由 `graph-head` 按 GraphId 读取，generation 状态来自权威记录；Scope 指针只判定当前图，不推断同代际旧版本为 frozen。membership 查询只证明所请求版本属于哪条追加链。普通 Controller snapshot 只包含当前图拓扑，不附带历史图正文。
- **退役证明**：`readVersion.retiredWorkPackageIds` 只来自所选版本 Accepted Graph Patch 的 `retired`。缺少该证明只显示该版本未包含所选工作包，不从其它修订的存在推断退役。
- **依据来源**：初始 Implementation Plan 从 schema 17 初始 v1 记录读取；Accepted Graph Patch 按 graph/generation/version 读取；批准 Manifest 按 authorization ID/version 读取。原始计划保留 JSON 原结构，不合成替代文本。旧行没有初始计划时显示未记录。批准时没有保存的 tracker 正文显示缺失；当前 Route Map 正文单独标记当前来源与其 sourceVersion。
- **授权目录**：来源页顺序为计划/补丁/当前 Route Map、批准授权目录、所选 Work Package 的 retained bindings。`graph-basis-authorizations` 按 GraphId/generation 查询批准 Manifest metadata，返回 authorization ID/version 与批准时 GraphVersion，每页最多 20 项；正文另按授权 ID/version 范围读取。批准时 GraphVersion 是授权自身的运行依据，不能据此声称所选历史版本曾获授权。
- **规格来源**：OpenSpec 文件目录与正文范围只通过可选 `SpecificationProvider.readFiles`/`readFileRange`。来源 ref 绑定 `workPackageId`、`orcaTaskId`、`SpecificationUnitLocator`、path 与 `contractRevision`；`listSources` 可指定 `orcaTaskId` 进入该 Task binding 的精确 unit。首次读取以已接纳 contract revision 证明；范围续读按文件 stat 检测变化，不在每页重算全文 digest。tasks/tracking revision 独立呈现，不改变 contract binding。`readSource` 必须与原 Materialization Binding 完全匹配，伪造 package/task/locator 被拒绝；adapter 再验证 locator 与真实 unit/worktree 路径。
- **保留执行记录**：来源 schema 是 `z.discriminatedUnion('kind', ...)`；未知 variant 或字段拒绝。`graph-basis-bindings` 经 package Work CTE 的 Task keys 按 Work Package 分页，每页最多 20 个 Task binding；每 Task 最多投影三项：`retained_task` 原执行记录、原授权、原规格。Task/Dispatch/Attempt、Accepted Result 与证据是包级 retained records，不属于具体 GraphVersion；缺少绑定时明确显示不可证明，不按时间归属。
- **tracker 正文**：GraphBasisService 只读取 Scope 当前配置的 `routeMapIssueRef`，经 optional `IssueTrackerGateway.readIssueBody` 返回 `TrackerBodyOutcome` 与真实 tracker sourceVersion。历史批准正文没有权威保存记录时明确显示不可用；当前 Route Map 正文单独标记当前版本，不回填为批准时快照。
- **范围、缓存与导航**：依据正文单次最多 64 KiB UTF-8，图/依据目录每页最多 20 项。来源 cursor 严格绑定 Session、Graph、Work Package 与读取 phase。历史正文与布局缓存分别限制 8 MiB/64 项；返回上下文只保留来源身份、GraphVersion、栏目、选择和滚动等展示标量，不缓存第二份正文。迟到查询只能更新原页面身份。历史页面不使用当前 Scope snapshot 推导 frontier、Worker、预算或验收状态。项目详情原分页与当前 Scope revision 约束保持不变；IC-12 返回栈和历史来源视口不借用 ProjectDetails snapshot 或 transcript 正文缓存。

## IC-15 用户级 TUI 展示偏好

- **Owner (Create)**：`complete-tui-project-statusline`
- **Canonical paths**：`src/application/configuration/tui-preferences.ts`（schema、DTO、port）；`src/adapters/storage/tui-preferences-store.ts`（文件实现）；Bootstrap 装配 `TuiPorts.preferences`
- **Consumers**：TUI 设置与图标选择；不提供 Coordinator 工具入口

用户文件 `${XDG_CONFIG_HOME || homedir/.config}/orca-companion/tui-preferences.json`，schemaVersion1：revision、iconMode(nerd/ascii)、statusline(modelFormat model/provider-model、contextFormat used/remaining/tokens、progressFormat count/percent、budgetKey work-packages/implementation-attempts/recovery、有序唯一 fields graph/ticket/work-package/progress/budget)。默认 revision0、nerd/model/used/count/work-packages、fields=[graph]。

`load()` 返回 `{kind:'loaded',preferences,writable,notice}`。文件缺失只读默认且可写；损坏/未来版本/不可读保留原文件，默认呈现且不可写。`save({expectedRevision,patch})` 的 patch 只含 icons 或 statusline 一区；短 exclusive 文件锁内重读/CAS、临时文件原子替换与回读，返回 saved/conflict（当前 preferences）/failed（安全code/message）。冲突不自动重试；锁占用失败关闭。该文件不含秘密、不进入协调/checkpoint/ui.sqlite，环境图标覆盖保持临时。

custom 编辑是内存草稿，同生产 statusline 的主区域宽度、字段配色与裁切作预览。↑↓选择、Space勾选、←→顺序/格式、Enter显式保存、Esc逐层丢弃；恢复默认只改草稿。成功关闭设置/命令层并回原入口；失败/CAS保留草稿可显式重试。异步请求绑定原编辑 generation，不闭合新页或覆盖新编辑。图标即时生效，独立分区保存，失败保留本次选择与未保存提示；重启恢复最后保存值。render/effect/resize/remount 只读。

## 可配置执行并发扩展（restore-configurable-execution-concurrency）

IC-05 的 ExecutionLimits 唯一拥有 `maxActiveWorkPackages`（并行包额度，默认3）、`maxWorkPackages`（未 retire 图容量，默认8）、`integrationReconciliations`（每包集成复验预算，默认2）；所有额度可配置且为正安全整数。ExecutionGraph 不存并发策略。配置与 Manifest 由 `remove-worker-credential-management` 升为 schema 5 / v4，status JSON 仍为 schema3。

IC-03 schema19 由 Branch Store 拥有最小包级 LaneReservation（scope/generation/package、稳定 operation identity、准入 authorization 与 baseline）。`reserve-work-package-lane` 在短事务内核验 lease/fencing/CAS、当前图与批准额度；同包重放复用原记录，未可见派发仍占用。`release-work-package-lane` 仅在终止或完整集成可证明后释放。额度降低不撤销已有包。集成复验轮次与独立预算消费在同一事务注册，绑定原 Validator Attempt/Session、原接受结果、目标 HEAD 与树证据；具体 Task/Dispatch 仍由 Orca 和物化绑定拥有。

Operation Intent 的 nullable `terminalHandle` 只记录已接受 terminal-create 回执的精确资源引用，在原意图结算事务内写入，不复制终端状态。恢复时从精确 worktree 的有界列举重新核验句柄与 connected/writable；终端标题仅是显示内容。原句柄缺失、失效或列举不完整时阻塞对应 lane，不能重发已存在的 mutation。旧记录保留 null，不按屏幕、标题或时间猜回填。

集成复验应用 owner 为 `src/application/integration-reconciliation.ts`，生产 Worker 接线为 `src/bootstrap/integration-reconciliation-runtime.ts`。轮次登记与额度消费同事务；`bind-integration-continuation` 在 Task 创建、Dispatch 启动后立即登记真实身份，允许未启动的 null Dispatch 补齐一次。原接受结果与目标 HEAD 不改写，通过轮次的树与续接身份也不可改写。重启以原 OperationId 和已绑定 Task/Dispatch 对账；读取失败保留不可核验状态，不当作空轮次重派。

IC-07 调度按当前批准的包额度接纳多个独立包，每包角色串行。自动驱动与工具共用原子准入；unknown 仅冻结所属 lane，共享事实无法归属仍全局阻塞。新包 worktree 基于已归属当前 canonical，依赖以已集成证明为准。IC-08/09 原 Validator 续接复验保持业务 Attempt 和精确 provider Session，物理续接使用独立 Task/Dispatch，旧结果不改写。

Codex 启动和续接共用 SessionStart hook（`startup|resume`）。续接报告只能由本次 launch 的精确路径读取，并核验原 provider UUID、runtime roots、cwd、transcript 和当前派发观察窗口。绑定报告迟到时，共享 Scoped Worker 派发按原 Task 只读回读 Dispatch，已接受的草稿激活复用原结算事实，不重复发送；pending 或 unknown 的激活仍须对账，Worker 已绑定 terminal 本身不证明草稿已提交。

续接前，Bootstrap 从原 Accepted Validator 的 Task/Dispatch 取得精确终端；后续复验轮次沿同一接受结果与业务 Attempt 读取最近已通过轮次的物理 Worker。只有精确 Worker 已终结且终端满足 `tui-idle` 时才关闭该终端，关闭意图绑定原句柄；pending/unknown 沿原 OperationId 以 `terminal-show` 的精确关闭事实对账。恢复使用原 runtime roots 与 provider UUID 的 `codex resume --no-daemon`。`submit_draft` 直接提交一次 Enter，激活成功的持久化事实控制重放；首个实际 turn 产生本轮 SessionStart 报告，观察窗口从本轮派发前的持久化意图起算。

Task 物化绑定的 `dispatchId` 是派发前 Task Envelope 的逻辑候选身份；真实 Orca Dispatch 由 Session Segment 证明并写入 Accepted Delivery Settlement。物化互斥与额度结算沿 `acceptedResultMatchesTask` 核对角色、WorkerTask 与业务 Attempt，不将逻辑候选 ID 与实际 Dispatch ID 比较；Delivery 准入仍核验精确物理 Dispatch。仅建立 Task 的包可沿原绑定续办；已受理的 Worker 启动意图及实时 Worker 事实阻止重复派发。

IC-08 的 Delivery identity 属于整批消息。普通角色与集成续接可能同批到达；所有结果均须按精确 Task/Dispatch 结算并回读后才能确认整批。`process-delivery.ts` 统一核验批次是否可确认；角色重放先逐条结算，再确认。崩溃后重读原批次，不另存结果正文。合并提交只使用原 Validator 已复验的 index 树，提交前后核验同一 tree OID；提交后、轮次落盘前重启仍沿原意图的 expected HEAD 和轮次身份对账。

集成复验报告单独声明有界 `filesModified`；冲突路径与修复文件按本包 Scope Envelope 核验。`evidence.coveredPaths` 表达验证阅读覆盖，可包含已授权 canonical 合入的其他包文件，不作为 Worker 修改声明。原 Session、Task/Dispatch 与精确树仍需独立核验。

IC-11/12 提供 ExecutionSettings load/save 和显式执行期完整审阅意图，复用 ProjectConfigurationStore CAS。保存仅改默认值；当前额度只有完整 Manifest 重新批准后改变，保持图、Run、Task 绑定及预算计数。活动包 DTO 使用 `activeWorkPackageIds` 和真实 `activeWorkPackageCount`，不截断为单个包；渲染无持久副作用。

重新审阅绑定当前 Graph head 与 Scope revision；批准时 head 或载荷变化以 `manifest_changed` 拒绝，同载荷重放读回原批准记录。

## 合同演进规则

1. Owner change 首次创建 canonical symbol 和最小行为测试。
2. Extender 只修改同一路径和登记维度，运行 owner 的原测试及新增行为测试。
3. Consumer 只导入，不定义别名类型、镜像状态、第二 repository/pipeline/snapshot。
4. 实现需要本文未登记的公共字段、枚举、错误、权限、migration 或调用顺序时停止 IP-ID，更新本合同与受影响 change 后再继续。
5. 私有 helper、SQL 细节、React props 和单模块内部拆分不属于本合同；owner 可在不改变调用者知识的前提下调整。

### Coordinator Provider Library 与 Catalog 合同

`ProviderLibraryStore` 的 canonical path 为 `src/application/ports/provider-library-store.ts`，`FileProviderLibraryStore` 实现用户级 providers.json（schema1、revision、connections、models），0700目录/0600文件、短exclusive锁、CAS、原子替换与回读；拒绝删除/改写历史引用、symlink、不安全权限和无界输入。应用 `ProviderLibraryService` 提供 load/saveConnection/saveModel/resolveModel。连接输入strict校验先于任何secret写入；保存失败不激活，密钥可能成为不被引用的孤立项。模型能力来自精确匹配的可信目录，未知为null。

`ProviderCatalog` 的 canonical path 为 `src/application/configuration/provider-catalog.ts`。presets/candidates 同步只读；discover 与 refresh 是分开的显式异步意图，查询有界、可取消。发现非空为唯一候选，失败或空结果按 connectionRef/credentialRef/effective catalog version 的LKG→catalog回退，无发现服务直接catalog。公共内容更新或发布基线更新使旧缓存失效，相同内容刷新保持缓存。自定义只按固定协议提供兼容候选，不按hostname猜供应商，exact ID不重写。

Home initializeProject 意图携带用户所选modelRef/effort/Route Map issue，仅对不存在文件按CAS创建完整schema5；Scope和Session仍需独立核验与批准。响应恢复的原配置引用/必要白名单kwargs与签名内容由checkpoint拥有，计入输出/上下文预算，不进普通metadata页；换模型只用可移植文本/tool结构。
