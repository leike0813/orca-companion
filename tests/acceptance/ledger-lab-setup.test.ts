import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

type CallOptions = { readonly cwd?: string; readonly env?: Readonly<Record<string, string>> };
type Call = (executable: string, args: readonly string[], options?: CallOptions) => Promise<string>;
type RunRecord = {
  readonly directory: string;
  readonly id: string;
  readonly profile: string;
  readonly repositoryPath: string;
  readonly branch: string;
  readonly githubRepository: string;
  readonly stage: string;
  readonly state: string;
  readonly orcaRepoId: string | null;
  readonly worktreeId: string | null;
  readonly terminalHandle: string | null;
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
  readonly prepareLab: (options: { readonly profile?: 'main' | 'cancel'; readonly root?: string; readonly settings?: string }, dependencies: {
    readonly env?: Record<string, string | undefined>;
    readonly orca?: string;
    readonly call?: Call;
    readonly readSettings?: (path: string) => Promise<unknown>;
    readonly signal?: AbortSignal;
    readonly doctor?: (record: RunRecord, env: Readonly<Record<string, string>>) => Promise<unknown>;
    readonly progress?: (stage: string) => void;
  }) => Promise<RunRecord>;
  readonly readRun: (path: string) => Promise<RunRecord>;
  readonly bindOperatorFiles: (record: Pick<RunRecord, 'directory'>, scopeId: string) => Promise<void>;
  readonly openLab: (options: { readonly run: string }, dependencies: { readonly env?: Record<string, string | undefined>; readonly call: Call }) => Promise<RunRecord>;
  readonly shellQuote: (value: string) => string;
};
type WizardModule = {
  readonly configureSettings: (input: {
    readonly settingsPath: string;
    readonly prompt: {
      ask(label: string, fallback?: string): Promise<string>;
      secret(label: string): Promise<string>;
      say(text: string): void;
    };
    readonly host: {
      read(): unknown;
      save(input: unknown): unknown;
      readonly providerLibrary: {
        load(): unknown;
        saveConnection(input: unknown): Promise<unknown>;
        saveModel(input: unknown): unknown;
      };
      readonly providerCatalog: {
        presets(): readonly unknown[];
        discover(connection: unknown): Promise<unknown>;
        candidates(connection: unknown): { readonly models: readonly { readonly id: string; readonly label: string }[] };
      };
    };
    readonly catalog: { query(input: { readonly harness: string }): Promise<
      | { readonly kind: 'available'; readonly source: string; readonly models: readonly {
          readonly model: string; readonly effortCapability: { readonly values: readonly string[]; readonly source: string } | null;
        }[] }
      | { readonly kind: 'unavailable'; readonly code: string }
    > };
    readonly roles: readonly string[];
    readonly harnesses: readonly string[];
  }) => Promise<unknown>;
};
type LabModule = { readonly main: (argv: readonly string[]) => Promise<number> };

const setupHref = new URL('../../artifacts/ledger-lab/setup.mjs', import.meta.url).href;
const setup = (await import(/* @vite-ignore */ setupHref)) as SetupModule;
const labHref = new URL('../../artifacts/ledger-lab/lab.mjs', import.meta.url).href;
const lab = (await import(/* @vite-ignore */ labHref)) as LabModule;
const ORCA_EXECUTABLE = '/fixture/bin/orca';
const wizardHref = new URL('../../artifacts/ledger-lab/wizard.mjs', import.meta.url).href;
const wizard = (await import(/* @vite-ignore */ wizardHref)) as WizardModule;
const settingsHref = new URL('../../dist/src/bootstrap/ledger-lab.js', import.meta.url).href;
const configHref = new URL('../../dist/src/application/configuration/project-config.js', import.meta.url).href;
const modelConfigHref = new URL('../../dist/src/domain/model-configuration.js', import.meta.url).href;
const { requireLedgerLabConfiguration } = await import(/* @vite-ignore */ settingsHref) as {
  readonly requireLedgerLabConfiguration: (value: unknown) => unknown;
};
const { parseProjectConfig } = await import(/* @vite-ignore */ configHref) as {
  readonly parseProjectConfig: (value: unknown) => { readonly ok: boolean; readonly value?: unknown };
};
const { MODEL_PROFILE_ROLES, WORKER_HARNESS_IDS } = await import(/* @vite-ignore */ modelConfigHref) as {
  readonly MODEL_PROFILE_ROLES: readonly string[];
  readonly WORKER_HARNESS_IDS: readonly string[];
};

const sandboxes: string[] = [];
async function sandbox(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'ledger-lab-setup-'));
  sandboxes.push(path);
  return path;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(sandboxes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function schemaFiveConfig(): unknown {
  const credentialRef = '00000000-0000-4000-8000-000000000001';
  const connection = { connectionRef: 'connection-main', label: 'Fixture provider', providerId: 'custom',
    providerIntegration: 'openai-chat', baseUrl: 'https://api.fixture.invalid/v1', credential: { kind: 'managed', credentialRef } };
  const model = { modelRef: 'model-main', connectionRef: connection.connectionRef, model: 'coordinator-fixture', effortCapability: null };
  const workerProfiles = MODEL_PROFILE_ROLES.map((role) => ({
    profileRef: `profile-${role}`,
    role,
    harness: 'codex',
    modelSelection: { model: `worker-${role}`, effort: null, effortCapability: null, catalogSource: null },
  }));
  const parsed = parseProjectConfig({
    schemaVersion: 5,
    revision: 0,
    coordinatorModels: [{ configurationRef: 'coordinator-main', providerIntegration: connection.providerIntegration,
      model: model.model, credentialRefs: [credentialRef], nativeWindowOwnerRef: null, providerConnection: connection,
      modelRef: model.modelRef, effortCapability: null, effort: null }],
    defaultCoordinatorModelRef: 'coordinator-main',
    providerConnections: [connection],
    models: [model],
    tracker: { kind: 'github', routeMapIssueNumber: 1 },
    planning: { maxMutations: 20 },
    context: { maxInputTokens: 10000 },
    execution: {
      harness: 'codex', codexSandbox: 'workspace-write', workerProfiles,
      workerProfileRefs: Object.fromEntries(MODEL_PROFILE_ROLES.map((role) => [role, `profile-${role}`])),
    },
  });
  if (!parsed.ok) throw new Error('test fixture schema-5 config failed to parse');
  return parsed.value;
}

function setupCall(options: { readonly unknownCreate?: boolean; readonly onCall?: (executable: string, args: readonly string[], options?: CallOptions) => void } = {}) {
  const calls: { readonly executable: string; readonly args: readonly string[]; readonly options?: CallOptions }[] = [];
  let issueBody = '';
  let createCount = 0;
  const call: Call = async (executable, args, callOptions) => {
    calls.push({ executable, args, ...(callOptions === undefined ? {} : { options: callOptions }) });
    options.onCall?.(executable, args, callOptions);
    const first = args[0];
    if (executable === 'node' && first === '--version') return 'v24.1.0\n';
    if (executable === 'pnpm' && first === '--version') return '11.10.0\n';
    if (executable === 'git' && first === 'config' && args.includes('--get')) {
      return args.at(-1) === 'user.email' ? 'fixture@example.invalid\n' : 'Fixture User\n';
    }
    if (executable === 'git' && first === 'var' && args[1] === 'GIT_AUTHOR_IDENT') return 'Fixture User <fixture@example.invalid> 0 +0000\n';
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
      return JSON.stringify({ nameWithOwner: args[2], visibility: 'PRIVATE', url: `https://github.com/${args[2]}` });
    }
    if (executable === 'gh' && first === 'api' && args[1]?.endsWith('/issues') && args.includes('POST')) {
      const payloadPath = args[args.indexOf('--input') + 1];
      if (payloadPath === undefined) throw new Error('fake GH call did not include its payload path');
      const payload = JSON.parse(await readFile(payloadPath, 'utf8')) as { readonly body: string };
      issueBody = payload.body;
      const repository = args[1].slice('repos/'.length, -'/issues'.length);
      return JSON.stringify({ number: 17, html_url: `https://github.com/${repository}/issues/17` });
    }
    if (executable === 'gh' && first === 'api' && args[1]?.includes('/issues/17')) {
      return JSON.stringify({ number: 17, body: issueBody });
    }
    if (executable.endsWith('/orca') && args[0] === 'status') return JSON.stringify({ ok: true, result: { runtime: { reachable: true } } });
    if (executable.endsWith('/orca') && args[0] === 'repo' && args[1] === 'add') {
      return JSON.stringify({ ok: true, result: { repo: { id: 'repo-fixture', path: args[3] } } });
    }
    if (executable.endsWith('/orca') && args[0] === 'repo' && args[1] === 'set-base-ref') return JSON.stringify({ ok: true, result: {} });
    if (executable.endsWith('/orca') && args[0] === 'worktree' && args[1] === 'show') {
      return JSON.stringify({ ok: true, result: { worktree: {
        id: 'worktree-fixture', repoId: 'repo-fixture', path: args[3]?.startsWith('path:') ? args[3].slice(5) : '',
        branch: 'refs/heads/main', isMainWorktree: true, isBare: false,
      } } });
    }
    if (executable.endsWith('/orca') && args[0] === 'terminal' && args[1] === 'create') {
      return JSON.stringify({ ok: true, result: { terminal: { handle: 'terminal-fixture' } } });
    }
    if (executable.endsWith('/orca') && args[0] === 'terminal' && args[1] === 'switch') return JSON.stringify({ ok: true, result: {} });
    throw new Error(`unexpected fake command: ${executable} ${args.join(' ')}`);
  };
  return { call, calls, get createCount() { return createCount; } };
}

describe('ledger-lab setup', () => {
  it.each(['main', 'cancel'] as const)('prepares a private external %s lab with canonical worktree and wrappers', async (profile) => {
    const root = join(await sandbox(), 'existing-runs-root');
    const config = schemaFiveConfig();
    const fake = setupCall();
    const progress: string[] = [];
    const doctorEnvironments: Readonly<Record<string, string>>[] = [];
    const result = await setup.prepareLab({ profile, root }, {
      env: { HOME: '/fixture-home', PATH: '/fixture-bin', GH_TOKEN: 'secret-gh-token', GH_REPO: 'attacker/repo', ORCA_HOST: 'attacker-host' },
      orca: ORCA_EXECUTABLE, call: fake.call,
      readSettings: () => Promise.resolve(requireLedgerLabConfiguration(config)),
      doctor: (_record, env) => {
        doctorEnvironments.push(env);
        return Promise.resolve({ ok: true, checks: [{ id: 'coordinator-model', status: 'ok' }, { id: 'read-only-worker', status: 'ok' }] });
      },
      progress: (stage) => progress.push(stage),
    });

    expect(await stat(root)).toBeDefined();
    expect(result).toMatchObject({ profile, state: 'ready', stage: 'ready', branch: 'refs/heads/main', githubRepository: `fixture-user/${result.id}` });
    expect(result.repositoryPath).toBe(join(result.directory, 'repo'));
    expect(await setup.readRun(result.directory)).toMatchObject({ id: result.id, state: 'ready', orcaRepoId: 'repo-fixture', worktreeId: 'worktree-fixture' });
    expect(doctorEnvironments[0]).toMatchObject({ GH_TOKEN: 'secret-gh-token', GH_REPO: result.githubRepository });
    expect(doctorEnvironments[0]).not.toHaveProperty('ORCA_HOST');
    expect(progress).toContain('ready');
    expect(fake.calls.some(({ executable, args }) => executable === 'gh' && args[0] === 'repo' && args[1] === 'create' && args.includes('--private'))).toBe(true);
    expect(fake.calls.some(({ executable, args }) => executable === 'git' && args[0] === 'config' && args.includes('--local') && args.includes('credential.https://github.com.helper'))).toBe(true);
    expect(fake.calls.some(({ executable, args }) => executable === 'git' && args[0] === 'push')).toBe(true);

    const launcher = await readFile(join(result.directory, 'bin', 'ocp'), 'utf8');
    const shell = await readFile(join(result.directory, 'bin', 'shell'), 'utf8');
    expect(launcher).toContain('dist/src/interfaces/cli/main.js');
    expect(launcher).toContain(`export GH_REPO='${result.githubRepository}'`);
    expect(shell).toContain(`cd '${result.repositoryPath}'`);
    expect(await readdir(result.directory)).toEqual(expect.arrayContaining(['repo', 'operator', 'bin', 'run.json']));
    expect(await readdir(result.repositoryPath)).toEqual(expect.arrayContaining(['README.md', '.gitignore', 'openspec', 'orca-companion.json', '.git']));
    expect(await readdir(result.repositoryPath)).not.toContain('src');
    expect(await readFile(join(result.directory, 'operator', 'guide.md'), 'utf8')).toContain('ledger-lab');
    expect(await readFile(join(result.directory, 'run.json'), 'utf8')).not.toContain('secret-gh-token');
  });

  it('allows an existing output root and allocates a distinct run directory each time', async () => {
    const root = join(await sandbox(), 'runs');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(root));
    const dependencies = {
      env: { HOME: '/fixture', PATH: '/bin' }, orca: ORCA_EXECUTABLE,
      readSettings: () => Promise.resolve(requireLedgerLabConfiguration(schemaFiveConfig())),
      doctor: () => Promise.resolve({ ok: true, checks: [{ id: 'coordinator-model', status: 'ok' }, { id: 'read-only-worker', status: 'ok' }] }),
    };
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
      readSettings: () => Promise.resolve(requireLedgerLabConfiguration(schemaFiveConfig())),
    })).rejects.toThrow('Companion 仓库之外');
    expect(fake.createCount).toBe(0);
  });

  it('rejects non-TTY first-run configuration before invoking external commands', async () => {
    const calls: string[] = [];
    await expect(setup.prepareLab({ root: join(await sandbox(), 'runs') }, {
      env: { HOME: '/fixture', PATH: '/bin' },
      readSettings: () => Promise.reject(Object.assign(new Error('missing settings'), { code: 'ENOENT' })),
      call: (executable) => { calls.push(executable); return Promise.resolve(''); },
      orca: ORCA_EXECUTABLE,
    })).rejects.toThrow('首次配置需要交互式终端');
    expect(calls).toEqual([]);
  });

  it('preserves an unknown GitHub create outcome without retrying or cleaning the run', async () => {
    const root = join(await sandbox(), 'runs');
    const fake = setupCall({ unknownCreate: true });
    await expect(setup.prepareLab({ root }, {
      env: { HOME: '/fixture', PATH: '/bin' }, orca: ORCA_EXECUTABLE, call: fake.call,
      readSettings: () => Promise.resolve(requireLedgerLabConfiguration(schemaFiveConfig())),
    })).rejects.toMatchObject({ code: 'LAB_OPERATION_UNKNOWN' });

    expect(fake.createCount).toBe(1);
    const [directory] = await readdir(root);
    const record: unknown = JSON.parse(await readFile(join(root, directory!, 'run.json'), 'utf8'));
    expect(record).toMatchObject({ state: 'failed', stage: 'github-repository' });
    expect((record as { readonly githubRepository: string }).githubRepository).toMatch(/^fixture-user\/ledger-lab-/u);
    expect(await readdir(directory ? join(root, directory) : root)).toContain('repo');
  });

  it('retains the failed run and avoids GitHub create when cancellation arrives at a stage boundary', async () => {
    const root = join(await sandbox(), 'runs');
    const controller = new AbortController();
    const fake = setupCall();
    await expect(setup.prepareLab({ root }, {
      env: { HOME: '/fixture', PATH: '/bin' }, orca: ORCA_EXECUTABLE, call: fake.call,
      signal: controller.signal,
      readSettings: () => Promise.resolve(requireLedgerLabConfiguration(schemaFiveConfig())),
      progress: (stage) => { if (stage === 'github-repository') controller.abort(); },
    })).rejects.toMatchObject({ code: 'LAB_OPERATION_UNKNOWN' });
    expect(fake.createCount).toBe(0);
    const [directory] = await readdir(root);
    const record = JSON.parse(await readFile(join(root, directory!, 'run.json'), 'utf8')) as Record<string, unknown>;
    expect(record).toMatchObject({ state: 'failed', stage: 'github-repository' });
  });

  it('checks the original worktree identity before opening a new terminal', async () => {
    const root = join(await sandbox(), 'runs');
    const prepared = await setup.prepareLab({ root }, {
      env: { HOME: '/fixture', PATH: '/bin' }, orca: ORCA_EXECUTABLE, call: setupCall().call,
      readSettings: () => Promise.resolve(requireLedgerLabConfiguration(schemaFiveConfig())),
      doctor: () => Promise.resolve({ ok: true, checks: [{ id: 'coordinator-model', status: 'ok' }, { id: 'read-only-worker', status: 'ok' }] }),
    });
    let terminalCreateCount = 0;
    const call: Call = (executable, args) => {
      if (executable === 'git' && args[0] === 'symbolic-ref') return Promise.resolve('refs/heads/wrong\n');
      if (executable === 'git' && args[0] === 'rev-parse' && args[1] === '--path-format=absolute') return Promise.resolve(join(prepared.repositoryPath, '.git'));
      if (executable === 'git' && args[0] === 'rev-parse' && args[1] === '--absolute-git-dir') return Promise.resolve(join(prepared.repositoryPath, '.git'));
      if (executable === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') return Promise.resolve(prepared.repositoryPath);
      if (executable === 'git' && args[0] === 'remote') return Promise.resolve(`https://github.com/${prepared.githubRepository}.git`);
      if (executable.endsWith('/orca') && args[0] === 'worktree') return Promise.resolve(JSON.stringify({ ok: true, result: { worktree: {
        id: prepared.worktreeId, repoId: prepared.orcaRepoId, path: prepared.repositoryPath,
        branch: prepared.branch, isMainWorktree: true, isBare: false,
      } } }));
      if (executable.endsWith('/orca') && args[0] === 'terminal' && args[1] === 'create') terminalCreateCount += 1;
      throw new Error(`unexpected open command ${executable} ${args.join(' ')}`);
    };
    await expect(setup.openLab({ run: prepared.directory }, { env: { HOME: '/fixture', PATH: '/bin' }, call })).rejects.toThrow('Git canonical 身份不符');
    expect(terminalCreateCount).toBe(0);
  });

  it('opens only after Git branch, common dir, toplevel, remote, and Orca worktree match', async () => {
    const root = join(await sandbox(), 'runs');
    const prepared = await setup.prepareLab({ root }, {
      env: { HOME: '/fixture', PATH: '/bin' }, orca: ORCA_EXECUTABLE, call: setupCall().call,
      readSettings: () => Promise.resolve(requireLedgerLabConfiguration(schemaFiveConfig())),
      doctor: () => Promise.resolve({ ok: true, checks: [{ id: 'coordinator-model', status: 'ok' }, { id: 'read-only-worker', status: 'ok' }] }),
    });
    const gitDir = join(prepared.repositoryPath, '.git');
    const commands: string[] = [];
    const call: Call = (executable, args) => {
      commands.push(`${executable} ${args.join(' ')}`);
      if (executable === 'git' && args[0] === 'symbolic-ref') return Promise.resolve(`${prepared.branch}\n`);
      if (executable === 'git' && args[0] === 'rev-parse' && args[1] === '--path-format=absolute') return Promise.resolve(`${gitDir}\n`);
      if (executable === 'git' && args[0] === 'rev-parse' && args[1] === '--absolute-git-dir') return Promise.resolve(`${gitDir}\n`);
      if (executable === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') return Promise.resolve(`${prepared.repositoryPath}\n`);
      if (executable === 'git' && args[0] === 'remote') return Promise.resolve(`https://github.com/${prepared.githubRepository}.git\n`);
      if (executable.endsWith('/orca') && args[0] === 'worktree') return Promise.resolve(JSON.stringify({ ok: true, result: { worktree: {
        id: prepared.worktreeId, repoId: prepared.orcaRepoId, path: prepared.repositoryPath,
        branch: prepared.branch, isMainWorktree: true, isBare: false,
      } } }));
      if (executable.endsWith('/orca') && args[0] === 'terminal' && args[1] === 'create') {
        return Promise.resolve(JSON.stringify({ ok: true, result: { terminal: { handle: 'terminal-reopened' } } }));
      }
      throw new Error(`unexpected open command ${executable} ${args.join(' ')}`);
    };
    const opened = await setup.openLab({ run: prepared.directory }, { env: { HOME: '/fixture', PATH: '/bin' }, call });
    expect(opened.terminalHandle).toBe('terminal-reopened');
    expect(commands.some((command) => command.includes('--show-toplevel'))).toBe(true);
    expect(commands.some((command) => command.includes('remote get-url origin'))).toBe(true);
    expect(commands.some((command) => command.startsWith(`${ORCA_EXECUTABLE} worktree show`))).toBe(true);
  });

  it('binds empty operator templates once, preserves matching data, and rejects another scope', async () => {
    const directory = await sandbox();
    const operator = join(directory, 'operator');
    await mkdir(operator);
    const record = { directory };
    const mappingPath = join(operator, 'mapping.json');
    const observationsPath = join(operator, 'observations.json');
    const blankFiles = [
      { schemaVersion: 1, coordinationScopeId: '', graphs: [] },
      { schemaVersion: 1, coordinationScopeId: '', entries: [] },
    ];
    await writeFile(mappingPath, JSON.stringify(blankFiles[0]));
    await writeFile(observationsPath, JSON.stringify(blankFiles[1]));

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
    const prepared = await setup.prepareLab({ root }, {
      env: { HOME: '/fixture', PATH: '/bin' }, orca: ORCA_EXECUTABLE, call: setupCall().call,
      readSettings: () => Promise.resolve(requireLedgerLabConfiguration(schemaFiveConfig())),
      doctor: () => Promise.resolve({ ok: true, checks: [{ id: 'coordinator-model', status: 'ok' }, { id: 'read-only-worker', status: 'ok' }] }),
    });
    const code = await lab.main(['verify-result', '--run', prepared.directory]);
    expect(code).toBe(3);
    const reports = await readdir(join(prepared.directory, 'checks'));
    expect(reports).toHaveLength(1);
    const reportPath = join(prepared.directory, 'checks', reports[0]!);
    expect(reportPath.startsWith(prepared.repositoryPath)).toBe(false);
    const report: unknown = JSON.parse(await readFile(reportPath, 'utf8'));
    expect(report).toMatchObject({ kind: 'result-report', repositoryPath: prepared.repositoryPath });
  });

  it('rejects --run collection before a canonical Scope exists', async () => {
    const root = join(await sandbox(), 'runs');
    const prepared = await setup.prepareLab({ root }, {
      env: { HOME: '/fixture', PATH: '/bin' }, orca: ORCA_EXECUTABLE, call: setupCall().call,
      readSettings: () => Promise.resolve(requireLedgerLabConfiguration(schemaFiveConfig())),
      doctor: () => Promise.resolve({ ok: true, checks: [{ id: 'coordinator-model', status: 'ok' }, { id: 'read-only-worker', status: 'ok' }] }),
    });
    await expect(lab.main(['collect', '--run', prepared.directory])).rejects.toThrow(/Scope|scope/u);
    expect(await readdir(join(prepared.directory, 'captures'))).toEqual([]);
  });

  it('passes a sanitized environment to the process runner while retaining credentials in memory', async () => {
    const requests: { readonly env: Readonly<Record<string, string>>; readonly args: readonly string[] }[] = [];
    const call = await setup.createCommandRunner({ env: setup.cleanEnvironment({ GH_TOKEN: 'memory-token', GH_REPO: 'untrusted/repo', ORCA_HOST: 'untrusted', SAFE: 'kept' }),
      runner: (request) => {
        requests.push({ env: request.env, args: request.args });
        return Promise.resolve({ kind: 'completed', exitCode: 0, stdout: { text: 'ok', truncated: false }, stderr: { text: '', truncated: false } });
      } });
    expect(await call('git', ['status'])).toBe('ok');
    expect(requests[0]?.env).toMatchObject({ GH_TOKEN: 'memory-token', SAFE: 'kept' });
    expect(requests[0]?.env).not.toHaveProperty('GH_REPO');
    expect(requests[0]?.env).not.toHaveProperty('ORCA_HOST');
    expect(JSON.stringify(requests.map(({ args }) => args))).not.toContain('memory-token');
    expect(setup.shellQuote("space $() and ' quote")).toBe("'space $() and '" + '"' + "'" + '"' + "' quote'");
  });
});

describe('ledger-lab setup wizard', () => {
  const libraryConnection = { connectionRef: 'connection-library', label: 'Fixture connection', providerId: 'fixture',
    providerIntegration: 'openai-chat', baseUrl: 'https://api.fixture.invalid/v1',
    credential: { kind: 'managed', credentialRef: '00000000-0000-4000-8000-000000000001' } };
  const createWizardHost = (save: (input: unknown) => unknown) => ({
    read: () => ({ kind: 'absent' }), save,
    providerLibrary: {
      load: () => ({ kind: 'loaded', revision: 4, connections: [libraryConnection], models: [] }),
      saveConnection: () => Promise.reject(new Error('existing connection should be reused')),
      saveModel: () => ({ kind: 'saved', revision: 5, model: { modelRef: 'coordinator-model-ref', connectionRef: libraryConnection.connectionRef,
        model: 'coordinator-fixture', effortCapability: null } }),
    },
    providerCatalog: {
      presets: () => [], discover: () => Promise.reject(new Error('offline')),
      candidates: () => ({ models: [{ id: 'coordinator-fixture', label: 'Coordinator Fixture' }] }),
    },
  });

  it('queries and preserves native source and effort for each of the five worker roles', async () => {
    const asks: string[] = [];
    const queriedRoles: string[] = [];
    let saved: unknown;
    const prompt = {
      ask(label: string, fallback = ''): Promise<string> {
        asks.push(label);
        const answer = label.startsWith('Coordinator 连接') ? 'existing'
          : label.startsWith('选择用户级连接') ? 'Fixture connection'
            : label.startsWith('选择 Coordinator 模型') ? 'coordinator-fixture'
              : label.includes('模型序号或原生 ID') ? '1'
                  : label.includes(' effort ') ? 'high'
                    : label.includes('预算') ? '20'
                      : label.includes('token 上限') ? '10000'
                        : label.includes('保存以上选择') ? 'save' : fallback;
        return Promise.resolve(answer);
      },
      secret(): Promise<string> { return Promise.reject(new Error('secret input is not expected')); },
      say(): void {},
    };
    const result = await wizard.configureSettings({
      settingsPath: join(await sandbox(), 'settings.json'), prompt,
      host: createWizardHost((input) => { saved = input; return input; }),
      catalog: { query: ({ harness }) => {
        const role = MODEL_PROFILE_ROLES[queriedRoles.length];
        queriedRoles.push(role ?? 'missing-role');
        const source = `${harness}:${role}:catalog`;
        return Promise.resolve({ kind: 'available' as const, source, models: [{ model: `${role}-native`, effortCapability: { values: ['low', 'high'], source } }] });
      } },
      roles: MODEL_PROFILE_ROLES,
      harnesses: WORKER_HARNESS_IDS,
    });
    expect(result).toBe(saved);
    expect(queriedRoles).toEqual(MODEL_PROFILE_ROLES);
    expect(saved).toMatchObject({ workers: MODEL_PROFILE_ROLES.map((role) => ({ role, harness: 'codex', modelSelection: {
      model: `${role}-native`, effort: 'high', catalogSource: `codex:${role}:catalog`,
      effortCapability: { values: ['low', 'high'], source: `codex:${role}:catalog` },
    } })) });
    expect(asks.filter((label) => label.includes('模型序号或原生 ID'))).toHaveLength(5);
  });

  it('does not save when the user cancels the final confirmation', async () => {
    let saveCount = 0;
    const prompt = {
      ask(label: string, fallback = ''): Promise<string> {
        const answer = label.startsWith('Coordinator 连接') ? 'existing'
          : label.startsWith('选择用户级连接') ? 'Fixture connection'
            : label.startsWith('选择 Coordinator 模型') ? 'coordinator-fixture'
              : label.includes('模型序号或原生 ID') ? 'manual-worker-model'
                  : label.includes('保存以上选择') ? 'cancel' : fallback;
        return Promise.resolve(answer);
      },
      secret(): Promise<string> { return Promise.reject(new Error('secret input is not expected')); },
      say(): void {},
    };
    await expect(wizard.configureSettings({
      settingsPath: '/external/settings.json', prompt,
      host: createWizardHost(() => { saveCount += 1; }),
      catalog: { query: () => Promise.resolve({ kind: 'available' as const, source: 'fixture', models: [] }) },
      roles: MODEL_PROFILE_ROLES, harnesses: WORKER_HARNESS_IDS,
    })).rejects.toThrow('配置已取消');
    expect(saveCount).toBe(0);
  });

  it('saves a custom connection key privately and permits offline exact model IDs', async () => {
    const messages: string[] = [];
    const savedConnectionInputs: unknown[] = [];
    let projectSave: unknown;
    const connection = { ...libraryConnection, connectionRef: 'new-connection', label: 'Custom provider' };
    const host = {
      read: () => ({ kind: 'absent' }),
      save: (input: unknown) => { projectSave = input; return input; },
      providerLibrary: {
        load: (() => {
          let reads = 0;
          return () => ++reads === 1
            ? { kind: 'loaded', revision: 0, connections: [], models: [] }
            : { kind: 'loaded', revision: 1, connections: [connection], models: [] };
        })(),
        saveConnection: (input: unknown) => {
          savedConnectionInputs.push(input);
          return Promise.resolve({ kind: 'saved', revision: 1, connection });
        },
        saveModel: () => ({ kind: 'saved', revision: 2, model: { modelRef: 'offline-model-ref', connectionRef: connection.connectionRef,
          model: 'provider/exact-id', effortCapability: null } }),
      },
      providerCatalog: { presets: () => [], discover: () => Promise.reject(new Error('offline')), candidates: () => ({ models: [] }) },
    };
    const prompt = {
      ask(label: string, fallback = ''): Promise<string> {
        if (label.startsWith('Coordinator 连接')) return Promise.resolve('new');
        if (label.startsWith('Coordinator provider 来源')) return Promise.resolve('custom');
        if (label === '连接名称') return Promise.resolve('Custom provider');
        if (label === 'Provider 地址') return Promise.resolve('https://api.fixture.invalid/v1');
        if (label.startsWith('Coordinator 精确模型 ID')) return Promise.resolve('provider/exact-id');
        if (label.includes('模型序号或原生 ID')) return Promise.resolve('worker-native-id');
        if (label.includes('预算')) return Promise.resolve('20');
        if (label.includes('token 上限')) return Promise.resolve('10000');
        if (label.includes('保存以上选择')) return Promise.resolve('save');
        return Promise.resolve(fallback);
      },
      secret: () => Promise.resolve('sk-private-key'),
      say: (text: string) => messages.push(text),
    };
    await wizard.configureSettings({ settingsPath: join(await sandbox(), 'settings.json'), prompt, host,
      catalog: { query: () => Promise.resolve({ kind: 'unavailable' as const, code: 'offline' }) },
      roles: MODEL_PROFILE_ROLES, harnesses: WORKER_HARNESS_IDS });

    expect(savedConnectionInputs).toEqual([expect.objectContaining({ providerId: 'custom', providerIntegration: 'openai-chat', newSecret: 'sk-private-key' })]);
    expect(JSON.stringify(messages)).not.toContain('sk-private-key');
    expect(projectSave).toMatchObject({ coordinator: { modelRef: 'offline-model-ref', effort: null } });
  });
});
