# IP-05 Recovery 现场只读核验

观察时间：2026-10-04T13:09:05.266Z

现场：`ip05-recovery-20261004j`；Scope：`ip05-ip05-recovery-20261004j-scope`；Run：`run_9b5d8a9bd4c0`。
只通过生产 `BranchCoordinationStore` 的只读 query port 与公开 `ExecutionBackend.query(worker-show)` 读取；未触发 mutation、模型或 Worker。

## 结论

同一业务 Attempt 有 2 条 Recovery 记录。首条为 `recovered`，消耗 1 次；替代 Session 的 Orca worker-show 状态为 `succeeded`。
该 Attempt 的 Recovery 预算为 1/1，剩余 0。
Accepted Worker Result：未发现匹配 Recovery 派发的 Accepted Worker Result 结算记录。Orca worker succeeded/terminal 可见本身不等于 Companion 接受结果。
第二条 Recovery 是针对替代 Segment（`ctx_059ef478ef8a`）新增的来源记录，仍为 pending；阻塞原因：终端仍在已列举主机上存在。它没有创建第二个替代派发，也没有再消耗预算。

## Recovery 与精确 Session

- `recovery:ip05-ip05-recovery-20261004j-scope:segment:ip05-ip05-recovery-20261004j-scope:ctx_f320f1621f0b:attempt%3Aip05-ip05-recovery-20261004j-scope%3Aip05-ip05-recovery-20261004j-scope%2523g1%3A1%3Aip05-ip05-recovery-20261004j-scope%2523g1%253Anotes-basics%3Aimplementation%3A4064813501694813%3A1`: status=recovered; attempt=`attempt:ip05-ip05-recovery-20261004j-scope:ip05-ip05-recovery-20261004j-scope%23g1:1:ip05-ip05-recovery-20261004j-scope%23g1%3Anotes-basics:implementation:4064813501694813:1`; source=ctx_f320f1621f0b; replacement=ctx_059ef478ef8a; consumed=1; terminalOutcome=replaced; blockingReason=无; acceptedResults=0.
  原/来源 Session binding: `session-binding:ctx_f320f1621f0b:01a106f6-c055-7bc3-806c-3ab0c84dd126`; transcript referenceable=true; verifiable=true.
  替代 Session binding: `session-binding:ctx_059ef478ef8a:01a106f8-6e8e-78e1-b029-9f4d5251a654`; transcript referenceable=true; verifiable=true.
  Orca source state=failed; replacement state=succeeded; exactWorker=true.
- `recovery:ip05-ip05-recovery-20261004j-scope:segment:ip05-ip05-recovery-20261004j-scope:ctx_059ef478ef8a:attempt%3Aip05-ip05-recovery-20261004j-scope%3Aip05-ip05-recovery-20261004j-scope%2523g1%3A1%3Aip05-ip05-recovery-20261004j-scope%2523g1%253Anotes-basics%3Aimplementation%3A4064813501694813%3A1`: status=pending; attempt=`attempt:ip05-ip05-recovery-20261004j-scope:ip05-ip05-recovery-20261004j-scope%23g1:1:ip05-ip05-recovery-20261004j-scope%23g1%3Anotes-basics:implementation:4064813501694813:1`; source=ctx_059ef478ef8a; replacement=无; consumed=0; terminalOutcome=无; blockingReason=终端仍在已列举主机上存在; acceptedResults=0.
  原/来源 Session binding: `session-binding:ctx_059ef478ef8a:01a106f6-c055-7bc3-806c-3ab0c84dd126`; transcript referenceable=true; verifiable=true.
  Orca source state=succeeded; replacement state=not dispatched; exactWorker=n/a.

## PTY 分页失败

此前 PTY 断言受 footer 裁切和首帧竞态影响；主会话修正探针已成功读取 7 页，Recovery 完整字段可见。本次只读端口结果与该探针一致。因此该 UI 采集失败没有遮挡 Recovery 状态、Attempt 预算或阻塞原因的结论。

此证据仅证明该实现 Worker 的 Recovery 状态与结果结算事实，不证明整个 IP-05 execution/patch/retire/restart/replanning 流程全部通过。
