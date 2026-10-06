# IP-15 Worker Harness Matrix

范围：隔离一次性 Orca 项目与专用协调身份下的角色派发、精确 Session 绑定、原 Session resume/recovery 和混合角色。这是 harness adapter 验收；完整 Controller 流程由应用与 runtime 回归另外覆盖。

| Harness | 本机版本 | 固定验收模型 |
| --- | --- | --- |
| Claude Code | 2.1.289 | Opus → `MiniMax-M3.1-Flash-Preview` |
| OpenCode | 2.0.21 | `minimax-cn-coding-plan/MiniMax-M3.1-Flash-Preview` |
| pi | 1.0.0 | `minimax-cn/MiniMax-M3` |
| OMP | 18.4.10 | `minimax-code-cn/MiniMax-M3.1-Flash-Preview` |

Orca 为 1.4.218。实际模型从已核验 transcript 的 assistant 记录取得，Finalizer 完成标记也只读 assistant 文本；Worker 完成通知先于最后响应落盘时有界等待。文件产物、完整 coverage 和同一 Session 恢复分别断言。只读能力由生产共用 bwrap 包装器与拒写探针验证。

## 验证结果

最终完整真实矩阵通过：15 项通过、1 项按条件跳过。四个 harness 的 16 次角色运行与 4 次原 Session 恢复，以及同一 Run 的 `claude → opencode → pi → omp` 混合流程全部通过。20 次角色的文件或答复产物、coverage 与实际模型均符合预期，4 次恢复的 `sameSession=true`。见 [最终摘要](ip15-2026-10-06T05-02-57-524Z.md) 与 [结构化证据](ip15-2026-10-06T05-02-57-524Z.json)。

本次使用 `KEEP=1` 保留现场完成源证据核验，随后经公开 Orca 接口回收；8 个用户级配置/认证文件在最终验收开始后无修改。24 个 Dispatch 已请求 stop/release（已结算的 external terminal 仍记 retained）；`terminal close --worktree … --all` 后回读终端数为 0，核验的 67 个进程全部退出。自建 project setup 已注销，原 selector 返回 `selector_not_found`，私有临时目录已删除。Run/Task/Dispatch 历史保留在 Orca。

开发期各轮的 fixture 已一并回收：46 个一次性 project setup 经 `project setup-delete` 注销，46 个 `/var/tmp/orca-harness-acceptance-*` 目录删除，回读 `worktree list`、`project setups`、`project list` 与 active worker 均为零残留。

离线全量：182 个测试文件通过，7 个按条件跳过；2138 项通过、16 项跳过。`pnpm typecheck`、`pnpm lint`、`pnpm build`、`git diff --check` 与 OpenSpec strict 校验通过。新增原生连接应用与候选隔离也在真实宿主端口回归中通过。

## 复验

```sh
pnpm test --maxWorkers=8 --testTimeout=30000 --hookTimeout=30000
ORCA_COMPANION_REAL_ACCEPTANCE=1 pnpm exec vitest run --maxWorkers=1 --testTimeout=1800000 tests/acceptance/worker-harness-matrix.test.ts
```

入口：[worker-harness-matrix.test.ts](../../tests/acceptance/worker-harness-matrix.test.ts)，支持：[worker-harness-acceptance.ts](../../tests/support/worker-harness-acceptance.ts)。未开启真实开关时不读凭据、不调用 Orca；`ORCA_COMPANION_REAL_ACCEPTANCE_HARNESSES` / `_ROLES` 可限制范围，`_KEEP=1` 保留现场供诊断。清理失败保留目录并使验收失败。

同目录 `ip15-<timestamp>.json|.md` 保存各轮摘要，包含失败或部分运行，不能把旧文件的 Worker succeeded 当作完整通过。摘要不保存秘密或 transcript 正文。本轮未采集可核验的 usage，费用未记录。

原生参数、认证与隔离限制见 [Orca 兼容性基线](../../docs/orca-compatibility.md)；三档生产模型页画面见 [TUI 证据](../worker-harness/tui/README.md)。
