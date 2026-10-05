# fixture 06 执行 run-sheet（PASS）

现场：/home/joshua/.cache/orca-acceptance/fixtures/orca-cc-concurrency-06（baseline ee6cf84f…，预建标准
openspec/config.yaml）；身份 term_e065b760-80d2-4e61-ae60-dce7c69c8ad8；ref ip05-cc-06-integration；
模型 minimax-cn/MiniMax-M3.1-Flash-Preview；额度 5/8/2。

## 1. 公共环境块

    PATH=/home/joshua/.cache/orca-acceptance/acceptance-bin:$PATH
    XDG_CONFIG_HOME=/home/joshua/.cache/orca-acceptance/fixtures/orca-cc-concurrency-06-xdg
    ORCA_COMPANION_E2E_REPO=/home/joshua/.cache/orca-acceptance/fixtures/orca-cc-concurrency-06
    ORCA_COMPANION_E2E_IDENTITY=term_e065b760-80d2-4e61-ae60-dce7c69c8ad8
    ORCA_COMPANION_E2E_CONCURRENCY=1
    ORCA_COMPANION_COORDINATOR_MODEL=minimax-cn/MiniMax-M3.1-Flash-Preview

## 2. seed 命令（经专用身份终端 terminal send 运行）

    cd /home/joshua/Workspace/Code/JavaScript/orca-companion
    pnpm exec vitest run tests/acceptance/execution-concurrency.test.ts --no-file-parallelism > /tmp/orca-cc-06-run.log 2>&1

无 ORCA_COMPANION_E2E_RESUME → 新 seed；日志 /tmp/orca-cc-06-run.log。

## 3. 同 06 短 RESUME 再验（闭环结束后；不新 seed）

    在环境块中追加 ORCA_COMPANION_E2E_RESUME=1，其余不变，输出 /tmp/orca-cc-06-resume.log

断言：sameOriginalIds（原 planner Task/ctx 不变）；独立 session-starts-orca-cc-concurrency-06-resume.json；
续接 UUID 复用原 provider session；报告按 report-orca-cc-concurrency-06-{seed,resume}.json 各自落盘、不互相覆盖。

## 4. own-pid 控制（禁止 pattern kill）

1. 启动后立即记录三个 pid：ps -eo pid,ppid,args | rg 'execution-concurrenc[y]' → pnpm / vitest / fork。
2. 只对已确认属于本次验收的 Vitest pid 发 SIGINT；绝不按进程名批量停止其它进程。
3. 停止后确认无 execution-concurrency 进程，Scope/Worker/预算/记录保留。

## 5. 结束证据清单

- seed：report-orca-cc-concurrency-06-seed.json + session-starts-orca-cc-concurrency-06-seed.json；
  observation.peakOverlap >= 2（公共 worker-show 区间）；lane baselineHead == fixture 初始 HEAD；
  批准额度来自当前 Manifest 读取（=5）。
- resume：report-…-resume.json + session-starts-…-resume.json；sameOriginalIds=true；
  validated 轮 validationAttemptId == 原 Validator attemptId，续接 dispatchId/orcaTaskId 均不同于原，
  continuationSessionId == originalSessionId（两条精确 codexSessionPathsUnder 路径）。
- test 退出码（EXIT:）写入日志，不以 while-loop 阶段代替结论。

## 6. 实际完成记录

Finalizer 在 2026-10-05T10:22:07.255Z 记录 `deliverable`。原 push 的响应丢失后按原 ID
只读核验 canonical/remote 同为 `87a3d1c26e0c666351915ee79a1b6df74077df32`，结算后继续收尾。
原 Validator 与 round 1 续接 UUID 同为 `01a10b63-6084-7291-bf15-7fc07b88ab67`。

最终同 Scope 恢复：`/tmp/orca-cc-06-restart-readonly.log`，1 项通过，13.16s，`EXIT:0`。
已有 Verdict 时只读核验；原非空 Task/ctx、Work Package 状态及 Attempt 均不变。
完整证据为 `report-orca-cc-concurrency-06-resume.json`、`session-starts-orca-cc-concurrency-06-resume.json`
和 `continuation-proof-06.json`。首轮 Verdict 后取证失败的 `report-…-finalizer-first.json` 保留；
失败原因与模型服务的 529 见目录 README，不计通过。
