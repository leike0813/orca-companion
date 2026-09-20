# Verification

## 验收对象

- Change：`m0-orca-control-baseline`
- 输入实现 HEAD：`281aaee0e8962ae1f89d4555031f5983f255d79e`
- 最终验收 HEAD：`281aaee0e8962ae1f89d4555031f5983f255d79e`（验收修复保留在当前未提交 worktree，未获授权提交）
- 验收 Agent：Codex

## 结论

**PASS**。边界为当前 Ubuntu 环境、Orca CLI/runtime `1.4.198` 与 OpenSpec 所定义的 M0 控制基线。13/13 implementation tasks、四个 capability 的全部 Requirement/Scenario、IP-1～IP-12 与两项限定审计均已核验；验收中发现的 CLI 参数漂移、运行时输入校验缺口和 doctor 命令面核验缺口已经修复并完成回归。

## 核验与修复证据

| Requirement / Scenario / IP-ID | 证据或命令 | 结果 |
|---|---|---|
| 封闭操作边界、必填 ExecutionScope、未声明操作拒绝；IP-1/IP-2/IP-8 | `tests/orca-backend.contract.test.ts`；`pnpm test` | 未声明/类型错配/缺 scope/伪造 authority/缺失字段在进程启动前拒绝；PASS |
| 三值结果、确定失败 accepted、unknown 与原 ID 对账、对账阻塞；IP-1/IP-2/IP-8 | `orca-backend.ts`、`error-classification.ts`；`pnpm test` | `accepted/rejected/unknown` 与 `completed/pending/absent` 路径全部通过；PASS |
| 当前 Orca operation catalog 与公开参数 | `orca orchestration <command> --help`、`orca terminal <command> --help`；catalog contract test | 移除 `worker-list` 已退役参数；生命周期命令不再错误注入 `--from`；PASS |
| 参数数组、显式 cwd/env、stdout/stderr 分离、截断、非零退出、不可达、超时与取消；IP-3/IP-7 | `tests/process-runner.test.ts`；`pnpm test` | 7 个行为边界通过；PASS |
| Delivery 读取/确认分离、identity 与原始 payload 保留；IP-4/IP-9 | `tests/delivery-transport.test.ts`；隔离探针 | 读取零确认、独立 ack、三值结果、task/dispatch/attempt payload 归属通过；PASS |
| doctor 环境、版本、runtime、host、身份、24 个 M0 必需公开命令、无 TTY；IP-5/IP-6/IP-10 | `node dist/src/interfaces/cli/main.js doctor` | 退出 0；7 项检查均为 `ok`，stdout 为机器 JSON；PASS |
| 隔离目标、专用身份、固定 MiniMax-M3、单 Worker 闭环、确认后不重放、重连不重复派发；IP-11 | `ORCA_M0_PROBE=1 ORCA_M0_PROBE_MODEL=minimax-cn/MiniMax-M3 pnpm test -- tests/m0-isolated-probe.integration.test.ts` | 57/57 tests PASS；Run `run_575ad2c85787`，唯一 Dispatch `ctx_638cea95a219`；PASS |
| 探针结论与兼容性文档；IP-12 | `docs/orca-compatibility.md`；`rg -n "M0 门禁结论|尚未验证|MiniMax-M3" ...` | 最新 Run、Dispatch、临时仓库与未核验边界已同步；PASS |
| OpenSpec 工件完整性 | `openspec validate m0-orca-control-baseline --type change --strict --json --no-interactive` | 1/1 valid；13/13 tasks complete；PASS |
| 项目回归 | `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`、`git diff --check` | 全部退出 0；56 tests PASS、1 个真实探针默认跳过；PASS |

验收阶段完成的修复：

- 将 operation catalog 收窄到 Orca 1.4.198 当前公开参数：删除 `worker-list` 不支持的 `--include-remote`、`--cursor`、`--limit`，删除 `worker-stop` / `worker-abandon` / `worker-release` 不支持的 `--from`。
- 在 argv 构造前补齐缺失字段、非法枚举、无效可选值、互斥参数与 execution authority 的运行时 fail-closed 校验。
- `doctor` 新增 24 个 M0 必需公开命令的实际存在性核验，并补回归测试。
- 用最新隔离闭环结果更新兼容性文档，并修正研究契约表中的旧 `worker-list` 参数。

## 限定审计

- `@M0-PROBE-DOC-SYNC`：PASS。测试固定 `minimax-cn/MiniMax-M3`，兼容性文档记录同一模型、最新 Run/Dispatch、保留现场和未核验项。
- `@M0-UNKNOWN-RECONCILE`：PASS。unknown 只携带原 `OperationId`/后端 request id，经只读 `request-show` 对账；未发现换 ID 或自动重放 mutation。

## 后续注意事项

- provider transcript 绑定、runtime 重启后的 handle/session 恢复、迟到 generation fence、Worker release/archive 路径与 Windows 行为仍未核验；这些不属于本 M0 PASS 边界。
- 本次隔离探针按设计保留 `/tmp/orca-companion-m0-probe.KYmCtX` 及对应 Orca Run/Dispatch，未执行清理。
