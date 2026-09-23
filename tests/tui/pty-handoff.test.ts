/**
 * 真实 PTY 的 Route Planning Handoff 验收（IP-11）。
 *
 * 这是 `m2-deliver-planning-tui` 里唯一需要真实 Orca、真实 Coordinator 模型与真实 PTY 的用例：它要在
 * 隔离项目里启动前台 TUI，经 Command Palette 走 prepare → review → cutover，再核对持久化事实。
 *
 * ```sh
 * ORCA_COMPANION_REAL_HARNESS=1 \
 * ORCA_COMPANION_REAL_REPO=<isolated-project> \
 * ORCA_COMPANION_REAL_IDENTITY=<dedicated-identity> \
 * ORCA_COMPANION_COORDINATOR_MODEL=minimax-cn/MiniMax-M3 \
 * pnpm exec vitest run tests/tui/pty-handoff.test.ts --no-file-parallelism
 * ```
 *
 * 未显式开启时整个文件只留一条 skip 记录：不解析身份、不调用 Orca、不打开数据库。隔离项目必须已经
 * 初始化过一个 Coordination Scope 且至少注册两个 Coordinator Session（Source 与 Target）。
 *
 * 已知前置缺口（实施记录，不在测试里绕过）：`src/bootstrap/tui-composition.ts` 对 planning handoff
 * 一律返回 `<capability>_unavailable` 的结构化拒绝（`ANCHORED_CAPABILITY_GAPS.planning_handoff`），
 * 因此当前实现下这条用例无法通过 TUI 真正完成 cutover。测试在这条缺口存在时 skip 并写明原因，而不是
 * 伪造通过；缺口消失后同一用例即可运行。
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

import { openCoordinationStore } from '../../src/adapters/storage/coordination-store.js';
import { openCheckpointStore } from '../../src/adapters/storage/checkpoint-store.js';
import type { CoordinatorSessionId } from '../../src/application/dto/identity.js';
import { resumePlanningHandoff } from '../../src/application/planning/planning-handoff.js';
import {
  coordinationDatabasePath,
  resolveGitCommonDir,
} from '../../src/bootstrap/composition.js';
import { checkpointDatabasePath } from '../../src/bootstrap/coordinator-runtime.js';
import { ANCHORED_CAPABILITY_GAPS } from '../../src/bootstrap/tui-capability-gaps.js';
import { toChildEnvironment } from '../../src/interfaces/cli/main.js';
import { COMMAND_IDS } from '../../src/interfaces/tui/components/command-palette.js';

const COMPANION_REPOSITORY = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const BUILT_ENTRY = join(COMPANION_REPOSITORY, 'dist', 'src', 'interfaces', 'cli', 'main.js');
const REAL_SWITCH = 'ORCA_COMPANION_REAL_HARNESS';
const WORKSPACE_VAR = 'ORCA_COMPANION_REAL_REPO';
const IDENTITY_VAR = 'ORCA_COMPANION_REAL_IDENTITY';
const MODEL_VAR = 'ORCA_COMPANION_COORDINATOR_MODEL';
/** 计划要求的 Coordinator 模型；凭据只留在 provider 环境变量里，本文件不读也不打印。 */
const REQUIRED_COORDINATOR_MODEL = 'minimax-cn/MiniMax-M3';

type Gate =
  | { readonly kind: 'run'; readonly workspace: string; readonly identity: string }
  | { readonly kind: 'skip'; readonly reason: string };

function evaluateGate(): Gate {
  if (process.env[REAL_SWITCH] !== '1') {
    return { kind: 'skip', reason: `${REAL_SWITCH} 未显式开启` };
  }
  const workspace = process.env[WORKSPACE_VAR];
  if (workspace === undefined || workspace.length === 0) {
    return { kind: 'skip', reason: `${WORKSPACE_VAR} 未显式选择隔离项目` };
  }
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
    return { kind: 'skip', reason: `${WORKSPACE_VAR} 指向的不是已存在的目录` };
  }
  if (resolve(workspace) === COMPANION_REPOSITORY) {
    return { kind: 'skip', reason: '隔离项目不得是 Companion 自身仓库' };
  }
  if (!existsSync(join(workspace, '.git'))) {
    return { kind: 'skip', reason: `${WORKSPACE_VAR} 不是 Git 仓库` };
  }
  const identity = process.env[IDENTITY_VAR];
  if (identity === undefined || identity.length === 0) {
    return { kind: 'skip', reason: `${IDENTITY_VAR} 未显式选择专用身份` };
  }
  return { kind: 'run', workspace: resolve(workspace), identity };
}

/* -------------------------------------------------------------------------- */
/* tmux PTY                                                                    */
/* -------------------------------------------------------------------------- */

const TMUX_BIN = existsSync('/usr/bin/tmux') ? '/usr/bin/tmux' : 'tmux';

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function tmux(
  socket: string,
  args: readonly string[],
  options: { readonly env?: NodeJS.ProcessEnv | undefined } = {},
): SpawnSyncReturns<string> {
  return spawnSync(TMUX_BIN, ['-L', socket, '-f', '/dev/null', ...args], {
    encoding: 'utf8',
    timeout: 10_000,
    ...(options.env === undefined ? {} : { env: options.env }),
  });
}

function capturePane(socket: string, session: string): string {
  const result = tmux(socket, ['capture-pane', '-p', '-t', session]);
  return result.status === 0 ? (result.stdout ?? '') : '';
}

function pollPane(
  socket: string,
  session: string,
  predicate: (text: string) => boolean,
  timeoutMs = 5_000,
): { readonly ok: boolean; readonly text: string } {
  const deadline = Date.now() + timeoutMs;
  let text = capturePane(socket, session);
  while (!predicate(text) && Date.now() < deadline) {
    sleepSync(100);
    text = capturePane(socket, session);
  }
  return { ok: predicate(text), text };
}

function quoteArgument(value: string): string {
  return JSON.stringify(value);
}

function probePty(): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  const socket = `orca-companion-handoff-probe-${String(process.pid)}`;
  try {
    const started = tmux(socket, ['new-session', '-d', '-s', 'probe', '-x', '80', '-y', '24', 'echo __PTY_PROBE__']);
    if (started.status !== 0) {
      return { ok: false, reason: `tmux 无法创建 PTY 会话：${(started.stderr ?? '').trim()}` };
    }
    const captured = pollPane(socket, 'probe', (text) => text.includes('__PTY_PROBE__'), 2_000);
    return captured.ok ? { ok: true } : { ok: false, reason: 'tmux 会话未产生可捕获输出' };
  } finally {
    tmux(socket, ['kill-server']);
  }
}

/* -------------------------------------------------------------------------- */
/* 断言辅助                                                                    */
/* -------------------------------------------------------------------------- */

function messageRole(message: unknown): string | null {
  if (typeof message !== 'object' || message === null) {
    return null;
  }
  const role = (message as { readonly role?: unknown }).role;
  return typeof role === 'string' ? role : null;
}

/** cutover 后 Target 仍未收到用户 Prompt：checkpoint 不存在或没有 user 消息。 */
function targetAwaitsUserPrompt(gitCommonDir: string, target: string): boolean {
  const path = checkpointDatabasePath(gitCommonDir);
  if (!existsSync(path)) {
    return true;
  }
  const opened = openCheckpointStore({ databasePath: path });
  if (opened.kind !== 'opened') {
    return true;
  }
  const sessionId = target as CoordinatorSessionId;
  if (opened.store.loadCheckpoint(sessionId).kind !== 'recovered') {
    return true;
  }
  return opened.store.readCommittedMessages(sessionId).every((message) => messageRole(message) !== 'user');
}

async function readCutoverFacts(workspace: string): Promise<{
  readonly phase: string;
  readonly target: string;
  readonly responsibility: string | null;
  readonly awaitingUserPrompt: boolean;
}> {
  const commonDir = await resolveGitCommonDir({
    repositoryPath: workspace,
    env: toChildEnvironment(process.env),
  });
  if (commonDir.kind !== 'resolved') {
    throw new Error(`无法解析隔离项目的 Git common dir：${commonDir.message}`);
  }
  const opened = openCoordinationStore({
    databasePath: coordinationDatabasePath(commonDir.path),
    readOnly: true,
  });
  if (opened.kind !== 'opened') {
    throw new Error(`无法只读打开隔离项目的 Coordination Store：${opened.message}`);
  }
  const store = opened.store;
  const scopes = store.query({ kind: 'scopes' });
  if (scopes.kind !== 'scopes' || scopes.scopes.length !== 1) {
    throw new Error('隔离项目必须恰好有一个 Coordination Scope');
  }
  const scope = scopes.scopes[0];
  if (scope === undefined) {
    throw new Error('隔离项目没有 Coordination Scope');
  }
  const coordinationScopeId = scope.coordinationScopeId;
  const resumed = resumePlanningHandoff({ store, coordinationScopeId });
  if (resumed.kind !== 'cutover_done') {
    return { phase: resumed.kind, target: '', responsibility: null, awaitingUserPrompt: false };
  }
  const responsibility = store.query({ kind: 'planning-responsibility', coordinationScopeId });
  const owner =
    responsibility.kind === 'planning-responsibility' ? responsibility.responsibility?.coordinatorSessionId ?? null : null;
  const target = resumed.proposal.targetCoordinatorSessionId;
  return {
    phase: resumed.kind,
    target,
    responsibility: owner,
    awaitingUserPrompt: targetAwaitsUserPrompt(commonDir.path, target),
  };
}

/* -------------------------------------------------------------------------- */
/* 用例                                                                        */
/* -------------------------------------------------------------------------- */

const gate = evaluateGate();

if (gate.kind === 'skip') {
  test.skip(`真实 PTY 规划 Handoff 未运行：${gate.reason}`, () => {});
} else {
  const pty = probePty();
  const handoffGap: string = ANCHORED_CAPABILITY_GAPS.planning_handoff;

  if (!pty.ok) {
    test.skip(`真实 PTY 规划 Handoff 未运行：${pty.reason}`, () => {});
  } else if (handoffGap.length > 0) {
    test.skip(
      `真实 PTY 规划 Handoff 未运行：TUI 装配层对 planning handoff fail closed（src/bootstrap/tui-composition.ts:325-332；${handoffGap}）`,
      () => {},
    );
  } else {
    test(
      '真实 PTY 中完成 Route Planning Handoff，cutover 后 Target 处于 awaiting_user_prompt',
      async () => {
        const declaredModel = process.env[MODEL_VAR];
        expect(declaredModel, `必须通过 ${MODEL_VAR} 显式声明 Coordinator 模型`).toBe(REQUIRED_COORDINATOR_MODEL);

        const socket = `orca-companion-handoff-${String(process.pid)}`;
        const session = 'handoff';
        const env: NodeJS.ProcessEnv = { ...process.env };
        const command = [process.execPath, BUILT_ENTRY].map(quoteArgument).join(' ');
        const handoffIndex = COMMAND_IDS.indexOf('handoff');
        expect(handoffIndex).toBeGreaterThanOrEqual(0);

        try {
          const started = tmux(socket, [
            'new-session', '-d', '-s', session, '-x', '120', '-y', '40',
            '-c', gate.workspace, command,
          ], { env });
          expect(started.status).toBe(0);

          const workspace = pollPane(socket, session, (text) => text.includes('composer ·'));
          expect(workspace.ok, `TUI 未在隔离项目中进入 workspace：\n${workspace.text}`).toBe(true);

          // Ctrl+P → 选中 `/handoff` → Enter prepare（Review 由 Controller 提案驱动）。
          tmux(socket, ['send-keys', '-t', session, 'C-p']);
          expect(pollPane(socket, session, (text) => text.includes('Command Palette')).ok).toBe(true);
          for (let index = 0; index < handoffIndex; index += 1) {
            tmux(socket, ['send-keys', '-t', session, 'Down']);
          }
          tmux(socket, ['send-keys', '-t', session, 'Enter']);
          const review = pollPane(socket, session, (text) => text.includes('Handoff Review'));
          expect(review.ok, `未进入 Handoff Review：\n${review.text}`).toBe(true);

          // Review 界面确认 cutover。
          tmux(socket, ['send-keys', '-t', session, 'Enter']);
          const cutover = pollPane(
            socket,
            session,
            (text) => text.includes('Target 发送下一条普通 Prompt'),
            10_000,
          );
          expect(cutover.ok, `未观察到 cutover 完成：\n${cutover.text}`).toBe(true);

          // 持久化事实：提案已 cutover，规划责任已转移到 Target，且 Target 尚未收到用户 Prompt。
          const facts = await readCutoverFacts(gate.workspace);
          expect(facts.phase).toBe('cutover_done');
          expect(facts.target.length).toBeGreaterThan(0);
          expect(facts.responsibility).toBe(facts.target);
          expect(facts.awaitingUserPrompt).toBe(true);
        } finally {
          tmux(socket, ['kill-server']);
        }
      },
      120_000,
    );
  }
}
