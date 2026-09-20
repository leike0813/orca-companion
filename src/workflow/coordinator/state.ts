/**
 * MOD-03：Coordinator graph 的共享状态、上下文片段与调用默认值
 * （Owner: `m1-run-coordinator-sessions`）。
 *
 * 这个文件只承载图与上下文维护共用的**类型与常量**，不放业务规则：准入、状态转换、预算与
 * 副作用策略留在 `src/application/` 与 `src/domain/`（D4）。把共享类型放在这里而不是埋在某个
 * 实现文件里，是为了让 `compaction.ts` 与 `context.ts` 之间保持单向依赖，不出现循环 import。
 *
 * 图通道只保存「本次 invoke 需要的最小运行状态」：会话记录本身由 checkpoint store 唯一拥有，
 * 节点通过 seam 读写它，而不是把它复制进图通道形成第二份真值。
 */

import { Annotation } from '@langchain/langgraph';

import type { ProjectedActionableWorkItem } from '../../application/coordinator/actionable-work.js';
import type { NativeWindowItemRef } from '../../domain/coordinator/session-state.js';

/**
 * D1：图状态在每个 super-step 边界同步提交。
 *
 * `durability` 是 invoke 选项而不是 store 属性，所以常量声明在 workflow 侧。
 */
export const COORDINATOR_DURABILITY = 'sync' as const;

/**
 * `recursionLimit` 只作高位技术保险，不承担业务预算（D15）。
 *
 * 值刻意远高于任何真实会话长度：达到它意味着循环失控，而不是预算耗尽。
 */
export const COORDINATOR_RECURSION_LIMIT = 1_000;

/** invoke 的默认选项：同步耐久度 + 高位技术保险。 */
export const COORDINATOR_INVOKE_DEFAULTS = {
  durability: COORDINATOR_DURABILITY,
  recursionLimit: COORDINATOR_RECURSION_LIMIT,
} as const;

/**
 * 一次模型输入里的历史片段。
 *
 * `messages` 按已提交 step 分组而不是摊平，因为机械 Shake 的占位符必须能指回原始 step，
 * 而 Capsule 必须能声明它取代了哪一段 step。
 */
export type HistorySegment =
  | { readonly kind: 'messages'; readonly stepId: string; readonly messages: readonly unknown[] }
  | {
      readonly kind: 'capsule';
      readonly capsuleId: string;
      readonly text: string;
      readonly replacedFromStepId: string;
      readonly replacedToStepId: string;
    }
  | {
      readonly kind: 'native-window';
      readonly ownerRef: string;
      readonly items: readonly NativeWindowItemRef[];
    };

/** 压缩路径的封闭取值；`none` 表示本次没有压缩。 */
export const COMPACTION_PATHS = ['none', 'provider_native', 'context_capsule', 'mechanical_shake'] as const;

export type CompactionPath = (typeof COMPACTION_PATHS)[number];

/**
 * 一次 Capsule 派生的结果：新的 Capsule 片段，以及它取代了多少个前导 `messages` 片段。
 *
 * 边界由派生方决定（它才知道哪一段可以安全取代），替换动作由 compaction 执行。
 */
export type CapsuleDerivation = {
  readonly segment: Extract<HistorySegment, { kind: 'capsule' }>;
  readonly replacedCount: number;
};

/**
 * 压缩结果（D9）。
 *
 * `compaction_degraded` 与 `context_exhausted` 都是显式终态：前者表示某条路径可用但没有取得
 * 新进展，后者表示所有路径都已尝试而输入仍然超预算。两者都不得被读成「已完成压缩」。
 */
export type CompactionOutcome =
  | { readonly kind: 'not_needed'; readonly path: 'none'; readonly note: string }
  | {
      readonly kind: 'compacted';
      readonly path: Exclude<CompactionPath, 'none'>;
      readonly compactedTokens: number;
      readonly note: string;
    }
  | { readonly kind: 'compaction_degraded'; readonly path: CompactionPath; readonly reason: string }
  | { readonly kind: 'context_exhausted'; readonly reason: string; readonly stillOverBudget: number };

/** provider-native 压缩的可用性。 */
export type NativeCompactionAvailability =
  | { readonly kind: 'available'; readonly compact: () => NativeWindowCarry }
  | { readonly kind: 'unavailable'; readonly reason: string };

/** provider 原生压缩的产物：不透明项、owner 身份与压缩后的输入规模。 */
export type NativeWindowCarry = {
  readonly ownerRef: string;
  readonly items: readonly NativeWindowItemRef[];
  readonly compactedTokens: number;
};

/** 图通道：本次 invoke 的最小运行状态。 */
export const COORDINATOR_GRAPH_CHANNELS = Annotation.Root({
  coordinatorSessionId: Annotation<string>({
    reducer: (_left: string, right: string) => right,
    default: () => '',
  }),
  graphPosition: Annotation<string>({
    reducer: (_left: string, right: string) => right,
    default: () => 'start',
  }),
  status: Annotation<CoordinatorGraphStatus>({
    reducer: (_left: CoordinatorGraphStatus, right: CoordinatorGraphStatus) => right,
    default: () => 'running',
  }),
  /** 本次 invoke 尚未消费的有界 Actionable Work。 */
  remainingWork: Annotation<readonly ProjectedActionableWorkItem[]>({
    reducer: (_left: readonly ProjectedActionableWorkItem[], right: readonly ProjectedActionableWorkItem[]) => right,
    default: () => [],
  }),
  deferredWork: Annotation<number>({
    reducer: (_left: number, right: number) => right,
    default: () => 0,
  }),
  note: Annotation<string>({
    reducer: (_left: string, right: string) => right,
    default: () => '',
  }),
});

/**
 * 本次 invoke 的结局。
 *
 * `suspended` 是可恢复条件；`stalled` 是 Loop Stall（模型调用未完整提交，历史停在最后一个
 * Committed Model Step）；`blocked` 是 fail closed，需要人工处理。
 */
export const COORDINATOR_GRAPH_STATUSES = ['running', 'suspended', 'stalled', 'blocked'] as const;

export type CoordinatorGraphStatus = (typeof COORDINATOR_GRAPH_STATUSES)[number];

export type CoordinatorGraphState = typeof COORDINATOR_GRAPH_CHANNELS.State;

export type CoordinatorGraphUpdate = typeof COORDINATOR_GRAPH_CHANNELS.Update;
