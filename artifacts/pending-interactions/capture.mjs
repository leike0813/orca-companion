import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL, URL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import process from 'node:process';
import { displayWidth } from '../../dist/src/interfaces/tui/render/width.js';
import { COMMAND_IDS } from '../../dist/src/interfaces/tui/components/command-palette.js';

const root = process.cwd(), output = root + '/artifacts/pending-interactions';
mkdirSync(output, { recursive: true });
const require = createRequire(root + '/package.json');
const { launchTerminal } = await import(require.resolve('tuistory'));
const local = createRequire(require.resolve('tuistory')), imageModule = local.resolve('ghostty-opentui/image');
const { renderTerminalToImage } = await import(imageModule);
const { StyleFlags } = await import(new URL('./ffi.js', pathToFileURL(imageModule)));
const samples = [], checks = [];
async function shot(session, name, size, mode, icons) {
  await session.text(); const data = session.getTerminalData(), lines = data.lines.slice(-data.rows);
  const stem = name + '-' + size.join('x') + '-' + mode + '-' + icons;
  const cells = { ...data, lines: lines.map(line => ({ ...line, spans: line.spans.flatMap(span => Array.from(span.text,
    character => ({ ...span, text: character, width: displayWidth(character),
      ...((span.flags & StyleFlags.INVERSE) !== 0 ? { fg: span.fg ?? '#c0caf5', bg: span.bg ?? '#1a1b26' } : {}) }))) })) };
  writeFileSync(output + '/' + stem + '.txt', lines.map(line => line.spans.map(span => span.text).join('').trimEnd()).join('\n') + '\n');
  writeFileSync(output + '/' + stem + '.png', await renderTerminalToImage(cells));
  samples.push({ name, size, mode, icons, png: stem + '.png', text: stem + '.txt', cursor: data.cursor });
}
async function press(session, key) { await session.press(key); await delay(100); }
async function command(session, id) {
  await press(session, ['ctrl', 'p']);
  for (let index = 0; index < COMMAND_IDS.indexOf(id); index++) await session.press('down');
  await press(session, 'enter');
}
for (const size of [[120,40], [80,24], [50,40]]) for (const mode of ['color', 'no-color']) for (const icons of ['nerd', 'ascii']) {
  const env = { ...process.env, TERM: 'xterm-256color', NODE_NO_WARNINGS: '1', ORCA_COMPANION_TUI_ICONS: icons,
    ORCA_COMPANION_PENDING_INTERACTIONS: '1', FORCE_COLOR: mode === 'color' ? '1' : '0' };
  if (mode === 'no-color') env.NO_COLOR = '1'; else delete env.NO_COLOR;
  const session = await launchTerminal({ command: process.execPath, cwd: root, cols: size[0], rows: size[1], env, args: ['scripts/tui-preview.mjs', 'alignment'] });
  const snap = name => shot(session, name, size, mode, icons);
  try {
    await session.waitForText('当前会话问题'); await snap('history-cards');
    session.writeRaw('首尾'); await press(session, 'left');
    await press(session, ['ctrl', 't']); await snap('history-detailed'); await press(session, ['ctrl', 't']);
    await press(session, ['ctrl', 'b']); await press(session, 'tab'); await session.waitForText('第 1 页'); await snap('scope-page');
    await press(session, 'pagedown'); await session.waitForText('第 2 页'); await snap('scope-later-page');
    await press(session, 'enter'); await session.waitForText('跨会话问题 20'); await snap('cross-answer');
    await press(session, 'tab'); session.writeRaw('保留回答中文🙂'); await press(session, 'esc');
    await session.waitForText('第 2 页'); await snap('saved-return');
    await press(session, 'enter'); await session.waitForText('跨会话问题 20'); await press(session, 'tab'); await session.waitForText('保留回答中文');
    await press(session, 'enter'); await session.waitForText('所选对象已不在当前窗口'); await snap('accepted-return');
    await press(session, 'esc'); session.writeRaw('中'); await session.waitForText('首中尾'); await snap('cursor-return');
    await command(session, 'session-picker'); await snap('sessions'); await press(session, 'esc');
    await press(session, ['ctrl', 'g']); await snap('graph'); await press(session, 'esc');
    await command(session, 'cancel'); await snap('cancel-review'); await press(session, 'esc');
    await press(session, ['ctrl', 'e']); for (let n = 0; n < 3; n++) await press(session, 'backspace'); session.writeRaw('/');
    await session.waitForText('命令候选'); await snap('slash'); await press(session, 'esc');
    if (size[0] === 120 && mode === 'color' && icons === 'nerd') {
      for (const resized of [[80,24], [50,40], [120,40]]) {
        session.resize({ cols: resized[0], rows: resized[1] }); await delay(200);
        await shot(session, 'continuous-resize', resized, mode, icons);
      }
    }
    checks.push({ size, mode, icons, source: 'production TuiApp / real isolated SQLite Q&A and checkpoint',
      explicitCrossSession: true, savedReturn: true, acceptedReturn: true, lostSelectionDoesNotOpenNext: true, restoredCursorText: '首中尾' });
    process.stdout.write('captured ' + size + ' ' + mode + ' ' + icons + '\n');
  } finally { session.close(); }
}
writeFileSync(output + '/samples.json', JSON.stringify(samples, null, 2) + '\n');
writeFileSync(output + '/checks.json', JSON.stringify(checks, null, 2) + '\n');
