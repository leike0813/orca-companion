# Tasks

## 1. 权威历史读取与搜索

- [x] 1.1 IP-01：实现调用/参数/普通输入 DTO、有限派生索引与存储读取。验证：pnpm exec vitest run tests/adapters/history-inspection.test.ts
- [x] 1.2 IP-02：可信工具分类与原调用 unknown 观测，不伪造配对结果。验证：pnpm exec vitest run tests/workflow --maxWorkers=4
- [x] 1.3 IP-04：实现独立、有界、可取消的原文搜索与 Unicode 原位置映射。验证：pnpm exec vitest run tests/application/history-search.test.ts

## 2. 交互与阅读

- [x] 2.1 IP-03：跨页活动、参数与结果详情、Ctrl+T 整体详细和 F4 局部导航。验证：pnpm exec vitest run tests/tui/transcript-reader.test.ts tests/tui/activity-navigation.test.tsx
- [x] 2.2 IP-04：接通 F3 搜索、命中定位、高亮和 Esc 原阅读状态恢复。验证：pnpm exec vitest run tests/tui --maxWorkers=4
- [x] 2.3 IP-05：实现普通输入召回、Ctrl+R 采用、原草稿恢复与原提交保护。验证：pnpm exec vitest run tests/tui/input-history.test.ts

## 3. 宿主与验收

- [x] 3.1 IP-06：生产宿主绑定、初始化索引、预览接线及当前合同/交接文档。验证：pnpm exec vitest run tests/bootstrap tests/tui/host-wiring.test.ts tests/tui/no-side-effect.test.tsx --maxWorkers=4
- [x] 3.2 IP-06：生产 SQLite/App 长历史与巨大参数/结果基准，输入及导航 p95 和有界工作区证据。验证：node artifacts/history-inspection/benchmark.mjs
- [x] 3.3 IP-06：六票原型、三档 PTY、返回与终端恢复证据；完整必要检查。验证：node artifacts/history-inspection/capture.mjs；pnpm typecheck；pnpm lint；pnpm test --maxWorkers=4；pnpm build；openspec validate inspect-and-search-coordinator-history --strict；git diff --check
