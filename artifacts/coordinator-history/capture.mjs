import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL, URL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import process from 'node:process';
import { displayWidth } from '../../dist/src/interfaces/tui/render/width.js';

const root = process.cwd(), output = root + '/artifacts/coordinator-history';
mkdirSync(output, { recursive: true });
const require = createRequire(root + '/package.json');
const { launchTerminal } = await import(require.resolve('tuistory'));
const terminalRequire = createRequire(require.resolve('tuistory'));
const imageModule = terminalRequire.resolve('ghostty-opentui/image');
const { renderTerminalToImage } = await import(imageModule);
const { StyleFlags } = await import(new URL('./ffi.js', pathToFileURL(imageModule)));
const samples = [];
async function shot(session, name, size, mode) {
  await session.text();
  const data = session.getTerminalData(), lines = data.lines.slice(-data.rows);
  const text = lines.map(line => line.spans.map(span => span.text).join('').trimEnd()).join('\n');
  const stem = name + '-' + size.join('x') + '-' + mode;
  const cells = { ...data, lines: lines.map(line => ({ ...line, spans: line.spans.flatMap(span =>
    Array.from(span.text, character => ({ ...span, text: character, width: displayWidth(character),
      ...((span.flags & StyleFlags.INVERSE) !== 0 ? { fg: span.fg ?? '#c0caf5', bg: span.bg ?? '#1a1b26' } : {}) }))) })) };
  writeFileSync(output + '/' + stem + '.txt', text + '\n');
  writeFileSync(output + '/' + stem + '.png', await renderTerminalToImage(cells));
  samples.push({ name, size, mode, png: stem + '.png', text: stem + '.txt', cursor: data.cursor, cursorVisible: data.cursorVisible });
}
async function press(session, key) { await session.press(key); await delay(120); }
for (const size of [[120, 40], [80, 24], [50, 40]]) for (const mode of ['color', 'no-color']) {
  const env = { ...process.env, TERM: 'xterm-256color', NODE_NO_WARNINGS: '1', FORCE_COLOR: mode === 'color' ? '1' : '0' };
  if (mode === 'no-color') env.NO_COLOR = '1'; else delete env.NO_COLOR;
  const session = await launchTerminal({ command: process.execPath, cwd: root, cols: size[0], rows: size[1], env,
    args: ['scripts/tui-preview.mjs', 'history'] });
  try {
    await session.waitForText('历史终点');
    session.writeRaw('首尾'); await press(session, 'left');
    await shot(session, 'latest', size, mode);
    session.writeRaw('\u001b[1;5H'); await delay(120); await session.waitForText('历史起点');
    await shot(session, 'oldest', size, mode);
    await press(session, 'pagedown'); await shot(session, 'page-down', size, mode);
    await press(session, 'pageup'); await shot(session, 'page-up', size, mode);
    for (let page = 0; page < 40 && !(await session.text()).includes('历史条目 100'); page += 1) {
      await press(session, 'pagedown');
    }
    await session.waitForText('历史条目 100');
    await shot(session, 'cross-page-next', size, mode);
    session.writeRaw('\u001b[1;5F'); await delay(120); await session.waitForText('历史终点');
    await press(session, 'pageup'); await shot(session, 'reading', size, mode);
    await press(session, 'esc'); await session.waitForText('历史终点');
    session.writeRaw('中'); await session.waitForText('首中尾');
    await shot(session, 'return-cursor', size, mode);
    if (size[0] === 120 && mode === 'color') {
      for (const resized of [[80, 24], [50, 40], [120, 40]]) {
        session.resize({ cols: resized[0], rows: resized[1] }); await delay(200);
        await session.waitForText('首中尾');
        await shot(session, 'resize-return', resized, mode);
      }
    }
    process.stdout.write('history captured ' + size + ' ' + mode + '\n');
  } finally { session.close(); }
}
writeFileSync(output + '/samples.json', JSON.stringify(samples, null, 2) + '\n');
