/* global console, process, setTimeout */
/**
 * 夹具看护：定期采样**执行事实**，在疑似卡死时提前告警并退出。
 *
 * 动机：真机验收最长可跑到 100 分钟截止，而实际卡死往往在头 10 分钟就发生了；此前只能等截止，白白
 * 耗掉一整轮。这里把「卡死」变成一件可以在几分钟内发现的事。
 *
 * 用法：
 *   node artifacts/watch-fixture.mjs <fixture-path> [poll-seconds] [stall-samples] [max-minutes] [scope-id]
 * 例：
 *   node artifacts/watch-fixture.mjs ~/Workspace/Artifact/orca-companion-e2e58 60 15 100
 *
 * 判据说明（重要）：
 * - 指纹只含**执行事实**：图版本、修订持有、物化绑定、交付结算、预算计数、交付结论、阻塞的 intent、
 *   Recovery 状态。**不含** `scope.revision`——驱动自己每轮 Pause→Resume 都会推进它，把它算进去会让
 *   任何静止状态看起来都「有变化」，那正是此前空转 244 轮没被发现的原因。
 * - 所以「连续 N 次采样（默认 15 次 × 60s ≈ 15 分钟）执行事实完全不变」= 疑似卡死；真实 Worker 单次
 *   会话通常 4–6 分钟，正常链路不会连续 15 分钟没有任何执行事实变化。
 * - 出现 `blocked` intent、pending/blocked Recovery 或交付结论时立即打印一行提示（不退出，除非拿到结论）。
 * - 拿到 `delivery_verdicts` ⇒ 打印 DONE 并退出 0；疑似卡死 ⇒ 打印 ALERT + 完整采样并退出 1；
 *   超过 max-minutes ⇒ 打印 WINDOW 并退出 0。
 *
 * 只读：store 以只读方式打开，不做任何写入。
 */
import { DatabaseSync } from 'node:sqlite';

const [fixture, pollSecondsRaw, stallSamplesRaw, maxMinutesRaw, scopeIdRaw] = process.argv.slice(2);
if (fixture === undefined) {
  console.error('用法: node artifacts/watch-fixture.mjs <fixture-path> [poll-seconds] [stall-samples] [max-minutes] [scope-id]');
  process.exit(2);
}
const pollMs = Math.max(5, Number(pollSecondsRaw ?? 60)) * 1000;
const stallSamples = Math.max(2, Number(stallSamplesRaw ?? 15));
const maxMs = Math.max(1, Number(maxMinutesRaw ?? 100)) * 60_000;
const scopeId = scopeIdRaw ?? 'e2e-loop-scope';

const storePath = `${fixture}/.git/orca-companion/coordination.sqlite`;
/**
 * 每次采样都重开连接：长驻的只读连接可能持有旧快照，把**已经发生的变化**看成「没有变化」，
 * 于是报出误告警（本文件第一版就是这样，17:42 报「9 分钟无变化」而交付在 17:43 就到了）。
 * 采样成本极低，重开是这里最省事、也最可靠的取新方式。
 */
const withStore = (read) => {
  let db;
  try {
    db = new DatabaseSync(storePath, { readOnly: true });
  } catch (error) {
    // 夹具还没建好（或已删除）不是卡死：如实记一行，继续等，而不是崩掉。
    return { unavailable: error instanceof Error ? error.message : String(error) };
  }
  try {
    return read((sql) => {
      try {
        return db.prepare(sql).all();
      } catch (error) {
        return [{ error: error instanceof Error ? error.message : String(error) }];
      }
    });
  } finally {
    db.close();
  }
};

const clock = () => new Date().toTimeString().slice(0, 8);

function sample() {
  return withStore((rows) => {
    const one = (sql) => rows(sql)[0] ?? {};
    return {
      graph: rows(`select graph_version, record_kind from graph_versions order by graph_version`),
      holds: rows(
        `select work_package_id, state, prior_contract_revision, admitted_contract_revision from revision_holds order by work_package_id`,
      ),
      bindings: one(`select count(*) as n, max(created_at) as newest from materialization_bindings`),
      newestBinding: one(
        `select work_package_id, role from materialization_bindings order by created_at desc limit 1`,
      ),
      settlements: one(`select count(*) as n, max(accepted_at) as newest from delivery_settlements`),
      counters: rows(`select budget_key, consumed from budget_counters order by budget_key`),
      verdicts: rows(`select verdict_kind from delivery_verdicts`),
      blockedIntents: one(`select count(*) as n from operation_intents where state = 'blocked'`),
      recoveries: rows(`select status, blocking_reason from recoveries order by updated_at desc`),
      control: one(`select control_state from scope where coordination_scope_id = '${scopeId}'`)['control_state'],
    };
  });
}

/**
 * 指纹只含执行事实。**必须排除** `control_state`（以及 `scope.revision`）：驱动每轮 Pause→Resume 都在
 * 改它们，把它们算进来会让任何静止状态都看起来「有变化」——这正是本项目此前空转 244 轮没被发现的原因，
 * 也是本文件第一版自己踩过的坑（冒烟测试当场看到 control 在 active/paused 之间翻转）。
 */
const fingerprint = (s) =>
  JSON.stringify({
    graph: s.graph,
    holds: s.holds,
    bindings: s.bindings,
    settlements: s.settlements,
    counters: s.counters,
    verdicts: s.verdicts,
    blockedIntents: s.blockedIntents,
    recoveries: s.recoveries,
  });
const brief = (s) => {
  const holds = s.holds.map((h) => `${h.work_package_id.split(':').pop()}:${h.state}`).join(',') || '-';
  const verdict = s.verdicts.map((v) => v.verdict_kind).join(',') || '-';
  return [
    `graph=v${s.graph.map((g) => g.graph_version).join('/')}`,
    `holds=[${holds}]`,
    `bindings=${String(s.bindings.n)}`,
    `settlements=${String(s.settlements.n)}`,
    `counters=${s.counters.map((c) => `${c.budget_key.split(':').slice(-2).join(':')}=${String(c.consumed)}`).join(',') || '-'}`,
    `verdict=${verdict}`,
    `blockedIntents=${String(s.blockedIntents.n)}`,
    `recoveries=${s.recoveries.map((r) => r.status).join(',') || '-'}`,
    `control=${String(s.control)}`,
  ].join(' ');
};

const startedAt = Date.now();
const heartbeatEvery = Math.max(1, Math.min(5, Math.floor(stallSamples / 3)));
let previous = null;
let unchanged = 0;
let lastHint = '';

console.log(`[watch] ${clock()} 开始看护 ${fixture}（每 ${String(pollMs / 1000)}s 采样，连续 ${String(stallSamples)} 次不变即告警）`);

for (;;) {
  const state = sample();
  if (state.unavailable !== undefined) {
    console.log(`[watch] ${clock()} 夹具暂不可读（${state.unavailable}），继续等待`);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    continue;
  }
  const current = fingerprint(state);
  if (current === previous) {
    unchanged += 1;
    // 心跳：没变化也要留下可读的进度行，否则日志一片安静，看不出「还在看」还是「已经死了」。
    if (unchanged % heartbeatEvery === 0) {
      console.log(
        `[watch] ${clock()} 心跳：执行事实已连续 ${String(unchanged)} 次采样（≈${String(Math.round((unchanged * pollMs) / 60_000))} 分钟）未变 ${brief(state)}`,
      );
    }
  } else {
    unchanged = 0;
    console.log(`[watch] ${clock()} ${brief(state)}`);
  }

  const verdict = state.verdicts.map((v) => v.verdict_kind).join(',');
  const hint = [
    state.blockedIntents.n > 0 ? `blocked intents=${String(state.blockedIntents.n)}` : '',
    state.recoveries.filter((r) => r.status !== 'recovered').map((r) => `recovery=${r.status}:${String(r.blocking_reason ?? '')}`),
  ]
    .flat()
    .filter((entry) => entry.length > 0)
    .join(' / ');
  if (hint.length > 0 && hint !== lastHint) {
    lastHint = hint;
    console.log(`[watch] ${clock()} 提示：${hint}`);
  }

  if (verdict.length > 0) {
    console.log(`[watch] ${clock()} DONE verdict=${verdict} ${brief(state)}`);
    process.exit(0);
  }
  if (unchanged >= stallSamples) {
    console.log(
      `[watch] ${clock()} ALERT 连续 ${String(unchanged)} 次采样（≈${String(Math.round((unchanged * pollMs) / 60_000))} 分钟）执行事实没有任何变化：疑似卡死`,
    );
    console.log(JSON.stringify(state, null, 2));
    console.log('下一步：看夹具日志与屏幕（宿主自己的 blocker 只在屏幕里），并用 artifacts/diag-revision-decision.mjs 复算判定。');
    process.exit(1);
  }
  if (Date.now() - startedAt > maxMs) {
    console.log(`[watch] ${clock()} WINDOW 看护窗口结束 ${brief(state)}`);
    process.exit(0);
  }

  previous = current;
  await new Promise((resolve) => setTimeout(resolve, pollMs));
}
