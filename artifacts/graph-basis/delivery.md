# 第八批实现交付

`complete-tui-graph-basis` 已完成12/12实施任务；基线为 `41b2f1e636c110441a0a344fc20749911b085201`，所有实现保留在工作区，未提交、未归档。独立正式验收PASS，结论见 [verification.md](../../openspec/changes/complete-tui-graph-basis/verification.md)。

## 实现范围

| 范围 | 文件与结果 |
| --- | --- |
| 图权威历史 | `adapters/storage/schema.ts`、`coordination-store.ts`、`application/ports/branch-coordination-store.ts`、`planning/graph-history.ts`：schema17保存归一化原计划，初始图同事务落盘；metadata目录、head、追加链成员和UTF-8正文范围有界读取，旧来源缺失明确不可用 |
| 原生执行依据 | `adapters/specification/openspec/provider.ts`、`application/ports/specification-provider.ts`、`adapters/tracker/gh-tracker.ts`、`planning/route-map-service.ts`：原Task精确规格绑定、contract/tracking分离、路径边界、来源版本与有界文件正文 |
| 应用读取与装配 | 新 `application/tui/graph-basis.ts`、`graph-basis-service.ts`，controller、execution-view及bootstrap：独立GraphBasisPort；当前轻量snapshot与共享Validator摘要；原批准授权和计划/patch/source追溯 |
| 生产TUI | 新 `components/graph-basis-view.tsx`，`app.tsx`、`state.ts`、Inspector、ProjectPanel、Workspace与ports：跨代际目录、历史拓扑、退役记录、来源正文、双缓存8MiB/64项、迟到隔离、resize与逐层返回 |
| 获批解阻塞 | 共享Codex模型参数、公开Worker字段、变化说明完整透传、Recovery Segment派发来源核验、Finalizer拒绝诊断过滤、Utility绑定复用；各自范围与现有行为测试见implementation-plan第8/9节 |
| 合同与记录 | AGENTS、architecture、interface-contracts、orca-compatibility、TUI handoff/workbench及OpenSpec工件更新；原型素材、前驱归档与旧失败证据保留 |

需求/场景包括 retained plan、legacy missing、all-generation history、bounded native specification、mutable source change、frozen generation return、retired selection、cross-screen return、真实执行/patch/recovery/cutover。逐项映射在 implementation-plan 与独立 verification 中。

## 固定实现检查

| 命令 | 结果与日志（checks-20261004-resume/） |
| --- | --- |
| `pnpm typecheck` | exit0，typecheck-final-readback.log |
| `pnpm lint` | exit0，lint-final-readback.log；独立证据脚本ESLint也exit0，lint-retained-evidence.log |
| `pnpm test --maxWorkers=4 --testTimeout=15000` | exit0，162文件1756项通过，6文件12项条件跳过，440.01秒，test-final-retained-readback.log |
| `pnpm build` | exit0，build-final-utility.log（此后仅脚手架/文档变动） |
| `openspec validate complete-tui-graph-basis --strict` | exit0，strict-delivery.log |
| `git diff --check` | 通过 |

全量未启用真实外部集成开关：M0 isolated probe、Coordinator/Planning模型smoke、独立真实Patch/Cutover/Validator及PTY隔离入口按各自门禁跳过，不能算通过。必要的真实闭环另在 n/o/b 显式现场运行。默认5秒交接超时、PTY瞬时退出码null和此前失败日志均保留；退出探针等待实际退出码，交接和普通PTY两文件19项复验通过。15秒是行为测试时限，产品100ms性能门槛不变。

## 真实结果与证据边界

MiniMax n现场完成真实retire和只读Finalizer deliverable，o完成同Task/Attempt Recovery、revise、独立基线补救、两包集成与deliverable。原PTY各6通过/2失败/2阶段跳过、exit1；旧reconcile显示位置与并排文本污染长ID的两项失败，在同一暂停现场经生产详情和当前Inspector复验结清，原退出码未改写。两版图完整读回38/82项正文，Scope revision不变；阅读重启后Task/Dispatch/Attempt、Segment、结算、预算、Verdict不变。o仅1条Recovery、预算1/1，替代结果已接受。

流程有人工督办和绑定问题回答，详见 [真实验收](real-acceptance/README.md)。UI探针启动取得Runtime Lease，不能宣称整个进程零写入。旧unknown现场、旧Session误绑现场与旧失败记录没有回填。零模型b现场的Cutover为真实两Run/两代图、旧图冻结且原计划仍可读，1通过/9阶段跳过，范围单列。

六票生产画面和100次输入/缓存导航性能分别见 [prototype-review](prototype-review.md)、[performance](performance.md)。原矩阵216样本实际192独立PNG/TXT，专项另有96/114/108/36对。固定前驱的标题/计数差异没有由本批重新设计。输入p95最大30.134ms，缓存版本/正文导航最大24.914/19.422ms，均小于100ms；冷读、扫描、RSS另列。

平台仅Ubuntu。没有新增真实OS IME人工验证，Windows、无人值守与原生迁移未验证。请求数与费用不推断，未精确按launch绑定的用量保持unbound。
