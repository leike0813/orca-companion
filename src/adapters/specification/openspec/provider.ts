/**
 * IC-06 / IP-A4：OpenSpec `SpecificationProvider`（Owner: `m1-admit-work-package-specifications`）。
 *
 * 这个 adapter 只做一件事：把某个 worktree 里的 OpenSpec 原生工件读成一棵确定的事实——哪些契约
 * 工件存在、内容摘要是什么、规格声明了哪些路径、任务勾选到什么程度。它不写业务状态、不解析
 * OpenSpec 的 artifact 图、不实现第二套 change 工作流，也不替 Controller 判断规格是否完备。
 *
 * worktree 根目录由注入的 resolver 给出：adapter 不从 cwd、mtime 或「最近的 worktree」推断路径。
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import type {
  SpecificationReadFailure,
  SpecificationReadResult,
  SpecificationProvider,
} from '../../../application/ports/specification-provider.js';
import type {
  RoleTransitionQuery,
  RoleTransitionState,
  SpecificationUnitLocator,
  SpecificationUnitScopeEntry,
  SpecificationUnitSnapshot,
} from '../../../domain/task-contract.js';

export const OPENSPEC_PROVIDER_ID = 'openspec';

/** provider 版本：读取语义变化时递增，使既有 Spec Binding 不再被当作同一解释。 */
export const OPENSPEC_PROVIDER_VERSION = '1';

/** 本 adapter 支持的 OpenSpec unit 结构版本；读取到别的结构必须拒绝，而不是尽力解析。 */
export const OPENSPEC_STRUCTURE_VERSION = 1;

/** OpenSpec change 的工件目录；与 OpenSpec 自身的布局一致。 */
export const OPENSPEC_CHANGES_DIR = 'openspec/changes';

const CONTRACT_ARTIFACTS = ['proposal.md', 'design.md', 'implementation-plan.md'] as const;

export type OpenSpecProviderOptions = {
  /** worktree 身份 → 该 worktree 的绝对根目录；解析不出即拒绝，不做任何猜测。 */
  readonly resolveWorktreeRoot: (worktreeId: string) => string | null;
  readonly providerVersion?: string;
};

type UnitFiles = {
  readonly root: string;
  readonly changeDir: string;
  readonly changeName: string;
  readonly files: readonly string[];
  readonly digest: string;
  readonly declaredScope: readonly SpecificationUnitScopeEntry[];
  readonly contractRevision: number;
  readonly trackingRevision: number;
};

function failure(code: string, message: string): SpecificationReadFailure {
  return { code, message };
}

function rejected<T>(code: string, message: string): SpecificationReadResult<T> {
  return { kind: 'rejected', failure: failure(code, message) };
}

function readFileOrNull(absolutePath: string): string | null {
  try {
    return readFileSync(absolutePath, 'utf8');
  } catch {
    // 读取失败与「文件不存在」在读取语义上没有区别：两者都只能给出拒绝，而不是空内容。
    return null;
  }
}

function listFilesOrNull(directory: string): readonly string[] | null {
  try {
    return listFiles(directory, '');
  } catch {
    return null;
  }
}

/**
 * 把 worktree 相对路径解析成绝对路径，并证明它没有逃出 worktree。
 *
 * 越界（绝对路径、`..` 上跳、符号链接之外的目标）一律返回 `null`：worktree 之外的规格必须被拒绝。
 */
export function resolveWithinWorktree(worktreeRoot: string, relativePath: string): string | null {
  if (relativePath.length === 0) {
    return null;
  }
  const root = resolve(worktreeRoot);
  const target = resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    return null;
  }
  if (target === root) {
    return null;
  }
  if (existsSync(root) && existsSync(target)) {
    try {
      const realRoot = realpathSync(root);
      const realTarget = realpathSync(target);
      if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${sep}`)) {
        return null;
      }
    } catch {
      return null;
    }
  }
  return target;
}

/** 从 `## Impact` 段落里抽取反引号路径；这是 OpenSpec 原生的影响范围声明位置。 */
export function declaredScopeFromProposal(proposal: string): readonly SpecificationUnitScopeEntry[] {
  const lines = proposal.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => /^##\s+Impact\s*$/.test(line.trim()));
  if (startIndex === -1) {
    return [];
  }
  const entries: SpecificationUnitScopeEntry[] = [];
  for (const line of lines.slice(startIndex + 1)) {
    if (/^##\s+/.test(line.trim())) {
      break;
    }
    for (const match of line.matchAll(/`([^`]+)`/g)) {
      const candidate = match[1];
      if (candidate === undefined || candidate.includes(' ')) {
        continue;
      }
      if (!/[/.]/.test(candidate)) {
        continue;
      }
      entries.push({ kind: 'include', path: candidate });
    }
  }
  return entries;
}

/** `### Requirement:` 计数；契约内容的结构版本由它表达，而非文件 mtime。 */
export function countRequirements(fileContents: readonly string[]): number {
  let count = 0;
  for (const content of fileContents) {
    for (const line of content.split(/\r?\n/)) {
      if (/^###\s+Requirement:/.test(line.trim())) {
        count += 1;
      }
    }
  }
  return count;
}

/** 已勾选任务计数；只改勾选也会改变这个计数，因此 Tracking Revision 有独立语义。 */
export function countCheckedTasks(tasks: string): number {
  let count = 0;
  for (const line of tasks.split(/\r?\n/)) {
    if (/^-\s+\[x\]/i.test(line.trim())) {
      count += 1;
    }
  }
  return count;
}

function listFiles(directory: string, prefix: string): readonly string[] {
  const entries: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      entries.push(...listFiles(resolve(directory, entry.name), relative));
      continue;
    }
    if (entry.isFile()) {
      entries.push(relative);
    }
  }
  return entries.sort();
}

/** 无状态 provider 用内容指纹生成稳定 revision；同数量的内容变化也不会复用旧 revision。 */
function revisionFromContents(contents: readonly string[]): number {
  if (contents.length === 0) {
    return 0;
  }
  return Number.parseInt(
    createHash('sha256').update(contents.join('\u0000')).digest('hex').slice(0, 13),
    16,
  );
}

function locateChange(
  worktreeRoot: string,
  locator: SpecificationUnitLocator,
): { readonly changeDir: string; readonly changeName: string } | SpecificationReadFailure {
  const changesDir = resolveWithinWorktree(worktreeRoot, OPENSPEC_CHANGES_DIR);
  if (changesDir === null || !existsSync(changesDir)) {
    return failure('unit_absent', `worktree 内不存在 ${OPENSPEC_CHANGES_DIR}`);
  }
  // 声明了具体路径时以它为准；否则只接受恰好一个 active change，绝不「挑一个最近的」。
  const relative = locator.relativePath;
  const normalized = relative
    .replace(new RegExp(`^${OPENSPEC_CHANGES_DIR}/?`), '')
    .replace(/\/.*$/, '')
    .replace(/\/$/, '');
  if (normalized.length > 0) {
    const declaredTarget = resolveWithinWorktree(worktreeRoot, relative);
    if (declaredTarget === null) {
      return failure('unit_outside_worktree', `规格路径 ${relative} 超出 worktree 范围`);
    }
    const candidate = resolve(changesDir, normalized);
    if (!existsSync(candidate)) {
      return failure('unit_absent', `未找到 ${relative} 对应的 OpenSpec change`);
    }
    if (!statSync(candidate).isDirectory()) {
      return failure('unit_not_a_change', `${relative} 不是 OpenSpec change 目录`);
    }
    return { changeDir: candidate, changeName: normalized };
  }
  const names = readdirSync(changesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'archive')
    .map((entry) => entry.name)
    .sort();
  if (names.length === 0) {
    return failure('unit_absent', 'worktree 内没有 active OpenSpec change');
  }
  if (names.length > 1) {
    return failure(
      'unit_ambiguous',
      `worktree 内有 ${names.length} 个 active OpenSpec change，无法确定 Specification Unit`,
    );
  }
  const changeName = names[0] as string;
  return { changeDir: resolve(changesDir, changeName), changeName };
}

function readUnitFiles(
  worktreeRoot: string,
  locator: SpecificationUnitLocator,
): UnitFiles | SpecificationReadFailure {
  const located = locateChange(worktreeRoot, locator);
  if ('code' in located) {
    return located;
  }
  const files = listFilesOrNull(located.changeDir);
  if (files === null) {
    return failure('unit_unreadable', `无法列举 OpenSpec change ${located.changeName}`);
  }
  if (files.length === 0) {
    return failure('unit_empty', `OpenSpec change ${located.changeName} 不含任何工件`);
  }
  const contents: string[] = [];
  for (const file of files) {
    const content = readFileOrNull(resolve(located.changeDir, file));
    if (content === null) {
      return failure('unit_unreadable', `无法读取 ${OPENSPEC_CHANGES_DIR}/${located.changeName}/${file}`);
    }
    // 文件路径参与摘要：新增或删除工件同样改变内容快照的身份。
    contents.push(`${file}\n${content}`);
  }
  const digest = createHash('sha256').update(contents.join('\u0000')).digest('hex');
  const proposal = readFileOrNull(resolve(located.changeDir, 'proposal.md'));
  const tasks = readFileOrNull(resolve(located.changeDir, 'tasks.md'));
  const contractContents = files
    .filter((file) => (CONTRACT_ARTIFACTS as readonly string[]).includes(file) || /^specs\//.test(file))
    .map((file) => `${file}\n${readFileOrNull(resolve(located.changeDir, file)) ?? ''}`);
  return {
    root: worktreeRoot,
    changeDir: located.changeDir,
    changeName: located.changeName,
    files,
    digest,
    declaredScope: proposal === null ? [] : declaredScopeFromProposal(proposal),
    contractRevision: revisionFromContents(contractContents),
    trackingRevision: tasks === null ? 0 : revisionFromContents([tasks]),
  };
}

const ROLE_TRANSITIONS: Readonly<Record<string, { readonly artifactKind: string; readonly requires: readonly string[] }>> = {
  planner: { artifactKind: 'openspec-change-specs', requires: ['specs'] },
  implementation: { artifactKind: 'openspec-tasks', requires: ['tasks.md'] },
  validator: { artifactKind: 'openspec-delta-specs', requires: ['tasks.md', 'specs'] },
  finalizer: { artifactKind: 'openspec-archive-ready', requires: ['tasks.md', 'specs'] },
};

function readUnitSnapshot(
  resolveWorktreeRoot: (worktreeId: string) => string | null,
  providerVersion: string,
  locator: SpecificationUnitLocator,
): SpecificationReadResult<SpecificationUnitSnapshot> {
  const worktreeRoot = resolveWorktreeRoot(locator.worktreeId);
  if (worktreeRoot === null) {
    return rejected('worktree_unresolved', `无法解析 worktree ${locator.worktreeId} 的根目录`);
  }
  const unit = readUnitFiles(worktreeRoot, locator);
  if ('code' in unit) {
    return rejected(unit.code, unit.message);
  }
  return {
    kind: 'read',
    value: {
      provider: OPENSPEC_PROVIDER_ID,
      providerVersion,
      locator: { worktreeId: locator.worktreeId, relativePath: `${OPENSPEC_CHANGES_DIR}/${unit.changeName}` },
      contentDigest: unit.digest,
      declaredScope: unit.declaredScope,
      structureVersion: OPENSPEC_STRUCTURE_VERSION,
      contractRevision: unit.contractRevision,
      trackingRevision: unit.trackingRevision,
    },
  };
}

function readTransitionState(
  resolveWorktreeRoot: (worktreeId: string) => string | null,
  query: RoleTransitionQuery,
): SpecificationReadResult<RoleTransitionState> {
  const worktreeRoot = resolveWorktreeRoot(query.worktreeId);
  if (worktreeRoot === null) {
    return rejected('worktree_unresolved', `无法解析 worktree ${query.worktreeId} 的根目录`);
  }
  const spec = ROLE_TRANSITIONS[query.role];
  if (spec === undefined) {
    return rejected('role_unsupported', `未登记的 Worker 角色: ${query.role}`);
  }
  const located = locateChange(worktreeRoot, {
    worktreeId: query.worktreeId,
    relativePath: OPENSPEC_CHANGES_DIR,
  });
  if ('code' in located) {
    return {
      kind: 'read',
      value: { role: query.role, ready: false, artifactKind: spec.artifactKind, detail: located.message },
    };
  }
  const files = listFilesOrNull(located.changeDir) ?? [];
  const missing = spec.requires.filter(
    (required) => !files.some((file) => file === required || file.startsWith(`${required}/`)),
  );
  return {
    kind: 'read',
    value: {
      role: query.role,
      ready: missing.length === 0,
      artifactKind: spec.artifactKind,
      detail: missing.length === 0 ? null : `缺少 ${missing.join('、')}`,
    },
  };
}

export function createOpenSpecProvider(options: OpenSpecProviderOptions): SpecificationProvider {
  const providerVersion = options.providerVersion ?? OPENSPEC_PROVIDER_VERSION;
  const resolveWorktreeRoot = options.resolveWorktreeRoot;

  return {
    providerId: OPENSPEC_PROVIDER_ID,
    providerVersion,
    readUnit: (locator) =>
      Promise.resolve(readUnitSnapshot(resolveWorktreeRoot, providerVersion, locator)),
    readRoleTransition: (query) => Promise.resolve(readTransitionState(resolveWorktreeRoot, query)),
  };
}
