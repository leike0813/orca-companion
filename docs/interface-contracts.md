# Orca Companion 接口合同

本文定义跨 module、跨 change 和外部系统 seam。架构与依赖方向见 [`architecture.md`](architecture.md)，领域词义见 [`CONTEXT.md`](../CONTEXT.md)。所有 TypeScript 片段都是规范形状，不是待复制的源码；owner change 应在 canonical path 实现，后继只能按登记关系 Extend 或 Consume。

每个合同只有一个 `Owner (Create)`。公共字段、枚举、错误分类、所有权或权威来源发生变化时，先更新该合同和所有受影响的 OpenSpec change；实现不得用 `any`、额外可选字段或局部 adapter 特判吸收漂移。

## 所有权总表

| Contract | Owner (Create) | Extenders (Extend) | 主要 Consumers (Consume) |
|---|---|---|---|
| IC-01 | `m0-orca-control-baseline` | 无 | 全部后继 change |
| IC-02 | `m0-orca-control-baseline` | Change 5 增加物化操作；Change 7 增加对账 query | 所有外部控制用例 |
| IC-03 | `m1-persist-coordination-state` | Changes 3–8 增加各自最小记录与 query/command variant；`m1-wire-foreground-planning-runtime` 增加 Scope 注册绑定、交互回答正文与 Session 模型绑定更新 | Controller、status、recovery、TUI projection |
| IC-04 | `m1-run-coordinator-sessions` | `m1-wire-foreground-planning-runtime` 增加用户消息、工具结果与压缩结论 | Planning、Recovery、ControllerService、TUI |
| IC-05 | `m1-plan-and-authorize-execution` | Change 8 只扩展 `ExecutionGraphHistory.appendAcceptedRevision` | Specification、Execution、Recovery、TUI |
| IC-06 | `m1-admit-work-package-specifications` | Change 8 使用同一 provider 实施 Specification Revision | Execution、Recovery、Graph evolution |
| IC-07 | `m1-admit-work-package-specifications` | 无；Recovery 创建替代 Dispatch/Segment 但不改合同 | Execution、Recovery、Graph evolution |
| IC-08 | `m1-execute-and-validate-work-packages` | 无；Recovery 重放同一 pipeline | Recovery、Graph evolution、TUI |
| IC-09 | `m1-recover-execution` | 无 | Graph evolution、TUI |
| IC-10 | `m1-evolve-execution-graph` | 无 | ControllerService、TUI |
| IC-11 | `m1-recover-execution` | Change 8 增加图演进 projection/commands；`m1-wire-foreground-planning-runtime` 增加消息/回答字段与事件归属；`m2-deliver-planning-tui` 增加只读投影 | CLI、两个 TUI change |
| IC-12 | `m0-orca-control-baseline` | `m1-wire-foreground-planning-runtime` 登记精确 Home 解析；`m2-deliver-planning-tui` 增加 planning 投影与组件；`m2-deliver-execution-tui` 增加执行态字段与组件 | CLI machine output、TUI React components |

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
| Pending Interaction | InteractionId、owner Session、scope ref、expected revision、state、answer ref；受控回答正文与状态在同一 CAS 事务写入，普通聊天不能满足 |
| Operation Intent | OperationId、target、expected revision、state、outcome class、backend request ref；不复制 receipt 正文 |
| Budget counters | budget key、approved limit ref、consumed count；重启/恢复/patch 不重置 |
| 后继记录 | wake admission、graph/auth refs、bindings、dedupe refs、Recovery/Handoff/lineage；只存不可重建最小事实 |

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

`m1-wire-foreground-planning-runtime` 将 Session payload 升为 v2：每条已提交消息有稳定 `entryId`；tool result 还包含配对的 `toolCallId` 与名称，assistant call 的可信 `OperationId` 在模型响应提交时由宿主分配；`lastCompactionOutcome` 是该 Session 最近一次维护结果。v1 读取只做可证明唯一的升级，失败阻塞且保留原 checkpoint。普通用户消息以 `submissionId` 与 WakeBatch 原子落盘后补记 source admission；交互回答正文属于 IC-03。

| 字段 | 合同 |
|---|---|
| `thread_id` | 由 CoordinatorSessionId 确定性映射；不同 Session 永不共享 checkpoint |
| committed messages/steps | 只含完整提交的模型响应与 tool steps；stream draft 不进入历史 |
| `sourceRevisions` | Authoritative Fact/Control Record 的稳定引用，不复制 Delivery 或外部正文 |
| Native Compacted Window | provider-native 不透明项与 owner metadata；跨 model configuration 不兼容时先迁移 |
| Context Capsule | Coordinator 历史的派生可移植摘要；不是 Recovery Capsule 或业务权威 |

恢复遵循 FLOW-02：取得 Runtime Lease → 读 checkpoint → 对账 pending intent → 投影 Actionable Work → 同步写 Wake Batch → IC-03 写 source admission → 模型 loop。无 Actionable Work 时 suspend；maintenance 不创建 Wake Batch 或 Committed Model Step。

- **失败**：checkpoint 不可恢复时阻塞同一 Session，不创建替代 Session；跨库中途崩溃按 WakeBatchId/source revision 补齐。
- **测试 seam**：LangGraph SqliteSaver 使用临时 `checkpoints.sqlite`；fake model 测试提交/重放；不少于 100 个连续工具调用验证无固定业务 step 上限。

## IC-05 Planning、Authorization 与 ExecutionGraphHistory

- **Owner (Create)**: `m1-plan-and-authorize-execution`
- **Canonical paths**: `src/domain/planning/`、`src/application/planning/graph-history.ts`、`planning-handoff.ts`、`initialize-scope.ts`
- **Extenders (Extend)**: `m1-evolve-execution-graph` 只增加 `appendAcceptedRevision`
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
  permissions: RoleAuthorities;
  limits: ExecutionLimits;
  workspacePolicy: WorkspacePolicy;
  gitPolicy: GitIntegrationPolicy;
  dependencyPolicy: DependencyPolicy;
  acceptedRisks: readonly string[];
};
```

`ExecutionLimits` 必须包含 active Work Package、实现尝试、Validator 修复、Graph Revision、Specification Revision 和每 Worker Attempt Recovery 的有限上限；缺失字段即拒绝。Graph Compiler 只校验 schema、引用、无环、Scope Envelope、预算和可信配置，不评判规划语义。

`PlanningHandoffProposal` 持有 proposal ID、Source/Target Session、地图/计划/候选图 revision、责任集合、phase、expected revision 和可移植 Coordinator Context Capsule ref。prepare/review 不转移责任，cutover 才 CAS；它不触碰在途 Worker 或 Execution Coordination Lease。

- **权威/版本**：图拓扑只经 `ExecutionGraphHistory` 追加；历史 GraphVersion 不改写。Manifest 内容变化产生新版本与新批准。
- **测试 seam**：纯 Graph Compiler 使用表格 fixture；history 使用 IC-03 adapter；tracker 使用 fake gateway 和显式真实隔离 smoke。

## IC-06 SpecificationProvider、Task Contract 与 Admission

- **Owner (Create)**: `m1-admit-work-package-specifications`
- **Canonical paths**: `src/application/ports/specification-provider.ts`、`src/application/specification-admission.ts`、`src/domain/{task-contract,worker-report}.ts`
- **Extenders (Extend)**: `m1-evolve-execution-graph` 通过同一 provider 区分 Contract Revision 与 Tracking Revision
- **Consumers (Consume)**: Implementation、Validation、Recovery、Graph evolution

```ts
interface SpecificationProvider {
  readUnit(input: SpecificationUnitLocator): Promise<SpecificationUnitSnapshot>;
  readRoleTransition(input: RoleTransitionQuery): Promise<RoleTransitionState>;
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

- **失败**：越界、stale binding、未知 provider version 或缺工件时阻塞并保留 worktree；不消耗实现预算或自动清理。
- **测试 seam**：OpenSpec adapter 使用临时 worktree fixture；Application admission 经 `SpecificationProvider` fake 测试同一 interface。

## IC-07 Worker Harness、Task Envelope、Session Binding 与候选报告

- **Owner (Create)**: `m1-admit-work-package-specifications`
- **Canonical paths**: `src/adapters/agents/`、`src/domain/{task-envelope,worker-report,worker-liveness}.ts`
- **Extenders (Extend)**: 无；Recovery 只新建符合该合同的 Dispatch/Session Segment
- **Consumers (Consume)**: Execution、Validation、Recovery、Graph evolution

```ts
type TaskEnvelope = {
  schemaVersion: number;
  workerTaskId: string;
  dispatchId: string;
  attemptId: string;
  role: WorkerRole;
  taskContract: TaskContract;
  specBinding: SpecBinding;
  workspace: WorkspaceBinding;
  authority: RoleAuthorities;
  budget: WorkerBudget;
  expectedEvidence: readonly EvidenceRequirement[];
};

type SessionBinding = {
  harness: 'codex';
  role: WorkerRole;
  workerTaskId: string;
  dispatchId: string;
  attemptId: string;
  providerSessionId: string;
  transcriptRef: string;
  observedAt: string;
};

type WorkerLiveness = 'live' | 'exited' | 'unverifiable';
type WorkerReport = WorkerResult | WorkerQuestion | WorkerEscalation;
```

Task Envelope 中的 scope、Run、consumer generation、OperationId 与协调身份由 Controller/adapter 注入，不接受 Worker 回传值覆盖。Session Binding 必须来自精确 harness 能力；terminal 输出、cwd、mtime 和“最新 transcript”不能作为绑定。Worker report 是候选载荷，边界 parser 先做 schema/role/version 校验。

Session Segment 记录角色、Task、Dispatch、Attempt、Binding、最后 transcript 位置与可核验终态。信息不足时 liveness 为 `unverifiable`，不能推断退出或触发重复派发。

- **测试 seam**：Worker Harness Adapter contract tests 使用托管 hook fixture；真实 Codex/Minimax-M3 仅在隔离项目验证精确 binding。领域层测试 Task Envelope parser 和三值 liveness。

## IC-08 Delivery settlement、Validation 与 Finalizer

- **Owner (Create)**: `m1-execute-and-validate-work-packages`
- **Canonical paths**: `src/application/delivery/process-delivery.ts`、`record-worker-result.ts`、`src/application/validation/`、`src/application/finalization/`
- **Extenders (Extend)**: 无；`m1-recover-execution` 启动时调用同一 pipeline 重放
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

Validator 在同一 Validation Attempt/真实 Session 内验证、范围内修复、复验；代码变化使受影响 Evidence Record 失效。Finalizer 使用新只读项目级 Session，从权威输入重跑并给出 Delivery Verdict。

- **失败/幂等**：任何持久化或回读 unknown 都不 ack；重放同一 DeliveryIdentity 不产生第二正文或生命周期推进。
- **测试 seam**：fake transport + fake Orca result store 覆盖每个崩溃窗口；真实隔离闭环验证 transport 契约而非故障注入。

## IC-09 Recovery、Scope control 与 Execution Handoff

- **Owner (Create)**: `m1-recover-execution`
- **Canonical paths**: `src/application/recovery/`、`src/domain/recovery/`、`src/application/coordination/scope-control-service.ts`、`src/application/handoff/execution-handoff.ts`
- **Extenders (Extend)**: 无
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

Worker Session Recovery 先尝试精确恢复原 session；仅确认不可恢复后才创建替代 Dispatch/Binding/Segment，并保留 Worker Task、contract/revision 和业务 Attempt。Recovery Budget 按 Worker Attempt 创建替代 Segment 时消费，重启不重置。`salvage` 只指 Utility Worker 从精确 Worker transcript 提取 Recovery Capsule 的动作；它不是生命周期或角色。

Recovery Capsule 与 Coordinator Context Capsule 不相同。Finalizer 不依赖 Recovery Capsule，而从权威输入重跑。Pause/Resume/Cancel/Exit 是 Scope 正交控制状态。Execution Handoff 遵循 FLOW-04，不复用 PlanningHandoffProposal，也不把 suspend/Wake 当作责任转移。

- **失败**：transcript 不可用、预算耗尽、角色门失败或 cutover CAS 失败时保持 blocker/Source owner；不伪称原 session 连续恢复。
- **测试 seam**：fake Utility Worker、fake backend 与临时 stores 覆盖 complete/partial/unavailable、迟到结果和 cutover 崩溃；真实隔离测试只验证一次 partial transcript Recovery。

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

Replanning 停止新派发并结清在途/Delivery/Interaction/Intent，建立新 Planning Cycle；Generation Cutover 同批切换 Planning Cycle、GraphId/Generation、Run、Authorization、budget ref 和 Execution Lease。旧完成状态不复制，旧成果只按 Baseline Adoption、Migration Material 或 Planning Reference 进入新规划。

- **失败/版本**：所有 patch 以 baseGraphVersion + expected revision + OperationId 提交，任一步失败不追加 history；Cutover 前可取消，Cutover 后前代永久冻结。
- **测试 seam**：纯 compiler/patch normalization 使用表格测试；history/CAS 使用 IC-03；真实 Orca 只验证隔离候选 Run binding。

## IC-11 ControllerService、Snapshot、SemanticEvent 与用户 intent

- **Owner (Create)**: `m1-recover-execution`
- **Canonical path**: `src/application/controller-service.ts`
- **Extenders (Extend)**: `m1-evolve-execution-graph` 增加图 patch/replanning projection 与 command variants；`m1-wire-foreground-planning-runtime` 增加提交身份、回答正文与事件归属；`m2-deliver-planning-tui` 增加候选图拓扑、压缩状态与规划交接提案投影
- **Consumers (Consume)**: CLI、planning TUI、execution TUI

```ts
interface ControllerService {
  query(input: ControllerQuery): Promise<ControllerQueryResult>;
  execute(input: ControllerCommand): Promise<ControllerCommandResult>;
  subscribe(listener: (event: SemanticEvent) => void): Unsubscribe;
}

type ControllerQuery =
  | { kind: 'snapshot'; coordinationScopeId: string; selectedSessionId?: string }
  | { kind: 'session-transcript'; coordinatorSessionId: string; cursor?: string };

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
  /** 已批准的 Execution Authorization 是否恰好绑定这张图的 GraphId 与 GraphVersion。 */
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
  /** 调用方读到的 GraphVersion 记录投影；未提供记录时为空数组，界面据此显示 blocker 而不是猜测。 */
  graphTopologies: readonly ControllerGraphTopologyView[];
  /** Session checkpoint 中最近一次压缩结论的只读投影；从未压缩时为 null。 */
  compaction: ControllerCompactionView | null;
  /** Route Planning Handoff 提案投影；确认与取消仍走既有 PlanningHandoffCommand。 */
  planningHandoffs: readonly ControllerPlanningHandoffView[];
};
```

`graphTopologies` 与 `compaction` 都由调用方从权威来源读好后注入 `ControllerSnapshotFacts`；façade 不读 store、不推断、不补全。它们是**投影**而非新的权威状态：`/compact` 的准入、执行与终止仍属于 Coordinator Runtime，本 facade 不新增执行路径。

`SemanticEvent` 是 UI 可投影的封闭联合；keepalive、stderr、poll timeout、无变化 reconciliation 和诊断日志不发布。`AnswerPendingInteraction` 必须含 InteractionId、expected revision 和 answer payload；普通 Session message 不满足 interaction。

`m1-wire-foreground-planning-runtime` 的 Extend：`SendSessionMessage` 增加稳定 `submissionId`；`AnswerPendingInteraction` 以 `answer: string` 进入应用用例，由宿主/IC-03 生成稳定 answer ref 并原子存正文。语义事件统一携带 `eventId`、`coordinationScopeId` 与可空 `coordinatorSessionId`，只在对应权威事实已提交并读回后发布。TUI 只用归属 ID 设置未读标记，重启后依快照恢复。

Service 只委派既有用例，不打开 store、不调用具体 adapter、不拥有状态转换。Scope 初始化继续使用 `initializeCoordinationScope`，不塞入 façade。

- **错误/取消**：command 返回结构化 accepted/rejected/unknown 或领域拒绝；stale revision 零副作用。订阅取消只移除 listener。
- **测试 seam**：注入 fake use cases，断言每个 variant 委派一次；snapshot/event contract tests 只断言字段与语义，不锁定内部调用顺序。

## IC-12 Presentation projection、CLI 输出与进程生命周期

- **Owner (Create)**: `m0-orca-control-baseline`
- **Canonical paths**: `src/application/tui/view-model.ts`、`src/interfaces/cli/`、`src/interfaces/tui/`
- **Extenders (Extend)**: `m2-deliver-planning-tui` 在同一合同内实现 planning 投影与 TUI；`m2-deliver-execution-tui` 增加执行态分区
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
};
```

`projectTuiViewModel` 是从 IC-11 `ControllerSnapshot` 到展示 DTO 的纯函数；CLI `status --json` 复用同一公共投影规则但输出独立版本化 machine DTO。TUI 内部只保存选中 Session、scroll、sidebar 密度、overlay 和每 Session 草稿；业务状态来自 snapshot/event。

`m2-deliver-planning-tui` 的 Extend 把 `TuiViewModel` 拆成可复用的纯展示 DTO（`ScopeView`、`SessionSummaryView`、`GraphView`、`WorkerView`、`BlockerView`、`BudgetView`、`InteractionView`、`MaintenanceView`、`CompactionView`、`TranscriptView`）并登记 Home 解析规则：

- **Home 解析**：以 Git common dir 定位 Branch Coordination State，再以当前完整 branch ref 和登记的 canonical worktree 精确匹配 Scope。无匹配则进入初始化向导；旧未绑定记录须经显式迁移 Review；多条冲突匹配或 detached HEAD 阻塞。不得以 common dir 下 Scope 数量推断当前身份。
- **Session 选择**：选中 Session 与 Sidebar 密度都是进程内展示态。重启后按「存在 Pending Interaction 的 Session 优先，否则最近活动」重新选择；M1 没有「上次选择」的持久来源，本 change 不新增表、文件或 migration。
- **`StatusJson` 形状不变**：`schemaVersion` 仍为 1，字段与既有 machine DTO 一致；`status --json` 改为经同一 `ControllerSnapshot` 投影规则构造，不再自行从 store 记录逐字段映射。

顶层 CLI 只识别 `[repository-path]`、`status [--json]`、`doctor`。启动 TUI 前同时检查 stdin/stdout TTY；无 TTY 在挂载 Ink 前非零退出。Exit/Ctrl+C 只退出进程，不隐式 Pause/Cancel。React render/effect/resize/remount 不调用 IC-11 command。

- **版本/可访问性**：状态不能只靠颜色；宽字符按显示宽度裁切。`StatusJson.schemaVersion` 变化时消费者可 fail closed；字段顺序不是合同。
- **测试 seam**：纯 projection 单测、Ink 组件交互测试、真实 PTY 的 TTY/CJK/resize/终端恢复测试；不使用整屏大 snapshot。

## 合同演进规则

1. Owner change 首次创建 canonical symbol 和最小行为测试。
2. Extender 只修改同一路径和登记维度，运行 owner 的原测试及新增行为测试。
3. Consumer 只导入，不定义别名类型、镜像状态、第二 repository/pipeline/snapshot。
4. 实现需要本文未登记的公共字段、枚举、错误、权限、migration 或调用顺序时停止 IP-ID，更新本合同与受影响 change 后再继续。
5. 私有 helper、SQL 细节、React props 和单模块内部拆分不属于本合同；owner 可在不改变调用者知识的前提下调整。
