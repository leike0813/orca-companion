/**
 * 前台 TUI 当前无法完成的能力及其权威缺口（Owner: `m2-deliver-planning-tui`）。
 *
 * 这些字符串同时用于：装配层的结构化拒绝文案、向导核验项的 detail、以及交付报告里的缺口清单。
 * 只有一处事实源，避免「界面说缺 A、装配层说缺 B」。
 */

export const ANCHORED_CAPABILITY_GAPS = {
  session_message:
    'M1 没有「用户消息进入 Coordinator 模型循环」的用例，也没有前台 Runtime Incarnation 装配：Actionable Work 只来自 store 事实',
  interaction_answer:
    '回答 Pending Interaction 需要合法的 CoordinationWriter（前台 Runtime Incarnation 的 lease/fencing），当前装配不谎称持有它',
  compaction:
    'M1 没有面向 Session 的压缩请求用例：`CompactionOutcome` 只在模型输入组装时产生，未持久化也未投影进快照',
  model_configuration:
    'M1 没有项目级 Coordinator Model Configuration 来源（provider 集成由用户注入），因此没有可核验或可切换的配置',
  planning_handoff:
    'Handoff prepare 需要宿主读好 map/plan revision、Target 与可移植 Capsule 引用；Capsule 生成属于未接线的 Runtime 装配',
  scope_initialization:
    '创建 Scope 需要合法的 CoordinationWriter；由界面进程谎称持有 Runtime Lease 会把真正的运行时 fence 掉',
  tracker: 'tracker 核验需要项目级配置来源，M1 未提供；界面不猜测 tracker',
  event_ownership:
    'M1 没有任何 ControllerNotification 发布者（事件源未装配），且 SemanticEvent 各变体不含 Session 归属：逐 Session 未读标记在运行态不可观察',
  scope_control:
    'Scope 级 Pause/Resume/Cancel 需要前台对账 runner 与 Worker 停止端口（Orca 后端与身份配置），当前装配未接线',
} as const;

export type AnchoredCapabilityGap = keyof typeof ANCHORED_CAPABILITY_GAPS;
