/**
 * IP-15：四个固定 harness（claude / opencode / pi / omp）的隔离真实验收矩阵。
 *
 * 只有显式设置 ORCA_COMPANION_REAL_ACCEPTANCE=1 才运行；未开启时整个文件只留一条 skip 记录，
 * 不建目录、不读凭据、不访问 Orca。可用 ORCA_COMPANION_REAL_ACCEPTANCE_HARNESSES /
 * _ROLES 把本次运行收窄到子集（例如只跑 claude 的 planner 做冒烟）。
 *
 *   ORCA_COMPANION_REAL_ACCEPTANCE=1 pnpm exec vitest run --maxWorkers=1 --testTimeout=1800000 tests/acceptance/worker-harness-matrix.test.ts
 *
 * 每个 harness 依次跑 planner → implementation → validator → finalizer，再用原精确身份对
 * implementation 会话做一次 resume/recovery；另有混合角色（跨 harness）一轮。全部结论写入
 * artifacts/worker-harness-adapters 的摘要证据；任一角色未绑定/artifact 不符/恢复不续同会话即失败。
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { workerHarnessRegistry } from '../../src/bootstrap/worker-harness.js';
import {
  ACCEPTANCE_DIAGNOSTICS,
  HARNESS_MATRIX,
  AcceptanceBlocker,
  assistantTextFromRecord,
  assertIsolatedWorkspace,
  createAcceptanceFixture,
  modelEvidenceFromAssistant,
  resolveAcceptancePlan,
  resumeRole,
  runRole,
  writeAcceptanceEvidence,
  type AcceptanceFixture,
  type AcceptanceHarnessId,
  type HarnessBinding,
  type RoleRun,
} from '../support/worker-harness-acceptance.js';

const PLAN = resolveAcceptancePlan();
const STARTED_AT = new Date().toISOString();
const EVIDENCE_DIR = resolve(fileURLToPath(new URL('../../', import.meta.url)), 'artifacts', 'worker-harness-adapters');
const HARNESS_TESTS_TIMEOUT_MS = 1_800_000;

const HARNESS_EVIDENCE: Record<string, unknown>[] = [];
let setupBlocker: string | null = null;

test.each([
  [{ type: 'model_change', model: 'configured-only' }, null],
  [{ type: 'message', message: { role: 'user', model: 'self-reported' } }, null],
  [{ type: 'assistant', message: { role: 'assistant', model: 'claude-model' } }, 'claude-model'],
  [{ type: 'message', message: { role: 'assistant', model: 'pi-model' } }, 'pi-model'],
  [{ type: 'assistant', model: { providerID: 'opencode-provider', id: 'actual-model' } }, 'opencode-provider/actual-model'],
])('模型证据只读取真实 assistant 记录 %#', (record, expected) => {
  expect(modelEvidenceFromAssistant(record)).toBe(expected);
});

test.each([
  [{ type: 'message', message: { role: 'user', content: 'requested-token' } }, ''],
  [{ type: 'assistant', message: { content: [{ type: 'tool_use', text: 'tool-token' }, { type: 'text', text: 'actual-answer' }] } }, 'actual-answer'],
  [{ type: 'assistant', parts: [{ type: 'text', text: 'public-api-answer' }] }, 'public-api-answer'],
])('结果证据只读取 assistant 文本 %#', (record, expected) => {
  expect(assistantTextFromRecord(record)).toBe(expected);
});

function bindingFor(harness: AcceptanceHarnessId): HarnessBinding {
  const binding = HARNESS_MATRIX.find((candidate) => candidate.harness === harness);
  if (binding === undefined) throw new Error('矩阵缺少绑定：' + harness);
  return binding;
}

function pick<T>(list: readonly T[], index: number): T {
  const value = list[index];
  if (value === undefined) throw new Error('缺少可用的 harness 选择');
  return value;
}

function roleEvidence(run: RoleRun): Record<string, unknown> {
  return {
    role: run.role,
    kind: run.kind,
    dispatchId: run.dispatchId,
    sessionId: run.sessionId,
    coverage: run.coverage,
    terminalState: run.terminalState,
    artifactOk: run.artifactOk,
    modelEvidence: run.modelEvidence,
    blocker: run.blocker,
  };
}

/** 跑一个 harness 的 p-i-v-f + resume，并把（无论成功失败）证据入列。 */
async function runHarnessMatrix(fixture: AcceptanceFixture, harness: AcceptanceHarnessId): Promise<void> {
  const binding = bindingFor(harness);
  const blockers: string[] = [];
  if (!workerHarnessRegistry.has(harness)) {
    blockers.push('Worker Harness 未注册：' + harness);
  }
  const roles: RoleRun[] = [];
  for (const role of PLAN.kind === 'run' ? PLAN.roles : []) {
    const run = await runRole({ fixture, binding, role, launchId: 'ip15:' + harness + ':' + role });
    roles.push(run);
    process.stdout.write(`[ip15] ${harness}/${role}: ${run.kind} ${run.blocker?.code ?? run.terminalState ?? ''} ${run.blocker?.message ?? ''}\n`);
    if (run.blocker !== null) blockers.push(role + '：' + run.blocker.code + ' ' + run.blocker.message);
  }
  const implementation = roles.find((run) => run.role === 'implementation');
  const resume = implementation === undefined
    ? { harness, kind: 'blocked' as const, sessionId: null, sameSession: false, coverage: null, blocker: { code: 'original_unavailable', message: '没有可恢复的 implementation 会话' } }
    : await resumeRole({ fixture, binding, original: implementation, resumeLaunchId: 'ip15:' + harness + ':resume' });
  if (resume.blocker !== null) blockers.push('resume：' + resume.blocker.code + ' ' + resume.blocker.message);

  HARNESS_EVIDENCE.push({
    harness,
    model: binding.model,
    providerId: binding.providerId,
    baseUrl: binding.baseUrl,
    roles: roles.map(roleEvidence),
    resume: { kind: resume.kind, sessionId: resume.sessionId, sameSession: resume.sameSession, coverage: resume.coverage, blocker: resume.blocker },
    blockers,
  });

  // 逐字核验固定模型：pi 是 MiniMax-M3，其余是 MiniMax-M3.1-Flash-Preview。
  expect(binding.model).toBe(harness === 'pi' ? 'MiniMax-M3' : 'MiniMax-M3.1-Flash-Preview');
  for (const run of roles) {
    expect(run.blocker, harness + '/' + run.role + ' blocker').toBeNull();
    expect(run.kind, harness + '/' + run.role).toBe('ran');
    expect(run.coverage, harness + '/' + run.role + ' coverage').toBe('complete');
    expect(run.artifactOk, harness + '/' + run.role + ' artifact').toBe(true);
    // 真实模型证据：必须来自 settled transcript，而不是我们传入的 binding 配置。
    expect(run.modelEvidence, harness + '/' + run.role + ' 真实模型证据').not.toBeNull();
    if (run.modelEvidence !== null) {
      expect(run.modelEvidence, harness + '/' + run.role + ' 实际模型').toContain(binding.model);
    }
  }
  expect(resume.blocker, harness + ' resume blocker').toBeNull();
  expect(resume.kind, harness + ' resume').toBe('ran');
  expect(resume.sameSession, harness + ' resume 必须续同一条 session').toBe(true);
}

/** 未开启时本文件不产生任何真实调用；这条断言本身就是「默认跳过」的可观察形式。 */
test.skipIf(PLAN.kind !== 'skip')('未开启开关时整个真实验收被跳过且不读凭据/不访问 Orca', () => {
  expect(PLAN.kind).toBe('skip');
  expect(ACCEPTANCE_DIAGNOSTICS.credentialsRead).toBe(false);
  expect(ACCEPTANCE_DIAGNOSTICS.orcaMutated).toBe(false);
  expect(ACCEPTANCE_DIAGNOSTICS.harnessLaunched).toBe(false);
});

test('隔离边界自检拒绝 Companion 自身仓库、其上级目录与不存在的路径', () => {
  const companion = resolve(fileURLToPath(new URL('../../', import.meta.url)));
  expect(() => assertIsolatedWorkspace(companion, new Set(['project-x']))).toThrow(/自身仓库/);
  expect(() => assertIsolatedWorkspace(resolve(companion, '..'), new Set(['project-x']))).toThrow(/上级目录/);
  expect(() => assertIsolatedWorkspace(join(companion, 'does-not-exist'), new Set(['project-x']))).toThrow(/不是存在的目录/);
  // 只含允许项的真实目录放行；混入其它内容必须失败。
  expect(() => assertIsolatedWorkspace(join(companion, 'references'), new Set(['orca']))).not.toThrow();
  expect(() => assertIsolatedWorkspace(join(companion, 'references'), new Set(['other']))).toThrow(/混入/);
});

describe.skipIf(PLAN.kind !== 'run')('IP-15 四 harness 真实隔离矩阵', () => {
  let fixture: AcceptanceFixture | null = null;

  beforeAll(async () => {
    if (PLAN.kind !== 'run') return;
    try {
      fixture = await createAcceptanceFixture(PLAN);
    } catch (error) {
      setupBlocker = error instanceof AcceptanceBlocker ? error.code + ' ' + error.message : String(error);
    }
  }, 300_000);

  afterAll(async () => {
    try {
      await fixture?.dispose();
    } finally {
      fixture = null;
    }
  }, 300_000);

  const mixedEnabled = PLAN.kind === 'run' && PLAN.harnesses.length >= 3;

  for (const harness of PLAN.kind === 'run' ? PLAN.harnesses : []) {
    test(harness + ' p-i-v-f + resume/recovery', async () => {
      if (setupBlocker !== null) {
        throw new Error('真实夹具未建立：' + setupBlocker);
      }
      if (fixture === null) throw new Error('真实夹具缺失');
      await runHarnessMatrix(fixture, harness);
    }, HARNESS_TESTS_TIMEOUT_MS);
  }

  test.skipIf(!mixedEnabled)('混合角色：跨 harness 的 planner → implementation → validator 同 Run 共存', async () => {
    if (setupBlocker !== null) throw new Error('真实夹具未建立：' + setupBlocker);
    if (fixture === null) throw new Error('真实夹具缺失');
    const available = PLAN.kind === 'run' ? PLAN.harnesses.filter((harness) => workerHarnessRegistry.has(harness)) : [];
    if (available.length < 3) {
      throw new Error('混合角色需要至少三个已注册 harness，当前：' + available.join(', '));
    }
    const finalizerHarness = available.find((harness) => harness === 'omp') ?? pick(available, Math.min(3, available.length - 1));
    const assignment: readonly { readonly role: 'planner' | 'implementation' | 'validator' | 'finalizer'; readonly harness: AcceptanceHarnessId }[] = [
      { role: 'planner', harness: pick(available, 0) },
      { role: 'implementation', harness: pick(available, 1) },
      { role: 'validator', harness: pick(available, 2) },
      { role: 'finalizer', harness: finalizerHarness },
    ];
    const runs: RoleRun[] = [];
    for (const entry of assignment) {
      runs.push(await runRole({ fixture, binding: bindingFor(entry.harness), role: entry.role, launchId: 'ip15:mixed:' + entry.harness + ':' + entry.role }));
    }
    HARNESS_EVIDENCE.push({
      harness: 'mixed',
      assignment: assignment.map((entry) => entry.harness + ':' + entry.role),
      roles: runs.map(roleEvidence),
      blockers: runs.filter((run) => run.blocker !== null).map((run) => run.role + '：' + (run.blocker?.code ?? '') + ' ' + (run.blocker?.message ?? '')),
    });
    for (const run of runs) {
      expect(run.blocker, 'mixed ' + run.role).toBeNull();
      expect(run.kind, 'mixed ' + run.role).toBe('ran');
      expect(run.coverage, 'mixed ' + run.role + ' coverage').toBe('complete');
      expect(run.artifactOk, 'mixed ' + run.role + ' artifact').toBe(true);
      expect(run.modelEvidence, 'mixed ' + run.role + ' 实际模型').toContain(bindingFor(run.harness).model);
    }
  }, HARNESS_TESTS_TIMEOUT_MS);

  test('汇总证据并确认没有未结阻塞', () => {
    const finishedAt = new Date().toISOString();
    const baseUrl = PLAN.kind === 'run' ? PLAN.baseUrl : '';
    const jsonPath = writeAcceptanceEvidence(EVIDENCE_DIR, {
      schema: 'worker-harness-acceptance/1',
      startedAt: STARTED_AT,
      finishedAt,
      baseDir: PLAN.kind === 'run' ? PLAN.baseDir : '',
      identity: PLAN.kind === 'run' ? PLAN.identity : '',
      envFile: PLAN.kind === 'run' ? PLAN.envFile : '',
      baseUrl,
      harnesses: HARNESS_EVIDENCE,
    });
    expect(existsSync(jsonPath)).toBe(true);
    expect(setupBlocker).toBeNull();
    for (const harness of PLAN.kind === 'run' ? PLAN.harnesses : []) {
      const entry = HARNESS_EVIDENCE.find((candidate) => candidate['harness'] === harness);
      expect(entry, harness + ' 缺少证据').toBeDefined();
      expect(entry?.['blockers'], harness + ' 存在阻塞').toEqual([]);
    }
  });
});
