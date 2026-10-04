import { z } from 'zod';
import type { CoordinationScopeId, CoordinatorSessionId, GraphGeneration, GraphId, GraphVersion, WorkPackageId } from '../dto/identity.js';
import type { BranchCoordinationStore, GraphAuthorizationCursor, GraphBasisBindingCursor, GraphVersionMetadata, MaterializationBindingRecord } from '../ports/branch-coordination-store.js';
import type { SpecificationProvider } from '../ports/specification-provider.js';
import type { IssueTrackerGateway } from '../planning/route-map-service.js';
import type { BasisReadResult, BasisSource, BasisSourceRef, GraphBasisPort, GraphVersionRef, GraphVersionSummary } from './graph-basis.js';
import { workPackageShortKey, type GraphView } from './view-model.js';

const id = z.string().min(1).max(4096);
const revision = z.number().int().nonnegative().safe();
const graphSchema = z.strictObject({ graphId: id, generation: revision, version: revision });
const sourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('initial_plan'), graph: graphSchema }),
  z.strictObject({ kind: z.literal('graph_patch'), graph: graphSchema }),
  z.strictObject({ kind: z.literal('authorization'), authorizationId: id, authorizationVersion: revision }),
  z.strictObject({ kind: z.literal('retained_task'), workPackageId: id, orcaTaskId: id }),
  z.strictObject({ kind: z.literal('tracker'), issueRef: id }),
  z.strictObject({ kind: z.literal('specification'), locator: z.strictObject({ worktreeId: id, relativePath: id }),
    contractRevision: revision, path: id, workPackageId: id, orcaTaskId: id }),
]);
const indexCursor = z.strictObject({ coordinatorSessionId: id, generation: revision, graphId: id, version: revision });
const sourcesCursor = z.strictObject({
  coordinatorSessionId: id, graph: graphSchema, workPackageId: id.nullable(),
  after: z.strictObject({ createdAt: revision, orcaTaskId: id }).nullable(), index: revision,
  phase: z.enum(['authorization', 'bindings']),
  authorizationAfter: z.strictObject({ authorizationId: id, authorizationVersion: revision }).nullable(),
});
const filesCursor = z.strictObject({ coordinatorSessionId: id, graph: graphSchema, workPackageId: id, orcaTaskId: id, after: id });
const unavailable = (code: string, message: string): { kind: 'unavailable'; code: string; message: string } => ({ kind: 'unavailable', code, message });
const sameGraph = (a: GraphVersionRef, b: GraphVersionRef): boolean => a.graphId === b.graphId && a.generation === b.generation && a.version === b.version;
const summary = (value: GraphVersionMetadata): GraphVersionSummary => ({ ...value, generationStatus: value.generationStatus ?? 'not_recorded' });
const token = (ref: BasisSourceRef): string => JSON.stringify(ref);

/** Application owns identities; injected adapters resolve only already-bound sources. */
export function createGraphBasisService(input: {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly tracker: IssueTrackerGateway | null;
  readonly routeMapIssueRef: string | null;
  readonly specification: (binding: MaterializationBindingRecord) => Promise<SpecificationProvider | null>;
}): GraphBasisPort {
  const scopeId = input.coordinationScopeId;
  // Tracker transport is bounded by the adapter; continuation uses the exact observed body.
  const trackerBodies = new Map<string, { version: string; bytes: Buffer }>();
  let trackerBytes = 0;
  const rememberTracker = (key: string, version: string, bytes: Buffer): void => {
    const old = trackerBodies.get(key);
    if (old !== undefined) { trackerBytes -= old.bytes.length; trackerBodies.delete(key); }
    while (trackerBodies.size >= 64 || trackerBytes + bytes.length > 8 * 1024 * 1024) {
      const first = trackerBodies.keys().next().value;
      if (first === undefined) break;
      trackerBytes -= trackerBodies.get(first)!.bytes.length; trackerBodies.delete(first);
    }
    if (bytes.length <= 8 * 1024 * 1024) { trackerBodies.set(key, { version, bytes }); trackerBytes += bytes.length; }
  };
  const admission = (session: string): boolean => {
    if (!id.safeParse(session).success) return false;
    const read = input.store.query({ kind: 'project-detail-session', coordinationScopeId: scopeId, coordinatorSessionId: session as CoordinatorSessionId });
    return read.kind === 'project-detail-session' && read.registration !== null;
  };
  const versionRead = (graph: GraphVersionRef) => {
    if (!graphSchema.safeParse(graph).success) return null;
    const read = input.store.query({ kind: 'graph-version', coordinationScopeId: scopeId, graphId: graph.graphId as GraphId, graphVersion: graph.version as GraphVersion });
    return read.kind === 'graph-version' && read.version?.generation === graph.generation ? read.version : null;
  };
  const bindingRead = (workPackageId: string, orcaTaskId: string) => {
    const read = input.store.query({ kind: 'graph-basis-binding', coordinationScopeId: scopeId, workPackageId: workPackageId as WorkPackageId, orcaTaskId });
    return read.kind === 'graph-basis-binding' ? read.binding : null;
  };
  const sourcesForBinding = (binding: MaterializationBindingRecord): readonly BasisSource[] => {
    const items: BasisSource[] = [{
      id: 'task:' + binding.orcaTaskId, label: '保留执行记录 · ' + (binding.role ?? binding.recoveryUtilityRole ?? '身份未记录') + ' · ' + binding.orcaTaskId,
      ref: { kind: 'retained_task', workPackageId: binding.workPackageId, orcaTaskId: binding.orcaTaskId },
      sourceVersion: token({ kind: 'retained_task', workPackageId: binding.workPackageId, orcaTaskId: binding.orcaTaskId }), unavailable: null,
    }];
    items.push({
      id: 'authorization:' + binding.orcaTaskId, label: '原批准授权 · ' + (binding.authorizationId ?? '未记录'),
      ref: binding.authorizationId === null || binding.authorizationVersion === null ? null : { kind: 'authorization', authorizationId: binding.authorizationId, authorizationVersion: binding.authorizationVersion },
      sourceVersion: null, unavailable: binding.authorizationId === null || binding.authorizationVersion === null ? '原授权绑定未记录' : null,
    });
    items.push({
      id: 'native:' + binding.orcaTaskId, label: '原生规格文件 · ' + (binding.specBinding?.relativePath ?? '未接纳'),
      ref: binding.specBinding === null || binding.worktreeId === null ? null : {
        kind: 'specification', locator: { worktreeId: binding.worktreeId, relativePath: binding.specBinding.relativePath },
        contractRevision: binding.specBinding.contractRevision, path: '', workPackageId: binding.workPackageId, orcaTaskId: binding.orcaTaskId,
      }, sourceVersion: null, unavailable: binding.specBinding === null ? '没有已接纳规格绑定' : binding.worktreeId === null ? '原 worktree 身份未记录' : null,
    });
    return items;
  };
  return {
    async listVersions(request) {
      await Promise.resolve();
      if (!admission(request.coordinatorSessionId)) return unavailable('unauthorized', 'Session 不属于当前 Scope');
      let after;
      if (request.after !== null) {
        let raw: unknown; try { raw = JSON.parse(request.after); } catch { return unavailable('invalid_cursor', '版本目录游标无效'); }
        const parsed = indexCursor.safeParse(raw);
        if (!parsed.success || parsed.data.coordinatorSessionId !== request.coordinatorSessionId) return unavailable('invalid_cursor', '版本目录游标不属于当前 Session');
        after = { generation: parsed.data.generation as GraphGeneration, graphId: parsed.data.graphId as GraphId, version: parsed.data.version as GraphVersion };
      }
      const read = input.store.query({ kind: 'graph-version-index', coordinationScopeId: scopeId, ...(after === undefined ? {} : { after }) });
      if (read.kind !== 'graph-version-index') return unavailable('unreachable', '图版本目录不可读');
      return { kind: 'read', value: { items: read.items.map(summary), nextCursor: read.nextCursor === null ? null : JSON.stringify({ coordinatorSessionId: request.coordinatorSessionId, ...read.nextCursor }) } };
    },
    async readVersion(request) {
      await Promise.resolve();
      if (!admission(request.coordinatorSessionId)) return unavailable('unauthorized', 'Session 不属于当前 Scope');
      const record = versionRead(request.graph);
      if (record === null) return unavailable('not_recorded', '所选图版本未记录');
      const scope = input.store.query({ kind: 'scope', coordinationScopeId: scopeId });
      const generation = input.store.query({ kind: 'graph-generation', coordinationScopeId: scopeId, graphId: record.graphId });
      const patch = input.store.query({ kind: 'graph-patch-record', coordinationScopeId: scopeId, graphId: record.graphId, graphVersion: record.version });
      const graph: GraphView = {
        graphId: record.graphId, graphVersion: record.version, generation: record.generation,
        readiness: { generationStatus: generation.kind === 'graph-generation' ? generation.generation?.status ?? null : null, authorizationBound: false },
        frontier: [],
        nodes: record.graph.workPackages.map((node, position) => ({
          ...node, position, hidden: false, shortKey: workPackageShortKey(node.workPackageId),
          state: 'unknown', active: false, role: null, attemptId: null, liveness: null, worktreePath: null,
          baselineHead: null, validation: null, integration: null, revisionHold: null, reconciliation: null,
          blockerRefs: [], derivedFrom: ['graph:' + record.graphId + '@' + record.version],
        })),
      };
      return { kind: 'read', value: { graph, retiredWorkPackageIds: patch.kind === 'graph-patch-record' ? patch.record?.retired ?? [] : [], summary: {
        graphId: record.graphId, generation: record.generation, version: record.version,
        recordKind: record.recordKind, parentVersion: record.parentVersion, patchId: record.patchId,
        mapRevision: record.mapRevision, planRevision: record.planRevision, orcaRunId: record.orcaRunId, recordedAt: record.recordedAt,
        generationStatus: generation.kind === 'graph-generation' ? generation.generation?.status ?? 'not_recorded' : 'not_recorded',
        current: scope.kind === 'scope' && scope.scope?.graphId === record.graphId && scope.scope.graphVersion === record.version,
      } } };
    },
    async listSources(request) {
      if (!admission(request.coordinatorSessionId)) return unavailable('unauthorized', 'Session 不属于当前 Scope');
      const record = versionRead(request.graph);
      if (record === null) return unavailable('not_recorded', '所选图版本未记录');
      if (request.workPackageId !== null && !record.graph.workPackages.some(node => node.workPackageId === request.workPackageId)) {
        const patch = input.store.query({ kind: 'graph-patch-record', coordinationScopeId: scopeId, graphId: record.graphId, graphVersion: record.version });
        if (patch.kind !== 'graph-patch-record' || !patch.record?.retired.includes(request.workPackageId as WorkPackageId)) return unavailable('not_recorded', '该版本没有所选工作包或退役证明');
      }
      if (request.orcaTaskId !== undefined) {
        if (request.workPackageId === null) return unavailable('invalid_query', '规格目录没有工作包绑定');
        let after: string | null = null;
        if (request.after !== null) {
          let raw: unknown;
          try { raw = JSON.parse(request.after); } catch { return unavailable('invalid_cursor', '规格目录游标无效'); }
          const parsed = filesCursor.safeParse(raw);
          if (!parsed.success || parsed.data.coordinatorSessionId !== request.coordinatorSessionId || !sameGraph(parsed.data.graph, request.graph) || parsed.data.workPackageId !== request.workPackageId || parsed.data.orcaTaskId !== request.orcaTaskId) return unavailable('invalid_cursor', '规格目录游标不属于原对象');
          after = parsed.data.after;
        }
        const binding = bindingRead(request.workPackageId, request.orcaTaskId);
        if (binding?.specBinding == null || binding.worktreeId === null) return unavailable('not_recorded_binding', '原规格绑定未记录');
        const provider = await input.specification(binding);
        if (provider?.readFiles === undefined) return unavailable('unreachable', '原 worktree 或规格读取能力不可用');
        const read = await provider.readFiles({ locator: { worktreeId: binding.worktreeId, relativePath: binding.specBinding.relativePath }, contractRevision: binding.specBinding.contractRevision, after });
        if (read.kind !== 'read') return unavailable(read.failure.code, read.failure.message);
        return { kind: 'read', value: { items: read.value.items.map(file => ({
          id: request.orcaTaskId + ':' + file.path, label: file.path, unavailable: null, sourceVersion: file.sourceVersion,
          ref: { kind: 'specification' as const, locator: { worktreeId: binding.worktreeId!, relativePath: binding.specBinding!.relativePath }, contractRevision: binding.specBinding!.contractRevision, path: file.path, workPackageId: binding.workPackageId, orcaTaskId: binding.orcaTaskId },
        })), nextCursor: read.value.nextCursor === null ? null : JSON.stringify({ coordinatorSessionId: request.coordinatorSessionId, graph: request.graph, workPackageId: request.workPackageId, orcaTaskId: request.orcaTaskId, after: read.value.nextCursor }) } };
      }
      let after: GraphBasisBindingCursor | null = null, itemIndex = 0;
      let phase: 'authorization' | 'bindings' = 'authorization';
      let authorizationAfter: GraphAuthorizationCursor | null = null;
      if (request.after !== null) {
        let raw: unknown; try { raw = JSON.parse(request.after); } catch { return unavailable('invalid_cursor', '依据游标无效'); }
        const parsed = sourcesCursor.safeParse(raw);
        if (!parsed.success || parsed.data.coordinatorSessionId !== request.coordinatorSessionId || !sameGraph(parsed.data.graph, request.graph) || parsed.data.workPackageId !== request.workPackageId) return unavailable('invalid_cursor', '依据游标不属于原对象');
        after = parsed.data.after; itemIndex = parsed.data.index;
        phase = parsed.data.phase; authorizationAfter = parsed.data.authorizationAfter;
      }
      const cursor = (index: number, next: GraphBasisBindingCursor | null, nextPhase: 'authorization' | 'bindings' = 'bindings', nextAuthorization: GraphAuthorizationCursor | null = null): string =>
        JSON.stringify({ coordinatorSessionId: request.coordinatorSessionId, graph: request.graph, workPackageId: request.workPackageId, after: next, index, phase: nextPhase, authorizationAfter: nextAuthorization });
      if (request.after === null) {
        const graphV1 = { ...request.graph, version: 1 };
        const plan = input.store.query({ kind: 'graph-basis-range', coordinationScopeId: scopeId, source: { kind: 'initial_plan', graphId: record.graphId, generation: record.generation, version: 1 as GraphVersion }, offset: 0, maxBytes: 4 });
        const items: BasisSource[] = [
          { id: 'initial-plan', label: '原始 Implementation Plan', ref: plan.kind === 'graph-basis-range' && plan.found ? { kind: 'initial_plan', graph: graphV1 } : null, sourceVersion: null, unavailable: plan.kind === 'graph-basis-range' && plan.found ? null : '原始计划正文未记录' },
          { id: 'graph-patch', label: '所选版本 Accepted Graph Patch', ref: record.recordKind === 'accepted_revision' ? { kind: 'graph_patch', graph: request.graph } : null, sourceVersion: null, unavailable: record.recordKind === 'initial' ? '初始版本没有图补丁' : null },
          { id: 'historical-tracker', label: '批准时规划来源正文', ref: null, sourceVersion: null, unavailable: 'tracker 未提供该时刻的历史正文' },
        ];
        if (input.routeMapIssueRef !== null) items.push({ id: 'current-map', label: '当前 Route Map · 非历史快照', ref: { kind: 'tracker', issueRef: input.routeMapIssueRef }, sourceVersion: null, unavailable: null });
        return { kind: 'read', value: { items, nextCursor: cursor(0, null, 'authorization') } };
      }
      if (phase === 'authorization') {
        const read = input.store.query({ kind: 'graph-basis-authorizations', coordinationScopeId: scopeId,
          graphId: record.graphId, generation: record.generation, ...(authorizationAfter === null ? {} : { after: authorizationAfter }) });
        if (read.kind !== 'graph-basis-authorizations') return unavailable('unreachable', '批准授权目录不可读');
        return { kind: 'read', value: {
          items: read.items.map(entry => ({ id: 'approved:' + entry.authorizationId + '@' + entry.authorizationVersion,
            label: '批准授权 · ' + entry.authorizationId + ' v' + entry.authorizationVersion + ' · 批准图 v' + entry.graphVersion,
            ref: { kind: 'authorization' as const, authorizationId: entry.authorizationId, authorizationVersion: entry.authorizationVersion },
            sourceVersion: null, unavailable: null })),
          nextCursor: read.nextCursor !== null ? cursor(0, null, 'authorization', read.nextCursor)
            : request.workPackageId === null ? null : cursor(0, null),
        } };
      }
      if (request.workPackageId === null) return { kind: 'read', value: { items: [], nextCursor: null } };
      const read = input.store.query({ kind: 'graph-basis-bindings', coordinationScopeId: scopeId, workPackageId: request.workPackageId as WorkPackageId, ...(after === null ? {} : { after }) });
      if (read.kind !== 'graph-basis-bindings') return unavailable('unreachable', '保留执行记录不可读');
      const candidates = read.bindings.flatMap(sourcesForBinding), items = candidates.slice(itemIndex, itemIndex + 20);
      const end = itemIndex + items.length;
      return { kind: 'read', value: { items, nextCursor: end < candidates.length ? cursor(end, after) : read.nextCursor === null ? null : cursor(0, read.nextCursor) } };
    },
    async readSource(request) {
      if (!admission(request.coordinatorSessionId)) return unavailable('unauthorized', 'Session 不属于当前 Scope');
      if (!sourceSchema.safeParse(request.source).success || !Number.isSafeInteger(request.offset) || request.offset < 0 || !Number.isSafeInteger(request.maxBytes) || request.maxBytes < 4 || request.maxBytes > 65536 ||
        request.sourceVersion !== null && typeof request.sourceVersion !== 'string') return unavailable('invalid_query', '正文范围或来源无效');
      const ref = request.source;
      if (ref.kind === 'initial_plan' || ref.kind === 'graph_patch' || ref.kind === 'authorization') {
        const sourceVersion = token(ref);
        if (request.sourceVersion !== null && request.sourceVersion !== sourceVersion) return { kind: 'stale', message: '正文版本不属于原来源' };
        const source = ref.kind === 'authorization' ? ref : { kind: ref.kind, graphId: ref.graph.graphId as GraphId, generation: ref.graph.generation as GraphGeneration, version: ref.graph.version as GraphVersion };
        const read = input.store.query({ kind: 'graph-basis-range', coordinationScopeId: scopeId, source, offset: request.offset, maxBytes: request.maxBytes });
        if (read.kind !== 'graph-basis-range') return unavailable(read.kind === 'rejected' ? read.code : 'unreachable', '依据正文不可读');
        if (!read.found || read.text === null) return unavailable('not_recorded', '依据正文未记录');
        return { kind: 'read', value: { sourceVersion, text: read.text, offset: request.offset, end: read.end, byteLength: read.byteLength } };
      }
      if (ref.kind === 'retained_task') {
        const binding = bindingRead(ref.workPackageId, ref.orcaTaskId);
        if (binding === null) return unavailable('not_recorded_binding', '执行记录未记录');
        return textRange(JSON.stringify({ ...binding, versionAttribution: 'version_unprovable', description: '工作包保留记录，图版本归属不可证明' }, null, 2), token(ref), request);
      }
      if (ref.kind === 'tracker') {
        if (ref.issueRef !== input.routeMapIssueRef || input.tracker?.readIssueBody === undefined) return unavailable('unauthorized', '规划来源不属于当前 Scope');
        const cached = trackerBodies.get(ref.issueRef);
        if (cached !== undefined && request.sourceVersion === cached.version) return bufferRange(cached.bytes, cached.version, request);
        const read = await input.tracker.readIssueBody({ kind: 'route-map', id: ref.issueRef });
        if (read.kind !== 'read') return unavailable(read.kind, read.kind === 'unavailable' ? read.message : read.kind === 'unknown' ? read.reason : '规划来源不存在');
        if (request.sourceVersion !== null && request.sourceVersion !== read.value.sourceVersion) return { kind: 'stale', message: 'tracker 来源正文已改变' };
        const bytes = Buffer.from(read.value.body);
        rememberTracker(ref.issueRef, read.value.sourceVersion, bytes);
        return bufferRange(bytes, read.value.sourceVersion, request);
      }
      // Resolve a supplied locator only through the retained binding of a graph package.
      const binding = bindingRead(ref.workPackageId, ref.orcaTaskId);
      if (binding === null || binding.specBinding === null || binding.worktreeId !== ref.locator.worktreeId ||
        binding.specBinding?.relativePath !== ref.locator.relativePath ||
        binding.specBinding.contractRevision !== ref.contractRevision) return unavailable('not_recorded_binding', '来源不匹配原规格绑定');
      const located = await input.specification(binding);
      if (located?.readFileRange === undefined) return unavailable('not_recorded_binding', '原规格绑定不可读取');
      const read = await located.readFileRange({ locator: ref.locator, contractRevision: ref.contractRevision, path: ref.path, sourceVersion: request.sourceVersion, offset: request.offset, maxBytes: request.maxBytes });
      return read.kind === 'read' ? { kind: 'read', value: read.value } : unavailable(read.failure.code, read.failure.message);
    },
  };
}

function textRange(text: string, sourceVersion: string, query: { readonly offset: number; readonly maxBytes: number; readonly sourceVersion: string | null }): BasisReadResult<{ readonly text: string; readonly sourceVersion: string; readonly offset: number; readonly end: number; readonly byteLength: number }> {
  return bufferRange(Buffer.from(text), sourceVersion, query);
}

function bufferRange(bytes: Buffer, sourceVersion: string, query: { readonly offset: number; readonly maxBytes: number; readonly sourceVersion: string | null }): BasisReadResult<{ readonly text: string; readonly sourceVersion: string; readonly offset: number; readonly end: number; readonly byteLength: number }> {
  if (query.sourceVersion !== null && query.sourceVersion !== sourceVersion) return { kind: 'stale', message: '来源正文已改变' };
  if (query.offset > bytes.length || query.offset < bytes.length && (bytes[query.offset]! & 0xc0) === 0x80) return unavailable('invalid_utf8_offset', '正文位置不在 UTF-8 边界');
  let end = Math.min(bytes.length, query.offset + query.maxBytes);
  while (end < bytes.length && end > query.offset && (bytes[end]! & 0xc0) === 0x80) end--;
  return { kind: 'read', value: { text: bytes.subarray(query.offset, end).toString('utf8'), sourceVersion, offset: query.offset, end, byteLength: bytes.length } };
}
