import { afterEach, expect, test } from 'vitest';
import { createExecutionScopeHarness, type ExecutionScopeHarness } from '../support/execution-harness.js';
import { prepareFinalizerWorktree, finalizerPathsOutsideScope } from '../../src/application/finalizer-execution.js';
import type { OperationId, WorkerTaskId } from '../../src/application/dto/identity.js';
import type { ExecutionBackend, WorktreeSummary } from '../../src/application/ports/execution-backend.js';

let harness: ExecutionScopeHarness | undefined;
afterEach(() => harness?.close());

test.each(['unknown', 'accepted'] as const)('Finalizer worktree %s creation reuses its original intent and budget', async outcome => {
  harness = createExecutionScopeHarness();
  const h = harness;
  const manifest = { ...h.authorization().manifest,
    permissions: { ...h.authorization().manifest.permissions, finalizer: true, gitIntegration: true },
    finalizerPolicy: { mode: 'repair' as const, repairLimit: 1 } };
  expect(h.store.transact({ kind: 'record-authorization', coordinationScopeId: h.scopeId, expectedRevision: h.revision(),
    writer: h.writer, authorizationId: 'repair-auth', authorizationVersion: 2, manifestVersion: 5,
    fingerprint: 'repair-fingerprint', approvalRef: 'repair-approval', manifest }).kind).toBe('committed');
  const head = 'a'.repeat(40);
  const workerTaskId = 'finalizer-1' as WorkerTaskId;
  const operationId = 'create-finalizer-1' as OperationId;
  let worktree: WorktreeSummary | null = null;
  let mutations = 0;
  const backend: ExecutionBackend = {
    query: () => Promise.resolve({ kind: 'accepted', value: { worktrees: worktree === null ? [] : [worktree],
      truncated: false, hostScope: { omittedHostIds: [] } } }),
    mutate: (_mutation, scope) => {
      mutations++;
      worktree = { worktreeId: 'wt-finalizer', path: '/tmp/finalizer-worktree', branch: 'finalizer-branch', head,
        comment: `finalizerTaskId=${workerTaskId}`, isMainWorktree: false, displayName: null };
      return Promise.resolve(outcome === 'unknown'
        ? { kind: 'unknown', operation: { operationId, target: scope.target }, reason: 'lost response' }
        : { kind: 'accepted', operation: { operationId, target: scope.target }, value: { worktreeId: 'wt-finalizer' } });
    },
  };
  const input = { store: h.store, backend, writer: h.writer, coordinationScopeId: h.scopeId, graphId: h.graphId,
    graphGeneration: h.generation, workerTaskId, authorizationId: 'repair-auth', baselineHead: head,
    canonicalWorktree: '/tmp/canonical', operationId,
    executionScope: (revision: number) => ({ coordinationScopeId: h.scopeId, ...h.writer,
      backendIdentityRef: 'identity', operationId, target: { kind: 'finalizer-worktree', id: workerTaskId },
      expectedRevision: revision, timeoutMs: 1000, authority: { kind: 'execution_coordination' as const,
        graphGeneration: h.generation, authorizationId: 'repair-auth', runId: 'run-1', consumerGeneration: 1 } }),
  };
  const first = await prepareFinalizerWorktree(input);
  expect(first.kind).toBe(outcome === 'unknown' ? 'blocked' : 'ready');
  expect((await prepareFinalizerWorktree(input)).kind).toBe('ready');
  expect(mutations).toBe(1);
  const counters = h.store.query({ kind: 'budget-counters', coordinationScopeId: h.scopeId, approvedLimitRef: 'repair-auth' });
  expect(counters.kind === 'budget-counters' && counters.counters.find(row => row.budgetKey.startsWith('finalizer:'))?.consumed).toBe(1);
});

test('Finalizer scope includes only approved paths, including specification and tooling files', () => {
  harness = createExecutionScopeHarness();
  const graph = harness.currentGraph().graph;
  expect(finalizerPathsOutsideScope(graph, ['openspec/specs/changed.md', '.agents/config.json', 'outside/file.ts']))
    .toEqual(['openspec/specs/changed.md', '.agents/config.json', 'outside/file.ts']);
});
