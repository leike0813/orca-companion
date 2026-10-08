# 当前能力缺口

本文件只记录与本次实测有关、且会直接影响结论的现状。结论以代码为准，运行期行为以实测观察为准。

## 并发与 lane

设计目标是最多 3 个并行 Work Package、每条 lane 至多一个 Worker，图容量为 8 个 Work Package。`live` Worker 只阻止其所属包内继续推进，其他独立包可继续。实际观测仍受以下证据限制：

- 并发额度与图容量是授权上限，不等于某次采样必然观察到并行 Worker。
- `live` 只占用对应 Work Package；不可核验状态仍须按证据边界处理。

判定边界：`parallel` 需要同一 Run 内两条 lane 共存的 live 正证据；`lane-capacity` 需要完整 Worker 名单证明。图容量 8 不能作为实际并行证据。

## 时间与活跃区间

- `WorkerObservation`（`src/application/execution/execution-view.ts`）只有 `dispatchId`、`taskId`、`workerState`、`terminalState`，没有起止时间。
- 采集证据里的 `observedAt` 是采集时刻，只能近似 Worker 活跃区间，不能冒充起止时间。
- 持久记录（物化绑定、Session Segment、Delivery Settlement、Recovery）的写入时刻可以作为状态转变的上界，但不是 Worker 起止。

## 存活与只读查询

- `status --json` 不调用 Orca，`projection.scope` 为 `store-only`，`missing` 含 `worker-liveness`。要得到 live 或 exited 结论，需要宿主进程内快照，或直接查 Orca。
- 语义事件是进程内订阅（`ControllerService.subscribe`），重启后不保留；持久事实以 store 记录与 Orca 观察为准。
- Graph Basis 没有对应的 CLI 子命令，节点映射与图历史需要经应用侧只读查询获得。

## 用量

- 产品的快照与 `status` 不提供 token 或请求数；`budget-counters` 是消耗计数，不是用量。
- 费用只有在实际取得可信 usage 时才报告，缺失的 token 与费用不估算。

## 过程判定边界

`process-verifier.mjs` 的报告是 `checks` 数组加一个只覆盖必需场景组的总 `status`，没有顶层 `statuses`。按当前实现：

- `unknown`、`handoff`、`validator-repair`、`escalation`、`model-reauthorization` 发生后最多 `INCONCLUSIVE`，未发生 `NOT_COVERED`，不会自动 `PASS`。
- `parallel` 在授权并发额度为 1 时记 `BLOCKED`；额度大于 1 但没有捕获到同一 Run 内两条 lane 的真实 live Worker 时保持 `NOT_COVERED`。
- 名单覆盖不完整（`complete:false`）时，`lane-capacity` 即使捕获到 live Worker 也记 `INCONCLUSIVE`；若捕获到同一 lane 多个 live 仍记 `FAIL`。`parallel` 有两条 lane 共存的 live 正证据即可 `PASS`。
- `recovery` 只有明确阻塞记录时记 `BLOCKED`。
- `retry`：同 WorkerTask 的新 Attempt 光有物化记录不够，每个 Attempt 都要在 `segments`/`settlements` 留下不同的真实 Orca Dispatch；缺 Dispatch 记录记 `INCONCLUSIVE`，只有规格、worktree 或授权绑定不一致才 `FAIL`。
- `cancel`：样本已经是 `cancelled`，但同一个 Run 名单里仍有 live Worker，记 `FAIL`。
- 只读 Finalizer：样本的 status 投影是 store-only、缺 `readOnlyProfile` 或 `workspace` 时，即使有 FINALIZER verdict 记录也记 `INCONCLUSIVE`；某个 Worker 报告通过不会自动给 `finalizer` `PASS`。
- 缺少可核验的样本、身份或回读的场景自动记 `INCONCLUSIVE`，总状态被任一非 `PASS` 拉低。
- 总状态基于必需组，加上已证的 `conditional` `FAIL`：未覆盖的 `conditional` 不影响必需组，任何已证 `conditional` `FAIL` 使总状态为 `FAIL`。
- 证据日志上限 128 MiB 与 10000 条样本；同一 `sampleId` 内容冲突会让必需场景 `INCONCLUSIVE`。

## 验收程序

- 版本规则、默认值、行尾与输出语义由 `contract.json` 拥有；文档只引用，不复制取值。
- 默认值有专门用例：`cases.json` 用 `invoke.omitFlags` 覆盖省略 `--format`、`--threshold-cents`、`--line-ending` 的默认行为，另有缺少参数值、未知参数与重复参数的边界用例。
- `revised` 的结果 golden 同时要求 C1 排序修订与别名归一化；只完成其中一条的中间态没有结果 golden，只能做过程验收。
- 两个验证器都只读：结果验收前后项目 Git 的 HEAD、index 与 status 必须不变，项目也不依赖第三方包。
- 取消运行通常没有可用 CLI 结果，`report` 允许省略 `--result`；此时不生成成品报告，总状态只由 `cancel` 场景决定，`core` 场景统一记 `NOT_COVERED` 表示不适用。
