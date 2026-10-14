/**
 * Worker Harness 分级准入测试（change: `grade-worker-harness-admission`）。
 *
 * 覆盖三件事：等级只认连续的已证前缀；角色最低等级与等级比较；资格记录的运行时校验在信任边界上
 * 拒绝无证据的 verified、重复能力与未知字段。只读是任务级能力，它是声明过的事实，不参与通用等级。
 */

import { describe, expect, test } from 'vitest';

import {
  WORKER_CAPABILITIES,
  WORKER_SUPPORT_LEVELS,
  deriveWorkerSupportLevel,
  minimumWorkerSupportLevel,
  workerHarnessQualificationSchema,
  workerSupportLevelAllows,
  type WorkerCapability,
  type WorkerCapabilityEvidence,
  type WorkerHarnessQualification,
  type WorkerSupportLevel,
  type WorkerSupportSubject,
} from '../../src/domain/worker-harness-support.js';

const BASIC: readonly WorkerCapability[] = [
  'task_input',
  'orca_binding',
  'planner_result',
  'implementation_result',
];
const ENHANCED: readonly WorkerCapability[] = [
  'native_session',
  'session_resume',
  'validator_result',
  'finalizer_result',
];
const COMPLETE: readonly WorkerCapability[] = ['transcript_coverage', 'recovery', 'mixed_controller'];
/** 全部声明能力：`read_only` 只在任务级核验，不进通用等级。 */
const FULL: readonly WorkerCapability[] = [...BASIC, ...ENHANCED, ...COMPLETE, 'read_only'];

const verified = (capability: WorkerCapability): WorkerCapabilityEvidence => ({
  capability,
  state: 'verified',
  evidenceRef: `evidence:${capability}`,
  diagnostic: null,
});
const failed = (capability: WorkerCapability): WorkerCapabilityEvidence => ({
  capability,
  state: 'failed',
  evidenceRef: null,
  diagnostic: '原生探针返回失败',
});
const unverified = (capability: WorkerCapability): WorkerCapabilityEvidence => ({
  capability,
  state: 'unverified',
  evidenceRef: null,
  diagnostic: '本轮未运行',
});

const qualification = (facts: readonly WorkerCapabilityEvidence[]): WorkerHarnessQualification => ({
  harness: 'codex',
  evidenceRef: 'evidence:qualification',
  facts,
});

describe('deriveWorkerSupportLevel 只承认连续的已证前缀', () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly facts: readonly WorkerCapabilityEvidence[];
    readonly expected: WorkerSupportLevel;
  }> = [
    { name: '没有任何证据', facts: [], expected: 'unavailable' },
    {
      name: 'basic 只证明了一部分',
      facts: BASIC.slice(0, 3).map(verified),
      expected: 'unavailable',
    },
    {
      name: 'basic 中一条记为 failed',
      facts: [
        verified('task_input'),
        verified('orca_binding'),
        verified('planner_result'),
        failed('implementation_result'),
      ],
      expected: 'unavailable',
    },
    { name: 'basic 全覆盖', facts: BASIC.map(verified), expected: 'basic' },
    {
      name: 'basic 全覆盖，enhanced 只证明了一部分',
      facts: [...BASIC.map(verified), ...ENHANCED.slice(0, 3).map(verified)],
      expected: 'basic',
    },
    {
      name: 'basic 全覆盖，enhanced 中一条记为 failed',
      facts: [
        ...BASIC.map(verified),
        ...ENHANCED.filter((capability) => capability !== 'session_resume').map(verified),
        failed('session_resume'),
      ],
      expected: 'basic',
    },
    {
      name: 'enhanced 全覆盖但只读失败仍是 enhanced',
      facts: [...BASIC.map(verified), ...ENHANCED.map(verified), failed('read_only')],
      expected: 'enhanced',
    },
    {
      name: '只读未记录不影响 enhanced',
      facts: [...BASIC.map(verified), ...ENHANCED.map(verified), unverified('read_only')],
      expected: 'enhanced',
    },
    {
      name: '只读失败不影响 complete',
      facts: [
        ...BASIC.map(verified),
        ...ENHANCED.map(verified),
        ...COMPLETE.map(verified),
        failed('read_only'),
      ],
      expected: 'complete',
    },
    {
      name: 'basic 与 enhanced 全覆盖',
      facts: [...BASIC.map(verified), ...ENHANCED.map(verified)],
      expected: 'enhanced',
    },
    {
      name: '缺 basic 但 enhanced 全覆盖，不能跳级',
      facts: [...BASIC.slice(0, 3).map(verified), ...ENHANCED.map(verified)],
      expected: 'unavailable',
    },
    {
      name: '三段全覆盖',
      facts: [...BASIC.map(verified), ...ENHANCED.map(verified), ...COMPLETE.map(verified)],
      expected: 'complete',
    },
    {
      name: '部分历史：complete 的一条没有记录',
      facts: [
        ...BASIC.map(verified),
        ...ENHANCED.map(verified),
        ...COMPLETE.filter((capability) => capability !== 'recovery').map(verified),
      ],
      expected: 'enhanced',
    },
    {
      name: '部分历史：basic 的一条没有记录',
      facts: [
        ...BASIC.slice(0, 3).map(verified),
        unverified('implementation_result'),
      ],
      expected: 'unavailable',
    },
  ];

  test.each(cases)('$name', ({ facts, expected }) => {
    expect(deriveWorkerSupportLevel(qualification(facts))).toBe(expected);
  });

  test('未解析对象里的 verified 空 evidenceRef 不算证据', () => {
    const raw: WorkerCapabilityEvidence[] = [
      verified('task_input'),
      verified('orca_binding'),
      verified('planner_result'),
      { capability: 'implementation_result', state: 'verified', evidenceRef: null, diagnostic: null },
    ];
    expect(deriveWorkerSupportLevel(qualification(raw))).toBe('unavailable');
  });
});

describe('角色最低等级与等级比较', () => {
  const minimums: ReadonlyArray<{
    readonly subject: WorkerSupportSubject;
    readonly level: WorkerSupportLevel;
  }> = [
    { subject: 'planner', level: 'basic' },
    { subject: 'implementation', level: 'basic' },
    { subject: 'validator', level: 'enhanced' },
    { subject: 'finalizer', level: 'enhanced' },
    { subject: 'planning_utility', level: 'enhanced' },
    { subject: 'specification_validator', level: 'enhanced' },
    { subject: 'recovery_utility', level: 'complete' },
  ];

  test.each(minimums)('$subject 要求 $level', ({ subject, level }) => {
    expect(minimumWorkerSupportLevel(subject)).toBe(level);
  });

  const comparisons: ReadonlyArray<{
    readonly actual: WorkerSupportLevel;
    readonly required: WorkerSupportLevel;
    readonly allowed: boolean;
  }> = [
    { actual: 'unavailable', required: 'basic', allowed: false },
    { actual: 'basic', required: 'basic', allowed: true },
    { actual: 'basic', required: 'enhanced', allowed: false },
    { actual: 'enhanced', required: 'basic', allowed: true },
    { actual: 'enhanced', required: 'enhanced', allowed: true },
    { actual: 'enhanced', required: 'complete', allowed: false },
    { actual: 'complete', required: 'enhanced', allowed: true },
    { actual: 'complete', required: 'complete', allowed: true },
    { actual: 'unavailable', required: 'unavailable', allowed: true },
  ];

  test.each(comparisons)('$actual vs $required', ({ actual, required, allowed }) => {
    expect(workerSupportLevelAllows(actual, required)).toBe(allowed);
  });

  test('按等级决定各角色是否放行', () => {
    const basicOnly = qualification(BASIC.map(verified));
    expect(deriveWorkerSupportLevel(basicOnly)).toBe('basic');
    for (const subject of ['planner', 'implementation'] as const) {
      expect(workerSupportLevelAllows('basic', minimumWorkerSupportLevel(subject))).toBe(true);
    }
    for (const subject of [
      'validator',
      'finalizer',
      'planning_utility',
      'specification_validator',
      'recovery_utility',
    ] as const) {
      expect(workerSupportLevelAllows('basic', minimumWorkerSupportLevel(subject))).toBe(false);
    }

    const enhanced = deriveWorkerSupportLevel(
      qualification([...BASIC.map(verified), ...ENHANCED.map(verified)]),
    );
    expect(enhanced).toBe('enhanced');
    expect(workerSupportLevelAllows(enhanced, minimumWorkerSupportLevel('validator'))).toBe(true);
    expect(workerSupportLevelAllows(enhanced, minimumWorkerSupportLevel('recovery_utility'))).toBe(false);
  });
});

describe('资格记录 schema 在信任边界上拒绝伪证据', () => {
  test('合法记录通过解析，且可直接导出等级', () => {
    const parsed = workerHarnessQualificationSchema.parse({
      harness: 'codex',
      evidenceRef: 'evidence:qualification',
      facts: FULL.map(verified),
    });
    expect(deriveWorkerSupportLevel(parsed)).toBe('complete');
    expect(parsed.facts).toHaveLength(WORKER_CAPABILITIES.length);
  });

  const invalid: ReadonlyArray<{ readonly name: string; readonly raw: unknown }> = [
    {
      name: 'verified 缺少 evidenceRef',
      raw: {
        harness: 'codex',
        evidenceRef: 'evidence:qualification',
        facts: [{ capability: 'task_input', state: 'verified', evidenceRef: null, diagnostic: null }],
      },
    },
    {
      name: 'verified 的 evidenceRef 为空串',
      raw: {
        harness: 'codex',
        evidenceRef: 'evidence:qualification',
        facts: [{ capability: 'task_input', state: 'verified', evidenceRef: '', diagnostic: null }],
      },
    },
    {
      name: '同一 capability 两条证据',
      raw: {
        harness: 'codex',
        evidenceRef: 'evidence:qualification',
        facts: [verified('task_input'), failed('task_input')],
      },
    },
    {
      name: '未知 capability',
      raw: {
        harness: 'codex',
        evidenceRef: 'evidence:qualification',
        facts: [
          { capability: 'teleport', state: 'verified', evidenceRef: 'evidence:x', diagnostic: null },
        ],
      },
    },
    {
      name: '未知证据状态',
      raw: {
        harness: 'codex',
        evidenceRef: 'evidence:qualification',
        facts: [
          { capability: 'task_input', state: 'probably', evidenceRef: 'evidence:x', diagnostic: null },
        ],
      },
    },
    {
      name: '事实含多余字段',
      raw: {
        harness: 'codex',
        evidenceRef: 'evidence:qualification',
        facts: [
          {
            capability: 'task_input',
            state: 'verified',
            evidenceRef: 'evidence:x',
            diagnostic: null,
            model: 'gpt',
          },
        ],
      },
    },
    { name: 'harness 为空串', raw: { harness: '', evidenceRef: 'evidence:qualification', facts: [] } },
    { name: 'facts 不是数组', raw: { harness: 'codex', evidenceRef: 'evidence:qualification', facts: 'all' } },
    { name: '记录含多余字段', raw: { harness: 'codex', evidenceRef: 'evidence:q', facts: [], usage: 42 } },
  ];

  test.each(invalid)('$name', ({ raw }) => {
    expect(workerHarnessQualificationSchema.safeParse(raw).success).toBe(false);
  });

  test('支持等级取值就是已声明的四档', () => {
    expect([...WORKER_SUPPORT_LEVELS]).toEqual(['unavailable', 'basic', 'enhanced', 'complete']);
  });

  test('记录不含模型回显或 usage 时仍可达到 complete', () => {
    const parsed = workerHarnessQualificationSchema.parse({
      harness: 'codex',
      evidenceRef: 'evidence:qualification',
      facts: FULL.map(verified),
    });
    expect(Object.keys(parsed).sort()).toEqual(['evidenceRef', 'facts', 'harness']);
    expect(deriveWorkerSupportLevel(parsed)).toBe('complete');
  });
});
