import process from 'node:process';
import { lstat, opendir, realpath, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalPath, readJson, writeNewJson } from './common.mjs';

export const companionRoot = fileURLToPath(new URL('../../', import.meta.url));
export const runsRootFor = (env = process.env) => join(env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local/state'), 'orca-companion', 'ledger-lab');
export const labError = (code, message) => Object.assign(new Error(message), { code });
const absolute = z.string().max(4096).refine(isAbsolute);
const identity = z.strictObject({ device: z.string().regex(/^\d+$/u), inode: z.string().regex(/^\d+$/u) });
const nameWithOwner = z.string().max(512).regex(/^[A-Za-z0-9-]+\/ledger-lab-[A-Za-z0-9-]+$/u);
const targetState = z.strictObject({
  state: z.enum(['pending', 'deleting', 'deleted', 'rejected', 'failed', 'unknown']),
  code: z.string().max(128).nullable(), observedAt: z.string().max(64).nullable(),
});
const base = {
  kind: z.literal('ledger-lab-run'), id: z.string().max(256).regex(/^ledger-lab-[A-Za-z0-9-]+$/u),
  profile: z.enum(['main', 'cancel']), repositoryPath: absolute, branch: z.literal('refs/heads/main'),
  companionRoot: absolute, state: z.enum(['ready', 'failed', 'preparing']), stage: z.string().min(1).max(128),
  baselineHead: z.string().max(128).nullable(), createdAt: z.string().max(64), failureCode: z.string().max(128).optional(),
};
const legacy = z.strictObject({
  ...base, schemaVersion: z.literal(1), githubRepository: nameWithOwner,
  orcaExecutable: absolute, orcaRepoId: z.string().max(256).nullable(), worktreeId: z.string().max(256).nullable(),
  terminalHandle: z.string().max(1024).nullable(), routeMapIssueNumber: z.number().int().positive().nullable(),
  sourceHead: z.string().max(128).nullable(), sourceDirty: z.boolean().nullable(),
});
const current = z.strictObject({
  ...base, schemaVersion: z.literal(2), localIdentity: identity.nullable(),
  github: z.strictObject({ host: z.literal('github.com'), nameWithOwner, url: z.string().url().max(2048).nullable(), nodeId: z.string().min(1).max(256).nullable() }),
  installation: z.strictObject({ packageVersion: z.string().min(1).max(128), packagePath: absolute,
    sourceHead: z.string().max(128), sourceDirty: z.boolean() }).nullable(),
  // 登记与主 checkout 核验先后发生：worktreeId 可空；terminalHandle 由本轮终端创建回执补入，旧记录缺省即可。
  orca: z.strictObject({ executable: absolute, repoId: z.string().min(1).max(256),
    worktreeId: z.string().min(1).max(256).nullable(), terminalHandle: z.string().min(1).max(1024).optional() }).nullable(),
  cleanup: z.strictObject({ local: targetState, remote: targetState }),
});
const schema = z.discriminatedUnion('schemaVersion', [legacy, current]);

export async function externalPath(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw labError('LAB_INVALID_PATH', '演练路径必须为绝对路径');
  const canonical = await canonicalPath(path);
  const rel = relative(await realpath(companionRoot), canonical);
  if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
    throw labError('LAB_INVALID_PATH', '演练路径必须在 Companion 仓库之外');
  }
  return canonical;
}

function validate(record, directory) {
  const parsed = schema.safeParse(record);
  if (!parsed.success || parsed.data.repositoryPath !== join(directory, 'repo')) {
    throw labError('LAB_INVALID_RECORD', '演练记录身份或版本无效');
  }
  const value = parsed.data;
  if (value.schemaVersion === 2 && value.installation &&
      !value.installation.packagePath.startsWith(`${join(directory, 'packages')}${sep}`)) {
    throw labError('LAB_INVALID_RECORD', '安装包路径不属于本轮次');
  }
  return value;
}

export async function readRun(path) {
  const directory = await externalPath(path);
  const filename = join(directory, 'run.json');
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw labError('LAB_INVALID_RECORD', '演练记录必须是普通文件');
  return { directory, ...validate(await readJson(filename, 64 * 1024), directory) };
}

export async function saveRun(directory, record) {
  const { directory: ignored, ...fields } = record;
  void ignored;
  const value = validate(fields, directory);
  const temporary = join(directory, `run-${randomUUID()}.tmp`);
  try {
    await writeNewJson(temporary, value);
    await rename(temporary, join(directory, 'run.json'));
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function localIdentity(path) {
  const metadata = await lstat(path, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw labError('LAB_IDENTITY_MISMATCH', '本地仓库不是原普通目录');
  return { device: String(metadata.dev), inode: String(metadata.ino) };
}

export async function assertLocalRepository(record) {
  if (record.schemaVersion === 2 && !record.localIdentity) throw labError('LAB_IDENTITY_MISSING', '未记录本地目录身份');
  const actual = await localIdentity(record.repositoryPath);
  if (await realpath(record.repositoryPath) !== record.repositoryPath || (record.schemaVersion === 2 &&
      (actual.device !== record.localIdentity.device || actual.inode !== record.localIdentity.inode))) {
    throw labError('LAB_IDENTITY_MISMATCH', '本地仓库目录已被替换');
  }
  return actual;
}

export async function listRuns(root = runsRootFor()) {
  const directory = await externalPath(root);
  const runs = [];
  let entries;
  try { entries = await opendir(directory); }
  catch (error) { if (error.code === 'ENOENT') return { root: directory, runs, truncated: false }; throw error; }
  let truncated = false;
  for await (const entry of entries) {
    if (!entry.name.startsWith('ledger-lab-') || !entry.isDirectory()) continue;
    if (runs.length === 100) { truncated = true; break; }
    const round = join(directory, entry.name);
    try {
      const record = await readRun(round);
      runs.push({ directory: round, id: record.id, profile: record.profile, repositoryPath: record.repositoryPath,
        state: record.state, stage: record.stage, cleanup: record.schemaVersion === 2 ? record.cleanup : null });
    } catch (error) {
      runs.push({ directory: round, error: error.code ?? 'LAB_INVALID_RECORD' });
    }
  }
  return { root: directory, runs, truncated };
}
