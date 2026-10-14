# Worker Harness 分级续验（2026-10-14）

承接 `add-next-worker-harness-adapters` 和基线 `21ddd79`。等级以
`src/domain/worker-harness-support.ts` 的连续证据规则为准；身份登记不授予角色权限。
本页与本轮追加工件记录续验，不扩大首轮 verification PASS，也不改写旧失败现场。

运行环境为 Ubuntu x86_64、未修改 Orca CLI/runtime 1.4.224，runtime ID
`9504f185-ea15-49a0-bdf1-909bde15d5f2`，submodule 为
`cc5c85fb7a43ed52c6cd29157210020cd769d84c`。Kilo 7.8.8、Kimi 2.1.1、
Cline 3.0.70。模型沿原批准绑定：Kilo/Cline 使用
`minimax-cn-coding-plan/MiniMax-M3.1-Flash-Preview`，Kimi/Hermes 使用
`MiniMax-M3.1-Flash-Preview`；effort 保持 null。

| 候选 | 续办前 | 当前准入 | 本轮边界 |
| --- | --- | --- | --- |
| Kimi | unavailable | enhanced | 四角色、精确恢复与 Validator 上下文续接通过；Recovery/mixed Controller 未验证 |
| Hermes | unavailable | enhanced | 同上；历史仍 partial，complete 不成立 |
| Kilo | basic | basic | 新增 Validator 成功事实；其他输入/续接仍缺报告 |
| Cline | unavailable | unavailable | 原生 MiniMax 界面成立，监督接管 unknown，原 lane 保留 |
| Muse / Cursor | unavailable | unavailable | 缺 CLI、原生登录和获批模型 |

## Kimi：信任与普通工具审批

旧现场 `/var/tmp/orca-harness-acceptance-ehbi1C`、Run `run_bb51bb16dbd5`
仍可由原协调 handle 核验。原准备失败的终端
`term_d68bd02b-6851-422c-9912-75c4e2c6157d` 的当前 screen 明确显示该空测试
仓库的 Trust this folder；核对路径、无项目 MCP 配置后确认，原 handle 的公开
`tui-idle` 为 satisfied/running。此确认只作用于该目录，不自动信任未来 worktree。

随后两项独立角色派发均完成，但因 adapter 未指定运行权限模式，普通 shell 与
Orca completion 命令需要逐项确认。[辅助运行证据][kimi-assisted]保留其范围。
所属 adapter 的普通与精确恢复启动现在使用原生 `--yolo`（Ask When Needed），
只允许常规操作自动执行，风险操作仍由原生规则审批；不修改默认权限或信任库。

在新的 launch/Task/Dispatch 上复验后，Planner 与 Implementation 均自行完成、
结算 succeeded、工件正确，原生 Session/transcript/model 字段如实为 null。
[自动基础证据][kimi-basic]足以取得 basic；模型回显不是阻塞项。

增强探索的 [首轮][kimi-enhanced-first]和[原身份复核][kimi-enhanced-observed]
分别保留：运行中的 ZIP/export 暂时不可核验，但同一 Implementation 的原
Task/Dispatch/terminal 在确定 succeeded 后可读 complete，精确原 Session resume
也成功。Validator 的同类失败进一步确认了运行期快照与结算读取的时序问题。

验收 support 现在在原 Worker 确定结算后核验同一原生快照，对原来源做原有有界
重读；不重发输入、不放宽生产 ZIP/identity 校验。[最终矩阵][kimi-enhanced]
四角色均 succeeded、工件正确、coverage complete，Implementation resume 和
Validator 续接均 sameSession=true，后者 contextPreserved=true。断言自检 exit 0，
由此提升 enhanced。虽然完整历史已证明，Recovery/mixed Controller 仍未验证，
不自动授予 complete，也不把早期失败覆盖为成功。

## Hermes：基础成功与验收材料刷新

[基础矩阵][basic]中的 Planner、Implementation 均有精确 Task/Dispatch/terminal、
succeeded 与独立工件，证明 basic；Cline 在同轮失败不撤销 Hermes 的事实。
首次 enhanced 运行复现了夹具读取问题：Orca 的 worker_done 先于原生最终
assistant 落盘，Hermes export 在结算后仍会追加。Implementation 在两次读取间
范围变化导致材料拒绝，Validator 的派生 JSONL 则缺最后一条 assistant 和标记。

对同一精确 Session 的只读复核得到：Implementation 早期材料未生成，稳定后可
生成；Validator 的旧材料 32600 字节、8 条 assistant、无最终标记，新材料
34113 字节、9 条 assistant、含标记。原生历史仍是 partial，没有放宽覆盖判定。

修复仅在 `tests/support/worker-harness-acceptance.ts`：OpenCode、Hermes、Cline
共用原有有界重读流程，每次先核验当前范围，再生成同一来源的材料；等待最终
assistant 时同时刷新材料。已有精确来源结算测试增加 Hermes 分支，先红后绿。
生产 export 校验、Session Binding 与 Recovery 规则保持原合同。

修正后的 [enhanced 矩阵][hermes-enhanced]通过四角色、Implementation exact resume
和 Validator 同 Session 上下文标记续接，真实测试 61 passed / 2 skipped。
四角色均 succeeded、工件正确，两个续接均 sameSession=true，Validator 的
contextPreserved=true。由此提升为 enhanced；partial 历史仍明确失败，Recovery
和 mixed Controller 没有本轮通过证据，不提升 complete。旧失败轮次单独保留。

## Cline：原生 profile 与 unknown 接管

默认运行的两项基础任务停在 Cline 登录页，未开始真实模型轮次；Orca 仅记录
`ready/input_accepted`。对两个精确 Dispatch 的公开停止结果均为 stop_unknown、
processAction=none，现场保留；输入接受、停止请求和原生登录超时均不作成功证据。

官方 [3.0.70 TUI 配置检查][cline-gate]只读显式 config/settings，不读取环境变量
API Key；[启动视图][cline-root]据此进入 onboarding。[3.0.71 changelog][cline-changelog]
记录了环境变量凭据的启动修复，但本轮未升级。

本项目已批准的 `~/.cline/data/settings/providers-minimax-mplan.json`（0600）仍存在。
独立测试明确在实际启动命令设置 `CLINE_PROVIDER_SETTINGS_PATH`，没有读取或传递
密钥值。原生 screen 已进入 MiniMax 模型界面，默认 providers.json 字节核验未变。
但 [profile 对照][cline-profile] 的 worker-start 返回 unknown，未取得 Dispatch。
原 Run `run_04187c36aedc` 的公开 worker-list 为空，原 Task `task_2f3eab160b74`
仍 ready；这些读取不能证明旧 mutation 未发生，不重发该操作，保留原 terminal
`term_4b741988-7322-4326-a86e-fdf3444a2e69`。

两个停止结果的 OperationId、request ID 与回读见[停止回执][stops]；没有再次停止
或释放这些 unknown 资源。

该轮夹具没有保留原 request ID，不能完成 request-show 对账；后续夹具的
worker_start_failed 证据会携带完整 unknown OperationRef/reason。Cline 继续
unavailable，不能用原生模型界面替代监督执行结果。重新验证先解决该 mutation
的对账或经用户明确处置旧现场；认证/profile 仍由原生用户环境提供。

## Kilo、Muse 与 Cursor

Kilo 继续保留已有 basic。新的 enhanced 矩阵使用可写 Finalizer，排除了旧只读
Finalizer 门槛。[本轮矩阵][kilo-enhanced]的 Validator succeeded、工件正确、精确
Session/complete export 成立，资格摘要追加这一事实；Planner、Implementation、
可写 Finalizer 和 Validator 续接在 input_accepted 后仍缺报告，不能提升 enhanced。
本轮 3 failed / 58 passed / 2 skipped，包括同轮旧 Hermes 夹具失败；不覆盖后来的
Hermes 成功轮次。未追加 Enter、重发未知输入或放宽 prepared 就绪标准。

Muse、cursor-agent 仍不在 PATH，原生登录和获批模型也未准备。只运行了命令存在性
检查，未安装、登录、猜测 MiniMax endpoint 或把离线 fixture 当真实通过。
后续需完成 CLI/登录/模型选择，再补真实验收 helper 的显式模型绑定与候选入口。

## 验证与续办边界

真实矩阵沿现有开关运行：`ORCA_COMPANION_REAL_ACCEPTANCE=1`、
`ORCA_COMPANION_REAL_ACCEPTANCE_LEVEL=basic|enhanced`、
`ORCA_COMPANION_REAL_ACCEPTANCE_HARNESSES=<ids>`，入口为
`pnpm exec vitest run tests/acceptance/worker-harness-matrix.test.ts --maxWorkers=1`。
Kimi 沿已核验的原协调身份与 Run 调用同一 support，用新 launch ID 派发；原被拒绝
任务不重放，信任确认和人工协助轮次分别记录。Cline 的独立原生 profile 只作本机
显式测试配置，不写入生产 adapter。

历史 verification 保留原 12 项范围，本轮 tasks 6.1–6.4 单独跟踪。失败、unknown、
skip 与未运行分别保留，不将纯矩阵当 mixed Controller，也不据缺失 usage 推算费用。

资格采集器另修正了阻塞续接的三值解释：`original_unavailable` 导致的 blocked
resume/continuation 不记录为 session_resume failed；只有真实运行后发生身份或
上下文丢失才记失败。两个参数化回归先失败、修复后通过；历史工件保留当时输出，
新的资格摘要仍保留早期已核验成功，不从单轮缺失推断能力退化。

最终检查：`pnpm typecheck`、`pnpm lint`、`pnpm build` 均 exit 0；
`pnpm exec vitest run --maxWorkers=4` 为 216 文件通过 / 9 跳过，2738 tests passed /
18 skipped；OpenSpec strict 与 `git diff --check` 通过。独立 Node assert 自检重新
从 Kimi/Hermes 的实际 JSON 推导 enhanced，并核对 bundled 资格、未授予
Recovery/mixed Controller 以及清理对象身份。检查摘要见[验证汇总][checks]。

验收结束后沿公开 CLI 逐个回读 exact Worker 与 terminal/fixture 归属，只关闭
已证明 succeeded 的本轮资源，24 项关闭回执全部成功。失败、unknown、未结输入、
原协调终端、worktree 和全部 Session/证据文件保留，见[回收回执][cleanup]。
本轮未提交、归档、安装升级依赖、启动开发服务器或修改 Orca。

[basic]: ../../artifacts/next-worker-harness-adapters/ip04-2026-10-14T13-27-48-674Z-5c46104b-aa66-4fe9-bd75-a283eb2aa062.json
[kimi-assisted]: ../../artifacts/next-worker-harness-adapters/ip04-2026-10-14T13-31-40-584Z-c06ebb50-69a3-4927-bf7b-6bf59287433d.json
[kimi-basic]: ../../artifacts/next-worker-harness-adapters/ip04-2026-10-14T13-36-08-831Z-c7fa68c7-42f4-419b-902c-854f69ea9afb.json
[cline-profile]: ../../artifacts/next-worker-harness-adapters/ip04-2026-10-14T13-44-51-081Z-411e7af6-4ff4-418f-8249-813a300a63aa.json
[hermes-enhanced]: ../../artifacts/next-worker-harness-adapters/ip04-2026-10-14T13-47-09-882Z-9b7cbd78-6396-4085-aa3a-8cd4f3ac4faa.json
[kilo-enhanced]: ../../artifacts/next-worker-harness-adapters/ip04-2026-10-14T13-37-47-768Z-ddf96f16-587f-48fb-bf2c-97247e6fbb96.json
[kimi-enhanced-first]: ../../artifacts/next-worker-harness-adapters/ip04-2026-10-14T13-52-25-437Z-c02567b7-70d9-4ea2-84e8-3f3378b24f26.json
[kimi-enhanced-observed]: ../../artifacts/next-worker-harness-adapters/ip04-2026-10-14T13-56-12-879Z-17f49d74-91c4-4f2c-b8fa-78eeddafd681.json
[kimi-enhanced]: ../../artifacts/next-worker-harness-adapters/ip04-2026-10-14T13-59-22-461Z-b759fd59-591a-4350-ac07-4e86a19c5749.json
[stops]: ../../artifacts/next-worker-harness-adapters/graded-stop-outcomes-20261014.json
[cleanup]: ../../artifacts/next-worker-harness-adapters/graded-cleanup-final-20261014.json
[checks]: ../../artifacts/next-worker-harness-adapters/graded-validation-20261014.json
[cline-gate]: https://github.com/cline/cline/blob/9c4de34543/apps/cli/src/tui/utils/provider-configured.ts
[cline-root]: https://github.com/cline/cline/blob/9c4de34543/apps/cli/src/tui/root.tsx#L110-L117
[cline-changelog]: https://github.com/cline/cline/blob/c96fb0992a/apps/cli/CHANGELOG.md
