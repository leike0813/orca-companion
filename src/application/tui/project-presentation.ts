import { z } from 'zod';
import type { ValidatorAcceptanceSummary } from '../execution/execution-view.js';
import type { ModelUsageObservation } from '../../domain/coordinator/session-state.js';

/** Trusted statusline and project-panel facts derived from current authoritative bindings. */
export type ProjectPresentation = {
  readonly identity: {
    readonly repository: string | null;
    readonly fullBranchRef: string | null;
  };
  readonly session: {
    readonly id: string;
    readonly model: string | null;
    readonly provider: string | null;
    readonly effort:
      | { readonly status: 'configured'; readonly value: string }
      | { readonly status: 'not_configured' | 'not_supported' | 'unavailable' };
  } | null;
  readonly ticket: { readonly ref: string; readonly title: string } | null;
  /** 当前世代真实占用额度的包；多包时完整列出，不取第一个冒充唯一活动包。空数组表示执行空闲。 */
  readonly activeWorkPackages: readonly { readonly id: string; readonly title: string }[];
  readonly context: ProjectContextStatus;
  readonly acceptance: ValidatorAcceptanceSummary | null;
  readonly budgets: {
    readonly workPackages: BudgetPresentation | null;
    readonly implementationAttempts: BudgetPresentation | null;
    readonly recovery: BudgetPresentation | null;
  };
};

/**
 * 上下文状态的三个互斥事实来源。
 *
 * `available` 是当前这次有效输入的精确测量；`last_request` 是最近一次**已提交请求**的真实用量，
 * 它是历史观察而不是当前输入；`unavailable` 表示两者都无法证明。缺失一律保持未知，不估算、不把
 * 累计用量或 cache 读数当作本次输入。
 */
export type ProjectContextStatus =
    | {
        readonly status: 'available';
        readonly used: number;
        readonly capacity: number;
        readonly observationId: string;
        readonly coordinatorSessionId: string;
        readonly modelConfigurationRef: string;
        readonly effectiveInputRevision: number;
      }
    | {
        readonly status: 'last_request';
        readonly inputTokens: number | null;
        readonly outputTokens: number | null;
        readonly totalTokens: number | null;
        /** 声明的模型窗口；未声明时为 `null`，界面因此不显示虚假百分比。 */
        readonly capacity: number | null;
        readonly coordinatorSessionId: string;
        readonly modelConfigurationRef: string;
        readonly stepId: string;
      }
    | { readonly status: 'unavailable' };

export type BudgetPresentation = {
  readonly status: 'available' | 'unavailable';
  readonly consumed: number | null;
  readonly limit: number | null;
  readonly subject: string | null;
  readonly approvedLimitRef: string | null;
};

export type ContextObservationBinding = {
  readonly coordinatorSessionId: string | null;
  readonly modelConfigurationRef: string | null;
  readonly effectiveInputRevision: number | null;
  /** 声明的模型窗口；`null` 表示未知，只能如实呈现已知的用量。 */
  readonly contextWindow: number | null;
};

/**
 * 一次已提交模型 step 的真实 usage 与它的可信身份；形状与存储层的 `LatestModelUsage` 一致。
 *
 * `usage` 或 `configurationRef` 缺失就是「没有取得」：它不补零，也不借当前配置的窗口来编一个数字。
 */
export type LastModelUsage = {
  readonly stepId: string;
  readonly configurationRef: string | null;
  readonly usage: ModelUsageObservation | null;
};

export type ProjectDetailQuery = {
  readonly objectKey: string;
  readonly coordinatorSessionId: string;
  readonly seenRevision: number;
  readonly after: string | null;
};

export type ProjectDetailItem = {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  /** UTF-8 byte range in the complete field value. */
  readonly offset: number;
  readonly end: number;
  readonly byteLength: number;
};

export type ProjectDetailPage = {
  readonly objectKey: string;
  readonly coordinatorSessionId: string;
  readonly revision: number;
  readonly items: readonly ProjectDetailItem[];
  readonly nextCursor: string | null;
};

export type ProjectDetailsResult =
  | { readonly kind: 'page'; readonly page: ProjectDetailPage }
  | { readonly kind: 'stale'; readonly currentRevision: number }
  | { readonly kind: 'unavailable'; readonly reason: string };

export type ProjectDetailsPort = {
  read(input: ProjectDetailQuery): Promise<ProjectDetailsResult>;
};

export const contextObservationSchema = z.strictObject({
  status: z.literal('available'),
  used: z.number().int().nonnegative().safe(),
  capacity: z.number().int().positive().safe(),
  observationId: z.string().min(1),
  coordinatorSessionId: z.string().min(1),
  modelConfigurationRef: z.string().min(1),
  effectiveInputRevision: z.number().int().nonnegative().safe(),
});

/** Accept an exact observation only while all three trusted input bindings still match. */
export function projectContextObservation(
  observation: unknown,
  binding: ContextObservationBinding,
): ProjectPresentation['context'] {
  if (binding.coordinatorSessionId === null || binding.modelConfigurationRef === null ||
    binding.effectiveInputRevision === null) return { status: 'unavailable' };
  const parsed = contextObservationSchema.safeParse(observation);
  if (!parsed.success) return { status: 'unavailable' };
  const current = parsed.data;
  if (current.coordinatorSessionId !== binding.coordinatorSessionId ||
    current.modelConfigurationRef !== binding.modelConfigurationRef ||
    current.effectiveInputRevision !== binding.effectiveInputRevision ||
    current.used > current.capacity) return { status: 'unavailable' };
  return current;
}

/**
 * 当前精确测量优先；没有时退回同一配置下最近一次已提交请求的真实用量。
 *
 * 其它配置产生的用量一律拒绝呈现：换个模型之后那份数字不再描述当前会话，用它画百分比只会把
 * 不确定说成确定。三个 token 值保持 provider 报告的原始未知，不补零、不累加历史轮次。
 */
export function projectContextStatus(
  observation: unknown,
  lastRequest: LastModelUsage | null,
  binding: ContextObservationBinding,
): ProjectContextStatus {
  const current = projectContextObservation(observation, binding);
  if (current.status === 'available') return current;
  if (binding.coordinatorSessionId === null || binding.modelConfigurationRef === null ||
    lastRequest === null || lastRequest.usage === null || lastRequest.configurationRef === null) {
    return { status: 'unavailable' };
  }
  if (lastRequest.configurationRef !== binding.modelConfigurationRef) {
    return { status: 'unavailable' };
  }
  const { inputTokens, outputTokens, totalTokens } = lastRequest.usage;
  if (inputTokens === null && outputTokens === null && totalTokens === null) return { status: 'unavailable' };
  return {
    status: 'last_request',
    inputTokens,
    outputTokens,
    totalTokens,
    capacity: binding.contextWindow,
    coordinatorSessionId: binding.coordinatorSessionId,
    modelConfigurationRef: lastRequest.configurationRef,
    stepId: lastRequest.stepId,
  };
}

export const projectDetailQuerySchema = z.strictObject({
  objectKey: z.string().min(1).max(512),
  coordinatorSessionId: z.string().min(1).max(512),
  seenRevision: z.number().int().nonnegative().safe(),
  after: z.string().max(2048).nullable(),
});

export const PROJECT_DETAILS_MAX_ITEMS = 20;
export const PROJECT_DETAILS_MAX_PAGE_BYTES = 64 * 1024;

export function unavailableBudget(): BudgetPresentation {
  return {
    status: 'unavailable',
    consumed: null,
    limit: null,
    subject: null,
    approvedLimitRef: null,
  };
}

/**
 * 恰好一个活动包时返回它，否则返回 `null`。
 *
 * 项目详情与依据入口需要唯一对象 key；多包时没有任何依据可以挑出「那个」包，因此回落为非专属 key 或
 * 提示，而不是取第一个冒充唯一活动包。
 */
export function soleActiveWorkPackage(
  presentation: ProjectPresentation | undefined,
): { readonly id: string; readonly title: string } | null {
  const active = presentation?.activeWorkPackages ?? [];
  return active.length === 1 ? active[0]! : null;
}
