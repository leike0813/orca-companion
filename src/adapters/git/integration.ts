/**
 * IP-05 / D5：受控 Git 集成端口的生产实现。
 *
 * 只执行已批准步骤（commit、merge_canonical、merge_commit、integrate_canonical、push），全部经
 * runProcess 以可执行文件加参数数组与显式 cwd 调用 git，绝不经 shell；不 rewrite 历史、不 force push、
 * 不 reset，也不切换用户当前分支。merge 复验只在授权范围内把已归属 canonical 合进包 worktree 并落成
 * 普通 merge commit；提交前/后都用已复验的精确树核验。
 *
 * 每一步各自核验自己的目标：commit 只验证精确 Worker worktree 的 HEAD，integrate 只验证 canonical 的
 * HEAD，push 只验证获批 remote/ref 的目标 commit。进程超时、冲突、非 fast-forward、工作区不干净或回读
 * 不一致都返回 unknown/rejected，由 IC-08 按原 OperationId 对账：本 adapter 不重试，也不推断结果。
 */

import {
  runProcess,
  type OutputLimits,
  type ProcessResult,
  type ProcessRunner,
} from '../orca-cli/process-runner.js';
import type {
  GitAncestryRead,
  GitHeadRead,
  GitIntegrationPort,
  GitReadbackTarget,
  GitStepOutcome,
  GitStepRequest,
  GitTreeRead,
} from '../../application/integrate-work-package.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const LIMITS: OutputLimits = { maxBytes: 1024 * 1024, maxLines: 20_000 };
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
/** 带凭据的 URL 出现在 remote 错误里时必须脱敏。 */
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/gi;

type CompletedRun = Extract<ProcessResult, { readonly kind: 'completed' }>;

/** 进程级失败只能是 rejected 或 unknown，不会是某个步骤的成功结果。 */
type GitFailure = Extract<
  GitStepOutcome,
  { readonly kind: 'rejected' } | { readonly kind: 'unknown' }
>;

/** 一次调用的结果：正常退出可继续判定，进程级失败已经是该步骤终态。 */
type GitRun = CompletedRun | { readonly kind: 'terminal'; readonly outcome: GitFailure };

/** 读 HEAD 的探针结果；`failed` 直接是该步骤的终态，不再继续。 */
type HeadProbe =
  | { readonly kind: 'read'; readonly head: string }
  | { readonly kind: 'failed'; readonly outcome: GitFailure };

/** 只保留摘要：单行、去掉凭据、限长，不泄漏环境变量或整段输出。 */
function summarize(stderr: string): string {
  const line = stderr.split('\n').find((candidate) => candidate.trim().length > 0) ?? '';
  return line.trim().replace(URL_CREDENTIALS, '$1***@').slice(0, 200);
}

/** argv 里不接受空值、空白或被 git 当选项的取值。 */
function argvValue(raw: string): string | null {
  if (raw.length === 0 || raw.startsWith('-') || /[\s\0]/.test(raw)) return null;
  return raw;
}

export function createGitIntegrationPort(input: {
  readonly canonicalWorktreePath: string;
  readonly runner?: ProcessRunner;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}): GitIntegrationPort {
  const run = input.runner ?? runProcess;
  const env = input.env ?? (process.env as Readonly<Record<string, string>>);
  const defaultTimeoutMs =
    input.timeoutMs !== undefined && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
      ? input.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const canonical = input.canonicalWorktreePath;

  const runGit = async (cwd: string, args: readonly string[], timeoutMs: number): Promise<GitRun> => {
    const result = await run({ executable: 'git', args, cwd, env, timeoutMs, limits: LIMITS });
    if (result.kind === 'completed') return result;
    if (result.kind === 'unavailable') {
      return {
        kind: 'terminal',
        outcome: { kind: 'rejected', code: 'git_unavailable', message: `无法启动 git 进程：${result.message}` },
      };
    }
    return {
      kind: 'terminal',
      outcome: { kind: 'unknown', reason: result.reason === 'timeout' ? 'git 进程超时' : 'git 进程被取消' },
    };
  };

  /** 只读探针：非零退出、输出截断或非 commit ID 都封成终态，不猜结果。 */
  const probeHead = async (
    cwd: string,
    args: readonly string[],
    label: string,
    timeoutMs: number,
  ): Promise<HeadProbe> => {
    const probed = await runGit(cwd, args, timeoutMs);
    if (probed.kind === 'terminal') return { kind: 'failed', outcome: probed.outcome };
    if (probed.exitCode !== 0) {
      return {
        kind: 'failed',
        outcome: { kind: 'rejected', code: 'git_failed', message: `git ${label} 失败：${summarize(probed.stderr.text)}` },
      };
    }
    if (probed.stdout.truncated) {
      return { kind: 'failed', outcome: { kind: 'rejected', code: 'git_failed', message: `git ${label} 输出被截断` } };
    }
    const head = probed.stdout.text.trim();
    if (!COMMIT_ID.test(head)) {
      return {
        kind: 'failed',
        outcome: { kind: 'rejected', code: 'git_failed', message: `git ${label} 未返回完整 commit ID` },
      };
    }
    return { kind: 'read', head };
  };

  const readCanonical = (timeoutMs: number): Promise<HeadProbe> =>
    probeHead(canonical, ['rev-parse', '--verify', 'HEAD^{commit}'], 'rev-parse', timeoutMs);

  /** 除 `merge --ff-only` 的拒绝语义外，其余命令的非零退出都是稳定 code 的 `git_failed`。 */
  const failedExit = (runResult: CompletedRun, label: string): GitStepOutcome | null =>
    runResult.exitCode === 0
      ? null
      : { kind: 'rejected', code: 'git_failed', message: `git ${label} 失败：${summarize(runResult.stderr.text)}` };

  /** `git ls-remote` 只接受唯一一行精确匹配，其余一律当作读不到。 */
  const readRemoteHead = async (remote: string, ref: string, timeoutMs: number): Promise<GitHeadRead> => {
    const listed = await runGit(canonical, ['ls-remote', remote, ref], timeoutMs);
    if (listed.kind === 'terminal') {
      return {
        kind: 'unavailable',
        reason: listed.outcome.kind === 'rejected' ? listed.outcome.message : listed.outcome.reason,
      };
    }
    if (listed.exitCode !== 0) {
      return { kind: 'unavailable', reason: `git ls-remote 失败：${summarize(listed.stderr.text)}` };
    }
    if (listed.stdout.truncated) return { kind: 'unavailable', reason: 'git ls-remote 输出被截断' };
    const lines = listed.stdout.text.split('\n').filter((line) => line.trim().length > 0);
    if (lines.length === 0) return { kind: 'unavailable', reason: 'remote-ref-not-found' };
    if (lines.length > 1) return { kind: 'unavailable', reason: 'git ls-remote 返回多个 ref' };
    const [sha, name] = (lines[0] ?? '').split('\t');
    if (sha === undefined || name !== ref || !COMMIT_ID.test(sha)) {
      return { kind: 'unavailable', reason: 'git ls-remote 输出格式无效' };
    }
    return { kind: 'read', head: sha };
  };

  const readHead = async (target: GitReadbackTarget): Promise<GitHeadRead> => {
    if (target.kind === 'remote') {
      const remote = argvValue(target.remote);
      const ref = argvValue(target.ref);
      if (remote === null || ref === null) return { kind: 'unavailable', reason: 'remote 或 ref 形态非法' };
      return readRemoteHead(remote, ref, defaultTimeoutMs);
    }
    const worktreePath = target.kind === 'source' ? target.worktreePath : canonical;
    if (!worktreePath.startsWith('/')) return { kind: 'unavailable', reason: 'worktree 路径不是绝对路径' };
    const probed = await probeHead(
      canonical,
      ['-C', worktreePath, 'rev-parse', '--verify', 'HEAD^{commit}'],
      'rev-parse',
      defaultTimeoutMs,
    );
    if (probed.kind === 'read') return { kind: 'read', head: probed.head };
    return {
      kind: 'unavailable',
      reason: probed.outcome.kind === 'rejected' ? probed.outcome.message : probed.outcome.reason,
    };
  };

  /** 调用方传入的路径与 HEAD 先做形态校验，非法输入不落到任何 git 调用上。 */
  const requestFailure = (request: GitStepRequest): string | null => {
    if (!request.sourceWorktreePath.startsWith('/')) return 'sourceWorktreePath 不是绝对路径';
    if (!canonical.startsWith('/')) return 'canonicalWorktreePath 不是绝对路径';
    if (!COMMIT_ID.test(request.expectedHead)) return 'expectedHead 不是完整 Git commit ID';
    if (argvValue(request.branch) === null) return 'branch 形态非法';
    if (argvValue(request.sourceBranch) === null) return 'sourceBranch 形态非法';
    return null;
  };

  /** commit：精确 Worker worktree 内 `add -A` → 有 staged 变化才 commit → 回读 source HEAD。 */
  const runCommit = async (request: GitStepRequest, timeoutMs: number): Promise<GitStepOutcome> => {
    const source = request.sourceWorktreePath;
    const current = await probeHead(source, ['rev-parse', '--verify', 'HEAD^{commit}'], 'rev-parse', timeoutMs);
    if (current.kind === 'failed') return current.outcome;
    /**
     * 真实 Worker 往往**已经自行提交**交接成果，因此 source HEAD 不再是 baseline。
     *
     * 只在能证明「当前 HEAD 是所记录 expected HEAD 的后继」时把这一步按「已经提交」处理：这样既覆盖
     * Worker 已提交的情形，也仍然拒绝任何不是从获批基线长出来的 HEAD（例如被替换或改写过的历史）。
     * 后代关系无法核验时保持原来的拒绝语义。
     */
    if (current.head !== request.expectedHead) {
      const ancestry = await runGit(
        source,
        ['merge-base', '--is-ancestor', request.expectedHead, current.head],
        timeoutMs,
      );
      if (ancestry.kind === 'terminal') return ancestry.outcome;
      if (ancestry.exitCode !== 0) {
        return {
          kind: 'rejected',
          code: 'source_head_mismatch',
          message: `Worker worktree HEAD ${current.head} 既不是所记录的 ${request.expectedHead}，也不是它的后继`,
        };
      }
    }
    // 缺少提交信息必须在 `git add` 之前拒绝：`add` 会改变 index，之后拒绝就不再是「确定未发生副作用」。
    if (request.commitMessage === null) {
      return { kind: 'rejected', code: 'missing_commit_message', message: 'commit 步缺少提交信息' };
    }
    const staged = await runGit(source, ['add', '-A'], timeoutMs);
    if (staged.kind === 'terminal') return staged.outcome;
    const addFailure = failedExit(staged, 'add');
    if (addFailure !== null) return { kind: 'unknown', reason: 'git add 失败，index 是否已改变不可核验' };
    const stagedDiff = await runGit(source, ['diff', '--cached', '--quiet'], timeoutMs);
    if (stagedDiff.kind === 'terminal') return { kind: 'unknown', reason: 'git add 后无法核验 index' };
    if (stagedDiff.exitCode !== 0 && stagedDiff.exitCode !== 1) {
      return { kind: 'unknown', reason: `git diff 失败，index 已可能改变：${summarize(stagedDiff.stderr.text)}` };
    }
    // exit code 1 表示有 staged 变化；没有变化时 Worker 可能已自行提交，跳过 commit。
    if (stagedDiff.exitCode === 1) {
      const committed = await runGit(source, ['commit', '-m', request.commitMessage], timeoutMs);
      if (committed.kind === 'terminal') return { kind: 'unknown', reason: 'git commit 的结果不可核验' };
      const commitFailure = failedExit(committed, 'commit');
      if (commitFailure !== null) return { kind: 'unknown', reason: 'git commit 失败，HEAD 与 index 是否已改变不可核验' };
    }
    const after = await probeHead(source, ['rev-parse', '--verify', 'HEAD^{commit}'], 'rev-parse', timeoutMs);
    if (after.kind === 'failed') return { kind: 'unknown', reason: 'git commit 后无法回读 source HEAD' };
    return { kind: 'committed', head: after.head };
  };

  /** integrate：先证明可 fast-forward，再在 canonical 内执行 `merge --ff-only`。 */
  const runIntegrate = async (request: GitStepRequest, timeoutMs: number): Promise<GitStepOutcome> => {
    const branch = argvValue(request.sourceBranch);
    if (branch === null) return { kind: 'rejected', code: 'invalid_request', message: 'branch 形态非法' };
    const current = await readCanonical(timeoutMs);
    if (current.kind === 'failed') return current.outcome;
    if (current.head !== request.expectedHead) {
      return {
        kind: 'rejected',
        code: 'canonical_head_mismatch',
        message: `canonical HEAD ${current.head} 与 expected HEAD ${request.expectedHead} 不符`,
      };
    }
    const ancestor = await runGit(canonical, ['merge-base', '--is-ancestor', 'HEAD', branch], timeoutMs);
    if (ancestor.kind === 'terminal') return ancestor.outcome;
    if (ancestor.exitCode === 1) {
      return { kind: 'rejected', code: 'canonical_not_fast_forward', message: `无法 fast-forward 到 ${branch}` };
    }
    if (ancestor.exitCode !== 0) {
      return { kind: 'rejected', code: 'git_failed', message: `git merge-base 失败：${summarize(ancestor.stderr.text)}` };
    }
    const merged = await runGit(canonical, ['merge', '--ff-only', branch], timeoutMs);
    if (merged.kind === 'terminal') return merged.outcome;
    if (merged.exitCode !== 0) {
      return {
        kind: 'unknown',
        reason: `git merge --ff-only ${branch} 失败，canonical HEAD 是否已改变不可核验：${summarize(merged.stderr.text)}`,
      };
    }
    const after = await readCanonical(timeoutMs);
    if (after.kind === 'failed') return { kind: 'unknown', reason: 'git merge 后无法回读 canonical HEAD' };
    return { kind: 'integrated', head: after.head };
  };

  /** push：canonical HEAD 就是被推送的 commit，推送后回读获批 remote/ref。 */
  const runPush = async (request: GitStepRequest, timeoutMs: number): Promise<GitStepOutcome> => {
    const remote = request.remote === null ? null : argvValue(request.remote);
    const ref = request.ref === null ? null : argvValue(request.ref);
    if (remote === null || ref === null) {
      return { kind: 'rejected', code: 'invalid_request', message: 'push 步缺少形态合法的 remote 与 ref' };
    }
    const current = await readCanonical(timeoutMs);
    if (current.kind === 'failed') return current.outcome;
    if (current.head !== request.expectedHead) {
      return {
        kind: 'rejected',
        code: 'canonical_head_mismatch',
        message: `canonical HEAD ${current.head} 与 expected HEAD ${request.expectedHead} 不符`,
      };
    }
    const pushed = await runGit(canonical, ['push', remote, `${request.sourceBranch}:${ref}`], timeoutMs);
    if (pushed.kind === 'terminal') return pushed.outcome;
    const pushFailure = failedExit(pushed, 'push');
    if (pushFailure !== null) return { kind: 'unknown', reason: 'git push 失败，remote/ref 是否已改变不可核验' };
    const remoteHead = await readRemoteHead(remote, ref, timeoutMs);
    if (remoteHead.kind === 'unavailable') {
      return { kind: 'unknown', reason: `推送后无法回读 ${remote} ${ref}：${remoteHead.reason}` };
    }
    if (remoteHead.head !== current.head) {
      return {
        kind: 'unknown',
        reason: `推送后 ${remote} ${ref} 为 ${remoteHead.head}，与 canonical HEAD ${current.head} 不一致`,
      };
    }
    return { kind: 'pushed', remote, ref, head: remoteHead.head };
  };

  /** 合并中状态：present 表示 MERGE_HEAD 存在（合并已开始），absent 表示没有，其余不可核验。 */
  const mergeHeadState = async (
    cwd: string,
    timeoutMs: number,
  ): Promise<'present' | 'absent' | 'unknown'> => {
    const probed = await runGit(cwd, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], timeoutMs);
    if (probed.kind === 'terminal') return 'unknown';
    if (probed.exitCode === 0) return 'present';
    if (probed.exitCode === 1) return 'absent';
    return 'unknown';
  };

  type ConflictsRead =
    | { readonly kind: 'read'; readonly paths: readonly string[] }
    | { readonly kind: 'failed'; readonly outcome: GitFailure };

  /** 只读未解决冲突路径；输出截断或非零退出都封成终态，不猜。 */
  const readConflicts = async (cwd: string, timeoutMs: number): Promise<ConflictsRead> => {
    const listed = await runGit(cwd, ['diff', '--name-only', '--diff-filter=U'], timeoutMs);
    if (listed.kind === 'terminal') return { kind: 'failed', outcome: listed.outcome };
    if (listed.exitCode !== 0) {
      return {
        kind: 'failed',
        outcome: { kind: 'rejected', code: 'git_failed', message: 'git diff 失败：' + summarize(listed.stderr.text) },
      };
    }
    if (listed.stdout.truncated) {
      return { kind: 'failed', outcome: { kind: 'rejected', code: 'git_failed', message: 'git diff 输出被截断' } };
    }
    return {
      kind: 'read',
      paths: listed.stdout.text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0),
    };
  };

  /**
   * merge_canonical：把本轮目标 canonical HEAD 合并进包 worktree（--no-commit）。
   *
   * 幂等且只读优先：canonical 已是包 HEAD 的祖先时无需合并；已存在进行中的合并（前一次尝试留下的
   * MERGE_HEAD）时不重复 git merge，直接回报当前冲突集合。任何无法证明的状态都归为 unknown，由调用
   * 方按原身份对账。
   */
  const runMergeCanonical = async (request: GitStepRequest, timeoutMs: number): Promise<GitStepOutcome> => {
    const source = request.sourceWorktreePath;
    const target = request.expectedHead;
    const head = await probeHead(source, ['rev-parse', '--verify', 'HEAD^{commit}'], 'rev-parse', timeoutMs);
    if (head.kind === 'failed') return head.outcome;
    if (head.head === target) return { kind: 'already_merged' };
    const ancestor = await runGit(source, ['merge-base', '--is-ancestor', target, head.head], timeoutMs);
    if (ancestor.kind === 'terminal') return ancestor.outcome;
    if (ancestor.exitCode === 0) return { kind: 'already_merged' };
    if (ancestor.exitCode !== 1) {
      return { kind: 'rejected', code: 'git_failed', message: 'git merge-base 失败：' + summarize(ancestor.stderr.text) };
    }
    const existingMerge = await mergeHeadState(source, timeoutMs);
    if (existingMerge === 'present') {
      const conflicts = await readConflicts(source, timeoutMs);
      if (conflicts.kind !== 'read') return conflicts.outcome;
      return { kind: 'merge_applied', conflicts: conflicts.paths };
    }
    if (existingMerge === 'unknown') {
      return { kind: 'unknown', reason: 'git merge 前无法核验是否已处于合并中' };
    }
    const merged = await runGit(source, ['merge', '--no-commit', '--no-ff', target], timeoutMs);
    if (merged.kind === 'terminal') return merged.outcome;
    if (merged.exitCode !== 0) {
      // 冲突时 MERGE_HEAD 存在且未解决冲突列表非空；其它失败不留合并状态。
      const afterMerge = await mergeHeadState(source, timeoutMs);
      if (afterMerge === 'present') {
        const conflicts = await readConflicts(source, timeoutMs);
        if (conflicts.kind !== 'read') return conflicts.outcome;
        if (conflicts.paths.length === 0) {
          return { kind: 'unknown', reason: 'git merge 失败但未列出冲突：' + summarize(merged.stderr.text) };
        }
        return { kind: 'merge_applied', conflicts: conflicts.paths };
      }
      if (afterMerge === 'unknown') {
        return { kind: 'unknown', reason: 'git merge 失败且合并状态不可核验' };
      }
      return { kind: 'rejected', code: 'git_failed', message: 'git merge 失败：' + summarize(merged.stderr.text) };
    }
    const conflicts = await readConflicts(source, timeoutMs);
    if (conflicts.kind !== 'read') return conflicts.outcome;
    return { kind: 'merge_applied', conflicts: conflicts.paths };
  };

  /**
   * merge_commit：把已完成复验的合并落成普通 merge commit。
   *
   * 重放安全：HEAD 已前移且是原 HEAD 的后继时按已提交认账；仍有未解决冲突时拒绝。缺提交信息在任何
   * 写操作之前拒绝。
   */
  const runMergeCommit = async (request: GitStepRequest, timeoutMs: number): Promise<GitStepOutcome> => {
    const source = request.sourceWorktreePath;
    if (request.commitMessage === null) {
      return { kind: 'rejected', code: 'missing_commit_message', message: 'merge commit 步缺少提交信息' };
    }
    const before = await probeHead(source, ['rev-parse', '--verify', 'HEAD^{commit}'], 'rev-parse', timeoutMs);
    if (before.kind === 'failed') return before.outcome;
    if (before.head !== request.expectedHead) {
      const ancestry = await runGit(source, ['merge-base', '--is-ancestor', request.expectedHead, before.head], timeoutMs);
      if (ancestry.kind === 'terminal') return ancestry.outcome;
      if (ancestry.exitCode === 0) {
        // 已是原 HEAD 的后继：只有树也等于已复验树才按已提交归属，避免任意 HEAD 变化被认账。
        if (request.expectedTree !== undefined && request.expectedTree !== null && COMMIT_ID.test(request.expectedTree)) {
          const tree = await runGit(source, ['rev-parse', '--verify', 'HEAD^{tree}'], timeoutMs);
          if (tree.kind === 'terminal') return tree.outcome;
          if (tree.exitCode !== 0 || tree.stdout.truncated || tree.stdout.text.trim() !== request.expectedTree) {
            return { kind: 'unknown', reason: 'HEAD 后继树与已复验树不一致：无法归属' };
          }
        }
        return { kind: 'committed', head: before.head };
      }
      return {
        kind: 'rejected',
        code: 'source_head_mismatch',
        message: 'merge commit 前 HEAD ' + before.head + ' 既不是 ' + request.expectedHead + '，也不是它的后继',
      };
    }
    const conflicts = await readConflicts(source, timeoutMs);
    if (conflicts.kind !== 'read') return { kind: 'unknown', reason: '无法核验未解决的冲突' };
    if (conflicts.paths.length > 0) {
      return {
        kind: 'rejected',
        code: 'merge_conflicts_unresolved',
        message: '仍有未解决的冲突：' + conflicts.paths.join(', '),
      };
    }
    const expectedTree = request.expectedTree;
    if (expectedTree === undefined || expectedTree === null || !COMMIT_ID.test(expectedTree)) {
      return { kind: 'rejected', code: 'missing_expected_tree', message: 'merge commit 步缺少已复验的 expectedTree' };
    }
    // 工作区必须干净：未 stage 的改动或未跟踪文件都会被提交进 canonical，因此提交前拒绝。
    const unstaged = await runGit(source, ['diff', '--quiet'], timeoutMs);
    if (unstaged.kind === 'terminal') return unstaged.outcome;
    if (unstaged.exitCode === 1) {
      return {
        kind: 'rejected',
        code: 'worktree_dirty_not_staged',
        message: '工作区存在未 stage 的改动：拒绝提交未经复验的树',
      };
    }
    if (unstaged.exitCode !== 0) return { kind: 'unknown', reason: '无法核验工作区是否干净' };
    const untracked = await runGit(source, ['ls-files', '--others', '--exclude-standard'], timeoutMs);
    if (untracked.kind === 'terminal') return untracked.outcome;
    if (untracked.exitCode !== 0) return { kind: 'unknown', reason: '无法核验未跟踪文件' };
    if (untracked.stdout.text.trim().length > 0) {
      return { kind: 'rejected', code: 'worktree_untracked', message: '工作区存在未跟踪文件：拒绝提交未经复验的树' };
    }
    // 提交前精确对照已复验树：index 树必须等于 expectedTree，错误树不得进入 canonical。
    const indexTree = await runGit(source, ['write-tree'], timeoutMs);
    if (indexTree.kind === 'terminal') return indexTree.outcome;
    if (indexTree.exitCode !== 0 || indexTree.stdout.truncated) {
      return { kind: 'unknown', reason: '无法写出 index 树' };
    }
    const indexTreeId = indexTree.stdout.text.trim();
    if (!COMMIT_ID.test(indexTreeId) || indexTreeId !== expectedTree) {
      return { kind: 'rejected', code: 'tree_mismatch', message: '当前 index 树与已复验的树不一致：拒绝提交' };
    }
    // 不再 git add：Worker 必须自己 stage 已复验的树；提交直接使用当前 index 与 MERGE_HEAD。
    const committed = await runGit(source, ['commit', '-m', request.commitMessage], timeoutMs);
    if (committed.kind === 'terminal') return { kind: 'unknown', reason: 'git commit 的结果不可核验' };
    if (committed.exitCode !== 0) {
      return {
        kind: 'unknown',
        reason: 'git commit 失败，HEAD 是否已改变不可核验：' + summarize(committed.stderr.text),
      };
    }
    const after = await probeHead(source, ['rev-parse', '--verify', 'HEAD^{commit}'], 'rev-parse', timeoutMs);
    if (after.kind === 'failed') return { kind: 'unknown', reason: 'merge commit 后无法回读包 HEAD' };
    const afterTree = await runGit(source, ['rev-parse', '--verify', 'HEAD^{tree}'], timeoutMs);
    if (afterTree.kind === 'terminal') return afterTree.outcome;
    if (afterTree.exitCode !== 0 || afterTree.stdout.truncated) {
      return { kind: 'unknown', reason: 'merge commit 后无法回读 HEAD 树' };
    }
    if (afterTree.stdout.text.trim() !== expectedTree) {
      return { kind: 'unknown', reason: '提交后 HEAD 树与已复验的树不一致：拒绝归属' };
    }
    return { kind: 'committed', head: after.head };
  };

  /** 祖先关系只读探针；输入形态非法或 git 失败都返回 unavailable，不推断成 no。 */
  const readAncestry = async (probe: {
    readonly ancestor: string;
    readonly descendant: string;
  }): Promise<GitAncestryRead> => {
    if (!COMMIT_ID.test(probe.ancestor) || !COMMIT_ID.test(probe.descendant)) {
      return { kind: 'unavailable', reason: '祖先关系核验的输入不是完整 commit ID' };
    }
    const result = await runGit(canonical, ['merge-base', '--is-ancestor', probe.ancestor, probe.descendant], defaultTimeoutMs);
    if (result.kind === 'terminal') {
      return { kind: 'unavailable', reason: result.outcome.kind === 'rejected' ? result.outcome.message : result.outcome.reason };
    }
    if (result.exitCode === 0) return { kind: 'yes' };
    if (result.exitCode === 1) return { kind: 'no' };
    return { kind: 'unavailable', reason: 'git merge-base 失败：' + summarize(result.stderr.text) };
  };

  /** worktree 当前 index 的精确树 OID（git write-tree）；有未解决冲突时 git 失败，因此不可核验。 */
  const readTree = async (probe: { readonly worktreePath: string }): Promise<GitTreeRead> => {
    if (!probe.worktreePath.startsWith('/')) return { kind: 'unavailable', reason: 'worktree 路径不是绝对路径' };
    const result = await runGit(canonical, ['-C', probe.worktreePath, 'write-tree'], defaultTimeoutMs);
    if (result.kind === 'terminal') {
      return { kind: 'unavailable', reason: result.outcome.kind === 'rejected' ? result.outcome.message : result.outcome.reason };
    }
    if (result.exitCode !== 0) return { kind: 'unavailable', reason: 'git write-tree 失败：' + summarize(result.stderr.text) };
    if (result.stdout.truncated) return { kind: 'unavailable', reason: 'git write-tree 输出被截断' };
    const tree = result.stdout.text.trim();
    if (!COMMIT_ID.test(tree)) return { kind: 'unavailable', reason: 'git write-tree 未返回完整 tree ID' };
    return { kind: 'read', tree };
  };

  return {
    run: async (request, scope) => {
      const invalid = requestFailure(request);
      if (invalid !== null) return { kind: 'rejected', code: 'invalid_request', message: invalid };
      // scope 只决定诊断与超时，不参与业务判定。
      const timeoutMs = Number.isFinite(scope.timeoutMs) && scope.timeoutMs > 0 ? scope.timeoutMs : defaultTimeoutMs;
      if (request.step === 'commit') return runCommit(request, timeoutMs);
      if (request.step === 'integrate_canonical') return runIntegrate(request, timeoutMs);
      if (request.step === 'merge_canonical') return runMergeCanonical(request, timeoutMs);
      if (request.step === 'merge_commit') return runMergeCommit(request, timeoutMs);
      return runPush(request, timeoutMs);
    },
    // 对账只读：绝不调用 commit/merge/push，只按原 OperationId 核验目标当前状态。
    reconcile: async (request) => {
      const invalid = requestFailure(request);
      if (invalid !== null) return { kind: 'unknown', reason: `无法对账：${invalid}` };
      if (request.step === 'merge_canonical') {
        const state = await mergeHeadState(request.sourceWorktreePath, defaultTimeoutMs);
        if (state === 'present') {
          // 合并中：回报当前冲突集合。
          const conflicts = await readConflicts(request.sourceWorktreePath, defaultTimeoutMs);
          return conflicts.kind === 'read' ? { kind: 'merge_applied', conflicts: conflicts.paths } : conflicts.outcome;
        }
        // 已提交：target 是 HEAD 祖先即可证明本轮目标已合入，重读原 Task 报告而不丢绑定。
        const ancestry = await runGit(
          request.sourceWorktreePath,
          ['merge-base', '--is-ancestor', request.expectedHead, 'HEAD'],
          defaultTimeoutMs,
        );
        if (ancestry.kind === 'terminal') return ancestry.outcome;
        return ancestry.exitCode === 0
          ? { kind: 'merge_applied', conflicts: [] }
          : { kind: 'unknown', reason: '无法证明 merge_canonical 是否已作用' };
      }
      if (request.step === 'merge_commit') {
        const read = await readHead({ kind: 'source', worktreePath: request.sourceWorktreePath });
        if (read.kind === 'unavailable') return { kind: 'unknown', reason: `无法回读 source HEAD：${read.reason}` };
        if (read.head === request.expectedHead) return { kind: 'unknown', reason: 'merge commit 未产生新的 HEAD' };
        // HEAD 已前移：必须证明它是原 expectedHead 的后继，且树等于已复验树，不能任意变了就归属。
        const ancestry = await runGit(
          request.sourceWorktreePath,
          ['merge-base', '--is-ancestor', request.expectedHead, read.head],
          defaultTimeoutMs,
        );
        if (ancestry.kind === 'terminal') return ancestry.outcome;
        if (ancestry.exitCode !== 0) return { kind: 'unknown', reason: 'HEAD 不是原 expectedHead 的后继：无法归属' };
        if (request.expectedTree !== undefined && request.expectedTree !== null) {
          const tree = await runGit(request.sourceWorktreePath, ['rev-parse', '--verify', 'HEAD^{tree}'], defaultTimeoutMs);
          if (tree.kind === 'terminal') return tree.outcome;
          if (tree.exitCode !== 0 || tree.stdout.truncated || tree.stdout.text.trim() !== request.expectedTree) {
            return { kind: 'unknown', reason: 'HEAD 树与已复验树不一致：无法归属' };
          }
        }
        return { kind: 'committed', head: read.head };
      }
      if (request.step === 'commit') {
        const read = await readHead({ kind: 'source', worktreePath: request.sourceWorktreePath });
        if (read.kind === 'unavailable') return { kind: 'unknown', reason: `无法回读 source HEAD：${read.reason}` };
        return read.head !== request.expectedHead
          ? { kind: 'committed', head: read.head }
          : { kind: 'unknown', reason: 'commit 未产生新的 HEAD，且无法证明未写入 index' };
      }
      if (request.step === 'integrate_canonical') {
        const read = await readHead({ kind: 'canonical' });
        if (read.kind === 'unavailable') return { kind: 'unknown', reason: `无法回读 canonical HEAD：${read.reason}` };
        return read.head !== request.expectedHead
          ? { kind: 'integrated', head: read.head }
          : { kind: 'unknown', reason: 'canonical HEAD 仍等于 expected HEAD，无法证明集成已生效' };
      }
      if (request.remote === null || request.ref === null) {
        return { kind: 'unknown', reason: 'push 步缺少获批的 remote 与 ref' };
      }
      const local = await readHead({ kind: 'canonical' });
      if (local.kind === 'unavailable') return { kind: 'unknown', reason: `无法回读 canonical HEAD：${local.reason}` };
      if (local.head !== request.expectedHead) {
        return { kind: 'unknown', reason: 'canonical HEAD 与原 push 意图的 expected HEAD 不一致' };
      }
      const remote = await readHead({ kind: 'remote', remote: request.remote, ref: request.ref });
      if (remote.kind === 'unavailable') {
        return { kind: 'unknown', reason: `无法回读 ${request.remote} ${request.ref}：${remote.reason}` };
      }
      if (remote.head !== local.head) {
        return {
          kind: 'unknown',
          reason: `${request.remote} ${request.ref} 为 ${remote.head}，与 canonical HEAD ${local.head} 不一致`,
        };
      }
      return { kind: 'pushed', remote: request.remote, ref: request.ref, head: local.head };
    },
    readHead,
    isAncestor: readAncestry,
    readTree,
  };
}
