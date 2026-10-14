/**
 * 资格摘要与采集器测试（change: `grade-worker-harness-admission`）。
 *
 * 覆盖四件事：打包等级只由真实运行证据推导，候选没有被顺手提升；采集器不看 modelEvidence；
 * 部分历史或缺少 Validator 续接只能得到更低等级；缺失或损坏的输入、缺精确归属的角色和原生报告
 * 缺失都不能证明任何能力。只读是任务级能力：缺证据或拒写失败都不会降低通用等级。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import {
  deriveWorkerSupportLevel,
  minimumWorkerSupportLevel,
  workerHarnessQualificationSchema,
  workerSupportLevelAllows,
  WORKER_CAPABILITIES,
  type WorkerHarnessQualification,
  type WorkerSupportLevel,
} from '../../../src/domain/worker-harness-support.js';
import {
  qualificationFromAcceptance,
  workerHarnessQualification,
  workerHarnessSupport,
} from '../../../src/adapters/agents/worker-harness-qualifications.js';

/** 登记的 14 家；每条等级都是证据推导的结果。 */
const BUNDLED_LEVELS: ReadonlyArray<{ readonly harness: string; readonly level: WorkerSupportLevel }> = [
  { harness: 'codex', level: 'enhanced' },
  { harness: 'claude', level: 'basic' },
  { harness: 'opencode', level: 'basic' },
  { harness: 'pi', level: 'basic' },
  { harness: 'omp', level: 'basic' },
  { harness: 'command-code', level: 'complete' },
  { harness: 'qwen-code', level: 'complete' },
  { harness: 'antigravity', level: 'complete' },
  { harness: 'kilo', level: 'basic' },
  { harness: 'kimi', level: 'unavailable' },
  { harness: 'hermes', level: 'unavailable' },
  { harness: 'cline', level: 'unavailable' },
  { harness: 'muse', level: 'unavailable' },
  { harness: 'cursor', level: 'unavailable' },
];

function onlyRecord(input: unknown, mixed = false): WorkerHarnessQualification {
  const records = qualificationFromAcceptance(input, 'artifacts/example.json', mixed);
  expect(records).toHaveLength(1);
  const record = records[0];
  if (record === undefined) throw new Error('采集器没有返回记录');
  return record;
}

describe('打包的资格摘要', () => {
  test.each(BUNDLED_LEVELS)('$harness 的已推导等级是 $level', ({ harness, level }) => {
    expect(workerHarnessSupport(harness)).toEqual({
      level,
      qualificationRef: workerHarnessQualification(harness).evidenceRef,
    });
  });

  test('每条记录都通过信任边界校验，verified 事实带非空来源，同一能力只有一条', () => {
    for (const { harness } of BUNDLED_LEVELS) {
      const qualification = workerHarnessQualification(harness);
      expect(workerHarnessQualificationSchema.safeParse(qualification).success, harness).toBe(true);
      expect(new Set(qualification.facts.map((fact) => fact.capability)).size, harness).toBe(qualification.facts.length);
      for (const fact of qualification.facts) {
        if (fact.state !== 'verified') continue;
        expect(fact.evidenceRef ?? '', `${harness}/${fact.capability}`).not.toBe('');
        expect(fact.evidenceRef, `${harness}/${fact.capability}`).not.toBeNull();
      }
    }
  });

  test('complete 需要连续三段能力的完整证据，候选没有越过基本证据', () => {
    for (const { harness, level } of BUNDLED_LEVELS) {
      if (level !== 'complete') continue;
      const facts = workerHarnessQualification(harness).facts;
      // read_only 是任务级能力，不参与通用等级：这里不把它当作完整级的全局门槛。
      for (const capability of WORKER_CAPABILITIES.filter((value) => value !== 'read_only')) {
        expect(facts.some((fact) => fact.capability === capability && fact.state === 'verified'), `${harness}/${capability}`).toBe(true);
      }
    }
    for (const harness of ['kimi', 'hermes', 'cline', 'muse', 'cursor']) {
      expect(workerSupportLevelAllows(workerHarnessSupport(harness).level, 'basic'), harness).toBe(false);
    }
  });

  test('codex 没有 mixed Controller 证据，因此不声明 mixed_controller', () => {
    const facts = workerHarnessQualification('codex').facts;
    expect(facts.some((fact) => fact.capability === 'mixed_controller')).toBe(false);
  });

  test('默认 Recovery Utility 的等级要求与当前 codex 等级不一致', () => {
    // 兼容性影响：codex 的常用恢复配置在 v5 授权下会因 complete 未成立而被拒绝。
    const required = minimumWorkerSupportLevel('recovery_utility');
    expect(required).toBe('complete');
    expect(workerSupportLevelAllows(workerHarnessSupport('codex').level, required)).toBe(false);
  });

  test('未记录的 harness 只有空事实和缺失引用', () => {
    const qualification = workerHarnessQualification('not-a-harness');
    expect(qualification.facts).toEqual([]);
    expect(qualification.evidenceRef).toContain('missing');
    expect(deriveWorkerSupportLevel(qualification)).toBe('unavailable');
    expect(workerHarnessSupport('not-a-harness')).toEqual({
      level: 'unavailable',
      qualificationRef: qualification.evidenceRef,
    });
  });
});

// ---------------------------------------------------------------------------------------------
// 采集器
// ---------------------------------------------------------------------------------------------

function role(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: name,
    kind: 'ran',
    taskId: `task_${name}`,
    dispatchId: `ctx_${name}`,
    sessionId: `session-${name}`,
    terminalState: 'succeeded',
    artifactOk: true,
    coverage: 'complete',
    blocker: null,
    ...overrides,
  };
}

function harnessEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    harness: 'fixture',
    roles: [role('planner'), role('implementation'), role('validator'), role('finalizer')],
    resume: { kind: 'ran', sameSession: true, sessionId: 'session-implementation', blocker: null },
    validatorContinuation: { kind: 'ran', sameSession: true, contextPreserved: true, blocker: null },
    recovery: {
      kind: 'ran',
      readOnlyVerified: true,
      sourceBehaviorVerified: true,
      coverage: { coverage: 'complete', gaps: [] },
      blocker: null,
    },
    blockers: [],
    ...overrides,
  };
}

function acceptance(harness: Record<string, unknown> = harnessEntry()): Record<string, unknown> {
  return {
    schema: 'worker-harness-acceptance/1',
    startedAt: '2026-10-14T00:00:00.000Z',
    finishedAt: '2026-10-14T00:10:00.000Z',
    fixtureRoot: '/var/tmp/fixture',
    harnesses: [harness],
  };
}

describe('qualificationFromAcceptance', () => {
  test.each(['taskId', 'dispatchId'])('缺少 %s 不构成角色执行证据', (field) => {
    const record = onlyRecord(acceptance(harnessEntry({
      roles: [role('planner', { [field]: null }), role('implementation')],
    })));
    expect(record.facts.some(fact => fact.capability === 'planner_result')).toBe(false);
    expect(deriveWorkerSupportLevel(record)).toBe('unavailable');
  });

  test('部分角色缺原生 Session 时只具备 basic', () => {
    const record = onlyRecord(acceptance(harnessEntry({
      roles: [role('planner'), role('implementation'), role('validator'), role('finalizer', { sessionId: null })],
    })));
    expect(record.facts.some(fact => fact.capability === 'native_session')).toBe(false);
    expect(deriveWorkerSupportLevel(record)).toBe('basic');
  });

  test('模型回显、usage 与目录不参与事实', () => {
    const plain = acceptance();
    const withEcho = acceptance(harnessEntry({
      modelSelection: { model: 'MiniMax-M3.1-Flash-Preview' },
      expectedModel: 'MiniMax-M3.1-Flash-Preview',
      roles: [role('planner', { modelEvidence: 'MiniMax-M3.1-Flash-Preview', usage: { inputTokens: 10 } }),
        role('implementation', { modelEvidence: 'MiniMax-M3.1-Flash-Preview' }),
        role('validator', { modelEvidence: 'MiniMax-M3.1-Flash-Preview' }),
        role('finalizer', { modelEvidence: 'MiniMax-M3.1-Flash-Preview' })],
    }));
    expect(qualificationFromAcceptance(withEcho, 'artifacts/example.json', true))
      .toEqual(qualificationFromAcceptance(plain, 'artifacts/example.json', true));
  });

  test('完整证据链得到 complete，且记录通过 domain schema', () => {
    const record = onlyRecord(acceptance(), true);
    expect(deriveWorkerSupportLevel(record)).toBe('complete');
    expect(workerHarnessQualificationSchema.safeParse(record).success).toBe(true);
    expect(record.evidenceRef).toBe('artifacts/example.json#fixture');
    expect(record.facts.find((fact) => fact.capability === 'transcript_coverage')?.evidenceRef)
      .toBe('artifacts/example.json#fixture/roles.coverage');
  });

  test('mixed Controller 只由调用方显式传入', () => {
    expect(onlyRecord(acceptance()).facts.some((fact) => fact.capability === 'mixed_controller')).toBe(false);
    expect(deriveWorkerSupportLevel(onlyRecord(acceptance()))).toBe('enhanced');
  });

  test('部分历史只能得到更低等级', () => {
    const twoRoles = onlyRecord(acceptance(harnessEntry({
      roles: [role('planner'), role('implementation')],
      resume: null,
      validatorContinuation: null,
      recovery: null,
    })));
    expect(deriveWorkerSupportLevel(twoRoles)).toBe('basic');

    const noResume = onlyRecord(acceptance(harnessEntry({ resume: null, validatorContinuation: null })));
    expect(deriveWorkerSupportLevel(noResume)).toBe('basic');
  });

  test('缺 Recovery 只阻止完整级，不降低增强级', () => {
    const noRecovery = onlyRecord(acceptance(harnessEntry({ recovery: null })));
    expect(noRecovery.facts.some((fact) => fact.capability === 'recovery')).toBe(false);
    expect(deriveWorkerSupportLevel(noRecovery)).toBe('enhanced');
  });

  test('enhanced 需要 Validator 同 Session 且上下文保留的续接证据', () => {
    const withoutContinuation = onlyRecord(acceptance(harnessEntry({ validatorContinuation: null })));
    expect(withoutContinuation.facts.some((fact) => fact.capability === 'session_resume')).toBe(false);
    expect(deriveWorkerSupportLevel(withoutContinuation)).toBe('basic');

    const contextLost = onlyRecord(acceptance(harnessEntry({
      validatorContinuation: { kind: 'ran', sameSession: true, contextPreserved: false, blocker: null },
    })));
    expect(contextLost.facts.find((fact) => fact.capability === 'session_resume')).toEqual({
      capability: 'session_resume', state: 'failed', evidenceRef: null, diagnostic: 'session_not_continued',
    });
    expect(deriveWorkerSupportLevel(contextLost)).toBe('basic');
  });

  test('只读结论不参与通用等级：拒写失败或缺证据仍是 enhanced', () => {
    const writeAllowed = onlyRecord(acceptance(harnessEntry({
      recovery: { kind: 'ran', readOnlyVerified: false, sourceBehaviorVerified: true, coverage: { coverage: 'complete' }, blocker: null },
    })));
    expect(writeAllowed.facts.find((fact) => fact.capability === 'read_only')).toEqual({
      capability: 'read_only', state: 'failed', evidenceRef: null, diagnostic: 'write_not_denied',
    });
    expect(deriveWorkerSupportLevel(writeAllowed)).toBe('enhanced');

    const recoveryWithoutProbe = onlyRecord(acceptance(harnessEntry({
      recovery: { kind: 'ran', sourceBehaviorVerified: true, coverage: { coverage: 'complete' }, blocker: null },
    })));
    expect(recoveryWithoutProbe.facts.some((fact) => fact.capability === 'read_only')).toBe(false);
    expect(deriveWorkerSupportLevel(recoveryWithoutProbe)).toBe('enhanced');
  });

  test('角色自带的拒写结论仍作为独立事实记录，但不改变等级', () => {
    const probed = onlyRecord(acceptance(harnessEntry({
      roles: [role('planner'), role('implementation'), role('validator'), role('finalizer', { readOnlyVerified: true })],
      recovery: null,
    })));
    expect(probed.facts.find((fact) => fact.capability === 'read_only')?.evidenceRef)
      .toBe('artifacts/example.json#fixture/roles.finalizer.readOnlyVerified');
    expect(deriveWorkerSupportLevel(probed)).toBe('enhanced');

    const wrote = onlyRecord(acceptance(harnessEntry({
      roles: [role('planner'), role('implementation'), role('validator'), role('finalizer', { readOnlyVerified: false })],
      recovery: null,
    })));
    expect(wrote.facts.find((fact) => fact.capability === 'read_only')).toEqual({
      capability: 'read_only', state: 'failed', evidenceRef: null, diagnostic: 'write_not_denied',
    });
    expect(deriveWorkerSupportLevel(wrote)).toBe('enhanced');
  });

  test('实测的 partial coverage 记作失败，缺失的四角色覆盖不作结论', () => {
    const partial = onlyRecord(acceptance(harnessEntry({
      roles: [role('planner'), role('implementation'), role('validator', { coverage: 'partial' }), role('finalizer')],
    })));
    expect(partial.facts.find((fact) => fact.capability === 'transcript_coverage')).toEqual({
      capability: 'transcript_coverage', state: 'failed', evidenceRef: null, diagnostic: 'coverage_incomplete',
    });

    const unmeasured = onlyRecord(acceptance(harnessEntry({
      roles: [role('planner'), role('implementation'), role('validator'), role('finalizer', { kind: 'blocked', taskId: null, dispatchId: null, terminalState: null, artifactOk: null, coverage: null, blocker: { code: 'session_report_missing' } })],
    })));
    expect(unmeasured.facts.some((fact) => fact.capability === 'transcript_coverage')).toBe(false);
    expect(unmeasured.facts.some((fact) => fact.capability === 'finalizer_result')).toBe(false);
  });

  test('没有精确 task/dispatch 或没有结算的角色不算证据，也不算执行失败', () => {
    const cases: readonly Record<string, unknown>[] = [
      role('planner', { taskId: null, dispatchId: null }),
      role('planner', { taskId: '   ', dispatchId: null }),
      role('planner', { terminalState: 'ready' }),
      role('planner', { kind: 'blocked', taskId: null, dispatchId: null, terminalState: null, artifactOk: null, coverage: null, blocker: { code: 'session_report_missing' } }),
    ];
    for (const candidate of cases) {
      const record = onlyRecord(acceptance(harnessEntry({ roles: [candidate], resume: null, validatorContinuation: null, recovery: null })));
      expect(record.facts).toEqual([]);
      expect(deriveWorkerSupportLevel(record)).toBe('unavailable');
    }
  });

  test('结算成功但产物没核验记作失败', () => {
    const record = onlyRecord(acceptance(harnessEntry({
      roles: [role('planner', { artifactOk: false })],
      resume: null,
      validatorContinuation: null,
      recovery: null,
    })));
    expect(record.facts.find((fact) => fact.capability === 'planner_result')).toEqual({
      capability: 'planner_result', state: 'failed', evidenceRef: null, diagnostic: 'artifact_unverified',
    });
  });

  test('缺失或损坏的输入不产生任何记录', () => {
    const corrupt: readonly unknown[] = [
      undefined,
      null,
      42,
      '{"harnesses": []}',
      {},
      { harnesses: 'nope' },
      { harnesses: [null, 7, {}] },
      { harnesses: [{ harness: '' }] },
    ];
    for (const raw of corrupt) {
      expect(qualificationFromAcceptance(raw, 'artifacts/example.json')).toEqual([]);
    }
  });

  test('旧 ip15 摘要缺 Task 身份时不自动重新授予资格', () => {
    const path = fileURLToPath(new URL('../../../artifacts/worker-harness-adapters/ip15-2026-10-06T05-02-57-524Z.json', import.meta.url));
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const claude = qualificationFromAcceptance(raw, path).find((record) => record.harness === 'claude');
    expect(claude).toBeDefined();
    if (claude === undefined) return;
    expect(deriveWorkerSupportLevel(claude)).toBe('unavailable');
    expect(workerHarnessQualificationSchema.safeParse(claude).success).toBe(true);
    for (const capability of ['task_input', 'orca_binding', 'planner_result', 'implementation_result', 'transcript_coverage']) {
      expect(claude.facts.some((fact) => fact.capability === capability && fact.state === 'verified'), capability).toBe(false);
    }
    expect(claude.facts.some((fact) => fact.capability === 'read_only')).toBe(false);
  });
});
