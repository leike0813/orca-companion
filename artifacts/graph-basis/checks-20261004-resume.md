# 2026-10-04 恢复后的普通验证

## 验证边界

- 固定 HEAD：`41b2f1e636c110441a0a344fc20749911b085201`。
- 验证期间工作区已有 `complete-tui-graph-basis` 的实现、测试、OpenSpec 与 artifacts dirty changes；主 agent 另调整了 `tests/tui/pty-execution.test.ts` 的 palette 驱动方式和授权详情合同引用。验证未修改这些代码或任务状态。
- 主 agent 报告已完成 build；本次没有重复运行 build。没有启用真实 gate，没有调用真实模型或 Orca，也没有启动第二个真实现场。
- 本报告更新时，主会话正在运行后续 h 真实现场；按主会话要求，h 现场完成前不启动新的全量测试。
- 本次直接执行的检查将完整 stdout/stderr 与退出码分别保存在 `rawlogs/*.log` 和对应的 `*.exit`；主会话提供的复跑记录按现有日志单独引用。

## 检查结果

| 命令 | 结果 | 记录 |
| --- | --- | --- |
| `pnpm typecheck`（初次） | 通过，exit 0 | `rawlogs/typecheck.log`, `rawlogs/typecheck.exit` |
| `pnpm lint`（初次） | 通过，exit 0 | `rawlogs/lint.log`, `rawlogs/lint.exit` |
| `pnpm test --maxWorkers 4` | 失败，exit 1；1747 passed、12 skipped、1 failed；168 个测试文件中 161 passed、6 skipped、1 failed | `rawlogs/test.log`, `rawlogs/test.exit` |
| `startup-reconciliation.test.ts` 完整文件复跑 | 通过，exit 0；12 项通过 | `rawlogs/startup-recheck.log` |
| 普通真实 PTY | 13 项通过 | `rawlogs/ordinary-pty.log` |
| `openspec validate complete-tui-graph-basis --strict` | 通过，exit 0 | `rawlogs/openspec-strict.log`, `rawlogs/openspec-strict.exit` |
| `git diff --check`（初次） | 通过，exit 0 | `rawlogs/diff-check.log`, `rawlogs/diff-check.exit` |
| `pnpm typecheck`（脚手架调整后复核） | 通过，exit 0 | `rawlogs/typecheck-final.log`, `rawlogs/typecheck-final.exit` |
| `pnpm lint`（脚手架调整后复核） | 通过，exit 0 | `rawlogs/lint-final.log`, `rawlogs/lint-final.exit` |
| `git diff --check`（脚手架调整后复核） | 通过，exit 0 | `rawlogs/diff-check-final.log`, `rawlogs/diff-check-final.exit` |

全量测试的唯一失败用例是 `tests/bootstrap/startup-reconciliation.test.ts` 中的 **“步骤 1 运行时启动失败仍然整次拒绝（回归保护）”**（测试定义位于该文件第 724 行）。全量运行时 Vitest 报告 `Test timed out in 5000ms`。随后主会话单独复跑该完整测试文件，12 项全部通过，exit 0，详见 `rawlogs/startup-recheck.log`。因此保留全量运行的 exit 1，同时记录文件级复跑通过；两次结果分别呈现。

旧全量运行中 PTY palette 固定 index 与预算详情旧合同造成的失败属于已修正的测试脚手架问题；主 agent 提供的局部复验为 32 项通过。本次普通全量测试没有启用真实 gate，保留了现有条件跳过数，没有把跳过项计为通过。全量日志中的其他 Node SQLite experimental warning 不是失败项。

后续 PTY driver 调整包括首次命令等待上限 180 秒、精确等待查询字段并显式按 Down 选择、Scope 用例上限 240 秒，以及将旧门禁文案断言改为可观察的批准动作断言。主会话另报告：`read-basis.mjs` 经生产 port 成功读取 Cutover 的两代图与 4 段正文，Scope revision 保持不变；该读取结果由主会话提供，本目录当前未见对应 raw log。h 真实现场结束后再决定是否补跑全量测试。

本记录不代表全部 IP-05 验收完成，不更新 OpenSpec tasks，也不作为 OpenSpec verification。
