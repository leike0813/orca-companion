## Context

现有 WorkerHarness 全能力必填，Delivery 通过 SessionSegment 定位真实 Dispatch，Manifest v4 必配 Recovery Utility。用户已确认允许基础 Orca 绑定、统一递进等级、最低真实闭环及显式恢复关闭。当前工作区候选验收改动保留。

## Goals / Non-Goals

Goals: 基础级可贯通规划/实现及重启结算；高等级操作由同一等级规则准入。
Non-Goals: 任意插件发现、模型路由、自动降级重派、修改 Orca、依赖变更。

## Decisions

- D1：纯 domain 规则拥有证据与等级，证据必须有来源。资格摘要来自显式验收；历史版本不作为硬门禁，当前接口/安全能力在操作前复核。
- D2：新增 WorkerExecutionBinding 的 orca_worker/native_session 联合。基础绑定只用于 Planner/Implementation，真实 Task/Dispatch/terminal 来自公开 exact Worker 回读；原 SessionBinding 保持精确语义。Branch Store schema 21 追加基础派发表，同一 Delivery 使用统一归属投影。
- D3：Manifest v5 profiles 增加 supportLevel/qualificationRef，RecoveryUtility 可 null。v4 解析保持原结构，指纹不加默认字段；新批准必须显式资格绑定。项目 schema 5 不变，允许取消 recovery_utility 的当前引用。
- D4：WorkerHarness 用可选能力组，调用统一 helpers 返回能力不足；现有 adapter 内部实现复用。登记所有已有 adapter，生产选择仅开放达到对应等级的项。
- D5：未验证或能力失败不阻塞整个 harness 的基础角色。完整级不足的源任务需要历史恢复时阻塞。原生 Session 操作仍逐次证明身份；只读防护仍实际核验。
- D6：验收 collector 保留失败阶段的真实 Orca 身份，分别生成能力事实及目标等级结果。模型响应 ID 与 usage 不参与等级，mixed Controller 只影响完整级。
- D7：read_only 从 enhanced 的条件移除，不影响 basic/enhanced/complete 推导；Recovery Utility 与只读 Graph Patch/规划辅助操作在各自派发前核验 readOnly 能力组及实际探针。普通 Validator/Finalizer 不作只读探测。
- D8：新审阅的 v5 Manifest 显式增加 finalizerPolicy（repairLimit，取现有 validatorRepairs 额度；权限模式为 repair）。旧 v4/v5 缺该字段时仍是只读 Finalizer，不从当前配置补写权限。Finalizer 使用新的独立项目级 worktree，修复范围为获批 Work Package Scope Envelope 的并集，依赖/设计越界仍须上报。
- D9：schema 22 保存 Finalizer 的固定授权、基线、Graph 与原 Task 准入身份，准入与项目级 Finalizer 预算原子扣减，重放不重扣。可写任务要求干净基线、普通提交后的干净 HEAD 及真实复验命令；Git 读回核验 HEAD/祖先关系/实际路径。ignored/临时测试工件不纳入源码集成。精确原生 Session、原 Task 与原 worktree 恢复，不换 ID 重派。
- D10：Finalizer Report 与 Delivery Verdict 绑定 verifiedHead/verifiedTree，修复的实际结果成为独立证据；Worker 普通提交并复验后，宿主按原授权复用 Git intent 的 integrate/push，canonical 与最终验证版本一致后接受。宿主不再提交以免改变已复验版本，不伪造 Validator 或 Work Package 的通过记录。

## Risks / Trade-offs

基础任务中断不能历史恢复；真实 input_accepted 不能证明执行，最低证据需任务结果与产出。严格保留 unknown 原 OperationId，不用缺报告推出未执行。

## Migration Plan

追加 schema 21 不改旧 SessionSegment；v4 授权保持原生路径，不自动扩大权限。新配置不改 schema，旧 profile 数据不添加伪造资格。新资格来自版本化发布摘要或显式验收，历史事实保留。

## Open Questions

无。
