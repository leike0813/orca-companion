/**
 * `complete-tui-graph-basis` IP-05 / D06：从一次隔离运行的现场统计每角色 usage。
 *
 * 用法：`node collect-usage.mjs <fixture-path>`
 *
 * 只读指定 fixture 的 Companion coordination.sqlite 与其私有 codex 状态根。角色只由
 * materialization launch binding 的 launch_id 绑定；没有绑定的会话（包括 Finalizer）归为
 * `unbound`。请求数没有可靠的 rollout 级请求标识，因此始终报告 unavailable。Token 用量只读
 * 结构化 token_count.info：优先取最后的累计 total_token_usage；只有一个 last_token_usage
 * 快照时才允许使用它。不会读取正文、任务信封、cwd 或用户级 Codex 状态。
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';

const [fixtureArgument] = process.argv.slice(2);
if (fixtureArgument === undefined) {
  process.stderr.write('用法：node collect-usage.mjs <fixture-path>\n');
  process.exit(1);
}
const fixture = resolve(fixtureArgument);

const commonDirResult = spawnSync('git', ['-C', fixture, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
  encoding: 'utf8',
});
if (commonDirResult.status !== 0) {
  process.stderr.write(`无法解析 Git common dir：${(commonDirResult.stderr ?? '').trim()}\n`);
  process.exit(1);
}
const stateRoot = join(commonDirResult.stdout.trim(), 'orca-companion');
const databasePath = join(stateRoot, 'coordination.sqlite');
if (!existsSync(databasePath)) {
  process.stderr.write(`找不到协调库：${databasePath}\n`);
  process.exit(1);
}

const database = new DatabaseSync(databasePath, { readOnly: true });
const bindings = database
  .prepare(
    `select work_package_id, role, utility_role, dispatch_id, orca_task_id, launch_id
       from materialization_bindings where launch_id is not null`,
  )
  .all();
const recoveryRecords = database.prepare('select count(*) as count from recoveries').get().count;
database.close();

const roleByStateRoot = new Map();
for (const binding of bindings) {
  const hasRole = typeof binding.role === 'string' && binding.role.length > 0;
  const hasUtilityRole = typeof binding.utility_role === 'string' && binding.utility_role.length > 0;
  const role = hasRole === hasUtilityRole ? 'unbound' : hasRole ? binding.role : binding.utility_role;
  const digest = createHash('sha256').update(String(binding.launch_id)).digest('hex').slice(0, 20);
  const existing = roleByStateRoot.get(digest);
  roleByStateRoot.set(digest, existing === undefined || existing === role ? role : 'unbound');
}

const byRole = new Map();
function bucket(role) {
  const existing = byRole.get(role) ?? {
    sessions: 0,
    modelIds: new Set(),
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    tokenSessions: 0,
    unavailableTokenSessions: 0,
  };
  byRole.set(role, existing);
  return existing;
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function decodeUsage(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const inputTokens = nonNegativeInteger(value.input_tokens);
  const cachedInputTokens = nonNegativeInteger(value.cached_input_tokens);
  const outputTokens = nonNegativeInteger(value.output_tokens);
  if (inputTokens === null || cachedInputTokens === null || outputTokens === null) return null;
  return { inputTokens, cachedInputTokens, outputTokens };
}

function addUsage(entry, usage) {
  entry.inputTokens += usage.inputTokens;
  entry.cachedInputTokens += usage.cachedInputTokens;
  entry.outputTokens += usage.outputTokens;
  entry.tokenSessions += 1;
}

function collectRollout(path, entry) {
  const tokenSnapshots = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    const payload = record?.type === 'event_msg' ? record.payload : null;
    if (payload?.type === 'token_count') {
      const info = payload.info;
      if (info !== null && typeof info === 'object' && !Array.isArray(info)) {
        tokenSnapshots.push(info);
      }
    }

    const model = payload?.model ?? (record?.type === 'session_meta' || record?.type === 'turn_context'
      ? record.payload?.model : undefined);
    if (typeof model === 'string' && model.length > 0) entry.modelIds.add(model);
  }

  if (tokenSnapshots.length === 0) {
    entry.unavailableTokenSessions += 1;
    return;
  }

  const latest = tokenSnapshots.at(-1);
  const cumulative = decodeUsage(latest.total_token_usage);
  if (cumulative !== null) {
    addUsage(entry, cumulative);
    return;
  }

  if (tokenSnapshots.length === 1) {
    const last = decodeUsage(latest.last_token_usage);
    if (last !== null) {
      addUsage(entry, last);
      return;
    }
  }

  entry.unavailableTokenSessions += 1;
}

const codexRoot = join(stateRoot, 'codex');
if (existsSync(codexRoot)) {
  for (const dirent of readdirSync(codexRoot, { withFileTypes: true, encoding: 'utf8' })) {
    if (!dirent.isDirectory()) continue;
    const sessions = join(codexRoot, dirent.name, 'sessions');
    if (!existsSync(sessions)) continue;
    const role = roleByStateRoot.get(dirent.name) ?? 'unbound';
    for (const name of readdirSync(sessions, { recursive: true, encoding: 'utf8' })) {
      if (!/rollout-.*\.jsonl$/u.test(name)) continue;
      const entry = bucket(role);
      entry.sessions += 1;
      collectRollout(join(sessions, name), entry);
    }
  }
}

const roles = [...byRole.entries()]
  .map(([role, entry]) => ({
    role,
    sessions: entry.sessions,
    requests: { status: 'unavailable', reason: 'rollout 没有可无歧义计数的请求标识' },
    modelIds: [...entry.modelIds].sort(),
    tokenUsage: {
      status:
        entry.unavailableTokenSessions === 0
          ? 'available'
          : entry.tokenSessions === 0
            ? 'unavailable'
            : 'partial',
      inputTokens: entry.inputTokens,
      cachedInputTokens: entry.cachedInputTokens,
      outputTokens: entry.outputTokens,
      measuredSessions: entry.tokenSessions,
      unavailableSessions: entry.unavailableTokenSessions,
    },
  }))
  .sort((left, right) => left.role.localeCompare(right.role));

const tokenTotals = roles.reduce(
  (sum, entry) => ({
    inputTokens: sum.inputTokens + entry.tokenUsage.inputTokens,
    cachedInputTokens: sum.cachedInputTokens + entry.tokenUsage.cachedInputTokens,
    outputTokens: sum.outputTokens + entry.tokenUsage.outputTokens,
    measuredSessions: sum.measuredSessions + entry.tokenUsage.measuredSessions,
    unavailableSessions: sum.unavailableSessions + entry.tokenUsage.unavailableSessions,
  }),
  { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, measuredSessions: 0, unavailableSessions: 0 },
);

process.stdout.write(
  `${JSON.stringify(
    {
      fixture,
      materializationBindings: bindings.length,
      recoveryRecords,
      roles,
      totals: {
        sessions: roles.reduce((sum, entry) => sum + entry.sessions, 0),
        requests: { status: 'unavailable', reason: 'rollout 没有可无歧义计数的请求标识' },
        tokenUsage: tokenTotals,
      },
      note: 'tokenUsage 优先使用最后一个结构化累计 total_token_usage；仅单快照时才使用 last_token_usage。',
    },
    null,
    2,
  )}\n`,
);
