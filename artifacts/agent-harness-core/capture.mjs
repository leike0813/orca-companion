import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL, URL } from 'node:url';
import { launchTerminal } from 'tuistory';
import { displayWidth } from '../../dist/src/interfaces/tui/render/width.js';
import { scriptedModelServer } from '../../dist/tests/support/scripted-model-server.js';
import { credentialFixtureEnvironment, projectConnectionsFixture } from '../../dist/tests/support/model-configurations.js';

const output = resolve('artifacts/agent-harness-core', 'capture-' + new Date().toISOString().replaceAll(':', '-'));
mkdirSync(output, { recursive: true });
const require = createRequire(import.meta.url);
const local = createRequire(require.resolve('tuistory'));
const imageModule = local.resolve('ghostty-opentui/image');
const { renderTerminalToImage } = await import(imageModule);
const { StyleFlags } = await import(new URL('./ffi.js', pathToFileURL(imageModule)));
const samples = [];
async function shot(terminal, stem) {
  await delay(150);
  await terminal.text();
  const data = terminal.getTerminalData();
  const lines = data.lines.slice(-data.rows);
  const cells = { ...data, lines: lines.map(line => ({ ...line, spans: line.spans.flatMap(span =>
    Array.from(span.text, character => ({ ...span, text: character, width: displayWidth(character),
      ...((span.flags & StyleFlags.INVERSE) !== 0 ? { fg: span.fg ?? '#c0caf5', bg: span.bg ?? '#1a1b26' } : {}) }))) })) };
  const text = lines.map(line => line.spans.map(span => span.text).join('').trimEnd()).join('\n') + '\n';
  writeFileSync(join(output, stem + '.txt'), text);
  writeFileSync(join(output, stem + '.png'), await renderTerminalToImage(cells));
  samples.push({ stem, columns: data.cols, rows: data.rows, cursor: data.cursor });
}
const server = await scriptedModelServer();
const directory = mkdtempSync(join(tmpdir(), 'ocp-core-capture-'));
const root = join(directory, 'plain'); mkdirSync(root);
writeFileSync(join(root, 'sample.txt'), '只读工具证据\n');
const env = { ...credentialFixtureEnvironment(directory), XDG_STATE_HOME: join(directory, 'state'), TERM: 'xterm-256color', NODE_NO_WARNINGS: '1' };
const fixture = projectConnectionsFixture();
writeFileSync(join(env.XDG_CONFIG_HOME, 'orca-companion/providers.json'), JSON.stringify({ schemaVersion: 1, revision: 1,
  connections: fixture.providerConnections.map(c => ({ ...c, providerId: 'custom', baseUrl: server.baseUrl })), models: fixture.models }), { mode: 0o600 });
try {
  for (const [cols, rows] of [[120, 40], [80, 24], [50, 40]]) for (const color of ['color', 'no-color']) {
    const launchEnv = { ...env, FORCE_COLOR: color === 'color' ? '1' : '0' };
    if (color === 'no-color') launchEnv.NO_COLOR = '1'; else delete launchEnv.NO_COLOR;
    const stem = `${cols}x${rows}-${color}`;
    const terminal = await launchTerminal({ command: process.execPath, cwd: directory, cols, rows,
      args: [resolve('dist/src/interfaces/cli/main.js'), '--debug', root], env: launchEnv });
    try {
      await terminal.waitForText('新建或继续'); await terminal.press('n'); await terminal.waitForText('选择模型');
      await terminal.press('enter'); await terminal.waitForText('普通消息'); await shot(terminal, 'debug-empty-' + stem);
      await terminal.type('你好'); await terminal.press('enter'); await terminal.waitForText('E2E回复');
      await shot(terminal, 'debug-greeting-' + stem);
      await terminal.type('__TOOL__'); await terminal.press('enter'); await terminal.waitForText('工具结果已收到');
      await shot(terminal, 'debug-tool-' + stem);
      await terminal.press(['ctrl', 't']); await shot(terminal, 'debug-tool-details-' + stem);
      await terminal.press(['ctrl', 't']);
      await terminal.type('首尾'); await terminal.press('left'); await terminal.type('中'); await terminal.waitForText('首中尾');
      await shot(terminal, 'debug-cursor-' + stem);
      await terminal.press(['ctrl', 'a']); for (let n = 0; n < 3; n++) await terminal.press('delete');
      await terminal.type('/'); await shot(terminal, 'debug-slash-' + stem);
      await terminal.press('esc'); await terminal.press(['ctrl', 'p']); await shot(terminal, 'debug-palette-' + stem);
      await terminal.press('esc'); await terminal.press(['ctrl', 'a']); await terminal.press('delete');
      await terminal.type('/help'); await terminal.press('enter'); await terminal.press('enter');
      await shot(terminal, 'debug-help-' + stem);
      await terminal.press('esc'); terminal.sendKey(['ctrl', 'c']);
      if (!(await terminal.waitForExit(5000))) throw new Error('debug process did not exit');
    } finally { terminal.close(); }
    const coordinate = await launchTerminal({ command: process.execPath, cols, rows, cwd: resolve('.'),
      args: ['scripts/tui-preview.mjs', 'alignment'], env: launchEnv });
    try { await coordinate.waitForText('普通消息'); await shot(coordinate, 'coordination-' + stem); }
    finally { coordinate.close(); }
    process.stdout.write('captured ' + stem + '\n');
  }
  await delay(100);
  if (server.activeRequests() !== 0) throw new Error('model connection survived exit');
  writeFileSync(join(output, 'samples.json'), JSON.stringify({ samples, actualAgentRequests: server.requests.length,
    totalRequests: server.totalRequests(), activeRequestsAfterExit: server.activeRequests(), fixtureDirectory: directory }, null, 2) + '\n');
  process.stdout.write(output + '\n');
} finally { await server.close(); }
