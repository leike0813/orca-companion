# 第八批：图历史与执行依据

本目录保存 `complete-tui-graph-basis` 的新证据。原型来源见 [六票定稿表](../../openspec/changes/archive/2026-10-03-align-tui-with-approved-prototypes/design.md#d-01六张原型票直接作为设计参照)。此前批次的画面、报告和运行记录保持原验收范围。

实现提供当前 Scope 全代际图目录、精确历史拓扑、原计划和 Accepted Graph Patch、批准 Manifest、原 Task 绑定的 OpenSpec 文件，以及明确标为当前来源的 Route Map 正文。schema 17 与初始图同事务保存归一化计划，旧记录缺失时不推断回填。目录每页最多 20 项、正文每段最多 64 KiB；正文与布局缓存分别限 8 MiB/64 项。

当前状态：读取与返回、六票画面、性能和真实隔离闭环的行为与证据已完成，任务12/12；最终检查已通过，独立正式核验PASS。MiniMax 的 n 现场完成 retire、集成与 Finalizer deliverable；o 完成同 Attempt Recovery、revise、基线补救、两包集成与 deliverable。原驱动各6通过/2失败/2阶段跳过、exit1；两项失败为过时的基线显示位置和并排文本污染长ID，已在原暂停现场通过生产详情/Inspector复验结清，未改写原日志。两版图的38/82项完整正文可读，Scope revision不变；阅读重启前后Task/Dispatch/Attempt、Segment、结算、预算与Verdict不变。人工督办/回答单列于[真实记录](real-acceptance/README.md)。独立正式验收PASS。

## IP05 项目入口画面补采

项目入口最终[采集报告](screenshots/basis-path-2026-10-04T13-15-53-509Z/capture-report.md)、[样本清单](screenshots/basis-path-2026-10-04T13-15-53-509Z/samples.json)和[操作记录](screenshots/basis-path-2026-10-04T13-15-53-509Z/operations.json)覆盖12组合、96条样本与96对独立PNG/TXT，exit0。原13:00采集有96条记录，但resize命名重复只保留72对文件；旧目录保持原样，不计96对。修复脚本按resize前尺寸区分文件名并另存最终采集。路径为项目工作详情→GraphBasis→Route Map正文→三档resize→四层Esc回项目总览→Ctrl+B回工作区。正文与状态来自隔离fixture，不证明真实Worker。

已逐票查看不同尺寸的生产 TUI PNG。正文按终端宽度换行，resize 后重排并保留来源；此前报告所称正文横向裁切不准确，现已更正。窄屏来源标题和摘要会按既有规则省略。项目待答/最近事件的内容态另存于 `project-content-2026-10-04T14-06-32.782Z`，12组合、36对独立PNG/TXT，采集exit0。状态栏新采114对（116样本）、四类弹窗与审阅108对。`project-panel-prototype` 图片仅是原型参照；来源与实际视觉差异见对照报告。

## 行为检查

2026-10-04 Ubuntu / Node.js 24.12.0 / pnpm 11.10.0：

| 检查 | 结果 |
| --- | --- |
| `pnpm typecheck`、`pnpm lint`、`pnpm build` | 已通过；证据脚本变动后再检查 |
| 历史全量测试记录 | 1745 通过、12 条件跳过、1 失败；唯一失败为多代际目录测试夹具，已修复并复验 |
| store/controller/execution-view/graph-history/host-wiring | 5 文件、121 项通过，包含上述失败文件完整复验 |
| 普通 PTY、规格与读取无副作用 | 3 文件、47 项通过 |
| 最新 graph-inspector/specification-admission/graph-basis | 3 文件、44 项通过 |
| 最新应用与无副作用 | 2 文件、16 项通过 |
| 最终依据/Inspector/恢复/交接返回复验 | 串行与并行均为 4 文件、35 项通过；三页回翻已修复，分页测试等待目标页呈现后继续输入 |
| 最终全量 `pnpm test --maxWorkers 4` | 161 文件通过、6 文件条件跳过；1745 项通过、12 项条件跳过、1 项分页呈现等待失败。上述完整文件复验结清该项，原退出码 1 保留 |
| 最终 store/graph-history/controller/execution-view/specification/tracker/graph-basis/host-wiring | 8 文件、195 项通过 |
| 最终普通真实 PTY | 13 项通过；2 项真实 Orca 条件检查未启用，单列为跳过 |
| 图 head 收窄及目录索引修复复验 | runtime 2 文件、16 项通过；store/graph-basis 2 文件、69 项通过；typecheck/build 通过 |
| 2026-10-04 19:26 全量检查 | 160 文件、1743 项通过，6 文件、12 项条件跳过；2 文件、3 项失败。运行时修改了共享模型参数，导致 worker 已载入旧 `--model` 实现而测试采用新断言；保留原 exit 1，不计为固定实现全量 PASS |
| 共享模型参数修复后复验 | `codex-launch.test.ts`、`codex-read-only-probe.test.ts` 共 32 项通过，build 通过；模型参数由共享生成器编码为 `-c model=...` |
| 本批读取与返回复验 | 2026-10-04 19:33，9 文件、177 项通过；涵盖 store、graph-basis、graph-history、OpenSpec、tracker、Inspector、无副作用、恢复与交接 |
| resize 来源位置修复 | 只读审计发现窄屏滚动后扩大窗口会保留越界行号。修复按原文位置映射到新布局；Inspector/无副作用 2 文件、26 项通过，typecheck 通过 |
| 暂停交接前最终静态检查 | typecheck、build、受影响文件 eslint、OpenSpec strict 与 diff 检查通过；全库 lint 在 resize 修复前通过，修复后覆盖变更文件 |
| 公开 Worker 字段修复 | adapter/launch/probe 3 文件、60 项通过；build、typecheck、PTY helper 与 adapter ESLint 通过；新现场 workerStart accepted 且精确 Session Binding 落盘 |
| 新隔离现场的依据阅读 | `basis-ip05-exec-20261004i-start.json`：生产 GraphBasisPort 完整读取 11 项正文，包含原计划、批准 Manifest、保留 Task 和原生规格；Scope revision 不变，仍非完整执行结论 |
| 固定 Worker 字段修复后的全量 | 162 文件/1748 项通过，6 文件/12 项条件跳过，exit 0；日志 `checks-20261004-resume/test-after-adapter.log` |
| 摘要修复后的固定全量 | 162文件1750项通过，6文件12项条件跳过，exit0；日志 `checks-20261004-resume/test-after-summary.log` |
| 真实 Dispatch 摘要修复 | execution-view 28 项通过；应用/宿主3文件47项通过。原i记录重投影为2/2，业务结算不变 |
| PTY 详情读取修复 | 原j读取7页、原i重启后读取12页，完整 Finalizer/Recovery 字段可见；原失败保留 |
| 摘要修复后的 TUI 回归 | 5文件50项通过，含普通真实 PTY；不抵销真实执行与 Recovery 未完成项 |
| 变化说明合同 | 现有workflow/application/execution用例覆盖完整透传、空白与4000 code point边界；不改变九项路由规则 |
| Recovery 补记修复 | 16文件116项通过/2条件跳过，typecheck/build/受影响eslint通过；原Segment不补签替代Dispatch |
| MiniMax 模型切换后的固定全量 | 162文件1754项通过、6文件12项条件跳过，exit0；`checks-20261004-resume/test-final-minimax.log` |
| Finalizer 载体修复 | 3文件38项通过，typecheck/build/eslint通过；原l公开消息回读只排除拒绝载体，保留有效Task/Dispatch |
| Utility 物化修复 | 3文件58项通过，build通过；原最终全量和后续复验的失败退出码保留 |
| 固定实现全量 | `test-final-utility-bounded.log`：162文件1756项通过、6文件12项条件跳过，exit0；命令 `pnpm test --maxWorkers=4 --testTimeout=15000` |
| 最终脚手架后的全量 | 同一命令，162文件1756项通过、6文件12项条件跳过，exit0；`test-final-retained-readback.log`，440.01秒 |
| 最终静态检查 | `typecheck-final-readback.log`、`lint-final-readback.log`、`lint-retained-evidence.log`、`build-final-utility.log`、`strict-final-readback.log`均exit0，`git diff --check`通过 |
| 普通 PTY 与交接 | 退出探针等待真实退出码后，2文件19项通过；原默认5秒交接超时与PTY瞬时null均单列保留 |
| MiniMax真实闭环 | n retire与o Recovery/revise均取得deliverable；原驱动各6通过/2失败/2阶段跳过，原现场生产阅读复验结清两项显示断言，详见独立证据 |
| `openspec validate complete-tui-graph-basis --strict`、`git diff --check` | 已通过 |

检查覆盖原计划重启读回、旧库缺失、全代际分页、Scope 指针与 head 分离、追加链成员、UTF-8 连续范围、tracking/contract 分离、来源身份、批准授权分页、迟到结果、首次正文版本固定、来源变化拒绝、读取异常保留入口、resize 与逐层返回。历史图只展示所选拓扑，运行态缺失单独标明；退役提示与依据入口只采用所选 Accepted Graph Patch 的明确记录。

## 新证据入口

- 原矩阵画面：`node artifacts/graph-basis/capture.mjs`，三档尺寸、两种颜色与两套图标；运行时已有 dist。生产 TUI 和 GraphBasisService/SQLite 读取使用隔离夹具，不能证明真实 Worker 执行。本次项目入口专项产物见上节；未 build。
- 性能：`node artifacts/graph-basis/benchmark.mjs --run`；输入帧响应、缓存导航、冷读、完整扫描与 RSS 分别记录。
- [性能最终记录](performance.md)：2026-10-04 正式运行 exit 0，1000/10000/100000 个版本及 1/5 MiB 正文均完成三档尺寸采样，每档每类 100 次。输入 p95 最大 30.134ms，缓存版本导航最大 24.914ms，缓存正文导航最大 19.422ms，均满足 100ms 门槛；10 万版本完整扫描 2222.673ms。RSS 是进程级观测，限制见报告。先前未完成记录与日志保留。
- 真实运行：[隔离验收](real-acceptance/README.md)。后续新现场使用 `minimax-cn/MiniMax-M3.1-Flash-Preview` 与已核验连接；已启动现场与历史保持原模型身份。全跳过运行不计为通过。

本批未提交、未归档。真实 IME、Windows、无人值守与原生集成不属于本次已验证能力。

## 退休历史版本采集（2026-10-04）

本次接手只完成一档退休记录探针，不能代表 IP05 六票全矩阵：120×40、color、Nerd，共 3 组画面（workspace、Inspector、历史版本）及同名文本。运行产物位于 [`screenshots/retired-history-2026-10-04T11-23-33-460Z/`](screenshots/retired-history-2026-10-04T11-23-33-460Z/)；[操作记录](screenshots/retired-history-2026-10-04T11-23-33-460Z/operations.json)明确记载 G1·v2 的 accepted revision retire `wp-d`。这组截图用生产 TUI、GraphBasisService 和隔离 SQLite fixture；preview 环境预置的 `wp-d` 选择是合成输入，不能证明真实 Inspector 中存在该当前选择，也不代表真实 Worker 执行。

动态导入 smoke 裸跑时因缺少 `ORCA_COMPANION_PREVIEW_CONFIG_HOME` 退出 1；设置唯一临时 config home 后，`createGraphBasisPreviewPorts()` 创建与关闭均成功，exit 0。fixture 在关闭 store 前已缓存 harness 的图、revision 和授权读取结果；本次看到的 range query 使用 `maxBytes: 4`，没有复现 invalid query 或 closed SQLite。

采集脚本的两项失败根因均已由终端帧确认并限定在 harness：分页条件 `includes('G1·v2')` 把 `G1·v21` 当成目标版本；修正为精确图身份后，第一版画面断言又错误假设当前选择为 `wp-d`，而真实当前选择是 `wp-a`。最终探针通过隔离预览输入保留 `wp-d` 身份，进入 G1·v2 并显示“已由已接受修订移出”及“历史依据仍可读”。失败采集的日期目录和 PTY 文本/PNG 均保留，详见 `screenshots/retired-history-2026-10-04T11-16-11-210Z/`、`...11-18-13-222Z/`、`...11-19-24-515Z/`。没有发现或修改生产 UI 故障。

此处只留下退休历史版本的单配置对照，不代表真实 retire 闭环通过。原完整矩阵为216条样本、192对独立PNG/TXT（resize同名覆盖24条记录）；项目入口补采另有96对，逐票复核范围与结论见 [prototype-review](prototype-review.md)。性能结果按上文已完成记录。
