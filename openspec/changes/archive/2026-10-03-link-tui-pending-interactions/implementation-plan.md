# Implementation Plan

## 1. 实施基线与权威来源

baseline mode: `predecessor-contract`。planning commit: `69f0aa1781265bb7623cb4bbb3e8ae5722e72bce`。直接前驱 `inspect-and-search-coordinator-history` 已在 `2026-10-03-inspect-and-search-coordinator-history` 归档，主规格已存在，工作区原先干净。冻结接缝：HistoryCall.operationId、TranscriptReadingPort、TranscriptReader 的来源锚点/8 MiB/64 项预算、IC-13 的稳定 submission 与 draft revision。核验实际代码、相关测试及前驱 artifacts 已完成；重大漂移返回规划。

## 2. 复用与接缝

| IP-ID | 现有文件与符号 | 复用方式 | 禁止复制的事实 |
|---|---|---|---|
| IP-01 | branch-coordination-store、coordination-store、projectControllerSnapshot、deriveExecutionFacts | 原 SQL keyset、CAS 与投影 | 不截断业务事实，不复制 Q/A 权威 |
| IP-02 | createUserQuestion、HistoryCall、TranscriptReader | 正向 ID 派生、原 body/layout 阅读 | 不从结果文案猜身份，不创建第二阅读器 |
| IP-03 | App showAnswer/openAnswer/submit、protection、state reducer | 原精确提交与草稿恢复 | 不复制 draft、不凭事件视作受理 |

## 3. 代码变更映射

| IP-ID | Task | Requirement/Scenario | 文件与符号 | 精确变化 | 不得改变 |
|---|---|---|---|---|---|
| IP-01 | 查询和展示 | 有界问题读取的全部场景 | src/application/ports/branch-coordination-store.ts、src/adapters/storage/coordination-store.ts、schema.ts；controller-service.ts、execution/execution-view.ts；bootstrap/foreground-planning-runtime.ts、interfaces/cli/status-command.ts | 摘要、完整计数、Scope 页、指定 ID 摘要与 UTF-8 body range；展示 snapshot；精确 owner 查询 | 完整 snapshot、Finalizer 准入、原 CAS |
| IP-02 | 原位卡片 | 历史提问与权威回答关联、历史问题卡片原位阅读的全部场景 | application/coordination/pending-interaction.ts、coordinator/history.ts；tui/render/transcript-reader.ts、components/transcript.tsx、interaction-card.tsx、workspace.tsx；Bootstrap | 提问 ID 事实源、interaction source、紧凑/展开 Q/A、开放卡回答 | F4、搜索、缓存预算、来源锚点 |
| IP-03 | 回答往返 | 跨 Session 回答与明确返回、项目待答有界联动的全部场景 | tui/app.tsx、state.ts、view-model.ts、components/project-panel.tsx、answer-panel.tsx | Scope 页查询、精确进入、单次返回上下文、迟到结果/后续编辑守护 | Ctrl+R、IC-13、无焦点抢占 |

## 4. 调用与副作用顺序

进入：保存完整原输入 → 精确读取指定 owner/ID/revision → generation 核验 → 记录返回上下文 → 选 Session 和原回答面板。提交：原 beginSubmission 持久化 → Controller 答复 → settleSubmission → 只有确认结清原 draft 且当前绑定仍一致才返回。Esc：flush 成功才恢复原入口。查询/事件/resize 不产生 mutation。失败保留原输入；unknown 沿原 submission 核验，不自动新建重试。

## 5. Schema、状态与持久化落实

D-01/02：coordination.sqlite schema 15 仅新增 Scope 索引；Q/A part 范围读取仍由 Branch Store 拥有。完整 open count 独立于页面。CLI 的完整开放列表用专用 identity 查询保留原公开输出，仅返回身份列；TUI 使用有界页。D-03：返回上下文仅进程内，无新表；UI/checkpoint schema 不变，草稿和提交沿 IC-13。

## 6. 验收证据矩阵

| Requirement/Scenario | IP-ID | 测试文件 | Fixture/前置条件 | 关键断言 | 可运行命令 |
|---|---|---|---|---|---|
| 页面与精确详情、Scope 分页与完整计数 | IP-01 | tests/coordination-store.test.ts、tests/application/execution-view.test.ts、tests/bootstrap/foreground-planning-runtime.test.ts | 多 owner、>20、许多已答、其他 Scope | bounded 页、完整 count、精确后页、隔离 | pnpm exec vitest run tests/coordination-store.test.ts tests/application/execution-view.test.ts tests/bootstrap/foreground-planning-runtime.test.ts |
| 重放与恢复、回答前后原位阅读 | IP-02 | tests/tui/transcript-reader.test.ts、activity-navigation.test.tsx | 同 operation、重启、中文长正文 | 可信 ID、状态、范围、缓存、锚点 | pnpm exec vitest run tests/tui/transcript-reader.test.ts tests/tui/activity-navigation.test.tsx |
| 保存退出和成功返回、后来编辑与迟到结果、核验或保存失败、后页跨会话选题、后台状态刷新 | IP-03 | tests/tui/input-paths.test.tsx、session-lifecycle.test.tsx、no-side-effect.test.tsx、harness.ts | 稳定输入存储、延迟/unknown/save fail、中文粘贴 | 精确目标、完整返回、晚结果不跳、无自动动作 | pnpm exec vitest run tests/tui/input-paths.test.tsx tests/tui/session-lifecycle.test.tsx tests/tui/no-side-effect.test.tsx |
| 六票原型与真实终端 | IP-02/03 | artifacts/pending-interactions/、scripts/tui-preview.mjs | 120×40、80×24、50×40；彩色/NO_COLOR、Nerd/ASCII、resize | 原位层级、固定框、焦点返回、终端恢复 | node artifacts/pending-interactions/capture.mjs |
| 全体 | IP-01/02/03 | 现有 suite 与 change | 当前 Ubuntu | 类型、lint、构建、回归、规格 | pnpm typecheck；pnpm lint；pnpm build；pnpm exec vitest run --maxWorkers=2；openspec validate link-tui-pending-interactions --strict；git diff --check |

## 7. 文件清单与升级条件

新增本 change 五份规划工件及 delta specs、`artifacts/pending-interactions/` 验收证据和必要行为测试；修改上表文件及其测试 fixtures、tests/support/transcript-reading.ts、docs/interface-contracts.md、docs/architecture.md、docs/dev/tui-implementation-handoff.md、artifacts/history-inspection/README.md 当前入口。若紧邻公共来源判别需要维护其它调用方，仅做 exhaustive narrowing 和相关断言。保护原型资产、references/orca、package/lockfile、ui/checkpoint schema。不删除用户改动。

合同 owner、权限、依赖、原型设计或实施范围需要改变时升级用户决策；普通命名、内部抽取和现有调用方类型适配由实施自行完成。

## 8. 验收 Agent 授权与限定审计

授权上述生产与行为测试、PTY 证据、文档修正；关注完整计数、可信 ID、SQL/body 读取预算、submission 与 draft revision、异步 generation 和无 render 副作用。主代理负责原型实现验收，独立只读审计可委派。验证文档在实现完成并修复后写；本次不提交、不归档。

## 9. 实施与验收记录（2026-10-03）

- IP-01：摘要/Scope 与 Session keyset/精确详情/按版本UTF-8正文范围接通；schema15仅增加Scope索引。Bootstrap使用展示 snapshot，Finalizer保留完整计数。CLI完整开放列表改读身份列，公开输出范围不截断，也不读问答正文。
- IP-02：统一可信 operationId 正向派生；历史原提问处 Q/state/A 及展开沿同一阅读器。补齐索引未就绪、缺失与读取失败的区别；同一步多个提问的参数/卡片/结果按原来源序列阅读。双缓存与来源锚点保持原边界。
- IP-03：Scope待答PgUp/PgDn、后页精确跨Session进入，单次返回上下文及原提交管线接通。Esc成功保存或确定受理且无后来编辑才返回；保存失败、unknown、拒绝、手工切Session及迟到结果均保留或结清原绑定，不抢新输入。完整粘贴草稿全文/cursor/块身份和范围、原历史来源返回均经持久记录回读验证。
- 文档：更新IC-03/11/12、architecture、项目AGENTS及当前交接，第四批入口改为已归档路径。测试中新增来源variant的既有调用方仅做exhaustive narrowing；Controller公开字段清单补入新增计数。

| 命令/证据 | 实际结果 |
| --- | --- |
| 各IP指定测试及 `tests/status-command.test.ts` | 相关定向回归通过，全部也在完整suite内运行 |
| `pnpm typecheck` / `pnpm lint` / `pnpm build` | 最终通过；无依赖、package/lockfile或上游修改 |
| `pnpm exec vitest run --maxWorkers=2` | 首轮150文件/1513项通过，唯一失败为Controller公开字段清单；6文件/12项条件跳过 |
| `pnpm exec vitest run tests/application/controller-service.test.ts --maxWorkers=2` | 补入 `openInteractionCount` 后15项全部通过；生产代码无后续修改，合并覆盖为151文件/1514项通过、6文件/12项条件跳过，不重复计算复验 |
| `node artifacts/pending-interactions/capture.mjs` | 12组、147对PNG/文本，三档两色两图标、明确跨Session/后页/保存/受理/失效选择/光标/连续resize；主代理按六票源码与画面完成对照 |
| `tests/tui/pty.test.ts`（完整suite内） | 13项真实PTY通过，含三档 `stty -g` 退出恢复及无TTY拒绝/只读CLI |
| `node artifacts/pending-interactions/benchmark.mjs` | 五场景各100次；输入p95最大74.73ms、缓存导航最大11.02ms；最大正文单读16388字节、双缓存低于8MiB/64项；冷打开另记，不算输入门槛 |
| `openspec validate link-tui-pending-interactions --strict` / `git diff --check` | 通过 |

详细样本、画面对照、操作序列、性能和平台边界见 [独立证据](../../../artifacts/pending-interactions/README.md)。
仅验证当前Ubuntu；未启用真实Orca/provider条件测试，未新增真实OS IME人工验收，Windows未验证。
1/5MiB为持久回答压力fixture，不表示当前输入允许该大小。六票后继配置、custom保存和完整图功能不在本轮范围。
