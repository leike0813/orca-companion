# 第五批待答联动证据

2026-10-03，Ubuntu；基线 `69f0aa1781265bb7623cb4bbb3e8ae5722e72bce`。
实现为工作区中的 [link-tui-pending-interactions](../../openspec/changes/link-tui-pending-interactions/implementation-plan.md)，未提交、未归档。
任务9/9完成；[正式规约验收](../../openspec/changes/link-tui-pending-interactions/verification.md)为PASS，
`gpt-6-luna`独立只读复验6文件140项全部通过。

生产 `TuiApp`、组件和阅读器通过 `scripts/tui-preview.mjs alignment` 运行。`ORCA_COMPANION_PENDING_INTERACTIONS=1`
为这一批加载独立的真实 SQLite Branch Store 与 checkpoint，可信 `ask_user` 身份、问题/回答、范围读取、
聚合计数和答复 CAS 都来自应用/存储实现。执行图、模型目录及其余 Controller/backend 端口为隔离 fixture，
不代表真实模型或 Orca 运行。

## PTY 与操作

运行 `pnpm build` 后执行 `node artifacts/pending-interactions/capture.mjs`。
使用项目已有的 tuistory/Ghostty PTY 与图片渲染器，不启动开发服务器。
三档为 120×40、80×24、50×40，每档覆盖彩色/NO_COLOR × Nerd/ASCII。
每组12对画面，另有连续 resize 的3对，共147对 PNG/同名终端文本。
[samples.json](samples.json) 保存实际尺寸、图标/颜色选择和原生 cursor；[checks.json](checks.json) 保存12组操作结果。

操作顺序：历史 Q/state/A → Ctrl+T 原位详情 → 输入“首尾”并将光标移到中间 → Ctrl+B 待答列表
→ PgDown 第二页 → Enter 明确选择 Session B 的第20题 → Tab 自由答复、输入中文/emoji → Esc 保存返回
→ 再进入同题并恢复原答复 → Enter 受理返回原页 → 消失的选择提示 → Esc 回到聊天、插入“中”得到“首中尾”
→ Session Picker/Graph Inspector/Cancel 审阅并 Esc 返回 → slash 上方候选 → 120→80→50→120 连续 resize。
采集明确等待 slash 候选完成绘制，避免把上一帧计作候选证据。

| 场景 | 代表画面 |
| --- | --- |
| 原提问处已答/开放卡片、紧凑回答 | [80×24](history-cards-80x24-color-nerd.png)、[50×40 无色](history-cards-50x40-no-color-ascii.png) |
| 同一阅读器原位展开 Q/options/result | [80×24](history-detailed-80x24-color-nerd.png) |
| 固定项目框、Scope 页与当前 Session 不切换 | [120×40](scope-page-120x40-color-nerd.png)、[第二页](scope-later-page-80x24-color-nerd.png) |
| 明确选题后跨 Session 底部回答面板 | [50×40 无色/ASCII](cross-answer-50x40-no-color-ascii.png) |
| Esc 保存回答并恢复原栏目/选择 | [50×40](saved-return-50x40-color-nerd.png) |
| 受理返回原页、失效选择不自动打开下一题 | [80×24](accepted-return-80x24-color-nerd.png) |
| 原聊天全文/光标继续编辑 | [80×24](cursor-return-80x24-color-nerd.png) |
| Session Picker、Graph Inspector、审阅默认返回 | [Session](sessions-80x24-no-color-ascii.png)、[Graph](graph-120x40-color-nerd.png)、[审阅](cancel-review-80x24-color-nerd.png) |
| Slash 候选在 composer 上方 | [80×24](slash-80x24-color-nerd.png) |
| 连续 resize | [80×24](continuous-resize-80x24-color-nerd.png)、[50×40](continuous-resize-50x40-color-nerd.png)、[返回120×40](continuous-resize-120x40-color-nerd.png) |

## 六票画面对照

先读了各票定稿决议与源码，再查看定稿和本轮生产画面；原型对应表由
[已归档 D-01](../../openspec/changes/archive/2026-10-03-align-tui-with-approved-prototypes/design.md#d-01六张原型票直接作为设计参照) 拥有。

| 定稿 | 本轮实际对照 | 结论与边界 |
| --- | --- | --- |
| #40 continuous | history-cards/history-detailed 三档 | Q/state/A 在原调用位置，工具紧凑/展开沿原留白和标记；正文不进入最近事件 |
| #47 above-input | slash 三档 | 候选位于 composer 上方，焦点反色、圆角输入与采用/执行分离保持 |
| #51 tabs | scope-page/saved-return/accepted-return | ≥100列占原 sidebar 区域，窄屏占主区域；页签、固定框、明确失效选择与返回保持 |
| #52 dialog final | sessions/cancel-review 三档两色两图标 | 固定框、动作反色、默认返回；未增加 provider/effort/角色配置 |
| #48 custom-direct | history-cards/cursor-return | 简短顶栏与独立风险行、会话核心单行保持；实际缺失 effort/context 明示不可用 |
| #43 adaptive + #52 final | workspace sidebar/graph/连续 resize | 沿当前图、节点卡、关系导航与尺寸约束；未扩展历史图或验收摘要 |

这是第五批范围内的呈现验收，不据此宣称后继配置、custom 保存或完整图功能已经实现。

## 行为与性能

关键回归复用 coordination-store、execution-view、status-command、transcript-reader、activity-navigation、
input-paths、session-lifecycle 和 no-side-effect 测试：20条页与完整计数、精确后页、Scope/owner/version 隔离、
UTF-8 范围、同一步多个提问的顺序、索引未就绪/缺失/读取失败、状态刷新、缓存和来源锚点，及
保存失败/unknown/拒绝/后来编辑/手工切会话/迟到结果保护。
完整折叠粘贴草稿的测试读取持久记录，核验全文、cursor、唯一块身份与范围；同时验证返回原历史来源。

运行 `node artifacts/pending-interactions/benchmark.mjs` 将性能结果独立写入 [measurements.json](measurements.json)。
真实文件型 SQLite 同时包含1000/10000/100000条不同历史与问答记录，25个开放问题，展示页20项；
另测1/5MiB持久回答。每场景100次生产 App 输入到重绘、100次阅读器缓存导航及100次展示查询。
巨型回答是持久正文压力 fixture，不表示当前输入允许这一大小。Controller/backend 为 fake。
既有 #53 的输入/缓存导航 p95≤100ms 和双缓存8MiB/64项上限继续作为验收边界。

| 场景 | 输入 p95 ms | 缓存导航 p95 ms | 展示查询 p95 ms | 冷打开 ms |
| --- | ---: | ---: | ---: | ---: |
| 1000条 | 54.36 | 7.76 | 2.25 | 97.36 |
| 10000条 | 58.77 | 6.22 | 2.12 | 91.94 |
| 100000条 | 68.64 | 8.12 | 17.19 | 12.19 |
| 1000条 + 1MiB回答 | 64.21 | 6.39 | 1.95 | 87.91 |
| 1000条 + 5MiB回答 | 74.73 | 11.02 | 1.58 | 115.91 |

每场景均为100次输入/导航/展示查询。返回的单次问答正文最多16388字节；折叠场景不读问答正文。
摘要每次只查询当前窗口的指定ID，未随历史规模扩大；双缓存最大正文34036字节/24项、布局44372字节/42项。
冷打开单独记录，不算缓存导航或输入门槛；GC、进程调度和合成 fixture 分配会影响单次最大耗时。

最终 `pnpm typecheck`、`pnpm lint`、`pnpm build`、strict OpenSpec 和 `git diff --check` 通过。
全量 `pnpm exec vitest run --maxWorkers=2` 首轮150文件/1513项通过、6文件/12项条件跳过；
唯一失败为 Controller snapshot 的已有公开字段清单缺少新增 `openInteractionCount`。
补入该字段后单独复验 `tests/application/controller-service.test.ts` 的15项全部通过。
结合未改动的其余全量结果，最终覆盖151文件/1514项通过，条件跳过仍为6文件/12项；没有把复验重复计数。

检查结果在本轮 [implementation-plan](../../openspec/changes/link-tui-pending-interactions/implementation-plan.md) 记录。
真实终端恢复由 `tests/tui/pty.test.ts` 在独立 tmux server 中测量 `stty -g` 和显式 Ctrl+C 退出，
不是由截图推断。字节注入证明中文/emoji渲染和输入往返，没有新增真实 OS IME 预编辑/候选窗人工证据。
本轮未启用隔离真实 Orca/provider 条件测试；Windows 未验证。
