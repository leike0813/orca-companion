# Verification

## 验收对象

- Change：`inspect-and-search-coordinator-history`，#37/#46 第四批。
- 输入实现 HEAD：`20f02996471adb3efca524faced20ef9ffa0136d` 上的未提交工作区实现。
- 最终验收 HEAD：同上；该 SHA 是基线，不包含第四批实现及本轮修复。
- 验收 Agent：主代理 Codex；workflow、输入隔离和恢复审查委派使用 `minimax-cn/MiniMax-M3.1-Flash-Preview`。
- 报告日期：2026-10-03。

用户已授权在未提交工作区修复并重新核验，也已授权以该工作区撰写 verification。此报告绑定本轮最终源码、构建和证据，不把基线 SHA 当作可独立复现实现的提交。用户已有交接报告归档移动保留；没有 Git 提交、规格同步或 change 归档。

依据：[proposal](proposal.md)、三份 delta specs、[design](design.md)、[implementation-plan](implementation-plan.md)、[tasks](tasks.md)，以及 [实施证据](../../../artifacts/history-inspection/README.md)、[原始测量](../../../artifacts/history-inspection/measurements.json)、[画面索引](../../../artifacts/history-inspection/samples.json) 与 [操作记录](../../../artifacts/history-inspection/checks.json)。本轮修复和重新执行的检查见下文；未重跑的旧证据另行标明。

## 结论

**PASS**，限本 change 的 Ubuntu 前台 TUI、隔离合成历史与 fake 外部协调端口。9/9 任务、4 项 Requirement、14 项 Scenario 与 IP-01–06 均已核验；范围内审计与缺陷已闭合。V-01 的完整扫描成本缺口已补齐：1千/1万/10万记录及1/5 MiB详情均从原上界独立扫描到完成，并校验完整命中数及每批边界。

输入和已缓存导航各100次采样，五场景 p95 均≤100 ms。完整扫描耗时单独记录，不受100 ms门槛约束。验收不扩展为 Windows、OS输入法、真实 provider/Orca Worker 或无人值守运行已重新验证。

| 维度 | 状态 |
| --- | --- |
| 完整性 | 9/9任务；4项Requirement、14项Scenario和全部IP-ID有实现与证据映射 |
| 正确性 | 行为复验、生产读取接线、完整扫描及响应门槛通过；测试执行详情保留首次超时记录 |
| 一致性 | D-01–09与IP-01–06；唯一权威原文、六票布局及IC-13输入保护保持 |

## 核验与修复证据

| Requirement / Scenario / IP-ID | 实现与核验证据 | 结果 |
| --- | --- | --- |
| Bounded trusted call inspection / 巨大参数与原文来源 / IP-01、06 | `application/coordinator/history-inspection.ts`、`history.ts`；storage 的 `readHistoryCalls`、`readHistoryArguments` 与 metadata span scanner；`tests/adapters/history-inspection.test.ts`，精确 1/5 MiB benchmark | 原 entry/step/call/revision 定位，UTF-8 有限范围读取；参数不复制为 UI 正文，不先完整解析巨大参数再裁切 |
| Bounded trusted call inspection / unknown与未确认 / IP-01、02 | `workflow/coordinator/context.ts`、`nodes.ts`、`tool-node.ts`；runtime-guard 观测端口；workflow/domain/storage 用例 | 分类来自可信注册；真实 unknown 在 fencing 后绑定原 operation/call；诊断变化幂等，调用与摘要遵守同一序号上界；观测不伪造结果，配对结果优先 |
| Bounded trusted call inspection / 索引补齐与重放 / IP-01、06 | storage `prepareHistoryInspection`、Bootstrap 初始化；巨大参数多轮、延后结果、250 成员重放、seek 及实际读量用例 | 有界补齐，读取不触发维护；相同身份幂等，水位不跳过未处理条目，摘要与正文前缀纳入读量预算 |
| Semantic activities and retained details / 跨页查询与变更动作 / IP-01、03 | 派生 activity identity/version；`transcript-reader.ts`；storage 与 `activity-navigation.test.tsx` 的跨页活动用例 | >100 次查询仍为同一组；用户/正文/action 断组，固定上界下配对、观测与摘要不泄漏后续序号的事实 |
| Semantic activities and retained details / 两种详情与失败 / IP-03、06 | reader、App/state/keymap/Transcript；参数/结果来源锚点、Ctrl+T、F4；真实 PTY compact/details/action/query 场景 | 全局详细与手动展开独立，F4 定位活动首个调用；紧凑态 rejected/unknown 可见，完整内容可有界阅读，composer 与 resize 锚点保持 |
| Semantic activities and retained details / 未加载与缺失 / IP-01、03、04 | 索引 ready、水位、未配对 status 与读取失败分支；storage/reader/search 行为用例 | 准备中、未确认、读取失败分别表达；缺失参数明确报错，不伪造成功或无匹配，已有 frame/草稿保留 |
| Independent bounded transcript search / 跨块 Unicode 和折叠详情 / IP-04 | `application/coordinator/history-search.ts`；22 项搜索用例，F3 参数命中 PTY；arguments/history 来源坐标 | 转义字面 Unicode 简单折叠；跨块重叠与原文 UTF-8 offset 无漏报/重复；只布局命中附近，退出恢复阅读显示态 |
| Independent bounded transcript search / 固定上界与取消 / IP-03、04 | snapshot、opaque cursor、AbortSignal、App 查询 generation；搜索/输入迟到结果用例 | 固定上界不纳入后来消息；改查询、切 Session 和取消丢弃迟到结果；临时 preview 不进入搜索 |
| Independent bounded transcript search / 失败与继续查找 / IP-04 | bounded search cursor/complete、读取失败重试与参数缺失用例；F3 完成后画面 | 未完成与无匹配分开；失败不清聊天输入，沿原边界重试；响应字节预算及尾部进度边界已修复 |
| Independent bounded transcript search / 长历史搜索不阻塞输入 / IP-04、06 | 生产文件 SQLite/TranscriptReader/TuiApp 与同 store 搜索；`benchmark.mjs`、`measurements.json` | 五场景输入/导航各100样本均 p95≤100ms；独立 fullScan 全部完成，命中数与预期一致，每批与工作区有界；V-01 已闭合 |
| Authoritative ordinary input recall / 普通历史与回答隔离 / IP-01、05 | storage `readUserHistoryPage`；`input-history.ts`，input-history/storage/Bootstrap 用例 | 当前 Session 的 role=user 权威记录直接 keyset 读取；回答与其他 Session 不混入；进入回答面板取消普通召回预览，Enter 不误发旧聊天；不建立发送日志或改写原消息 |
| Authoritative ordinary input recall / 采用与发送及原草稿 / IP-05 | App 预览/采用、原 composerChange/IC-13；输入历史与 activity App 用例，Ctrl+R PTY | 首次 Enter 只采用，后续 Enter 才提交；取消恢复原全文/cursor/pasteBlocks；预览不覆盖持久草稿 |
| Authoritative ordinary input recall / 上下召回与修改 / IP-05 | InputHistory.move/canMove/cancel、原 composer-editor；13 项 input-history 检查 | 空输入↑召回；仅未修改且处全文边界时继续浏览；越过最新恢复原草稿，编辑后返回普通输入路径 |
| Authoritative ordinary input recall / 读取失败与迟到结果 / IP-05 | 有限正文读取、大小上限、AbortSignal/generation；input-history 和 App/Session 约束 | 失败/超限不截断或清空输入，不伪造旧粘贴身份；旧 Session 请求不覆盖当前目标，可重新读取 |
| 全部 Requirement / 生产宿主与原型 / IP-06 | `foreground-planning-runtime.ts`，Controller 封闭查询；host/no-side-effect/PTY；192 对画面与 docs 合同/交接 | Scope/Session 绑定及初始化维护接通；UI 查询/重绘不推进模型或 Worker；六票呈现与返回已有对照证据 |

### 本轮命令与结果

| 命令 / 范围 | 结果 |
| --- | --- |
| `pnpm typecheck`、`pnpm lint`、`pnpm build` | 最终产品修复后均通过 |
| `pnpm test --maxWorkers=4` | 150文件/1498项通过，1项缓存预算检查超时，6文件/12项条件跳过；该轮与PTY采图并行 |
| `pnpm exec vitest run tests/tui/transcript-reader.test.ts` | 超时所属文件独立复跑，9/9通过；未调高超时或削减用例 |
| `pnpm test --maxWorkers=2` | 151文件/1499项通过；6文件/12项条件跳过 |
| `pnpm exec vitest run tests/adapters/history-inspection.test.ts tests/adapters/checkpoint-store.test.ts tests/workflow tests/application/history-search.test.ts tests/tui/activity-navigation.test.tsx --maxWorkers=2` | 最终存储修复后11文件/173项通过 |
| 侧审：activity/input-history/input-protection/no-side-effect/host-wiring/unknown-state/interaction-card/input-paths | 8文件/78项通过；回答预览修复后执行 |
| 侧审：`pnpm exec vitest run tests/workflow tests/domain` | 20文件/239项通过；随后存储修复由上述173项覆盖 |
| `node artifacts/history-inspection/benchmark.mjs` | 最终构建的五场景通过；全部fullScan完成、命中数正确、每批边界断言通过 |
| `node artifacts/history-inspection/capture.mjs --inspection-only` | 最终构建12个组合完成，保留基线及更新检索画面，共192对PNG/文本、24条操作记录 |
| `openspec validate inspect-and-search-coordinator-history --strict`、`git diff --check` | 通过，含本轮最终报告与文档更新 |

各次定向检查有重叠，不与全套相加。条件跳过不计通过。上轮留下的六票原始决议、源码与画面对照仍作为设计依据；本轮复看最终80列彩色与50列无色参数命中画面，确认详情、查询行、composer和命中标记沿用原层级。未重新执行真实外部集成或OS输入法人工验收。

新增文本另以 `git diff --no-index --check /dev/null <path>` 检查；返回新文件差异状态且没有空白错误，覆盖新增源码、测试、change文档与本批证据脚本/报告。

### 性能证据

Node `v24.12.0` / Ubuntu，真实文件SQLite、生产App/reader/search。参数JSON与结果正文各自恰好为1,048,576或5,242,880字节。数据及外部协调端口为隔离合成夹具。

| 场景 | 输入 p95 / max (ms) | 缓存导航 p95 (ms) | 冷阅读 (ms) | 独立完整扫描 (ms) | 完整命中 / 批次 |
| --- | --- | --- | --- | --- | --- |
| 1,000 条 | 59.1 / 74.2 | 10.8 | 67.0 | 368.1 | 1,000 / 21 |
| 10,000 条 | 70.4 / 91.0 | 6.8 | 29.9 | 2,959.0 | 10,000 / 201 |
| 100,000 条 | 68.0 / 80.0 | 10.0 | 37.3 | 29,799.0 | 100,000 / 2,001 |
| 1 MiB 参数＋结果 | 68.2 / 86.4 | 0.9 | 103.0 | 151.3 | 3 / 36 |
| 5 MiB 参数＋结果 | 78.3 / 148.0 | 0.8 | 128.0 | 995.2 | 3 / 164 |

`scan` 记录输入/导航采样期间持续搜索的实际工作；`fullScan` 是停止该采样搜索后，使用原固定上界从头到尾的独立完整扫描。1万/10万记录的 `scan.firstFullScanMs=null` 仍保留，不能用采样窗口充当全文耗时。五个 `fullScan.complete` 均为true，命中数分别为1000/10000/100000/3/3，仅累积标量统计，不持有全部命中。

完整扫描实测峰值：100项元数据、50命中、65,536字节正文、6,050字节响应、416字节cursor；对应限额100项/50命中/64KiB正文及响应/4096字节cursor。缓存实测正文≤34,088字节/26项、布局及上下文≤68,848字节/49项，均低于各自8MiB/64项限制。此次索引已在新写入时就绪；旧库有界补齐成本由storage行为测试覆盖，不将零补齐读量当作旧库重建成本。

### 本轮修复记录

- **V-01：完整扫描证据缺口已闭合。** benchmark新增独立完整扫描，检查游标推进、命中总数、实际读量和批次/响应上限；五场景均完成。
- **搜索重复读页。** 无调用的历史曾在普通Agent消息处反复丢弃元数据页。固定上界的调用存在性只探一次，以私有cursor标量延续；无调用时按页推进。块间使用setImmediate让出。新增240条混合消息回归，验证全部匹配及读量随记录数线性增长，搜索22项通过。
- **召回预览污染回答。** 空输入↑后进入当前Session回答面板，Enter曾可能提交旧聊天。进入回答前取消召回请求并清除临时预览，原草稿仍由IC-13保存。App回归证明召回确实发生，打开回答后Enter不提交旧聊天；活动导航5项通过。
- **unknown诊断变化破坏幂等。** 相同可信调用再次unknown但理由变化，曾返回写入失败。现在保留首次观测，身份重验仍拒绝错误call/operation；不重复计数，不产生工具结果。
- **unknown状态越过序号上界。** 单次调用状态曾读取后续序号观测，活动摘要却保持旧状态。观测保存记录时已提交序号，调用状态与摘要按同一上界过滤。扩展已有storage用例先分别复现以上两项失败，修复后19项通过；本批观测表增加序号，权威entry/step/Wake及checkpoint/UI版本不变。

上轮已经修复的UTF-8尾部、固定上界配对/摘要、延后结果、计数重放、索引seek、搜索尾部/响应预算、参数缺失、F4首调用定位及NO_COLOR标记，也在本轮全套或受影响复验中覆盖。没有通过修改规格、减少数据规模或放宽门槛隐藏差异。

## 限定审计

implementation-plan §8的必审范围全部闭合。

| 范围 | 结论与证据 |
| --- | --- |
| 参数底层有界读取、唯一原文、索引补齐 | 原metadata范围定位，BLOB有限范围读取，UTF-8边界与实际读量记账；storage19项及checkpoint用例，无全文UI镜像 |
| 活动跨页与固定版本 | 首call身份、keyset定位、250成员重放、配对/观测/摘要上界；storage、reader与活动导航用例 |
| unknown/accepted与恢复 | 可信注册分类及fencing，原调用观测幂等；配对结果优先，不猜测未确认、不伪造结果，不重写执行或对账状态机 |
| 搜索取消、跨块、位置与工作区 | Application独立搜索、22项行为检查；五场景完整扫描和有限批次/响应，私有cursor仅增加标量 |
| Ctrl+R、原草稿/CAS/提交与回答隔离 | user-only读取，Enter先采用，原草稿/块恢复，迟到读取和失败保护；78项侧审及App回答预览回归 |
| 生产宿主与副作用隔离 | Scope/Session/schema封闭查询、Bootstrap显式维护，host/no-side-effect/foreground-runtime及PTY检查；重绘只读 |
| 六票画面对照 | 定稿来源与此前直接对照保留；最终构建补采12组合，复看彩色/NO_COLOR代表画面，布局/层级/返回不重设计 |

没有未闭合的范围内缺陷、必需证据缺口或待执行审计。

## 后续注意事项

- 报告绑定未提交工作区；提交或再次修改产品后应更新实际对象，不能仅凭基线SHA复用结论。
- p95不承诺所有单次操作≤100 ms；5MiB输入max为148 ms、冷阅读约128 ms。完整扫描随历史增长；RSS含合成数据和框架分配，不等同有界阅读缓存。
- Unicode字面搜索采用简单折叠；同步SQLite语句只在有限块/批之间可取消。
- 当前证据限Ubuntu；OS输入法、Windows和真实provider/Orca Worker未在本轮重验，12项条件跳过不计通过。
- 第五批跨Session待答联动、后继配置、持久偏好和历史图功能不属于本change。
