/**
 * Delivery Verdict 接受判定测试
 * （change: `m1-execute-and-validate-work-packages`，Owner: IP-B7）。
 *
 * 覆盖 Requirement「Delivery Verdict 由独立结论构成并被确定性接受」的三个 Scenario：接受可交付
 * 结论、阻塞结论保持不可交付、证据与既有权威事实不一致时阻塞。
 */

import { expect, test } from 'vitest';

import type { WorkPackageId } from '../../src/application/dto/identity.js';
import {
  evaluateDeliveryVerdict,
  type FinalizerReportFacts,
  type FinalizerVerification,
} from '../../src/domain/delivery-verdict.js';
import type { EvidenceRecord } from '../../src/domain/worker-report.js';

const WP_1 = 'wp-1' as WorkPackageId;
const WP_2 = 'wp-2' as WorkPackageId;
const HEAD = 'a'.repeat(40);
const TREE = 'b'.repeat(40);

function command(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    evidenceId: 'test-1',
    kind: 'command',
    coveredPaths: ['src'],
    command: 'pnpm test',
    summary: '复验通过',
    outcome: 'passed',
    ...overrides,
  };
}

function verification(overrides: Partial<FinalizerVerification> = {}): FinalizerVerification {
  return {
    head: HEAD,
    tree: TREE,
    expectedHead: HEAD,
    expectedTree: TREE,
    commands: [command()],
    integrationRef: 'integration-1',
    ...overrides,
  };
}

function facts(overrides: Partial<FinalizerReportFacts> = {}): FinalizerReportFacts {
  return {
    role: 'finalizer',
    session: { kind: 'new_read_only', sessionBindingId: 'session-binding-1' },
    readOnly: true,
    coveredWorkPackageIds: [WP_1, WP_2],
    expectedWorkPackageIds: [WP_1, WP_2],
    verdict: { kind: 'deliverable', evidenceRefs: ['orca-result-1'] },
    authoritativeRefs: ['orca-result-1', 'integration-1'],
    ...overrides,
  };
}

test('接受可交付结论', () => {
  expect(evaluateDeliveryVerdict(facts())).toEqual({
    kind: 'accepted',
    verdict: { kind: 'deliverable', evidenceRefs: ['orca-result-1'] },
    deliverable: true,
  });
});

test('阻塞结论被记录且保持不可交付', () => {
  const decision = evaluateDeliveryVerdict(
    facts({ verdict: { kind: 'blocked', blockerRefs: ['blocker-1'] } }),
  );

  expect(decision).toEqual({
    kind: 'accepted',
    verdict: { kind: 'blocked', blockerRefs: ['blocker-1'] },
    deliverable: false,
  });
});

test('复用既有会话的结论不被接受', () => {
  expect(evaluateDeliveryVerdict(facts({ session: { kind: 'reused', sessionBindingId: 'session-binding-1' } }))).toMatchObject(
    { kind: 'blocked', code: 'session_reused' },
  );
});

test('未被核验为只读的会话不能给出项目级结论', () => {
  expect(evaluateDeliveryVerdict(facts({ readOnly: false }))).toMatchObject({
    kind: 'blocked',
    code: 'session_not_read_only',
  });
  expect(
    evaluateDeliveryVerdict(facts({ session: { kind: 'unverifiable', reason: '无法核验会话权限' } })),
  ).toMatchObject({ kind: 'blocked', code: 'session_not_read_only' });
});

test('非 finalizer 角色不能给出项目级结论', () => {
  expect(evaluateDeliveryVerdict(facts({ role: 'validator' }))).toMatchObject({
    kind: 'blocked',
    code: 'role_mismatch',
  });
});

test('覆盖范围不足时不接受结论', () => {
  expect(evaluateDeliveryVerdict(facts({ coveredWorkPackageIds: [WP_1] }))).toMatchObject({
    kind: 'blocked',
    code: 'coverage_incomplete',
  });
});

test('结论缺少证据或阻塞项时不接受', () => {
  expect(evaluateDeliveryVerdict(facts({ verdict: { kind: 'deliverable', evidenceRefs: [] } }))).toMatchObject({
    kind: 'blocked',
    code: 'missing_evidence',
  });
  expect(evaluateDeliveryVerdict(facts({ verdict: { kind: 'blocked', blockerRefs: [] } }))).toMatchObject({
    kind: 'blocked',
    code: 'missing_evidence',
  });
});

test('证据与既有权威事实不一致时阻塞而不是覆盖', () => {
  const decision = evaluateDeliveryVerdict(
    facts({ verdict: { kind: 'deliverable', evidenceRefs: ['orca-result-1', 'unknown-ref'] } }),
  );

  expect(decision).toMatchObject({
    kind: 'blocked',
    code: 'evidence_conflicts_with_authoritative_facts',
  });
  expect(decision.kind === 'blocked' ? decision.mismatches : []).toEqual(['unknown-ref']);
});

test('可写项目级会话在最终版本与集成可核验时接受交付', () => {
  expect(
    evaluateDeliveryVerdict(
      facts({
        session: { kind: 'new_project', sessionBindingId: 'session-binding-2' },
        readOnly: false,
        verification: verification(),
      }),
    ),
  ).toEqual({
    kind: 'accepted',
    verdict: { kind: 'deliverable', evidenceRefs: ['orca-result-1'] },
    deliverable: true,
  });
});

test('旧只读会话不要求也不合成最终版本复验', () => {
  const decision = evaluateDeliveryVerdict(facts());

  expect(decision).toEqual({
    kind: 'accepted',
    verdict: { kind: 'deliverable', evidenceRefs: ['orca-result-1'] },
    deliverable: true,
  });
});

test('可写 Finalizer 缺少最终版本复验时阻塞', () => {
  expect(
    evaluateDeliveryVerdict(
      facts({ session: { kind: 'new_project', sessionBindingId: 'session-binding-2' }, readOnly: false }),
    ),
  ).toMatchObject({ kind: 'blocked', code: 'final_version_unverified' });
});

test.each([
  ['HEAD 不是完整 Git OID', { head: 'abc' }],
  ['tree 不是完整 Git OID', { tree: 'b'.repeat(39) }],
  ['HEAD 与期望版本不一致', { expectedHead: 'c'.repeat(40) }],
  ['tree 与期望版本不一致', { expectedTree: 'd'.repeat(40) }],
] satisfies readonly (readonly [string, Partial<FinalizerVerification>])[])(
  '可写 Finalizer 的 %s 时阻塞',
  (_label, overrides) => {
    expect(
      evaluateDeliveryVerdict(
        facts({
          session: { kind: 'new_project', sessionBindingId: 'session-binding-2' },
          readOnly: false,
          verification: verification(overrides),
        }),
      ),
    ).toMatchObject({ kind: 'blocked', code: 'final_version_unverified' });
  },
);

test.each([
  ['复验命令失败', [command({ outcome: 'failed' })]],
  ['只有非 command 证据', [command({ kind: 'inspection' })]],
  ['复验命令为空', [command({ command: '   ' })]],
  ['没有任何证据', []],
] satisfies readonly (readonly [string, readonly EvidenceRecord[]])[])(
  '可写 Finalizer %s 时不接受交付',
  (_label, commands) => {
    expect(
      evaluateDeliveryVerdict(
        facts({
          session: { kind: 'new_project', sessionBindingId: 'session-binding-2' },
          readOnly: false,
          verification: verification({ commands }),
        }),
      ),
    ).toMatchObject({ kind: 'blocked', code: 'verification_failed' });
  },
);

test.each([
  ['缺少集成引用', null],
  ['集成引用不在权威事实中', 'unknown-integration'],
] satisfies readonly (readonly [string, string | null])[])(
  '可写 Finalizer %s 时不接受交付',
  (_label, integrationRef) => {
    expect(
      evaluateDeliveryVerdict(
        facts({
          session: { kind: 'new_project', sessionBindingId: 'session-binding-2' },
          readOnly: false,
          verification: verification({ integrationRef }),
        }),
      ),
    ).toMatchObject({ kind: 'blocked', code: 'integration_unverified' });
  },
);
