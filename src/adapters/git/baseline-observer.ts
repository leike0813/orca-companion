/** D9：从目标 worktree 读取 Baseline Reconciliation 的 Git 事实。 */

import { createHash } from 'node:crypto';

import { runProcess, type ProcessRunner } from '../orca-cli/process-runner.js';
import type { BaselineGitObservations } from '../../application/execution/baseline-reconciliation.js';

const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export type BaselineGitReadResult =
  | { readonly kind: 'observed'; readonly git: BaselineGitObservations }
  | { readonly kind: 'rejected'; readonly reason: string };

function dirtyPathsFromPorcelain(output: string): readonly string[] | null {
  const entries = output.split('\0');
  if (entries.at(-1) !== '') return null;
  const paths: string[] = [];
  for (let index = 0; index < entries.length - 1; index += 1) {
    const entry = entries[index];
    if (entry === undefined || entry.length < 4 || entry[2] !== ' ') return null;
    paths.push(entry.slice(3));
    if ('RC'.includes(entry[0] ?? '') || 'RC'.includes(entry[1] ?? '')) {
      const source = entries[++index];
      if (source === undefined || source.length === 0) return null;
      paths.push(source);
    }
  }
  return paths;
}

/** 受限的 Git 调用：参数数组加显式 cwd 与环境，输出上限固定。 */
function gitIn(worktreePath: string, run: ProcessRunner, env: Readonly<Record<string, string>>) {
  return (args: readonly string[]) => run({
    executable: 'git', args, cwd: worktreePath, env,
    timeoutMs: 15_000, limits: { maxBytes: 1024 * 1024, maxLines: 20_000 },
  });
}

export async function readBaselineGitObservations(input: {
  readonly worktreePath: string;
  readonly requiredBaselineHead: string;
  readonly runner?: ProcessRunner;
}): Promise<BaselineGitReadResult> {
  if (!COMMIT_ID.test(input.requiredBaselineHead)) {
    return { kind: 'rejected', reason: '目标基线不是完整 Git commit ID' };
  }
  const run = input.runner ?? runProcess;
  const git = gitIn(input.worktreePath, run, process.env as Record<string, string>);
  const head = await git(['rev-parse', '--verify', 'HEAD^{commit}']);
  if (head.kind !== 'completed' || head.exitCode !== 0 || head.stdout.truncated) {
    return { kind: 'rejected', reason: '无法核验 worktree HEAD' };
  }
  const observedHead = head.stdout.text.trim();
  if (!COMMIT_ID.test(observedHead)) {
    return { kind: 'rejected', reason: 'worktree HEAD 不是完整 Git commit ID' };
  }
  const ancestry = await git(['merge-base', '--is-ancestor', input.requiredBaselineHead, observedHead]);
  if (ancestry.kind !== 'completed' || (ancestry.exitCode !== 0 && ancestry.exitCode !== 1)) {
    return { kind: 'rejected', reason: '无法核验基线祖先关系' };
  }
  const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (status.kind !== 'completed' || status.exitCode !== 0 || status.stdout.truncated) {
    return { kind: 'rejected', reason: '无法完整读取 worktree dirty paths' };
  }
  const dirtyPaths = dirtyPathsFromPorcelain(status.stdout.text);
  if (dirtyPaths === null) return { kind: 'rejected', reason: 'worktree dirty paths 格式无效' };
  const finalHead = await git(['rev-parse', '--verify', 'HEAD^{commit}']);
  if (finalHead.kind !== 'completed' || finalHead.exitCode !== 0 || finalHead.stdout.truncated || finalHead.stdout.text.trim() !== observedHead) {
    return { kind: 'rejected', reason: '读取期间 worktree HEAD 已变化' };
  }
  return { kind: 'observed', git: { observedHead, descendantOfRequiredBaseline: ancestry.exitCode === 0, dirtyPaths } };
}

/**
 * IP-05 / IP-06：Finalizer 运行前后工作区比较的生产来源。
 *
 * `indexRevision` 用 `git ls-files --stage -z` 输出的本地 sha256：它同样覆盖 staged 内容，但不写对象库
 * （因此不用 `git write-tree`）。两次 HEAD 读取不一致说明工作区在读取期间已变化，结论只能是 rejected。
 */
export type WorkspaceGitFacts = {
  readonly head: string;
  readonly indexRevision: string;
  readonly dirtyPaths: readonly string[];
};

export async function readWorkspaceFacts(input: {
  readonly worktreePath: string;
  readonly runner?: ProcessRunner;
  readonly env?: Readonly<Record<string, string>>;
}): Promise<
  | { readonly kind: 'observed'; readonly facts: WorkspaceGitFacts }
  | { readonly kind: 'rejected'; readonly reason: string }
> {
  const run = input.runner ?? runProcess;
  const git = gitIn(input.worktreePath, run, input.env ?? (process.env as Record<string, string>));
  const head = await git(['rev-parse', '--verify', 'HEAD^{commit}']);
  if (head.kind !== 'completed' || head.exitCode !== 0 || head.stdout.truncated) {
    return { kind: 'rejected', reason: '无法核验 worktree HEAD' };
  }
  const observedHead = head.stdout.text.trim();
  if (!COMMIT_ID.test(observedHead)) {
    return { kind: 'rejected', reason: 'worktree HEAD 不是完整 Git commit ID' };
  }
  const index = await git(['ls-files', '--stage', '-z']);
  if (index.kind !== 'completed' || index.exitCode !== 0 || index.stdout.truncated) {
    return { kind: 'rejected', reason: '无法完整读取 worktree index' };
  }
  const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (status.kind !== 'completed' || status.exitCode !== 0 || status.stdout.truncated) {
    return { kind: 'rejected', reason: '无法完整读取 worktree dirty paths' };
  }
  const dirtyPaths = dirtyPathsFromPorcelain(status.stdout.text);
  if (dirtyPaths === null) return { kind: 'rejected', reason: 'worktree dirty paths 格式无效' };
  const finalHead = await git(['rev-parse', '--verify', 'HEAD^{commit}']);
  if (
    finalHead.kind !== 'completed' ||
    finalHead.exitCode !== 0 ||
    finalHead.stdout.truncated ||
    finalHead.stdout.text.trim() !== observedHead
  ) {
    return { kind: 'rejected', reason: '读取期间 worktree HEAD 已变化' };
  }
  return {
    kind: 'observed',
    facts: {
      head: observedHead,
      indexRevision: createHash('sha256').update(index.stdout.text, 'utf8').digest('hex'),
      dirtyPaths,
    },
  };
}
