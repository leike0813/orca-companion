# Implementation Plan

## 1. 实施基线与权威来源

Baseline: **predecessor-contract**。Planning commit `20f02996471adb3efca524faced20ef9ffa0136d`；直接前驱 `archive/2026-10-03-render-bounded-transcript` 已归档、三份主规格已同步。实际已核对HistoryReadPort/TranscriptReadingPort、reader、appendModelStep/appendToolResult、原输入管线和宿主。冻结正文/entry/step/Wake/可信operation、fencing、3B来源锚点和双限缓存、IC-13草稿/CAS/submission。引用D-01–09和本change三份delta；交接文档的active路径/dirty状态漂移仅更新状态，不重新实施3B。

## 2. 复用与接缝

| IP-ID | 现有或前驱文件与符号 | 复用方式 | 禁止复制的事实 |
|---|---|---|---|
| IP-01 | history.ts、CheckpointStore、ControllerService | inspection DTO、参数范围、派生索引 | 参数/正文/完整历史 |
| IP-02 | CommittedToolCall、nodes、tool-node、runtime-guard | 可信分类、unknown观测 | 执行状态机/操作身份 |
| IP-03 | TranscriptReader、App/Workspace/Transcript/keymap | 活动、整体详细、局部展开 | 全局行号/第二阅读器 |
| IP-04 | HistoryReadPort、TranscriptReadingPort | Application独立搜索 | 展示AST/全量hits/全文索引 |
| IP-05 | Composer编辑/IC-13 | 普通历史预览/采用与返回 | 发送日志/回答管线 |
| IP-06 | PTY/preview/3B基准与交接 | 独立本批证据 | 原型fixture/旧证据 |

## 3. 代码变更映射

| IP-ID | Task | Requirement/Scenario | 文件与符号 | 精确变化 | 不得改变 |
|---|---|---|---|---|---|
| IP-01 | 1.1 | Bounded trusted call inspection；未加载与缺失 | 新增src/application/coordinator/history-inspection.ts；修改history.ts/controller-service.ts、adapters/storage/checkpoint-store.ts；新增storage/history-inspection-index.ts及必要metadata span模块 | DTO/schema；调用清单/参数source/users；≤64KiB索引工作；事务维护定位和group；Bootstrap专用prepare方法；recordToolObservation | 权威原文、checkpoint/UI格式、Scope校验 |
| IP-02 | 1.2 | unknown与未确认、索引补齐与重放 | 修改src/domain/coordinator/session-state.ts、application/coordinator/runtime-guard.ts、workflow/coordinator/nodes.ts、tool-node.ts；必要扩展context.ts | activityKind可信注册分类；可选observations端口，unknown绑定原call并fence后保存 | accepted步骤、未配对恢复、预算/工具副作用 |
| IP-03 | 2.1 | Semantic activities全部；搜索命中定位 | 修改src/interfaces/tui/render/transcript-reader.ts、components/transcript.tsx、app.tsx、state.ts、input/keymap.ts、screens/workspace.tsx；必要components/context-search.tsx | group/来源读取、detailMode/手动展开/F4；原文anchor支持arguments；有限frame；高亮原文hit | 六票原型、双缓存、IC-13 |
| IP-04 | 1.3,2.2 | Independent bounded transcript search全部 | 新增src/application/coordinator/history-search.ts、tests/application/history-search.test.ts；修改Controller/Bootstrap/preview/testsupport相应窄接线 | snapshot固定上界；≤50hits/64KiB扫描批；Unicode简单折叠、overlap、offset、取消/continuation；F3独立输入与返回 | 不依赖Ink/布局、不缓存全hits、不搜临时preview |
| IP-05 | 2.3 | Authoritative ordinary input recall全部 | 新增src/interfaces/tui/input/input-history.ts与行为测试；修改App/state/workspace；复用composer-editor/input-protection | user-only keyset、全原文回填、边界召回、Ctrl+R先采用、原UiDraft恢复/故障保护 | 不直接发/保存预览、不混回答、不复制提交 |
| IP-06 | 3.1–3.3 | 全部及长历史性能/原型 | 修改src/bootstrap/foreground-planning-runtime.ts、必要coordinator-runtime.ts；scripts/tui-preview.mjs、tests/support/transcript-reading.ts、tests/tui/harness.ts；更新docs/architecture.md、interface-contracts.md、dev/tui-implementation-handoff.md、tui-workbench.md、必要AGENTS.md/README.md；新增artifacts/history-inspection | 宿主初始化补齐索引、Scope绑定查询、生产queryobserver/取消；PTY/性能工件、状态漂移修正 | 不启动dev server/真实主项目Orca，不覆盖旧原型 |

IP-03 的组件修改还包括 `components/composer.tsx` 的查询光标归属与 `components/command-palette.tsx` 的现行帮助；相应领域字段测试复用 `tests/domain/coordinator-session-state.test.ts`。这些是既有接缝的配套更新，不增加功能范围。

## 4. 调用与副作用顺序

初始化：打开原store→Bootstrap有限补齐派生索引→水位回读/来源失效通知；读端只读水位和索引。新响应可信分类→既有append事务原entry/step+call index；结果append→配对和结构化摘要。unknown：原call→fence→观测写入→原blocked；无配对结果产生。查询：Scope/Session/schema→有限metadata/body→原文offset→局部frame。搜索：固定上界→有限scan→让出/取消→hit→附近布局；失败保留cursor。采用：完整原文→IC-13既有编辑保存；提交仍先完整快照后原用例。

## 5. Schema、状态与持久化落实

history-inspection.ts为Application DTO/schema唯一事实源。args source为entry/step/call/revision=1，不与content offset混用。派生call/group索引只存引用/范围，索引重建保持原文；观测由Session store拥有，只存真实unknown，不复制工具结果或第二业务状态机。CallPosition与序号keyset支持固定upperSequence；group version绑定固定水位。所有每次查询/写入参数运行时校验。核心持久schema2/UI2/Coordination14保持；没有旧格式迁移或新依赖。

## 6. 验收证据矩阵

| Requirement/Scenario | IP-ID | 测试文件 | Fixture/前置条件 | 关键断言 | 可运行命令 |
|---|---|---|---|---|---|
| 巨大参数/unknown/补齐/重放 | 01,02 | tests/adapters/history-inspection.test.ts、workflow相关已有测试 | 原metadata、真实SQLite/stream fake | 范围/身份、无全文解析、无伪结果、幂等 | pnpm exec vitest run tests/adapters tests/workflow --maxWorkers=4 |
| 跨页活动/详情/未加载 | 01,03 | tests/tui/transcript-reader.test.ts及活动测试 | >100calls、query/action/body、巨型参数 | 同group、原顺序、异常可见、有限frame | pnpm exec vitest run tests/tui --maxWorkers=4 |
| 跨块Unicode/固定上界/取消/失败 | 04 | tests/application/history-search.test.ts | 原端口、文件SQLite/late reads | 原文offset、bounded progress、无假无匹配 | pnpm exec vitest run tests/application/history-search.test.ts |
| 普通历史/采用/召回/失败 | 05 | tests/tui/input-history.test.ts及input-paths | user/system/otherSession、原UiDraft | 不自动发送/写预览、返回全文/cursor/块 | pnpm exec vitest run tests/tui --maxWorkers=4 |
| 宿主/副作用隔离 | 01,02,06 | tests/bootstrap/foreground-planning-runtime.test.ts、tests/tui/host-wiring.test.ts、no-side-effect.test.tsx | 真Git/SQLite | 精确ScopeSession、仅Bootstrap建索引、重绘只读 | pnpm exec vitest run tests/bootstrap tests/tui/host-wiring.test.ts tests/tui/no-side-effect.test.tsx --maxWorkers=4 |
| 长历史搜索与输入p95 | 06 | artifacts/history-inspection/benchmark.mjs | 真实store/生产App、≥100样本 | 双缓存/搜索workspace、input/nav≤100ms，实际读量 | node artifacts/history-inspection/benchmark.mjs |
| 六票/三档/返回/退出 | 06 | artifacts/history-inspection/capture.mjs、tests/tui/pty.test.ts | 生产preview/真实PTY，无外部provider | 画面对照、draft/cursor返回、终端恢复 | node artifacts/history-inspection/capture.mjs；pnpm exec vitest run tests/tui/pty.test.ts |
| 全项目 | 全部 | 既有suite | Node24/pnpm11 | 类型/lint/test/build/strict/diff | pnpm typecheck；pnpm lint；pnpm test --maxWorkers=4；pnpm build；openspec validate inspect-and-search-coordinator-history --strict；git diff --check |

## 7. 文件清单与升级条件

仅§3新增/修改路径和相应已有测试；必要新增行为测试置tests/adapters/history-inspection.test.ts、tests/tui/activity-navigation.test.tsx、tests/tui/input-history.test.ts。无删除。保护用户已有artifacts交接报告迁移、references/orca、六票源码和旧报告。用apply_patch修改既有文件。不提交/切分支、不安装依赖。公共Scope/权限、权威格式、原型或范围需改变时报告并回设计，不能缩范围掩盖缺陷。

## 8. 验收 Agent 授权与限定审计

在上述范围直接修复复验。必审：参数底层有界读取、group跨页/固定版本、索引补齐无正文镜像、unknown/accepted语义、搜索取消/跨块/位置/工作区、Ctrl+R与原UiDraft/CAS/提交、生产宿主真实接线、六票画面对照。主代理拥有TUI和合同；存储、搜索和workflow可独立委派，模型统一minimax-cn/MiniMax-M3.1-Flash-Preview。verification仅在任务完成并固定检查点或用户另行授权后创建。

## 9. 实施与最终核验记录（2026-10-03）

实施与证据见[history-inspection README](../../../artifacts/history-inspection/README.md)，正式[verification](verification.md)结论为PASS。用户已授权直接修复并重新核验未提交工作区；最终HEAD仍为基线20f0299，不能把该提交视为第四批实现。任务9/9，全部Requirement/Scenario/IP-ID及§8审计闭合。

本轮修复：无调用的普通Agent历史反复丢弃元数据页；召回聊天预览进入回答面板后可能误提交；同一unknown观测诊断理由变化导致写入失败；单次调用状态未按序号上界过滤观测。搜索以固定上界的调用存在性标量延续私有cursor、逐块让出，240条混合消息回归证明全部命中和线性读量。回答前取消普通召回并清预览，原IC-13草稿/提交保持。unknown保留首次观测、原身份重验、观测与摘要同序号上界；本批观测表增加序号，原权威entry/step/Wake及checkpoint/UI版本不变。

最终typecheck/lint/build通过；存储、checkpoint、workflow、搜索与活动导航11文件/173项复验通过，侧审输入隔离8文件/78项、workflow/domain20文件/239项通过。四worker全套一次1498项通过、1项缓存预算检查超时，独立复跑所在文件9项通过，未调高超时。最终两worker全套：151文件/1499项通过；6文件/12项条件跳过。OpenSpec strict与diff检查：通过，含本轮最终报告与文档更新。各次范围重叠，不累计重复项，12项条件跳过不计通过。

生产文件SQLite/App/reader/search的五场景各100次输入和100次缓存导航p95均≤100ms。独立完整扫描分别约0.37/2.96/29.80/0.15/1.00秒，命中1000/10000/100000/3/3，单批≤100项元数据、64KiB正文与响应、50命中，cursor≤4096字节。后台采样与独立完整扫描分开保留，1万/10万记录采样窗口未完成不再冒充完整成本。原始数据保留max、RSS和实际读量。

沿用此前直接读取的六票定稿与原画面。最终构建补采12组合检索画面并保留基线，共192对PNG/文本、24条操作记录；复看80列彩色与50列无色参数命中画面，详情/查询/composer层级与返回约定保持。Ubuntu证据不扩展为Windows、OS输入法或真实Orca/provider重验。没有提交、规格同步或归档，用户已有工件迁移保留。
