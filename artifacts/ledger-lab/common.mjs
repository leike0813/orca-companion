import { readFile, stat, realpath, mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative, dirname, sep } from 'node:path';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';

export const contract = JSON.parse(await readFile(new URL('./contract.json', import.meta.url), 'utf8'));
export const statuses = ['PASS', 'FAIL', 'BLOCKED', 'NOT_COVERED', 'INCONCLUSIVE'];
export function summarize(checks) {
  return Object.fromEntries(statuses.map((status) => [status, checks.filter((check) => check.status === status).length]));
}
export function overall(checks) {
  if (checks.some((check) => check.status === 'FAIL')) return 'FAIL';
  if (checks.some((check) => check.status === 'BLOCKED')) return 'BLOCKED';
  if (!checks.length || checks.some((check) => check.status !== 'PASS')) return 'INCONCLUSIVE';
  return 'PASS';
}
export async function readJson(path, maxBytes = 8 * 1024 * 1024) {
  if ((await stat(path)).size > maxBytes) throw new Error('输入文件超过读取上限');
  const body = await readFile(path, 'utf8');
  if (Buffer.byteLength(body) > maxBytes) throw new Error('输入文件超过读取上限');
  return JSON.parse(body);
}
// Resolve existing ancestors too: an output directory symlink must not lead back into the DUT.
export async function canonicalPath(path) {
  const absolute = resolve(path);
  try { return await realpath(absolute); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return resolve(await canonicalPath(parent), relative(parent, absolute));
  }
}
export async function assertExternal(path, repositoryPath) {
  const target = await canonicalPath(path);
  const root = await realpath(repositoryPath);
  const rel = relative(root, target);
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep))) {
    throw new Error('验收输出必须在待测仓库之外');
  }
  return target;
}
export async function writeNewJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}
