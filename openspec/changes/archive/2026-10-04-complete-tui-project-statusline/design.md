## Context

基线 `82f6a77` 已有角色模型配置、IC-13 输入保护、固定项目面板及同源命令目录。当前 `StatusLine` 写死 effort/context 不可用，graph presentation 仍有局部状态计数，用户偏好尚无 owner。领域语言以 CONTEXT 为准，IC-11/12/13 保持边界。

## Goals / Non-Goals

完成第七批可信项目/状态栏投影、共享验收摘要、custom 与图标偏好持久化；保持三档布局、调用入口及所有输入保护。历史 GraphVersion 和依据全文由第八批实现，不引入新 Worker 角色、调度授权、provider fallback 或依赖。

## Decisions

### D-01：六票定稿直接作为参照
沿 [原型纠偏 D-01 六票表](../archive/2026-10-03-align-tui-with-approved-prototypes/design.md#d-01六张原型票直接作为设计参照)，逐票读取决议、源码和画面。主要来源为 [#48 custom-direct](https://github.com/leike0813/orca-companion/issues/48#issuecomment-5911794472)、`statusline-prototype.tsx`、`artifacts/statusline-prototype/custom-direct/`；[#51 tabs](https://github.com/leike0813/orca-companion/issues/51#issuecomment-5905223127)、`project-panel-prototype.tsx` 及 tabs 样例；[#52 final](https://github.com/leike0813/orca-companion/issues/52#issuecomment-5909125813)、dialog final 源码与样例。#40 continuous/#47 above-input/#43 adaptive 保持已批准结构，沿 #41/#42/#44/#45/#50 的导航与语义。生产不 import 原型组件。

### D-02：应用只读 presentation 与精确对象绑定
`application/tui/project-presentation.ts` 拥有 DTO，ControllerSnapshot/TuiViewModel 传递可选 `projectPresentation`；未装配时明确不可用。注册 Scope 的 canonical worktree/full branch ref 提供 repository/branch，Session immutable configuration 提供 provider/model/effort。Claim 用选中 Session 的准确 claim，Ticket summary 单独有界读取，不读取 issue 全正文；无精确 claim 不取开放票首项。当前 Work Package 用当前 Dispatch/Attempt 绑定，不取图首节点。预算按显式类别及主体关联批准 Manifest/原 attempt authorization；work-packages 是当前未 retire 数/maxActiveWorkPackages，implementation-attempts 与 recovery 分别用现有精确 budget key，缺 ledger/授权绑定不造零。

### D-03：context 精确 capability，默认不可用
已安装 Provider Adapter 可选能力测量完整有效消息（含 system/tools）及模型窗口，宿主绑定 Session/configuration/effective-input-version。测量在准备真实有效输入时发生，snapshot/render 不测量。消息/tool step/compaction/model change 后失效；迟到绑定拒绝。禁用字符/4、BaseChatModel.getNumTokens fallback、上一轮 usage 和配置读回预算作为窗口。没有能力的 integration 显示不可用；精确分支以可控 installed integration 测试，不捏造 provider 支持。

### D-04：共享 current contract settlement
从 currentContractSettlements 与当前 GraphVersion 的未 retire 节点派生 Validator 摘要，精确校验 Task/contract/graph，分子每包一次，分母完整当前图。Controller/application 为唯一 owner，statusline、Sidebar、Inspector 只消费该摘要；清除重复局部验收计数。Implementation、integration、liveness 保持独立。

### D-05：项目详情有界且批准与候选分离
新增只读 projectDetails 端口，宿主绑定 Scope，请求绑定 Session/object key/seen revision 与游标。每页最多20项、64KiB，长字段提供 UTF-8 continuation；游标不得跨对象、版本或 Session。身份/预算/批准 Manifest 精确读取，各批准引用与候选入口分开；失效、不可用、失败保留页与重读入口。Store 只增加必要精确查询/索引，可索引迁移17；不复制整份权威记录。项目页保留 >=100 原 sidebar 固定框、窄屏主区域和原栏目/滚动返回。

### D-06：用户偏好 schema 与分区 CAS
`application/configuration/tui-preferences.ts` 拥有 schema/port；storage adapter 默认路径 `${XDG_CONFIG_HOME || homedir/.config}/orca-companion/tui-preferences.json`，Bootstrap 装配，不进入业务 store/IC-13。schema1：revision、iconMode，statusline 包含 modelFormat(model/provider-model)、contextFormat(used/remaining/tokens)、progressFormat(count/percent)、budgetKey(work-packages/implementation-attempts/recovery)、有序唯一 fields(graph/ticket/work-package/progress/budget)。默认 nerd/model/used/count/work-packages/graph。load 缺失返回默认可写；损坏/未来版本/不可读返回默认不可写并保留文件。save 只接受 icons 或 statusline 单区 patch、expectedRevision，短文件锁内重读/CAS，临时同目录文件原子 rename/回读；返回 saved/conflict/failed 安全结果，未知阶段按原候选回读，无自动换意图覆盖。临时启动图标 env override 不被 statusline save 持久化。

### D-07：custom 草稿与图标未保存状态
复用 commands/state/app 输入优先级。Options→Statusline 编辑只在内存；同一 production StatusLine 产生 preview，核心常驻且普通尾项按序整体省略、provider 先缩短、Ticket 号保留。↑↓选择、Space勾选、←→排序/格式、Enter任意行明确保存，末行Space恢复默认仅改草稿；Esc丢弃一层。成功关闭设置和命令层返回原 Session/composer/anchor/project context。CAS 冲突更新保存基准并保留用户草稿，第二次显式保存；失败留页可重试。保存请求绑定原编辑 generation，迟到回调不覆盖新页或新编辑。图标即时生效，独立 icons patch 保存，失败继续本次选择并有未保存/重试提示，重启恢复最后保存值。

### D-08：文档与证据分别记录
更新 IC-11/12 与新增 UI preferences 合同、architecture、AGENTS 和开发文档的当前状态，纠正 6B 归档漂移。采集生产 App 三档×彩色/NO_COLOR×Nerd/ASCII，覆盖五状态、设置/取消/保存失败/CAS/返回、项目详情及连续 resize；独立目录保留PNG/text与操作。相关行为测试、真实 PTY、typecheck/lint/test/build 和严格 OpenSpec 校验。只读画面不充当真实 provider capability 或 IME 人工证据；不提交、归档或提前创建 verification。

## Risks / Trade-offs
无精确 tokenizer 的 provider context 会继续不可用，这是可信边界。用户配置跨宿主 CAS 要保留两份编辑，失败不能静默覆盖。巨型 Manifest 即使存储记录原本完整，也必须限制 UI 每次返回与绘制；不以全记录遍历生成无限列表。窄屏设置不应侵占额外输入行，沿定稿框预算验收。

## Migration Plan
直接前驱已归档，主规格和冻结模型/命令/输入接缝核验后 apply；用户偏好缺失无需写迁移文件，原业务 schema 仅在精确查询需要时增加索引，不重置预算。实现未提交，verification 由后续独立验收在固定实现状态创建。

## Open Questions
无阻塞问题。
