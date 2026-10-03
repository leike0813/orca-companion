# Verification

## 验收对象

- Change：`align-tui-with-approved-prototypes`；2026-10-03，Ubuntu。
- 输入实现 HEAD：`d3066e2bf805db3efdc6db1cf9b4d1a8af81c205` 加上初次验收的未提交工作区。
- 最终验收 HEAD：同上，加上 V-01–04 与 F-01 修复后的工作区。HEAD 单独不包含本 change；产品与测试对象固定于 [implementation-reviewed.diff](../../../artifacts/tui-prototype-alignment/repair-20261003/implementation-reviewed.diff)，包含新增 ProjectPanel。此后仅更新验收文档；未提交、归档或启动开发服务器。
- 验收 Agent：Codex 主会话；两个原生子代理继承当前模型，分别修复键位/测试与真实执行 PTY；第三个同模型子代理只读审计几何、输入分发与规格。主会话复核发现、修复共享滚动预算、运行检查并亲自对照画面。所有审计已收回。
- 依据：[proposal](proposal.md)、六份 delta specs、[design D-01–10](design.md)、[implementation-plan IP-01–09](implementation-plan.md)、[tasks](tasks.md)、直接前驱 `complete-tui-editor` 的归档合同、六票定稿与 #41/#42/#44/#45/#50 最终语义。

## 结论

**PASS**，限于本 change 的已有生产区域呈现、导航、输入保护接续与当前已检查的工作区。21/21 任务完成，17 个 Requirement、50 个 Scenario 及 IP-01–09 均有核验依据，范围内没有未解决缺陷或待回收的必需审计。

初次验收的四项问题与限定审计新增的 F-01 已修复并复验。Recovery/Finalizer 两份补充 delta 将既有事实移到已批准的详情区域，未修改其身份、权限或结果语义。D-10 的完整历史、跨 Session 返回、真实角色/effort/custom 配置、可信元数据及共享摘要继续保持未完成，不能把此结论扩大为六张票的全部功能完成。

真实 Orca execution/handoff 两项检查未启用隔离开关，未运行、未计为通过。按 implementation-plan 的条件运行边界，本次验证它们的区域迁移与固定投影入口，不宣称新增真实 Provider/Worker 恢复或交付证据。

## 修复与复验

| 发现 | 修复与证据 | 结果 |
| --- | --- | --- |
| V-01：三个审阅特许 Ctrl+P 打开可执行 Palette | app 共同 guard 删除 reviewNavigation 例外；审阅/确认拦截 Ctrl+P/B/G，Ctrl+C 与 Esc 沿原流程。input-paths 参数化三类审阅；依赖非法嵌套 Palette 的交接测试改走合法返回。旧例外临时恢复时三个新回归均失败。真实三档/两色的 18 组观察见 [checks.json](../../../artifacts/tui-prototype-alignment/repair-20261003/checks.json)。 | 已修复；默认返回、准确确认及零业务触发通过。 |
| V-02：项目总览用途分组被压平 | projectItems 恢复需要处理、额度与权限、项目资料；总览每项三行，其他列表两行，容量按真实行高计算。青色用途标题、操作、次要说明与留白按 P-51 对照。 | 已修复；三档彩色/无色、滚动、ASCII 与固定外框通过。 |
| V-03：执行、Recovery、Finalizer 的区域合同仍是旧分层 | 六份 delta 与主规格、proposal/design/IP、IC-12 同步：Sidebar 概要与版本定位编号，Inspector 节点详情，项目工作详情中的 Recovery/Finalizer。完整身份、验证/集成、Segment/Capsule/预算及 Delivery Verdict 语义保持。架构预览说明区分拒绝写入与隔离内存模拟。 | 已修复；严格工件、语义/代码及 delta/main 对照通过。 |
| V-04：条件真实 PTY 读取已移除的 Sidebar 分区 | pty-execution 删除旧 sidebarCell/recoveryRows，实际进入项目工作详情、逐帧有界滚到底、读 verdictRecording、顶部重开与逐层返回；保留对账、Recovery 真实原因、Finalizer 只读/前后工作区/结论及身份断言。 | 迁移通过；[辅助固定投影 PTY](../../../artifacts/tui-prototype-alignment/repair-20261003/details-probe-result.txt) 全字段/返回通过。真实 Orca 链路仍为条件跳过。 |
| F-01：输入与渲染的宽度/末页预算不一致，Up 可能无反应 | workspaceLayout/bodyWidth 集中有效密度、风险占用和面板尺寸；projectDetailViewport 共用内宽、换行、可见 offset 与末页。按键从可见 offset 加减并钳制，resize 不累积不可见滚动。补回原固定 footer 内的位置提示。 | full/collapsed 两个回归：80 次 Down 后一次 Up 即回退，再 Down 回末页；审计复核闭合。 |
| 测试观察绕过界面 | recovery 与 execution-handoff 从 Ctrl+B 工作/预算详情实际读取，替代静态 snapshot 序列化；交接前后核对原 Work Package、attempt、worktree、baseline 与预算引用。 | 已修复；既有测试扩展通过，无新增业务调用。 |

## Requirement / Scenario / IP 核验

每行括号覆盖该 Requirement 的全部 Scenario；“通过”限于当前 UI 合同与检查，条件真实链路不在此冒充通过。

| Requirement / Scenario / IP-ID | 实现与证据 | 结果 |
| --- | --- | --- |
| 常驻 transcript/composer（窄屏可见、工具折叠、普通字符、Esc 逐层、未知命令、多行错误、粘贴仅插入）；IP-01/02/04/06 | app、Workspace、Transcript、composer-editor；workspace/input-paths/input-protection/普通 PTY | 7 场景通过，合法 overlay 返回保留。 |
| 信息分层（维护噪声、语义事件）；IP-05/07 | semantic event 窗口、ProjectPanel；workspace/event-drawer/no-side-effect | 2 场景通过，项目总览不重复执行概要，工作详情保留真实依据。 |
| 三态 Sidebar/渲染保真（宽字符 resize、折叠不自动展开、窄屏不遮挡、显式 Inspector 返回）；IP-04/08 | width/state/Workspace；width/workspace/no-side-effect/PTY | 4 场景通过，同源有效密度与滚动预算复验。 |
| continuous 当前呈现（连续呈现、无演示事实）；IP-01 | Transcript；workspace、工具展开与 P-40 画面 | 2 场景通过，无常驻模拟 thought 或虚构成功。 |
| 定稿输入/完整编辑（中文与粘贴块、三档/禁用）；IP-02/04 | Composer、内宽/native cursor、唯一 UiDraft；editor/width/input-paths/input-protection/PTY | 2 场景通过，全文与光标保持。 |
| 固定项目面板（宽屏不移动对话、窄屏返回、事件/问题权威）；IP-04/05 | ProjectPanel/state/Workspace；workspace/PTY/新三档画面 | 3 场景通过，恢复用途分组，框内滚动与位置提示可读。 |
| 上方命令候选（两步采用、回答错误不提交）；IP-06 | COMMAND_METADATA、app 原 handler；input-paths/input-protection 与 full-map | 2 场景通过，采用无业务动作，未知/粘贴/IME 不执行。 |
| 定稿弹窗（审阅取消/确认、模型能力不伪造）；IP-06 | SelectionList、各 review、ControlBar；authorization-review/execution-handoff/control/exit/session-picker/input-paths | 2 场景及三种审阅键位通过，原目标/指纹/revision 核验保留。 |
| 顶栏/单行状态（窄屏核心、缺失数据/设置）；IP-07 | TopBar/StatusLine、原 model catalog；workspace/execution-workspace/unknown-state | 2 场景通过，缺失 effort/context/custom 明示不可用。 |
| 原型一致性证据（六票对应、功能缺口登记）；IP-09 | D-01、原定稿、full-map/隔离重采集、修复目录与主会话对照 | 2 场景通过；当前结论覆盖呈现，D-10 保持未完成。 |
| 当前回答视觉（选项/自由输入、Esc 恢复、未知/新问题）；IP-03 | AnswerPanel/InteractionCard、精确问题与原提交管线；input-paths/interaction-card/session-lifecycle/input-protection/PTY | 3 场景通过，草稿/光标/绑定保留，新问题不抢焦点。 |
| 授权后工作区连续性（授权不重置、重启先对账）；IP-04/07 | 原投影与宿主接缝；execution-workspace/recovery/unknown-state | 2 场景回归通过，未新增真实 Orca 恢复证据。 |
| 执行图/Frontier（状态不重排、折叠不读详情、过滤稳定、并发 1）；IP-08 | graph-layout、既有执行投影、Sidebar/Inspector；execution-graph/frontier/no-side-effect | 4 场景通过，概要/节点字段归属与定位编号符合定稿。 |
| 只读 Inspector（候选无动作、沿依赖）；IP-08 | GraphInspector、原 reducer；graph-inspector/no-side-effect | 2 场景通过，业务 execute 为零。 |
| adaptive/准确导航（多分支、resize、未知/ASCII）；IP-08 | graph-layout/GraphInspector/app/theme；graph-inspector/execution-graph/PTY | 3 场景通过：位置稳定、多关系显式选择，仅可信 live 动画，不猜验收数量。 |
| Recovery/Segment（partial 缺口、迟到只补历史、失败 blocker）；IP-05/07/09 | ProjectPanel recoveryRows；recovery 实际详情入口、事件/零副作用断言、迁移 PTY | 3 场景通过；替代/superseded、coverage/预算/原因可读，不伪称原 provider session 连续。 |
| Finalizer（只读无法强制、工作区变化、成功证据、单包不等于交付、blocked 终态）；IP-05/07/09 | projectDetail/finalizerRows；finalizer 组件测试、迁移 PTY/固定投影探针 | 5 场景通过；前后 HEAD/index/dirty、Evidence 与被接受的 Verdict 保留，真实链路未重跑。 |

## 实际检查

| 命令 / 检查 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过，包含迁移后的条件测试代码。 |
| `pnpm lint` | 通过。 |
| `pnpm build` | 通过，只构建 Companion。 |
| `pnpm exec vitest run tests/tui --maxWorkers=8` | 27 文件、181 项通过；2 文件、2 项条件跳过。最终运行开始 10:07:45，耗时 18.24 秒；其中 13 项普通真实 PTY 通过。 |
| `pnpm exec vitest run tests/tui/input-paths.test.tsx -t '项目详情滚到底' --maxWorkers=1` | full/collapsed 两项通过；其余 20 项按过滤器未运行，不是额外通过。 |
| `openspec validate align-tui-with-approved-prototypes --strict` | 通过。 |
| `openspec validate tui/<capability> --type spec --strict`，六次 | planning-workspace、session-interactions、execution-monitoring、graph-inspection、recovery-observability、delivery-finalization 均通过；仅已有 Requirement 过长 INFO。 |
| `git diff --check` | 通过。 |
| 本地链接与资产索引 | 修复 README、design/IP 及最终报告/交接链接可解析；96+12 对 PNG/文本齐全、索引唯一、无尺寸越界；18 组审阅观察通过，六个返回光标均可见且 x=6。 |
| 固定投影 tmux 220×80 | 最新构建上通过：长 worktree/baseline/Evidence、对账 required、Recovery/Segment/Capsule/预算、Finalizer/结论尾部、顶部重开和返回；记录保存在修复目录。 |
| 冻结接缝 | application/domain/workflow/adapters/bootstrap、依赖与锁文件没有本轮改动；IC-11/13、数据库/schema、权限与结果语义保持。 |

修复画面及操作来源见 [repair README](../../../artifacts/tui-prototype-alignment/repair-20261003/README.md)。新增 108 对未覆盖定稿或原 full-map。未受修复影响的区域沿用先前核查的六票/full-map 与 277 对隔离重采集；涉及用途层级、键位和 footer 的区域均有本轮补证据。

## 限定审计

| 范围 | 结论与依据 |
| --- | --- |
| 六票来源、布局与层级 | 已亲读定稿源码/决议/画面；V-01/02 经修复画面复核，其余已有区域保持。完整功能缺口按 D-10。 |
| 固定几何与返回 | 审计发现 F-01 后复核共享 workspaceLayout/projectDetailViewport；full/collapsed 回归及三档/连续 resize/实际光标通过。 |
| 输入保护与权限身份 | IC-13 全文/CAS/submissionId/generation/精确问题接缝保留；原失败/unknown/迟到结果与精确确认回归通过。 |
| 事实、依赖与规格 | 六份 delta/main 与 IC-12 的位置、身份、阶段/liveness/Validation/Integration/Recovery/Verdict 一致。过滤保坐标、多关系重验邻接、未知不伪造进度。 |
| 零副作用与证据范围 | render/resize/remount 不写业务或输入；事件窗口有界。条件 PTY 保留原真实断言与隔离开关，迁移入口经固定投影检查，不以跳过充当通过。 |

没有待回收的必需审计。主会话额外检查 AnswerPanel/PasteViewer：它们直接按 scroll 切片，没有项目详情原来的二次 offset 钳制，不存在本次审计所述的隐藏滚动累积；未据此扩写功能。

## 后续注意事项

- 报告绑定 HEAD 加上述已检查的未提交工作区。后续材料性产品变化需要重新验证；尚未提交或归档，新增组件、规格与证据仍须在未来提交中纳入。
- 真实 Orca execution/handoff 未运行。固定投影 fixture 只证明呈现/导航，不证明 Controller 对该 fixture 的业务准入、真实 Worker 或 Provider 恢复。
- 本次没有新增真实 OS IME 预编辑/候选窗人工证据；PTY CJK/字节注入不扩大为任意输入法保证。Windows 未验证。
- D-10 的未接通能力与 #53 完整历史性能继续由后继批次负责，标准 statusline 不代表完整 custom 功能完成。
