/**
 * 三个独立事实的状态模型测试
 * （change: `m1-execute-and-validate-work-packages`，Owner: IP-B1）。
 *
 * 覆盖 Requirement「实现完成、验证通过与项目可交付是三个独立事实」的两个 Scenario：
 * 实现完成不推进验证状态；全部任务通过验证也不自动产生项目级可交付结论。
 */

import { expect, test } from 'vitest';

import type { WorkPackageId } from '../../src/application/dto/identity.js';
import {
  initialWorkPackageStatus,
  projectIsDeliverable,
  withDeliveryStatus,
  withImplementationStatus,
  withValidationStatus,
} from '../../src/domain/work-package-status.js';

const WP = 'wp-1' as WorkPackageId;
const WP2 = 'wp-2' as WorkPackageId;

test('实现完成不表示验证通过', () => {
  const status = withImplementationStatus(initialWorkPackageStatus(WP), {
    kind: 'implemented',
    attemptId: 'attempt-1',
    acceptedResultRef: 'orca-result-1',
  });

  expect(status.implementation.kind).toBe('implemented');
  expect(status.validation).toEqual({ kind: 'not_validated' });
  expect(status.delivery).toEqual({ kind: 'not_finalized' });
});

test('验证通过只推进验证状态，不推出交付结论', () => {
  const implemented = withImplementationStatus(initialWorkPackageStatus(WP), {
    kind: 'implemented',
    attemptId: 'attempt-1',
    acceptedResultRef: 'orca-result-1',
  });
  const validated = withValidationStatus(implemented, {
    kind: 'validated',
    validationAttemptId: 'validation-1',
    acceptedResultRef: 'orca-result-2',
  });

  expect(validated.implementation.kind).toBe('implemented');
  expect(validated.delivery).toEqual({ kind: 'not_finalized' });
});

test('全部任务通过不自动表示项目可交付', () => {
  const statuses = [WP, WP2].map((id) =>
    withValidationStatus(initialWorkPackageStatus(id), {
      kind: 'validated',
      validationAttemptId: `validation-${id}`,
      acceptedResultRef: `orca-result-${id}`,
    }),
  );

  expect(statuses.every((status) => status.validation.kind === 'validated')).toBe(true);
  expect(statuses.every((status) => status.delivery.kind === 'not_finalized')).toBe(true);
  expect(projectIsDeliverable(statuses)).toBe(false);
});

test('只有写入交付结论后项目才可交付', () => {
  const delivered = [WP, WP2].map((id) =>
    withDeliveryStatus(initialWorkPackageStatus(id), { kind: 'deliverable', verdictRef: 'verdict-1' }),
  );

  expect(projectIsDeliverable(delivered)).toBe(true);
  // 交付状态不反向推出验证状态：两个事实各自独立保留。
  expect(delivered.every((status) => status.validation.kind === 'not_validated')).toBe(true);
});

test('空集合不构成可交付结论', () => {
  expect(projectIsDeliverable([])).toBe(false);
});
