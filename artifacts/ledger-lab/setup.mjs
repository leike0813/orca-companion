import process from 'node:process';
import { access, copyFile, lstat, mkdir, readdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import { readJson, writeNewJson } from './common.mjs';
import {
  assertLocalRepository, companionRoot, externalPath, labError, listRuns, localIdentity, readRun, runsRootFor, saveRun,
} from './run-record.mjs';

export {
  assertLocalRepository, companionRoot, externalPath, labError, listRuns, localIdentity, readRun, runsRootFor, saveRun,
};

export const shellQuote = (value) => `'${value.replace(/'/gu, `'"'"'`)}'`;

// 只剥离已废弃的 GH_REPO 与身份类 ORCA_* 变量；GH_HOST 由准备显式钉到 github.com，必须保留。
export function cleanEnvironment(base = process.env) {
  return Object.fromEntries(Object.entries(base).filter(([key, value]) => value !== undefined &&
    !/^ORCA_(?:WORKTREE|REPO|PROJECT|TERMINAL|PANE|TAB|RUN|COORDINATOR|DISPATCH|TASK|WORKER|HOST|ENVIRONMENT|IDENTITY|CONSUMER|ATTEMPT|CONTEXT)(?:_|$)/u.test(key) && key !== 'GH_REPO'));
}

export async function findExecutable(command, env = process.env) {
  const candidates = command.includes('/') ? [resolve(command)] : (env.PATH || '').split(':').map((path) => resolve(join(path, command)));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); if ((await lstat(candidate)).isDirectory()) continue; return candidate; }
    catch (error) { if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) throw error; }
  }
  throw new Error(`找不到可执行文件：${command}`);
}

export async function resolveOrcaExecutable(env = process.env) {
  const command = env.ORCA_CLI_COMMAND || (env.ORCA_DEV_REPO_ROOT ? 'orca-dev' : env.ORCA_WORKTREE_ID ? 'orca' : 'orca-ide');
  return findExecutable(command, env);
}

/** 只保留已知安全结构化码（Orca 可能写在 stdout 或 stderr），原始输出永不进入错误消息。 */
function orcaErrorCode(result) {
  for (const stream of [result.stdout.text, result.stderr.text]) {
    try {
      const envelope = JSON.parse(stream.slice(-8 * 1024));
      if (envelope?.ok === false && envelope?.error?.code === 'selector_not_found') return 'selector_not_found';
    } catch { /* 非 JSON 输出不是结构化回执 */ }
  }
  return null;
}

/** 只在确定失败且 stdout 未截断时解析 gh GraphQL 载荷，供回收核对远程身份；错误消息从不包含它。 */
function graphqlResponse(executable, args, result) {
  if (!result.stdout.text.trim() || result.stdout.truncated) return undefined;
  if (executable !== 'gh' || args[0] !== 'api' || args[1] !== 'graphql') return undefined;
  try { return JSON.parse(result.stdout.text); } catch { return undefined; }
}

export async function createCommandRunner({ env, signal, runner } = {}) {
  const run = runner ?? (await import('../../dist/src/adapters/orca-cli/process-runner.js')).runProcess;
  return async (executable, args, options = {}) => {
    const result = await run({ executable, args, cwd: options.cwd ?? companionRoot, env: options.env ?? env ?? cleanEnvironment(),
      timeoutMs: options.timeoutMs ?? 60000, limits: { maxBytes: 1024 * 1024, maxLines: 20000 },
      ...(signal ? { signal } : {}), ...(options.stdin === undefined ? {} : { stdin: options.stdin }) });
    if (result.kind !== 'completed' || result.exitCode !== 0 || result.stdout.truncated || result.stderr.truncated) {
      // 输出被截断的 mutation 无法证明是否已生效，与超时/取消同样按结果不明处理，且不给结构化载荷。
      const determined = result.kind === 'completed' && !result.stdout.truncated && !result.stderr.truncated;
      const label = result.kind === 'completed' ? (determined ? String(result.exitCode) : 'truncated') : result.kind;
      const error = new Error(`外部命令失败：${executable.split('/').at(-1)} ${args[0] ?? ''}（${label}）`);
      error.code = determined ? orcaErrorCode(result) ?? 'LAB_COMMAND_FAILED' : 'LAB_OPERATION_UNKNOWN';
      if (determined) {
        const response = graphqlResponse(executable, args, result);
        if (response !== undefined) error.response = response;
      }
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

function assertCanonicalWorktree(worktree, { repositoryPath, branch, repoId, worktreeId }) {
  if (!worktree || typeof worktree.id !== 'string' || typeof worktree.repoId !== 'string' || worktree.path !== repositoryPath || worktree.branch !== branch ||
      worktree.isMainWorktree !== true || worktree.isBare === true || (repoId && worktree.repoId !== repoId) ||
      (worktreeId && worktree.id !== worktreeId)) throw new Error('Orca canonical 工作区身份不符');
}

function terminalHandle(result) {
  const handle = result.terminal?.handle ?? result.handle;
  if (typeof handle !== 'string' || !handle) throw new Error('Orca 终端句柄不可核验');
  return handle;
}

// --command 只在原生 shell 里补本轮安装的 bin 与确定的 Orca 可执行文件；不换 shell、不全局安装、不启动 ocp。
export const terminalCommand = (repositoryPath, executable) =>
  `export PATH=${shellQuote(join(repositoryPath, 'node_modules', '.bin'))}:"$PATH"; export ORCA_CLI_COMMAND=${shellQuote(executable)}`;

/** 只描述本轮终端里如何启动；不写回记录，也不代表模型能力或业务验收通过。 */
export const startupFor = (record) => ({ cwd: record.repositoryPath, command: 'ocp', debugCommand: 'ocp --debug',
  manual: ['在项目终端里运行 ocp，按启动引导配置 Coordinator、创建或选择 Route Map，最后确认初始化',
    '也可直接运行 ocp --debug 配置模型并调试对话；需要诊断报告时显式运行 ocp doctor'] });

/** 登记并核验 canonical 主 checkout；未知控制流或身份缺失时按不可核验拒绝。 */
async function registerRepository(call, executable, record) {
  let shown;
  try { shown = await orcaCommand(call, executable, ['worktree', 'show', '--worktree', `path:${record.repositoryPath}`]); }
  catch (error) {
    if (error.code !== 'selector_not_found' || record.orca) throw error;
    if (record.stage === 'orca-registration' && record.failureCode === 'LAB_OPERATION_UNKNOWN') {
      throw labError('LAB_OPERATION_UNKNOWN', '原仓库登记结果不明；请先在 Orca 核对原仓库再显式重开');
    }
    record.stage = 'orca-registration';
    record.failureCode = 'LAB_OPERATION_UNKNOWN';
    await saveRun(record.directory, record);
    const registered = await orcaCommand(call, executable, ['repo', 'add', '--path', record.repositoryPath]);
    if (typeof registered.repo?.id !== 'string' || registered.repo.path !== record.repositoryPath) {
      throw labError('LAB_OPERATION_UNKNOWN', 'Orca 仓库登记结果不可核验');
    }
    record.orca = { executable, repoId: registered.repo.id, worktreeId: null };
    await saveRun(record.directory, record);
  }
  if (shown) assertCanonicalWorktree(shown.worktree, { ...record, repoId: record.orca?.repoId, worktreeId: null });
  const repoId = record.orca?.repoId ?? shown?.worktree?.repoId;
  if (typeof repoId !== 'string' || !repoId) throw labError('LAB_OPERATION_UNKNOWN', 'Orca 仓库登记身份不可核验');
  record.orca = { ...record.orca, executable, repoId, worktreeId: null };
  await saveRun(record.directory, record);
  await orcaCommand(call, executable, ['repo', 'set-base-ref', '--repo', `id:${repoId}`, '--ref', 'origin/main']);
  shown = await orcaCommand(call, executable, ['worktree', 'show', '--worktree', `path:${record.repositoryPath}`]);
  assertCanonicalWorktree(shown.worktree, { ...record, repoId, worktreeId: null });
  record.orca = { ...record.orca, worktreeId: shown.worktree.id };
  await saveRun(record.directory, record);
  return record.orca;
}

async function createTerminal(call, executable, record, worktreeId) {
  record.state = 'preparing';
  record.stage = 'orca-terminal';
  record.failureCode = 'LAB_OPERATION_UNKNOWN';
  await saveRun(record.directory, record);
  try {
    const created = await orcaCommand(call, executable, ['terminal', 'create', '--worktree', `id:${worktreeId}`, '--title', record.id,
      '--command', terminalCommand(record.repositoryPath, executable), '--focus']);
    const handle = terminalHandle(created);
    record.orca = { ...record.orca, executable, repoId: record.orca.repoId, worktreeId, terminalHandle: handle };
    record.state = 'ready';
    record.stage = 'ready';
    delete record.failureCode;
    await saveRun(record.directory, record);
    return handle;
  } catch (error) {
    record.state = 'failed';
    record.failureCode = error.code === 'selector_not_found' ? error.code : 'LAB_OPERATION_UNKNOWN';
    await saveRun(record.directory, record);
    throw labError(record.failureCode, 'Orca 终端创建失败或结果不可核验');
  }
}

/** 只替换具有明确退出证据的终端；切换前再次核验其 live PTY 与 canonical worktree。 */
async function focusOrReplaceTerminal(call, executable, record) {
  const handle = record.orca.terminalHandle;
  let shown;
  try { shown = await orcaCommand(call, executable, ['terminal', 'show', '--terminal', handle]); }
  catch { throw labError('LAB_TERMINAL_UNVERIFIABLE', '原终端状态不可核验；请先在 Orca 中确认该终端再重试 open'); }
  if (shown.terminal?.handle !== handle) throw labError('LAB_TERMINAL_UNVERIFIABLE', 'Orca 回执的终端身份与记录不符');
  if (shown.terminal.worktreeId !== record.orca.worktreeId ||
      (shown.terminal.worktreePath !== undefined && shown.terminal.worktreePath !== record.repositoryPath)) {
    throw labError('LAB_TERMINAL_UNVERIFIABLE', 'Orca 终端不属于本轮 canonical 工作区');
  }
  const exited = shown.terminal.ptyId === null && ['operator_close', 'signaled', 'exited'].includes(shown.terminal.exitCause?.kind);
  if (exited) return createTerminal(call, executable, record, record.orca.worktreeId);
  if (typeof shown.terminal.ptyId !== 'string' || !shown.terminal.ptyId) {
    throw labError('LAB_TERMINAL_UNVERIFIABLE', '原终端存活状态不可核验；请先在 Orca 中确认该终端再重试 open');
  }
  const worktree = await orcaCommand(call, executable, ['worktree', 'show', '--worktree', `id:${record.orca.worktreeId}`]);
  assertCanonicalWorktree(worktree.worktree, { ...record, repoId: record.orca.repoId, worktreeId: record.orca.worktreeId });
  await orcaCommand(call, executable, ['terminal', 'switch', '--terminal', handle]);
  return handle;
}

/**
 * 准备建立仓库、仓库内安装环境、经公开命令登记 Orca 并打开原生项目终端（IP-07）：
 * 不读模型库与凭据、不写项目配置、不创建 Route Map、不跑 doctor。每个外部动作前先持久化阶段，结果不明时不自动重做。
 */
export async function prepareLab(options = {}, dependencies = {}) {
  if (process.platform !== 'linux') throw new Error('ledger-lab 一键准备当前只支持 Ubuntu 本机');
  const profile = options.profile ?? 'main';
  if (!['main', 'cancel'].includes(profile)) throw new Error('profile 必须为 main 或 cancel');
  const baseEnv = dependencies.env ?? process.env;
  const env = { ...cleanEnvironment(baseEnv), GH_HOST: 'github.com' };
  const call = dependencies.call ?? await createCommandRunner({ env, signal: dependencies.signal });
  await call('node', ['--version']);
  const pnpmVersion = (await call('pnpm', ['--version'])).trim();
  if (!/^\d+\./u.test(pnpmVersion) || Number(pnpmVersion.split('.')[0]) < 11) throw new Error('需要 pnpm 11 或更新版本');
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('需要 Node.js 24 或更新版本');
  for (const key of ['user.name', 'user.email']) {
    if (!(await call('git', ['config', '--get', key])).trim()) throw new Error('Git 作者身份未配置');
  }
  const account = await jsonCommand(call, 'gh', ['api', 'user']);
  if (typeof account?.login !== 'string' || !/^[A-Za-z0-9-]+$/u.test(account.login)) throw new Error('GitHub 账号不可核验');
  const orca = dependencies.orca ?? await resolveOrcaExecutable(baseEnv);
  const status = await orcaCommand(call, orca, ['status']);
  if (status.runtime?.reachable !== true) throw labError('LAB_ORCA_UNAVAILABLE', '请先启动本机 Orca');
  const root = await externalPath(options.root ?? runsRootFor(baseEnv));

  const id = `ledger-lab-${profile}-${new Date().toISOString().replace(/[-:.TZ]/gu, '')}-${randomUUID().slice(0, 8)}`;
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = join(root, id);
  await mkdir(directory, { mode: 0o700 });
  const repositoryPath = join(directory, 'repo');
  const record = { directory, schemaVersion: 2, kind: 'ledger-lab-run', id, profile, repositoryPath, branch: 'refs/heads/main',
    companionRoot: await realpath(companionRoot), state: 'preparing', stage: 'local-repository', baselineHead: null,
    createdAt: new Date().toISOString(), localIdentity: null,
    github: { host: 'github.com', nameWithOwner: `${account.login}/${id}`, url: null, nodeId: null },
    installation: null, orca: null,
    cleanup: { local: { state: 'pending', code: null, observedAt: null }, remote: { state: 'pending', code: null, observedAt: null } } };
  const stage = async (name) => {
    if (dependencies.signal?.aborted) throw labError('LAB_PREPARE_CANCELLED', '准备已取消');
    record.stage = name;
    await saveRun(directory, record);
    dependencies.progress?.(name);
    if (dependencies.signal?.aborted) throw labError('LAB_PREPARE_CANCELLED', '准备已取消');
  };
  await saveRun(directory, record);
  try {
    await mkdir(repositoryPath, { mode: 0o700 });
    record.localIdentity = await localIdentity(repositoryPath);
    await saveRun(directory, record);
    await call('git', ['init', '--initial-branch=main', repositoryPath]);
    await call('git', ['var', 'GIT_AUTHOR_IDENT'], { cwd: repositoryPath });
    for (const subdir of ['operator', 'captures', 'checks', 'packages']) await mkdir(join(directory, subdir), { mode: 0o700 });
    for (const filename of ['guide.md', 'prompts.md', 'contract.json', 'cases.json', 'mapping.example.json', 'observations.example.json']) {
      await copyFile(new URL(filename, import.meta.url), join(directory, 'operator', filename), constants.COPYFILE_EXCL);
    }
    await writeNewJson(join(directory, 'operator', 'mapping.json'), { schemaVersion: 1, coordinationScopeId: '', graphs: [] });
    await writeNewJson(join(directory, 'operator', 'observations.json'), { schemaVersion: 1, coordinationScopeId: '', entries: [] });
    const sourceHead = (await call('git', ['rev-parse', 'HEAD'])).trim();
    const sourceDirty = (await call('git', ['status', '--porcelain'])).trim().length > 0;

    await stage('github-repository');
    await call('gh', ['repo', 'create', record.github.nameWithOwner, '--private', '--disable-wiki']);
    const remote = await jsonCommand(call, 'gh', ['repo', 'view', record.github.nameWithOwner, '--json', 'nameWithOwner,visibility,url,id']);
    if (remote.nameWithOwner !== record.github.nameWithOwner || remote.visibility !== 'PRIVATE' || typeof remote.id !== 'string' || !remote.id) {
      throw new Error('新 GitHub 仓库身份或可见性不符');
    }
    record.github = { ...record.github, url: remote.url, nodeId: remote.id };
    await saveRun(directory, record);

    await stage('package');
    const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    await call('pnpm', ['pack', '--pack-destination', join(directory, 'packages')]);
    const tarballs = (await readdir(join(directory, 'packages'))).filter((name) => name.endsWith('.tgz'));
    if (tarballs.length !== 1) throw new Error('打包产物不可核验');
    const tarball = join(directory, 'packages', tarballs[0]);

    await stage('installation');
    await writeNewJson(join(repositoryPath, 'package.json'), { name: `ledger-lab-${profile}`, private: true,
      version: '0.0.0', type: 'module',
      devDependencies: { 'orca-companion': `file:../packages/${tarballs[0]}` } });
    // pnpm 11 把「依赖有 build script 但没放行」当安装失败；只放行 better-sqlite3 的预编译产物。
    await writeFile(join(repositoryPath, 'pnpm-workspace.yaml'), 'allowBuilds:\n  better-sqlite3: true\n', { flag: 'wx' });
    record.installation = { packageVersion: manifest.version, packagePath: tarball, sourceHead, sourceDirty };
    await saveRun(directory, record);
    await call('pnpm', ['install'], { cwd: repositoryPath, timeoutMs: 600000 });
    await call('pnpm', ['exec', 'ocp', '--help'], { cwd: repositoryPath, timeoutMs: 600000 });

    await stage('initial-push');
    await writeFile(join(repositoryPath, 'README.md'), '# ledger-lab\n\n本仓库只含演练环境安装文件；业务需求由用户在 Companion 中提交。\n', { flag: 'wx' });
    await writeFile(join(repositoryPath, '.gitignore'), 'node_modules/\n.env*\n', { flag: 'wx' });
    await mkdir(join(repositoryPath, 'openspec'), { mode: 0o700 });
    await writeFile(join(repositoryPath, 'openspec/config.yaml'), 'schema: spec-driven\n', { flag: 'wx' });
    await call('git', ['add', '--', 'README.md', '.gitignore', 'openspec/config.yaml', 'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml'], { cwd: repositoryPath });
    await call('git', ['commit', '-m', 'Initialize ledger-lab rehearsal environment'], { cwd: repositoryPath });
    record.baselineHead = (await call('git', ['rev-parse', 'HEAD'], { cwd: repositoryPath })).trim();
    await call('git', ['remote', 'add', 'origin', `https://github.com/${record.github.nameWithOwner}.git`], { cwd: repositoryPath });
    await call('git', ['config', '--local', 'credential.https://github.com.helper', ''], { cwd: repositoryPath });
    await call('git', ['config', '--local', '--add', 'credential.https://github.com.helper', '!gh auth git-credential'], { cwd: repositoryPath });
    await call('git', ['push', '--set-upstream', 'origin', 'main'], { cwd: repositoryPath });
    if ((await call('git', ['status', '--porcelain'], { cwd: repositoryPath })).trim()) throw new Error('测试仓库不是干净工作区');

    await stage('orca-registration');
    record.orca = await registerRepository(call, orca, record);
    await saveRun(directory, record);

    await stage('orca-terminal');
    record.orca = { ...record.orca, terminalHandle: await createTerminal(call, orca, record, record.orca.worktreeId) };
    await saveRun(directory, record);
    record.state = 'ready';
    await stage('ready');
    return { directory, ...record, startup: startupFor(record) };
  } catch (error) {
    record.state = 'failed';
    record.failureCode = error.code ?? 'LAB_PREPARE_FAILED';
    await saveRun(directory, record);
    throw labError(record.failureCode, `${error.message}；现场保留于 ${directory}（阶段 ${record.stage}）`);
  }
}

async function assertCanonicalGit(call, record) {
  const ref = (await call('git', ['symbolic-ref', 'HEAD'], { cwd: record.repositoryPath })).trim();
  const common = (await call('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: record.repositoryPath })).trim();
  const gitDir = (await call('git', ['rev-parse', '--absolute-git-dir'], { cwd: record.repositoryPath })).trim();
  const top = (await call('git', ['rev-parse', '--show-toplevel'], { cwd: record.repositoryPath })).trim();
  const remote = (await call('git', ['remote', 'get-url', 'origin'], { cwd: record.repositoryPath })).trim();
  const owner = record.schemaVersion === 1 ? record.githubRepository : record.github.nameWithOwner;
  if (ref !== record.branch || common !== gitDir || top !== record.repositoryPath || remote !== `https://github.com/${owner}.git`) {
    throw new Error('Git canonical 身份不符');
  }
}

/** schema 2 核验原 canonical Git、安装与登记身份：聚焦原终端，只有确定已退出才替换；不建 Scope、不动模型。 */
export async function openLab(options, dependencies = {}) {
  const record = await readRun(options.run);
  const env = cleanEnvironment(dependencies.env ?? process.env);
  const call = dependencies.call ?? await createCommandRunner({ env });
  // 先证明这是原目录，再读它的 Git：被替换的路径（含 symlink 目标）不进入后续核验。
  await assertLocalRepository(record);
  await assertCanonicalGit(call, record);
  if (record.schemaVersion === 1) {
    const shown = await orcaCommand(call, record.orcaExecutable, ['worktree', 'show', '--worktree', `id:${record.worktreeId}`]);
    assertCanonicalWorktree(shown.worktree, { ...record, repoId: record.orcaRepoId, worktreeId: record.worktreeId });
    const created = await orcaCommand(call, record.orcaExecutable, ['terminal', 'create', '--worktree', `id:${record.worktreeId}`,
      '--title', record.id, '--command', shellQuote(join(record.directory, 'bin', 'shell')), '--focus']);
    return { ...record, terminalHandle: terminalHandle(created) };
  }
  if (!record.installation) throw new Error('本轮没有可核验的安装来源');
  const installed = JSON.parse(await readFile(join(record.repositoryPath, 'node_modules', 'orca-companion', 'package.json'), 'utf8'));
  if (installed.version !== record.installation.packageVersion) throw new Error('仓库内安装版本与记录不符');
  // 已有绑定按原记录核验；旧轮次在显式 open 时补登记，不回退到当前环境的默认 Orca，也不猜最近工作区。
  const executable = record.orca?.executable ?? dependencies.orca ?? await resolveOrcaExecutable(env);
  const orca = !record.orca || !record.orca.worktreeId
    ? await registerRepository(call, executable, record)
    : record.orca;
  if (record.orca?.worktreeId) {
    const selector = orca.worktreeId ? `id:${orca.worktreeId}` : `path:${record.repositoryPath}`;
    const shown = await orcaCommand(call, executable, ['worktree', 'show', '--worktree', selector]);
    assertCanonicalWorktree(shown.worktree, { ...record, repoId: orca.repoId, worktreeId: orca.worktreeId });
  }
  if (record.stage === 'orca-terminal' && (record.failureCode === 'LAB_OPERATION_UNKNOWN' ||
      (record.state === 'preparing' && !orca.terminalHandle))) {
    throw labError('LAB_TERMINAL_UNVERIFIABLE', '终端创建结果不明；请先在 Orca 中核对原终端，再显式重开');
  }
  record.orca = orca;
  const handle = orca.terminalHandle ? await focusOrReplaceTerminal(call, executable, record)
    : await createTerminal(call, executable, record, orca.worktreeId);
  const bound = { ...record, orca: { ...record.orca, terminalHandle: handle } };
  if (JSON.stringify(bound.orca) !== JSON.stringify(record.orca)) await saveRun(record.directory, bound);
  return { ...bound, startup: startupFor(bound), terminalHandle: handle };
}

/** 用户登记后经公开 worktree 查询核验并保存绑定；未绑定时不猜最近工作区。 */
export async function bindOrcaForRun(record, dependencies = {}) {
  const env = cleanEnvironment(dependencies.env ?? process.env);
  const call = dependencies.call ?? await createCommandRunner({ env });
  // 已有绑定按原记录核验，不回退到当前环境的默认 Orca。
  const executable = record.orca?.executable ?? dependencies.orca ?? await resolveOrcaExecutable(env);
  const shown = await orcaCommand(call, executable, ['worktree', 'show', '--worktree', `path:${record.repositoryPath}`]);
  assertCanonicalWorktree(shown.worktree, { ...record, repoId: record.orca?.repoId, worktreeId: record.orca?.worktreeId });
  const orca = { executable, repoId: shown.worktree.repoId, worktreeId: shown.worktree.id,
    ...(record.orca?.terminalHandle ? { terminalHandle: record.orca.terminalHandle } : {}) };
  if (JSON.stringify(orca) === JSON.stringify(record.orca)) return record;
  const bound = { ...record, orca };
  await saveRun(record.directory, bound);
  return bound;
}

/** 唯一 Scope 入口：显式 `--scope` 也要证明是本轮 canonical Scope，然后只绑定一次 Orca。 */
export async function verifyScopeForRun(record, scopeId, dependencies = {}) {
  const matches = await scopesFor(record);
  if (scopeId !== undefined) {
    if (!matches.some((scope) => scope.coordinationScopeId === scopeId)) throw new Error('指定的 Scope 不属于本轮 canonical 工作区与分支');
  } else {
    if (matches.length !== 1) throw new Error('找不到唯一的当前 canonical Scope；请先完成 Home 初始化');
    scopeId = matches[0].coordinationScopeId;
  }
  if (record.schemaVersion === 2) await bindOrcaForRun(record, dependencies);
  return scopeId;
}

export const scopeForRun = (record, dependencies = {}) => verifyScopeForRun(record, undefined, dependencies);

async function scopesFor(record) {
  const { openRepositoryCoordinationStore } = await import('../../dist/src/bootstrap/composition.js');
  const opened = await openRepositoryCoordinationStore({ repositoryPath: record.repositoryPath, env: cleanEnvironment(), readOnly: true });
  if (opened.kind !== 'opened') throw new Error('尚未初始化 Scope；请先在 ocp Home 中完成初始化');
  try {
    const result = opened.store.query({ kind: 'scopes' });
    if (result.kind !== 'scopes') throw new Error('Scope 状态不可读');
    return result.scopes.filter((scope) => scope.canonicalWorktreePath === record.repositoryPath && scope.fullBranchRef === record.branch);
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
