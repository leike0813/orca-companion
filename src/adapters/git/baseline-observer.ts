/** D9：从目标 worktree 读取 Baseline Reconciliation 的 Git 事实。 */

import { runProcess, type ProcessRunner } from '../orca-cli/process-runner.js';
import type { BaselineGitObservations } from '../../application/execution/baseline-reconciliation.js';

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

export async function readBaselineGitObservations(input: {
  readonly worktreePath: string;
  readonly requiredBaselineHead: string;
  readonly runner?: ProcessRunner;
}): Promise<BaselineGitReadResult> {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(input.requiredBaselineHead)) {
    return { kind: 'rejected', reason: '目标基线不是完整 Git commit ID' };
  }
  const run = input.runner ?? runProcess;
  const git = (args: readonly string[]) => run({
    executable: 'git', args, cwd: input.worktreePath, env: process.env as Record<string, string>,
    timeoutMs: 15_000, limits: { maxBytes: 1024 * 1024, maxLines: 20_000 },
  });
  const head = await git(['rev-parse', '--verify', 'HEAD^{commit}']);
  if (head.kind !== 'completed' || head.exitCode !== 0 || head.stdout.truncated) {
    return { kind: 'rejected', reason: '无法核验 worktree HEAD' };
  }
  const observedHead = head.stdout.text.trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(observedHead)) {
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
