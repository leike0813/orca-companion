## 1. 合同与准入

- [x] 1.1 IP-01：统一额度、图预算、配置/Manifest schema 和限定额度重授权；运行领域/配置/授权测试。
- [x] 1.2 IP-02：事务 lane reservation、预算/worker 互斥、恢复释放；运行 coordination-store 与物化测试。
- [x] 1.3 IP-02：共享多包调度入口、当前 canonical 基线、包级阻塞/恢复/修订；运行 advance-execution 与 foreground runtime 测试。

## 2. 集成与界面

- [x] 2.1 IP-03：合并树复验、原 Validator 精确续接、稳定轮次预算、串行集成和 Finalizer；运行 Git/Session/执行测试。
- [x] 2.2 IP-04：TUI 设置、保存/批准分离、多活动包 DTO 与 status JSON；运行 TUI/CLI/设置测试。
- [x] 2.3 IP-01/04：更新 AGENTS、CONTEXT、architecture、interface-contracts 和当前原型交接漂移；核对当前合同。

## 3. 完整验收

- [x] 3.1 IP-05：并发 1/2/3/5、准入竞态/崩溃、局部 unknown、Git 分叉/冲突/会话和额度降低回归；运行相关 Vitest。
- [x] 3.2 IP-05：隔离真实 Orca/Codex 多 Worker 闭环和 TUI 三档画面/PTY；记录身份、并行区间、原 Session 与 Verdict。
- [x] 3.3 IP-05：pnpm typecheck、pnpm lint、pnpm test、pnpm build 和 openspec validate restore-configurable-execution-concurrency --strict 全部通过。
