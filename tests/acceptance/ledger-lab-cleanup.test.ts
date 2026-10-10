import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { debugDirectoryId, debugSessionPaths, FileDebugSessionStore } from '../../src/adapters/storage/debug-session-store.js';
import { coordinatorConfigurationFixture } from '../support/model-configurations.js';

type Target = { state: string; code: string | null; observedAt: string | null };
type RecordValue = {
  schemaVersion: number; directory: string; id: string; repositoryPath: string;
  localIdentity: { device: string; inode: string } | null;
  github: { host: string; nameWithOwner: string; url: string | null; nodeId: string | null };
  cleanup: { local: Target; remote: Target };
  orca: { executable: string; repoId: string; worktreeId: string } | null;
};
type CallOptions = { stdin?: string; cwd?: string };
type Dependencies = {
  call?: (file: string, args: string[], options?: CallOptions) => Promise<string>;
  assertInactive?: () => Promise<void>; remove?: (path: string) => Promise<void>; env?: Record<string, string>;
};
type CleanupResult = { kind: string; local: Target; remote: Target; blockers: { code: string }[] };
const records = await import(/* @vite-ignore */ new URL('../../artifacts/ledger-lab/run-record.mjs', import.meta.url).href) as {
  companionRoot: string; localIdentity(path: string): Promise<RecordValue['localIdentity']>;
  saveRun(directory: string, value: unknown): Promise<void>; readRun(path: string): Promise<RecordValue>;
  listRuns(root: string): Promise<{ runs: unknown[]; truncated: boolean }>;
};
const cleanup = await import(/* @vite-ignore */ new URL('../../artifacts/ledger-lab/cleanup.mjs', import.meta.url).href) as {
  cleanupLab(options: { run: string; yes?: boolean }, dependencies: Dependencies): Promise<CleanupResult>;
  assertInactive(record: RecordValue, dependencies: Dependencies): Promise<void>;
};
const lab = await import(/* @vite-ignore */ new URL('../../artifacts/ledger-lab/lab.mjs', import.meta.url).href) as {
  resolveRunOptions(command: string, options: Record<string, string>): Promise<Record<string, string>>;
  parseArguments(argv: string[]): { command: string; options: Record<string, string | boolean> };
};
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'lab-cleanup-'));
  roots.push(root);
  const id = 'ledger-lab-main-fixture';
  const directory = join(root, id);
  const repo = join(directory, 'repo');
  await mkdir(repo, { recursive: true });
  for (const name of ['operator', 'packages', 'captures', 'checks']) {
    await mkdir(join(directory, name));
    await writeFile(join(directory, name, 'evidence.txt'), 'retained');
  }
  const record = { schemaVersion: 2, kind: 'ledger-lab-run', id, profile: 'main', repositoryPath: repo,
    branch: 'refs/heads/main', companionRoot: records.companionRoot, state: 'ready', stage: 'ready',
    baselineHead: 'abc', createdAt: new Date().toISOString(), localIdentity: await records.localIdentity(repo),
    github: { host: 'github.com', nameWithOwner: `fixture-user/${id}`, url: `https://github.com/fixture-user/${id}`, nodeId: 'R_original' as string | null },
    installation: null, orca: null,
    cleanup: { local: { state: 'pending', code: null, observedAt: null }, remote: { state: 'pending', code: null, observedAt: null } } };
  await records.saveRun(directory, record);
  let remotePresent = true;
  const deletes: string[] = [];
  const call = vi.fn((_file: string, args: string[]) => {
    const rest = args.indexOf('--method') !== -1 && args[args.indexOf('--method') + 1] === 'DELETE';
    if (rest) {
      deletes.push(args.at(-1) ?? '');
      remotePresent = false;
      return Promise.resolve('');
    }
    return Promise.resolve(JSON.stringify({ data: { viewer: { login: 'fixture-user' }, node: remotePresent ?
      { id: record.github.nodeId, nameWithOwner: record.github.nameWithOwner, url: record.github.url } : null,
      repository: remotePresent ? { id: record.github.nodeId } : null } }));
  });
  const deps = { call, assertInactive: async () => {} };
  return { root, directory, repo, record, deletes, call, deps };
}

describe('ledger lab recorded repository reclamation', () => {
  it('preview is read-only; explicit cleanup removes dirty repo but keeps all external evidence and list entry', async () => {
    const f = await fixture();
    await writeFile(join(f.repo, 'unfinished.txt'), 'business work');
    const before = await readFile(join(f.directory, 'run.json'), 'utf8');
    const preview = await cleanup.cleanupLab({ run: f.directory }, f.deps);
    expect(preview.kind).toBe('cleanup-preview');
    expect(f.deletes).toEqual([]);
    expect(await readFile(join(f.directory, 'run.json'), 'utf8')).toBe(before);
    const result = await cleanup.cleanupLab({ run: f.directory, yes: true }, f.deps);
    expect([result.local.state, result.remote.state]).toEqual(['deleted', 'deleted']);
    await expect(stat(f.repo)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.deletes).toEqual([`/repos/${f.record.github.nameWithOwner}`]);
    for (const name of ['operator', 'packages', 'captures', 'checks']) expect(await readFile(join(f.directory, name, 'evidence.txt'), 'utf8')).toBe('retained');
    expect((await records.listRuns(f.root)).runs).toHaveLength(1);
    expect((await records.readRun(f.directory)).cleanup.local.state).toBe('deleted');
    await cleanup.cleanupLab({ run: f.directory, yes: true }, f.deps);
    expect(f.deletes).toHaveLength(1);
  });

  it.each(['replacement-directory', 'symlink', 'replacement-remote'])('rejects %s before deleting either target', async kind => {
    const f = await fixture();
    if (kind !== 'replacement-remote') {
      await rename(f.repo, join(f.directory, 'original'));
      if (kind === 'symlink') await symlink(join(f.directory, 'original'), f.repo);
      else await mkdir(f.repo);
    } else {
      f.call.mockImplementation(() => Promise.resolve(JSON.stringify({ data: { viewer: { login: 'fixture-user' },
        node: { id: 'R_original', nameWithOwner: f.record.github.nameWithOwner, url: f.record.github.url }, repository: { id: 'R_replacement' } } })));
    }
    await expect(cleanup.cleanupLab({ run: f.directory, yes: true }, f.deps)).rejects.toMatchObject({ code: 'LAB_IDENTITY_MISMATCH' });
    expect(f.deletes).toEqual([]);
    expect(await stat(f.repo)).toBeTruthy();
  });

  it('preserves remote success on local failure and retries only the pending local target', async () => {
    const f = await fixture();
    const remove = vi.fn(() => Promise.reject(Object.assign(new Error('fixture IO failure'), { code: 'EACCES' })));
    await expect(cleanup.cleanupLab({ run: f.directory, yes: true }, { ...f.deps, remove })).rejects.toMatchObject({ code: 'EACCES' });
    const record = await records.readRun(f.directory);
    expect(record.cleanup.remote.state).toBe('deleted');
    expect(record.cleanup.local.state).toBe('failed');
    await cleanup.cleanupLab({ run: f.directory, yes: true }, f.deps);
    expect(f.deletes).toHaveLength(1);
  });

  it('stops after a lost delete response and reconciles on the next explicit execution without sending another deletion', async () => {
    const f = await fixture();
    const original = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (file: string, args: string[]) => {
      const value = await original(file, args);
      if (args.includes('DELETE')) throw Object.assign(new Error('lost response'), { code: 'LAB_OPERATION_UNKNOWN' });
      return value;
    });
    await expect(cleanup.cleanupLab({ run: f.directory, yes: true }, f.deps)).rejects.toMatchObject({ code: 'LAB_OPERATION_UNKNOWN' });
    expect((await records.readRun(f.directory)).cleanup.remote.state).toBe('unknown');
    expect(await stat(f.repo)).toBeTruthy();
    await cleanup.cleanupLab({ run: f.directory, yes: true }, f.deps);
    expect(f.deletes).toHaveLength(1);
    await expect(stat(f.repo)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['LAB_ACTIVE_RESOURCE', 'LAB_RESOURCE_UNVERIFIABLE'])('known running or unverifiable resource blocks all deletion (%s)', async code => {
    const f = await fixture();
    await expect(cleanup.cleanupLab({ run: f.directory, yes: true }, { ...f.deps,
      assertInactive: () => Promise.reject(Object.assign(new Error('fixture runtime'), { code })) })).rejects.toMatchObject({ code });
    expect(f.deletes).toEqual([]);
    expect(await stat(f.repo)).toBeTruthy();
  });

  it('refuses overlapping cleanup without mutating resources', async () => {
    const f = await fixture();
    await writeFile(join(f.directory, 'cleanup.lock'), '{}');
    await expect(cleanup.cleanupLab({ run: f.directory, yes: true }, f.deps)).rejects.toMatchObject({ code: 'LAB_CLEANUP_BUSY' });
    expect(f.call).not.toHaveBeenCalled();
  });

  it('legacy failure records remain readable but cannot authorize deletion', async () => {
    const f = await fixture();
    const { localIdentity: ignoredLocal, github, installation: ignoredInstall, orca: ignoredOrca, cleanup: ignoredCleanup, ...base } = f.record;
    void ignoredLocal; void ignoredInstall; void ignoredOrca; void ignoredCleanup;
    await records.saveRun(f.directory, { ...base, schemaVersion: 1, state: 'failed', githubRepository: github.nameWithOwner,
      orcaExecutable: '/fixture/orca', orcaRepoId: null, worktreeId: null, terminalHandle: null,
      routeMapIssueNumber: null, sourceHead: null, sourceDirty: null });
    await rm(f.repo, { recursive: true });
    expect((await records.readRun(f.directory)).schemaVersion).toBe(1);
    await expect(cleanup.cleanupLab({ run: f.directory, yes: true }, f.deps)).rejects.toMatchObject({ code: 'LAB_IDENTITY_MISSING' });
    expect(f.call).not.toHaveBeenCalled();
  });

  it('missing remote creation identity allows only proven local reclamation and retains unknown remote state', async () => {
    const f = await fixture();
    f.record.github.nodeId = null;
    await records.saveRun(f.directory, f.record);
    await expect(cleanup.cleanupLab({ run: f.directory, yes: true }, f.deps)).rejects.toMatchObject({ code: 'LAB_IDENTITY_MISSING' });
    expect(f.call).not.toHaveBeenCalled();
    const record = await records.readRun(f.directory);
    expect([record.cleanup.local.state, record.cleanup.remote.state]).toEqual(['deleted', 'unknown']);
  });

  it('an authenticated non-owner cannot prove disappearance of a private repository', async () => {
    const f = await fixture();
    f.call.mockImplementation(() => Promise.resolve(JSON.stringify({ data: { viewer: { login: 'other-user' }, node: null, repository: null } })));
    await expect(cleanup.cleanupLab({ run: f.directory, yes: true }, f.deps)).rejects.toMatchObject({ code: 'LAB_OPERATION_UNKNOWN' });
    expect(await stat(f.repo)).toBeTruthy();
  });

  it('reconciles GraphQL NOT_FOUND partial data from a verified owner instead of confusing it with command failure', async () => {
    const f = await fixture();
    f.call.mockImplementation(() => Promise.reject(Object.assign(new Error('gh exits nonzero for GraphQL not found'), {
      code: 'LAB_COMMAND_FAILED', response: { data: { viewer: { login: 'fixture-user' }, node: null, repository: null },
        errors: [{ type: 'NOT_FOUND', path: ['node'] }, { type: 'NOT_FOUND', path: ['repository'] }] },
    })));
    const result = await cleanup.cleanupLab({ run: f.directory, yes: true }, f.deps);
    expect(result.remote.state).toBe('deleted');
    expect(result.local.state).toBe('deleted');
  });

  it('lists corrupt records individually and reports bounded truncation', async () => {
    const f = await fixture();
    for (let index = 0; index < 101; index++) {
      const directory = join(f.root, `ledger-lab-broken-${index}`);
      await mkdir(directory);
      await writeFile(join(directory, 'run.json'), '{}');
    }
    const result = await records.listRuns(f.root);
    expect(result.runs).toHaveLength(100);
    expect(result.truncated).toBe(true);
    expect(result.runs).toEqual(expect.arrayContaining([expect.objectContaining({ error: 'LAB_INVALID_RECORD' })]));
  });

  it('resolves retained process/report inputs after reclamation without querying a live Scope', async () => {
    const f = await fixture();
    await cleanup.cleanupLab({ run: f.directory, yes: true }, f.deps);
    await writeFile(join(f.directory, 'checks', 'process-20261009.json'), '{}');
    await writeFile(join(f.directory, 'checks', 'result-20261009.json'), '{}');
    const process = await lab.resolveRunOptions('verify-process', { run: f.directory, evidence: join(f.directory, 'captures', 'evidence.jsonl') });
    expect(process.repo).toBe(f.repo);
    expect(process.observations).toBe(join(f.directory, 'operator', 'observations.json'));
    const report = await lab.resolveRunOptions('report', { run: f.directory });
    expect(report.process).toBe(join(f.directory, 'checks', 'process-20261009.json'));
    expect(report.result).toBe(join(f.directory, 'checks', 'result-20261009.json'));
    expect(lab.parseArguments(['cleanup', '--run', f.directory, '--yes']).options).toEqual({ run: f.directory, yes: true });
    expect(() => lab.parseArguments(['configure'])).toThrow();
    expect(() => lab.parseArguments(['prepare', '--settings', '/unused'])).toThrow();
  });

  it('checks real local Git runtime storage without creating it and rejects a registered Orca worktree', async () => {
    const f = await fixture();
    execFileSync('git', ['init', '--initial-branch=main', f.repo], { stdio: 'ignore' });
    const record = await records.readRun(f.directory);
    record.orca = { executable: '/fixture/orca', repoId: 'repo_original', worktreeId: 'wt_original' };
    const call = (file: string, args: string[]) => Promise.resolve(file === 'git'
      ? execFileSync(file, args, { cwd: f.repo, encoding: 'utf8' })
      : JSON.stringify({ ok: true, result: { worktree: { id: 'wt_original', repoId: 'repo_original', path: f.repo } } }));
    await expect(cleanup.assertInactive(record, { call, env: { XDG_STATE_HOME: join(f.root, 'state') } })).rejects.toMatchObject({ code: 'LAB_ACTIVE_RESOURCE' });
    await expect(stat(join(f.repo, '.git', 'orca-companion'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('an actual live debug writer blocks reclamation while an exited writer is only observed, never removed', async () => {
    const f = await fixture();
    const stateDirectory = join(f.root, 'state', 'orca-companion', 'debug');
    const registry = new FileDebugSessionStore({ stateDirectory, newId: () => 'session-fixture' });
    const registered = registry.register({ debugDirectoryId: debugDirectoryId(f.repo), directoryPath: f.repo,
      configuration: coordinatorConfigurationFixture() });
    expect(registered.kind).toBe('ok');
    const paths = debugSessionPaths(stateDirectory, 'session-fixture');
    await mkdir(paths.directory, { recursive: true });
    await writeFile(paths.writerLock, JSON.stringify({ pid: process.pid }));
    const env = { XDG_STATE_HOME: join(f.root, 'state'), ORCA_CLI_COMMAND: '/nonexistent-lab-test-orca' };
    await expect(cleanup.assertInactive(await records.readRun(f.directory), { env, call: f.call })).rejects.toMatchObject({ code: 'LAB_ACTIVE_RESOURCE' });
    // Linux pid_max is below this value: ESRCH is definitive and the file stays intact.
    await writeFile(paths.writerLock, JSON.stringify({ pid: 2147483647 }));
    await cleanup.assertInactive(await records.readRun(f.directory), { env, call: f.call });
    expect(JSON.parse(await readFile(paths.writerLock, 'utf8'))).toEqual({ pid: 2147483647 });
    expect(f.call).not.toHaveBeenCalled();
  });
});
