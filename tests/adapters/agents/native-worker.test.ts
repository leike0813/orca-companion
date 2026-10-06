/**
 * native Worker harness（claude / pi / omp）启动与 Session 证明的行为合同。
 *
 * 只验证稳定可观察的行为：隔离状态根、非秘密启动面、逐 harness 的 pin 参数/环境、精确身份证明与
 * 活动分支读取。不锁定命令文案、日志或不相关的实现细节；不发起真实模型调用。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'vitest';

import {
  createNativeWorkerLaunch,
  inspectNativeTranscript,
  installNativeSessionStartReporter,
  nativeRecoveryInstructions,
  nativeTranscriptIdentity,
  proveNativeTranscript,
} from '../../../src/adapters/agents/native-worker.js';
import type { NativeHarness, NativeWorkerLaunchInput } from '../../../src/adapters/agents/native-worker.js';
import { modelSelectionFixture } from '../../support/model-configurations.js';

const roots: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const selection = modelSelectionFixture({ model: 'minimax/MiniMax-M3', effort: null, effortCapability: null, catalogSource: null });

function descriptorFor(stateRoot: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(stateRoot, 'codex-model-launch.json'), 'utf8')) as Record<string, unknown>;
}

function launchFor(harness: NativeHarness) {
  return (input: NativeWorkerLaunchInput) => createNativeWorkerLaunch(harness, input);
}

function baseInput(harness: NativeHarness, overrides: Partial<NativeWorkerLaunchInput> = {}): NativeWorkerLaunchInput {
  return {
    launchId: `${harness}:dispatch-1`,
    modelSelection: selection,
    sandboxMode: 'workspace-write',
    ...overrides,
  };
}

test('claude 使用原生 modelSelection 与 reporter 启动', async () => {
  const root = tempDir('companion-native-claude-');
  const worktree = join(root, 'worktree');
  mkdirSync(worktree, { recursive: true });
  const reporter = join(worktree, '.companion', 'claude-reporter.mjs');

  const strategy = launchFor('claude')(baseInput('claude', {
    reporterPath: reporter,
    sandboxMode: 'workspace-write',
  }));
  const prepared = await strategy.prepare({ worktreePath: worktree });
  const descriptor = descriptorFor(prepared.stateRoot);
  const args = descriptor['args'] as string[];

  expect(prepared.title).toMatch(/^orca-companion:claude:/u);
  expect(args).toContain('--model');
  expect(args[args.indexOf('--model') + 1]).toBe(selection.model);
  expect(args).toContain('--permission-mode');
  // --bare 会跳过 SessionStart hook，生产启动不得使用。
  expect(args).not.toContain('--bare');
  const settings = readFileSync(join(prepared.stateRoot, 'native-settings.json'), 'utf8');
  expect(settings).toContain(reporter);
  expect(settings).toContain('startup|resume');
  expect(prepared.command).toContain('codex-model-launcher.mjs');
});

test('claude resume 只按原 UUID 与原状态根恢复', async () => {
  const root = tempDir('companion-native-claude-resume-');
  const worktree = join(root, 'worktree');
  const originalRoot = join(root, 'original-claude-root');
  mkdirSync(worktree, { recursive: true });
  const sessionId = '0f0e0d0c-1b1a-4918-8877-665544332211';
  const transcriptRef = join(originalRoot, 'projects', 'x', `${sessionId}.jsonl`);
  mkdirSync(join(transcriptRef, '..'), { recursive: true });
  writeFileSync(transcriptRef, JSON.stringify({ sessionId, cwd: worktree }) + '\n');

  const strategy = launchFor('claude')(baseInput('claude', {
    resume: { sessionId, stateRoot: originalRoot, transcriptRef },
  }));
  const prepared = await strategy.prepare({ worktreePath: worktree });
  const args = descriptorFor(prepared.stateRoot)['args'] as string[];

  expect(prepared.stateRoot).not.toBe(originalRoot);
  expect(prepared.title).toMatch(/-resume:/u);
  expect(args[args.indexOf('--resume') + 1]).toBe(sessionId);
});

test('pi 使用原生 model selector 与确定性 session id', async () => {
  const root = tempDir('companion-native-pi-');
  const worktree = join(root, 'worktree');
  mkdirSync(worktree, { recursive: true });
  const reporter = join(worktree, '.companion', 'pi-reporter.mjs');
  const input = baseInput('pi', {
    reporterPath: reporter,
  });

  const prepared = await launchFor('pi')(input).prepare({ worktreePath: worktree });
  const descriptor = descriptorFor(prepared.stateRoot);
  const args = descriptor['args'] as string[];
  expect(args[args.indexOf('--extension') + 1]).toBe(reporter);
  expect(args).toContain('--session-id');
  expect(args[args.indexOf('--session-id') + 1]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/u);
  expect(args[args.indexOf('--model') + 1]).toBe('minimax/MiniMax-M3');
  expect(args).toContain('--session-id');
});

test('pi resume 用精确 session 文件路径，不用 --continue 或前缀', async () => {
  const root = tempDir('companion-native-pi-resume-');
  const worktree = join(root, 'worktree');
  const originalRoot = join(root, 'original-pi-root');
  mkdirSync(worktree, { recursive: true });
  const transcriptRef = join(originalRoot, 'sessions', '--w--', '2026_session-1.jsonl');
  writePiSession(transcriptRef, 'session-1', worktree, []);

  const prepared = await launchFor('pi')(baseInput('pi', {
    resume: { sessionId: 'session-1', stateRoot: originalRoot, transcriptRef },
  })).prepare({ worktreePath: worktree });
  const args = descriptorFor(prepared.stateRoot)['args'] as string[];

  expect(args[args.indexOf('--session') + 1]).toBe(transcriptRef);
  expect(args).not.toContain('--continue');
  expect(args).not.toContain('--session-id');
});

test('omp 用 provider/exact-id 与 --config，resume 走 -r 精确 fullpath', async () => {
  const root = tempDir('companion-native-omp-');
  const worktree = join(root, 'worktree');
  const originalRoot = join(root, 'original-omp-root');
  mkdirSync(worktree, { recursive: true });
  const transcriptRef = join(originalRoot, 'sessions', '--w--', 'session-1.jsonl');
  writePiSession(transcriptRef, 'session-1', worktree, []);
  const input = baseInput('omp', {
    resume: { sessionId: 'session-1', stateRoot: originalRoot, transcriptRef },
  });

  const prepared = await launchFor('omp')(input).prepare({ worktreePath: worktree });
  const descriptor = descriptorFor(prepared.stateRoot);
  const args = descriptor['args'] as string[];
  expect(args[args.indexOf('--model') + 1]).toBe('minimax/MiniMax-M3');
  expect(args[args.indexOf('-r') + 1]).toBe(transcriptRef);
  expect(args).toContain('--auto-approve');
});

test.each(['claude', 'pi', 'omp'] as const)('%s resume 拒绝不匹配或缺失的原会话且不写启动文件', async (harness) => {
  const root = tempDir('companion-native-resume-identity-');
  const workspace = join(root, 'workspace');
  const stateRoot = join(root, 'state');
  mkdirSync(workspace, { recursive: true });
  const sessionId = '0f0e0d0c-1b1a-4918-8877-665544332211';
  const transcriptRef = join(stateRoot, harness === 'claude' ? 'projects' : 'sessions', `${sessionId}.jsonl`);
  const input = baseInput(harness, {
    resume: { sessionId, stateRoot, transcriptRef },
  });
  await expect(launchFor(harness)(input).prepare({ worktreePath: workspace })).rejects.toThrow(/resume/u);
  mkdirSync(join(transcriptRef, '..'), { recursive: true });
  if (harness === 'claude') {
    writeFileSync(transcriptRef, JSON.stringify({ sessionId: 'other-session', cwd: workspace }) + '\n');
  } else {
    writePiSession(transcriptRef, 'other-session', workspace, []);
  }
  await expect(launchFor(harness)(input).prepare({ worktreePath: workspace })).rejects.toThrow(/resume/u);
  expect(existsSync(join(stateRoot, 'codex-model-launch.json'))).toBe(false);
});

test('状态根必须是绝对路径', async () => {
  const strategy = launchFor('pi')(baseInput('pi', { stateRoot: './relative' }));
  await expect(strategy.prepare({ worktreePath: '/tmp/native-worktree' })).rejects.toThrow(/绝对路径/u);
});

test('只读模式写出 readOnly 描述符，并在写盘前证明包装器可用', async () => {
  const root = tempDir('companion-native-readonly-');
  const worktree = join(root, 'worktree');
  const privateState = join(root, 'git-common', 'companion');
  mkdirSync(worktree, { recursive: true });
  mkdirSync(privateState, { recursive: true });
  let probed = 0;

  const prepared = await launchFor('pi')(baseInput('pi', {
    sandboxMode: 'read-only',
    stateRoot: privateState,
    assertReadOnlyWrapperAvailable: () => {
      probed += 1;
      return Promise.resolve();
    },
  })).prepare({ worktreePath: worktree });

  expect(probed).toBe(1);
  expect(descriptorFor(prepared.stateRoot)['readOnly']).toEqual({ workspace: worktree, stateRoot: prepared.stateRoot });
  // 只读包装器把 /tmp 设为只读：临时目录必须落在可写的状态根内。
  expect(existsSync(join(prepared.stateRoot, 'tmp'))).toBe(true);
  expect(descriptorFor(prepared.stateRoot)['runtimeReportPath']).toBe(join(prepared.stateRoot, 'native-runtime.json'));
  // 只读角色不在被检查的 canonical 工作区留下状态。
  expect(existsSync(join(worktree, '.companion'))).toBe(false);
});

test('只读包装器不可用时在任何写盘之前 fail closed', async () => {
  const root = tempDir('companion-native-readonly-fail-');
  const worktree = join(root, 'worktree');
  mkdirSync(worktree, { recursive: true });

  const strategy = launchFor('omp')(baseInput('omp', {
    sandboxMode: 'read-only-local-control',
    stateRoot: join(root, 'state'),
    assertReadOnlyWrapperAvailable: () => Promise.reject(new Error('bwrap 不可用')),
  }));

  await expect(strategy.prepare({ worktreePath: worktree })).rejects.toThrow(/bwrap/u);
  expect(existsSync(join(root, 'state'))).toBe(false);
});

/** 生成一个 pi/omp 形状的会话文件（首行 session header + 活动分支）。 */
function writePiSession(path: string, id: string, cwd: string, entries: readonly { id: string; parentId: string | null }[]): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const lines = [JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-10-06T00:00:00.000Z', cwd })];
  for (const entry of entries) {
    lines.push(JSON.stringify({ type: 'message', id: entry.id, parentId: entry.parentId, timestamp: '2026-10-06T00:00:01.000Z', message: { role: 'user', content: entry.id } }));
  }
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
}

/** extension 在上报时写出的精确 sidecar（仅 metadata）。 */
function writeLeafSidecar(transcriptPath: string, sessionId: string, leafId: string): void {
  writeFileSync(`${transcriptPath}.companion-leaf.json`, JSON.stringify({ harness: 'pi', sessionId, leafId }), 'utf8');
}

function removeLeafSidecar(transcriptPath: string): void {
  rmSync(`${transcriptPath}.companion-leaf.json`, { force: true });
}

test('pi transcript 证明要求 id、精确 path、状态根与绑定窗口全部一致', () => {
  const root = tempDir('companion-native-proof-pi-');
  const workspace = join(root, 'worktree');
  const stateRoot = join(root, 'state');
  mkdirSync(workspace, { recursive: true });
  const sessionId = '4e2a1c8b-0000-4000-8000-abcdefabcdef';
  const transcript = join(stateRoot, 'sessions', '--worktree--', `2026_${sessionId}.jsonl`);
  writePiSession(transcript, sessionId, workspace, [{ id: 'a', parentId: null }]);

  const report = {
    harness: 'pi',
    sessionId,
    transcriptPath: transcript,
    stateRoot,
    runtimeRoots: [stateRoot],
    cwd: workspace,
    observedAt: '2026-10-06T00:00:30.000Z',
  };
  const window = { dispatchStartedAt: '2026-10-06T00:00:00.000Z', bindingDeadlineAt: '2026-10-06T00:01:00.000Z' };

  expect(proveNativeTranscript('pi', { report, workspace, expectedStateRoot: stateRoot, ...window })).toMatchObject({
    kind: 'proven',
    proof: { providerSessionId: sessionId },
  });
  expect(proveNativeTranscript('pi', {
    report: { ...report, runtimeRoots: [] }, workspace, expectedStateRoot: stateRoot, ...window,
  })).toMatchObject({ kind: 'transcript_unavailable' });
  expect(proveNativeTranscript('pi', {
    report: { ...report, runtimeRoots: [join(root, 'missing-native-root')] }, workspace, expectedStateRoot: stateRoot, ...window,
  })).toMatchObject({ kind: 'transcript_unavailable' });

  // cwd 不一致 => 不可用。
  expect(proveNativeTranscript('pi', { report: { ...report, cwd: root }, workspace, expectedStateRoot: stateRoot, ...window })).toMatchObject(
    { kind: 'transcript_unavailable' },
  );
  // 观察早于 Dispatch 窗口 => 不可用。
  expect(proveNativeTranscript('pi', { report: { ...report, observedAt: '2026-10-05T23:59:00.000Z' }, workspace, expectedStateRoot: stateRoot, ...window })).toMatchObject(
    { kind: 'transcript_unavailable' },
  );
  // 首 transcript 延迟（文件尚未出现）=> 不可用，不猜测。
  expect(proveNativeTranscript('pi', {
    report: { ...report, transcriptPath: join(stateRoot, 'sessions', 'missing.jsonl') },
    workspace,
    expectedStateRoot: stateRoot,
    ...window,
  })).toMatchObject({ kind: 'transcript_unavailable' });
  // 会话头 id 与上报不一致 => 不可用。
  const otherId = '5f3b2d9c-0000-4000-8000-abcdefabcdef';
  const otherFile = join(stateRoot, 'sessions', '--other--', `2026_${sessionId}.jsonl`);
  writePiSession(otherFile, otherId, workspace, []);
  expect(proveNativeTranscript('pi', {
    report: { ...report, transcriptPath: otherFile },
    workspace,
    expectedStateRoot: stateRoot,
    ...window,
  })).toMatchObject({ kind: 'transcript_unavailable' });
  // 报告自称其它 harness => 拒绝，不因为 adapter 固定就信任来源。
  expect(proveNativeTranscript('pi', {
    report: { ...report, harness: 'claude' },
    workspace,
    expectedStateRoot: stateRoot,
    ...window,
  })).toMatchObject({ kind: 'transcript_unavailable' });
});

test('claude transcript 证明以文件内 sessionId/cwd 与精确 path 为准', () => {
  const root = tempDir('companion-native-proof-claude-');
  const workspace = join(root, 'worktree');
  const stateRoot = join(root, 'state');
  mkdirSync(workspace, { recursive: true });
  const sessionId = '6a4c3e0d-1111-4222-8333-abcdefabcdef';
  const transcript = join(stateRoot, 'projects', '--worktree--', `${sessionId}.jsonl`);
  mkdirSync(join(transcript, '..'), { recursive: true });
  // 真实 claude transcript 首行常是 file-history 快照，既没有 sessionId 也没有 cwd：
  // 身份证明必须继续有界扫描，而不是断言第一行。
  writeFileSync(transcript, [
    JSON.stringify({ type: 'file-history-snapshot', messageId: 'm0' }),
    JSON.stringify({ type: 'user', sessionId, cwd: workspace, uuid: 'u1' }),
    '',
  ].join('\n'), 'utf8');

  const report = { harness: 'claude', sessionId, transcriptPath: transcript, stateRoot, runtimeRoots: [stateRoot], cwd: workspace, observedAt: '2026-10-06T00:00:30.000Z' };
  const window = { dispatchStartedAt: '2026-10-06T00:00:00.000Z', bindingDeadlineAt: '2026-10-06T00:01:00.000Z' };

  expect(proveNativeTranscript('claude', { report, workspace, expectedStateRoot: stateRoot, ...window })).toMatchObject({ kind: 'proven' });
  expect(nativeTranscriptIdentity('claude', { transcriptRef: transcript, workspace })).toEqual({ providerSessionId: sessionId });
  expect(nativeTranscriptIdentity('claude', { transcriptRef: transcript, workspace: root })).toMatchObject({ kind: 'transcript_unavailable' });
});

test('逐 harness 的 recovery 读取配方区分分支树与线性文件', () => {
  const pi = nativeRecoveryInstructions('pi').join('\n');
  expect(pi).toContain('parentId');
  expect(pi).toContain('toEventRef');
  expect(pi).toContain('gaps');
  const omp = nativeRecoveryInstructions('omp').join('\n');
  expect(omp).toContain('parentId');
  const claude = nativeRecoveryInstructions('claude').join('\n');
  expect(claude).toContain('uuid');
  expect(claude).toContain('gaps');
  // 通用 Codex 配方（timestamp/ordinal 遍历全部行）不能用于 native。
  expect(pi).not.toContain('timestamp');
  expect(claude).not.toContain('ordinal');
});

test('pi/omp transcript 只按活动分支读取，不混入其它分支', async () => {
  const root = tempDir('companion-native-branch-');
  const workspace = join(root, 'worktree');
  mkdirSync(workspace, { recursive: true });
  const transcript = join(root, 'session.jsonl');
  writePiSession(transcript, 'session-1', workspace, [
    { id: 'a', parentId: null },
    { id: 'b', parentId: 'a' },
    { id: 'c', parentId: 'a' },
    { id: 'd', parentId: 'c' },
  ]);

  // 关键回归：文件最后一行（d）不是活动叶子。extension 的 sidecar 指向 b，
  // 因此只能读 a..b；绝不能按最后一行把历史分支 d 当成活动分支。
  writeLeafSidecar(transcript, 'session-1', 'b');
  expect(await inspectNativeTranscript('pi', transcript)).toMatchObject({
    kind: 'covered',
    evidence: { coverage: 'complete', readableRange: { fromEventRef: 'a', toEventRef: 'b' }, gaps: [] },
  });

  // 显式 leafId 覆盖 sidecar。
  expect(await inspectNativeTranscript('pi', transcript, 'd')).toMatchObject({
    kind: 'covered',
    evidence: { coverage: 'complete', readableRange: { fromEventRef: 'a', toEventRef: 'd' } },
  });
  // sidecar 与文件内会话头 id 不符 => 不可用，不按 mtime 或最后一行猜。
  writeLeafSidecar(transcript, 'other-session', 'b');
  expect(await inspectNativeTranscript('pi', transcript)).toMatchObject({ kind: 'transcript_unavailable' });
  // 既无显式 leafId 也无 sidecar => 不可用（不得退回文件最后一行）。
  removeLeafSidecar(transcript);
  expect(await inspectNativeTranscript('pi', transcript)).toMatchObject({ kind: 'transcript_unavailable' });
  // 叶子在文件里不存在 => 不可用。
  expect(await inspectNativeTranscript('pi', transcript, 'zzz')).toMatchObject({ kind: 'transcript_unavailable' });

  // 父链断裂或成环都不是「少一点历史」，而是身份不可证明。
  writePiSession(transcript, 'session-1', workspace, [
    { id: 'a', parentId: null },
    { id: 'b', parentId: 'missing' },
  ]);
  writeLeafSidecar(transcript, 'session-1', 'b');
  expect(await inspectNativeTranscript('pi', transcript)).toMatchObject({ kind: 'transcript_unavailable' });
  writePiSession(transcript, 'session-1', workspace, [
    { id: 'a', parentId: 'c' },
    { id: 'c', parentId: 'a' },
  ]);
  writeLeafSidecar(transcript, 'session-1', 'a');
  expect(await inspectNativeTranscript('pi', transcript)).toMatchObject({ kind: 'transcript_unavailable' });

  // 截断行 => partial，范围仍是活动分支，且不把正文复制进证据。
  writePiSession(transcript, 'session-1', workspace, [
    { id: 'a', parentId: null },
    { id: 'b', parentId: 'a' },
  ]);
  writeLeafSidecar(transcript, 'session-1', 'b');
  writeFileSync(transcript, `${readFileSync(transcript, 'utf8')}{"type":"message"`, 'utf8');
  expect(await inspectNativeTranscript('pi', transcript)).toMatchObject({
    kind: 'covered',
    evidence: {
      coverage: 'partial',
      readableRange: { fromEventRef: 'a', toEventRef: 'b' },
      gaps: [{ fromEventRef: 'line:4', toEventRef: null, reason: 'invalid_json' }],
    },
  });

  // 缺口后的可解析事件不能被报成连续历史的末端。
  writeFileSync(transcript, `${readFileSync(transcript, 'utf8')}\n${JSON.stringify({ id: 'c', parentId: 'b' })}\n`);
  writeLeafSidecar(transcript, 'session-1', 'c');
  expect(await inspectNativeTranscript('pi', transcript)).toMatchObject({ kind: 'transcript_unavailable' });
});

test('OMP 文件标题槽不造成转录缺口，未知无身份条目仍按缺口处理', async () => {
  const root = tempDir('companion-omp-title-');
  const transcript = join(root, 'session.jsonl');
  writePiSession(transcript, 'session-1', root, [{ id: 'a', parentId: null }]);
  writeLeafSidecar(transcript, 'session-1', 'a');
  const body = readFileSync(transcript, 'utf8');
  writeFileSync(transcript, JSON.stringify({ type: 'title', v: 1, title: '', updatedAt: '', pad: '' }) + '\n' + body);
  expect(await inspectNativeTranscript('omp', transcript)).toMatchObject({ kind: 'covered', evidence: { coverage: 'complete' } });
  writeFileSync(transcript, JSON.stringify({ type: 'unknown' }) + '\n' + body);
  expect(await inspectNativeTranscript('omp', transcript)).toMatchObject({ kind: 'covered', evidence: { coverage: 'partial' } });
});

test('reporter 可执行并写出完整的一行身份报告', () => {
  const root = tempDir('companion-native-reporter-');
  const reporterPath = join(root, 'claude-reporter.mjs');
  const reportPath = join(root, 'report.jsonl');
  installNativeSessionStartReporter('claude', { stateRoot: root, reporterPath, reportPath });
  const event = { session_id: 'session-1', transcript_path: '/tmp/session-1.jsonl', cwd: '/tmp/worktree' };
  const stdout = execFileSync(process.execPath, [reporterPath], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: root },
  });

  expect(JSON.parse(stdout)).toEqual({});
  expect(JSON.parse(readFileSync(reportPath, 'utf8').trim())).toMatchObject({
    sessionId: 'session-1',
    transcriptPath: '/tmp/session-1.jsonl',
    stateRoot: root,
    runtimeRoots: [root],
    cwd: '/tmp/worktree',
  });
});

test('pi/omp reporter 在回合结束与切换分支后更新精确活动叶子', () => {
  const root = tempDir('companion-native-extension-');
  for (const harness of ['pi', 'omp'] as const) {
    const reporterPath = join(root, `${harness}-reporter.mjs`);
    const reportPath = join(root, `${harness}.jsonl`);
    installNativeSessionStartReporter(harness, { stateRoot: root, reporterPath, reportPath });
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { existsSync, readFileSync, writeFileSync } from 'node:fs';
      import { pathToFileURL } from 'node:url';
      const { default: install } = await import(pathToFileURL(${JSON.stringify(reporterPath)}));
      const handlers = new Map();
      install({ on: (name, handler) => handlers.set(name, handler) });
      let leaf = 'a';
      const transcriptPath = ${JSON.stringify(join(root, `${harness}-session.jsonl`))};
      const ctx = { sessionManager: {
        getHeader: () => ({ cwd: ${JSON.stringify(root)} }),
        getSessionId: () => 'session-1', getSessionFile: () => transcriptPath, getLeafId: () => leaf,
      } };
      handlers.get('session_start')({}, ctx);
      if (existsSync(${JSON.stringify(reportPath)})) throw new Error('premature session report');
      writeFileSync(transcriptPath, JSON.stringify({ type: 'session', id: 'session-1' }) + '\\n');
      await new Promise((resolve) => setTimeout(resolve, 300));
      leaf = 'b';
      handlers.get('turn_end')({}, ctx);
      leaf = 'a';
      handlers.get('session_tree')({}, ctx);
      process.stdout.write(readFileSync(transcriptPath + '.companion-leaf.json', 'utf8'));
    `], { encoding: 'utf8' });
    expect(JSON.parse(output)).toMatchObject({ harness, sessionId: 'session-1', leafId: 'a' });
    expect(readFileSync(reportPath, 'utf8').trim().split('\n')).toHaveLength(3);
  }
});
