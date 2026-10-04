/**
 * IC-06 / IP-A4：OpenSpec `SpecificationProvider`（Owner: `m1-admit-work-package-specifications`）。
 *
 * 这个 adapter 只做一件事：把某个 worktree 里的 OpenSpec 原生工件读成一棵确定的事实——哪些契约
 * 工件存在、内容摘要是什么、规格声明了哪些路径、任务勾选到什么程度。它不写业务状态、不解析
 * OpenSpec 的 artifact 图、不实现第二套 change 工作流，也不替 Controller 判断规格是否完备。
 *
 * worktree 根目录由注入的 resolver 给出：adapter 不从 cwd、mtime 或「最近的 worktree」推断路径。
 */

import type { Hash } from 'node:crypto';
import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';

import type {
  SpecificationFileEntry,
  SpecificationFileListing,
  SpecificationFileListingQuery,
  SpecificationFileRange,
  SpecificationFileRangeQuery,
  SpecificationReadFailure,
  SpecificationReadResult,
  SpecificationProvider,
} from '../../../application/ports/specification-provider.js';
import {
  SPECIFICATION_BODY_MAX_BYTES,
  SPECIFICATION_FILE_PAGE_SIZE,
} from '../../../application/ports/specification-provider.js';
import type {
  RoleTransitionQuery,
  RoleTransitionState,
  SpecificationUnitLocator,
  SpecificationUnitScopeEntry,
  SpecificationUnitSnapshot,
} from '../../../domain/task-contract.js';
import { SPECIFICATION_UNIT_DIRECTORY, specificationUnitPathFor } from '../../../domain/task-contract.js';

export const OPENSPEC_PROVIDER_ID = 'openspec';

/** provider 版本：读取语义变化时递增，使既有 Spec Binding 不再被当作同一解释。 */
export const OPENSPEC_PROVIDER_VERSION = '1';

/** 本 adapter 支持的 OpenSpec unit 结构版本；读取到别的结构必须拒绝，而不是尽力解析。 */
export const OPENSPEC_STRUCTURE_VERSION = 1;

/** OpenSpec change 的工件目录；与 OpenSpec 自身的布局一致。 */
export const OPENSPEC_CHANGES_DIR = SPECIFICATION_UNIT_DIRECTORY;

const CONTRACT_ARTIFACTS = ['proposal.md', 'design.md', 'implementation-plan.md'] as const;

/** 契约工件只有这些：内容变化推进 `contractRevision`；`tasks.md` 的勾选变化只推进它自己的版本。 */
function isContractFile(file: string): boolean {
  return (CONTRACT_ARTIFACTS as readonly string[]).includes(file) || /^specs\//.test(file);
}

/** 流式读取与范围读取的固定缓冲：正文多大都只占用这么多内存。 */
const READ_BUFFER_BYTES = 64 * 1024;

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
  return revisionFromDigest(createHash('sha256').update(contents.join('\u0000')).digest('hex'));
}

/** 摘要到 revision 的唯一换算；流式读取与字符串读取共用它，避免出现第二套版本语义。 */
function revisionFromDigest(digestHex: string): number {
  return Number.parseInt(digestHex.slice(0, 13), 16);
}

type ArchivedMatch =
  | { readonly kind: 'none' }
  | { readonly kind: 'unique'; readonly directory: string }
  | { readonly kind: 'ambiguous'; readonly count: number };

/**
 * OpenSpec 把已完成变更归档为 `changes/archive/<date>-<name>`。
 *
 * 归档只改变位置，不改变单元身份：同名 change 仍对应同一个 Specification Unit。Planner 按 OpenSpec
 * 惯例归档后，宿主按固定路径读取仍必须解析到同一单元；同名匹配不唯一时不做选择。
 */
function locateArchivedChange(changesDir: string, changeName: string): ArchivedMatch {
  const archiveDir = resolve(changesDir, 'archive');
  if (!existsSync(archiveDir)) {
    return { kind: 'none' };
  }
  const matches = readdirSync(archiveDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name === changeName || name.endsWith(`-${changeName}`))
    .sort();
  if (matches.length === 0) {
    return { kind: 'none' };
  }
  if (matches.length > 1) {
    return { kind: 'ambiguous', count: matches.length };
  }
  return { kind: 'unique', directory: resolve(archiveDir, matches[0] as string) };
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
      const archived = locateArchivedChange(changesDir, normalized);
      if (archived.kind === 'none') {
        return failure('unit_absent', `未找到 ${relative} 对应的 OpenSpec change`);
      }
      if (archived.kind === 'ambiguous') {
        return failure(
          'unit_ambiguous',
          `archive 内有 ${archived.count} 个与 ${normalized} 同名的 OpenSpec change，无法确定 Specification Unit`,
        );
      }
      return { changeDir: archived.directory, changeName: normalized };
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
    .filter(isContractFile)
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

type UnitFileEntry = {
  readonly path: string;
  /** 内容版本令牌：由 `revisionFromContents` 算出，只由内容决定。 */
  readonly sourceVersion: string;
  /** 打开时观察到的元数据：只回答「要不要重新打开」，不参与身份，也不替代内容版本。 */
  readonly observed: FileObservation;
};

/** 打开时 stat 到的文件元数据；不参与身份判定，只用于发现「打开之后被改过」。 */
type FileObservation = {
  readonly byteLength: number;
  readonly ino: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
};

type OpenedUnit = {
  readonly worktreeRoot: string;
  /** change 目录的 worktree 相对路径；与 `changeDir` 一起构成定位，不重复保存别的身份。 */
  readonly changeRelativePath: string;
  readonly changeDir: string;
  readonly changeName: string;
  readonly files: readonly UnitFileEntry[];
  readonly contractRevision: number;
};

function realpathOrNull(absolutePath: string): string | null {
  try {
    return realpathSync(absolutePath);
  } catch {
    return null;
  }
}

/** 已打开 unit 的缓存上限：按 unit 条数与其中的工件条数计内存，缓存里没有正文。 */
const OPENED_UNIT_CACHE_LIMIT = 64;
const OPENED_FILE_CACHE_LIMIT = 4096;

/** 打开、交给回调读、保证关闭；读不了或回调抛错都只给 `null`，不泄漏句柄也不假装有内容。 */
function withOpenFile<T>(absolutePath: string, read: (handle: number) => T): T | null {
  let handle: number | null = null;
  try {
    handle = openSync(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    return read(handle);
  } catch {
    return null;
  } finally {
    if (handle !== null) {
      closeSync(handle);
    }
  }
}

/**
 * 把 `path\n` 与正文原始字节喂进 hash：与 `revisionFromContents` 同一套布局（路径参与摘要、条目之间
 * 一个 `\0`），只是逐块喂入，不把全部正文装进 `contents[]`。
 *
 * 只有显式打开（以及元数据变化后的重新打开）才走这里；翻页与滚动只 stat，不重读正文。
 */
function feedFile(hashes: readonly Hash[], buffer: Buffer, relativePath: string, absolutePath: string): boolean {
  return (
    withOpenFile(absolutePath, (handle) => {
      for (const hash of hashes) {
        hash.update(`${relativePath}\n`);
      }
      for (;;) {
        const read = readSync(handle, buffer, 0, buffer.length, null);
        if (read <= 0) {
          return true;
        }
        for (const hash of hashes) {
          hash.update(buffer.subarray(0, read));
        }
      }
    }) === true
  );
}

function observedOrNull(absolutePath: string): FileObservation | null {
  try {
    const stat = statSync(absolutePath, { bigint: true });
    return {
      byteLength: Number(stat.size),
      ino: stat.ino.toString(),
      mtimeNs: stat.mtimeNs.toString(),
      ctimeNs: stat.ctimeNs.toString(),
    };
  } catch {
    return null;
  }
}

/**
 * 显式打开：定位 unit、证明它没逃出 worktree，然后每个工件读一遍，同时得到它自己的内容版本与 unit 的
 * 契约内容版本。这是唯一会流式读正文的地方，缓存里不留正文。
 */
function openUnit(worktreeRoot: string, locator: SpecificationUnitLocator): OpenedUnit | SpecificationReadFailure {
  const located = locateChange(worktreeRoot, locator);
  if ('code' in located) {
    return located;
  }
  const realRoot = realpathOrNull(worktreeRoot);
  const realUnit = realpathOrNull(located.changeDir);
  if (realRoot === null || realUnit === null || !realUnit.startsWith(`${realRoot}${sep}`)) {
    return failure('unit_outside_worktree', `OpenSpec change ${located.changeName} 解析后超出 worktree 范围`);
  }
  const listed = listFilesOrNull(located.changeDir);
  if (listed === null) {
    return failure('unit_unreadable', `无法列举 OpenSpec change ${located.changeName}`);
  }
  if (listed.length === 0) {
    return failure('unit_empty', `OpenSpec change ${located.changeName} 不含任何工件`);
  }
  const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
  const contractHash = createHash('sha256');
  const entries: UnitFileEntry[] = [];
  let contractFiles = 0;
  for (const path of listed) {
    const absolute = resolve(located.changeDir, path);
    const realFile = realpathOrNull(absolute);
    if (realFile === null || !realFile.startsWith(`${realUnit}${sep}`)) {
      return failure('unit_outside_worktree', `规格工件 ${path} 解析后超出绑定 unit`);
    }
    const observed = observedOrNull(absolute);
    const versionHash = createHash('sha256');
    const contract = isContractFile(path);
    if (contract && contractFiles > 0) {
      contractHash.update('\u0000');
    }
    if (observed === null || !feedFile(contract ? [versionHash, contractHash] : [versionHash], buffer, path, absolute)) {
      return failure('unit_unreadable', `无法读取 ${OPENSPEC_CHANGES_DIR}/${located.changeName}/${path}`);
    }
    if (contract) {
      contractFiles += 1;
    }
    entries.push({ path, sourceVersion: String(revisionFromDigest(versionHash.digest('hex'))), observed });
  }
  return {
    worktreeRoot,
    changeRelativePath: relative(worktreeRoot, located.changeDir),
    changeDir: located.changeDir,
    changeName: located.changeName,
    files: entries,
    contractRevision: contractFiles === 0 ? 0 : revisionFromDigest(contractHash.digest('hex')),
  };
}

/**
 * 元数据是否还能证明「打开之后没有改过」。
 *
 * 这里只 stat，不读正文：文件集合、inode、大小、mtime 与 ctime 都没动就沿用打开时的内容版本；动了就
 * 重新打开并重新算 digest。`tasks.md` 的勾选变化因此只让它自己的版本变，契约工件仍然绑在已接纳的
 * `contractRevision` 上；契约内容变化则由重新打开后的版本比对显式拒绝。
 */
function unchangedSinceOpen(unit: OpenedUnit): boolean {
  if (!existsSync(unit.changeDir)) {
    return false;
  }
  const listed = listFilesOrNull(unit.changeDir);
  if (listed === null || listed.length !== unit.files.length) {
    return false;
  }
  return unit.files.every((entry, index) => {
    if (listed[index] !== entry.path) {
      return false;
    }
    const current = observedOrNull(resolve(unit.changeDir, entry.path));
    return (
      current !== null &&
      current.byteLength === entry.observed.byteLength &&
      current.ino === entry.observed.ino &&
      current.mtimeNs === entry.observed.mtimeNs &&
      current.ctimeNs === entry.observed.ctimeNs
    );
  });
}

/**
 * 已打开 unit 的有界缓存。
 *
 * 缓存只保存 unit 身份、每个工件的内容版本与打开时的元数据，没有正文，所以 1 MiB 或 5 MiB 的工件
 * 不会撑大它；上限按 unit 条数与其中的工件条数计。命中后先 stat，元数据动了就丢弃并重新打开。
 */
class OpenedUnitCache {
  private readonly units = new Map<string, OpenedUnit>();
  private readonly resolveWorktreeRoot: (worktreeId: string) => string | null;
  private recordedFiles = 0;

  constructor(resolveWorktreeRoot: (worktreeId: string) => string | null) {
    this.resolveWorktreeRoot = resolveWorktreeRoot;
  }

  private evict(): void {
    while (this.units.size > OPENED_UNIT_CACHE_LIMIT || this.recordedFiles > OPENED_FILE_CACHE_LIMIT) {
      const oldest = this.units.keys().next();
      if (oldest.done === true) {
        return;
      }
      const dropped = this.units.get(oldest.value);
      this.units.delete(oldest.value);
      this.recordedFiles -= dropped?.files.length ?? 0;
    }
  }

  take(
    locator: SpecificationUnitLocator,
    admittedContractRevision: number,
  ): { readonly unit: OpenedUnit } | SpecificationReadFailure {
    const worktreeRoot = this.resolveWorktreeRoot(locator.worktreeId);
    if (worktreeRoot === null) {
      return failure('worktree_unresolved', `无法解析 worktree ${locator.worktreeId} 的根目录`);
    }
    const key = `${locator.worktreeId}\u0000${locator.relativePath}`;
    const cached = this.units.get(key);
    if (cached !== undefined) {
      this.units.delete(key);
      if (unchangedSinceOpen(cached)) {
        // 命中即刷新顺序；元数据没动就沿用这次打开算出的内容版本，不重读正文。
        this.units.set(key, cached);
        return admittedOrChanged(cached, admittedContractRevision);
      }
      this.recordedFiles -= cached.files.length;
    }
    const opened = openUnit(worktreeRoot, locator);
    if ('code' in opened) {
      return opened;
    }
    this.units.set(key, opened);
    this.recordedFiles += opened.files.length;
    this.evict();
    return admittedOrChanged(opened, admittedContractRevision);
  }
}

/** 契约内容一旦不再匹配已接纳的版本就不能按旧绑定继续读；追踪工件的变化不参与这个判定。 */
function admittedOrChanged(
  unit: OpenedUnit,
  admittedContractRevision: number,
): { readonly unit: OpenedUnit } | SpecificationReadFailure {
  if (unit.contractRevision === admittedContractRevision) {
    return { unit };
  }
  return failure(
    'contract_revision_changed',
    `Specification Unit 的契约内容版本已由 ${String(admittedContractRevision)} 变为 ${String(unit.contractRevision)}`,
  );
}

function nonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** 解析一个只读浏览请求：worktree、unit、契约绑定与请求本身都先过一遍。 */
function resolveBrowsingUnit(
  cache: OpenedUnitCache,
  input: { readonly locator: SpecificationUnitLocator; readonly contractRevision: number },
): { readonly unit: OpenedUnit } | SpecificationReadFailure {
  if (!nonNegativeInteger(input.contractRevision)) {
    return failure('contract_revision_invalid', `契约内容版本 ${String(input.contractRevision)} 不是非负整数`);
  }
  return cache.take(input.locator, input.contractRevision);
}

function listingOf(
  cache: OpenedUnitCache,
  input: SpecificationFileListingQuery,
): SpecificationReadResult<SpecificationFileListing> {
  const resolved = resolveBrowsingUnit(cache, input);
  if ('code' in resolved) {
    return rejected(resolved.code, resolved.message);
  }
  if (input.after !== null && input.after.length === 0) {
    return rejected('range_invalid', '目录游标必须是非空路径或 null');
  }
  const remaining = resolved.unit.files.filter((entry) => input.after === null || entry.path > input.after);
  const page = remaining.slice(0, SPECIFICATION_FILE_PAGE_SIZE);
  const items: SpecificationFileEntry[] = page.map((entry) => ({
    path: entry.path,
    sourceVersion: entry.sourceVersion,
    byteLength: entry.observed.byteLength,
  }));
  return {
    kind: 'read',
    value: { items, nextCursor: remaining.length > page.length ? (page[page.length - 1]?.path ?? null) : null },
  };
}

/**
 * 把 change 目录内的相对路径解析成绝对文件。
 *
 * worktree 边界直接复用 `resolveWithinWorktree`（词法上跳、绝对路径与符号链接都已被它拒绝），这里
 * 只补一条 unit 边界：真实路径必须仍在 change 目录内，因此 unit 内指向别处的链接同样读不到。
 */
function resolveWithinUnit(unit: OpenedUnit, path: string): { readonly absolute: string } | SpecificationReadFailure {
  if (path.length === 0) {
    return failure('range_invalid', '正文路径必须是非空路径');
  }
  // 绝对路径与 `..` 是越界意图，不是一个「恰好不存在的相对路径」，先明确拒绝。
  if (/^([\\/]|[A-Za-z]:)/.test(path) || /(^|[\\/])\.\.([\\/]|$)/.test(path)) {
    return failure('unit_outside_worktree', `规格工件 ${path} 不是 ${unit.changeName} 内的相对路径`);
  }
  const target = resolveWithinWorktree(unit.worktreeRoot, `${unit.changeRelativePath}/${path}`);
  if (target === null) {
    return failure('unit_outside_worktree', `规格工件 ${path} 解析后超出 ${unit.changeName} 或 worktree 范围`);
  }
  const realTarget = realpathOrNull(target);
  if (realTarget === null) {
    return failure('file_absent', `规格工件 ${OPENSPEC_CHANGES_DIR}/${unit.changeName}/${path} 不存在`);
  }
  const realUnit = realpathOrNull(unit.changeDir);
  if (realUnit === null || !realTarget.startsWith(`${realUnit}${sep}`)) {
    return failure('unit_outside_worktree', `规格工件 ${path} 解析后超出 ${unit.changeName} 范围`);
  }
  return { absolute: target };
}

/**
 * 有界读取：从 `offset` 起最多取 `maxBytes` 字节，只解码完整字符。
 *
 * 流式解码保留范围末尾的半个字符；到文件末尾仍未完成或含非法序列时拒绝读取。
 * 返回的 `byteLength` 是真正消费的字节数，也就是下一页的 offset 差。
 */
function readSliceOrNull(
  absolutePath: string,
  offset: number,
  maxBytes: number,
  fileBytes: number,
): { readonly text: string; readonly byteLength: number } | null {
  return withOpenFile(absolutePath, (handle) => {
    const buffer = Buffer.allocUnsafe(maxBytes);
    const read = readSync(handle, buffer, 0, maxBytes, offset);
    if (read <= 0) {
      return { text: '', byteLength: 0 };
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, read), { stream: offset + read < fileBytes });
    return { text, byteLength: Buffer.byteLength(text, 'utf8') };
  });
}

function rangeOf(
  cache: OpenedUnitCache,
  input: SpecificationFileRangeQuery,
): SpecificationReadResult<SpecificationFileRange> {
  const resolved = resolveBrowsingUnit(cache, input);
  if ('code' in resolved) {
    return rejected(resolved.code, resolved.message);
  }
  if (input.path.length === 0) {
    return rejected('range_invalid', '正文路径必须是非空路径');
  }
  if (!nonNegativeInteger(input.offset) || !nonNegativeInteger(input.maxBytes) || input.maxBytes < 4) {
    return rejected('range_invalid', `offset ${String(input.offset)} 与 maxBytes ${String(input.maxBytes)} 必须是正整数范围内的字节位置`);
  }
  if (input.maxBytes > SPECIFICATION_BODY_MAX_BYTES) {
    return rejected(
      'body_limit_exceeded',
      `单次正文读取 ${String(input.maxBytes)} 字节超过 ${String(SPECIFICATION_BODY_MAX_BYTES)} 字节上限`,
    );
  }
  const unit = resolved.unit;
  const target = resolveWithinUnit(unit, input.path);
  if ('code' in target) {
    return rejected(target.code, target.message);
  }
  const entry = unit.files.find((candidate) => candidate.path === input.path);
  if (entry === undefined) {
    return rejected('file_not_in_unit', `${input.path} 不是 ${unit.changeName} 的工件`);
  }
  if (input.sourceVersion !== null && input.sourceVersion !== entry.sourceVersion) {
    return rejected('source_version_stale', `${input.path} 的内容版本已由 ${input.sourceVersion} 变为 ${entry.sourceVersion}`);
  }
  if (input.offset > entry.observed.byteLength) return rejected('range_invalid', '正文位置超过文件末尾');
  if (input.offset < entry.observed.byteLength) {
    const atBoundary = withOpenFile(target.absolute, (handle) => {
      const byte = Buffer.allocUnsafe(1);
      return readSync(handle, byte, 0, 1, input.offset) === 1 && (byte[0]! & 0xc0) !== 0x80;
    });
    if (atBoundary !== true) return rejected('range_invalid', '正文位置不在 UTF-8 字符边界');
  }
  const slice = readSliceOrNull(target.absolute, input.offset, input.maxBytes, entry.observed.byteLength);
  if (slice === null) {
    return rejected('unit_unreadable', `无法读取 ${OPENSPEC_CHANGES_DIR}/${unit.changeName}/${input.path}`);
  }
  return {
    kind: 'read',
    value: {
      text: slice.text,
      sourceVersion: entry.sourceVersion,
      offset: input.offset,
      end: input.offset + slice.byteLength,
      byteLength: entry.observed.byteLength,
    },
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
    relativePath: specificationUnitPathFor(query.workPackageId),
  });
  if ('code' in located && located.code === 'unit_absent') {
    // 规范路径不在时按工具惯例回退：同一 Work Package 的 change 目录名在历史上可能是另一种拼写
    // （schema 12 之前是百分号编码）。只接受「该 worktree 内恰好一个活跃 change」，不挑最近的。
    const fallback = locateChange(worktreeRoot, { worktreeId: query.worktreeId, relativePath: OPENSPEC_CHANGES_DIR });
    if (!('code' in fallback)) {
      const files = listFilesOrNull(fallback.changeDir) ?? [];
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
  }
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
  const openedUnits = new OpenedUnitCache(resolveWorktreeRoot);

  return {
    providerId: OPENSPEC_PROVIDER_ID,
    providerVersion,
    readUnit: (locator) =>
      Promise.resolve(readUnitSnapshot(resolveWorktreeRoot, providerVersion, locator)),
    readRoleTransition: (query) => Promise.resolve(readTransitionState(resolveWorktreeRoot, query)),
    readFiles: (query) => Promise.resolve(listingOf(openedUnits, query)),
    readFileRange: (query) => Promise.resolve(rangeOf(openedUnits, query)),
  };
}
