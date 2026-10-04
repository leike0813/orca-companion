# Verification

## 验收对象

- Change：`complete-tui-command-reviews`，#46 第六批 6A。
- 输入实现 HEAD：`abf8f0c0617972f8277598dfe04257769ba86179` 上的固定工作区实现。
- 最终验收 HEAD：同上；用户未授权提交，产品代码保持未提交状态。限定审计收到包含19个源文件的最终工作区 diff，修复后再次复核。
- 验收 Agent：主代理执行 `openspec-verify-change`，负责规约、测试和原型对照；原生 `gpt-6-luna` 子代理 Jason 只读限定审计，ID `01a10298-f5a8-7e82-bb8b-044a305ce9fc`，已完成并关闭。
- 日期/环境：2026-10-04，Ubuntu、Node.js 24、pnpm 11.10.0。

## 结论

**PASS**，限批准的6A范围：现有命令同源搜索、调用结果/返回保护、精确授权/交接审阅及现有模型目录的明确 Session 绑定。
直接前驱已归档、主规格存在，IC-11/12/13接缝核验成立。任务9/9、Requirement 4/4、Scenario 9/9、IP-01–05均有实现和证据；没有未决限定审计或范围内缺陷。

| 维度 | 结果 |
| --- | --- |
| 完整性 | 9/9任务；4/4 requirement；文档与108对生产画面齐备 |
| 正确性 | 9/9 scenario；精确身份/版本、失败保稿、完整流程防连按与只读核验通过 |
| 一致性 | D-01–06及既有模块方向遵循；权威记录、草稿和reader owner保持；6B能力未混入 |

## 核验与修复证据

| Requirement / Scenario / IP-ID | 实现与证据 | 结果 |
| --- | --- | --- |
| 可搜索同源命令目录 / 搜索子项与取消 / IP-01、04、05 | `commands.ts`、command-palette/keymap、App查询；`command-reviews.test.tsx`的中文/别名/路径、空结果、独立查询用例；`input-paths.test.tsx`与真实PTY保留全文/粘贴块/光标 | 通过；查询≤256 code points，列表有界 |
| 同一 requirement / 相同操作的不同入口 / IP-01、02 | Palette/slash/help/固定键位共用目录和 `runCommand`；现有control、host-wiring、authorization及PTY入口复验 | 通过；候选采用和查询不执行业务动作 |
| 命令结果与页面返回绑定 / 拒绝与等待中编辑 / IP-02、05 | `command-invocations.ts`、App slash target/generation、session-lifecycle/input-paths/unknown-state；拒绝/unknown、迟到编辑、读取失败与核验回归 | 通过；accepted不等于业务完成；刷新失败保留accepted/refreshFailed与原输入 |
| 同一 requirement / 多级搜索返回 / IP-02、04 | `state.ts`独立query/selection及confirmationFrames；options、模型迟到查询、输入与原reader返回；capture的目录→子页→目录→首中尾 | 通过；无自动会话切换或发送 |
| 精确选择与语义审阅 / 多条交接记录 / IP-03、04 | prepare结果引用、`handoff.read(id)`、execution对应端口；多提案与read悬挂/失败回归，planning-handoff bootstrap | 通过；单次prepare、精确ID，读取/审阅就绪前guard不释放 |
| 同一 requirement / 审阅期间内容变更 / IP-03、04 | fingerprint/Scope revision、record revision回传；宿主await后版本重验及own-review revision；authorization/handoff/stale用例 | 通过；不自动替换批准对象，默认返回 |
| 同一 requirement / 非责任 Session 的模型目录 / IP-03 | `ModelCatalogPort.load(SessionId)`、宿主显式membership/配置读取、model-picker；foreground-planning-runtime及迟到查询用例 | 通过；首次已核验模型用于绑定，避免写入后再次provider组装造成错误拒绝 |
| 命令连按与待核验恢复 / 连按与未知响应 / IP-02、03 | 单目标32项有界guard、write-produced resultRef/schema/Scope核验；unknown不重发、query rejected不解锁、无引用保持未知；accepted读取失败回归及宿主精确结果查询 | 通过；不增加持久命令账本或伪造OperationId |
| 同一 requirement / 审阅键位不穿透 / IP-02、04 | pending确认优先、review拦截；嵌套确认恢复栏目/滚动/动作；control/PTY、12组采集的Ctrl+P/B/G与Ctrl+C | 通过；退出只沿原前台退出流程 |
| 原型呈现与交接 / IP-04、05 | [108对生产画面/定稿对照](../../../artifacts/command-reviews/README.md)，120×40/80×24/50×40、彩色/NO_COLOR、Nerd/ASCII、独立查询/栏目/默认返回/resize；文本边界检查无超宽或超高 | 通过，限本次既有命令及审阅；预览全部使用隔离fixture端口 |

可运行命令与数值见 [implementation-plan 第9节](implementation-plan.md#9-验收记录2026-10-04)：最终typecheck/lint/build、strict OpenSpec与diff通过。
全量152文件1527项通过、6文件12项条件跳过；审计修复后9文件100项、命令回归16项和PTY/宿主/重绘3文件22项复验通过。
合并未改动的全量与修复后结果，最终覆盖152文件1530项通过、6文件12项条件跳过；没有把重复复验或构建失败时跳过的PTY算作通过。

验收阶段修复：

- planning review在异步事实读取后重验用户所见record revision，cutover沿用本次own-review revision。
- prepare→精确read/review→open整体进入guard；连按在递增页面generation之前被拦截，读取失败保留原ref。
- action→reload整体受保护；已受理后的刷新失败保持UI `refreshFailed`，slash不清稿，核验只重读状态。
- 搜索键入与粘贴共用选择/查询更新；模型与Session列表和提交共用对象定义，保留原查询光标。
- 页签增加文字状态，长内容保留位置提示及分隔线；50列审阅完整显示Enter/Esc。
- 真实PTY等待菜单与查询实际可见再Enter；测试fixture使用SnapshotLoad合同的`failed`判别值。最终完整PTY重新执行通过。

## 限定审计

范围：target/version、slash清稿、unknown/accepted刷新失败防重发、prepare精确读取生命周期、页面generation、Scope确认拦截、render/effect/resize无业务副作用、Application→TUI依赖方向。

Jason先报告F1“prepare guard提前释放”和F2“刷新失败仍清slash”；主代理修复并新增悬挂read、刷新不可用/异常两类稳定行为用例。
最终只读复核明确“F1、F2均已闭合，本轮限定复核无新增阻塞”，确认4 Requirement、9 Scenario、IP-01–05覆盖。
审计不运行测试、不修改文件；测试、真实PTY、画面证据由主代理完成。CRITICAL、WARNING、SUGGESTION均无未决项。

## 后续注意事项

- 6B继续provider/model/effort、Worker Profiles与Manifest模型绑定及真实启动；第七/八批用户展示配置、可信metadata/验收摘要和历史图仍未实施。
- 无引用异常、已被后续写入覆盖的Scope/模型事实仍不可核验；进程内guard不提供持久请求身份，重启不自动补发。
- 本次未启用隔离真实Orca/provider条件测试；PNG不能证明真实provider可启动，条件跳过不算通过。
- 平台证据限Ubuntu。中文/emoji字节输入不是OS IME预编辑/候选窗人工证据，Windows未验证。
- IC-13输入、IC-11/12有界历史与双缓存接缝保留；本次没有重新测量历史p95。
- change未提交、未同步主规格、未归档；本报告不授权后续Git操作。
