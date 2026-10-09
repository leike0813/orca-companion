# Agent harness 核心实施证据

对应 change：[`stabilize-agent-harness-core`](../../openspec/changes/archive/2026-10-09-stabilize-agent-harness-core/implementation-plan.md)，已于 2026-10-09 归档并随实现提交。本文件记录当时的运行结果，不替代 OpenSpec verification。

## 已验证行为

- 正式配置绑定在请求前核验；完整响应沿 SDK → appendModelStep 提交。提交失败会停止轮次，同一驱动再次调用不会再请求模型。
- 网络断连与 429 最多三次尝试，400 一次；内部、上下文、落盘、取消与输出超限不重试。`running` 先于请求落盘；故障及中断后的新输入、定时入口与重开均不能自动恢复。
- `/stop`、`/retry` 与退出取消共用轮次驱动。Ctrl+C 在能力探测及 SSE 中生效；SIGTERM 取消；SIGKILL 后读到 durable running，需要明确恢复，保持原 Session/配置/消息身份。
- 非 Git 目录可用 `--debug`；独立 XDG 状态，正式 ProviderLibrary/CredentialStore/固定 SDK。四个只读工具有根目录及资源边界；子目录 Git diff、literal pathspec、符号链接、取消与微小输出预算都有回归。
- 共用历史、压缩、流式阅读、composer、光标与输入保护。未知提交核验受理后释放等待位，保留后来编辑；命令目录可搜索，工具详情与 Help 可阅读。
- 连续文字/Enter 与 slash 双 Enter 不依赖 React 下一帧。回归在旧输入时序下失败，在同步状态修复后通过；同一数据块里的回车仍遵循 Ink 的粘贴语义，不自动发送。

## 本地正式链路

```sh
pnpm build
pnpm exec vitest run tests/integration/debug-harness-e2e.test.ts
```

8 项实际 CLI → tuistory PTY → 固定协议 SDK → HTTP/SSE 场景通过。服务记录请求和活跃连接；没有用 UI mock 的调用次数代替 HTTP 计数。每个服务最多接受100个 HTTP请求。最终全量结果见 [`final-vitest-2026-10-09-observed-input.log`](final-vitest-2026-10-09-observed-input.log)：196个文件通过、7个跳过，2218项测试通过、16项跳过。`pnpm typecheck`、`pnpm lint`、`pnpm build`、严格OpenSpec验证及 `git diff --check` 均通过；环境条件跳过的集成用例未被算作通过。

收尾中保留了先前失败日志：连续按键读取上一帧草稿已通过同步输入状态修复，PTY驱动改为等待可见草稿、回答编辑器与slash采用完成，避免 `waitIdle` 在无回显时提前返回。回归和最终全量验证包含这些修正；没有放宽模型请求数、停止或取消断言。

最终 [进程检查](process-check-2026-10-09T11-03-29.888Z.json) 于2026-10-09 11:03:29 UTC执行：当前项目、原lab和本次E2E/MiniMax临时目录均未发现残留Harness进程；各服务的退出后连接计数另由E2E及下面的实测记录证明。

## MiniMax 实测

```sh
node artifacts/agent-harness-core/minimax-smoke.mjs /home/joshua/.local/state/orca-companion/ledger-lab/ledger-lab-main-20261009082337625-898346b7/repo/orca-companion.json
```

[`result.json`](minimax-2026-10-09T10-18-17.386Z/result.json)：新隔离 Session，MiniMax-M3.1-Flash-Preview；含能力探测共 **9/12** 个真实后端请求，3条已提交 assistant记录、1个配对 read_file 调用，Ctrl+C正常退出，活跃后端请求为0。只读取原项目配置及 CredentialStore；没有打开或推进原 lab Session。临时密钥没有进入本目录、日志或截图。

## 终端画面对照

```sh
node artifacts/agent-harness-core/capture.mjs
```

最终画面：[`capture-2026-10-09T10-42-46.918Z`](capture-2026-10-09T10-42-46.918Z/samples.json)。120×40、80×24、50×40各有有色/无色版本，共54个 PNG及文本帧：空会话、问候、折叠工具、工具详情、中文光标插入、slash候选、命令目录、帮助及协调工作区。请求计数54（Agent18），退出后活跃连接0。

对照已确认的 `artifacts/tui-prototype/continuous-v2b-80x24.png`、`artifacts/composer-prototype/slash-above-all-80x24.png` 及其源码：continuous transcript、用户边线、Agent标记、折叠工具、圆角composer、输入上方候选保持；协调布局的sidebar宽度和窄屏隐藏保持。实际查看三档图像，确认工具详情刷新、空会话无错误、overlay不抢composer输入、中文“首中尾”及游标位置。此前两轮capture保留了修复前证据，最终对照使用上述目录。本次没有声称完成六票原型的全部人工验收。

## 限制

未执行完整Orca业务lab、Windows或新的IME人工验收。PID复用和不可读锁均保守拒绝；注册表锁或回收锁自身崩溃遗留时，需要人工核验后处理。原lab现场保留。真实MiniMax记录来自本次实施过程；其后的上下文、取消、工具边界和TUI修正由本地正式链路及回归验证。
