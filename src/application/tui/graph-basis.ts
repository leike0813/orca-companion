import type { GraphView } from './view-model.js';
import type { SpecificationUnitLocator } from '../../domain/task-contract.js';

/** IC-11: source identities are application-owned; reading never authorizes execution. */
export type GraphVersionRef = { readonly graphId: string; readonly generation: number; readonly version: number };
export type GraphVersionSummary = GraphVersionRef & {
  readonly recordKind: 'initial' | 'accepted_revision';
  readonly parentVersion: number | null;
  readonly patchId: string | null;
  readonly mapRevision: number;
  readonly planRevision: number;
  readonly orcaRunId: string;
  readonly recordedAt: number;
  readonly generationStatus: string;
  readonly current: boolean;
};
export type BasisSourceRef =
  | { readonly kind: 'initial_plan'; readonly graph: GraphVersionRef }
  | { readonly kind: 'graph_patch'; readonly graph: GraphVersionRef }
  | { readonly kind: 'authorization'; readonly authorizationId: string; readonly authorizationVersion: number }
  | { readonly kind: 'retained_task'; readonly workPackageId: string; readonly orcaTaskId: string }
  | { readonly kind: 'specification'; readonly locator: SpecificationUnitLocator; readonly contractRevision: number; readonly path: string; readonly workPackageId: string; readonly orcaTaskId: string }
  | { readonly kind: 'tracker'; readonly issueRef: string };
export type BasisSource = {
  readonly id: string;
  readonly label: string;
  readonly ref: BasisSourceRef | null;
  readonly sourceVersion: string | null;
  readonly unavailable: string | null;
};
export type BasisReadResult<T> =
  | { readonly kind: 'read'; readonly value: T }
  | { readonly kind: 'unavailable'; readonly code: string; readonly message: string }
  | { readonly kind: 'stale'; readonly message: string };
export type BasisBodyRange = {
  readonly sourceVersion: string;
  readonly text: string;
  readonly offset: number;
  readonly end: number;
  readonly byteLength: number;
};
export type GraphBasisPort = {
  listVersions(input: { readonly coordinatorSessionId: string; readonly after: string | null }): Promise<BasisReadResult<{
    readonly items: readonly GraphVersionSummary[]; readonly nextCursor: string | null;
  }>>;
  readVersion(input: { readonly coordinatorSessionId: string; readonly graph: GraphVersionRef }): Promise<BasisReadResult<{
    readonly summary: GraphVersionSummary; readonly graph: GraphView;
    readonly retiredWorkPackageIds?: readonly string[];
  }>>;
  listSources(input: { readonly coordinatorSessionId: string; readonly graph: GraphVersionRef; readonly workPackageId: string | null; readonly after: string | null; readonly orcaTaskId?: string }): Promise<BasisReadResult<{
    readonly items: readonly BasisSource[]; readonly nextCursor: string | null;
  }>>;
  readSource(input: { readonly coordinatorSessionId: string; readonly source: BasisSourceRef; readonly sourceVersion: string | null; readonly offset: number; readonly maxBytes: number }): Promise<BasisReadResult<BasisBodyRange>>;
};
