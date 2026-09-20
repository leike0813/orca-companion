/**
 * MOD-01：Coordination Scope 的模式与控制状态。
 *
 * 模式只有两个显式取值，控制状态与模式正交：暂停、阻塞、取消与 Replanning Transition 都不改变
 * 当前模式，也不构成第三种模式。这里只有封闭取值与判定函数，不读取时钟、不接触存储，也不定义
 * 状态转换顺序——转换由 Controller 用例按授权与预算决定。
 */

export const COORDINATION_MODES = ['route_planning', 'execution_coordination'] as const;

export type CoordinationMode = (typeof COORDINATION_MODES)[number];

export const CONTROL_STATES = [
  'active',
  'paused',
  'blocked',
  'cancelling',
  'cancelled',
  'unverifiable',
  'replanning_transition',
] as const;

export type ControlState = (typeof CONTROL_STATES)[number];

export function isCoordinationMode(raw: unknown): raw is CoordinationMode {
  return typeof raw === 'string' && (COORDINATION_MODES as readonly string[]).includes(raw);
}

export function isControlState(raw: unknown): raw is ControlState {
  return typeof raw === 'string' && (CONTROL_STATES as readonly string[]).includes(raw);
}
