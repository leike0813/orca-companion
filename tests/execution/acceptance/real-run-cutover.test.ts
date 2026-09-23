/**
 * `m1-evolve-execution-graph` 验收层：真实新 Run 的 Generation Cutover（IP-10，D13）。
 *
 * 「新代际确实落在新的 Orca Run 上」只有真实 Orca 事实能证明。本文件在**显式选择的隔离工作区**里建立
 * 一个协调终端并自建 Run，然后走完整的重规划过渡与 Cutover：
 *
 * 1. 前代代际被挂起、Lease 被释放、Scope 切到新的 Planning Cycle；
 * 2. 候选代际（新 GraphId、新 Run、新 WorkPackageId）通过完整授权；
 * 3. `commitGenerationCutover` 在一次写入里冻结前代、激活候选并切换全部引用。
 *
 * ```sh
 * ORCA_COMPANION_REAL_HARNESS=1 \
 * ORCA_COMPANION_REAL_REPO=<isolated-workspace> \
 * ORCA_COMPANION_REAL_IDENTITY=<dedicated-identity> \
 * pnpm test -- tests/execution/acceptance/real-run-cutover.test.ts --no-file-parallelism
 * ```
 *
 * 前置条件（缺一不可）：隔离工作区是一个**干净的一次性** Git 仓库（没有 Companion 状态目录）、已被
 * Orca 注册为 repo（`orca repo add --path <workspace> --json`）、`orca` CLI 在当前 PATH 上、并且该
 * 专用身份没有被其它会话占用。
 *
 * 未显式开启时整个文件只留一条 skip 记录：不解析身份、不调用 Orca、不打开数据库。真实调用只在隔离
 * 工作区与专用身份中进行：不触碰用户主项目、不重启全局 Orca runtime、不改上游。
 */

import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

import { createOrcaExecutionBackend } from '../../../src/adapters/orca-cli/orca-backend.js';
import { runProcess } from '../../../src/adapters/orca-cli/process-runner.js';
import { openCoordinationStore, type CoordinationStore } from '../../../src/adapters/storage/coordination-store.js';
import { acquireRuntimeLease } from '../../../src/application/coordination/lease-service.js';
import type { ExecutionScope } from '../../../src/application/ports/execution-backend.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  GraphGeneration,
  GraphId,
  GraphVersion,
  PlanningCycleId,
  RuntimeIncarnationId,
  WorkPackageId,
} from '../../../src/application/dto/identity.js';
import type { CoordinationWriter } from '../../../src/application/ports/branch-coordination-store.js';
import { initializeCoordinationScope } from '../../../src/application/planning/initialize-scope.js';
import { graphIdFor } from '../../../src/application/planning/graph-generation.js';
import { loadCurrentGraph, recordInitialGraph } from '../../../src/application/planning/graph-history.js';
import { readScope } from '../../../src/application/planning/scope-read.js';
import {
  beginReplanningTransition,
  commitGenerationCutover,
  completeReplanningTransition,
  ensureGraphGenerationRecord,
} from '../../../src/application/execution/replanning-service.js';
import {
  COMPANION_STATE_DIRECTORY,
  coordinationDatabasePath,
  resolveGitCommonDir,
} from '../../../src/bootstrap/composition.js';
import { toChildEnvironment } from '../../../src/interfaces/cli/main.js';
import { executionManifest, executionWorkPackage } from '../../support/execution-harness.js';

const COMPANION_REPOSITORY = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const REAL_SWITCH = 'ORCA_COMPANION_REAL_HARNESS';
const WORKSPACE_VAR = 'ORCA_COMPANION_REAL_REPO';
const IDENTITY_VAR = 'ORCA_COMPANION_REAL_IDENTITY';

type Gate =
  | { readonly kind: 'run'; readonly workspace: string; readonly identity: string }
  | { readonly kind: 'skip'; readonly reason: string };

function gate(): Gate {
  if (process.env[REAL_SWITCH] !== '1') {
    return { kind: 'skip', reason: `${REAL_SWITCH} 未显式开启` };
  }
  const workspace = process.env[WORKSPACE_VAR];
  if (workspace === undefined || workspace.length === 0) {
    return { kind: 'skip', reason: `${WORKSPACE_VAR} 未显式选择隔离工作区` };
  }
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
    return { kind: 'skip', reason: `${WORKSPACE_VAR} 指向的不是已存在的目录` };
  }
  if (resolve(workspace) === COMPANION_REPOSITORY) {
    return { kind: 'skip', reason: '隔离工作区不得是 Companion 自身仓库' };
  }
  if (!existsSync(join(workspace, '.git'))) {
    return { kind: 'skip', reason: `${WORKSPACE_VAR} 不是 Git 仓库` };
  }
  const identity = process.env[IDENTITY_VAR];
  if (identity === undefined || identity.length === 0) {
    return { kind: 'skip', reason: `${IDENTITY_VAR} 未显式选择专用身份` };
  }
  return { kind: 'run', workspace: resolve(workspace), identity };
}

function currentRevision(store: CoordinationStore, scopeId: CoordinationScopeId): number {
  const read = readScope(store, scopeId);
  if (read.kind === 'rejected') {
    throw new Error(`无法读取 Scope：${read.code} ${read.message}`);
  }
  return read.scope.revision;
}

const resolved = gate();

if (resolved.kind === 'skip') {
  test.skip(`真实新 Run cutover 未运行：${resolved.reason}`, () => {});
} else {
  test(
    'Generation Cutover 在真实 Orca Run 上原子切换全部代际引用',
    async () => {
      const env = toChildEnvironment(process.env);
      const handle: { value: string | undefined } = { value: undefined };
      const backend = createOrcaExecutionBackend({
        cwd: resolved.workspace,
        env,
        resolveIdentityHandle: (ref) => (ref === resolved.identity ? handle.value : undefined),
      });
      const scopeFor = (operationId: string): ExecutionScope => ({
        coordinationScopeId: `${resolved.identity}:scope`,
        coordinatorSessionId: `${resolved.identity}:session`,
        runtimeIncarnationId: `${resolved.identity}:inc`,
        fencingGeneration: 1,
        backendIdentityRef: resolved.identity,
        operationId,
        target: { kind: 'orca-run', id: resolved.identity },
        expectedRevision: 0,
        timeoutMs: 120_000,
        // 建终端与建 Run 都是规划侧动作：它们发生在绑定 Run 之前，因此权威是 route_planning。
        authority: { kind: 'route_planning' },
      });

      // 1. 专用协调终端：只有它的句柄才能让绑定型命令（含 run-create）在这个身份上成立。
      const created = await backend.mutate(
        {
          operation: 'terminal-create',
          worktree: `path:${resolved.workspace}`,
          title: `${resolved.identity} cutover coordinator`,
          command: process.env['SHELL'] ?? 'sh',
        },
        scopeFor(`${resolved.identity}:terminal-create`),
      );
      expect(created.kind).toBe('accepted');

      const listed = await backend.query({
        operation: 'terminal-list',
        worktree: `path:${resolved.workspace}`,
      });
      expect(listed.kind).toBe('accepted');
      if (listed.kind !== 'accepted') {
        return;
      }
      const terminals = listed.value as {
        readonly terminals: readonly { readonly handle: string; readonly connected: boolean; readonly writable: boolean }[];
      };
      handle.value = terminals.terminals.find((terminal) => terminal.connected && terminal.writable)?.handle;
      expect(handle.value).toBeDefined();

      // 2. 真实新 Run：这是候选代际绑定的 Orca Run。回执不保证带 Run 身份，因此按下标身份读回。
      const runCreated = await backend.mutate(
        { operation: 'run-create', objective: `Orca Companion graph evolution cutover (${resolved.identity})` },
        scopeFor(`${resolved.identity}:run-create`),
      );
      expect(runCreated.kind).toBe('accepted');

      const currentRun = await backend.query({
        operation: 'run-current',
        backendIdentityRef: resolved.identity,
      });
      expect(currentRun.kind).toBe('accepted');
      if (currentRun.kind !== 'accepted') {
        return;
      }
      const run = (currentRun.value as { readonly run: { readonly runId: string } | null }).run;
      expect(run).not.toBeNull();
      const orcaRunId = run?.runId ?? '';
      expect(orcaRunId.length).toBeGreaterThan(0);

      // 3. 隔离工作区的 Companion 状态：前代代际、候选代际与 Cutover 都写在这里。
      const commonDir = await resolveGitCommonDir({ repositoryPath: resolved.workspace, env });
      if (commonDir.kind === 'failed') {
        throw new Error(`无法解析隔离工作区的 Git common dir：${commonDir.message}`);
      }
      // 一次性隔离工作区：这里必须是干净的，既有的 Companion 状态会让本次场景失去意义。
      expect(existsSync(join(commonDir.path, COMPANION_STATE_DIRECTORY))).toBe(false);
      const opened = openCoordinationStore({ databasePath: coordinationDatabasePath(commonDir.path) });
      if (opened.kind !== 'opened') {
        throw new Error(`无法打开隔离工作区的 coordination store：${opened.message}`);
      }
      const store = opened.store;
      try {
        const scopeId = `${resolved.identity}:scope` as CoordinationScopeId;
        const sessionId = `${resolved.identity}:session` as CoordinatorSessionId;
        const identityIncarnation = `${resolved.identity}:inc` as RuntimeIncarnationId;
        const cycleOne = `${resolved.identity}:cycle-1` as PlanningCycleId;
        const cycleTwo = `${resolved.identity}:cycle-2` as PlanningCycleId;

        const initialized = initializeCoordinationScope({
          store,
          coordinationScopeId: scopeId,
          coordinatorSessionId: sessionId,
          coordinatorModelConfigurationRef: 'codex#default',
          planningCycleId: cycleOne,
          fullBranchRef: `refs/heads/${scopeId}`,
          canonicalWorktreePath: '/tmp/orca-real-worktree',
        });
        if (initialized.kind !== 'initialized') {
          throw new Error(`无法初始化 Scope：${initialized.code} ${initialized.message}`);
        }
        const acquired = acquireRuntimeLease(store, {
          coordinationScopeId: scopeId,
          coordinatorSessionId: sessionId,
          runtimeIncarnationId: identityIncarnation,
          fencingGeneration: 0,
        });
        if (acquired.kind !== 'acquired') {
          throw new Error('无法取得 Runtime Lease');
        }
        const writer: CoordinationWriter = {
          coordinatorSessionId: sessionId,
          runtimeIncarnationId: identityIncarnation,
          fencingGeneration: acquired.lease.fencingGeneration,
        };

        const predecessorGraphId = graphIdFor(scopeId, 1 as GraphGeneration);
        const predecessor = recordInitialGraph({
          store,
          coordinationScopeId: scopeId,
          writer,
          graph: {
            graphId: predecessorGraphId,
            generation: 1 as GraphGeneration,
            concurrencyLimit: 1,
            workPackages: [executionWorkPackage('wp-predecessor')],
          },
          mapRevision: 0,
          planRevision: 1,
          orcaRunId: `${resolved.identity}:run-predecessor`,
        });
        if (predecessor.kind !== 'recorded') {
          throw new Error(`无法记录前代图：${predecessor.failure.code}`);
        }
        const authorized = store.transact({
          kind: 'record-authorization',
          coordinationScopeId: scopeId,
          expectedRevision: currentRevision(store, scopeId),
          writer,
          authorizationId: 'auth-real-cutover',
          authorizationVersion: 1,
          manifestVersion: 1,
          fingerprint: 'fingerprint-real-cutover-1',
          approvalRef: `${resolved.identity}:approval-1`,
          manifest: executionManifest({
            graphId: predecessorGraphId,
            generation: 1 as GraphGeneration,
            orcaRunId: `${resolved.identity}:run-predecessor`,
            coordinationScopeId: scopeId,
            planningCycleId: cycleOne,
          }),
        });
        if (authorized.kind === 'rejected') {
          throw new Error(`无法记录前代授权：${authorized.message}`);
        }

        // 4. 重规划过渡：挂起前代、结清、释放 Lease、进入新的 Planning Cycle。
        const begun = beginReplanningTransition({
          store,
          coordinationScopeId: scopeId,
          writer,
          facts: {
            userRequestedReplanning: true,
            goalOrGlobalConstraintChanged: false,
            graphRevisionsExhausted: false,
          },
          predecessor: {
            graphId: predecessorGraphId,
            generation: 1 as GraphGeneration,
            planningCycleId: cycleOne,
            orcaRunId: `${resolved.identity}:run-predecessor`,
            baselineHead: 'head-1',
          },
        });
        expect(begun.kind).toBe('started');

        const completed = completeReplanningTransition({
          store,
          coordinationScopeId: scopeId,
          writer,
          closure: 'drain',
          settlement: { inFlightWorkers: 0, pendingDeliveries: 0, openInteractions: 0, unresolvedIntents: 0 },
          newPlanningCycleId: cycleTwo,
        });
        expect(completed.kind).toBe('released');

        // 5. 候选代际：新 GraphId、新 Run、新 WorkPackageId，并通过完整授权。
        const candidateGraphId = graphIdFor(scopeId, 2 as GraphGeneration);
        const ensured = ensureGraphGenerationRecord({
          store,
          coordinationScopeId: scopeId,
          writer,
          graphId: candidateGraphId,
          generation: 2 as GraphGeneration,
          planningCycleId: cycleTwo,
          orcaRunId,
          predecessorGraphId: predecessorGraphId,
          baselineHead: 'head-2',
        });
        expect(ensured.kind).toBe('recorded');

        const candidate = recordInitialGraph({
          store,
          coordinationScopeId: scopeId,
          writer,
          graph: {
            graphId: candidateGraphId,
            generation: 2 as GraphGeneration,
            concurrencyLimit: 1,
            workPackages: [executionWorkPackage('wp-candidate')],
          },
          mapRevision: 0,
          planRevision: 1,
          orcaRunId,
        });
        if (candidate.kind !== 'recorded') {
          throw new Error(`无法记录候选图：${candidate.failure.code}`);
        }
        const candidateAuthorization = store.transact({
          kind: 'record-authorization',
          coordinationScopeId: scopeId,
          expectedRevision: currentRevision(store, scopeId),
          writer,
          authorizationId: 'auth-real-cutover-2',
          authorizationVersion: 2,
          manifestVersion: 1,
          fingerprint: 'fingerprint-real-cutover-2',
          approvalRef: `${resolved.identity}:approval-2`,
          manifest: executionManifest({
            graphId: candidateGraphId,
            generation: 2 as GraphGeneration,
            orcaRunId,
            baselineHead: 'head-2',
            coordinationScopeId: scopeId,
            planningCycleId: cycleTwo,
          }),
        });
        if (candidateAuthorization.kind === 'rejected') {
          throw new Error(`无法记录候选授权：${candidateAuthorization.message}`);
        }

        // 6. Cutover：一次写入把前代冻结、候选激活并切换全部引用。
        const cutover = commitGenerationCutover({
          store,
          coordinationScopeId: scopeId,
          writer,
          refs: {
            predecessorGraphId,
            candidateGraphId,
            candidateGeneration: 2 as GraphGeneration,
            candidateGraphVersion: 1 as GraphVersion,
            candidateRunId: orcaRunId,
            planningCycleId: cycleTwo,
            authorizationId: 'auth-real-cutover-2',
            authorizationVersion: 2,
            baselineHead: 'head-2',
            expectedRevision: currentRevision(store, scopeId),
          },
        });
        expect(cutover.kind).toBe('cutover');

        const scope = readScope(store, scopeId);
        if (scope.kind === 'rejected') {
          throw new Error('无法读取切换后的 Scope');
        }
        expect(scope.scope.graphId).toBe(candidateGraphId);
        expect(scope.scope.planningCycleId).toBe(cycleTwo);
        expect(scope.scope.mode).toBe('execution_coordination');
        expect(scope.scope.authorizationId).toBe('auth-real-cutover-2');

        const generations = store.query({ kind: 'graph-generations', coordinationScopeId: scopeId });
        const byGraph =
          generations.kind === 'graph-generations'
            ? new Map(generations.generations.map((entry) => [entry.graphId, entry]))
            : new Map<GraphId, { readonly status: string; readonly orcaRunId: string }>();
        expect(byGraph.get(candidateGraphId)?.status).toBe('active');
        expect(byGraph.get(candidateGraphId)?.orcaRunId).toBe(orcaRunId);
        expect(byGraph.get(predecessorGraphId)?.status).toBe('frozen');

        // 新代际使用全新的 WorkPackageId：worktree 归属标记因此也全新，不复用前代隔离工作区。
        const loaded = loadCurrentGraph({ store, coordinationScopeId: scopeId, graphId: candidateGraphId });
        if (loaded.kind !== 'loaded') {
          throw new Error('无法读取候选图');
        }
        const candidateIds = loaded.version.graph.workPackages.map(
          (entry) => entry.workPackageId,
        );
        expect(candidateIds).toContain('wp-candidate' as WorkPackageId);
        expect(candidateIds).not.toContain('wp-predecessor' as WorkPackageId);

        const leases = store.query({ kind: 'leases', coordinationScopeId: scopeId });
        const executionHolder =
          leases.kind === 'leases'
            ? leases.leases.find((lease) => lease.kind === 'execution_coordination' && lease.releasedAt === null)
                ?.coordinatorSessionId
            : undefined;
        expect(executionHolder).toBe(sessionId);
      } finally {
        store.close();
      }

      // 现场保留供检查：隔离工作区的清理需要另行授权。
      const status = await runProcess({
        executable: 'git',
        args: ['status', '--short'],
        cwd: resolved.workspace,
        env,
        timeoutMs: 30_000,
      });
      expect(status.kind).toBe('completed');
    },
    900_000,
  );
}
