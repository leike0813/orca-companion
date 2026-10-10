import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

type CallOptions = { readonly cwd?: string; readonly env?: Readonly<Record<string, string>>; readonly timeoutMs?: number };
type Call = (executable: string, args: readonly string[], options?: CallOptions) => Promise<string>;
type RunRecord = {
  readonly directory: string;
  readonly id: string;
  readonly profile: string;
  readonly repositoryPath: string;
  readonly branch: string;
  readonly state: string;
  readonly stage: string;
  readonly github: { readonly host: string; readonly nameWithOwner: string; readonly url: string | null; readonly nodeId: string | null };
  readonly installation: { readonly packageVersion: string; readonly packagePath: string; readonly sourceHead: string; readonly sourceDirty: boolean } | null;
  readonly orca: { readonly executable: string; readonly repoId: string; readonly worktreeId: string | null; readonly terminalHandle?: string } | null;
  readonly startup?: { readonly cwd: string; readonly command: string; readonly debugCommand: string };
};
type SetupModule = {
  readonly companionRoot: string;
  readonly cleanEnvironment: (env: Record<string, string | undefined>) => Record<string, string>;
  readonly createCommandRunner: (options: {
    readonly env: Readonly<Record<string, string>>;
    readonly runner: (request: {
      readonly executable: string;
      readonly args: readonly string[];
      readonly cwd: string;
      readonly env: Readonly<Record<string, string>>;
      readonly timeoutMs: number;
      readonly limits: { readonly maxBytes: number; readonly maxLines: number };
    }) => Promise<unknown>;
  }) => Promise<(executable: string, args: readonly string[], options?: CallOptions) => Promise<string>>;
  readonly prepareLab: (options: { readonly profile?: 'main' | 'cancel'; readonly root?: string }, dependencies: {
    readonly env?: Record<string, string | undefined>;
    readonly orca?: string;
    readonly call?: Call;
    readonly signal?: AbortSignal;
    readonly progress?: (stage: string) => void;
  }) => Promise<RunRecord>;
  readonly readRun: (path: string) => Promise<RunRecord>;
  readonly listRuns: (root?: string) => Promise<{ readonly root: string; readonly runs: readonly { readonly id?: string; readonly state?: string; readonly error?: string }[]; readonly truncated: boolean }>;
  readonly bindOperatorFiles: (record: Pick<RunRecord, 'directory'>, scopeId: string) => Promise<void>;
  readonly verifyScopeForRun: (record: RunRecord, scopeId: string, dependencies: { readonly env?: Record<string, string | undefined>; readonly call?: Call }) => Promise<string>;
  readonly bindOrcaForRun: (record: RunRecord, dependencies: { readonly env?: Record<string, string | undefined>; readonly orca?: string; readonly call?: Call }) => Promise<RunRecord>;
  readonly openLab: (options: { readonly run: string }, dependencies: { readonly env?: Record<string, string | undefined>; readonly orca?: string; readonly call: Call }) => Promise<RunRecord & {
    readonly terminalHandle?: string;
  }>;
  readonly shellQuote: (value: string) => string;
};
type LabModule = { readonly main: (argv: readonly string[]) => Promise<number> };

const setupHref = new URL('../../artifacts/ledger-lab/setup.mjs', import.meta.url).href;
const setup = (await import(/* @vite-ignore */ setupHref)) as SetupModule;
const labHref = new URL('../../artifacts/ledger-lab/lab.mjs', import.meta.url).href;
const lab = (await import(/* @vite-ignore */ labHref)) as LabModule;
const ORCA_EXECUTABLE = '/fixture/bin/orca';

const sandboxes: string[] = [];
async function sandbox(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'ledger-lab-setup-'));
  sandboxes.push(path);
  return path;
}
async function readRunFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(sandboxes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** 合成外部命令：Git 真实执行，gh/pnpm 的远端与安装副作用在临时目录内模拟。 */
function setupCall(options: {
  readonly unknownCreate?: boolean;
  readonly unknownTerminalCreate?: boolean;
  readonly orcaPreflight?: 'reachable' | 'unreachable' | 'unknown';
  readonly failInstall?: boolean;
  readonly repositoryPath?: string;
  /** 原终端状态：live 聚焦，exited 替换，unknown 不可核验。 */
  readonly terminal?: 'live' | 'exited' | 'unknown' | 'missing-state' | 'unproven-exit' | 'wrong-worktree';
  readonly terminalHandle?: string;
  readonly unknownRepoAdd?: boolean;
  readonly unregisteredPath?: boolean;
  readonly rejectTerminalCreate?: boolean;
  readonly worktreeMismatchOnShow?: number;
  readonly onCall?: (executable: string, args: readonly string[], options?: CallOptions) => void | Promise<void>;
} = {}) {
  const calls: { readonly executable: string; readonly args: readonly string[]; readonly options?: CallOptions }[] = [];
  let createCount = 0;
  let terminalCreateCount = 0;
  let registeredPath: string | null = options.unregisteredPath ? null : options.repositoryPath ?? null;
  let worktreeShowCount = 0;
  let terminalSwitchCount = 0;
  const ok = (result: unknown) => Promise.resolve(JSON.stringify({ ok: true, result }));
  const call: Call = async (executable, args, callOptions) => {
    calls.push({ executable, args, ...(callOptions === undefined ? {} : { options: callOptions }) });
    await options.onCall?.(executable, args, callOptions);
    const first = args[0];
    if (executable === 'node' && first === '--version') return 'v24.1.0\n';
    if (executable === 'pnpm' && first === '--version') return '11.10.0\n';
    if (executable === 'pnpm' && first === 'pack') {
      await writeFile(join(args[2]!, 'orca-companion-0.0.0.tgz'), 'fixture-tarball');
      return 'orca-companion-0.0.0.tgz\n';
    }
    if (executable === 'pnpm' && first === 'install') {
      if (options.failInstall) throw Object.assign(new Error('install failed'), { code: 'LAB_COMMAND_FAILED' });
      const installed = join(callOptions!.cwd!, 'node_modules', 'orca-companion');
      await mkdir(installed, { recursive: true });
      await writeFile(join(installed, 'package.json'), JSON.stringify({ name: 'orca-companion', version: '0.0.0' }));
      await writeFile(join(callOptions!.cwd!, 'pnpm-lock.yaml'), 'lockfileVersion: \'9.0\'\n');
      return '';
    }
    if (executable === 'pnpm' && first === 'exec') return '用法: ocp ...\n';
    if (executable === 'git' && first === 'config' && args.includes('--get')) {
      return args.at(-1) === 'user.email' ? 'fixture@example.invalid\n' : 'Fixture User\n';
    }
    if (executable === 'git' && first === 'var' && args[1] === 'GIT_AUTHOR_IDENT') return 'Fixture User <fixture@example.invalid> 0 +0000\n';
    if (executable === 'git' && first === 'status' && args[1] === '--porcelain' && callOptions?.cwd === setup.companionRoot) return '';
    if (executable === 'git' && first === 'rev-parse' && args[1] === 'HEAD') {
      return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: callOptions?.cwd ?? setup.companionRoot, encoding: 'utf8' });
    }
    if (executable === 'git') {
      if (first === 'push') return '';
      const invocation = first === 'commit'
        ? ['-c', 'user.name=Fixture User', '-c', 'user.email=fixture@example.invalid', ...args]
        : [...args];
      return execFileSync('git', invocation, { cwd: callOptions?.cwd ?? setup.companionRoot, encoding: 'utf8' });
    }
    if (executable === 'gh' && first === 'api' && args[1] === 'user') return JSON.stringify({ login: 'fixture-user' });
    if (executable === 'gh' && first === 'repo' && args[1] === 'create') {
      createCount += 1;
      if (options.unknownCreate) throw Object.assign(new Error('create outcome unknown'), { code: 'LAB_OPERATION_UNKNOWN' });
      return '';
    }
    if (executable === 'gh' && first === 'repo' && args[1] === 'view') {
      return JSON.stringify({ nameWithOwner: args[2], visibility: 'PRIVATE', url: `https://github.com/${args[2]}`, id: 'R_kgFixtureNodeId' });
    }
    if (executable === ORCA_EXECUTABLE) {
      if (first === 'status') {
        if (options.orcaPreflight === 'unknown') throw Object.assign(new Error('Orca status unknown'), { code: 'LAB_OPERATION_UNKNOWN' });
        return ok({ runtime: { reachable: options.orcaPreflight !== 'unreachable' } });
      }
      if (first === 'repo' && args[1] === 'add') {
        registeredPath ??= args[3]!;
        if (options.unknownRepoAdd) throw Object.assign(new Error('repo add outcome unknown'), { code: 'LAB_OPERATION_UNKNOWN' });
        return ok({ repo: { id: 'repo-fixture', path: registeredPath } });
      }
      if (first === 'repo' && args[1] === 'set-base-ref') return ok({ repo: { id: 'repo-fixture', path: registeredPath } });
      if (first === 'worktree' && args[1] === 'show') {
        worktreeShowCount += 1;
        if (args[3]!.startsWith('path:') && registeredPath === null) {
          throw Object.assign(new Error('worktree not found'), { code: 'selector_not_found' });
        }
        return ok({ worktree: { id: 'worktree-fixture', repoId: 'repo-fixture', path: options.worktreeMismatchOnShow === worktreeShowCount ? '/fixture/wrong' : registeredPath,
          branch: 'refs/heads/main', isMainWorktree: true, isBare: false } });
      }
      if (first === 'terminal' && args[1] === 'create') {
        terminalCreateCount += 1;
        if (options.unknownTerminalCreate) throw Object.assign(new Error('terminal create unknown'), { code: 'LAB_OPERATION_UNKNOWN' });
        if (options.rejectTerminalCreate) throw Object.assign(new Error('terminal create rejected'), { code: 'selector_not_found' });
        return ok({ terminal: { handle: `${options.terminalHandle ?? 'terminal-fixture'}-${terminalCreateCount}` } });
      }
      if (first === 'terminal' && args[1] === 'show') {
        if (options.terminal === 'unknown') return Promise.resolve(JSON.stringify({ ok: false, error: { code: 'terminal_handle_stale' } }));
        return ok({ terminal: { handle: args[3], worktreeId: options.terminal === 'wrong-worktree' ? 'other-worktree' : 'worktree-fixture',
          worktreePath: registeredPath,
          ...(options.terminal === 'missing-state' ? {} : { ptyId: options.terminal === 'exited' || options.terminal === 'unproven-exit' ? null : 'pty-fixture' }),
          ...(options.terminal === 'exited' ? { exitCause: { kind: 'exited', exitCode: 0 } }
            : options.terminal === 'unproven-exit' ? { exitCause: { kind: 'unknown', reason: 'cause_unreported' } } : {}) } });
      }
      if (first === 'terminal' && args[1] === 'switch') { terminalSwitchCount += 1; return ok({}); }
    }
    throw new Error(`unexpected fake command: ${executable} ${args.join(' ')}`);
  };
  return { call, calls, get createCount() { return createCount; }, get terminalCreateCount() { return terminalCreateCount; }, get terminalSwitchCount() { return terminalSwitchCount; } };
}

describe('ledger-lab setup', () => {
  it.each([
    { preflight: 'unreachable' as const, code: 'LAB_ORCA_UNAVAILABLE' },
    { preflight: 'unknown' as const, code: 'LAB_OPERATION_UNKNOWN' },
  ])('runs Orca preflight before creating external resources when status is $preflight', async ({ preflight, code }) => {
    const directory = await sandbox();
    const root = join(directory, 'runs');
    const fake = setupCall({ orcaPreflight: preflight });

    await expect(setup.prepareLab({ root }, { env: { HOME: '/fixture', PATH: '/bin' }, orca: ORCA_EXECUTABLE, call: fake.call }))
      .rejects.toMatchObject({ code });
    expect(fake.createCount).toBe(0);
    await expect(readdir(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['main', 'cancel'] as const)('prepares a private external %s lab with an Orca terminal and no models or doctor', async (profile) => {
    const directory = await sandbox();
    const root = join(directory, 'existing-runs-root');
    const fake = setupCall();
    const progress: string[] = [];
    const result = await setup.prepareLab({ profile, root }, {
      env: { HOME: '/fixture-home', PATH: '/fixture-bin', GH_TOKEN: 'secret-gh-token', GH_REPO: 'attacker/repo', ORCA_HOST: 'attacker-host' },
      orca: ORCA_EXECUTABLE,
      call: fake.call,
      progress: (stage) => progress.push(stage),
    });

    expect(await readdir(root)).toContain(result.id);
    expect(result).toMatchObject({ profile, state: 'ready', stage: 'ready', branch: 'refs/heads/main',
      orca: { executable: ORCA_EXECUTABLE, repoId: 'repo-fixture', worktreeId: 'worktree-fixture', terminalHandle: 'terminal-fixture-1' },
      github: { host: 'github.com', nameWithOwner: `fixture-user/${result.id}`, url: `https://github.com/fixture-user/${result.id}`, nodeId: 'R_kgFixtureNodeId' } });
    expect(result.repositoryPath).toBe(join(result.directory, 'repo'));
    expect(result.installation?.packagePath).toBe(join(result.directory, 'packages', 'orca-companion-0.0.0.tgz'));
    expect(result.startup).toMatchObject({ cwd: result.repositoryPath, command: 'ocp', debugCommand: 'ocp --debug' });
    expect(fake.calls.some(({ executable, args, options }) => executable === 'pnpm' && args[0] === 'install' && options?.timeoutMs === 600000)).toBe(true);
    expect(await setup.readRun(result.directory)).not.toHaveProperty('startup');
    expect(await setup.readRun(result.directory)).toMatchObject({ id: result.id, state: 'ready', orca: result.orca });
    expect(progress).toContain('ready');
    expect(fake.calls.some(({ executable, args }) => executable === 'gh' && args[0] === 'repo' && args[1] === 'create' && args.includes('--private'))).toBe(true);
    // 登记、base ref 与主 checkout 核验都走公开命令，终端只补本轮 PATH 与 ORCA_CLI_COMMAND。
    expect(fake.calls.some(({ executable, args }) => executable === ORCA_EXECUTABLE && args[0] === 'status')).toBe(true);
    expect(fake.calls.findIndex(({ executable, args }) => executable === ORCA_EXECUTABLE && args[0] === 'status'))
      .toBeLessThan(fake.calls.findIndex(({ executable, args }) => executable === 'gh' && args[0] === 'repo' && args[1] === 'create'));
    expect(fake.calls.some(({ executable, args }) => executable === ORCA_EXECUTABLE && args.join(' ') === `repo add --path ${result.repositoryPath} --json`)).toBe(true);
    expect(fake.calls.some(({ args }) => args.join(' ').includes('repo set-base-ref --repo id:repo-fixture --ref origin/main'))).toBe(true);
    expect(fake.calls.some(({ args }) => args.join(' ').includes(`worktree show --worktree path:${result.repositoryPath}`))).toBe(true);
    const created = fake.calls.find(({ args }) => args[0] === 'terminal' && args[1] === 'create');
    expect(created?.args.join(' ')).toContain('--worktree id:worktree-fixture --title');
    expect(created?.args.join(' ')).toContain(`--focus`);
    // --command 只被键入原生 shell：仓库内 bin 前置 PATH，并固定本轮选定的 Orca 可执行文件。
    expect(created?.args[created.args.indexOf('--command') + 1]).toBe(
      `export PATH='${join(result.repositoryPath, 'node_modules', '.bin')}':"$PATH"; export ORCA_CLI_COMMAND='${ORCA_EXECUTABLE}'`);
    expect(fake.calls.some(({ args }) => args.includes('dist/src/bootstrap/ledger-lab.js'))).toBe(false);
    expect(fake.calls.some(({ args }) => args.includes('doctor'))).toBe(false);
    expect(fake.calls.some(({ args }) => args.includes('route-map'))).toBe(false);
    expect(fake.calls.some(({ executable, args }) => executable === 'pnpm' && args[0] === 'pack')).toBe(true);
    expect(fake.calls.some(({ executable, args }) => executable === 'pnpm' && args[0] === 'exec' && args[1] === 'ocp')).toBe(true);
    expect(fake.calls.some(({ executable, args }) => executable === 'git' && args[0] === 'push')).toBe(true);

    expect(await readdir(result.directory)).toEqual(expect.arrayContaining(['repo', 'operator', 'captures', 'checks', 'packages', 'run.json']));
    expect(await readdir(result.directory)).not.toContain('bin');
    expect(await readdir(result.repositoryPath)).toEqual(expect.arrayContaining(['README.md', '.gitignore', 'openspec', 'package.json', 'pnpm-lock.yaml', '.git']));
    expect(await readdir(result.repositoryPath)).not.toContain('src');
    expect(await readdir(result.repositoryPath)).not.toContain('orca-companion.json');
    expect(JSON.parse(await readFile(join(result.repositoryPath, 'package.json'), 'utf8'))).toMatchObject({
      devDependencies: { 'orca-companion': 'file:../packages/orca-companion-0.0.0.tgz' },
    });
    // pnpm 11 未放行依赖 build script 会让安装直接失败；演练仓库必须带同一份放行配置。
    expect(await readFile(join(result.repositoryPath, 'pnpm-workspace.yaml'), 'utf8')).toBe('allowBuilds:\n  better-sqlite3: true\n');
    expect(await readFile(join(result.repositoryPath, 'README.md'), 'utf8')).not.toContain('nativeSQLite');
    expect(await readFile(join(result.directory, 'operator', 'guide.md'), 'utf8')).toContain('ledger-lab');
    expect(await readFile(join(result.directory, 'run.json'), 'utf8')).not.toContain('secret-gh-token');
  });

  it('persists the registration stage and exact binding before later Orca mutations', async () => {
    const root = join(await sandbox(), 'runs');
    let directory = '';
    const beforeMutation: { command: string; record: Record<string, unknown> }[] = [];
    const fake = setupCall({ onCall: async (executable, args) => {
      if (executable === ORCA_EXECUTABLE && args[0] === 'repo' && args[1] === 'add') directory = dirname(args[3]!);
      if (executable === ORCA_EXECUTABLE && ((args[0] === 'repo' && args[1] === 'add') ||
          (args[0] === 'terminal' && args[1] === 'create'))) {
        beforeMutation.push({ command: `${args[0]} ${args[1]}`, record: await readRunFile(join(directory, 'run.json')) });
      }
    } });

    await setup.prepareLab({ root }, { env: { HOME: '/fixture', PATH: '/bin' }, orca: ORCA_EXECUTABLE, call: fake.call });
    expect(beforeMutation).toMatchObject([
      { command: 'repo add', record: { stage: 'orca-registration', orca: null } },
      { command: 'terminal create', record: { stage: 'orca-terminal', failureCode: 'LAB_OPERATION_UNKNOWN',
        orca: { executable: ORCA_EXECUTABLE, repoId: 'repo-fixture', worktreeId: 'worktree-fixture' } } },
    ]);
  });

  it('reconciles an unknown repo add by exact worktree path before any explicit retry', async () => {
    const root = join(await sandbox(), 'runs');
    await expect(setup.prepareLab({ root }, { env: { HOME: '/fixture', PATH: '/bin' }, orca: ORCA_EXECUTABLE,
      call: setupCall({ unknownRepoAdd: true }).call })).rejects.toMatchObject({ code: 'LAB_OPERATION_UNKNOWN' });
    const [id] = await readdir(root);
    const record = await setup.readRun(join(root, id!));
    expect(record).toMatchObject({ stage: 'orca-registration', orca: null });
    const retry = setupCall({ repositoryPath: record.repositoryPath });

    const opened = await setup.openLab({ run: record.directory }, { env: { HOME: '/fixture', PATH: '/bin' }, orca: ORCA_EXECUTABLE,
      call: openCall(record, retry.call).call });
    expect(retry.calls.some(({ executable, args }) => executable === ORCA_EXECUTABLE && args[0] === 'repo' && args[1] === 'add')).toBe(false);
    expect(opened.orca).toMatchObject({ repoId: 'repo-fixture', worktreeId: 'worktree-fixture' });
  });

  it('does not repeat an unknown repo add when the record already has a partial binding', async () => {
    const root = join(await sandbox(), 'runs');
    const partial = setupCall({ unknownRepoAdd: true });
    await expect(setup.prepareLab({ root }, { env: { HOME: '/fixture', PATH: '/bin' }, orca: ORCA_EXECUTABLE, call: partial.call }))
      .rejects.toMatchObject({ code: 'LAB_OPERATION_UNKNOWN' });
    const [id] = await readdir(root);
    const record = await setup.readRun(join(root, id!));
    const raw = await readRunFile<Record<string, unknown>>(join(record.directory, 'run.json'));
    await writeFile(join(record.directory, 'run.json'), JSON.stringify({ ...raw,
      orca: { executable: ORCA_EXECUTABLE, repoId: 'repo-fixture', worktreeId: null } }));
    const retry = setupCall({ repositoryPath: record.repositoryPath });

    await setup.openLab({ run: record.directory }, { env: { HOME: '/fixture', PATH: '/bin' }, orca: ORCA_EXECUTABLE,
      call: openCall(record, retry.call).call });
    expect(retry.calls.some(({ executable, args }) => executable === ORCA_EXECUTABLE && args[0] === 'repo' && args[1] === 'add')).toBe(false);
  });

  it('keeps an unknown registration unresolved when the original worktree cannot be found', async () => {
    const root = join(await sandbox(), 'runs');
    await expect(setup.prepareLab({ root }, { env: { HOME: '/fixture', PATH: '/bin' }, orca: ORCA_EXECUTABLE,
      call: setupCall({ unknownRepoAdd: true }).call })).rejects.toMatchObject({ code: 'LAB_OPERATION_UNKNOWN' });
    const [id] = await readdir(root);
    const record = await setup.readRun(join(root, id!));
    const retry = setupCall({ unregisteredPath: true });
    await expect(setup.openLab({ run: record.directory }, { env: { HOME: '/fixture', PATH: '/bin' }, orca: ORCA_EXECUTABLE,
      call: openCall(record, retry.call).call })).rejects.toMatchObject({ code: 'LAB_OPERATION_UNKNOWN' });
    expect(retry.calls.some(({ args }) => args[0] === 'repo' && args[1] === 'add')).toBe(false);
    expect(retry.terminalCreateCount).toBe(0);
  });

  it('allocates a distinct run directory each time under an existing output root', async () => {
    const root = join(await sandbox(), 'runs');
    const dependencies = { env: { HOME: '/fixture', PATH: '/bin' }, orca: ORCA_EXECUTABLE };
    const first = await setup.prepareLab({ root }, { ...dependencies, call: setupCall().call });
    const second = await setup.prepareLab({ root }, { ...dependencies, call: setupCall().call });
    expect(first.id).not.toBe(second.id);
    expect(first.directory).not.toBe(second.directory);
    expect(first.directory.startsWith(root)).toBe(true);
    expect(second.directory.startsWith(root)).toBe(true);
  });

  it('refuses output inside the Companion repository before creating a GitHub repository', async () => {
    const fake = setupCall();
    await expect(setup.prepareLab({ root: join(setup.companionRoot, 'artifacts', 'ledger-lab', '.test-output') }, {
      env: { HOME: '/fixture', PATH: '/bin' }, orca: ORCA_EXECUTABLE, call: fake.call,
    })).rejects.toThrow('Companion 仓库之外');
    expect(fake.createCount).toBe(0);
  });

  it('preserves an unknown GitHub create outcome without retrying or cleaning the run', async () => {
    const root = join(await sandbox(), 'runs');
    const fake = setupCall({ unknownCreate: true });
    await expect(setup.prepareLab({ root }, { env: { HOME: '/fixture', PATH: '/bin' }, orca: ORCA_EXECUTABLE, call: fake.call }))
      .rejects.toMatchObject({ code: 'LAB_OPERATION_UNKNOWN' });

    expect(fake.createCount).toBe(1);
    const [id] = await readdir(root);
    const record = await readRunFile<RunRecord>(join(root, id!, 'run.json'));
    expect(record).toMatchObject({ state: 'failed', stage: 'github-repository', installation: null, orca: null });
    expect(record.github.nameWithOwner).toMatch(/^fixture-user\/ledger-lab-/u);
    expect(record.github.nodeId).toBeNull();
    expect(record.installation).toBeNull();
    expect(await readdir(join(root, id!))).toContain('repo');
    const listed = await setup.listRuns(root);
    expect(listed.runs).toEqual([expect.objectContaining({ id: record.id, state: 'failed' })]);
  });

  it('retains the failed run and avoids GitHub create when cancellation arrives at a stage boundary', async () => {
    const root = join(await sandbox(), 'runs');
    const controller = new AbortController();
    const fake = setupCall();
    await expect(setup.prepareLab({ root }, {
      env: { HOME: '/fixture', PATH: '/bin' }, orca: ORCA_EXECUTABLE, call: fake.call,
      signal: controller.signal,
      progress: (stage) => { if (stage === 'github-repository') controller.abort(); },
    })).rejects.toMatchObject({ code: 'LAB_PREPARE_CANCELLED' });
    expect(fake.createCount).toBe(0);
    const [id] = await readdir(root);
    const record = JSON.parse(await readFile(join(root, id!, 'run.json'), 'utf8')) as Record<string, unknown>;
    expect(record).toMatchObject({ state: 'failed', stage: 'github-repository', failureCode: 'LAB_PREPARE_CANCELLED' });
  });

  it('keeps the failed stage and installation provenance when the repository-local install fails', async () => {
    const root = join(await sandbox(), 'runs');
    const fake = setupCall({ failInstall: true });
    await expect(setup.prepareLab({ root }, { env: { HOME: '/fixture', PATH: '/bin' }, orca: ORCA_EXECUTABLE, call: fake.call }))
      .rejects.toMatchObject({ code: 'LAB_COMMAND_FAILED' });
    const [id] = await readdir(root);
    const record = JSON.parse(await readFile(join(root, id!, 'run.json'), 'utf8')) as RunRecord;
    expect(record).toMatchObject({ state: 'failed', stage: 'installation' });
    expect(record.github.nodeId).toBe('R_kgFixtureNodeId');
    expect(record.installation?.packagePath).toBe(join(root, id!, 'packages', 'orca-companion-0.0.0.tgz'));
    expect(await readdir(join(root, id!))).toEqual(expect.arrayContaining(['repo', 'packages', 'run.json']));
  });

  it('reads the record and lists the round after the local repository is deleted', async () => {
    const root = join(await sandbox(), 'runs');
    const prepared = await setup.prepareLab({ root }, { env: { HOME: '/fixture', PATH: '/bin' }, orca: ORCA_EXECUTABLE, call: setupCall().call });
    await rm(prepared.repositoryPath, { recursive: true, force: true });
    const record = await setup.readRun(prepared.directory);
    expect(record).toMatchObject({ id: prepared.id, repositoryPath: prepared.repositoryPath, state: 'ready' });
    expect(await setup.listRuns(root)).toMatchObject({ truncated: false, runs: [expect.objectContaining({ id: prepared.id })] });
    await expect(setup.openLab({ run: prepared.directory }, { env: { HOME: '/fixture', PATH: '/bin' }, call: setupCall().call })).rejects.toThrow();
  });

  it('rejects a replaced local directory before reading its Git identity', async () => {
    const root = join(await sandbox(), 'runs');
    const prepared = await setup.prepareLab({ root }, { env: { HOME: '/fixture', PATH: '/bin' }, orca: ORCA_EXECUTABLE, call: setupCall().call });
    await rm(prepared.repositoryPath, { recursive: true, force: true });
    await mkdir(prepared.repositoryPath);
    let gitCalled = false;
    const call: Call = (executable) => {
      if (executable === 'git') gitCalled = true;
      return Promise.resolve('');
    };
    await expect(setup.openLab({ run: prepared.directory }, { env: { HOME: '/fixture', PATH: '/bin' }, call }))
      .rejects.toMatchObject({ code: 'LAB_IDENTITY_MISMATCH' });
    expect(gitCalled).toBe(false);
  });

  it('verifies an explicit scope against this round before binding Orca', async () => {
    const root = join(await sandbox(), 'runs');
    const prepared = await setup.prepareLab({ root }, { env: { HOME: '/fixture', PATH: '/bin' }, orca: ORCA_EXECUTABLE, call: setupCall().call });
    const record = { ...prepared, schemaVersion: 2 } as RunRecord;
    const orcaCalls: string[] = [];
    const call: Call = (executable, args) => {
      orcaCalls.push(`${executable} ${args.join(' ')}`);
      return Promise.resolve(JSON.stringify({ ok: true, result: { worktree: { id: 'worktree-fixture', repoId: 'repo-fixture',
        path: prepared.repositoryPath, branch: prepared.branch, isMainWorktree: true, isBare: false } } }));
    };
    await expect(setup.verifyScopeForRun(record, 'scope-other', { env: { HOME: '/fixture', PATH: '/bin' }, call })).rejects.toThrow(/Scope/u);
    expect(orcaCalls.some((command) => command.includes('worktree show'))).toBe(false);
  });

  it('checks the original Git identity before returning startup instructions', async () => {
    const root = join(await sandbox(), 'runs');
    const prepared = await setup.prepareLab({ root }, { env: { HOME: '/fixture', PATH: '/bin' }, orca: ORCA_EXECUTABLE, call: setupCall().call });
    const terminalCalls: string[] = [];
    const call: Call = (executable, args) => {
      if (executable === 'git' && args[0] === 'symbolic-ref') return Promise.resolve('refs/heads/wrong\n');
      if (executable.endsWith('/orca')) { terminalCalls.push(args.join(' ')); return Promise.resolve(''); }
      return Promise.resolve('');
    };
    await expect(setup.openLab({ run: prepared.directory }, { env: { HOME: '/fixture', PATH: '/bin' }, call })).rejects.toThrow('Git canonical 身份不符');
    expect(terminalCalls).toEqual([]);
  });

  /** open 先证明原 canonical Git 身份，其余命令交给合成 transport。 */
  function openCall(prepared: RunRecord, transport: Call) {
    const gitDir = join(prepared.repositoryPath, '.git');
    const commands: string[] = [];
    const call: Call = async (executable, args, options) => {
      commands.push(`${executable} ${args.join(' ')}`);
      if (executable === 'git' && args[0] === 'symbolic-ref') return `${prepared.branch}\n`;
      if (executable === 'git' && args[0] === 'rev-parse' && args[1] !== 'HEAD') return args[1] === '--show-toplevel' ? `${prepared.repositoryPath}\n` : `${gitDir}\n`;
      if (executable === 'git' && args[0] === 'remote') return `https://github.com/${prepared.github.nameWithOwner}.git\n`;
      return transport(executable, args, options);
    };
    return { call, commands };
  }

  it('focuses the recorded terminal and returns the bare startup command', async () => {
    const root = join(await sandbox(), 'runs');
    const prepared = await setup.prepareLab({ root }, { env: { HOME: '/fixture', PATH: '/bin' }, orca: ORCA_EXECUTABLE, call: setupCall().call });
    const fake = setupCall({ repositoryPath: prepared.repositoryPath, terminal: 'live' });
    const { call, commands } = openCall(prepared, fake.call);
    const opened = await setup.openLab({ run: prepared.directory }, { env: { HOME: '/fixture', PATH: '/bin' }, orca: '/fixture/bin/other-orca', call });

    expect(opened.terminalHandle).toBe('terminal-fixture-1');
    expect(opened.startup?.command).toBe('ocp');
    expect(opened.startup?.cwd).toBe(prepared.repositoryPath);
    expect(commands.some((command) => command.includes('remote get-url origin'))).toBe(true);
    expect(commands.some((command) => command.includes('worktree show --worktree id:worktree-fixture'))).toBe(true);
    expect(commands.some((command) => command.includes('terminal switch --terminal terminal-fixture-1'))).toBe(true);
    expect(fake.terminalCreateCount).toBe(0);
    expect(await setup.readRun(prepared.directory)).toMatchObject({ orca: prepared.orca });
  });

  it('replaces the recorded terminal only after Orca reports it exited', async () => {
    const root = join(await sandbox(), 'runs');
    const prepared = await setup.prepareLab({ root }, { env: { HOME: '/fixture', PATH: '/bin' }, orca: ORCA_EXECUTABLE, call: setupCall().call });
    const fake = setupCall({ repositoryPath: prepared.repositoryPath, terminal: 'exited', terminalHandle: 'terminal-reopened' });
    const opened = await setup.openLab({ run: prepared.directory }, { env: { HOME: '/fixture', PATH: '/bin' }, call: openCall(prepared, fake.call).call });

    expect(fake.terminalCreateCount).toBe(1);
    expect(opened.orca).toMatchObject({ repoId: 'repo-fixture', worktreeId: 'worktree-fixture', terminalHandle: 'terminal-reopened-1' });
    expect((await setup.readRun(prepared.directory)).orca?.terminalHandle).toBe('terminal-reopened-1');
  });

  it('stops without creating a terminal when the recorded one cannot be verified', async () => {
    const root = join(await sandbox(), 'runs');
    const prepared = await setup.prepareLab({ root }, { env: { HOME: '/fixture', PATH: '/bin' }, orca: ORCA_EXECUTABLE, call: setupCall().call });
    const fake = setupCall({ repositoryPath: prepared.repositoryPath, terminal: 'unknown' });
    await expect(setup.openLab({ run: prepared.directory }, { env: { HOME: '/fixture', PATH: '/bin' }, call: openCall(prepared, fake.call).call }))
      .rejects.toMatchObject({ code: 'LAB_TERMINAL_UNVERIFIABLE' });

    expect(fake.terminalCreateCount).toBe(0);
    expect((await setup.readRun(prepared.directory)).orca?.terminalHandle).toBe('terminal-fixture-1');
  });

  it('does not create another terminal after the original create outcome is unknown, even if the row looks ready', async () => {
    const root = join(await sandbox(), 'runs');
    const initial = setupCall({ unknownTerminalCreate: true });
    await expect(setup.prepareLab({ root }, { env: { HOME: '/fixture', PATH: '/bin' }, orca: ORCA_EXECUTABLE, call: initial.call }))
      .rejects.toMatchObject({ code: 'LAB_OPERATION_UNKNOWN' });
    const [id] = await readdir(root);
    const record = await setup.readRun(join(root, id!));
    const persisted = await readRunFile<Record<string, unknown>>(join(record.directory, 'run.json'));
    await writeFile(join(record.directory, 'run.json'), JSON.stringify({ ...persisted, state: 'ready' }));
    const retry = setupCall({ repositoryPath: record.repositoryPath });

    await expect(setup.openLab({ run: record.directory }, {
      env: { HOME: '/fixture', PATH: '/bin' }, call: openCall(record, retry.call).call,
    })).rejects.toMatchObject({ code: 'LAB_TERMINAL_UNVERIFIABLE' });
    expect(retry.terminalCreateCount).toBe(0);
  });

  it.each(['missing-state', 'unproven-exit', 'wrong-worktree'] as const)(
    'does not switch or recreate a terminal with %s evidence', async (terminal) => {
      const root = join(await sandbox(), 'runs');
      const prepared = await setup.prepareLab({ root }, { env: { HOME: '/fixture', PATH: '/bin' }, orca: ORCA_EXECUTABLE, call: setupCall().call });
      const fake = setupCall({ repositoryPath: prepared.repositoryPath, terminal });

      await expect(setup.openLab({ run: prepared.directory }, {
        env: { HOME: '/fixture', PATH: '/bin' }, call: openCall(prepared, fake.call).call,
      })).rejects.toMatchObject({ code: 'LAB_TERMINAL_UNVERIFIABLE' });
      expect(fake.terminalSwitchCount).toBe(0);
      expect(fake.terminalCreateCount).toBe(0);
    },
  );

  it('rechecks the canonical worktree after proving the terminal PTY is live and before switching', async () => {
    const root = join(await sandbox(), 'runs');
    const prepared = await setup.prepareLab({ root }, { env: { HOME: '/fixture', PATH: '/bin' }, orca: ORCA_EXECUTABLE, call: setupCall().call });
    const fake = setupCall({ repositoryPath: prepared.repositoryPath, terminal: 'live', worktreeMismatchOnShow: 2 });

    await expect(setup.openLab({ run: prepared.directory }, {
      env: { HOME: '/fixture', PATH: '/bin' }, call: openCall(prepared, fake.call).call,
    })).rejects.toThrow('Orca canonical 工作区身份不符');
    expect(fake.terminalSwitchCount).toBe(0);
  });

  it('allows an explicit retry after Orca returned a known terminal-create rejection', async () => {
    const root = join(await sandbox(), 'runs');
    const prepared = await setup.prepareLab({ root }, { env: { HOME: '/fixture', PATH: '/bin' }, orca: ORCA_EXECUTABLE, call: setupCall().call });
    const rejected = setupCall({ repositoryPath: prepared.repositoryPath, terminal: 'exited', rejectTerminalCreate: true });
    await expect(setup.openLab({ run: prepared.directory }, {
      env: { HOME: '/fixture', PATH: '/bin' }, call: openCall(prepared, rejected.call).call,
    })).rejects.toMatchObject({ code: 'selector_not_found' });
    expect(await setup.readRun(prepared.directory)).toMatchObject({ stage: 'orca-terminal', failureCode: 'selector_not_found' });

    const retry = setupCall({ repositoryPath: prepared.repositoryPath, terminal: 'exited', terminalHandle: 'retried-terminal' });
    const opened = await setup.openLab({ run: prepared.directory }, {
      env: { HOME: '/fixture', PATH: '/bin' }, call: openCall(prepared, retry.call).call,
    });
    expect(opened.orca?.terminalHandle).toBe('retried-terminal-1');
    expect(await setup.readRun(prepared.directory)).toMatchObject({ state: 'ready', stage: 'ready' });
  });

  it('uses the canonical path to verify an older schema 2 binding without a worktree id', async () => {
    const root = join(await sandbox(), 'runs');
    const prepared = await setup.prepareLab({ root }, { env: { HOME: '/fixture', PATH: '/bin' }, orca: ORCA_EXECUTABLE, call: setupCall().call });
    const raw = await readRunFile<RunRecord & { orca: NonNullable<RunRecord['orca']> }>(join(prepared.directory, 'run.json'));
    const oldOrca = { ...raw.orca, worktreeId: null };
    delete oldOrca.terminalHandle;
    const oldRecord = { ...raw, orca: oldOrca };
    await writeFile(join(prepared.directory, 'run.json'), JSON.stringify(oldRecord));
    const fake = setupCall({ repositoryPath: prepared.repositoryPath });
    const { call, commands } = openCall(prepared, fake.call);

    const opened = await setup.openLab({ run: prepared.directory }, { env: { HOME: '/fixture', PATH: '/bin' }, call });
    expect(commands.some((command) => command.includes(`worktree show --worktree path:${prepared.repositoryPath}`))).toBe(true);
    expect((await setup.readRun(prepared.directory)).orca?.terminalHandle).toBe(opened.orca?.terminalHandle);
  });

  it('registers an old schema 2 round without an Orca binding on explicit open', async () => {
    const root = join(await sandbox(), 'runs');
    const prepared = await setup.prepareLab({ root }, { env: { HOME: '/fixture', PATH: '/bin' }, orca: ORCA_EXECUTABLE, call: setupCall().call });
    const file = join(prepared.directory, 'run.json');
    await writeFile(file, JSON.stringify({ ...(await readRunFile<RunRecord>(file)), orca: null }));
    const fake = setupCall({ unregisteredPath: true });
    const opened = await setup.openLab({ run: prepared.directory }, { env: { HOME: '/fixture', PATH: '/bin' }, orca: ORCA_EXECUTABLE, call: openCall(prepared, fake.call).call });

    expect(fake.calls.some(({ args }) => args.join(' ').includes(`repo add --path ${prepared.repositoryPath}`))).toBe(true);
    expect(fake.calls.some(({ args }) => args.join(' ').includes('repo set-base-ref --repo id:repo-fixture --ref origin/main'))).toBe(true);
    expect(opened.orca).toMatchObject({ executable: ORCA_EXECUTABLE, repoId: 'repo-fixture', worktreeId: 'worktree-fixture', terminalHandle: 'terminal-fixture-1' });
    expect((await setup.readRun(prepared.directory)).orca).toEqual(opened.orca);
  });

  it('keeps the terminal handle when collect rebinds the recorded Orca identity', async () => {
    const root = join(await sandbox(), 'runs');
    const prepared = await setup.prepareLab({ root }, { env: { HOME: '/fixture', PATH: '/bin' }, orca: ORCA_EXECUTABLE, call: setupCall().call });
    const fake = setupCall({ repositoryPath: prepared.repositoryPath });
    const bound = await setup.bindOrcaForRun(prepared, { env: { HOME: '/fixture', PATH: '/bin' }, orca: '/fixture/bin/other-orca', call: fake.call });
    expect(bound.orca).toEqual(prepared.orca);
  });

  it('keeps the legacy schema 1 open contract on the original Orca terminal entry', async () => {
    const root = join(await sandbox(), 'runs');
    const legacyRoot = join(await sandbox(), 'legacy-runs');
    const repositoryPath = join(legacyRoot, 'ledger-lab-main-legacy', 'repo');
    await mkdir(join(repositoryPath, 'bin'), { recursive: true });
    await mkdir(join(legacyRoot, 'ledger-lab-main-legacy', 'captures'), { recursive: true });
    await mkdir(join(legacyRoot, 'ledger-lab-main-legacy', 'checks'), { recursive: true });
    await mkdir(join(legacyRoot, 'ledger-lab-main-legacy', 'operator'), { recursive: true });
    const directory = join(legacyRoot, 'ledger-lab-main-legacy');
    await writeFile(join(directory, 'run.json'), JSON.stringify({ schemaVersion: 1, kind: 'ledger-lab-run', id: 'ledger-lab-main-legacy',
      profile: 'main', repositoryPath, branch: 'refs/heads/main', companionRoot: setup.companionRoot, orcaExecutable: ORCA_EXECUTABLE,
      githubRepository: 'fixture-user/ledger-lab-main-legacy', routeMapIssueNumber: 17, orcaRepoId: 'repo-fixture', worktreeId: 'worktree-fixture',
      terminalHandle: 'terminal-fixture', sourceHead: 'a'.repeat(40), sourceDirty: false, baselineHead: null,
      state: 'ready', stage: 'ready', createdAt: '2026-10-01T00:00:00.000Z' }));
    const gitDir = join(repositoryPath, '.git');
    const commands: string[] = [];
    const call: Call = (executable, args) => {
      commands.push(`${executable} ${args.join(' ')}`);
      if (executable === 'git' && args[0] === 'symbolic-ref') return Promise.resolve('refs/heads/main\n');
      if (executable === 'git' && args[0] === 'rev-parse' && args[1] === '--path-format=absolute') return Promise.resolve(`${gitDir}\n`);
      if (executable === 'git' && args[0] === 'rev-parse' && args[1] === '--absolute-git-dir') return Promise.resolve(`${gitDir}\n`);
      if (executable === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') return Promise.resolve(`${repositoryPath}\n`);
      if (executable === 'git' && args[0] === 'remote') return Promise.resolve('https://github.com/fixture-user/ledger-lab-main-legacy.git\n');
      if (executable.endsWith('/orca') && args[0] === 'worktree') return Promise.resolve(JSON.stringify({ ok: true, result: { worktree: {
        id: 'worktree-fixture', repoId: 'repo-fixture', path: repositoryPath, branch: 'refs/heads/main', isMainWorktree: true, isBare: false } } }));
      if (executable.endsWith('/orca') && args[0] === 'terminal') return Promise.resolve(JSON.stringify({ ok: true, result: { terminal: { handle: 'terminal-reopened' } } }));
      throw new Error(`unexpected legacy open command ${executable} ${args.join(' ')}`);
    };
    const opened = await setup.openLab({ run: directory }, { env: { HOME: '/fixture', PATH: '/bin' }, call });
    expect(opened.terminalHandle).toBe('terminal-reopened');
    expect(commands.some((command) => command.startsWith(`${ORCA_EXECUTABLE} worktree show`))).toBe(true);
    void root;
  });

  it('binds empty operator templates once, preserves matching data, and rejects another scope', async () => {
    const directory = await sandbox();
    const operator = join(directory, 'operator');
    await mkdir(operator);
    const record = { directory };
    const mappingPath = join(operator, 'mapping.json');
    const observationsPath = join(operator, 'observations.json');
    await writeFile(mappingPath, JSON.stringify({ schemaVersion: 1, coordinationScopeId: '', graphs: [] }));
    await writeFile(observationsPath, JSON.stringify({ schemaVersion: 1, coordinationScopeId: '', entries: [] }));

    await setup.bindOperatorFiles(record, 'scope-alpha');
    const mapping = JSON.parse(await readFile(mappingPath, 'utf8')) as { coordinationScopeId: string; graphs: unknown[] };
    const observations = JSON.parse(await readFile(observationsPath, 'utf8')) as { coordinationScopeId: string; entries: unknown[] };
    expect(mapping).toEqual({ schemaVersion: 1, coordinationScopeId: 'scope-alpha', graphs: [] });
    expect(observations).toEqual({ schemaVersion: 1, coordinationScopeId: 'scope-alpha', entries: [] });

    const populated = { ...mapping, graphs: [{ graphId: 'graph-kept' }] };
    await writeFile(mappingPath, JSON.stringify(populated));
    await setup.bindOperatorFiles(record, 'scope-alpha');
    expect(JSON.parse(await readFile(mappingPath, 'utf8'))).toEqual(populated);
    await expect(setup.bindOperatorFiles(record, 'scope-beta')).rejects.toThrow('尚未绑定本轮 Scope');
    expect(JSON.parse(await readFile(mappingPath, 'utf8'))).toEqual(populated);
  });

  it('resolves verify-result --run defaults to the run repository and writes checks outside it', async () => {
    const root = join(await sandbox(), 'runs');
    const prepared = await setup.prepareLab({ root }, { env: { HOME: '/fixture', PATH: '/bin' }, orca: ORCA_EXECUTABLE, call: setupCall().call });
    const code = await lab.main(['verify-result', '--run', prepared.directory]);
    expect(code).toBe(3);
    const reports = await readdir(join(prepared.directory, 'checks'));
    expect(reports).toHaveLength(1);
    const reportPath = join(prepared.directory, 'checks', reports[0]!);
    expect(reportPath.startsWith(prepared.repositoryPath)).toBe(false);
    expect(JSON.parse(await readFile(reportPath, 'utf8'))).toMatchObject({ kind: 'result-report', repositoryPath: prepared.repositoryPath });
  });

  it('rejects --run collection before a canonical Scope exists', async () => {
    const root = join(await sandbox(), 'runs');
    const prepared = await setup.prepareLab({ root }, { env: { HOME: '/fixture', PATH: '/bin' }, orca: ORCA_EXECUTABLE, call: setupCall().call });
    await expect(lab.main(['collect', '--run', prepared.directory])).rejects.toThrow(/Scope|scope/u);
    expect(await readdir(join(prepared.directory, 'captures'))).toEqual([]);
  });

  it('passes a sanitized environment to the process runner and keeps GH_HOST for GitHub calls', async () => {
    const requests: { readonly env: Readonly<Record<string, string>>; readonly args: readonly string[] }[] = [];
    const call = await setup.createCommandRunner({ env: setup.cleanEnvironment({ GH_TOKEN: 'memory-token', GH_REPO: 'untrusted/repo', GH_HOST: 'github.com', ORCA_HOST: 'untrusted', SAFE: 'kept' }),
      runner: (request) => {
        requests.push({ env: request.env, args: request.args });
        return Promise.resolve({ kind: 'completed', exitCode: 0, stdout: { text: 'ok', truncated: false }, stderr: { text: '', truncated: false } });
      } });
    expect(await call('git', ['status'])).toBe('ok');
    expect(requests[0]?.env).toMatchObject({ GH_TOKEN: 'memory-token', GH_HOST: 'github.com', SAFE: 'kept' });
    expect(requests[0]?.env).not.toHaveProperty('GH_REPO');
    expect(requests[0]?.env).not.toHaveProperty('ORCA_HOST');
    expect(JSON.stringify(requests.map(({ args }) => args))).not.toContain('memory-token');
    expect(setup.shellQuote("space $() and ' quote")).toBe("'space $() and '" + '"' + "'" + '"' + "' quote'");

    const failing = await setup.createCommandRunner({ env: {}, runner: () => Promise.resolve({ kind: 'completed', exitCode: 1,
      stdout: { text: '', truncated: false }, stderr: { text: JSON.stringify({ ok: false, error: { code: 'selector_not_found', message: 'x' } }), truncated: false } }) });
    await expect(failing('/fixture/bin/orca', ['worktree', 'show'])).rejects.toMatchObject({ code: 'selector_not_found' });
  });

  it('attaches a parsed GraphQL payload only on a determined failure, never on an unknown outcome', async () => {
    const envelope = JSON.stringify({ data: { repository: null, viewer: { repository: { id: 'R_kgFixtureNodeId' } } }, errors: [{ type: 'NOT_FOUND' }] });
    const determined = await setup.createCommandRunner({ env: {}, runner: () => Promise.resolve({ kind: 'completed', exitCode: 1,
      stdout: { text: envelope, truncated: false }, stderr: { text: '', truncated: false } }) });
    await expect(determined('gh', ['api', 'graphql', '--input', 'payload.json'])).rejects.toMatchObject({
      code: 'LAB_COMMAND_FAILED', response: { data: { repository: null } },
    });
    const timedOut = await setup.createCommandRunner({ env: {}, runner: () => Promise.resolve({ kind: 'unknown', reason: 'timeout',
      stdout: { text: envelope, truncated: false }, stderr: { text: '', truncated: false } }) });
    await expect(timedOut('gh', ['api', 'graphql', '--input', 'payload.json'])).rejects.toMatchObject({ code: 'LAB_OPERATION_UNKNOWN' });
    await expect(timedOut('gh', ['api', 'graphql', '--input', 'payload.json']).catch((error: unknown) => error)).resolves.not.toHaveProperty('response');

    const truncated = await setup.createCommandRunner({ env: {}, runner: () => Promise.resolve({ kind: 'completed', exitCode: 1,
      stdout: { text: envelope, truncated: true }, stderr: { text: '', truncated: false } }) });
    const outcome = await truncated('gh', ['api', 'graphql', '--input', 'payload.json']).catch((error: unknown) => error);
    expect(outcome).toMatchObject({ code: 'LAB_OPERATION_UNKNOWN' });
    expect(outcome).not.toHaveProperty('response');
  });
});
