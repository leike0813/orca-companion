/**
 * IP-07 / D08：secretless Codex 启动的真实证据采集（一次性、隔离）。
 *
 * 只证明一件事：经生产 createCodexWorkerLaunch 启动的真实 Codex 会话，拿到的是批准的
 * provider/model/effort，并且 managed key 只经子进程环境注入。复用生产 launcher、真实凭据文件、
 * 真实 Orca terminal 与真实 SessionStart reporter + transcript，不另造启动路径。
 *
 * 秘密纪律（与单测一致，不因「真实环境」放宽）：
 * - key 只从 .env.smoke 读入内存，写进临时 0600 CredentialStore 后从不再读取或打印；
 * - 不打印 key、HTTP header、原始 argv 或完整 env；证据只含安全元数据；
 * - 不接触主项目或其 threads：仓库、worktree、terminal 全部新建在临时目录并用完即删；
 * - 失败只回报结构化 code，不把子进程输出原样带出。
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createCodexWorkerLaunch, installCodexSessionStartReporter } from '../../dist/src/adapters/agents/codex-launch.js';
import { JsonCredentialStore } from '../../dist/src/adapters/storage/credential-store.js';
import { proveCodexTranscript } from '../../dist/src/adapters/agents/codex-transcript.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUTPUT_PATH = join(REPO_ROOT, 'artifacts', 'model-configuration', 'real-startup.json');

/** 短只读 prompt：只要一句固定回复，足以产生真实 assistant turn。 */
const READ_ONLY_PROMPT = 'Reply with exactly: READY';

function fail(code, detail) {
  const error = new Error(detail === undefined ? code : code + ': ' + detail);
  error.safeCode = code;
  throw error;
}

/** 读取 .env.smoke；只取需要的键，值不进日志。 */
function readSmokeEnv(path) {
  const values = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    values.set(trimmed.slice(0, index).trim(), trimmed.slice(index + 1).trim());
  }
  return values;
}

function orca(args, options = {}) {
  try {
    return JSON.parse(execFileSync('orca', args, { encoding: 'utf8', timeout: options.timeoutMs ?? 60000 }));
  } catch {
    return null;
  }
}

/**
 * Codex 把 `/responses` 追加到 `base_url` 上，因此 base_url 必须是 API 根（含 /v1）。
 * 直接用 .env.smoke 里的裸主机名会打到 `https://<host>/responses` 并 404。
 * 只在本隔离脚本里显式补，不改生产配置语义。
 */
function withV1(url) {
  const trimmed = url.replace(/\/+$/u, '');
  return trimmed.endsWith('/v1') ? trimmed : trimmed + '/v1';
}

/** orca 回执：ok=false 与进程失败都算失败，并给出脱敏后的原因（不原样转发子进程输出）。 */
function orcaCall(args, options = {}) {
  const parsed = orca(args, options);
  if (parsed === null) return { ok: false, reason: 'orca_command_failed', result: null };
  if (parsed.ok !== true) return { ok: false, reason: 'orca_rejected', result: null };
  return { ok: true, reason: null, result: parsed.result ?? null };
}

function sleep(ms) {
  execFileSync('sleep', [String(ms / 1000)]);
}

async function main() {
  const envPath = join(REPO_ROOT, '.env.smoke');
  if (!existsSync(envPath)) fail('smoke_env_missing');
  const env = readSmokeEnv(envPath);
  const secret = env.get('COORDINATOR_SMOKE_API_KEY') ?? '';
  if (secret.length === 0) fail('smoke_key_missing');
  const rawBaseUrl = env.get('COORDINATOR_SMOKE_RESPONSES_BASE_URL') || env.get('COORDINATOR_SMOKE_OPENAI_BASE_URL') || '';
  const baseUrl = withV1(rawBaseUrl);
  const model = env.get('COORDINATOR_SMOKE_RESPONSES_MODEL') || env.get('COORDINATOR_SMOKE_OPENAI_MODEL') || '';
  if (rawBaseUrl.length === 0 || model.length === 0) fail('smoke_endpoint_missing');

  const fixture = mkdtempSync(join(tmpdir(), 'companion-real-launch-'));
  const evidence = {
    kind: 'codex-secretless-real-launch',
    observedAt: new Date().toISOString(),
    isolation: { fixtureRootIsTemporary: fixture.startsWith(tmpdir()), mainProjectTouched: false, threadsTouched: false },
    modelConfiguration: { providerId: 'companion_minimax', model, effort: 'low', credentialKind: 'managed' },
    secretHandling: { source: '.env.smoke', heldInMemoryOnly: true, persistedToTemporaryStore: true, printedAnywhere: false },
    steps: [],
    verdict: 'unknown',
  };
  const step = (name, ok, detail) => evidence.steps.push({ name, ok, ...(detail === undefined ? {} : { detail }) });

  let terminalHandle = null;
  let registered = false;
  try {
    // 一次性 git 项目：全新目录，不复用主项目仓库。
    const projectDir = join(fixture, 'project');
    mkdirSync(projectDir, { recursive: true });
    const git = (...args) => execFileSync('git', args, { cwd: projectDir, encoding: 'utf8', timeout: 30000 });
    git('init', '-q');
    git('config', 'user.email', 'real-launch@example.invalid');
    git('config', 'user.name', 'real-launch');
    writeFileSync(join(projectDir, 'README.md'), '# isolated real launch fixture' + String.fromCharCode(10), 'utf8');
    git('add', '-A');
    git('commit', '-q', '-m', 'fixture');
    step('git_fixture_created', true);

    // 临时凭据存储：目录 0700、文件 0600，由生产 adapter 自己写。
    const storeDir = join(fixture, 'credentials');
    mkdirSync(storeDir, { recursive: true, mode: 0o700 });
    chmodSync(storeDir, 0o700);
    const storePath = join(storeDir, 'credentials.json');
    const store = new JsonCredentialStore({ path: storePath });
    const saved = store.save({ expectedRevision: 0, secret });
    if (saved.kind !== 'saved') fail('credential_save_rejected', saved.code);
    step('credential_store_written', true, { credentialRef: saved.credentialRef });

    // 生产 launcher：与正式 Worker 完全同一条路径。
    // 来源 Codex HOME 只提供 hooks 开关（与既有真实验收一致）；模型、provider 与凭据全部来自绑定。
    const sourceCodexHome = join(fixture, 'codex-source');
    mkdirSync(sourceCodexHome, { recursive: true });
    writeFileSync(
      join(sourceCodexHome, 'config.toml'),
      ['[features]', 'hooks = true', ''].join(String.fromCharCode(10)),
      'utf8',
    );
    const reporterPath = join(fixture, 'session-start.mjs');
    const reportPath = join(fixture, 'session-start.jsonl');
    installCodexSessionStartReporter({ reporterPath, reportPath });
    const modelConfiguration = {
      connection: {
        connectionRef: 'real-launch-minimax',
        label: 'MiniMax',
        providerIntegration: 'minimax',
        modelOptions: {},
        credential: { kind: 'managed', credentialRef: saved.credentialRef, optionPath: 'apiKey' },
        codex: { providerId: 'companion_minimax', baseUrl, wireApi: 'responses' },
      },
      modelRef: 'real-launch-model',
      model,
      effort: 'low',
      effortCapability: { values: ['low', 'medium', 'high'], source: 'codex', optionPath: 'effort' },
      modelOptions: {},
    };
    const strategy = createCodexWorkerLaunch({
      launchId: 'real-launch:validator:attempt-1',
      modelConfiguration,
      credentialStore: store,
      credentialStorePath: storePath,
      sandboxMode: 'read-only',
      sessionStartReporterPath: reporterPath,
      sourceCodexHome,
    });
    const prepared = await strategy.prepare({ worktreePath: projectDir });
    if (prepared.command.includes(secret)) fail('secret_in_command');
    // 只记录脱敏后的命令形状，不记录原始内容。
    const commandShape = prepared.command.replaceAll(/'[^']*'/gu, '<path>');
    step('prepared_command_built', true, {
      commandShape,
      mentionsLauncher: prepared.command.includes('codex-model-launcher.mjs'),
      mentionsKey: false,
    });

    // 独立 Orca terminal：不碰主项目 threads。
    const added = orcaCall(['repo', 'add', '--path', projectDir, '--json']);
    if (!added.ok) fail('orca_repo_add_' + added.reason);
    registered = true;
    const created = orcaCall([
      'terminal', 'create', '--worktree', 'path:' + projectDir,
      '--title', 'companion-real-launch', '--command', prepared.command, '--json',
    ]);
    if (!created.ok) fail('orca_terminal_create_' + created.reason);
    const handle = created.result?.terminal?.handle ?? created.result?.handle ?? null;
    if (typeof handle !== 'string') fail('terminal_create_failed');
    terminalHandle = handle;
    step('terminal_created', true, { handle });

    // 次序与生产一致：先等 TUI 空闲，再发 prompt。SessionStart 只在 TUI 起来并收到首个 prompt
    // 之后才触发；先等报告再发 prompt 会永远等不到（这正是本脚本最初的错误）。
    orca(['terminal', 'wait', '--terminal', handle, '--for', 'tui-idle', '--timeout-ms', '90000', '--json'], { timeoutMs: 120000 });
    step('tui_idle', true);

    orca(['terminal', 'send', '--terminal', handle, '--text', READ_ONLY_PROMPT, '--enter', '--json'], { timeoutMs: 60000 });
    step('prompt_sent', true, { prompt: READ_ONLY_PROMPT });

    // SessionStart 报告：精确 Session Binding 的唯一来源，由 reporter 给出，不按 mtime/cwd 推断。
    let report = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (existsSync(reportPath)) {
        const line = readFileSync(reportPath, 'utf8').trim();
        if (line.length > 0) { report = JSON.parse(line.split(String.fromCharCode(10)).at(-1)); break; }
      }
      sleep(1000);
    }
    if (report === null) fail('session_start_report_missing');
    step('session_start_reported', true, {
      hasSessionId: typeof report.sessionId === 'string',
      hasTranscriptPath: typeof report.transcriptPath === 'string',
    });

    // 等待真实 assistant turn 落到 transcript。
    const transcriptPath = typeof report.transcriptPath === 'string' ? report.transcriptPath : null;
    if (transcriptPath === null || !existsSync(transcriptPath)) fail('transcript_missing');
    let sawAssistant = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const text = readFileSync(transcriptPath, 'utf8');
      // 必须真有 assistant 消息；只出现 prompt 里的 READY 字样不算完成。
      // Codex 0.160 的 rollout 把助手消息记成 response_item{type:message, role:assistant}，
      // 旧版才是 agent_message；两种形状都要认，否则会把成功回合误判成失败。
      if (/"type":"agent_message"/u.test(text) || /"role":"assistant"/u.test(text)) {
        sawAssistant = true;
        break;
      }
      sleep(1000);
    }
    step('assistant_turn_observed', sawAssistant);
    if (!sawAssistant) fail('assistant_turn_not_completed');

    // 精确 transcript 核验：session/CODEX_HOME/工作目录必须与本次启动一致。
    const observedMs = Date.parse(report.observedAt);
    const proof = proveCodexTranscript({
      report,
      workspace: projectDir,
      expectedCodexHome: prepared.stateRoot,
      dispatchStartedAt: new Date(observedMs - 60000).toISOString(),
      bindingDeadlineAt: new Date(observedMs + 60000).toISOString(),
    });
    step('session_binding_proved', proof.kind === 'proven', {
      kind: proof.kind,
      reason: proof.kind === 'proven' ? null : proof.reason,
    });

    // 从 transcript 读回模型与 effort，确认真实进程设置与批准绑定一致。
    const transcriptText = readFileSync(transcriptPath, 'utf8');
    const transcriptModel = /"model"\s*:\s*"([^"]+)"/u.exec(transcriptText)?.[1] ?? null;
    const transcriptEffort = /"reasoning_effort"\s*:\s*"([^"]+)"/u.exec(transcriptText)?.[1]
      ?? /"effort"\s*:\s*"([^"]+)"/u.exec(transcriptText)?.[1]
      ?? null;
    const modelMatches = transcriptModel !== null && (transcriptModel === model || transcriptModel.includes(model));
    // effort 缺失不算匹配：必须是真实读回并等于批准值。
    const effortMatches = transcriptEffort === 'low';
    // transcript 是持久证据，绝不能含 key。
    const secretLeaked = secret.length > 0 && transcriptText.includes(secret);
    step('transcript_free_of_secret', !secretLeaked);
    if (secretLeaked) fail('secret_in_transcript');
    evidence.observedSession = {
      sessionId: report.sessionId,
      codexHomeMatched: report.codexHome === prepared.stateRoot,
      transcriptModel,
      transcriptEffort,
      modelMatchesApprovedBinding: modelMatches,
      effortMatchesApprovedBinding: effortMatches,
      credentialEvidence: 'key 仅存在于子进程环境；未读取、未打印、未落证据',
    };
    evidence.verdict = proof.kind === 'proven' && modelMatches && effortMatches && sawAssistant && !secretLeaked
      ? 'launched-with-approved-binding'
      : 'not-proved';
  } catch (error) {
    evidence.verdict = 'failed';
    evidence.failure = {
      code: error.safeCode ?? 'unexpected',
      message: error instanceof Error ? error.message : String(error),
    };
    // 失败诊断只给结构化事实：绝不把终端片段写进证据——终端内容可能带 credential 相关回显，
    // 即使脱敏也不该落盘。需要人工排查时由操作者自行用 orca terminal read 现场查看。
    if (terminalHandle !== null) {
      evidence.failure.terminalHandle = terminalHandle;
      evidence.failure.terminalOutputCaptured = false;
    }
  } finally {
    if (terminalHandle !== null) orca(['terminal', 'close', '--terminal', terminalHandle, '--json']);
    if (registered) orca(['repo', 'remove', '--path', join(fixture, 'project'), '--json']);
    // 临时凭据文件随整个 fixture 删除：磁盘上不残留 key。
    try { rmSync(fixture, { recursive: true, force: true }); } catch { /* 已不存在 */ }
  }

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(evidence, null, 2) + String.fromCharCode(10), 'utf8');
  process.stdout.write(JSON.stringify({
    verdict: evidence.verdict,
    steps: evidence.steps.map((entry) => entry.name + ':' + entry.ok),
  }, null, 2) + String.fromCharCode(10));
  if (evidence.verdict === 'failed') process.exitCode = 1;
}

await main();
