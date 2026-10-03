## 1. 合同与安全调用

- [x] 1.1 实施 IP-01：独立历史/预览窄读取合同与临时存储；`pnpm exec vitest run tests/adapters/transcript-preview-store.test.ts`。
- [x] 1.2 实施 IP-03：输出/上下文配置与 storage budget；`pnpm exec vitest run tests/bootstrap/project-config.test.ts tests/adapters/checkpoint-store.test.ts`。
- [x] 1.3 实施 IP-02：生产 stream、SDK 最终响应、工具接受、usage 和非重试中断；`pnpm exec vitest run tests/workflow`。

## 2. 局部阅读与生产接线

- [x] 2.1 实施 IP-04：Marked、来源锚点、局部 Markdown/换行、双缓存；`pnpm exec vitest run tests/tui/transcript-reader.test.ts`。
- [x] 2.2 实施 IP-04：正式 App/Workspace/Transcript 的导航、工具、resize、阅读版本与输入返回；`pnpm exec vitest run tests/tui`。
- [x] 2.3 实施 IP-05：宿主 observer、preview/query/订阅、配置装配、Scope Cancel/fencing/Exit；`pnpm exec vitest run tests/bootstrap/foreground-planning-runtime.test.ts tests/coordination/scope-control.test.ts`。

## 3. 验收与交接

- [x] 3.1 实施 IP-06：真实生产阅读性能 1千/1万/10万、1/5MiB与至少100采样，输入/缓存导航 p95≤100ms；`node artifacts/bounded-transcript/benchmark.mjs`。
- [x] 3.2 实施 IP-06：三档两色/图标真实 PTY、六票画面对照与操作证据；`pnpm exec vitest run tests/tui/pty.test.ts`、`node artifacts/bounded-transcript/capture.mjs`。
- [x] 3.3 实施 IP-06：合同/配置/交接文档及工件报告；typecheck、lint、test、build、OpenSpec strict、diff 全部检查；未固定实现 HEAD 时不创建 verification.md。
