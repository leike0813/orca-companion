/**
 * 真实执行 Scope 的共用播种夹具。
 *
 * 把「尚无 Scope 的隔离项目」推到「route_planning + 候选图与 Run + 已让出 Runtime Lease + 空 checkpoint」，
 * 之后由前台宿主接管。使用方有两处，且必须共用同一份事实：
 *
 * - `tests/integration/foreground-execution-runtime.test.ts`（进程内驱动宿主）；
 * - `tests/tui/pty-execution.test.ts`（真实 PTY 驱动）。
 *
 * 播种用的图与宿主工具路径同一个用例（`proposeExecutionGraph`），不是第二套状态机；这里只做夹具，
 * 因此失败一律抛错并带上原始结论，调用方不需要再区分失败原因。
 */

import { existsSync } from 'node:fs';

import { runProcess } from '../../src/adapters/orca-cli/process-runner.js';
import { createOrcaExecutionBackend } from '../../src/adapters/orca-cli/orca-backend.js';
import { acquireRuntimeLease } from '../../src/application/coordination/lease-service.js';
import { initializeCoordinationScope } from '../../src/application/planning/initialize-scope.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  PlanningCycleId,
  RuntimeIncarnationId,
} from '../../src/application/dto/identity.js';
import type { CoordinationWriter } from '../../src/application/ports/branch-coordination-store.js';
import { DEFAULT_EXECUTION_LIMITS } from '../../src/domain/planning/budget-policy.js';
import { openRepositoryCoordinationStore, resolveGitCommonDir } from '../../src/bootstrap/composition.js';
import { checkpointDatabasePath } from '../../src/bootstrap/coordinator-runtime.js';
import { openCheckpointStore } from '../../src/adapters/storage/checkpoint-store.js';
import { COORDINATOR_SESSION_STATE_SCHEMA_VERSION } from '../../src/domain/coordinator/session-state.js';
import { proposeExecutionGraph } from '../../src/bootstrap/execution-runtime.js';

/** 夹具接受的计划形状：调用方可以只取其中一部分 Work Package。 */
export type RealLoopPlan = {
  readonly planRevision: number;
  readonly destinationRef: { readonly kind: 'destination'; readonly id: string; readonly version: number };
  readonly workPackages: readonly {
    readonly key: string;
    readonly title: string;
    readonly dependsOn: readonly string[];
    readonly scopeEnvelope: { readonly include: readonly string[]; readonly exclude: readonly string[] };
  }[];
};

/** 目标是一个 README 落点：只在 README.md 里落一行标题与一句说明。 */
const README_BANNER = {
  key: 'readme-banner',
  title: 'README 标题与说明',
  dependsOn: [],
  scopeEnvelope: { include: ['README.md'], exclude: [] },
} as const;

/** 第二个落点是独立文件：它与 README 互不依赖，因此在串行 Frontier 里排在后面。 */
const NOTES_BASICS = {
  key: 'notes-basics',
  title: 'NOTES 基础说明',
  dependsOn: [],
  scopeEnvelope: { include: ['NOTES.md'], exclude: [] },
} as const;

const DESTINATION = { kind: 'destination', id: 'destination-e2e', version: 1 } as const;

/** 单包计划：一条干净的角色链，不需要图修订与基线补救。 */
export const REAL_LOOP_SINGLE_PLAN: RealLoopPlan = {
  planRevision: 1,
  destinationRef: DESTINATION,
  workPackages: [README_BANNER],
};

/**
 * 双包计划（PTY 验收用）：两个互不依赖的 Work Package 是**串行 Frontier 的最小可观测形状**。
 *
 * 第一个集成之后 canonical 会前移，第二个的隔离 worktree 仍建立在授权 baseline 上（因此落后于
 * canonical），图修订因此能在同一条链路上取到「worktree base 落后于所需基线」这一真实场景。
 */
export const REAL_LOOP_PLAN: RealLoopPlan = {
  planRevision: 1,
  destinationRef: DESTINATION,
  workPackages: [README_BANNER, NOTES_BASICS],
};

export type SeededRealExecutionScope = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly coordinatorSessionId: CoordinatorSessionId;
  /** 候选图的 Orca Run：驱动按它读 Worker 存活。 */
  readonly orcaRunId: string;
  readonly baselineHead: string;
};

export type SeedRealExecutionScopeInput = {
  readonly workspace: string;
  /** 专用 Orca 身份：与宿主同一约定，只接受显式声明的句柄。 */
  readonly identity: string;
  readonly objective: string;
  readonly env: Record<string, string>;
  readonly plan?: RealLoopPlan;
};

function requireCompleted(result: Awaited<ReturnType<typeof runProcess>>, what: string): string {
  if (result.kind !== 'completed') {
    throw new Error(`${what} 失败：${JSON.stringify(result)}`);
  }
  return result.stdout.text.trim();
}

/**
 * 播种一个全新的真实执行 Scope。
 *
 * 只对**尚无 Scope** 的隔离项目成立：已有 Scope 时抛错，绝不覆盖既有状态。
 */
export async function seedRealExecutionScope(
  input: SeedRealExecutionScopeInput,
): Promise<SeededRealExecutionScope> {
  const backend = createOrcaExecutionBackend({
    cwd: input.workspace,
    env: input.env,
    resolveIdentityHandle: (ref) => Promise.resolve(ref === input.identity ? ref : undefined),
  });
  const opened = await openRepositoryCoordinationStore({
    repositoryPath: input.workspace,
    env: input.env,
  });
  if (opened.kind !== 'opened') {
    throw new Error(`无法打开协调状态：${JSON.stringify(opened)}`);
  }
  try {
    const store = opened.store;
    const scopes = store.query({ kind: 'scopes' });
    if (scopes.kind !== 'scopes') {
      throw new Error(`无法读取 Scope 列表：${JSON.stringify(scopes)}`);
    }
    if (scopes.scopes.length !== 0) {
      throw new Error('播种需要尚无 Scope 的隔离项目');
    }
    const coordinationScopeId = 'e2e-loop-scope' as CoordinationScopeId;
    const coordinatorSessionId = 'e2e-loop-session' as CoordinatorSessionId;
    const planningCycleId = 'e2e-loop-cycle' as PlanningCycleId;
    // Scope 身份绑定 (repository, ref, canonical worktree)：分支名从 Git 读，不写死在夹具里。
    const fullBranchRef = requireCompleted(
      await runProcess({
        executable: 'git',
        args: ['symbolic-ref', 'HEAD'],
        cwd: input.workspace,
        env: input.env,
        timeoutMs: 60_000,
      }),
      'git symbolic-ref HEAD',
    );
    const initialized = initializeCoordinationScope({
      store,
      coordinationScopeId,
      coordinatorSessionId,
      coordinatorModelConfigurationRef: 'planning-default',
      planningCycleId,
      fullBranchRef,
      canonicalWorktreePath: input.workspace,
    });
    if (initialized.kind !== 'initialized') {
      throw new Error(`初始化 Coordination Scope 失败：${JSON.stringify(initialized)}`);
    }
    const lease = acquireRuntimeLease(store, {
      coordinationScopeId,
      coordinatorSessionId,
      runtimeIncarnationId: 'e2e-loop-incarnation' as RuntimeIncarnationId,
      fencingGeneration: 0,
    });
    if (lease.kind !== 'acquired') {
      throw new Error(`取得 Runtime Lease 失败：${JSON.stringify(lease)}`);
    }
    const writer: CoordinationWriter = {
      coordinatorSessionId,
      runtimeIncarnationId: 'e2e-loop-incarnation' as RuntimeIncarnationId,
      fencingGeneration: lease.lease.fencingGeneration,
    };
    const baselineHead = requireCompleted(
      await runProcess({
        executable: 'git',
        args: ['rev-parse', 'HEAD'],
        cwd: input.workspace,
        env: input.env,
        timeoutMs: 60_000,
      }),
      'git rev-parse HEAD',
    );
    const seeded = await proposeExecutionGraph({
      store,
      backend,
      coordinationScopeId,
      writer,
      backendIdentityRef: input.identity,
      timeoutMs: 60_000,
      authority: { kind: 'route_planning' },
      plan: input.plan ?? REAL_LOOP_PLAN,
      limits: DEFAULT_EXECUTION_LIMITS,
      baselineHead,
      objective: input.objective,
    });
    if (seeded.kind !== 'recorded') {
      throw new Error(`播种候选图失败：${JSON.stringify(seeded)}`);
    }
    const generations = store.query({ kind: 'graph-generations', coordinationScopeId });
    const orcaRunId =
      generations.kind === 'graph-generations' ? (generations.generations[0]?.orcaRunId ?? '') : '';
    if (orcaRunId.length === 0) {
      throw new Error(`候选图没有 Orca Run：${JSON.stringify(generations)}`);
    }
    // 让出 Runtime Lease：宿主启动时会取得新的 fencing generation。
    const revision = store.query({ kind: 'scope', coordinationScopeId });
    if (revision.kind === 'scope' && revision.scope !== null) {
      store.transact({
        kind: 'release-runtime-lease',
        coordinationScopeId,
        expectedRevision: revision.scope.revision,
        writer,
      });
    }
    // 播种用的 Session 已经持有过 Runtime Lease：补写一份空 checkpoint，否则宿主启动时会把
    // 「取过租约但读不到 checkpoint」判成不可恢复（`runtime-guard` 的既有规则）。
    const commonDir = await resolveGitCommonDir({ repositoryPath: input.workspace, env: input.env });
    if (commonDir.kind !== 'resolved') {
      throw new Error(`无法解析 Git common dir：${JSON.stringify(commonDir)}`);
    }
    const checkpoints = openCheckpointStore({ databasePath: checkpointDatabasePath(commonDir.path) });
    if (checkpoints.kind !== 'opened') {
      throw new Error(`无法打开 checkpoint store：${JSON.stringify(checkpoints)}`);
    }
    try {
      const saved = checkpoints.store.saveCheckpoint({
        schemaVersion: COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
        coordinatorSessionId,
        committedMessages: [],
        graphPosition: 'suspend',
        committedModelSteps: [],
        wakeBatches: [],
        lastCompactionOutcome: null,
      });
      if (saved.kind !== 'saved') {
        throw new Error(`写入空 checkpoint 失败：${JSON.stringify(saved)}`);
      }
    } finally {
      checkpoints.store.close();
    }
    if (!existsSync(checkpointDatabasePath(commonDir.path))) {
      throw new Error('checkpoint 数据库未落盘');
    }
    return { coordinationScopeId, coordinatorSessionId, orcaRunId, baselineHead };
  } finally {
    opened.close();
  }
}
