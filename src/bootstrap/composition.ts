/**
 * MOD-07：Bootstrap 组合（Owner: `m1-persist-coordination-state` 起）。
 *
 * 这里只做装配与路径解析：把 Git common dir 解析成 Companion 私有目录下的
 * `coordination.sqlite`，再注入给应用层与 CLI。路径、进程与文件系统概念到此为止，
 * 不进入领域层；import 时不启动进程、不打开数据库。
 */

import { realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { runProcess } from '../adapters/orca-cli/process-runner.js';
import {
  openCoordinationStore,
  type CoordinationStoreOpenFailureCode,
} from '../adapters/storage/coordination-store.js';
import type { BranchCoordinationStore } from '../application/ports/branch-coordination-store.js';

/** Companion 在 Git common dir 下的私有目录；checkpoint store 使用同一目录下的另一个文件。 */
export const COMPANION_STATE_DIRECTORY = 'orca-companion';

export const COORDINATION_STORE_FILENAME = 'coordination.sqlite';

export function coordinationDatabasePath(gitCommonDir: string): string {
  return join(gitCommonDir, COMPANION_STATE_DIRECTORY, COORDINATION_STORE_FILENAME);
}

/** 除了 store 自身失败外，路径解析失败也是一个明确的可诊断原因。 */
export type CoordinationStoreFailureCode = CoordinationStoreOpenFailureCode | 'repository_unresolved';

export type CoordinationStoreOpenResult =
  | {
      readonly kind: 'opened';
      readonly store: BranchCoordinationStore;
      readonly close: () => void;
    }
  | { readonly kind: 'failed'; readonly code: CoordinationStoreFailureCode; readonly message: string };

export type CreateCoordinationStoreOptions = {
  readonly gitCommonDir: string;
  readonly clock?: () => number;
  readonly readOnly?: boolean;
};

export function createCoordinationStore(options: CreateCoordinationStoreOptions): CoordinationStoreOpenResult {
  const opened = openCoordinationStore({
    databasePath: coordinationDatabasePath(options.gitCommonDir),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
  });
  return opened.kind === 'failed'
    ? opened
    : { kind: 'opened', store: opened.store, close: opened.store.close };
}

export type ResolveGitCommonDirOptions = {
  readonly repositoryPath: string;
  readonly env: Readonly<Record<string, string>>;
  readonly executable?: string;
};

export type GitCommonDirResult =
  | { readonly kind: 'resolved'; readonly path: string }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * 以参数数组调用 git，不经 shell；限额固定，返回原始进程结果。
 *
 * 所有 Git 事实查询都走这一条路径：adapter 不解析 shell 字符串，也不各自决定超时与输出上限。
 */
async function runGit(
  options: ResolveGitCommonDirOptions,
  args: readonly string[],
): Promise<
  | { readonly kind: 'completed'; readonly exitCode: number; readonly stdout: string; readonly stderr: string }
  | { readonly kind: 'failed'; readonly message: string }
> {
  const result = await runProcess({
    executable: options.executable ?? 'git',
    args: [...args],
    cwd: options.repositoryPath,
    env: options.env,
    timeoutMs: 10_000,
    limits: { maxBytes: 64 * 1024, maxLines: 100 },
  });
  if (result.kind === 'unavailable') {
    return { kind: 'failed', message: `${result.code}: ${result.message}` };
  }
  if (result.kind === 'unknown') {
    return { kind: 'failed', message: `git ${args.join(' ')} ${result.reason}` };
  }
  return {
    kind: 'completed',
    exitCode: result.exitCode,
    stdout: result.stdout.text,
    stderr: result.stderr.text,
  };
}

/**
 * 以参数数组调用 `git rev-parse --git-common-dir`，不经 shell。
 * Git common dir 是唯一对所有 worktree 都一致的位置，因此共享协调事实放在它下面。
 */
export async function resolveGitCommonDir(options: ResolveGitCommonDirOptions): Promise<GitCommonDirResult> {
  const result = await runGit(options, ['rev-parse', '--git-common-dir']);
  if (result.kind === 'failed') {
    return { kind: 'failed', message: result.message };
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim();
    return {
      kind: 'failed',
      message: detail.length > 0 ? detail : `git rev-parse --git-common-dir 退出码 ${result.exitCode}`,
    };
  }
  const reported = result.stdout.trim().split('\n')[0] ?? '';
  if (reported.length === 0) {
    return { kind: 'failed', message: 'git rev-parse --git-common-dir 没有输出路径' };
  }
  return {
    kind: 'resolved',
    path: isAbsolute(reported) ? reported : resolve(options.repositoryPath, reported),
  };
}

/** 当前 Git 身份的实时读取结果；`detached` 不是失败，而是「没有 branch ref 可登记」。 */
export type GitScopeIdentity =
  | {
      readonly kind: 'resolved';
      readonly fullBranchRef: string;
      readonly canonicalWorktreePath: string;
    }
  | { readonly kind: 'detached' }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * 读取当前工作区的完整 branch ref 与 canonical worktree 路径。
 *
 * 两个事实都来自 Git：`symbolic-ref` 给出完整 ref（而不是 `git branch --show-current` 的短名），
 * `rev-parse --show-toplevel` 给出该 worktree 的根。detached HEAD 明确区分出来，因为此时没有任何
 * branch ref 可以被登记——猜一个「最近用过的分支」正是要避免的事。
 */
export async function resolveGitScopeIdentity(
  options: ResolveGitCommonDirOptions,
): Promise<GitScopeIdentity> {
  const head = await runGit(options, ['symbolic-ref', '--quiet', 'HEAD']);
  if (head.kind === 'failed') {
    return head;
  }
  if (head.exitCode !== 0) {
    return head.stdout.trim().length === 0
      ? { kind: 'detached' }
      : { kind: 'failed', message: `git symbolic-ref --quiet HEAD 退出码 ${head.exitCode}` };
  }
  const fullBranchRef = head.stdout.trim();
  if (fullBranchRef.length === 0) {
    return { kind: 'detached' };
  }

  const topLevel = await runGit(options, ['rev-parse', '--show-toplevel']);
  if (topLevel.kind === 'failed') {
    return topLevel;
  }
  if (topLevel.exitCode !== 0) {
    const detail = topLevel.stderr.trim();
    return {
      kind: 'failed',
      message: detail.length > 0 ? detail : `git rev-parse --show-toplevel 退出码 ${topLevel.exitCode}`,
    };
  }
  const reported = topLevel.stdout.trim();
  if (reported.length === 0) {
    return { kind: 'failed', message: 'git rev-parse --show-toplevel 没有输出路径' };
  }
  const absolute = isAbsolute(reported) ? reported : resolve(options.repositoryPath, reported);
  return { kind: 'resolved', fullBranchRef, canonicalWorktreePath: canonicalPath(absolute) };
}

/** worktree 路径按符号链接解析后比较：同一个目录的不同写法必须命中同一个 Scope。 */
export function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export type OpenRepositoryCoordinationStoreOptions = ResolveGitCommonDirOptions & {
  readonly readOnly?: boolean;
  readonly clock?: () => number;
};

/** 解析当前仓库的 common dir 并打开共享协调状态；`status` 走 `readOnly` 路径。 */
export async function openRepositoryCoordinationStore(
  options: OpenRepositoryCoordinationStoreOptions,
): Promise<CoordinationStoreOpenResult> {
  const commonDir = await resolveGitCommonDir(options);
  if (commonDir.kind === 'failed') {
    return { kind: 'failed', code: 'repository_unresolved', message: commonDir.message };
  }
  return createCoordinationStore({
    gitCommonDir: commonDir.path,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
  });
}
