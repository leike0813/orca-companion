/**
 * IP-08：前台执行运行时的真实集成冒烟（显式隔离项目 + 专用 Orca 身份）。
 *
 * 它只做**真实环境**才能证明的事：在一次性的隔离 Git 项目里以专用 Orca 身份启动前台宿主，验证启动
 * 对账序列在当前 Orca 上真的跑通、Execution Authorization 的审阅只从权威事实组装、并且在候选图尚不
 * 存在时明确拒绝批准（不产生任何授权记录）。
 *
 * ```sh
 * ORCA_COMPANION_E2E_REPO=<isolated-path> \
 * ORCA_COMPANION_E2E_IDENTITY=<dedicated-identity> \
 * pnpm exec vitest run tests/integration/foreground-execution-runtime.test.ts --no-file-parallelism
 * ```
 *
 * 未显式设置这两个变量时整个文件只留一条 skip 记录：不打开隔离项目、不调用 Orca、不启动 Worker。
 * `ORCA_COMPANION_E2E_IDENTITY` 是**前置声明**，不是注入点：专用身份必须已经是本进程所连 Orca 环境里
 * 可用的协调身份（例如在该专用身份对应的终端/host scope 内运行），因此文件只断言它被显式给出，不去
 * 伪造一个身份。
 *
 * 再加 `ORCA_COMPANION_E2E_LOOP=1` 时，本文件还会在**尚没有 Scope** 的隔离项目里跑一次真实执行闭环
 * （第二组用例）：用真实 Orca 后端与专用身份把候选图与 Run 播种进去，再经宿主的授权审阅/批准进入
 * Execution Coordination，然后反复触发执行推进直到出现终态或明确 blocker，最后重启宿主核对没有重复
 * 派发。候选图的播种调用与宿主工具路径同一个用例（`proposeExecutionGraph`），模型驱动的规划路径仍归
 * 规划 TUI 的验收；这样真实验证集中在授权与执行阶段。该组用例只对全新项目有效，已存在 Scope 时显式
 * skip，不覆盖既有状态。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { runProcess } from '../../src/adapters/orca-cli/process-runner.js';
import { createOrcaExecutionBackend } from '../../src/adapters/orca-cli/orca-backend.js';
import { CODEX_FULL_ACCESS_RISK } from '../../src/bootstrap/project-config.js';
import { openRepositoryCoordinationStore } from '../../src/bootstrap/composition.js';
import {
  createForegroundPlanningHost,
  type ForegroundPlanningHost,
} from '../../src/bootstrap/foreground-planning-runtime.js';
import { runStatus, type StatusSnapshot } from '../../src/interfaces/cli/status-command.js';
import { toChildEnvironment } from '../../src/interfaces/cli/main.js';
import { REAL_LOOP_SINGLE_PLAN, seedRealExecutionScope } from '../support/real-execution-scope.js';

const REPO_VAR = 'ORCA_COMPANION_E2E_REPO';
const IDENTITY_VAR = 'ORCA_COMPANION_E2E_IDENTITY';
const LOOP_SWITCH = 'ORCA_COMPANION_E2E_LOOP';
/** 计划要求的 Worker 模型；凭据只留在 provider 环境变量里，本文件不读也不打印。 */
const REQUIRED_WORKER_MODEL = 'minimax-cn/MiniMax-M3.1-Flash-Preview';

type RealProjectConfig = {
  readonly execution?: {
    readonly workerProfiles?: readonly { readonly role: string; readonly modelSelection: { readonly model: string } }[];
    readonly acceptedRisks?: unknown;
  };
};

/** 项目 schema2 为每个生产角色固定 profile 与模型；宿主不会替用户挑一个模型。 */
function workerModelsByRole(config: RealProjectConfig): Record<string, string> {
  const models: Record<string, string> = {};
  for (const profile of config.execution?.workerProfiles ?? []) {
    models[profile.role] = profile.modelSelection.model;
  }
  return models;
}

const isolatedRepo = process.env[REPO_VAR] ?? '';
const dedicatedIdentity = process.env[IDENTITY_VAR] ?? '';
const enabled = isolatedRepo.length > 0 && dedicatedIdentity.length > 0;
const loopEnabled = enabled && process.env[LOOP_SWITCH] === '1';

if (!enabled) {
  test.skip(
    `真实执行闭环未开启：需要 ${REPO_VAR}（一次性隔离项目）与 ${IDENTITY_VAR}（专用 Orca 身份）`,
    () => undefined,
  );
}

describe.skipIf(!enabled)('前台执行运行时的真实集成冒烟', () => {
  let baselineStatus = '';

  test('宿主在隔离项目上启动：读权威事实，并在缺少候选图时拒绝批准', async () => {
    expect(isolatedRepo.startsWith('/')).toBe(true);
    expect(existsSync(join(isolatedRepo, 'orca-companion.json'))).toBe(true);
    const config = JSON.parse(readFileSync(join(isolatedRepo, 'orca-companion.json'), 'utf8')) as RealProjectConfig;
    // Worker 模型必须由隔离项目的配置显式给出：宿主不会替用户挑一个模型。
    expect(workerModelsByRole(config)).toEqual({
      planner: REQUIRED_WORKER_MODEL,
      implementation: REQUIRED_WORKER_MODEL,
      validator: REQUIRED_WORKER_MODEL,
      finalizer: REQUIRED_WORKER_MODEL,
    });
    const baseline = await runProcess({
      executable: 'git',
      args: ['status', '--porcelain', '--untracked-files=all'],
      cwd: isolatedRepo,
      env: process.env as Record<string, string>,
      timeoutMs: 60_000,
    });
    expect(baseline.kind).toBe('completed');
    baselineStatus = baseline.kind === 'completed' ? baseline.stdout.text.trim() : '';

    const host = await createForegroundPlanningHost({
      repositoryPath: isolatedRepo,
      env: process.env as Record<string, string>,
    });
    try {
      const readiness = host.readiness();
      expect(readiness.blocker).toBeNull();
      expect(readiness.canonicalWorktreePath).toBe(isolatedRepo);
      expect(readiness.fullBranchRef).not.toBeNull();

      // 隔离项目可在多次真实冒烟之间复用同一个 Scope。
      const home = await host.ports.scopeSetup.resolveHome();
      let scopeId: string;
      if (home.kind === 'wizard') {
        const proposal = await host.ports.scopeSetup.proposal();
        expect(proposal.canonicalWorktree).toBe(isolatedRepo);
        expect((await host.ports.scopeSetup.initialize(proposal)).kind).toBe('accepted');
        scopeId = proposal.coordinationScopeId;
      } else {
        expect(home.kind).toBe('restore');
        if (home.kind !== 'restore') {
          throw new Error(`隔离项目无法恢复 Scope：${JSON.stringify(home)}`);
        }
        scopeId = home.coordinationScopeId;
      }

      const loaded = await host.ports.snapshot(null);
      if (loaded.kind !== 'snapshot') {
        throw new Error(`无法读取快照：${loaded.code} ${loaded.message}`);
      }
      expect(['route_planning', 'execution_coordination']).toContain(loaded.snapshot.mode);
      expect(loaded.snapshot.coordinationScopeId).toBe(scopeId);

      // 审阅只读：已有 Execution Authorization 的隔离项目同样可重复冒烟。
      const review = await host.ports.executionAuthorization.review();
      if (loaded.snapshot.mode === 'execution_coordination') {
        expect(review.kind).toBe('rejected');
      } else {
        expect(['blocked', 'review']).toContain(review.kind);
      }

      const after = await host.ports.snapshot(null);
      if (after.kind !== 'snapshot') {
        throw new Error(`无法读取快照：${after.code} ${after.message}`);
      }
      // 审阅不修改模式、授权或 lease 归属。
      expect(after.snapshot.mode).toBe(loaded.snapshot.mode);
      expect(after.snapshot.authorization).toEqual(loaded.snapshot.authorization);
      expect(after.snapshot.executionLeaseHolderSessionId).toBe(loaded.snapshot.executionLeaseHolderSessionId);
    } finally {
      host.close();
    }
  }, 600_000);

  test('冒烟结束后隔离工作区没有新增文件改动', async () => {
    const probe = await runProcess({
      executable: 'git',
      args: ['status', '--porcelain', '--untracked-files=all'],
      cwd: isolatedRepo,
      env: process.env as Record<string, string>,
      timeoutMs: 60_000,
    });
    expect(probe.kind).toBe('completed');
    if (probe.kind !== 'completed') {
      return;
    }
    // Companion 的持久状态在 Git common dir 的私有目录里；工作区出现改动只能来自被显式派发的 Worker。
    expect(probe.stdout.text.trim()).toBe(baselineStatus);
  }, 120_000);
});

/* -------------------------------------------------------------------------- */
/* 真实执行闭环（ORCA_COMPANION_E2E_LOOP=1）                                     */
/* -------------------------------------------------------------------------- */

/** 闭环用的工作包与 PTY 验收共用同一份定义（`tests/support/real-execution-scope.ts`）。 */

/**
 * 轮询到条件成立或超时。
 *
 * 真实 Worker 的完成时间只能由外部事实回答，因此这里等待的是**条件**（状态变化 / 租约过期），不是
 * 猜测的固定时长：`intervalMs` 只是重试间隔，任何一轮的提前成立都会立刻返回。
 */
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
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, intervalMs);
    await promise;
  }
}

/** Runtime Lease 仍被本进程持有（未过期）：重启前必须等到它过期。 */
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

function policyOf(config: RealProjectConfig): string {
  return JSON.stringify(config.execution ?? {});
}

/**
 * 一次真实执行闭环。
 *
 * 顺序固定：播种候选图与 Run（与宿主工具路径同一个用例）→ 宿主启动对账 → 授权审阅（沙箱模式必须可见）
 * → 审批进入 Execution Coordination → 反复 Pause/Resume 触发单步推进，直到终态或明确 blocker →
 * 重启宿主核对没有重复派发。
 */
describe.skipIf(!loopEnabled)('真实执行闭环（一次性项目）', () => {
  test(
    '授权 → 串行角色 → 集成 → Finalizer：终态或明确 blocker，且重启不重复派发',
    async () => {
      const env = process.env as Record<string, string>;
      const configText = readFileSync(join(isolatedRepo, 'orca-companion.json'), 'utf8');
      const config = JSON.parse(configText) as RealProjectConfig;
      expect(workerModelsByRole(config)['validator']).toBe(REQUIRED_WORKER_MODEL);
      // 本机内核无法执行 Codex 的 Linux 沙箱（见 docs/orca-compatibility.md）：闭环显式接受 full-access
      // 风险，因此这条风险必须真的写在项目配置里，而不是测试替它放宽。
      expect(policyOf(config)).toContain(CODEX_FULL_ACCESS_RISK);

      // ---- 播种：Scope + Runtime Lease + 候选图与 Run（与 PTY 验收共用同一份夹具） ----
      const seededScope = await seedRealExecutionScope({
        workspace: isolatedRepo,
        identity: dedicatedIdentity,
        objective: 'm2-wire-execution-runtime 真实执行闭环',
        // 进程内冒烟只跑一条干净的角色链：图修订与基线补救由 PTY 验收（双包计划）覆盖。
        plan: REAL_LOOP_SINGLE_PLAN,
        env,
      });
      const seededRunId = seededScope.orcaRunId;
      const backend = createOrcaExecutionBackend({
        cwd: isolatedRepo,
        env,
        // 与宿主同一约定：只接受显式声明的专用身份，不从终端的其它句柄里挑一个。
        resolveIdentityHandle: (ref) => Promise.resolve(ref === dedicatedIdentity ? ref : undefined),
      });

      // ---- 宿主：启动对账 → 授权审阅 → 批准 ----
      let host: ForegroundPlanningHost = await createForegroundPlanningHost({ repositoryPath: isolatedRepo, env });
      const openHostOnce = async (): Promise<void> => {
        const home = await host.ports.scopeSetup.resolveHome();
        expect(home.kind, `Scope 无法恢复：${JSON.stringify(home)}`).toBe('restore');
        const review = await host.ports.executionAuthorization.review();
        expect(review.kind, `授权审阅被阻塞：${JSON.stringify(review)}`).toBe('review');
        if (review.kind !== 'review') {
          return;
        }
        // 沙箱模式必须在用户看到的 Manifest 行里可见。
        const sandboxRow = review.review.manifestRows.find((row) => row.label === 'Worker Sandbox');
        expect(sandboxRow?.value ?? '').toContain('danger-full-access');
        const approved = await host.ports.executionAuthorization.approve({
          fingerprint: review.review.fingerprint,
          expectedRevision: review.review.scopeRevision,
        });
        expect(approved.kind, `授权批准失败：${JSON.stringify(approved)}`).toBe('accepted');
        const after = await readStatus(isolatedRepo);
        expect(after.scope.mode).toBe('execution_coordination');
        expect(after.scope.executionLeaseHolder).not.toBeNull();
      };
      await openHostOnce();

      // ---- 触发点：Pause/Resume 各触发一次执行推进（一次最多推进一个阶段） ----
      const trigger = async (): Promise<void> => {
        const paused = await host.ports.execute({ kind: 'scope-control', action: 'pause' });
        expect(paused.kind, `Pause 被拒绝：${JSON.stringify(paused)}`).toBe('accepted');
        const resumed = await host.ports.execute({ kind: 'scope-control', action: 'resume' });
        expect(resumed.kind, `Resume 被拒绝：${JSON.stringify(resumed)}`).toBe('accepted');
      };
      // 真实 Worker 的存活只能从 Orca 读：有活跃 Worker 时触发没有意义（一次只推进一个阶段），
      // 因此驱动顺序是「等到没有活跃 Worker → 触发一次 → 等到状态变化」。
      const liveWorkers = async (): Promise<number> => {
        const listed = await backend.query({ operation: 'worker-list', runId: seededRunId });
        if (listed.kind !== 'accepted') {
          return 0;
        }
        const live = new Set(['running', 'active', 'working', 'in_progress']);
        return (listed.value as { readonly workers?: readonly { readonly workerState?: unknown }[] }).workers?.filter(
          (worker) => typeof worker.workerState === 'string' && live.has(worker.workerState),
        ).length ?? 0;
      };
      const deadline = Date.now() + 45 * 60_000;
      const fingerprintOf = (snapshot: StatusSnapshot): string =>
        snapshot.execution.workPackages
          .map((entry) => `${entry.workPackageId}:${entry.state}:${entry.role ?? '-'}:${entry.attemptId ?? '-'}`)
          .join('|');
      let snapshot = await readStatus(isolatedRepo);
      let rounds = 0;
      while (Date.now() < deadline) {
        const settled =
          snapshot.execution.finalizer.verdict !== null ||
          snapshot.execution.workPackages.some((entry) => entry.state === 'blocked') ||
          snapshot.execution.workPackages.every((entry) => entry.state === 'accepted');
        if (settled) {
          break;
        }
        // 有活跃 Worker 时先等它结束（Delivery 会在下一次触发里结算）。
        if ((await liveWorkers()) > 0) {
          const idle = await pollUntil(async () => (await liveWorkers()) === 0, 10_000, 20 * 60_000);
          if (!idle) {
            break;
          }
          continue;
        }
        const beforeFingerprint = fingerprintOf(snapshot);
        await trigger();
        rounds += 1;
        // 等真实 Worker 把阶段推进到可观察变化：条件成立即返回，不猜固定时长。
        let sawLiveWorker = (await liveWorkers()) > 0;
        const advanced = await pollUntil(
          async () => {
            const live = await liveWorkers();
            const wasLive = sawLiveWorker;
            sawLiveWorker = sawLiveWorker || live > 0;
            const current = await readStatus(isolatedRepo);
            return (
              fingerprintOf(current) !== beforeFingerprint ||
              current.execution.finalizer.verdict !== null ||
              current.blockers.length > 0 ||
              // 刚结束的真实 Worker：交付要走下一次触发才结算，因此这里就返回。
              (wasLive && live === 0)
            );
          },
          5_000,
          15 * 60_000,
        );
        snapshot = await readStatus(isolatedRepo);
        console.warn(
          `[e2e] round=${String(rounds)} advanced=${String(advanced)} phase=${fingerprintOf(snapshot)} blockers=${snapshot.blockers.map((blocker) => blocker.code).join(',')}`,
        );
        // 记录每一轮的可见事实，便于在真实失败时定位停在哪一步。
        const active = snapshot.execution.workPackages.filter(
          (entry) => entry.state !== 'waiting' && entry.state !== 'accepted',
        );
        expect(active.length, '并发上限为 1：同时最多一个 Work Package 处于非终态').toBeLessThanOrEqual(1);
        if (!advanced) {
          // 没有任何可观察变化：lane 被阻塞或推进停在事实层；由结论断言回答。
          break;
        }
      }
      expect(rounds, '闭环没有产生任何推进').toBeGreaterThan(0);

      // ---- 结论：deliverable 或明确 blocker 二者必有其一 ----
      const observed = await readStatus(isolatedRepo);
      const verdict = observed.execution.finalizer.verdict;
      const blockerCodes = observed.blockers.map((blocker) => blocker.code);
      const anyAccepted = observed.execution.workPackages.some((entry) => entry.state === 'accepted');
      console.warn(
        `[e2e] rounds=${String(rounds)} verdict=${verdict === null ? 'none' : verdict.kind} accepted=${String(anyAccepted)} blockers=${blockerCodes.join(',')}`,
      );
      expect(verdict !== null || blockerCodes.length > 0 || anyAccepted).toBe(true);

      // ---- 重启：读回同一批派发身份，不产生新的 Task/Dispatch ----
      const before = observed;
      host.close();
      // 退出不释放 Runtime Lease（产品语义）：等到它确实不再被持有再启动新的 Incarnation。
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
      ).toEqual(before.execution.workPackages.map((entry) => [entry.workPackageId, entry.state, entry.attemptId]));
      host.close();
    },
    3_600_000,
  );
});
