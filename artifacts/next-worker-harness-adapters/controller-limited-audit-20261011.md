# Controller 限定审计

独立只读审计：Fermat，gpt-6-luna。依据 IC-02/08/09 与 D-06，覆盖 Worker sender、退出 Validator 问题、Capsule 读取/消费、startup/replay 整批确认、替代派发顺序、首次授权租约、替代报告路径、旧 blocker 投影和已结算 Finalizer 重启。审计没有编辑文件、调用 Orca 或模型，也没有独立复跑父线程的测试。

发现与处理：

- Capsule 落盘后有一条缺消费引用的重复直接 ack，返回值也未使用。已删除；消息确认仍由原 Delivery 重放和整批守卫统一拥有。
- 验收把 terminal-close accepted 当成退出证明。现先拒绝 `value.ok=false`，再有界公开 worker-show 回读精确 Task/Dispatch，只有 observation exited 才继续，unknown 不重发。
- 成功的普通 Delivery outcome 有 `confirmed:true`，但 `laneKey:null`，因此清不掉旧启动 blocker。现只对 confirmed outcome 按 deliveryId 调用已有 ackLaneKey；progress 使用同一构造。confirmed/unknown 参数回归覆盖确认 lane 与未确认列表，14/14 通过。

最后一轮复核确认前述 P2 已解决，未发现可证实新增问题。终态 frontier 过滤只影响等待原因；Finalizer 已完成短路核验确定性身份、原物化授权、Session Segment 与同 Run/Dispatch/Attempt 结算，未结算旧派发仍要求只读证明。替代 Validator 从精确 recovered 记录取报告路径，没有借用当前默认 profile。

父线程相关六份回归 105/105 通过；已结算 Finalizer 重启测试单独 11/11 通过。独立[真实 Controller 证据](controller-20261011T085821980Z-89759c30-e5f4-4a09-8624-89e137fe85f5.json)记录 deliverable、人工中断恢复、集成与同 Scope 重启。

本审计仅覆盖上述修改，未做全仓审计或独立模型验收。原生认证与 transcript 安全读取见 `limited-audit.md`；最终实现身份与整合检查见 `implementation-checkpoint-20261011.json` 和 `final-checks-20261011.md`。
