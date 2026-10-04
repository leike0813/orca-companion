## Context

前驱已归档，当前 store schema16。graph_versions 保存拓扑与 patch_json，却没有原始计划；snapshot 会读整条版本链。现有 ProjectDetailsPort 以 Scope revision 绑定当前详情，不适合不可变历史和文件版本。参考根 CONTEXT、IC-03/05/06/11/12 与原型归档 D-01 六票链接。

## Goals / Non-Goals

目标为当前 Scope 全代际历史及可证明的完整依据、有界生产阅读和全链路验收。保持定稿 adaptive、三栏目和返回。不开新执行模式、不重新设计、不复制 Orca 正文、不重建不存在的历史、不提交归档。

## Decisions

### D-01 原型和入口

沿用六票源码/画面及 #44/#46 定稿。Inspector Enter 完整详情 → 依据目录/历史版本 → 正文/选版 Inspector；项目工作详情连接同一入口。上下选择/阅读，Tab 三栏目，Enter 下钻，PgUp/PgDn 翻页，Esc 逐层返回。历史选择与当前选择分开；身份绑定 graphId/generation/version/workPackageId，代际标签取真实状态，不把同代际旧版本标成冻结。退役依据须有 accepted patch 证明。无需新键位或第四栏目。

### D-02 唯一读取 seam

Application 的 graph-basis.ts 定义窄 GraphBasisPort：listVersions、readVersion、listSources、readSource。版本目录20项 keyset，正文64KiB UTF-8范围，结果使用明确 available/unavailable/stale。可信 Scope 在Bootstrap闭包注入，Session须注册；来源引用为受控判别联合，正文sourceVersion为不透明版本令牌，不能用Scope revision替代。沿用现有ProjectDetailsPort处理当前身份/预算，不把文件伪装成Coordinator transcript。

### D-03 图与计划权威

schema17仅追加 nullable initial_plan_json，initial新写必须带解析后的ImplementationPlan并与planRevision一致，和v1同事务；accepted_revision不写原计划。旧行NULL保持。graph-version-index返回metadata，graph-head精确查head，graph-version-membership只返回请求版本的追加链成员事实；范围字段从指定row读取，不全量组装后切片。graph-basis-bindings按包20项分页，graph-basis-binding按包/Task精确读取；graph-basis-authorizations按图/代际列20项授权引用，与所选版本运行状态分开。snapshot仅当前图，原授权链判定仍核验parent关系，生命周期结算规则不变。

### D-04 依据与执行记录

依据来源包含v1原计划、精确patch、指定id/version批准Manifest、原绑定OpenSpec和tracker引用。原计划按原结构阅读，不合成Markdown。保留执行记录是WorkPackage级历史，不是所选图版本事实；仅显示可证明的Task/Dispatch/Attempt/原授权/规格身份，缺绑定明确缺失，不按时间归属。历史图不接收当前frontier/workers/budget/acceptance。当前statusline/sidebar仍共用原Validator摘要。

### D-05 外部正文

SpecificationProvider扩展只读有界文件目录与范围方法：精确worktree/native unit，活动/归档路径按既有locator，无歧义且realpath在unit/worktree内。使用既有contractRevision校验；tracking单独显示。显式打开可流式计算既有digest，不每次滚动读/encode全文；检测变化返回stale。Tracker新增带updatedAt正文观察，沿既有1MiB transport限额，范围切片与缓存有限；批准时正文无历史源只显示缺失，当前正文独立标注。正文/布局各8MiB/64项，失效/容量淘汰不持久写正文副本。

### D-06 验收与模型

扩展已有行为测试；原型按六票逐项对照而非snapshot断言。验收模型以用户当前授权为准；2026-10-04 后续新现场使用 `minimax-cn/MiniMax-M3.1-Flash-Preview`，已启动的 `gpt-6-luna` 现场及历史证据保持原绑定。验收配置从已验证连接读取，模型声明须与完整 Coordinator/Worker Profiles 配置一致，不能继承默认。执行/patch/retire、重启/恢复及Replanning Cutover验证真实历史可读。输入和缓存导航每档100采样、p95≤100ms；冷读/扫描/RSS另列。所有tasks完成且实现固定后才创建独立verification。

## Risks / Trade-offs

历史内容未被权威来源保留时只能报告缺失。当前规格文件可变，读取不能假称旧快照；cache不成为权威。外部tracker受原transport限额约束，超限明确拒绝。真实provider费用与运行时间由已确认隔离验收授权覆盖，异常按原身份对账，不绕过。

## Migration Plan

SQLite已有迁移事务升至17，旧initial_plan_json保持NULL；不修改checkpoint/UI schema、Task绑定或已消耗预算。实施前复核前驱和dirty；更新当前文档漂移，历史报告不改写。

## Open Questions

无阻塞问题。
