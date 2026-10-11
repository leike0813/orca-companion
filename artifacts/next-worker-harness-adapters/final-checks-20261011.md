# 最终整合检查

日期：2026-10-11。Ubuntu x86_64，Node.js 24.12.0、pnpm 11.10.0。检查覆盖本轮最终生产修改，包括替代 Validator 报告路径、已结算 Finalizer 重启和已确认 Delivery 的旧 blocker 清理。

| 检查 | 结果 | 本机完整日志 |
| --- | --- | --- |
| `pnpm typecheck` | exit 0 | `/var/tmp/ocp-harness-typecheck-final-v9.log` |
| `pnpm lint` | exit 0 | `/var/tmp/ocp-harness-lint-final-v6.log` |
| `pnpm build` | exit 0 | `/var/tmp/ocp-harness-build-final-v4.log` |
| `pnpm test --maxWorkers=1` | exit 0；204 文件通过 / 9 文件跳过；2394 测试通过 / 18 跳过；623.20 秒 | `/var/tmp/ocp-harness-final-vitest-20261011-v7.log` |
| `openspec validate add-testable-worker-harness-adapters --strict` | valid | `/var/tmp/ocp-harness-final-openspec.log` |
| `git diff --check` | exit 0 | 无错误输出 |

构建结束后才启动全量测试，避免 PTY 用到半写的 dist；测试使用单 Worker，不修改 timeout。真实验收默认开关关闭，跳过项不算通过，也没有再次调用模型。

独立真实验收另有[Worker 矩阵](ip04-2026-10-11T05-08-24-154Z-7fc1a011-b14e-47d2-8e5a-e550e0635a8d.md)（45 passed / 2 skipped，730.57 秒）与[混合 Controller](controller-20261011T085821980Z-89759c30-e5f4-4a09-8624-89e137fe85f5.md)（1 passed，46.15 秒，deliverable）。Controller 包含沿原 Scope 恢复、人工中断后 Capsule/替代 Validator、集成、私有 origin 推送与同 Scope 重启。原生全局配置 hash 不变。

[限定审计](controller-limited-audit-20261011.md)的发现均已处理，最后复核没有可证实新增问题。最终未提交身份见 `implementation-checkpoint-20261011.json`：HEAD、tracked binary diff 及 untracked 文件 manifest；指纹不包括检查点自身与 diff 工件，避免循环 hash。旧安全审计中的指纹属于当时历史检查点。

一次性现场累计回收 135 个终端、21 个 checkout，见[回收汇总](cleanup-summary-20261011.json)。认证、原生 transcript 和归档保留。上游固定至 `cc5c85fb7a43ed52c6cd29157210020cd769d84c`，submodule 工作区干净；本机 Orca 仍为 1.4.222。

不提交、不 archive、不创建 verification。Windows/arm64 未实测；C/Q 写角色的原生 `--yolo` 无额外 OS 文件隔离。#52 限定布局与返回核验见 `ui/README.md`，不宣称六票完整人工视觉验收。
