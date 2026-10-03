## 1. 权威存储

- [x] 1.1 IP-01：实现关联增量存储、有界metadata/body、独立有效上下文与精确恢复；`pnpm exec vitest run tests/adapters/checkpoint-store.test.ts`。

## 2. 生产消费者

- [x] 2.1 IP-02：接通应用核验/压缩、workflow及全部宿主读写；`pnpm exec vitest run tests/application tests/workflow tests/bootstrap --maxWorkers=8`。

## 3. 正式分页阅读

- [x] 3.1 IP-03：接通Controller/TUI keyset、正文导航、失败/迟到/返回，保留定稿布局与草稿；`pnpm exec vitest run tests/tui --maxWorkers=8`。

## 4. 验收与交接

- [x] 4.1 IP-04：补齐实际存储计量/原子失败/生产分页与三档Ubuntu PTY原型证据；运行上述行为测试及 `node artifacts/coordinator-history/capture.mjs`。
- [x] 4.2 IP-04：同步IC-04/11/12、架构/交接，`pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm test`、`openspec validate paginate-coordinator-history --strict`、`git diff --check`。
- [x] 4.3 IP-04：固定HEAD+实现diff，完成HIST-INCREMENTAL/HIST-ATOMIC/HIST-UI独立只读审计，无必要审计待处理。
