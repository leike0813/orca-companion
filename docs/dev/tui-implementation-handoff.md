# TUI 实现进度与原型交接

> **硬约束：尊重已确认原型。任何 TUI change 必须直接引用对应定稿决议、源码和画面，并按其布局、信息层级、视觉风格、导航与返回约定实施、验收。未经用户明确批准，不得自行重新设计。交互正常或自动测试通过，不能替代原型一致性验收。**

状态日期：2026-10-06。接手先核对 HEAD、工作区和当前工件；保留已有未提交改动。体验以用户当前指示和 Decision Ticket 最终决议为准；领域、模块与公共合同分别由 [CONTEXT.md](../../CONTEXT.md)、[architecture.md](../architecture.md)、[interface-contracts.md](../interface-contracts.md) 拥有。

当前批次为 [remove-worker-credential-management](../../openspec/changes/remove-worker-credential-management/implementation-plan.md)。模型设置沿 #52 dialog final：Worker 角色只选择 harness 与该 harness 原生目录候选（model/effort），不再出现连接、凭据、API key 或任意 options 字段；Coordinator 表单保留。目录查询失败时可手填 native exact ID 并标记未验证，effort 不可捏造。保存追加 profile，执行应用须经 Manifest v4 审阅。行为检查与三档画面验收按本 change 的 implementation-plan 执行，自动测试不能代替呈现验收。

## 1. 六票来源与当前范围

Route Map 为 [#37](https://github.com/leike0813/orca-companion/issues/37)，功能依赖见 [#46 最终决议](https://github.com/leike0813/orca-companion/issues/46#issuecomment-5946016892)。

**原型对应表见已归档的 [design.md D-01](../../openspec/changes/archive/2026-10-03-align-tui-with-approved-prototypes/design.md#d-01六张原型票直接作为设计参照)，包含六票最终决议、源码和代表画面的可点击链接。接手不能只看一张票或凭记忆实施。**

| 原型票 | 定稿版本 | 当前纠偏职责 | 仍需后继功能合同 |
| --- | --- | --- | --- |
| #40 / P-40 | continuous | 保留标记/色边/留白/工具；3A 全历史范围读取，3B 有界视窗/锚点/Markdown/真实流式 | 后继活动分组、详情/搜索 |
| #47 / P-47 | above-input | 圆角真实 composer、有界上方候选、采用/执行分离 | 完整命令搜索及未接通操作 |
| #51 / P-51 | tabs，固定 sidebar 区域，窄屏主区域 | Ctrl+B、总览/Scope 待答页/最近事件及已有详情，固定外框和回答返回 | 可信身份/批准后正文 |
| #52 / P-52 | dialog final | 现有四类弹窗、反色动作、默认返回、Nerd/ASCII 即时选择 | provider/effort/Worker 角色配置、图标持久偏好 |
| #48 / P-48 | custom-direct | 简短顶栏、单行会话核心/图、独立风险与字段配色 | 可靠 effort/context/Claim/预算 metadata、完整 custom 设置与保存 |
| #43 / P-43 | adaptive，联动 #52 final | 当前图 sidebar/Inspector、分区节点卡、准确关系与窄屏检查 | 共享 Validator 摘要、历史图与依据全文 |

语义以 #41/#42/#44/#45/#50 最终决议为准，链接也在 design D-01。旧演示的常驻 thought、Ctrl+A 回答、追加式输入、居中项目面板、fixture 模型/context/预算和 9/20 进度都不能复制为生产事实。原型根组件与 final/custom-direct 独立源码归档只读，运行入口见 [TUI 工作台](tui-workbench.md)。

## 2. 已有 changes 的状态

实现、行为检查、每票呈现、完整功能、提交和归档分别记录。历史 PASS 的范围以各自报告为准。

| Change | 已记录实现/验证 | Git / OpenSpec 状态 | 原型关系 |
| --- | --- | --- | --- |
| `m2-deliver-planning-tui` | 14/14；[verification PASS](../../openspec/changes/archive/2026-09-23-m2-deliver-planning-tui/verification.md) | 2026-09-23 已归档 | 定稿前的生产功能基线 |
| `m2-deliver-execution-tui` | [verification PASS](../../openspec/changes/archive/2026-09-29-m2-deliver-execution-tui/verification.md)，含隔离真实执行 PTY，限制见报告 | 2026-09-29 已归档 | 执行功能基线，未代表新 adaptive/项目原型落地 |
| `tui-debug-workbench-and-ui-migration` | 6/6；[verification PASS](../../openspec/changes/archive/2026-09-29-tui-debug-workbench-and-ui-migration/verification.md) | 实现 `b4dfd3c`、归档 `e774b5a`；2026-09-29 已归档 | 共享主题/组件/隔离预览基础 |
| `protect-tui-input`（第一批） | 18/18；[verification PASS](../../openspec/changes/archive/2026-10-02-protect-tui-input/verification.md) | 实现/归档包含于 `c1964d4`；2026-10-02 已归档 | 输入保护行为基础 |
| `complete-tui-editor`（第二批） | [任务 7/7](../../openspec/changes/archive/2026-10-02-complete-tui-editor/tasks.md)；[verification PASS](../../openspec/changes/archive/2026-10-02-complete-tui-editor/verification.md)，限批准功能范围 | 实现/归档包含于 `d3066e2`；2026-10-02 已归档、主规格已同步 | 完整编辑与当前回答；不能推定整体原型通过 |
| `align-tui-with-approved-prototypes` | 任务 21/21；最终复验 27 文件/181 项通过，2 条件跳过，普通真实 PTY 13 项通过；**[verification PASS](../../openspec/changes/archive/2026-10-03-align-tui-with-approved-prototypes/verification.md)**，V-01–04 及审计发现的滚动预算 F-01 已修复 | 已包含于 `8af15029`；2026-10-03 已归档，六份主规格已同步 | 原 277 对证据已复查；另存 [108 对修复/补采画面与操作](../../artifacts/tui-prototype-alignment/repair-20261003/README.md)，三档层级、键位、固定框/返回通过；D-10 全功能缺口继续保留 |
| `paginate-coordinator-history`（3A） | 增量权威历史、有界有效上下文与正式 transcript 分页；证据见 [README](../../artifacts/coordinator-history/README.md) | 已包含于 `b15ff20d`，2026-10-03 已归档 | 沿用 #40 continuous 和 #41 阅读键位，三档彩色/NO_COLOR、跨页与 resize 共 45 对画面 |
| `render-bounded-transcript`（3B） | 局部原文视窗、双缓存、来源锚点、有限 Markdown、生产流式/中止与预算；[性能与81对画面](../../artifacts/bounded-transcript/README.md)；[verification PASS](../../openspec/changes/archive/2026-10-03-render-bounded-transcript/verification.md) | 已包含于 `20f02996`；2026-10-03 已归档、主规格已同步；原验收按用户要求复用当时证据 | 六票结构沿用，三档两色/Nerd与ASCII、历史/流式/resize/返回；输入和缓存导航各100采样达到 #53 p95 |
| `inspect-and-search-coordinator-history`（第四批） | 任务9/9；可信活动、参数/结果来源、整体详细、F4、F3 原文搜索及普通输入召回/Ctrl+R；[性能与192对画面](../../artifacts/history-inspection/README.md)，五场景完整扫描及响应门槛通过；[verification PASS](../../openspec/changes/archive/2026-10-03-inspect-and-search-coordinator-history/verification.md) | 已包含于 `69f0aa17`；2026-10-03 已归档、主规格已同步 | 沿六票定稿；完整扫描、必要检查与最终画面证据齐备 |
| `link-tui-pending-interactions`（第五批） | 9/9；有界问题摘要与完整计数、原提问处 Q/state/A、原位详情、跨 Session 回答和原入口/草稿/锚点返回；[verification PASS](../../openspec/changes/archive/2026-10-03-link-tui-pending-interactions/verification.md)，[147对画面与性能](../../artifacts/pending-interactions/README.md) | 已包含于 `abf8f0c`；2026-10-03 已归档、主规格已同步 | 沿六票定稿；输入/缓存导航p95通过，范围外配置与图功能留后继 |

### 第二批成果及证据边界

第六批 6A/6B 及全部前驱已归档；第七批 `complete-tui-project-statusline` 已包含于 commit `41b2f1e` 并归档到 `2026-10-04-complete-tui-project-statusline`。其[生产证据](../../artifacts/project-statusline/README.md)和历史验收范围保持原样。第八批 `complete-tui-graph-basis` 已包含于 `055c148` 并归档到 `2026-10-04-complete-tui-graph-basis`。当前 active change 为 `remove-worker-credential-management`，沿用六票布局与返回约定，把 Worker 模型设置收敛为原生目录候选与独立 effort；完成状态以当前 change 的任务和验证记录为准。

第二批已提供 grapheme 任意位置编辑、行首尾、多行有界视窗、原生光标；>1000 code points 原子粘贴及 /paste；唯一完整 UiDraft、CAS、提交快照/稳定 submissionId、单活跃提交/generation；真实 ask_user 创建/重放与精确查询；当前 Session 选项/自由回答、Esc 恢复。UI schema v2、Coordination schema 14，问题正文由 Branch Store 拥有。

证据来源：[第二批 implementation-plan](../../openspec/changes/archive/2026-10-02-complete-tui-editor/implementation-plan.md#9-本轮验收记录2026-10-02)。

| 证据 | 已记录结果 |
| --- | --- |
| typecheck/lint/build | 通过 |
| 全量测试 | 145 文件通过/6 条件跳过；1369 项通过/12 条件跳过，跳过不可算通过 |
| Ubuntu 真实 PTY | 三档中文/多行粘贴/resize/回答/Esc/无色/终端恢复通过 |
| 真实 IME 人工反馈 | 用户：“我已完成人工验收，交互似乎是正常的。”未提供终端/输入法名称，字节注入不充当 IME 证据 |
| OpenSpec/diff | 第二批严格校验和 diff 检查通过 |
| 整体原型对照 | 第二批没有逐票画面对照，不能由交互反馈推定 |

### 原型纠偏的旧阶段记录

已改 continuous 标记/色边/留白、圆角 composer/统一内宽/native cursor、当前回答层级/反色/高度预算。旧阶段 TUI 27 文件/172 项通过，2 文件/2 项条件跳过；普通 PTY 12 项通过，真实 Orca 两项未启用隔离开关；typecheck/lint/build/strict/diff 通过。

[旧 54 组生产画面](../../artifacts/tui-prototype-alignment/README.md) 覆盖聊天、输入和当前回答的三档彩色/NO_COLOR、中文多行/粘贴/Esc/禁用。它们只证明旧范围，**不证明重稿后的六票整体对齐**。保留这些样例，扩展证据另存 full-map。

旧 `tool-expanded-50x40-no-color.png/.txt` 被临时脚本误覆盖，原文件未入 Git、无备份，用户已明确接受丢失；该对文件不再计为旧阶段原始证据。商议过程中形成的六票原型源码及定稿素材完整保留。本轮采集脚本仅写 full-map，来源更正已记在旧目录 README。

## 3. 接续顺序与缺口

呈现纠偏、3A、3B、第四批和第五批均已归档；第六批按用户决定拆为连续 6A/6B，沿用同一原型。原纠偏范围的缺口与 owner 见 [design D-10](../../openspec/changes/archive/2026-10-03-align-tui-with-approved-prototypes/design.md#d-10逐项合同缺口与后续归属)，第五批边界见 [已归档 design](../../openspec/changes/archive/2026-10-03-link-tui-pending-interactions/design.md)。

| 顺序 | 当前状态 / 后续职责 |
| --- | --- |
| 第二批 | 已归档，功能验证 PASS |
| 原型纠偏 | 已归档，正式验收 PASS；V-01–04/F-01 已修复，输入保护接缝保留 |
| 3A | 已归档：全历史增量读写、keyset/正文范围、分页返回和有效上下文边界 |
| 3B | 已归档：局部视窗、稳定锚点/有界缓存、Markdown/流式与 #53 输入/缓存导航 p95；原验收复用当时既有证据 |
| 第四批 | 已归档9/9：活动关联/参数与结果详情、F3 transcript 搜索、Ctrl+R 普通输入历史；1千/1万/10万记录与1/5MiB完整扫描成本均已记录 |
| 第五批 | 已归档9/9、正式验收PASS：历史问答卡片、Scope有界待答页、跨Session进入/返回及输入保护；6文件140项独立复验通过，全量与唯一失败修复后合并1514项通过、12项条件跳过；147对画面及性能见独立证据 |
| 第六批 6A | 9/9、[正式验收PASS](../../openspec/changes/archive/2026-10-04-complete-tui-command-reviews/verification.md)，已包含于 `8f6d1a7`、已归档：同源目录/子页搜索、结构化结果与输入保护、精确交接 ID/revision、五栏授权/三栏交接审阅和显式 Session 模型目录；[生产画面与操作](../../artifacts/command-reviews/README.md)及最终检查见 change 验收记录 |
| 第六批 6B | 13/13、[独立验收PASS](../../openspec/changes/archive/2026-10-04-complete-tui-model-configuration/verification.md)，已包含于 `82f6a77`、已归档；provider/model/effort、不可变 Worker Profiles、用户级 CredentialStore、Manifest2 模型限定重授权、schema16 Task 绑定和实际启动接线完成。[171对生产画面与隔离真实启动](../../artifacts/model-configuration/README.md)；全量及最终受影响复验按文件去重后1653项通过/12项条件跳过，原始全量exit 1及复验口径见验收报告 |
| 第七批 | 已归档并包含于 `41b2f1e`：[complete-tui-project-statusline](../../openspec/changes/archive/2026-10-04-complete-tui-project-statusline/implementation-plan.md)，12/12任务和历史独立验收完成；[原生产证据](../../artifacts/project-statusline/README.md)保留原记录 |
| 第八批 | 当前 active：[complete-tui-graph-basis](../../openspec/changes/complete-tui-graph-basis/implementation-plan.md)，任务12/12；最终检查已通过，独立正式核验PASS。读取返回、六票对照、规模性能、真实Cutover与MiniMax真实闭环已完成：n retire、o同Attempt Recovery/revise均取得deliverable，2版图的38/82完整正文可读。原驱动各6通过/2显示断言失败/2阶段跳过、exit1，已在原暂停现场通过生产详情与Inspector复验结清；人工督办/回答及原日志保留。Task/Dispatch/Attempt、Segment、结算、预算与Verdict在读取重启后不变。固定全量1756通过/12条件跳过，最终脚手架复验另存。六票原矩阵192独立对、项目入口96对、状态栏114对、审阅108对、待答/事件36对；独立正式验收PASS，见 [graph-basis](../../artifacts/graph-basis/README.md) |

[#53 性能基线](https://github.com/leike0813/orca-companion/issues/53#issuecomment-5945507505)：1000/10000/100000 条记录，输入与已缓存导航 p95≤100ms。3B使用实际 SQLite、生产阅读器与生产 App，每种100次输入/导航采样；1/5 MiB 正文与工具输出同测。冷读取、提交、finish、SDK聚合与RSS另列，限制见证据报告。

## 4. 六票原型验收和进度更新

纠偏的 [tasks.md](../../openspec/changes/archive/2026-10-03-align-tui-with-approved-prototypes/tasks.md) 与 [implementation-plan.md](../../openspec/changes/archive/2026-10-03-align-tui-with-approved-prototypes/implementation-plan.md) 按 IP-01–09 登记实际完成项，旧局部测试保留其范围。该批新增固定项目/详情、候选两步采用、弹窗默认返回、图多关系/活动节点和连续 resize 验证；事件更新不抢焦点，移出窗口的原选择明确失效。

生产画面对照使用现有 `pnpm ui:preview`/tuistory/PTY，隔离端口与存储，不把 prototype 入口当生产。覆盖三档、彩色/NO_COLOR、Nerd/ASCII、规划/执行/阻塞/unknown/待答/空闲；逐项操作项目页签/详情、四类弹窗、候选采用、图选择/依赖/栏目/返回和连续 resize。

阶段证据见 [full-map README](../../artifacts/tui-prototype-alignment/full-map/README.md)，修复后的当前证据见 [repair README](../../artifacts/tui-prototype-alignment/repair-20261003/README.md)：用途分组、三类审阅键位、位置提示及固定框/返回另存 108 对画面与同名文本，保留操作序列、18 组拦截观察及实际 cursor。原型素材和历史 verification 保留原范围，旧阶段一对文件的丢失按上面的用户反馈登记。行为测试复用现有用例，不用整屏 snapshot、像素或源码字符串门禁代替对照。

纠偏批只验证标准布局，模型配置由已归档 6B 完成，custom 功能由已归档第七批完成；第五批跨 Session 待答协议的独立证据见上表。纠偏批 typecheck/lint/build、change/六份主规格严格 OpenSpec、diff 和 TUI 181 项复验通过，两项隔离真实 Orca 条件检查未运行。2026-10-03 正式 [verification](../../openspec/changes/archive/2026-10-03-align-tui-with-approved-prototypes/verification.md) 结论为 **PASS**：输入分发、用途分组、区域规格与 PTY 入口已修复，限定审计的滚动预算问题复核闭合；已提交并归档。3A 单独验收全部原文分页，不据此宣称 3B 的渲染/缓存或整体性能完成。平台证据限 Ubuntu；本次没有新增 OS 输入法预编辑/候选窗人工证据，Windows 未验证。
