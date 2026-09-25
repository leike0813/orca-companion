/**
 * 受控 Git 集成 adapter 测试（change: `m2-wire-execution-runtime`，IP-05）。
 *
 * 用真实 `git` 在隔离临时目录内建 bare remote、canonical clone 与 Worker worktree，覆盖三个步骤的
 * 分目标读回、expected HEAD 不符、非 fast-forward、幂等 commit 与只读对账；夹具自带 Git 身份，
 * 不依赖用户的全局配置或主项目。
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { createGitIntegrationPort } from '../../src/adapters/git/integration.js';
import { runProcess } from '../../src/adapters/orca-cli/process-runner.js';
import type { GitIntegrationPort, GitStepRequest } from '../../src/application/integrate-work-package.js';
import type { WorkPackageId } from '../../src/application/dto/identity.js';
import type { ExecutionScope } from '../../src/application/ports/execution-backend.js';

const GIT_ENV: Readonly<Record<string, string>> = {
  ...(process.env as Record<string, string>),
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_SYSTEM: devNull,
  GIT_TERMINAL_PROMPT: '0',
};

/** 形态合法但不可能存在的 commit ID，用来表达「expected HEAD 已经过期」。 */
const STALE = 'dead'.repeat(10);

let root = '';
let canonical = '';
let source = '';
let remotePath = '';
let port: GitIntegrationPort;

function gitAt(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim();
}

/** 夹具自带提交身份；远程执行不弹出凭据提示。 */
function configure(cwd: string): void {
  gitAt(cwd, 'config', 'user.name', 'Verification');
  gitAt(cwd, 'config', 'user.email', 'verification@example.invalid');
}

function commitAll(cwd: string, message: string): void {
  gitAt(cwd, 'add', '-A');
  gitAt(cwd, 'commit', '-q', '-m', message);
}

const scope = (operationId: string): ExecutionScope => ({
  coordinationScopeId: 'scope-1',
  coordinatorSessionId: 'session-a',
  runtimeIncarnationId: 'inc-a',
  fencingGeneration: 0,
  backendIdentityRef: 'identity-ref',
  operationId,
  target: { kind: 'work-package', id: 'wp-1' },
  expectedRevision: 1,
  timeoutMs: 30_000,
  authority: {
    kind: 'execution_coordination',
    graphGeneration: 1,
    authorizationId: 'auth-1',
    runId: 'run-1',
    consumerGeneration: 1,
  },
});

function request(step: GitStepRequest['step'], overrides: Partial<GitStepRequest> = {}): GitStepRequest {
  return {
    step,
    workPackageId: 'wp-1' as WorkPackageId,
    sourceWorktreePath: source,
    // canonical 分支的授权判定留在 application 层；adapter 合并/推送的是 sourceBranch。
    branch: 'main',
    sourceBranch: 'wp-1',
    remote: 'origin',
    ref: 'refs/heads/main',
    expectedHead: gitAt(source, 'rev-parse', 'HEAD'),
    commitMessage: step === 'commit' ? 'feat: wp-1' : null,
    ...overrides,
  };
}

/** 走完 commit 与 integrate，返回 canonical HEAD。 */
async function commitAndIntegrate(): Promise<string> {
  writeFileSync(join(source, 'feature.txt'), 'worker change\n');
  const committed = await port.run(request('commit'), scope('op-commit'));
  if (committed.kind !== 'committed') {
    throw new Error(`commit 步未完成：${JSON.stringify(committed)}`);
  }
  const integrated = await port.run(
    request('integrate_canonical', { branch: 'wp-1', expectedHead: gitAt(canonical, 'rev-parse', 'HEAD') }),
    scope('op-integrate'),
  );
  if (integrated.kind !== 'integrated') {
    throw new Error(`integrate 步未完成：${JSON.stringify(integrated)}`);
  }
  return committed.head;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-git-integration-'));
  remotePath = join(root, 'remote.git');
  canonical = join(root, 'canonical');
  source = join(root, 'worker');
  const seed = join(root, 'seed');
  execFileSync('git', ['init', '-q', seed], { cwd: root, env: GIT_ENV });
  configure(seed);
  writeFileSync(join(seed, 'README.md'), 'baseline\n');
  commitAll(seed, 'baseline');
  gitAt(seed, 'branch', '-m', 'main');
  execFileSync('git', ['init', '-q', '--bare', remotePath], { cwd: root, env: GIT_ENV });
  gitAt(remotePath, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  gitAt(seed, 'push', '-q', remotePath, 'main:refs/heads/main');
  execFileSync('git', ['clone', '-q', remotePath, canonical], { cwd: root, env: GIT_ENV });
  configure(canonical);
  gitAt(canonical, 'worktree', 'add', '-q', '-b', 'wp-1', source);
  port = createGitIntegrationPort({ canonicalWorktreePath: canonical, env: GIT_ENV, timeoutMs: 30_000 });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test('commit 步只在精确 Worker worktree 生效，canonical 未动', async () => {
  const baseline = gitAt(canonical, 'rev-parse', 'HEAD');
  const sourceHead = gitAt(source, 'rev-parse', 'HEAD');
  writeFileSync(join(source, 'feature.txt'), 'worker change\n');

  const outcome = await port.run(request('commit', { expectedHead: sourceHead }), scope('op-commit'));

  expect(outcome.kind).toBe('committed');
  if (outcome.kind !== 'committed') return;
  expect(outcome.head).not.toBe(sourceHead);
  expect(gitAt(source, 'rev-parse', 'HEAD')).toBe(outcome.head);
  expect(gitAt(source, 'status', '--porcelain')).toBe('');
  expect(gitAt(canonical, 'rev-parse', 'HEAD')).toBe(baseline);
  expect(gitAt(canonical, 'status', '--porcelain')).toBe('');
  expect(await port.readHead({ kind: 'source', worktreePath: source })).toEqual({
    kind: 'read',
    head: outcome.head,
  });
});

test('integrate 步把 canonical fast-forward 到 Worker HEAD，不产生 merge commit', async () => {
  const canonicalHead = await commitAndIntegrate();

  expect(gitAt(canonical, 'rev-parse', 'HEAD')).toBe(canonicalHead);
  expect(gitAt(canonical, 'status', '--porcelain')).toBe('');
  expect(gitAt(canonical, 'rev-list', '--count', 'HEAD')).toBe('2');
  expect(await port.readHead({ kind: 'canonical' })).toEqual({ kind: 'read', head: canonicalHead });
});

test('push 步推送 canonical HEAD 到获批 remote/ref', async () => {
  expect(await port.readHead({ kind: 'remote', remote: 'origin', ref: 'refs/heads/release' })).toEqual({
    kind: 'unavailable',
    reason: 'remote-ref-not-found',
  });
  const canonicalHead = await commitAndIntegrate();

  const pushed = await port.run(request('push', { expectedHead: canonicalHead }), scope('op-push'));

  expect(pushed).toEqual({ kind: 'pushed', remote: 'origin', ref: 'refs/heads/main', head: canonicalHead });
  expect(gitAt(remotePath, 'rev-parse', 'refs/heads/main')).toBe(canonicalHead);
  expect(await port.readHead({ kind: 'remote', remote: 'origin', ref: 'refs/heads/main' })).toEqual({
    kind: 'read',
    head: canonicalHead,
  });
});

test('expectedHead 与实际 HEAD 不符时拒绝且零副作用', async () => {
  const baseline = gitAt(canonical, 'rev-parse', 'HEAD');
  writeFileSync(join(source, 'feature.txt'), 'worker change\n');

  const sourceRejected = await port.run(request('commit', { expectedHead: STALE }), scope('op-commit'));

  expect(sourceRejected).toMatchObject({ kind: 'rejected', code: 'source_head_mismatch' });
  expect(gitAt(source, 'rev-parse', 'HEAD')).toBe(baseline);
  // 未被 add：拒绝发生在任何 index 写入之前。
  expect(gitAt(source, 'status', '--porcelain')).toBe('?? feature.txt');

  const committed = await port.run(request('commit'), scope('op-commit'));
  if (committed.kind !== 'committed') throw new Error(`commit 步未完成：${JSON.stringify(committed)}`);
  const canonicalRejected = await port.run(
    request('integrate_canonical', { branch: 'wp-1', expectedHead: committed.head }),
    scope('op-integrate'),
  );

  expect(canonicalRejected).toMatchObject({ kind: 'rejected', code: 'canonical_head_mismatch' });
  expect(gitAt(canonical, 'rev-parse', 'HEAD')).toBe(baseline);
  expect(gitAt(canonical, 'status', '--porcelain')).toBe('');
});

test('非 fast-forward 的集成被拒绝且 canonical 不变', async () => {
  writeFileSync(join(source, 'feature.txt'), 'worker change\n');
  const committed = await port.run(request('commit'), scope('op-commit'));
  if (committed.kind !== 'committed') throw new Error(`commit 步未完成：${JSON.stringify(committed)}`);
  // canonical 上另行前进，使 wp-1 不再是 canonical 的后继。
  writeFileSync(join(canonical, 'canonical.txt'), 'canonical side\n');
  commitAll(canonical, 'canonical side');
  const divergent = gitAt(canonical, 'rev-parse', 'HEAD');

  const outcome = await port.run(
    request('integrate_canonical', { branch: 'wp-1', expectedHead: divergent }),
    scope('op-integrate'),
  );

  expect(outcome).toMatchObject({ kind: 'rejected', code: 'canonical_not_fast_forward' });
  expect(gitAt(canonical, 'rev-parse', 'HEAD')).toBe(divergent);
  // `--ff-only` 失败时不留 merge commit、MERGE_HEAD 或冲突。
  expect(gitAt(canonical, 'status', '--porcelain')).toBe('');
  expect(gitAt(source, 'rev-parse', 'HEAD')).toBe(committed.head);
});

test('无 staged 变化时 commit 步不新建 commit', async () => {
  writeFileSync(join(source, 'feature.txt'), 'worker change\n');
  commitAll(source, 'worker self commit');
  const head = gitAt(source, 'rev-parse', 'HEAD');
  const count = gitAt(source, 'rev-list', '--count', 'HEAD');

  const outcome = await port.run(request('commit', { expectedHead: head }), scope('op-commit'));

  expect(outcome).toEqual({ kind: 'committed', head });
  expect(gitAt(source, 'rev-list', '--count', 'HEAD')).toBe(count);
  expect(gitAt(source, 'status', '--porcelain')).toBe('');
});

test('Worker 已自行提交交接成果时 commit 步按当前 HEAD 认账，只要求它是获批基线的后继', async () => {
  const baseline = gitAt(source, 'rev-parse', 'HEAD');
  writeFileSync(join(source, 'feature.txt'), 'worker change\n');
  commitAll(source, 'worker self commit');
  const workerHead = gitAt(source, 'rev-parse', 'HEAD');

  // expectedHead 仍是获批基线：真实 Worker 已提交，因此 HEAD 不等于基线但确实是它的后继。
  const outcome = await port.run(request('commit', { expectedHead: baseline }), scope('op-commit'));
  expect(outcome).toEqual({ kind: 'committed', head: workerHead });

  // 不是基线的后继（历史被替换/改写）时仍然拒绝。
  const orphan = gitAt(source, 'commit-tree', `${baseline}^{tree}`, '-m', 'orphan');
  gitAt(source, 'checkout', '--detach', orphan);
  const mismatch = await port.run(request('commit', { expectedHead: baseline }), scope('op-commit'));
  expect(mismatch).toMatchObject({ kind: 'rejected', code: 'source_head_mismatch' });
});

test('reconcile 只读回读，不产生新 commit 或推送', async () => {
  const canonicalHead = await commitAndIntegrate();
  const pushed = await port.run(request('push', { expectedHead: canonicalHead }), scope('op-push'));
  expect(pushed.kind).toBe('pushed');

  const snapshot = {
    source: gitAt(source, 'rev-parse', 'HEAD'),
    canonical: gitAt(canonical, 'rev-parse', 'HEAD'),
    remote: gitAt(remotePath, 'rev-parse', 'refs/heads/main'),
    commits: gitAt(source, 'rev-list', '--count', 'HEAD'),
    refs: gitAt(canonical, 'show-ref'),
  };
  // 与当前 HEAD 不同的任意 hex，用来表示「上一步的 expected HEAD」。
  const earlier = gitAt(canonical, 'rev-parse', 'HEAD~1');

  expect(await port.reconcile(request('commit', { expectedHead: earlier }), scope('op-commit'))).toEqual({
    kind: 'committed',
    head: snapshot.source,
  });
  expect(
    await port.reconcile(request('integrate_canonical', { branch: 'wp-1', expectedHead: earlier }), scope('op-integrate')),
  ).toEqual({ kind: 'integrated', head: snapshot.canonical });
  expect(await port.reconcile(request('push', { expectedHead: snapshot.canonical }), scope('op-push'))).toEqual({
    kind: 'pushed',
    remote: 'origin',
    ref: 'refs/heads/main',
    head: snapshot.canonical,
  });
  // 没有新 HEAD 时只能是 unknown，不能推断已提交。
  expect(await port.reconcile(request('commit', { expectedHead: snapshot.source }), scope('op-commit'))).toMatchObject({
    kind: 'unknown',
  });

  expect(gitAt(source, 'rev-parse', 'HEAD')).toBe(snapshot.source);
  expect(gitAt(canonical, 'rev-parse', 'HEAD')).toBe(snapshot.canonical);
  expect(gitAt(remotePath, 'rev-parse', 'refs/heads/main')).toBe(snapshot.remote);
  expect(gitAt(source, 'rev-list', '--count', 'HEAD')).toBe(snapshot.commits);
  expect(gitAt(canonical, 'show-ref')).toBe(snapshot.refs);
});

test('非法输入与不可读的 worktree 被拒绝，且不落到任何 git 变更上', async () => {
  const plain = join(root, 'plain');
  mkdirSync(plain);

  const notARepository = await port.run(
    request('commit', { sourceWorktreePath: plain, expectedHead: 'a'.repeat(40) }),
    scope('op-commit'),
  );
  const invalidHead = await port.run(request('commit', { expectedHead: 'not-a-commit' }), scope('op-commit'));
  const relativePath = await port.run(
    request('integrate_canonical', { sourceWorktreePath: 'relative/worker', branch: 'wp-1' }),
    scope('op-integrate'),
  );
  const optionLikeBranch = await port.run(request('push', { branch: '--force' }), scope('op-push'));

  expect(notARepository).toMatchObject({ kind: 'rejected', code: 'git_failed' });
  expect(invalidHead).toMatchObject({ kind: 'rejected', code: 'invalid_request' });
  expect(relativePath).toMatchObject({ kind: 'rejected', code: 'invalid_request' });
  expect(optionLikeBranch).toMatchObject({ kind: 'rejected', code: 'invalid_request' });
  expect(gitAt(canonical, 'status', '--porcelain')).toBe('');
  expect(gitAt(source, 'status', '--porcelain')).toBe('');
});

test('commit 在暂存前拒绝缺失提交信息，暂存后报错则保留 unknown 供原 ID 对账', async () => {
  writeFileSync(join(source, 'feature.txt'), 'worker change\n');
  const missingMessage = await port.run(request('commit', { commitMessage: null }), scope('op-commit'));
  expect(missingMessage).toMatchObject({ kind: 'rejected', code: 'missing_commit_message' });
  expect(gitAt(source, 'diff', '--cached', '--name-only')).toBe('');

  const failing = createGitIntegrationPort({
    canonicalWorktreePath: canonical,
    env: GIT_ENV,
    runner: async (input) => {
      const result = await runProcess(input);
      return input.args[0] === 'add' && result.kind === 'completed'
        ? { ...result, exitCode: 1 }
        : result;
    },
  });
  const attempt = request('commit');
  expect(await failing.run(attempt, scope('op-commit'))).toMatchObject({ kind: 'unknown' });
  expect(gitAt(source, 'diff', '--cached', '--name-only')).toBe('feature.txt');
  expect(await failing.reconcile(attempt, scope('op-commit'))).toMatchObject({ kind: 'unknown' });
});

test('push 退出码失败但远端已移动时先报 unknown，再从同一目标只读对账', async () => {
  const head = await commitAndIntegrate();
  const failing = createGitIntegrationPort({
    canonicalWorktreePath: canonical,
    env: GIT_ENV,
    runner: async (input) => {
      const result = await runProcess(input);
      return input.args[0] === 'push' && result.kind === 'completed'
        ? { ...result, exitCode: 1 }
        : result;
    },
  });
  const attempt = request('push', { expectedHead: head });
  expect(await failing.run(attempt, scope('op-push'))).toMatchObject({ kind: 'unknown' });
  expect(await failing.reconcile(attempt, scope('op-push'))).toMatchObject({ kind: 'pushed', head });
});
