## Context

直接前驱 `link-tui-pending-interactions` 已归档，基线 `abf8f0c`。MOD-06 消费 IC-11/12 和 IC-13；业务准入、事务、Operation Intent 与模型维护由原 Application/Bootstrap 用例拥有。用户确认第六批拆分，当前只交付 6A。

## Goals / Non-Goals

**Goals:** 同源可搜索目录、可核验异步结果、精确审阅、逐层返回，全部接入生产 App 和宿主。

**Non-Goals:** provider/effort/角色配置、Manifest 的模型绑定扩展、用户级显示偏好、statusline custom、图历史、依赖/平台升级与 Git 提交。

## Decisions

### D-01：沿用六票与命令定稿

来源为 [#46](https://github.com/leike0813/orca-companion/issues/46#issuecomment-5946016892)、[#45](https://github.com/leike0813/orca-companion/issues/45#issuecomment-5936017992)、[#52](https://github.com/leike0813/orca-companion/issues/52#issuecomment-5909125813)。六票源码/画面入口沿用前驱纠偏 design D-01 和 `docs/dev/tui-implementation-handoff.md`；本次直接对照 `artifacts/dialog-prototype/final/` 命令、会话、授权、交接及 Cancel 三档画面和 `source.tar.gz`。只复用呈现，不复制原型 fixture 或副作用。

### D-02：目录与输入归属

将静态命令/别名/键位/路径放在 TUI 单一目录 module，Palette/slash/help 共用。Catalog 不取代业务准入；handler 调用原用例，UI 可从可信快照和原准入投影呈现原因。目录与子页查询上限 256 code points，字面忽略大小写，渲染有限列表；选择按对象 ID，刷新消失时提示变化，不换成另一目标。模型页先保留当前 Coordinator 配置选择，provider/effort/Worker 配置显式归 6B；未接通 statusline 设置仍显示原因。

### D-03：调用结果与原输入

UI handler 返回 opened 或 Controller 三值结果；slash 只在 opened/accepted 后按原 target/generation 清稿。同步捕获调用目标与页面 generation，单目标在途调用拒绝重复；reject/unknown/throw 不清稿。已受理但展示刷新失败以 UI `refreshFailed` 保留受理事实及输入；guard 覆盖 action、精确读取与刷新，核验只重读而不重发。未知外部结果只读原引用核验，不重派；无可证明结果则保持 unknown。身份/引用由宿主产生，UI 不拼 OperationId。

### D-04：页面栈与精确选择

页面保存独立 query/selection；审阅保存 tab/scroll/action，确认栈保存调用页状态。异步调用绑定 Scope/Session/问题及页面 generation；正文仍在 IC-13，锚点仍属原 reader。Esc 恢复父 frame，不将父查询塞进 composer。选 Session 才切换；成功 cutover 保留当前选中 Session，由用户选择 Target；迟到结果仅更新原对象的反馈，不切 Session、不抢焦点。现有 `ModelCatalogPort.load` 必填 Session ID，宿主校验 membership 后读取该 Session。

### D-05：语义审阅与可信引用

Application 拥有 ReviewSection/字段投影，Bootstrap 从实际 Manifest/交接记录生成固定语义栏目。授权保留 fingerprint 和 Scope revision；交接 prepare 返回精确 ID，查询按 ID，cutover/cancel 核验用户所见 record revision。按原版本确认，不解析展示文案、不取首个待审阅记录。默认返回，Tab 切栏目、方向键滚动/动作，unknown 不隐藏为成功。

### D-06：有界状态恢复

扩展 IC-11 的窄结果引用/状态查询，Scope 绑定和运行时 schema 校验由宿主执行。数据源为已有交接、授权、Session 配置和 Scope 控制记录；不建新持久命令账本。重启沿原权威记录读现状，不自动提交。进程内 guard 保存在途、unknown 和已受理但刷新失败的结果，不充当可恢复账本；无引用异常和已被覆盖的控制/配置事实保持不可核验。仅对能证明的结论返回 accepted/rejected，其余 unknown。Cancel 被受理仍可能处于 cancelling/unverifiable。

## Risks / Trade-offs

页面栈调整可能影响原生光标和回答返回，沿用输入/reader ownership 并加迟到结果与 resize 验证。审阅字段只显示当前真实值，不能宣称第六批模型合同已完成。实时变更使旧审阅失效，要求重新读取，避免自动替换批准对象。

## Migration Plan

无历史格式迁移或依赖变更。按目录、调用/返回、生产接口/审阅、验收顺序串行落地；同步文档的第五批状态与 6A/6B 边界。保持原权威记录和数据库 ownership。

## Open Questions

无阻塞问题。
