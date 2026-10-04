import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL, URL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import process from 'node:process';
import { displayWidth } from '../../dist/src/interfaces/tui/render/width.js';

const root = process.cwd();
const output = root + '/artifacts/graph-basis/screenshots/project-content-' + new Date().toISOString().replaceAll(':', '-');
mkdirSync(output, { recursive: true });
const require = createRequire(root + '/package.json');
const { launchTerminal } = await import(require.resolve('tuistory'));
const imageModule = createRequire(require.resolve('tuistory')).resolve('ghostty-opentui/image');
const { renderTerminalToImage } = await import(imageModule);
const { StyleFlags } = await import(new URL('./ffi.js', pathToFileURL(imageModule)));
const samples = [], checks = [];
async function press(session, key) { await session.press(key); await delay(150); }
async function shot(session, name, size, mode, icons) {
  await session.text();
  const data = session.getTerminalData(), lines = data.lines.slice(-data.rows);
  const stem = name + '-' + size.join('x') + '-' + mode + '-' + icons;
  const cells = { ...data, lines: lines.map(line => ({ ...line, spans: line.spans.flatMap(span => Array.from(span.text,
    character => ({ ...span, text: character, width: displayWidth(character),
      ...((span.flags & StyleFlags.INVERSE) !== 0 ? { fg: span.fg ?? '#c0caf5', bg: span.bg ?? '#1a1b26' } : {}) }))) })) };
  writeFileSync(output + '/' + stem + '.txt', lines.map(line => line.spans.map(span => span.text).join('').trimEnd()).join('\n') + '\n');
  writeFileSync(output + '/' + stem + '.png', await renderTerminalToImage(cells));
  samples.push({ name, size, mode, icons, png: stem + '.png', text: stem + '.txt' });
}
for (const size of [[120,40],[80,24],[50,40]]) for (const mode of ['color','no-color']) for (const icons of ['nerd','ascii']) {
  const env = { ...process.env, TERM: 'xterm-256color', NODE_NO_WARNINGS: '1', ORCA_COMPANION_PENDING_INTERACTIONS: '1',
    ORCA_COMPANION_TUI_ICONS: icons, FORCE_COLOR: mode === 'color' ? '1' : '0' };
  if (mode === 'no-color') env.NO_COLOR = '1'; else delete env.NO_COLOR;
  const session = await launchTerminal({ command: process.execPath, cwd: root, cols: size[0], rows: size[1], env,
    args: ['scripts/tui-preview.mjs','alignment'] });
  try {
    await session.waitForText('当前会话问题');
    await press(session,['ctrl','b']); await session.waitForText('项目面板');
    await press(session,'tab'); await session.waitForText('第 1 页');
    await shot(session,'pending-content',size,mode,icons);
    await press(session,'tab'); await session.waitForText('scope-control-changed');
    await shot(session,'events-content',size,mode,icons);
    await press(session,'enter'); await session.waitForText('详情');
    await shot(session,'event-detail',size,mode,icons);
    await press(session,'esc'); await session.waitForText('[最近事件]');
    await press(session,['ctrl','b']); await session.waitForText('普通消息');
    checks.push({size,mode,icons,pendingContent:true,semanticEventContent:true,eventDetailReturn:true,
      source:'production TuiApp, isolated SQLite Q&A, fixture semantic events; no Orca or model'});
    process.stdout.write('captured ' + size + ' ' + mode + ' ' + icons + '\n');
  } finally { session.close(); }
}
writeFileSync(output+'/samples.json',JSON.stringify(samples,null,2)+'\n');
writeFileSync(output+'/checks.json',JSON.stringify(checks,null,2)+'\n');
process.stdout.write(output + '\n');
