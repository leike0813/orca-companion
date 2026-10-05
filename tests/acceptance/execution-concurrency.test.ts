/**
 * restore-configurable-execution-concurrency IP-05：多包并发的真实隔离闭环验收。
 *
 * 本文件只验证**真实 Orca/Codex 事实**才能回答的三件事：
 *
 * 1. 并行包额度可配置且真的大于设计时的保守假定 3——项目配置与批准 Manifest 都是 5，运行时确实把
 *    两个独立 Work Package 同时推进到活动态（不是串行队列的假并行）；
 * 2. 两个独立 Work Package 的隔离 worktree 建立在**同一条 baseline** 上并同时存活；
 * 3. 串行 Git 集成把已前移的 canonical 合并进后集成包的 worktree，并由**原 Validator 的精确
 *    provider Session** 复验合并树（integration reconciliation），最后得到 Finalizer Verdict。
 *
 * 运行方式（先跑 `artifacts/execution-concurrency/setup-fixture.mjs` 建立隔离现场）：
 *
 * ```sh
 * ORCA_COMPANION_E2E_REPO=<isolated-path> \
 * ORCA_COMPANION_E2E_IDENTITY=<dedicated-identity> \
 * ORCA_COMPANION_E2E_CONCURRENCY=1 \
 * pnpm exec vitest run tests/acceptance/execution-concurrency.test.ts --no-file-parallelism
 * ```
 *
 * 未显式开启时整个文件只留一条 skip 记录：不打开隔离项目、不调用 Orca、不启动 Worker。真实调用
 * 一律只在隔离 Git 项目与专用身份中进行：不触碰用户主项目、不重启全局 Orca runtime、不改 references。
 *
 * 结论只有在出现 Finalizer Verdict（`deliverable`）、观测到 >=2 个活动包与 >=2 个同时 live 的
 * Worker、且至少一条集成复验绑定原 Validation Attempt 并 `validated` 时才算通过；任何一项缺失都
 * 如实报失败并写出可读报告，不把跳过或阻塞改写成通过。真实计划聚焦两个包：每包只会在集成时复验
 * 一次（串行 canonical，后集成包的 worktree 落后于已前移的 canonical），额度 5 提供闲置余量。
 */

import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, test } from 'vitest';

import { createOrcaExecutionBackend } from '../../src/adapters/orca-cli/orca-backend.js';
import { COMPANION_STATE_DIRECTORY, coordinationDatabasePath, openRepositoryCoordinationStore, resolveGitCommonDir } from '../../src/bootstrap/composition.js';
import { codexSessionPathsUnder } from '../../src/bootstrap/execution-runtime.js';
import {
  createForegroundPlanningHost,
  type ForegroundPlanningHost,
} from '../../src/bootstrap/foreground-planning-runtime.js';
import { DEFAULT_EXECUTION_LIMITS, type ExecutionLimits } from '../../src/domain/planning/budget-policy.js';
import { runProcess } from '../../src/adapters/orca-cli/process-runner.js';
import { workerStateLiveness } from '../../src/application/execution/execution-view.js';
import { runStatus, type StatusSnapshot } from '../../src/interfaces/cli/status-command.js';
import { toChildEnvironment } from '../../src/interfaces/cli/main.js';
import type { CoordinationScopeId, WorkPackageId } from '../../src/application/dto/identity.js';
import { REAL_LOOP_PLAN, seedRealExecutionScope } from '../support/real-execution-scope.js';

const REPO_VAR = 'ORCA_COMPANION_E2E_REPO';
const IDENTITY_VAR = 'ORCA_COMPANION_E2E_IDENTITY';
const SWITCH = 'ORCA_COMPANION_E2E_CONCURRENCY';
/** 恢复模式：不再播种，直接在既有 Scope 上重启宿主继续（复用既有 Plan/Graph，不重复批准）。 */
const RESUME_SWITCH = 'ORCA_COMPANION_E2E_RESUME';

/** 验收目标是「可配置且大于 3」：批准额度显式取 5，且必须真的被使用。 */
const ACCEPTANCE_MAX_ACTIVE_PACKAGES = 5;

/** 至少两个独立包同时 live；这是并行恢复的最低可观测证据。 */
const MIN_SIMULTANEOUS_ACTIVE = 2;
const MIN_SIMULTANEOUS_LIVE_WORKERS = 2;

const ACCEPTANCE_LIMITS: ExecutionLimits = {
  ...DEFAULT_EXECUTION_LIMITS,
  maxActiveWorkPackages: ACCEPTANCE_MAX_ACTIVE_PACKAGES,
  // 图容量与并行额度分离：容量只限制图里的包数量，不改变本次调度额度。
  maxWorkPackages: 8,
  integrationReconciliations: 2,
  validatorRepairs: 2,
};

const COMPANION_REPOSITORY = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const ARTIFACT_DIRECTORY = join(COMPANION_REPOSITORY, 'artifacts', 'execution-concurrency');

const isolatedRepo = process.env[REPO_VAR] ?? '';
const dedicatedIdentity = process.env[IDENTITY_VAR] ?? '';
const enabled = isolatedRepo.length > 0 && dedicatedIdentity.length > 0 && process.env[SWITCH] === '1';

if (!enabled) {
  test.skip(
    `多包并发真实验收未开启：需要 ${REPO_VAR}、${IDENTITY_VAR} 与 ${SWITCH}=1`,
    () => undefined,
  );
}

/** 轮询到条件成立或超时；`intervalMs` 只是重试间隔，任何一轮提前成立都立刻返回。 */
async function pollUntil(
  check: () => Promise<boolean>,
  intervalMs: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    const { promise, resolve: done } = Promise.withResolvers<void>();
    setTimeout(done, intervalMs);
    await promise;
  }
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve: done } = Promise.withResolvers<void>();
  setTimeout(done, ms);
  return promise;
}

/** Runtime Lease 仍被本进程持有（未过期）；退出不会释放它，重启前必须等到它过期。 */
function runtimeLeaseHeld(snapshot: StatusSnapshot): boolean {
  const now = Date.now();
  return snapshot.scope.leases.some(
    (lease) => lease.leaseKind === 'runtime' && (lease.expiresAt === null || lease.expiresAt > now),
  );
}

async function readStatus(workspace: string): Promise<StatusSnapshot> {
  let stdout = '';
  let stderr = '';
  const code = await runStatus({
    openStore: () =>
      openRepositoryCoordinationStore({
        repositoryPath: workspace,
        env: toChildEnvironment(process.env),
        readOnly: true,
      }),
    json: true,
    io: {
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
    },
  });
  expect(code, `status 必须以 0 退出：${stderr}`).toBe(0);
  return JSON.parse(stdout) as StatusSnapshot;
}


type IntegrationReconciliationRead = {
  readonly workPackageId: string;
  readonly reconciliationId: string;
  readonly round: number;
  readonly validationAttemptId: string;
  readonly sourceAcceptedResultRef: string;
  readonly targetHead: string;
  readonly mergedTreeRef: string | null;
  readonly orcaTaskId: string | null;
  readonly dispatchId: string | null;
  readonly state: string;
  readonly blockerRef: string | null;
  readonly createdAt: number;
};

/** 原 Validator 的 Attempt 与精确 provider session；复验必须落在同一条会话上。 */
type ValidatorOrigin = {
  readonly attemptId: string | null;
  readonly dispatchId: string | null;
  readonly sessionBindingId: string | null;
  readonly launchId: string | null;
  readonly orcaTaskId: string | null;
};

/** 从 Branch Store 读回每个 Work Package 的集成复验轮次（只读；不推断未记录的身份）。 */

/**
 * 仍未收尾的 dispatch 数量；`null` 表示 worker-list 不可核验（fail closed，不读成 0）。
 *
 * 复用生产 SSOT `workerStateLiveness`：只有确定为 `exited` 才算收尾；`live` 与 `unverifiable`
 * （运行中的 prepared-terminal Worker 报 `ready`，按闭集不可核验）都算未收尾，因此不会把正在运行的
 * Worker 当成空闲而空转触发。
 */
async function unconcludedWorkerCount(
  backend: ReturnType<typeof createOrcaExecutionBackend>,
  runId: string,
): Promise<number | null> {
  const listed = await backend.query({ operation: 'worker-list', runId });
  if (listed.kind !== 'accepted') {
    return null;
  }
  const workers = (listed.value as { readonly workers?: readonly { readonly workerState?: unknown }[] }).workers;
  if (workers === undefined) {
    return null;
  }
  return workers.filter(
    (worker) => typeof worker.workerState !== 'string' || workerStateLiveness(worker.workerState) !== 'exited',
  ).length;
}

type DispatchInterval = {
  readonly dispatchId: string;
  readonly start: number;
  readonly end: number;
};

/** 解析公共 worker-show 的时间：`2026-10-05 05:31:26`（UTC，无时区）或 ISO。 */
function parseDispatchTime(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  const normalized = value.includes('T') ? value : value.replace(' ', 'T') + 'Z';
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

/** 重叠并发峰值：区间扫描，不推断状态、不把 ready 当 live。 */
function peakOverlap(intervals: readonly DispatchInterval[]): number {
  const events: { readonly at: number; readonly delta: number }[] = [];
  for (const interval of intervals) {
    events.push({ at: interval.start, delta: 1 });
    events.push({ at: interval.end, delta: -1 });
  }
  events.sort((left, right) => left.at - right.at || left.delta - right.delta);
  let current = 0;
  let peak = 0;
  for (const event of events) {
    current += event.delta;
    peak = Math.max(peak, current);
  }
  return peak;
}

/**
 * 从**公共** worker-list/worker-show 原始 JSON 读每个 dispatch 的起止时间。
 *
 * 适配器的 parseWorkerShow 不暴露 dispatchedAt/completedAt，因此这里直接读公开回执；这是证据读取，
 * 不改变任何状态，也不把状态猜成 live。
 */
async function readDispatchIntervals(env: Record<string, string>, runId: string): Promise<DispatchInterval[]> {
  const listed = await runProcess({
    executable: 'orca',
    args: ['orchestration', 'worker-list', '--run', runId, '--json'],
    cwd: process.cwd(),
    env,
    timeoutMs: 60_000,
  });
  if (listed.kind !== 'completed') {
    return [];
  }
  let workers: readonly { readonly dispatchId?: unknown }[];
  try {
    const parsed = JSON.parse(listed.stdout.text) as {
      readonly result?: { readonly workers?: readonly { readonly dispatchId?: unknown }[] };
    };
    workers = parsed.result?.workers ?? [];
  } catch {
    return [];
  }
  const intervals: DispatchInterval[] = [];
  for (const worker of workers) {
    if (typeof worker.dispatchId !== 'string') {
      continue;
    }
    const shown = await runProcess({
      executable: 'orca',
      args: ['orchestration', 'worker-show', '--dispatch', worker.dispatchId, '--json'],
      cwd: process.cwd(),
      env,
      timeoutMs: 60_000,
    });
    if (shown.kind !== 'completed') {
      continue;
    }
    try {
      const parsed = JSON.parse(shown.stdout.text) as {
        readonly result?: {
          readonly dispatch?: { readonly dispatchedAt?: unknown; readonly completedAt?: unknown };
        };
      };
      const start = parseDispatchTime(parsed.result?.dispatch?.dispatchedAt);
      const end = parseDispatchTime(parsed.result?.dispatch?.completedAt) ?? Date.now();
      if (start !== null) {
        intervals.push({ dispatchId: worker.dispatchId, start, end });
      }
    } catch {
      continue;
    }
  }
  return intervals;
}
async function readReconciliations(
  workspace: string,
  coordinationScopeId: string,
  workPackageIds: readonly string[],
): Promise<Record<string, readonly IntegrationReconciliationRead[]>> {
  const opened = await openRepositoryCoordinationStore({
    repositoryPath: workspace,
    env: toChildEnvironment(process.env),
    readOnly: true,
  });
  if (opened.kind !== 'opened') {
    throw new Error(`无法打开协调状态读取集成复验：${JSON.stringify(opened)}`);
  }
  try {
    const result: Record<string, readonly IntegrationReconciliationRead[]> = {};
    for (const workPackageId of workPackageIds) {
      const read = opened.store.query({
        kind: 'integration-reconciliations',
        coordinationScopeId: coordinationScopeId as CoordinationScopeId,
        workPackageId: workPackageId as WorkPackageId,
      });
      result[workPackageId] =
        read.kind === 'integration-reconciliations'
          ? read.records.map((record) => ({
              workPackageId,
              reconciliationId: record.reconciliationId,
              round: record.round,
              validationAttemptId: record.validationAttemptId,
              sourceAcceptedResultRef: record.sourceAcceptedResultRef,
              targetHead: record.targetHead,
              mergedTreeRef: record.mergedTreeRef,
              orcaTaskId: record.orcaTaskId,
              dispatchId: record.dispatchId,
              state: record.state,
              blockerRef: record.blockerRef,
              createdAt: record.createdAt,
            }))
          : [];
    }
    return result;
  } finally {
    opened.close();
  }
}

/** 恢复模式：从既有 Scope 读回身份与 Run，不重新播种、不重新批准。 */
async function readExistingScopeIdentity(workspace: string): Promise<{
  readonly coordinationScopeId: string;
  readonly orcaRunId: string;
  readonly baselineHead: string;
}> {
  const opened = await openRepositoryCoordinationStore({
    repositoryPath: workspace,
    env: toChildEnvironment(process.env),
    readOnly: true,
  });
  if (opened.kind !== 'opened') {
    throw new Error(`无法打开协调状态：${JSON.stringify(opened)}`);
  }
  try {
    const scopes = opened.store.query({ kind: 'scopes' });
    const scope = scopes.kind === 'scopes' ? scopes.scopes[0] : undefined;
    if (scope === undefined) throw new Error('隔离项目没有可恢复的 Coordination Scope');
    const generations = opened.store.query({
      kind: 'graph-generations',
      coordinationScopeId: scope.coordinationScopeId,
    });
    const generation = generations.kind === 'graph-generations' ? generations.generations[0] : undefined;
    if (generation === undefined) throw new Error('既有 Scope 没有图世代记录');
    return {
      coordinationScopeId: scope.coordinationScopeId,
      orcaRunId: generation.orcaRunId,
      baselineHead: generation.baselineHead,
    };
  } finally {
    opened.close();
  }
}

/** 从既有 Scope 读回已物化的 planner Task 与真实 ctx 派发身份，用于核验恢复未重派。 */
async function readOriginalIds(
  workspace: string,
  coordinationScopeId: string,
): Promise<{ readonly tasks: readonly string[]; readonly dispatches: readonly string[] }> {
  const opened = await openRepositoryCoordinationStore({
    repositoryPath: workspace,
    env: toChildEnvironment(process.env),
    readOnly: true,
  });
  if (opened.kind !== 'opened') {
    throw new Error(`无法打开协调状态：${JSON.stringify(opened)}`);
  }
  try {
    const scopeId = coordinationScopeId as CoordinationScopeId;
    const bindings = opened.store.query({ kind: 'materialization-bindings', coordinationScopeId: scopeId });
    const segments = opened.store.query({ kind: 'session-segments', coordinationScopeId: scopeId });
    const tasks =
      bindings.kind === 'materialization-bindings'
        ? bindings.bindings
            .filter((binding) => binding.role === 'planner' && binding.orcaTaskId !== null)
            .map((binding) => `${binding.workPackageId}|${binding.role}|${String(binding.orcaTaskId)}`)
            .sort()
        : [];
    const dispatches =
      segments.kind === 'session-segments'
        ? segments.segments
            .filter((segment) => segment.role === 'planner')
            .map((segment) => `${segment.workPackageId}|${segment.role}|${segment.dispatchId}`)
            .sort()
        : [];
    return { tasks, dispatches };
  } finally {
    opened.close();
  }
}

/**
 * 原 Validator 的 Attempt 与精确 provider session；复验必须落在同一条会话上。
 *
 * 只从**已有事实**组装：`materialization_bindings`（validator 的 business attempt）与 `session_segments`
 * （该 Validator 的真实 dispatch 与 session binding）。记录里没有 provider 字段就不推断、不强转。
 */
async function readValidatorOrigin(
  workspace: string,
  coordinationScopeId: string,
  workPackageIds: readonly string[],
): Promise<Record<string, ValidatorOrigin>> {
  const opened = await openRepositoryCoordinationStore({
    repositoryPath: workspace,
    env: toChildEnvironment(process.env),
    readOnly: true,
  });
  if (opened.kind !== 'opened') {
    throw new Error(`无法打开协调状态：${JSON.stringify(opened)}`);
  }
  try {
    const scopeId = coordinationScopeId as CoordinationScopeId;
    const result: Record<string, ValidatorOrigin> = {};
    for (const workPackageId of workPackageIds) {
      const bindings = opened.store.query({
        kind: 'materialization-bindings',
        coordinationScopeId: scopeId,
        workPackageId: workPackageId as WorkPackageId,
      });
      const segments = opened.store.query({
        kind: 'session-segments',
        coordinationScopeId: scopeId,
        workPackageId: workPackageId as WorkPackageId,
      });
      const binding =
        bindings.kind === 'materialization-bindings'
          ? bindings.bindings.find((entry) => entry.role === 'validator')
          : undefined;
      const segment =
        segments.kind === 'session-segments'
          ? segments.segments.find((entry) => entry.role === 'validator')
          : undefined;
      result[workPackageId] = {
        attemptId: binding?.attemptId ?? null,
        dispatchId: segment?.dispatchId ?? null,
        sessionBindingId: segment?.sessionBindingId ?? null,
        launchId: binding?.launchId ?? null,
        orcaTaskId: binding?.orcaTaskId ?? null,
      };
    }
    return result;
  } finally {
    opened.close();
  }
}


/**
 * 复用生产 `codexSessionPathsUnder` 读精确 SessionStart 报告：不自行 hash、不扫描 reporters 目录。
 * 只解析第一行，字段取自 reporter 约定；无 secret（只有不透明 id 与路径）。
 */
async function readSessionStartReport(
  workspace: string,
  launchId: string,
): Promise<{ readonly reportPath: string; readonly sessionId: string | null }> {
  const commonDir = await resolveGitCommonDir({
    repositoryPath: workspace,
    env: toChildEnvironment(process.env),
  });
  if (commonDir.kind !== 'resolved') {
    throw new Error(`无法解析 Git common dir：${JSON.stringify(commonDir)}`);
  }
  const paths = codexSessionPathsUnder(join(commonDir.path, COMPANION_STATE_DIRECTORY), launchId);
  if (!existsSync(paths.reportPath)) {
    return { reportPath: paths.reportPath, sessionId: null };
  }
  const firstLine = readFileSync(paths.reportPath, 'utf8')
    .split('\n')
    .find((line) => line.trim().length > 0);
  if (firstLine === undefined) {
    return { reportPath: paths.reportPath, sessionId: null };
  }
  try {
    const parsed = JSON.parse(firstLine) as { readonly sessionId?: unknown };
    return {
      reportPath: paths.reportPath,
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : null,
    };
  } catch {
    return { reportPath: paths.reportPath, sessionId: null };
  }
}

/**
 * 只读检查隔离 fixture 的 Companion 数据库中当前图的占位历史；生产查询仅返回当前占位。
 * Manifest 仍通过应用 store 读取；此取证不访问 Orca 数据库，也不修改运行状态。
 */
async function readLaneAndAuthorizationEvidence(
  workspace: string,
  coordinationScopeId: string,
): Promise<{
  readonly lanes: readonly {
    readonly workPackageId: string;
    readonly baselineHead: string;
    readonly releasedAt: number | null;
    readonly authorizationId: string;
  }[];
  readonly approvalAuthorizationId: string | null;
  readonly approvedMaxActiveWorkPackages: number | null;
}> {
  const opened = await openRepositoryCoordinationStore({
    repositoryPath: workspace,
    env: toChildEnvironment(process.env),
    readOnly: true,
  });
  if (opened.kind !== 'opened') {
    throw new Error(`无法打开协调状态：${JSON.stringify(opened)}`);
  }
  try {
    const scopeId = coordinationScopeId as CoordinationScopeId;
    const scopeRead = opened.store.query({ kind: 'scope', coordinationScopeId: scopeId });
    if (scopeRead.kind !== 'scope' || scopeRead.scope?.graphId == null) {
      throw new Error('当前图身份不可读');
    }
    const commonDir = await resolveGitCommonDir({ repositoryPath: workspace, env: toChildEnvironment(process.env) });
    if (commonDir.kind !== 'resolved') throw new Error('隔离项目 Git common dir 不可读');
    const database = new DatabaseSync(coordinationDatabasePath(commonDir.path), { readOnly: true });
    let lanes;
    try {
      lanes = database.prepare(`SELECT work_package_id AS workPackageId, baseline_head AS baselineHead,
        released_at AS releasedAt, authorization_id AS authorizationId FROM work_package_lanes
        WHERE coordination_scope_id = ? AND graph_id = ? ORDER BY work_package_id`)
        .all(scopeId, scopeRead.scope.graphId) as {
          workPackageId: string; baselineHead: string; releasedAt: number | null; authorizationId: string;
        }[];
    } finally {
      database.close();
    }
    const approvalAuthorizationId = lanes[0]?.authorizationId ?? null;
    let approvedMaxActiveWorkPackages: number | null = null;
    if (approvalAuthorizationId !== null) {
      const authorizationRead = opened.store.query({
        kind: 'authorization',
        coordinationScopeId: scopeId,
        authorizationId: approvalAuthorizationId,
      });
      if (authorizationRead.kind === 'authorization' && authorizationRead.authorization !== null) {
        approvedMaxActiveWorkPackages = authorizationRead.authorization.manifest.limits.maxActiveWorkPackages;
      }
    }
    return { lanes, approvalAuthorizationId, approvedMaxActiveWorkPackages };
  } finally {
    opened.close();
  }
}

describe.skipIf(!enabled)('多包并发真实闭环（隔离项目）', () => {
  test(
    '额度 5 可配置、两个独立包同 base 同时 live、乱序集成经原 Validator 续接并取得 Finalizer Verdict',
    async () => {
      const env = process.env as Record<string, string>;

      // 项目配置本身就是「额度可配置且大于 3」的证据（不是硬编码 3，也不是运行时补丁）。
      const config = JSON.parse(readFileSync(join(isolatedRepo, 'orca-companion.json'), 'utf8')) as {
        readonly execution?: { readonly limits?: { readonly maxActiveWorkPackages?: number } };
      };
      expect(
        config.execution?.limits?.maxActiveWorkPackages,
        '隔离项目的并行额度必须大于设计时的保守假定 3',
      ).toBe(ACCEPTANCE_MAX_ACTIVE_PACKAGES);

      // ---- 身份：默认播种新 Scope；恢复模式复用既有 Scope（不重新批准、不重建图、不重派 Task） ----
      const resume = process.env[RESUME_SWITCH] === '1';
      const identity = resume
        ? await readExistingScopeIdentity(isolatedRepo)
        : await seedRealExecutionScope({
            workspace: isolatedRepo,
            identity: dedicatedIdentity,
            objective: 'restore-configurable-execution-concurrency 多包并发验收',
            plan: REAL_LOOP_PLAN,
            limits: ACCEPTANCE_LIMITS,
            env,
          });
      const runId = identity.orcaRunId;
      // 报告按 fixture 标签命名，避免不同现场互相覆盖。
      const fixtureTag = basename(isolatedRepo).replace(/[^A-Za-z0-9._-]/g, '_');
      // 恢复模式：在重启宿主**之前**读当前 Scope 的实际原始身份，用于事后比较是否重派；不引外部证据文件。
      const originalIdsBefore = resume
        ? await readOriginalIds(isolatedRepo, identity.coordinationScopeId)
        : null;
      const backend = createOrcaExecutionBackend({
        cwd: isolatedRepo,
        env,
        resolveIdentityHandle: (ref) => Promise.resolve(ref === dedicatedIdentity ? ref : undefined),
      });

      // ---- 宿主：启动对账 → 授权审阅（额度必须在用户可见的 Manifest 行里） → 批准 ----
      let host: ForegroundPlanningHost = await createForegroundPlanningHost({ repositoryPath: isolatedRepo, env });
      const rounds = { triggers: 0, samples: 0 };
      const observation = {
        maxActivePackages: 0,
        maxUnconcluded: 0,
        peakOverlap: 0,
        activePackageIds: [] as string[],
      };

      // 失败也要留盘：把已知事实持续写入 partial evidence，不依赖测试末段成功。
      const evidenceState: {
        lastStatus: StatusSnapshot | null;
        lastIntervals: readonly DispatchInterval[];
        sameOriginalIds: boolean;
        sameOriginalIdsApplied: boolean;
        originalIdsBefore: { readonly tasks: readonly string[]; readonly dispatches: readonly string[] } | null;
        originalIdsAfter: { readonly tasks: readonly string[]; readonly dispatches: readonly string[] } | null;
        reportWritten: boolean;
      } = {
        lastStatus: null,
        lastIntervals: [],
        sameOriginalIds: true,
        sameOriginalIdsApplied: false,
        originalIdsBefore,
        originalIdsAfter: null,
        reportWritten: false,
      };
      const writeEvidence = (phase: string): void => {
        const status = evidenceState.lastStatus;
        const payload = {
          generatedAt: new Date().toISOString(),
          phase,
          fixture: {
            repository: isolatedRepo,
            identity: dedicatedIdentity,
            coordinationScopeId: identity.coordinationScopeId,
            orcaRunId: runId,
            baselineHead: identity.baselineHead,
            resumed: resume,
          },
          approvedMaxActiveWorkPackages: ACCEPTANCE_MAX_ACTIVE_PACKAGES,
          configuredMaxActiveWorkPackages: config.execution?.limits?.maxActiveWorkPackages ?? null,
          observation,
          rounds,
          sameOriginalIds: evidenceState.sameOriginalIds,
          sameOriginalIdsApplied: evidenceState.sameOriginalIdsApplied,
          originalIdsBefore: evidenceState.originalIdsBefore,
          originalIdsAfter: evidenceState.originalIdsAfter,
          dispatchIntervals: evidenceState.lastIntervals,
          workPackages: status === null ? [] : status.execution.workPackages.map((entry) => ({
            workPackageId: entry.workPackageId,
            state: entry.state,
            role: entry.role,
            attemptId: entry.attemptId,
          })),
          finalizer: status === null ? null : { verdict: status.execution.finalizer.verdict, gate: status.execution.finalizer.gate },
          blockers: status === null ? [] : status.blockers,
        };
        mkdirSync(ARTIFACT_DIRECTORY, { recursive: true });
        const path = join(
          ARTIFACT_DIRECTORY,
          `report-${fixtureTag}-${resume ? 'resume' : 'seed'}-partial.json`,
        );
        writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
        console.warn(`[concurrency] evidence(${phase})=${path}`);
      };
      try {
        const home = await host.ports.scopeSetup.resolveHome();
        expect(home.kind, `Scope 无法恢复：${JSON.stringify(home)}`).toBe('restore');
        // 恢复不总是已授权：既有 Scope 若仍停在 planning（例如批准阶段失败），仍走完整审阅/批准，
        // 但不重新 seed、不重建图。只有已在 execution_coordination 才跳过。
        const hostedBefore = await host.ports.snapshot(null);
        const alreadyApproved =
          hostedBefore.kind === 'snapshot' && hostedBefore.snapshot.mode === 'execution_coordination';
        if (!alreadyApproved) {
          const review = await host.ports.executionAuthorization.review();
          expect(review.kind, `授权审阅被阻塞：${JSON.stringify(review)}`).toBe('review');
          if (review.kind !== 'review') {
            return;
          }
          const limitsRow = review.review.manifestRows.find((row) => row.label === 'Limits');
          // 额度不是硬编码 3：用户看到的正是本次批准的 5。
          expect(limitsRow?.value ?? '').toContain(`并行≤${String(ACCEPTANCE_MAX_ACTIVE_PACKAGES)}`);
          const approved = await host.ports.executionAuthorization.approve({
            fingerprint: review.review.fingerprint,
            expectedRevision: review.review.scopeRevision,
          });
          expect(approved.kind, `授权批准失败：${JSON.stringify(approved)}`).toBe('accepted');
        }

        // ---- 触发点：Pause/Resume 触发一次执行推进；一次触发会按额度填满可用 lane ----
        const trigger = async (): Promise<void> => {
          // 只重试尚未受理的模型启动拒绝；每次仍执行完整能力核验，业务拒绝立即失败。
          const ready = await pollUntil(async () => {
            const paused = await host.ports.execute({ kind: 'scope-control', action: 'pause' });
            console.warn('[pause] ' + JSON.stringify(paused));
            if (paused.kind === 'rejected' && paused.code === 'session_unavailable') return false;
            expect(paused.kind, `Pause 被拒绝：${JSON.stringify(paused)}`).toBe('accepted');
            return true;
          }, 30_000, 180_000);
          expect(ready, '模型启动能力核验持续不可用').toBe(true);
          const resumed = await host.ports.execute({ kind: 'scope-control', action: 'resume' });
          // 先记录再断言：被 idle 覆盖前的第一次真实 Result 必须留下。
          console.warn('[trigger] ' + JSON.stringify({ resumed }));
          expect(resumed.kind, `Resume 被拒绝：${JSON.stringify(resumed)}`).toBe('accepted');
          rounds.triggers += 1;
        };

        const sample = async (): Promise<StatusSnapshot> => {
          const snapshot = await readStatus(isolatedRepo);
          evidenceState.lastStatus = snapshot;
          const unconcluded = await unconcludedWorkerCount(backend, runId);
          const active = snapshot.execution.activeWorkPackageIds;
          observation.maxActivePackages = Math.max(observation.maxActivePackages, active.length);
          if (unconcluded !== null) {
            observation.maxUnconcluded = Math.max(observation.maxUnconcluded, unconcluded);
          }
          for (const id of active) {
            if (!observation.activePackageIds.includes(id)) {
              observation.activePackageIds.push(id);
            }
          }
          // 宿主内存 blocker 只能经 ports.snapshot 读；store-only 的 status 看不到。每 3 次采样打一次。
          if (rounds.samples % 3 === 0) {
            const hosted = await host.ports.snapshot(null);
            if (hosted.kind === 'snapshot') {
              console.warn('[host] ' + JSON.stringify({
                control: hosted.snapshot.controlState,
                active: hosted.snapshot.activeWorkPackageIds,
                blockers: hosted.snapshot.blockers.map((b) => [b.source, b.code, b.message]),
                frontier: hosted.snapshot.frontier.map((e) => [e.workPackageId, e.state, e.role, e.liveness, e.blockerRefs]),
                recon: hosted.snapshot.executionReconciliation,
              }));
            } else {
              console.warn('[host] snapshot failed: ' + hosted.code + ' ' + hosted.message);
            }
          }
          // 每 6 次采样落一次公共 dispatch 区间：这样即使后续失败，峰值证据也已写盘。
          if (rounds.samples % 6 === 0) {
            evidenceState.lastIntervals = await readDispatchIntervals(env, runId);
            // 采样即落盘：这样被外部停掉时磁盘上仍有截至当时的现场。
            writeEvidence('sampled');
          }
          rounds.samples += 1;
          return snapshot;
        };

        // 已有持久化 Verdict 的恢复只核验原事实，不为已完成的执行启动模型。
        if ((await readStatus(isolatedRepo)).execution.finalizer.verdict === null) await trigger();
        const deadline = Date.now() + 60 * 60_000;
        let snapshot = await sample();
        let lastTriggerAt = Date.now();
        let allAcceptedSince: number | null = null;
        // 终态只有「Finalizer Verdict」与「明确 blocked」两种；全部包 accepted 后仍要给 Finalizer
        // 一个有限的收尾窗口（它由触发点驱动），窗口耗尽即停，避免无限等待。
        const finished = (): boolean =>
          snapshot.execution.finalizer.verdict !== null ||
          snapshot.execution.workPackages.some((entry) => entry.state === 'blocked');
        while (Date.now() < deadline && !finished()) {
          const allAccepted =
            snapshot.execution.workPackages.length > 0 &&
            snapshot.execution.workPackages.every((entry) => entry.state === 'accepted');
          if (allAccepted) {
            allAcceptedSince ??= Date.now();
            if (Date.now() - allAcceptedSince > 10 * 60_000) {
              break;
            }
          } else {
            allAcceptedSince = null;
          }
          // 对账可与在途 Worker 并行；局部不可核验不能挡住其它包已到达的 Delivery。
          // Scope 控制不停止现有 Worker，应用层的 lane/意图准入负责防止重复派发。
          if (Date.now() - lastTriggerAt >= 20_000) {
            await trigger();
            lastTriggerAt = Date.now();
          }
          await sleep(5_000);
          snapshot = await sample();
        }

        // ---- 结论：先固定观测事实，再逐项判定（缺一项都如实失败） ----
        const reconciliations = await readReconciliations(
          isolatedRepo,
          identity.coordinationScopeId,
          snapshot.execution.workPackages.map((entry) => entry.workPackageId),
        );
        const allReconciliations = Object.values(reconciliations).flat();
        const validatorOrigins = await readValidatorOrigin(
          isolatedRepo,
          identity.coordinationScopeId,
          snapshot.execution.workPackages.map((entry) => entry.workPackageId),
        );
        const laneEvidence = await readLaneAndAuthorizationEvidence(isolatedRepo, identity.coordinationScopeId);
        const validated = allReconciliations.filter((record) => record.state === 'validated');
        const verdict = snapshot.execution.finalizer.verdict;

        // 恢复模式不重算峰：核验恢复前后当前 Scope 的实际 planner Task/真实 ctx 未变（不重派）。
        if (resume && originalIdsBefore !== null) {
          // 只有“运行前就已经存在原 planner 身份”时该比较才有意义；首次恢复（before 为空）不算 noDuplicate。
          evidenceState.sameOriginalIdsApplied = originalIdsBefore.tasks.length > 0;
          const after = await readOriginalIds(isolatedRepo, identity.coordinationScopeId);
          evidenceState.originalIdsAfter = after;
          if (evidenceState.sameOriginalIdsApplied) {
            evidenceState.sameOriginalIds =
              JSON.stringify(after.tasks) === JSON.stringify(originalIdsBefore.tasks) &&
              JSON.stringify(after.dispatches) === JSON.stringify(originalIdsBefore.dispatches);
          }
        }

        // 公共证据：用 worker-show 的起止时间计算真实重叠并发峰值（不把 ready 猜成 live）。
        const dispatchIntervals = await readDispatchIntervals(env, runId);
        observation.peakOverlap = peakOverlap(dispatchIntervals);
        evidenceState.lastIntervals = dispatchIntervals;

        const report = {
          generatedAt: new Date().toISOString(),
          fixture: {
            repository: isolatedRepo,
            identity: dedicatedIdentity,
            coordinationScopeId: identity.coordinationScopeId,
            orcaRunId: runId,
            baselineHead: identity.baselineHead,
            resumed: resume,
          },
          approvedMaxActiveWorkPackages: ACCEPTANCE_MAX_ACTIVE_PACKAGES,
          configuredMaxActiveWorkPackages: config.execution?.limits?.maxActiveWorkPackages ?? null,
          observation,
          rounds,
          resumed: resume,
          sameOriginalIds: evidenceState.sameOriginalIds,
          sameOriginalIdsApplied: evidenceState.sameOriginalIdsApplied,
          originalIdsBefore: evidenceState.originalIdsBefore,
          originalIdsAfter: evidenceState.originalIdsAfter,
          dispatchIntervals,
          workPackages: snapshot.execution.workPackages.map((entry) => ({
            workPackageId: entry.workPackageId,
            state: entry.state,
            role: entry.role,
            attemptId: entry.attemptId,
          })),
          reconciliations,
          validatorOrigins,
          laneEvidence,
          finalizer: { verdict, gate: snapshot.execution.finalizer.gate },
          blockers: snapshot.blockers,
        };
        mkdirSync(ARTIFACT_DIRECTORY, { recursive: true });
        const reportPath = join(
          ARTIFACT_DIRECTORY,
          `report-${fixtureTag}-${resume ? 'resume' : 'seed'}.json`,
        );
        writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
        evidenceState.reportWritten = true;
        console.warn(`[concurrency] report=${reportPath}`);

        // 1. 并发峰用公共起止时间的重叠证明：>=2 个真实 dispatch 区间重叠（不把 ready 当 live）。
        // 独立 lane/批准证据：lane 的持久 baselineHead 必须等于 fixture 初始 HEAD（released lane 也保留）；
        // 批准额度必须来自当前 Execution Authorization Manifest 的读取，而不是常量字段。
        expect(laneEvidence.lanes.length, '缺少 lane reservation 证据').toBeGreaterThanOrEqual(2);
        for (const lane of laneEvidence.lanes) {
          expect(
            lane.baselineHead,
            `lane ${lane.workPackageId} 的持久 baselineHead 与 fixture 初始 HEAD 不一致`,
          ).toBe(identity.baselineHead);
        }
        expect(
          laneEvidence.approvedMaxActiveWorkPackages,
          '批准额度必须来自当前 Execution Authorization Manifest 的读取',
        ).toBe(ACCEPTANCE_MAX_ACTIVE_PACKAGES);
        expect(
          observation.peakOverlap,
          `没有公共证据证明两个 Worker 同时运行；intervals=${JSON.stringify(dispatchIntervals)}`,
        ).toBeGreaterThanOrEqual(MIN_SIMULTANEOUS_LIVE_WORKERS);
        if (resume) {
          // 原事实保留：同批原始 planner Task/ctx 身份不得重派。
          if (evidenceState.sameOriginalIdsApplied) {
            expect(evidenceState.sameOriginalIds, '恢复后原 planner Task/ctx 身份必须保持不变（未重派）').toBe(true);
          }
        } else {
          expect(
            observation.maxActivePackages,
            '没有观测到两个 Work Package 同时活动：并发未被真实使用',
          ).toBeGreaterThanOrEqual(MIN_SIMULTANEOUS_ACTIVE);
        }
        // 3. 乱序集成必须经过原 Validator 精确续接的复验轮次。
        expect(
          validated.length,
          `没有 validated 的集成复验轮次：${JSON.stringify(allReconciliations)}`,
        ).toBeGreaterThanOrEqual(1);
        // 独立 provider UUID 证据：原 Validator 的 SessionStart 报告 + 复验之后新增的 SessionStart 报告。
        const sessionStartEvidence: {
          readonly workPackageId: string;
          readonly round: number;
          readonly originalLaunchId: string;
          readonly continuationLaunchId: string;
          readonly originalReportPath: string;
          readonly continuationReportPath: string;
          readonly originalSessionId: string | null;
          readonly continuationSessionId: string | null;
          readonly sameProviderSession: boolean;
          readonly originalDispatchId: string | null;
          readonly continuationDispatchId: string | null;
        }[] = [];
        for (const record of validated) {
          // 复验不产生新的 Validation Attempt：必须绑定原 Attempt，并记录 Orca 真实分配的续接身份。
          expect(record.validationAttemptId.length).toBeGreaterThan(0);
          expect(record.sourceAcceptedResultRef.length).toBeGreaterThan(0);
          expect(record.dispatchId, `复验未记录 Orca 续接 Dispatch：${record.reconciliationId}`).not.toBeNull();
          expect(record.mergedTreeRef, `复验未记录合并树：${record.reconciliationId}`).not.toBeNull();
          // fail closed：原 Validator 的 Attempt/Dispatch 必须存在，缺一项就不是可比较的证据。
          const origin = validatorOrigins[record.workPackageId];
          expect(origin, `缺少原 Validator 事实：${record.workPackageId}`).toBeDefined();
          expect(origin?.attemptId, `原 Validator Attempt 缺失：${record.workPackageId}`).not.toBeNull();
          expect(origin?.dispatchId, `原 Validator Dispatch 缺失：${record.workPackageId}`).not.toBeNull();
          expect(origin?.orcaTaskId, `原 Validator Orca Task 缺失：${record.workPackageId}`).not.toBeNull();
          if (origin === undefined || origin.attemptId === null || origin.dispatchId === null) {
            throw new Error(`原 Validator 事实缺失（fail closed）：${record.workPackageId}`);
          }
          expect(record.validationAttemptId, `复验未绑定原 Validator Attempt：${record.reconciliationId}`).toBe(origin.attemptId);
          expect(record.dispatchId, `续接 Dispatch 必须不同于原 Validator Dispatch：${record.reconciliationId}`).not.toBe(origin.dispatchId);
          expect(
            record.orcaTaskId,
            `续接 Orca Task 必须不同于原 Validator Task：${record.reconciliationId}`,
          ).not.toBe(origin.orcaTaskId);
          // provider session 连续性：复用生产 path helper，按 SSOT 读原 Validator 与续接的精确报告。
          expect(origin.launchId, `原 Validator launchId 缺失：${record.workPackageId}`).not.toBeNull();
          if (origin.launchId === null) {
            throw new Error(`原 Validator launchId 缺失（fail closed）：${record.workPackageId}`);
          }
          const continuationLaunchId = `${origin.launchId}:round-${String(record.round)}`;
          const originalReport = await readSessionStartReport(isolatedRepo, origin.launchId);
          const continuationReport = await readSessionStartReport(isolatedRepo, continuationLaunchId);
          expect(originalReport.sessionId, `原 Validator 的 SessionStart 报告缺少 provider uuid：${record.workPackageId}`).toBeTruthy();
          expect(continuationReport.sessionId, `续接的 SessionStart 报告缺少 provider uuid：${continuationLaunchId}`).toBeTruthy();
          const sameProviderSession =
            originalReport.sessionId !== null && continuationReport.sessionId === originalReport.sessionId;
          sessionStartEvidence.push({
            workPackageId: record.workPackageId,
            round: record.round,
            originalLaunchId: origin.launchId,
            continuationLaunchId,
            originalReportPath: originalReport.reportPath,
            continuationReportPath: continuationReport.reportPath,
            originalSessionId: originalReport.sessionId,
            continuationSessionId: continuationReport.sessionId,
            sameProviderSession,
            originalDispatchId: origin.dispatchId,
            continuationDispatchId: record.dispatchId,
          });
          expect(sameProviderSession, `复验后的 SessionStart 未复用原 provider session：${record.workPackageId}`).toBe(true);
        }
        // 4. 完整闭环取得 Finalizer Verdict。
        // 独立 UUID 证据单独落盘（报告在此之后才断言，避免顺序耦合）。
        const sessionEvidencePath = join(
          ARTIFACT_DIRECTORY,
          `session-starts-${fixtureTag}-${resume ? 'resume' : 'seed'}.json`,
        );
        writeFileSync(
          sessionEvidencePath,
          `${JSON.stringify({ generatedAt: new Date().toISOString(), fixture: fixtureTag, resumed: resume, evidence: sessionStartEvidence }, null, 2)}\n`,
        );
        console.warn(`[concurrency] session-start evidence=${sessionEvidencePath}`);
        expect(verdict, `未取得 Finalizer Verdict；blockers=${snapshot.blockers.map((b) => b.code).join(',')}`).not.toBeNull();
        expect(verdict?.kind).toBe('deliverable');

        // ---- 重启：读回同一批身份，不产生新的派发 ----
        host.close();
        const released = await pollUntil(
          async () => !runtimeLeaseHeld(await readStatus(isolatedRepo)),
          5_000,
          120_000,
        );
        expect(released, 'Runtime Lease 未在预期时间内过期').toBe(true);
        host = await createForegroundPlanningHost({ repositoryPath: isolatedRepo, env });
        await host.ports.snapshot(null);
        const restarted = await readStatus(isolatedRepo);
        expect(
          restarted.execution.workPackages.map((entry) => [entry.workPackageId, entry.state, entry.attemptId]),
        ).toEqual(
          snapshot.execution.workPackages.map((entry) => [entry.workPackageId, entry.state, entry.attemptId]),
        );
      } finally {
        writeEvidence('partial');
        host.close();
      }
    },
    3_600_000,
  );
});
