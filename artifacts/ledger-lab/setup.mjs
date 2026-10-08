import process from 'node:process';
import { access, copyFile, lstat, mkdir, realpath, rename, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { canonicalPath, contract, readJson, writeNewJson } from './common.mjs';
import { runConfigurationWizard, requireInteractive } from './wizard.mjs';

export const companionRoot = fileURLToPath(new URL('../../', import.meta.url));
export const settingsPathFor = (env = process.env) => join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'), 'orca-companion', 'ledger-lab.json');
export const runsRootFor = (env = process.env) => join(env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local/state'), 'orca-companion', 'ledger-lab');
const inside = (root, target) => { const path = relative(root, target); return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path)); };
export const shellQuote = (value) => `'${value.replace(/'/gu, `'"'"'`)}'`;

export function cleanEnvironment(base = process.env) {
  return Object.fromEntries(Object.entries(base).filter(([key, value]) => value !== undefined &&
    !/^ORCA_(?:WORKTREE|REPO|PROJECT|TERMINAL|PANE|TAB|RUN|COORDINATOR|DISPATCH|TASK|WORKER|HOST|ENVIRONMENT|IDENTITY|CONSUMER|ATTEMPT|CONTEXT)(?:_|$)/u.test(key) && key !== 'GH_REPO'));
}

export async function findExecutable(command, env = process.env) {
  const candidates = command.includes('/') ? [resolve(command)] : (env.PATH || '').split(':').map((path) => join(path, command));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); if ((await lstat(candidate)).isDirectory()) continue; return resolve(candidate); }
    catch (error) { if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) throw error; }
  }
  throw new Error(`找不到可执行文件：${command}`);
}

export async function resolveOrcaExecutable(env = process.env) {
  const command = env.ORCA_CLI_COMMAND || (env.ORCA_DEV_REPO_ROOT ? 'orca-dev' : env.ORCA_WORKTREE_ID ? 'orca' : 'orca-ide');
  return findExecutable(command, env);
}

async function externalPath(path) {
  if (!isAbsolute(path)) throw new Error('演练路径必须为绝对路径');
  const canonical = await canonicalPath(path);
  if (inside(await realpath(companionRoot), canonical)) throw new Error('演练路径必须在 Companion 仓库之外');
  return canonical;
}

export async function createCommandRunner({ env, signal, runner } = {}) {
  const run = runner ?? (await import('../../dist/src/adapters/orca-cli/process-runner.js')).runProcess;
  return async (executable, args, options = {}) => {
    const result = await run({ executable, args, cwd: options.cwd ?? companionRoot, env: options.env ?? env ?? cleanEnvironment(),
      timeoutMs: options.timeoutMs ?? 60000, limits: { maxBytes: 1024 * 1024, maxLines: 20000 },
      ...(signal ? { signal } : {}), ...(options.stdin === undefined ? {} : { stdin: options.stdin }) });
    if (result.kind !== 'completed' || result.exitCode !== 0 || result.stdout.truncated || result.stderr.truncated) {
      const error = new Error(`外部命令失败：${executable.split('/').at(-1)} ${args[0] ?? ''}（${result.kind === 'completed' ? result.exitCode : result.kind}）`);
      error.code = result.kind === 'unknown' ? 'LAB_OPERATION_UNKNOWN' : 'LAB_COMMAND_FAILED';
      throw error;
    }
    return result.stdout.text;
  };
}

async function jsonCommand(call, executable, args, options) {
  const text = await call(executable, args, options);
  try { return JSON.parse(text); } catch { throw new Error('外部命令没有返回有效 JSON'); }
}
async function orcaCommand(call, executable, args, options) {
  const response = await jsonCommand(call, executable, [...args, '--json'], options);
  if (response?.ok !== true || !response.result || typeof response.result !== 'object') throw new Error('Orca 回执不可核验');
  return response.result;
}
async function saveRun(directory, value) {
  const temporary = join(directory, `run-${randomUUID()}.tmp`);
  await writeNewJson(temporary, value);
  await rename(temporary, join(directory, 'run.json'));
}

export async function configureLab(options = {}) {
  const path = await externalPath(options.settings ?? settingsPathFor());
  return runConfigurationWizard(path);
}

export async function prepareLab(options = {}, dependencies = {}) {
  if (process.platform !== 'linux') throw new Error('ledger-lab 一键准备当前只支持 Ubuntu 本机');
  const profile = options.profile ?? 'main';
  if (!['main', 'cancel'].includes(profile)) throw new Error('profile 必须为 main 或 cancel');
  const baseEnv = dependencies.env ?? process.env;
  const env = { ...cleanEnvironment(baseEnv), GH_HOST: 'github.com' };
  const settingsPath = await externalPath(options.settings ?? settingsPathFor(baseEnv));
  const { createLedgerLabConfigurationHost, requireLedgerLabConfiguration } = await import('../../dist/src/bootstrap/ledger-lab.js');
  const settingsHost = createLedgerLabConfigurationHost({ configPath: settingsPath, env, verifyWorkerSelection: () => null });
  let configuration;
  try {
    if (dependencies.readSettings) configuration = await dependencies.readSettings(settingsPath);
    else {
      const loaded = settingsHost.read();
      if (loaded.kind === 'absent') throw Object.assign(new Error('演练配置尚未创建'), { code: 'ENOENT' });
      if (loaded.kind === 'failed') throw new Error(loaded.message);
      configuration = requireLedgerLabConfiguration(loaded.config);
    }
  }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    requireInteractive();
    configuration = await (dependencies.configure ?? runConfigurationWizard)(settingsPath, env, settingsHost.credentials);
  }
  const call = dependencies.call ?? await createCommandRunner({ env, signal: dependencies.signal });
  const orca = dependencies.orca ?? await resolveOrcaExecutable(baseEnv);
  await call('node', ['--version']);
  const pnpmVersion = (await call('pnpm', ['--version'])).trim();
  if (!/^\d+\./u.test(pnpmVersion) || Number(pnpmVersion.split('.')[0]) < 11) throw new Error('需要 pnpm 11 或更新版本');
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('需要 Node.js 24 或更新版本');
  for (const key of ['user.name', 'user.email']) {
    if (!(await call('git', ['config', '--get', key])).trim()) throw new Error('Git 作者身份未配置');
  }
  const account = await jsonCommand(call, 'gh', ['api', 'user']);
  if (typeof account?.login !== 'string' || !/^[A-Za-z0-9-]+$/u.test(account.login)) throw new Error('GitHub 账号不可核验');
  const status = await orcaCommand(call, orca, ['status']);
  if (status.runtime?.reachable !== true) throw new Error('请先启动本机 Orca');
  const root = await externalPath(options.root ?? runsRootFor(baseEnv));
  const id = `ledger-lab-${profile}-${new Date().toISOString().replace(/[-:.TZ]/gu, '')}-${randomUUID().slice(0, 8)}`;
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = join(root, id);
  await mkdir(directory, { mode: 0o700 });
  const repositoryPath = join(directory, 'repo');
  const record = { schemaVersion: 1, kind: 'ledger-lab-run', id, profile, repositoryPath, branch: 'refs/heads/main',
    companionRoot: await realpath(companionRoot), orcaExecutable: orca, state: 'preparing', stage: 'local-repository',
    githubRepository: `${account.login}/${id}`, routeMapIssueNumber: null, orcaRepoId: null, worktreeId: null, terminalHandle: null,
    sourceHead: null, sourceDirty: null, baselineHead: null, createdAt: new Date().toISOString() };
  const stage = async (name) => {
    if (dependencies.signal?.aborted) throw Object.assign(new Error('准备已取消'), { code: 'LAB_OPERATION_UNKNOWN' });
    record.stage = name; await saveRun(directory, record); dependencies.progress?.(name);
    if (dependencies.signal?.aborted) throw Object.assign(new Error('准备已取消'), { code: 'LAB_OPERATION_UNKNOWN' });
  };
  await saveRun(directory, record);
  try {
    for (const subdir of ['repo', 'bin', 'operator', 'captures', 'checks']) await mkdir(join(directory, subdir), { mode: 0o700 });
    for (const filename of ['guide.md', 'prompts.md', 'contract.json', 'cases.json', 'mapping.example.json', 'observations.example.json']) {
      await copyFile(new URL(filename, import.meta.url), join(directory, 'operator', filename), constants.COPYFILE_EXCL);
    }
    await writeNewJson(join(directory, 'operator', 'mapping.json'), { schemaVersion: 1, coordinationScopeId: '', graphs: [] });
    await writeNewJson(join(directory, 'operator', 'observations.json'), { schemaVersion: 1, coordinationScopeId: '', entries: [] });
    record.sourceHead = (await call('git', ['rev-parse', 'HEAD'])).trim();
    record.sourceDirty = (await call('git', ['status', '--porcelain'])).trim().length > 0;
    await call('git', ['init', '--initial-branch=main', repositoryPath]);
    await call('git', ['var', 'GIT_AUTHOR_IDENT'], { cwd: repositoryPath });
    await stage('github-repository');
    await call('gh', ['repo', 'create', record.githubRepository, '--private', '--disable-wiki']);
    const remote = await jsonCommand(call, 'gh', ['repo', 'view', record.githubRepository, '--json', 'nameWithOwner,visibility,url']);
    if (remote.nameWithOwner !== record.githubRepository || remote.visibility !== 'PRIVATE') throw new Error('新 GitHub 仓库身份或可见性不符');
    await stage('route-map');
    const { ROUTE_MAP_SECTIONS, renderRouteMapSection } = await import('../../dist/src/domain/planning/route-map.js');
    const body = ROUTE_MAP_SECTIONS.reduce((text, section) => renderRouteMapSection(text, section, ''), '');
    const payload = join(directory, 'operator', 'route-map-create.json');
    await writeNewJson(payload, { title: `ledger-lab ${profile} Route Map`, body });
    const issue = await jsonCommand(call, 'gh', ['api', `repos/${record.githubRepository}/issues`, '--method', 'POST', '--input', payload]);
    if (!Number.isSafeInteger(issue?.number) || issue.number <= 0 || issue.html_url !== `https://github.com/${record.githubRepository}/issues/${issue.number}`) throw new Error('Route Map 创建结果不可核验');
    record.routeMapIssueNumber = issue.number;
    const reread = await jsonCommand(call, 'gh', ['api', `repos/${record.githubRepository}/issues/${issue.number}`]);
    if (reread.number !== issue.number || reread.body !== body) throw new Error('Route Map 回读不符');
    await stage('initial-configuration');
    const { DEFAULT_PROJECT_EXECUTION } = await import('../../dist/src/application/configuration/project-config.js');
    const limits = { ...contract.executionLimits };
    const maxWorkPackages = limits.maxActiveWorkPackages;
    const concurrency = limits.concurrencyLimit;
    delete limits.maxActiveWorkPackages; delete limits.concurrencyLimit; delete limits.perLane;
    const configured = requireLedgerLabConfiguration({ ...configuration, revision: 1,
      tracker: { kind: 'github', routeMapIssueNumber: issue.number }, execution: { ...configuration.execution,
        permissions: DEFAULT_PROJECT_EXECUTION.permissions, codexSandbox: DEFAULT_PROJECT_EXECUTION.codexSandbox, acceptedRisks: [],
        limits: { ...configuration.execution.limits, ...limits, maxWorkPackages, maxActiveWorkPackages: concurrency },
        git: { remotes: ['origin'], refs: ['refs/heads/main'] }, dependency: { allowDependencyChanges: false, registry: null } } });
    await writeNewJson(join(repositoryPath, 'orca-companion.json'), configured);
    await writeFile(join(repositoryPath, 'README.md'), '# ledger-lab\n\nNode.js 24，ESM；业务需求由用户在 Companion 中提交。\n', { flag: 'wx' });
    await writeFile(join(repositoryPath, '.gitignore'), 'node_modules/\ndist/\n.env*\n', { flag: 'wx' });
    await mkdir(join(repositoryPath, 'openspec'));
    await writeFile(join(repositoryPath, 'openspec/config.yaml'), 'schema: spec-driven\n', { flag: 'wx' });
    await call('git', ['add', '--', 'README.md', '.gitignore', 'openspec/config.yaml', 'orca-companion.json'], { cwd: repositoryPath });
    await call('git', ['commit', '-m', 'Initialize ledger-lab rehearsal'], { cwd: repositoryPath });
    record.baselineHead = (await call('git', ['rev-parse', 'HEAD'], { cwd: repositoryPath })).trim();
    await call('git', ['remote', 'add', 'origin', `https://github.com/${record.githubRepository}.git`], { cwd: repositoryPath });
    await call('git', ['config', '--local', 'credential.https://github.com.helper', ''], { cwd: repositoryPath });
    await call('git', ['config', '--local', '--add', 'credential.https://github.com.helper', '!gh auth git-credential'], { cwd: repositoryPath });
    await stage('initial-push');
    await call('git', ['push', '--set-upstream', 'origin', 'main'], { cwd: repositoryPath });
    await stage('orca-registration');
    const registered = await orcaCommand(call, orca, ['repo', 'add', '--path', repositoryPath]);
    if (typeof registered.repo?.id !== 'string' || registered.repo.path !== repositoryPath) throw new Error('Orca 仓库注册结果不可核验');
    record.orcaRepoId = registered.repo.id;
    await orcaCommand(call, orca, ['repo', 'set-base-ref', '--repo', `id:${record.orcaRepoId}`, '--ref', 'origin/main']);
    const shown = await orcaCommand(call, orca, ['worktree', 'show', '--worktree', `path:${repositoryPath}`]);
    assertWorktree(shown.worktree, record);
    record.worktreeId = shown.worktree.id;
    await writeLaunchers(directory, record);
    await stage('orca-terminal');
    const terminal = await orcaCommand(call, orca, ['terminal', 'create', '--worktree', `id:${record.worktreeId}`, '--title', id,
      '--command', shellQuote(join(directory, 'bin', 'shell'))]);
    record.terminalHandle = terminalHandle(terminal);
    await stage('doctor');
    const runtimeEnv = { ...env, GH_REPO: record.githubRepository, PATH: `${join(directory, 'bin')}:${env.PATH ?? ''}` };
    const doctor = dependencies.doctor ?? (async () => {
      const { createOrcaDoctorProbe, runDoctor } = await import('../../dist/src/bootstrap/doctor.js');
      return runDoctor(createOrcaDoctorProbe({ cwd: repositoryPath, env: runtimeEnv, executable: orca,
        identityWorktreePath: repositoryPath, coordinatorIdentityRef: record.terminalHandle, credentialStore: settingsHost.credentials }));
    });
    const report = await doctor(record, runtimeEnv);
    if (dependencies.signal?.aborted) throw Object.assign(new Error('准备已取消'), { code: 'LAB_OPERATION_UNKNOWN' });
    await writeNewJson(join(directory, 'operator', 'doctor.json'), report);
    if (report?.ok !== true || !report.checks?.some((check) => check.id === 'coordinator-model' && check.status === 'ok') ||
      !report.checks.some((check) => check.id === 'read-only-worker' && check.status === 'ok')) throw new Error('doctor 未通过；请查看 operator/doctor.json');
    if ((await call('git', ['status', '--porcelain'], { cwd: repositoryPath })).trim()) throw new Error('测试仓库不是干净工作区');
    record.state = 'ready'; await stage('ready');
    await orcaCommand(call, orca, ['terminal', 'switch', '--terminal', record.terminalHandle]);
    return { directory, ...record };
  } catch (error) {
    record.state = 'failed'; record.failureCode = error.code ?? 'LAB_PREPARE_FAILED';
    await saveRun(directory, record);
    const failure = new Error(`${error.message}；现场保留于 ${directory}（阶段 ${record.stage}）`);
    failure.code = record.failureCode;
    throw failure;
  }
}

function terminalHandle(result) {
  const handle = result.terminal?.handle ?? result.handle;
  if (typeof handle !== 'string' || !handle) throw new Error('Orca 终端句柄不可核验');
  return handle;
}
function assertWorktree(worktree, record) {
  if (!worktree || typeof worktree.id !== 'string' || worktree.repoId !== record.orcaRepoId ||
    worktree.path !== record.repositoryPath || worktree.branch !== record.branch || worktree.isMainWorktree !== true || worktree.isBare === true ||
    (record.worktreeId !== null && worktree.id !== record.worktreeId)) throw new Error('Orca canonical 工作区身份不符');
}

async function writeLaunchers(directory, record) {
  const bin = join(directory, 'bin');
  const entry = join(record.companionRoot, 'dist/src/interfaces/cli/main.js');
  const node = process.execPath;
  const environment = `export PATH=${shellQuote(bin)}:"$PATH"\nexport GH_REPO=${shellQuote(record.githubRepository)}\n`;
  await writeFile(join(bin, 'orca'), `#!/bin/sh\nexec ${shellQuote(record.orcaExecutable)} "$@"\n`, { flag: 'wx', mode: 0o700 });
  await writeFile(join(bin, 'ocp'), `#!/bin/sh\n${environment}exec ${shellQuote(node)} ${shellQuote(entry)} "$@"\n`, { flag: 'wx', mode: 0o700 });
  await writeFile(join(bin, 'shell'), `#!/bin/sh\n${environment}cd ${shellQuote(record.repositoryPath)} || exit\nprintf '%s\\n' '运行 ocp 开始演练；需求和指南见仓库外 operator/。'\nexec /bin/bash --noprofile --norc -i\n`, { flag: 'wx', mode: 0o700 });
}

export async function readRun(path) {
  const directory = await externalPath(path);
  const record = await readJson(join(directory, 'run.json'), 64 * 1024);
  if (record?.schemaVersion !== 1 || record.kind !== 'ledger-lab-run' || !['main', 'cancel'].includes(record.profile) ||
    !['ready', 'failed', 'preparing'].includes(record.state) || record.repositoryPath !== join(directory, 'repo') ||
    record.branch !== 'refs/heads/main' || record.companionRoot !== await realpath(companionRoot) ||
    typeof record.githubRepository !== 'string' || !/^[A-Za-z0-9-]+\/ledger-lab-[A-Za-z0-9-]+$/u.test(record.githubRepository) ||
    typeof record.orcaExecutable !== 'string' || !isAbsolute(record.orcaExecutable) ||
    typeof record.orcaRepoId !== 'string' || typeof record.worktreeId !== 'string') throw new Error('演练记录身份或版本无效');
  if (await realpath(record.repositoryPath) !== record.repositoryPath) throw new Error('测试仓库路径已被替换');
  return { directory, ...record };
}

export async function openLab(options, dependencies = {}) {
  const record = await readRun(options.run);
  const env = cleanEnvironment(dependencies.env ?? process.env);
  const call = dependencies.call ?? await createCommandRunner({ env });
  const ref = (await call('git', ['symbolic-ref', 'HEAD'], { cwd: record.repositoryPath })).trim();
  const common = (await call('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: record.repositoryPath })).trim();
  const gitDir = (await call('git', ['rev-parse', '--absolute-git-dir'], { cwd: record.repositoryPath })).trim();
  const top = (await call('git', ['rev-parse', '--show-toplevel'], { cwd: record.repositoryPath })).trim();
  const remote = (await call('git', ['remote', 'get-url', 'origin'], { cwd: record.repositoryPath })).trim();
  if (ref !== record.branch || common !== gitDir || top !== record.repositoryPath || remote !== `https://github.com/${record.githubRepository}.git`) throw new Error('Git canonical 身份不符');
  const shown = await orcaCommand(call, record.orcaExecutable, ['worktree', 'show', '--worktree', `id:${record.worktreeId}`]);
  assertWorktree(shown.worktree, record);
  const terminal = await orcaCommand(call, record.orcaExecutable, ['terminal', 'create', '--worktree', `id:${record.worktreeId}`, '--title', record.id,
    '--command', shellQuote(join(record.directory, 'bin', 'shell')), '--focus']);
  return { ...record, terminalHandle: terminalHandle(terminal) };
}

export async function scopeForRun(record) {
  const { openRepositoryCoordinationStore } = await import('../../dist/src/bootstrap/composition.js');
  const opened = await openRepositoryCoordinationStore({ repositoryPath: record.repositoryPath, env: cleanEnvironment(), readOnly: true });
  if (opened.kind !== 'opened') throw new Error('尚未初始化 Scope；请先在 ocp Home 中完成初始化');
  try {
    const result = opened.store.query({ kind: 'scopes' });
    if (result.kind !== 'scopes') throw new Error('Scope 状态不可读');
    const matches = result.scopes.filter((scope) => scope.canonicalWorktreePath === record.repositoryPath && scope.fullBranchRef === record.branch);
    if (matches.length !== 1) throw new Error('找不到唯一的当前 canonical Scope；请先完成 Home 初始化');
    return matches[0].coordinationScopeId;
  } finally { opened.close(); }
}

export async function bindOperatorFiles(record, scopeId) {
  for (const [filename, field] of [['mapping.json', 'graphs'], ['observations.json', 'entries']]) {
    const path = join(record.directory, 'operator', filename);
    let value;
    try { value = await readJson(path); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await writeNewJson(path, { schemaVersion: 1, coordinationScopeId: scopeId, [field]: [] });
      continue;
    }
    if (value.schemaVersion !== 1 || !Array.isArray(value[field])) throw new Error('映射或观察模板结构无效');
    if (value.coordinationScopeId === scopeId) continue;
    if (value.coordinationScopeId !== '' || value[field].length !== 0) throw new Error('映射或观察尚未绑定本轮 Scope；请核对文件身份');
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeNewJson(temporary, { ...value, coordinationScopeId: scopeId });
    await rename(temporary, path);
  }
}
