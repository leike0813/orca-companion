/**
 * Specification Admission 与 Spec Binding 测试
 * （change: `m1-admit-work-package-specifications`，Owner: IP-A4）。
 *
 * 覆盖 Requirement「Specification Planner 在 Work Package 的 worktree 内编写工具原生 Specification
 * Unit」、「确定性 Specification Admission 与 Spec Binding」与「可选 Specification Validator 作为
 * 独立质量门」的全部 Scenario：
 * - 临时 worktree 内的 OpenSpec change 被接纳并给出内容摘要绑定；
 * - worktree 之外生成的规格被拒绝，Work Package 留在未接纳状态；
 * - 内容变化与「只改勾选」都产生新的绑定摘要；
 * - 超出 Scope Envelope 时逐条报告失败项；
 * - 质量门开启时派发独立审查，关闭时零额外派发。
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'vitest';

import type { WorkPackageId } from '../../src/application/dto/identity.js';
import {
  admitSpecification,
  admitSpecificationWithValidatorGate,
  pathWithinEnvelope,
  pathWithinWorktree,
  runSpecificationValidatorGate,
  specBindingOf,
  specificationValidatorGate,
} from '../../src/application/specification-admission.js';
import {
  createOpenSpecProvider,
  declaredScopeFromProposal,
  countCheckedTasks,
  countRequirements,
  resolveWithinWorktree,
} from '../../src/adapters/specification/openspec/provider.js';
import { workPackageBudgetKey } from '../../src/domain/dispatch-candidate.js';
import type { RoleAuthorities } from '../../src/domain/planning/execution-authorization.js';
import type { ScopeEnvelope } from '../../src/domain/planning/execution-graph.js';

const WP = 'wp-1' as WorkPackageId;
const WORKTREE_ID = 'repo-1::/tmp/worktrees/wp-1';
const CHANGE = 'm1-example-change';

const AUTHORITY: RoleAuthorities = {
  planner: true,
  implementation: true,
  validator: true,
  finalizer: true,
  gitIntegration: false,
  dependencyChanges: false,
};

const ENVELOPE: ScopeEnvelope = { include: ['src/domain', 'src/application'], exclude: [] };

let directories: string[] = [];

function makeWorktree(options: { readonly changeName?: string; readonly impact?: string; readonly proposalExtra?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-openspec-'));
  directories.push(root);
  const changeName = options.changeName ?? CHANGE;
  const changeDir = join(root, 'openspec', 'changes', changeName);
  mkdirSync(join(changeDir, 'specs', 'execution'), { recursive: true });
  writeFileSync(
    join(changeDir, 'proposal.md'),
    [
      '## Why',
      '',
      '需要一个例子 change。',
      '',
      '## What Changes',
      '',
      '- 新增行为。',
      '',
      '## Impact',
      '',
      options.impact ?? '- `src/domain` 与 `src/application`\n',
      options.proposalExtra ?? '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(changeDir, 'tasks.md'),
    ['## 1. 实现', '', '- [x] 1.1 已完成', '- [ ] 1.2 未完成', ''].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(changeDir, 'specs', 'execution', 'spec.md'),
    ['## ADDED Requirements', '', '### Requirement: 例子行为', '', '行为必须成立。', ''].join('\n'),
    'utf8',
  );
  writeFileSync(join(changeDir, 'design.md'), '# Design\n\n例子设计。\n', 'utf8');
  return root;
}

function providerFor(roots: Readonly<Record<string, string>>) {
  return createOpenSpecProvider({ resolveWorktreeRoot: (worktreeId) => roots[worktreeId] ?? null });
}

function admissionInput(overrides: Partial<Parameters<typeof admitSpecification>[0]> = {}) {
  const root = makeWorktree();
  const provider = providerFor({ [WORKTREE_ID]: root });
  return {
    provider,
    declaration: {
      role: 'planner' as const,
      producer: { kind: 'worker' as const, role: 'planner' as const, sessionBindingId: 'binding-1' },
      workPackageId: WP,
      worktreeId: WORKTREE_ID,
      relativePath: `openspec/changes/${CHANGE}`,
      declaredVersion: 1,
    },
    worktreeId: WORKTREE_ID,
    workPackageId: WP,
    scopeEnvelope: ENVELOPE,
    authority: AUTHORITY,
    contractSchemaVersion: 1,
    consumedSpecificationRevisions: 0,
    specificationRevisionLimit: 2,
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
  directories = [];
});

test('worktree 内的 OpenSpec change 被接纳并记录内容摘要绑定', async () => {
  const input = admissionInput();
  const result = await admitSpecification(input);

  expect(result.kind).toBe('admitted');
  if (result.kind !== 'admitted') {
    return;
  }
  expect(result.specBinding.provider).toBe('openspec');
  expect(result.specBinding.relativePath).toBe(`openspec/changes/${CHANGE}`);
  expect(result.specBinding.contentDigest).toMatch(/^[0-9a-f]{64}$/);
  expect(result.specBinding.providerVersion).toBe('1');
  expect(result.specBinding.contractRevision).toBeGreaterThan(0);
  expect(result.specBinding.trackingRevision).toBeGreaterThan(0);
});

test('worktree 之外的规格被拒绝，Work Package 留在未接纳状态', async () => {
  const root = makeWorktree();
  const provider = providerFor({ [WORKTREE_ID]: root });

  const outside = await admitSpecification(
    admissionInput({
      provider,
      declaration: {
        role: 'planner',
        producer: { kind: 'worker', role: 'planner', sessionBindingId: 'binding-1' },
        workPackageId: WP,
        worktreeId: WORKTREE_ID,
        relativePath: '/etc/openspec/changes/elsewhere',
        declaredVersion: 1,
      },
    }),
  );
  const escaping = await admitSpecification(
    admissionInput({
      provider,
      declaration: {
        role: 'planner',
        producer: { kind: 'worker', role: 'planner', sessionBindingId: 'binding-1' },
        workPackageId: WP,
        worktreeId: WORKTREE_ID,
        relativePath: 'openspec/../../elsewhere',
        declaredVersion: 1,
      },
    }),
  );
  const wrongWorktree = await admitSpecification(
    admissionInput({
      provider,
      declaration: {
        role: 'planner',
        producer: { kind: 'worker', role: 'planner', sessionBindingId: 'binding-1' },
        workPackageId: WP,
        worktreeId: 'other-worktree',
        relativePath: `openspec/changes/${CHANGE}`,
        declaredVersion: 1,
      },
    }),
  );

  expect(outside.kind).toBe('rejected');
  expect(escaping.kind).toBe('rejected');
  expect(wrongWorktree.kind).toBe('rejected');
  if (outside.kind === 'rejected') {
    expect(outside.failures.map((failure) => failure.code)).toContain('worktree_mismatch');
  }
});

test('Coordinator Session 直接写入的规格不能冒充 Planner Worker', async () => {
  const result = await admitSpecification(
    admissionInput({
      declaration: {
        role: 'planner',
        producer: { kind: 'coordinator-session', coordinatorSessionId: 'session-1' },
        workPackageId: WP,
        worktreeId: WORKTREE_ID,
        relativePath: `openspec/changes/${CHANGE}`,
        declaredVersion: 1,
      },
    }),
  );
  expect(result.kind).toBe('rejected');
  if (result.kind === 'rejected') {
    expect(result.failures.map((failure) => failure.field)).toContain('declaration.producer');
  }
});

test('内容变化与只改勾选都产生新的绑定摘要', async () => {
  const root = makeWorktree();
  const provider = providerFor({ [WORKTREE_ID]: root });
  const first = await admitSpecification(admissionInput({ provider }));

  // 只改勾选：Tracking Revision 与摘要都必须变化。
  writeFileSync(
    join(root, 'openspec', 'changes', CHANGE, 'tasks.md'),
    ['## 1. 实现', '', '- [x] 1.1 已完成', '- [x] 1.2 也已完成', ''].join('\n'),
    'utf8',
  );
  const trackingOnly = await admitSpecification(admissionInput({ provider }));

  // 改契约内容：新增一条 Requirement。
  writeFileSync(
    join(root, 'openspec', 'changes', CHANGE, 'specs', 'execution', 'spec.md'),
    [
      '## ADDED Requirements',
      '',
      '### Requirement: 例子行为',
      '',
      '行为必须成立。',
      '',
      '### Requirement: 第二条行为',
      '',
      '第二条行为也必须成立。',
      '',
    ].join('\n'),
    'utf8',
  );
  const contractChanged = await admitSpecification(admissionInput({ provider }));

  expect(first.kind).toBe('admitted');
  expect(trackingOnly.kind).toBe('admitted');
  expect(contractChanged.kind).toBe('admitted');
  if (first.kind !== 'admitted' || trackingOnly.kind !== 'admitted' || contractChanged.kind !== 'admitted') {
    return;
  }
  expect(trackingOnly.specBinding.contentDigest).not.toBe(first.specBinding.contentDigest);
  expect(trackingOnly.specBinding.trackingRevision).not.toBe(first.specBinding.trackingRevision);
  expect(contractChanged.specBinding.contentDigest).not.toBe(trackingOnly.specBinding.contentDigest);
  expect(contractChanged.specBinding.contractRevision).not.toBe(trackingOnly.specBinding.contractRevision);
});

test('超出 Scope Envelope 时拒绝接纳并报告具体检查项', async () => {
  const root = makeWorktree({ impact: '- `src/domain`\n- `src/secret-package`\n' });
  const provider = providerFor({ [WORKTREE_ID]: root });

  const result = await admitSpecification(admissionInput({ provider }));

  expect(result.kind).toBe('rejected');
  if (result.kind !== 'rejected') {
    return;
  }
  const exceeded = result.failures.filter((failure) => failure.code === 'scope_envelope_exceeded');
  expect(exceeded).toHaveLength(1);
  expect(exceeded[0]?.message).toContain('src/secret-package');
});

test('版本、authority 与预算不通过时分别给出对应检查项', async () => {
  const root = makeWorktree();
  const provider = providerFor({ [WORKTREE_ID]: root });

  const wrongRole = await admitSpecification(
    admissionInput({
      provider,
      declaration: {
        role: 'implementation',
        producer: { kind: 'worker', role: 'implementation', sessionBindingId: 'binding-1' },
        workPackageId: WP,
        worktreeId: WORKTREE_ID,
        relativePath: `openspec/changes/${CHANGE}`,
        declaredVersion: 1,
      },
    }),
  );
  const unauthorized = await admitSpecification(
    admissionInput({ provider, authority: { ...AUTHORITY, planner: false } }),
  );
  const overBudget = await admitSpecification(
    admissionInput({ provider, consumedSpecificationRevisions: 2, specificationRevisionLimit: 2 }),
  );
  const wrongVersion = await admitSpecification(admissionInput({ provider, contractSchemaVersion: 9 }));
  const wrongDeclaredVersion = await admitSpecification(
    admissionInput({
      provider,
      declaration: {
        role: 'planner',
        producer: { kind: 'worker', role: 'planner', sessionBindingId: 'binding-1' },
        workPackageId: WP,
        worktreeId: WORKTREE_ID,
        relativePath: `openspec/changes/${CHANGE}`,
        declaredVersion: 2,
      },
    }),
  );

  expect(wrongRole.kind).toBe('rejected');
  expect(unauthorized.kind).toBe('rejected');
  expect(overBudget.kind).toBe('rejected');
  expect(wrongVersion.kind).toBe('rejected');
  expect(wrongDeclaredVersion.kind).toBe('rejected');
  if (overBudget.kind === 'rejected') {
    expect(overBudget.failures.map((failure) => failure.code)).toContain('budget_exhausted');
    expect(workPackageBudgetKey(WP, 'specificationRevisions')).toContain('specificationRevisions');
  }
  if (wrongVersion.kind === 'rejected') {
    expect(wrongVersion.failures.map((failure) => failure.code)).toContain('contract_revision_unsupported');
  }
});

test('质量门开启时派出独立审查角色，关闭时零额外派发', async () => {
  const dispatched: string[] = [];
  const record = (role: 'validator') => {
    dispatched.push(role);
    return Promise.resolve({
      reportId: 'review-1',
      summary: '规格可实施',
      evidence: [
        {
          evidenceId: 'review-evidence-1',
          kind: 'review' as const,
          coveredPaths: ['openspec/changes/example'],
          command: 'openspec validate example --strict',
          summary: '规格校验通过',
          outcome: 'passed' as const,
        },
      ],
    });
  };

  const disabled = await runSpecificationValidatorGate({ enabled: false, review: record });
  expect(disabled).toEqual({ enabled: false, reviewerRole: null, report: null, passed: true });
  expect(dispatched).toHaveLength(0);

  const enabled = await runSpecificationValidatorGate({ enabled: true, review: record });
  expect(enabled.reviewerRole).toBe('validator');
  expect(enabled.report?.reportId).toBe('review-1');
  expect(enabled.passed).toBe(true);
  expect(dispatched).toEqual(['validator']);
  // 审查角色独立于 Planner：质量门不把 Planner 自审当作独立结论。
  expect(dispatched).not.toContain('planner');
  expect(specificationValidatorGate(true).reviewerRole).toBe('validator');
});

test('质量门启用时未通过的独立 Worker Result 阻止接纳', async () => {
  const result = await admitSpecificationWithValidatorGate({
    admission: admissionInput(),
    validatorEnabled: true,
    review: () => Promise.resolve({
      reportId: 'review-failed',
      summary: '规格仍有阻塞项',
      evidence: [
        {
          evidenceId: 'review-evidence-failed',
          kind: 'review',
          coveredPaths: ['openspec/changes/example'],
          command: 'openspec validate example --strict',
          summary: '规格校验失败',
          outcome: 'failed',
        },
      ],
    }),
  });

  expect(result.kind).toBe('rejected');
  if (result.kind === 'rejected') {
    expect(result.failures.map((failure) => failure.code)).toContain('validator_gate_failed');
  }
});

test('接纳结果不宣称语义完备', async () => {
  const result = await admitSpecification(admissionInput());

  expect(result.kind).toBe('admitted');
  if (result.kind !== 'admitted') {
    return;
  }
  const keys = Object.keys(result);
  expect(keys).toEqual(['kind', 'specBinding']);
  expect(keys).not.toContain('semanticallyComplete');
  expect(keys).not.toContain('verdict');
});

test('路径判定与 provider 解析保持在 worktree 与 Scope Envelope 内', () => {
  expect(pathWithinEnvelope(ENVELOPE, 'src/domain/x.ts')).toBe(true);
  expect(pathWithinEnvelope(ENVELOPE, 'src/domain')).toBe(true);
  expect(pathWithinEnvelope(ENVELOPE, 'src/other/x.ts')).toBe(false);
  expect(pathWithinEnvelope({ include: ['src/domain/x.ts'], exclude: [] }, 'src/domain')).toBe(false);
  expect(pathWithinEnvelope({ include: ['src'], exclude: ['src/private'] }, 'src/private/key.ts')).toBe(false);
  expect(pathWithinEnvelope({ include: ['src'], exclude: ['src/private'] }, 'src')).toBe(false);
  expect(pathWithinEnvelope(ENVELOPE, 'src/domain/../private')).toBe(false);

  expect(pathWithinWorktree('openspec/changes/x')).toBe(true);
  expect(pathWithinWorktree('/abs/path')).toBe(false);
  expect(pathWithinWorktree('openspec/../../etc')).toBe(false);
  expect(pathWithinWorktree('')).toBe(false);
  expect(resolveWithinWorktree('/tmp/root', '../escape')).toBeNull();
  expect(resolveWithinWorktree('/tmp/root', 'a/b')).toBe(join('/tmp/root', 'a/b'));
});

test('指向 worktree 外的 OpenSpec change 符号链接被拒绝', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-openspec-link-'));
  directories.push(root);
  const externalRoot = makeWorktree({ changeName: 'outside-change' });
  mkdirSync(join(root, 'openspec', 'changes'), { recursive: true });
  symlinkSync(
    join(externalRoot, 'openspec', 'changes', 'outside-change'),
    join(root, 'openspec', 'changes', CHANGE),
    'dir',
  );
  const result = await admitSpecification(
    admissionInput({ provider: providerFor({ [WORKTREE_ID]: root }) }),
  );
  expect(result.kind).toBe('rejected');
});

test('OpenSpec 原生工件解析是确定性的', () => {
  const proposal = ['## Impact', '', '- `src/domain`', '- 没有反引号', '- `src/application/x.ts`', ''].join('\n');
  expect(declaredScopeFromProposal(proposal)).toEqual([
    { kind: 'include', path: 'src/domain' },
    { kind: 'include', path: 'src/application/x.ts' },
  ]);
  expect(countCheckedTasks('- [x] a\n- [X] b\n- [ ] c\n')).toBe(2);
  expect(countRequirements(['### Requirement: A', '### Requirement: B', '#### Not a requirement'])).toBe(2);
});

test('Spec Binding 的身份来自内容摘要与版本，而不是路径', () => {
  const base = {
    provider: 'openspec',
    providerVersion: '1',
    locator: { worktreeId: WORKTREE_ID, relativePath: 'openspec/changes/x' },
    contentDigest: 'digest-1',
    declaredScope: [],
    structureVersion: 1,
    contractRevision: 1,
    trackingRevision: 1,
  };
  const sameContentOtherPath = specBindingOf(
    { ...base, locator: { worktreeId: WORKTREE_ID, relativePath: 'openspec/changes/y' } },
    'openspec',
  );
  const changedContent = specBindingOf({ ...base, contentDigest: 'digest-2' }, 'openspec');

  expect(sameContentOtherPath.relativePath).toBe('openspec/changes/y');
  expect(sameContentOtherPath.contentDigest).toBe('digest-1');
  expect(changedContent.contentDigest).toBe('digest-2');
});
