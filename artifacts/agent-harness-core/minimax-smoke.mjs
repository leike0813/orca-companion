import { createServer } from 'node:http';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import { setTimeout, clearTimeout } from 'node:timers';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { launchTerminal } from 'tuistory';
import { JsonCredentialStore } from '../../dist/src/adapters/storage/credential-store.js';
import { openCheckpointStore } from '../../dist/src/adapters/storage/checkpoint-store.js';
const { AbortController, AbortSignal, fetch } = globalThis;

// Explicit source config only supplies a connection; its repository and session are never opened.
const configPath = process.argv[2];
if (!configPath) throw new Error('Provide the approved connection configuration path');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const model = config.models.find(m => m.model === 'MiniMax-M3.1-Flash-Preview');
const connection = config.providerConnections.find(c => c.connectionRef === model?.connectionRef);
if (!connection || connection.providerIntegration !== 'anthropic-messages') throw new Error('Approved MiniMax connection unavailable');
const originalCredentials = new JsonCredentialStore();
const key = originalCredentials.read(connection.credential.credentialRef);
if (key.kind !== 'resolved') throw new Error('Approved credential unavailable');
const LIMIT = 12;
let requests = 0;
let active = 0;
const controllers = new Set();
const server = createServer((request, response) => { void (async () => {
  if (requests >= LIMIT) { response.writeHead(400).end(); return; }
  requests++; active++;
  const controller = new AbortController(); controllers.add(controller);
  response.on('close', () => controller.abort());
  try {
    let body = '';
    for await (const chunk of request) {
      body += String(chunk);
      if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw new Error('request budget exceeded');
    }
    const target = new URL(connection.baseUrl.replace(/\/$/, '') + request.url);
    const headers = { 'content-type': 'application/json', 'x-api-key': key.secret,
      'anthropic-version': request.headers['anthropic-version'] ?? '2023-06-01' };
    const upstream = await fetch(target, { method: 'POST', body, headers,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]) });
    response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
    if (upstream.body) {
      for await (const chunk of Readable.fromWeb(upstream.body)) {
        if (controller.signal.aborted) break;
        response.write(chunk);
      }
    }
    response.end();
  } catch { response.destroy(); }
  finally { active--; controllers.delete(controller); }
})().catch(() => response.destroy()); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const directory = mkdtempSync(join(tmpdir(), 'ocp-minimax-debug-'));
const root = join(directory, 'plain'); mkdirSync(root);
writeFileSync(join(root, 'sample.txt'), 'MINIMAX_DEBUG_TOOL_EVIDENCE\n');
const env = { ...process.env, XDG_CONFIG_HOME: join(directory, 'config'), XDG_STATE_HOME: join(directory, 'state'),
  TERM: 'xterm-256color', NO_COLOR: '1', FORCE_COLOR: '0', NODE_NO_WARNINGS: '1' };
const isolatedCredentials = new JsonCredentialStore({ environment: env });
const saved = isolatedCredentials.save({ expectedRevision: 0, secret: key.secret });
if (saved.kind !== 'saved') throw new Error('Isolated credential store failed');
writeFileSync(join(env.XDG_CONFIG_HOME, 'orca-companion/providers.json'), JSON.stringify({ schemaVersion: 1, revision: 1,
  connections: [{ ...connection, baseUrl: `http://127.0.0.1:${address.port}`, credential: { kind: 'managed', credentialRef: saved.credentialRef } }], models: [model] }), { mode: 0o600 });
const output = resolve('artifacts/agent-harness-core', 'minimax-' + new Date().toISOString().replaceAll(':', '-'));
mkdirSync(output, { recursive: true });
let terminal;
const deadline = setTimeout(() => { terminal?.killProcess(); controllers.forEach(c => c.abort()); }, 120_000);
async function waitIdle() {
  const registryPath = join(env.XDG_STATE_HOME, 'orca-companion/debug/sessions.json');
  const record = JSON.parse(readFileSync(registryPath, 'utf8')).sessions[0];
  const path = join(env.XDG_STATE_HOME, 'orca-companion/debug/sessions', record.coordinatorSessionId, 'checkpoints.sqlite');
  for (let n = 0; n < 600; n++) {
    const opened = openCheckpointStore({ databasePath: path });
    if (opened.kind !== 'opened') throw new Error('Smoke checkpoint unavailable');
    try {
      const state = opened.store.turns.readTurnState(record.coordinatorSessionId);
      if (state.kind === 'halted') throw new Error('Smoke turn halted: ' + state.failure.code);
      if (state.kind === 'idle') return { record, entries: opened.store.readCommittedMessages(record.coordinatorSessionId),
        calls: opened.store.readHistoryCalls({ coordinatorSessionId: record.coordinatorSessionId }).calls };
    } finally { opened.store.close(); }
    await delay(100);
  }
  throw new Error('Smoke deadline exceeded');
}
try {
  terminal = await launchTerminal({ command: process.execPath, args: [resolve('dist/src/interfaces/cli/main.js'), '--debug', root],
    cwd: directory, cols: 100, rows: 30, env });
  await terminal.waitForText('新建或继续'); await terminal.press('n'); await terminal.waitForText('选择模型');
  await terminal.press('enter'); await terminal.waitForText('普通消息', { timeout: 60_000 });
  const afterProbe = requests;
  await terminal.type('你好，请简短回应即可。'); await terminal.press('enter'); await delay(200);
  const greeting = await waitIdle();
  if (!greeting.entries.some(e => e.role === 'assistant' && e.content.length > 0)) throw new Error('No committed greeting');
  writeFileSync(join(output, 'greeting.txt'), await terminal.text());
  await terminal.type('请使用 read_file 工具读取 sample.txt，确认读到的标记后只回复该标记。');
  await terminal.press('enter'); await delay(200);
  const tool = await waitIdle();
  if (!tool.calls.some(c => c.name === 'read_file' && c.status === 'ok')) throw new Error('No paired read tool result');
  writeFileSync(join(output, 'tool.txt'), await terminal.text());
  terminal.sendKey(['ctrl', 'c']);
  if (!(await terminal.waitForExit(5000))) throw new Error('Process survived Ctrl+C');
  for (let n = 0; active > 0 && n < 50; n++) await delay(100);
  if (active > 0) throw new Error('Backend request survived exit');
  writeFileSync(join(output, 'result.json'), JSON.stringify({ status: 'passed', directory, sessionId: tool.record.coordinatorSessionId,
    model: model.model, requestLimit: LIMIT, requests, afterProbe, activeAfterExit: active,
    committedAssistants: tool.entries.filter(e => e.role === 'assistant').length, pairedReadTools: tool.calls.filter(c => c.status === 'ok').length,
    exit: terminal.exitInfo }, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ status: 'passed', requests, limit: LIMIT, output }) + '\n');
} catch (error) {
  writeFileSync(join(output, 'result.json'), JSON.stringify({ status: 'failed', requests, limit: LIMIT, directory,
    reason: error instanceof Error ? error.message : 'unknown' }, null, 2) + '\n');
  if (terminal) writeFileSync(join(output, 'failure.txt'), terminal.readAll());
  process.stderr.write('MiniMax smoke failed; evidence: ' + output + '\n'); process.exitCode = 1;
} finally {
  clearTimeout(deadline); terminal?.close(); controllers.forEach(c => c.abort());
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
