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

import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
import type { SpecificationProvider } from '../../src/application/ports/specification-provider.js';
import { SPECIFICATION_BODY_MAX_BYTES } from '../../src/application/ports/specification-provider.js';
import { specificationUnitNameFor } from '../../src/domain/task-contract.js';
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

test('Planner 按 OpenSpec 惯例归档后，固定路径仍解析到同一 Specification Unit', async () => {
  const root = makeWorktree();
  const provider = providerFor({ [WORKTREE_ID]: root });
  const active = await admitSpecification(admissionInput({ provider }));

  // OpenSpec 的归档只改变位置：`changes/archive/<date>-<name>` 仍是同一个单元。
  const changeDir = join(root, 'openspec', 'changes', CHANGE);
  const archivedDir = join(root, 'openspec', 'changes', 'archive', `2026-09-24-${CHANGE}`);
  mkdirSync(join(root, 'openspec', 'changes', 'archive'), { recursive: true });
  renameSync(changeDir, archivedDir);

  const archived = await admitSpecification(admissionInput({ provider }));

  expect(active.kind).toBe('admitted');
  expect(archived.kind).toBe('admitted');
  if (active.kind !== 'admitted' || archived.kind !== 'admitted') {
    return;
  }
  expect(archived.specBinding.relativePath).toBe(`openspec/changes/${CHANGE}`);
  expect(archived.specBinding.contentDigest).toBe(active.specBinding.contentDigest);
});

test('归档内同名 change 不唯一时拒绝，而不是选一个', async () => {
  const root = makeWorktree();
  const provider = providerFor({ [WORKTREE_ID]: root });
  const archiveRoot = join(root, 'openspec', 'changes', 'archive');
  mkdirSync(archiveRoot, { recursive: true });
  renameSync(join(root, 'openspec', 'changes', CHANGE), join(archiveRoot, `2026-09-24-${CHANGE}`));
  mkdirSync(join(archiveRoot, `2026-09-25-${CHANGE}`), { recursive: true });

  const read = await provider.readUnit({
    worktreeId: WORKTREE_ID,
    relativePath: `openspec/changes/${CHANGE}`,
  });
  const result = await admitSpecification(admissionInput({ provider }));

  expect(read.kind === 'rejected' && read.failure.code).toBe('unit_ambiguous');
  expect(result.kind).toBe('rejected');
});

test('角色转换按 Work Package 固定路径读取，归档后仍然就绪', async () => {
  // 固定路径的名字由宿主派生（文件系统安全的 slug + 内容哈希后缀），测试从同一处读取而不是自己拼。
  const unitName = specificationUnitNameFor(WP);
  const root = makeWorktree({ changeName: unitName });
  const provider = providerFor({ [WORKTREE_ID]: root });
  const query = { role: 'implementation' as const, workPackageId: WP, worktreeId: WORKTREE_ID };

  const active = await provider.readRoleTransition(query);
  mkdirSync(join(root, 'openspec', 'changes', 'archive'), { recursive: true });
  renameSync(
    join(root, 'openspec', 'changes', unitName),
    join(root, 'openspec', 'changes', 'archive', `2026-09-24-${unitName}`),
  );
  const archived = await provider.readRoleTransition(query);

  expect(active.kind === 'read' && active.value.ready).toBe(true);
  expect(archived.kind === 'read' && archived.value.ready).toBe(true);
  expect(archived.kind === 'read' && archived.value.artifactKind).toBe('openspec-tasks');
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

/*
 * Requirement「Bounded native specification reading」：只读浏览的目录、范围与来源变化判定。
 * 断言只落在结构化错码、返回的身份与正文内容上，不锁内部实现。
 */

const LOCATOR = { worktreeId: WORKTREE_ID, relativePath: `openspec/changes/${CHANGE}` } as const;

async function filesOf(provider: SpecificationProvider, contractRevision: number, after: string | null = null) {
  const read = await provider.readFiles?.({ locator: LOCATOR, contractRevision, after });
  if (read === undefined) {
    throw new Error('OpenSpec provider 未实现只读目录');
  }
  return read;
}

async function rangeOf(
  provider: SpecificationProvider,
  contractRevision: number,
  path: string,
  offset: number,
  maxBytes: number,
  sourceVersion: string | null = null,
) {
  const read = await provider.readFileRange?.({
    locator: LOCATOR,
    contractRevision,
    path,
    offset,
    maxBytes,
    sourceVersion,
  });
  if (read === undefined) {
    throw new Error('OpenSpec provider 未实现正文范围读取');
  }
  return read;
}

/** 目录与正文都以已接纳的 `SpecBinding.contractRevision` 为身份。 */
async function admittedChange(changeName: string = CHANGE) {
  const root = makeWorktree({ changeName });
  const provider = providerFor({ [WORKTREE_ID]: root });
  const result = await admitSpecification(
    admissionInput({
      provider,
      declaration: {
        role: 'planner',
        producer: { kind: 'worker', role: 'planner', sessionBindingId: 'binding-1' },
        workPackageId: WP,
        worktreeId: WORKTREE_ID,
        relativePath: `openspec/changes/${changeName}`,
        declaredVersion: 1,
      },
    }),
  );
  if (result.kind !== 'admitted') {
    throw new Error(`OpenSpec change 未被接纳: ${result.kind}`);
  }
  return {
    provider,
    root,
    changeDir: join(root, 'openspec', 'changes', changeName),
    contractRevision: result.specBinding.contractRevision,
  };
}

test('只读目录按已接纳的契约版本分页，条目给出的路径就是正文 URI', async () => {
  const unit = await admittedChange();
  mkdirSync(join(unit.changeDir, 'evidence'), { recursive: true });
  for (let index = 0; index < 25; index += 1) {
    writeFileSync(join(unit.changeDir, 'evidence', `note-${index}.md`), `证据 ${index}\n`, 'utf8');
  }

  const first = await filesOf(unit.provider, unit.contractRevision);
  if (first.kind !== 'read') {
    throw new Error('目录读取应成功');
  }
  expect(first.value.items).toHaveLength(20);
  expect(first.value.nextCursor).not.toBeNull();
  expect(first.value.items.every((item) => item.sourceVersion.length > 0 && item.byteLength > 0)).toBe(true);

  const second = await filesOf(unit.provider, unit.contractRevision, first.value.nextCursor);
  if (second.kind !== 'read') {
    throw new Error('目录续读应成功');
  }
  expect(second.value.items).toHaveLength(9);
  expect(second.value.nextCursor).toBeNull();
  const all = [...first.value.items, ...second.value.items];
  expect(new Set(all.map((item) => item.path)).size).toBe(29);

  const entry = all.find((item) => item.path === 'specs/execution/spec.md');
  expect(entry).toBeDefined();
  const body = await rangeOf(
    unit.provider,
    unit.contractRevision,
    'specs/execution/spec.md',
    0,
    SPECIFICATION_BODY_MAX_BYTES,
    entry?.sourceVersion ?? null,
  );
  expect(body.kind === 'read' && body.value.text).toContain('### Requirement: 例子行为');
});

test('tasks 追踪变化不改契约工件，tasks.md 自己换版本', async () => {
  const unit = await admittedChange();
  const before = await filesOf(unit.provider, unit.contractRevision);
  if (before.kind !== 'read') {
    throw new Error('目录读取应成功');
  }
  const tasksBefore = before.value.items.find((item) => item.path === 'tasks.md');
  const specBefore = before.value.items.find((item) => item.path === 'specs/execution/spec.md');

  // 只改追踪：契约工件一个字节都没动，绑定必须继续成立。
  writeFileSync(
    join(unit.changeDir, 'tasks.md'),
    ['## 1. 实现', '', '- [x] 1.1 已完成', '- [x] 1.2 未完成', '- [x] 1.3 复验完成', ''].join('\n'),
    'utf8',
  );

  const after = await filesOf(unit.provider, unit.contractRevision);
  if (after.kind !== 'read') {
    throw new Error('追踪变化后契约绑定仍应可读');
  }
  const tasksAfter = after.value.items.find((item) => item.path === 'tasks.md');
  const specAfter = after.value.items.find((item) => item.path === 'specs/execution/spec.md');
  expect(tasksAfter?.sourceVersion).not.toBe(tasksBefore?.sourceVersion);
  expect(specAfter?.sourceVersion).toBe(specBefore?.sourceVersion);

  const spec = await rangeOf(
    unit.provider,
    unit.contractRevision,
    'specs/execution/spec.md',
    0,
    SPECIFICATION_BODY_MAX_BYTES,
    specBefore?.sourceVersion ?? null,
  );
  expect(spec.kind).toBe('read');

  const stale = await rangeOf(
    unit.provider,
    unit.contractRevision,
    'tasks.md',
    0,
    SPECIFICATION_BODY_MAX_BYTES,
    tasksBefore?.sourceVersion ?? null,
  );
  expect(stale.kind === 'rejected' && stale.failure.code).toBe('source_version_stale');

  const fresh = await rangeOf(unit.provider, unit.contractRevision, 'tasks.md', 0, SPECIFICATION_BODY_MAX_BYTES);
  expect(fresh.kind === 'read' && fresh.value.sourceVersion).toBe(tasksAfter?.sourceVersion);
});

test('契约内容变化后按旧绑定读取被拒绝，按新版本可读', async () => {
  const unit = await admittedChange();
  writeFileSync(
    join(unit.changeDir, 'specs', 'execution', 'spec.md'),
    ['## ADDED Requirements', '', '### Requirement: 例子行为', '', '行为应当成立，并且留下证据。', ''].join('\n'),
    'utf8',
  );

  const listed = await filesOf(unit.provider, unit.contractRevision);
  expect(listed.kind === 'rejected' && listed.failure.code).toBe('contract_revision_changed');

  const ranged = await rangeOf(unit.provider, unit.contractRevision, 'specs/execution/spec.md', 0, 1024);
  expect(ranged.kind === 'rejected' && ranged.failure.code).toBe('contract_revision_changed');

  const reopened = await unit.provider.readUnit(LOCATOR);
  if (reopened.kind !== 'read') {
    throw new Error('读取新版本应成功');
  }
  const body = await rangeOf(
    unit.provider,
    reopened.value.contractRevision,
    'specs/execution/spec.md',
    0,
    1024,
  );
  expect(body.kind === 'read' && body.value.text).toContain('行为应当成立，并且留下证据。');
});

test('越界、绝对路径与符号链接一律拒绝，未列出的 unit 内文件也不暴露', async () => {
  const unit = await admittedChange();
  writeFileSync(join(unit.root, 'outside.md'), 'worktree 内、unit 之外\n', 'utf8');
  symlinkSync(join(unit.root, 'outside.md'), join(unit.changeDir, 'leak.md'));
  symlinkSync(join(unit.changeDir, 'tasks.md'), join(unit.changeDir, 'alias.md'));

  const listed = await filesOf(unit.provider, unit.contractRevision);
  if (listed.kind !== 'read') {
    throw new Error('目录读取应成功');
  }
  const paths = listed.value.items.map((item) => item.path);
  expect(paths).not.toContain('leak.md');
  expect(paths).not.toContain('alias.md');

  for (const path of ['../design.md', '/etc/hostname', 'leak.md']) {
    const read = await rangeOf(unit.provider, unit.contractRevision, path, 0, 1024);
    expect(read.kind === 'rejected' && read.failure.code).toBe('unit_outside_worktree');
  }
  // unit 内的符号链接指向已列出的工件也不放行：目录是这次阅读认定的工件集合。
  const unlisted = await rangeOf(unit.provider, unit.contractRevision, 'alias.md', 0, 1024);
  expect(unlisted.kind === 'rejected' && unlisted.failure.code).toBe('file_not_in_unit');
  for (const path of ['evidence', 'not-a-file.md']) {
    const read = await rangeOf(unit.provider, unit.contractRevision, path, 0, 1024);
    expect(read.kind === 'rejected' && read.failure.code).toBe('file_absent');
  }
});

test('大正文按 64 KiB 跨块分页完整读出，中文不被切断', async () => {
  const unit = await admittedChange();
  mkdirSync(join(unit.changeDir, 'evidence'), { recursive: true });
  const body = `${'中文正文证据。'.repeat(60_000)}\n`;
  writeFileSync(join(unit.changeDir, 'evidence', 'long.md'), body, 'utf8');
  const badOffset = await rangeOf(unit.provider, unit.contractRevision, 'evidence/long.md', 1, 1024);
  expect(badOffset.kind === 'rejected' && badOffset.failure.code).toBe('range_invalid');

  const listed = await filesOf(unit.provider, unit.contractRevision);
  if (listed.kind !== 'read') {
    throw new Error('目录读取应成功');
  }
  const entry = listed.value.items.find((item) => item.path === 'evidence/long.md');
  expect(entry?.byteLength).toBe(Buffer.byteLength(body, 'utf8'));

  const pages: string[] = [];
  let offset = 0;
  let sourceVersion: string | null = entry?.sourceVersion ?? null;
  for (let turn = 0; turn < 20 && offset < (entry?.byteLength ?? 0); turn += 1) {
    const page = await rangeOf(
      unit.provider,
      unit.contractRevision,
      'evidence/long.md',
      offset,
      SPECIFICATION_BODY_MAX_BYTES,
      sourceVersion,
    );
    if (page.kind !== 'read') {
      throw new Error(`第 ${turn + 1} 页读取失败`);
    }
    pages.push(page.value.text);
    expect(page.value.byteLength).toBe(entry?.byteLength);
    offset = page.value.end;
    sourceVersion = page.value.sourceVersion;
  }
  const joined = pages.join('');
  expect(joined).toBe(body);
  expect(joined).not.toContain('\uFFFD');
  expect(offset).toBe(entry?.byteLength);
  writeFileSync(join(unit.changeDir, 'evidence', 'invalid.md'), Buffer.from([0x41, 0xe4, 0xb8]));
  const invalidUtf8 = await rangeOf(unit.provider, unit.contractRevision, 'evidence/invalid.md', 0, 1024);
  expect(invalidUtf8.kind).toBe('rejected');
});

test('正文上限、范围参数与不可解析的绑定各自明确拒绝', async () => {
  const unit = await admittedChange();

  const tooLarge = await rangeOf(
    unit.provider,
    unit.contractRevision,
    'proposal.md',
    0,
    SPECIFICATION_BODY_MAX_BYTES + 1,
  );
  expect(tooLarge.kind === 'rejected' && tooLarge.failure.code).toBe('body_limit_exceeded');

  const invalidRanges: ReadonlyArray<readonly [number, number]> = [
    [-1, 1024],
    [0, 0],
    [0, 3],
  ];
  for (const [offset, maxBytes] of invalidRanges) {
    const invalid = await rangeOf(unit.provider, unit.contractRevision, 'proposal.md', offset, maxBytes);
    expect(invalid.kind === 'rejected' && invalid.failure.code).toBe('range_invalid');
  }

  const badRevision = await filesOf(unit.provider, -1);
  expect(badRevision.kind === 'rejected' && badRevision.failure.code).toBe('contract_revision_invalid');

  const beyond = await rangeOf(unit.provider, unit.contractRevision, 'proposal.md', 10_000_000, 1024);
  expect(beyond.kind === 'rejected' && beyond.failure.code).toBe('range_invalid');
});

test('归档后的同一 unit 仍可按原绑定阅读，同名歧义不选', async () => {
  const unit = await admittedChange();
  const archiveRoot = join(unit.root, 'openspec', 'changes', 'archive');
  mkdirSync(archiveRoot, { recursive: true });
  renameSync(unit.changeDir, join(archiveRoot, `2026-09-24-${CHANGE}`));

  const archived = await filesOf(unit.provider, unit.contractRevision);
  if (archived.kind !== 'read') {
    throw new Error('归档后仍应可读');
  }
  expect(archived.value.items.map((item) => item.path)).toContain('specs/execution/spec.md');

  mkdirSync(join(archiveRoot, `2026-09-25-${CHANGE}`), { recursive: true });
  const ambiguous = await filesOf(providerFor({ [WORKTREE_ID]: unit.root }), unit.contractRevision);
  expect(ambiguous.kind === 'rejected' && ambiguous.failure.code).toBe('unit_ambiguous');
});

test('worktree 解析不出与 unit 消失各自明确拒绝', async () => {
  const unit = await admittedChange();
  const unresolved = await providerFor({}).readFiles?.({
    locator: LOCATOR,
    contractRevision: unit.contractRevision,
    after: null,
  });
  expect(unresolved?.kind === 'rejected' && unresolved.failure.code).toBe('worktree_unresolved');

  rmSync(unit.changeDir, { recursive: true, force: true });
  const absent = await filesOf(unit.provider, unit.contractRevision);
  expect(absent.kind === 'rejected' && absent.failure.code).toBe('unit_absent');
});
