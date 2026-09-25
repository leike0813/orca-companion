/**
 * IP-05 / D5：受控 Git 集成端口的生产实现。
 *
 * 只执行已批准的三个步骤（commit、integrate_canonical、push），全部经 `runProcess` 以可执行文件
 * 加参数数组与显式 cwd 调用 `git`，绝不经 shell；不产生 merge commit、不 rewrite 历史、不 force push、
 * 不 reset，也不切换用户当前分支。
 *
 * 三个步骤各自核验自己的目标：commit 只验证精确 Worker worktree 的 HEAD，integrate 只验证 canonical
 * 的 HEAD，push 只验证获批 remote/ref 的目标 commit。进程超时、冲突、非 fast-forward 或回读不一致都
 * 返回 `unknown`/`rejected`，由 IC-08 按原 OperationId 对账：本 adapter 不重试，也不推断结果。
 */

import {
  runProcess,
  type OutputLimits,
  type ProcessResult,
  type ProcessRunner,
} from '../orca-cli/process-runner.js';
import type {
  GitHeadRead,
  GitIntegrationPort,
  GitReadbackTarget,
  GitStepOutcome,
  GitStepRequest,
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

  return {
    run: async (request, scope) => {
      const invalid = requestFailure(request);
      if (invalid !== null) return { kind: 'rejected', code: 'invalid_request', message: invalid };
      // scope 只决定诊断与超时，不参与业务判定。
      const timeoutMs = Number.isFinite(scope.timeoutMs) && scope.timeoutMs > 0 ? scope.timeoutMs : defaultTimeoutMs;
      if (request.step === 'commit') return runCommit(request, timeoutMs);
      if (request.step === 'integrate_canonical') return runIntegrate(request, timeoutMs);
      return runPush(request, timeoutMs);
    },
    // 对账只读：绝不调用 commit/merge/push，只按原 OperationId 核验目标当前状态。
    reconcile: async (request) => {
      const invalid = requestFailure(request);
      if (invalid !== null) return { kind: 'unknown', reason: `无法对账：${invalid}` };
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
  };
}
