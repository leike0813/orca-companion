import process from 'node:process';
import { lstat, open, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson } from './common.mjs';
import { assertLocalRepository, labError, readRun, saveRun } from './run-record.mjs';
import { cleanEnvironment, createCommandRunner, resolveOrcaExecutable } from './setup.mjs';

async function localTarget(record) {
  try {
    await lstat(record.repositoryPath);
    await assertLocalRepository(record);
    return { state: 'present', code: null };
  } catch (error) {
    if (error.code === 'ENOENT') return { state: 'absent', code: null };
    return { state: 'rejected', code: error.code ?? 'LAB_IDENTITY_MISMATCH' };
  }
}

async function remoteTarget(record, call) {
  if (!record.github.nodeId) return { state: 'unknown', code: 'LAB_IDENTITY_MISSING' };
  const [owner, name] = record.github.nameWithOwner.split('/');
  const query = 'query($id:ID!,$owner:String!,$name:String!){viewer{login} node(id:$id){... on Repository{id nameWithOwner url}} repository(owner:$owner,name:$name){id}}';
  let response;
  try {
    response = JSON.parse(await call('gh', ['api', 'graphql', '--hostname', record.github.host, '--input', '-'], {
      stdin: JSON.stringify({ query, variables: { id: record.github.nodeId, owner, name } }),
    }));
  } catch (error) {
    if (error.code !== 'LAB_COMMAND_FAILED' || !error.response) throw error;
    response = error.response;
  }
  if (!response.data?.viewer?.login || response.errors?.some(error =>
    error.type !== 'NOT_FOUND' || !['node', 'repository'].includes(error.path?.[0]))) {
    throw labError('LAB_OPERATION_UNKNOWN', '远程仓库可见性无法核验');
  }
  const node = response.data.node;
  if (!Object.hasOwn(response.data, 'node') || !Object.hasOwn(response.data, 'repository')) {
    return { state: 'unknown', code: 'LAB_OPERATION_UNKNOWN' };
  }
  if (node === null) {
    // A null node can mean lost access to a private repository, not deletion.
    if (response.data.repository) return { state: 'rejected', code: 'LAB_IDENTITY_MISMATCH' };
    if (response.data.repository === null && response.data.viewer.login.toLowerCase() === owner.toLowerCase()) return { state: 'absent', code: null };
    return { state: 'unknown', code: 'LAB_OPERATION_UNKNOWN' };
  }
  if (node?.id !== record.github.nodeId || node.nameWithOwner !== record.github.nameWithOwner ||
      response.data.repository?.id !== record.github.nodeId || node.url !== record.github.url) {
    return { state: 'rejected', code: 'LAB_IDENTITY_MISMATCH' };
  }
  return { state: 'present', code: null };
}

async function assertNoDebugWriter(record, environment) {
  const { debugStateDirectory, debugDirectoryId, debugSessionPaths, FileDebugSessionStore } =
    await import('../../dist/src/adapters/storage/debug-session-store.js');
  const stateDirectory = debugStateDirectory({ environment });
  const sessions = new FileDebugSessionStore({ stateDirectory }).list(debugDirectoryId(record.repositoryPath));
  if (sessions.kind !== 'ok') throw labError('LAB_RESOURCE_UNVERIFIABLE', sessions.message);
  for (const session of sessions.value) {
    const lock = debugSessionPaths(stateDirectory, session.coordinatorSessionId).writerLock;
    try {
      const metadata = await lstat(lock);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 64) {
        throw labError('LAB_RESOURCE_UNVERIFIABLE', `调试写者身份不可核验：${session.coordinatorSessionId}`);
      }
      const holder = await readJson(lock, 64);
      if (!Number.isSafeInteger(holder.pid) || holder.pid <= 0) throw labError('LAB_RESOURCE_UNVERIFIABLE', '调试写者 PID 无效');
      try { process.kill(holder.pid, 0); }
      catch (error) { if (error.code === 'ESRCH') continue; throw labError('LAB_RESOURCE_UNVERIFIABLE', '调试写者存活状态不可核验'); }
      throw labError('LAB_ACTIVE_RESOURCE', `请先退出调试会话 ${session.coordinatorSessionId}（PID ${holder.pid}）`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

async function assertNoRuntime(record, call, environment) {
  try { await lstat(join(record.repositoryPath, '.git')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const commonDir = (await call('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: record.repositoryPath })).trim();
  const { coordinationDatabasePath } = await import('../../dist/src/bootstrap/composition.js');
  try { await lstat(coordinationDatabasePath(commonDir)); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const { openRepositoryCoordinationStore } = await import('../../dist/src/bootstrap/composition.js');
  const opened = await openRepositoryCoordinationStore({ repositoryPath: record.repositoryPath, env: environment, readOnly: true });
  if (opened.kind !== 'opened') throw labError('LAB_RESOURCE_UNVERIFIABLE', '协调运行存储无法核验');
  try {
    const result = opened.store.query({ kind: 'scopes' });
    if (result.kind !== 'scopes') throw labError('LAB_RESOURCE_UNVERIFIABLE', 'Scope 列表不可读');
    for (const scope of result.scopes) {
      if (scope.canonicalWorktreePath !== record.repositoryPath) continue;
      const result = opened.store.query({ kind: 'leases', coordinationScopeId: scope.coordinationScopeId });
      if (result.kind !== 'leases') throw labError('LAB_RESOURCE_UNVERIFIABLE', '运行租约不可读');
      const active = result.leases.find(lease => lease.kind === 'runtime' && lease.releasedAt === null &&
        (lease.expiresAt === null || lease.expiresAt > Date.now()));
      if (active) throw labError('LAB_ACTIVE_RESOURCE', `请先退出 Coordinator Session ${active.coordinatorSessionId}`);
    }
  } finally { opened.close(); }
}

export async function assertInactive(record, { call, env = process.env } = {}) {
  await assertNoDebugWriter(record, env);
  const local = await localTarget(record);
  if (local.state === 'present') await assertNoRuntime(record, call, cleanEnvironment(env));
  let executable = record.orca?.executable;
  if (!executable) {
    try { executable = await resolveOrcaExecutable(env); }
    catch (error) {
      if (error.code === 'ENOENT' || error.message.startsWith('找不到可执行文件')) return;
      throw error;
    }
  }
  try {
    const response = JSON.parse(await call(executable, ['worktree', 'show', '--worktree',
      `path:${record.repositoryPath}`, '--json']));
    if (response.ok === false && response.error?.code === 'selector_not_found') return;
    const worktree = response.result?.worktree;
    if (response.ok !== true || !worktree || worktree.path !== record.repositoryPath) {
      throw labError('LAB_RESOURCE_UNVERIFIABLE', 'Orca 工作区登记不可核验');
    }
    throw labError('LAB_ACTIVE_RESOURCE', `请先关闭本轮终端/Worker 并解除登记：${executable} project setup-delete --setup ${worktree.repoId}`);
  } catch (error) {
    if (error.code === 'selector_not_found') return;
    throw error;
  }
}

export async function cleanupLab(options, dependencies = {}) {
  let record = await readRun(options.run);
  const environment = dependencies.env ?? process.env;
  const call = dependencies.call ?? await createCommandRunner({ env: { ...cleanEnvironment(environment), GH_HOST: 'github.com' }, signal: dependencies.signal });
  const retained = ['run.json', 'operator', 'packages', 'captures', 'checks'];
  const result = { kind: 'cleanup-preview', directory: record.directory, repositoryPath: record.repositoryPath,
    githubRepository: record.schemaVersion === 1 ? record.githubRepository : record.github.nameWithOwner, retained,
    local: { state: 'unknown', code: null }, remote: { state: 'unknown', code: null }, blockers: [] };
  if (record.schemaVersion === 1) {
    result.blockers.push({ code: 'LAB_IDENTITY_MISSING', message: '旧轮次缺少删除身份证明，请手工核验；原记录和证据保留' });
    if (options.yes) throw Object.assign(labError('LAB_IDENTITY_MISSING', result.blockers[0].message), { result });
    return result;
  }
  let lock;
  const lockPath = join(record.directory, 'cleanup.lock');
  if (options.yes) {
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (error) { throw labError(error.code === 'EEXIST' ? 'LAB_CLEANUP_BUSY' : 'LAB_RECORD_IO_ERROR', `回收锁不可用：${lockPath}`); }
  }
  const update = async (target, state, code = null) => {
    record.cleanup[target] = { state, code, observedAt: new Date().toISOString() };
    await saveRun(record.directory, record);
  };
  const assertNotCancelled = () => {
    if (dependencies.signal?.aborted) throw labError('LAB_CLEANUP_CANCELLED', '回收已取消；现场记录保留');
  };
  try {
    if (lock) record = await readRun(options.run);
    result.local = await localTarget(record);
    try { await (dependencies.assertInactive ?? assertInactive)(record, { call, env: environment }); }
    catch (error) { result.blockers.push({ code: error.code ?? 'LAB_RESOURCE_UNVERIFIABLE', message: error.message }); }
    try {
      result.remote = record.cleanup.remote.state === 'deleted'
        ? { state: 'deleted', code: null } : await remoteTarget(record, call);
    } catch (error) { result.remote = { state: 'unknown', code: error.code ?? 'LAB_OPERATION_UNKNOWN' }; }
    for (const [target, value] of [['local', result.local], ['remote', result.remote]]) {
      if (value.state === 'rejected') result.blockers.push({ code: value.code, message: `${target} 目标身份不匹配` });
    }
    if (!options.yes) return result;
    assertNotCancelled();
    result.kind = 'cleanup-result';
    if (result.blockers.length) {
      for (const target of ['local', 'remote']) {
        if (record.cleanup[target].state !== 'deleted' && result[target].state !== 'absent') {
          await update(target, 'rejected', result[target].code ?? result.blockers[0].code);
        }
      }
      throw Object.assign(labError(result.blockers[0].code, result.blockers[0].message), { result });
    }
    if (result.remote.state === 'absent') {
      await update('remote', 'deleted');
      result.remote = { state: 'deleted', code: null };
    } else if (result.remote.state === 'present') {
      await update('remote', 'deleting');
      try {
        assertNotCancelled();
        // Immediate identity recheck: drift or unverifiable visibility refuses before any DELETE is sent.
        const before = await remoteTarget(record, call);
        if (before.state === 'rejected') throw labError('LAB_IDENTITY_MISMATCH', '删除前远程目标已漂移，未发送 DELETE');
        if (before.state === 'unknown') throw labError(before.code ?? 'LAB_OPERATION_UNKNOWN', '删除前远程目标无法核验，未发送 DELETE');
        // GitHub GraphQL 没有 deleteRepository mutation，只能走 REST。
        if (before.state === 'present') {
          await call('gh', ['api', '--method', 'DELETE', '--hostname', record.github.host, `/repos/${record.github.nameWithOwner}`]);
        }
      } catch (error) {
        const code = error.code ?? 'LAB_OPERATION_UNKNOWN';
        await update('remote', code === 'LAB_IDENTITY_MISMATCH' ? 'rejected' : 'unknown', code);
        result.remote = { ...record.cleanup.remote };
        throw Object.assign(labError(code, '远程回收未确认；请查看原记录并在下次显式回收前核验'), { result });
      }
      try {
        // Only a fresh absence proof of the original node and owner/name turns `deleting` into `deleted`.
        const after = await remoteTarget(record, call);
        if (after.state !== 'absent') throw labError(after.code ?? 'LAB_OPERATION_UNKNOWN', 'DELETE 后无法证明原远程目标已删除');
        await update('remote', 'deleted');
        result.remote = { state: 'deleted', code: null };
      } catch (error) {
        // After a sent DELETE, only drift stays distinguishable; every other failure is an unknown outcome.
        const code = error.code === 'LAB_IDENTITY_MISMATCH' ? error.code : 'LAB_OPERATION_UNKNOWN';
        // A lost response or unreachable host never proves the delete landed, and nothing retries it.
        await update('remote', 'unknown', code);
        result.remote = { ...record.cleanup.remote };
        throw Object.assign(labError(code, 'DELETE 后远程状态不明，本地现场保留；请在下次显式回收前核验'), { result });
      }
    } else if (result.remote.state !== 'deleted') {
      const code = result.remote.code ?? 'LAB_OPERATION_UNKNOWN';
      await update('remote', 'unknown', code);
      if (code !== 'LAB_IDENTITY_MISSING') throw Object.assign(labError(code, '远程回收状态不明，已停止后续删除'), { result });
    }
    if (result.local.state === 'absent') {
      await update('local', 'deleted');
      result.local = { state: 'deleted', code: null };
    } else {
      await update('local', 'deleting');
      try {
        assertNotCancelled();
        await assertLocalRepository(record);
        await (dependencies.remove ?? (path => rm(path, { recursive: true })))(record.repositoryPath);
        const check = await localTarget(record);
        if (check.state !== 'absent') throw labError('LAB_OPERATION_UNKNOWN', '本地删除后仍有目录');
        await update('local', 'deleted');
        result.local = { state: 'deleted', code: null };
      } catch (error) {
        const code = error.code ?? 'LAB_COMMAND_FAILED';
        await update('local', 'failed', code);
        result.local = { ...record.cleanup.local };
        throw Object.assign(labError(code, '本地回收失败；远程结果和证据已保留'), { result });
      }
    }
    if (result.remote.state !== 'deleted') throw Object.assign(labError('LAB_IDENTITY_MISSING', '本地已回收；远程缺少身份证明，请手工核验'), { result });
    return result;
  } finally {
    if (lock) { await lock.close(); await unlink(lockPath); }
  }
}
