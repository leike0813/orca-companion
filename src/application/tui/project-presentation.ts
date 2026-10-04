import { z } from 'zod';
import type { ValidatorAcceptanceSummary } from '../execution/execution-view.js';

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
  readonly activeWorkPackage: { readonly id: string; readonly title: string } | null;
  readonly context:
    | {
        readonly status: 'available';
        readonly used: number;
        readonly capacity: number;
        readonly observationId: string;
        readonly coordinatorSessionId: string;
        readonly modelConfigurationRef: string;
        readonly effectiveInputRevision: number;
      }
    | { readonly status: 'unavailable' };
  readonly acceptance: ValidatorAcceptanceSummary | null;
  readonly budgets: {
    readonly workPackages: BudgetPresentation | null;
    readonly implementationAttempts: BudgetPresentation | null;
    readonly recovery: BudgetPresentation | null;
  };
};

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
