# TUI 实现进度与原型交接

> **硬约束：尊重已确认原型。任何 TUI change 必须直接引用对应定稿决议、源码和画面，并按其布局、信息层级、视觉风格、导航与返回约定实施、验收。未经用户明确批准，不得自行重新设计。交互正常或自动测试通过，不能替代原型一致性验收。**

状态日期：2026-10-03。接手先核对 HEAD、工作区和当前工件；保留已有未提交改动。体验以用户当前指示和 Decision Ticket 最终决议为准；领域、模块与公共合同分别由 [CONTEXT.md](../../CONTEXT.md)、[architecture.md](../architecture.md)、[interface-contracts.md](../interface-contracts.md) 拥有。

## 1. 六票来源与当前范围

Route Map 为 [#37](https://github.com/leike0813/orca-companion/issues/37)，功能依赖见 [#46 最终决议](https://github.com/leike0813/orca-companion/issues/46#issuecomment-5946016892)。

**原型对应表已直接写入当前 [design.md D-01](../../openspec/changes/align-tui-with-approved-prototypes/design.md#d-01六张原型票直接作为设计参照)，包含六票最终决议、源码和代表画面的可点击链接。接手不能只看一张票或凭记忆实施。** 后续归档时将此链接迁到实际归档路径，保留对应表。

| 原型票 | 定稿版本 | 当前纠偏职责 | 仍需后继功能合同 |
| --- | --- | --- | --- |
| #40 / P-40 | continuous | 保留已改标记/色边/留白/工具，并在新布局重新验收 | 全历史、活动分组、Markdown、详情/搜索 |
| #47 / P-47 | above-input | 圆角真实 composer、有界上方候选、采用/执行分离 | 完整命令搜索及未接通操作 |
| #51 / P-51 | tabs，固定 sidebar 区域，窄屏主区域 | Ctrl+B、总览/待答/最近事件及已有详情，固定外框和返回 | 跨 Session 回答完整返回、可信身份/批准后正文 |
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
| `align-tui-with-approved-prototypes` | 任务 21/21；最终复验 27 文件/181 项通过，2 条件跳过，普通真实 PTY 13 项通过；**[verification PASS](../../openspec/changes/align-tui-with-approved-prototypes/verification.md)**，V-01–04 及审计发现的滚动预算 F-01 已修复 | `d3066e2` 上的已检查未提交工作区；六份主规格与 IC-12 已同步；未归档 | 原 277 对证据已复查；另存 [108 对修复/补采画面与操作](../../artifacts/tui-prototype-alignment/repair-20261003/README.md)，三档层级、键位、固定框/返回通过；D-10 全功能缺口继续保留 |

### 第二批成果及证据边界

当前基线 HEAD：`d3066e2bf805db3efdc6db1cf9b4d1a8af81c205`。第二批已包含于 HEAD；当前 dirty 工作区主要为原型纠偏阶段成果与重稿工件。接手先检查 `git status --short`，不要覆盖、重置或重复实现。

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

先完成重稿后的呈现纠偏，再接 #46 的功能批次；后继沿用同一原型，不重新比较视觉方案。完整缺口、当前显示方式与 owner 的唯一登记见 [design D-10](../../openspec/changes/align-tui-with-approved-prototypes/design.md#d-10逐项合同缺口与后续归属)。

| 顺序 | 当前状态 / 后续职责 |
| --- | --- |
| 第二批 | 已归档，功能验证 PASS |
| 当前原型纠偏 | 已实施并复验，正式验收 PASS，V-01–04/F-01 已修复；旧输入保护接缝保留，D-10 功能缺口转后继合同，当前未提交/未归档 |
| 3A / 3B | 全历史增量读写、keyset/正文范围、稳定锚点/有界缓存、Markdown/流式与 #53 性能 |
| 第四批 | 活动关联/完整详情、F3 transcript 搜索、Ctrl+R 普通发送历史 |
| 第五批 | 当前回答基础已具备；补历史卡片状态和跨 Session 进入/返回，保护原位置/草稿 |
| 第六批 | 当前命令/弹窗样式与候选已实现；后继补完整目录搜索、真实 provider/effort/角色配置及其权限 |
| 第七批 | 当前项目固定框/状态栏层级已实现；后继补可信身份/context/metadata、用户级 custom 配置/恢复/保存失败和共享验收摘要 |
| 第八批 | 当前 adaptive/节点卡/准确导航已实现；后继补历史版本/依据有界读取与全链路验收 |

[#53 性能基线](https://github.com/leike0813/orca-companion/issues/53#issuecomment-5945507505)：1000/10000/100000 条记录，输入与已缓存导航 p95≤100ms。当前短窗口通过不能推定完整历史性能通过。

## 4. 六票原型验收和进度更新

当前 [tasks.md](../../openspec/changes/align-tui-with-approved-prototypes/tasks.md) 与 [implementation-plan.md](../../openspec/changes/align-tui-with-approved-prototypes/implementation-plan.md) 按 IP-01–09 登记实际完成项，旧局部测试保留其范围。本轮新增固定项目/详情、候选两步采用、弹窗默认返回、图多关系/活动节点和连续 resize 验证；事件更新不抢焦点，移出窗口的原选择明确失效。

生产画面对照使用现有 `pnpm ui:preview`/tuistory/PTY，隔离端口与存储，不把 prototype 入口当生产。覆盖三档、彩色/NO_COLOR、Nerd/ASCII、规划/执行/阻塞/unknown/待答/空闲；逐项操作项目页签/详情、四类弹窗、候选采用、图选择/依赖/栏目/返回和连续 resize。

阶段证据见 [full-map README](../../artifacts/tui-prototype-alignment/full-map/README.md)，修复后的当前证据见 [repair README](../../artifacts/tui-prototype-alignment/repair-20261003/README.md)：用途分组、三类审阅键位、位置提示及固定框/返回另存 108 对画面与同名文本，保留操作序列、18 组拦截观察及实际 cursor。原型素材和历史 verification 保留原范围，旧阶段一对文件的丢失按上面的用户反馈登记。行为测试复用现有用例，不用整屏 snapshot、像素或源码字符串门禁代替对照。

完整历史/真实配置/跨会话协议仍未完成，标准布局不能称 custom 功能完成。typecheck/lint/build、change/六份主规格严格 OpenSpec、diff 和 TUI 181 项复验通过，两项隔离真实 Orca 条件检查未运行。2026-10-03 正式 [verification](../../openspec/changes/align-tui-with-approved-prototypes/verification.md) 结论为 **PASS**：输入分发、用途分组、区域规格与 PTY 入口已修复，限定审计的滚动预算问题复核闭合；当前对象固定于报告链接的工作区补丁。提交和归档尚未进行。平台证据限 Ubuntu；本次没有新增 OS 输入法预编辑/候选窗人工证据，Windows 未验证。
