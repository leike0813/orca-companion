import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL, URL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import process from 'node:process';
import { displayWidth } from '../../dist/src/interfaces/tui/render/width.js';
import { COMMAND_IDS } from '../../dist/src/interfaces/tui/components/command-palette.js';
const root = process.cwd(), output = root + '/artifacts/bounded-transcript'; mkdirSync(output, { recursive: true });
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
async function press(s, key) { await s.press(key); await delay(100); }
async function command(s, id) { await press(s, ['ctrl','p']); for (let n=0;n<COMMAND_IDS.indexOf(id);n++) await s.press('down'); await press(s,'enter'); }
async function run(scene, size, mode, icons, body) {
  const env = { ...process.env, TERM: 'xterm-256color', NODE_NO_WARNINGS: '1', ORCA_COMPANION_TUI_ICONS: icons, FORCE_COLOR: mode === 'color' ? '1' : '0' };
  if (mode === 'no-color') env.NO_COLOR = '1'; else delete env.NO_COLOR;
  const s = await launchTerminal({ command: process.execPath, cwd: root, cols: size[0], rows: size[1], env, args: ['scripts/tui-preview.mjs', scene] });
  try { await s.waitForText('普通消息'); await body(s, name => shot(s, name, size, mode, icons)); }
  finally { s.close(); }
}
for (const size of [[120,40],[80,24],[50,40]]) for (const mode of ['color','no-color']) for (const icons of ['nerd','ascii']) {
  await run('alignment', size, mode, icons, async (s, snap) => {
    await snap('workspace'); s.writeRaw('首尾'); await press(s,'left');
    await press(s,['ctrl','b']); await snap('project'); await press(s,'esc');
    await press(s,['ctrl','g']); await snap('graph'); await press(s,'esc');
    await command(s,'cancel'); await snap('cancel-review'); await press(s,'esc');
    s.writeRaw('中'); await s.waitForText('首中尾'); await snap('return-cursor');
    await press(s,['ctrl','e']); for (let n=0;n<3;n++) await press(s,'backspace'); s.writeRaw('/'); await delay(100); await snap('slash');
    checks.push({ size, mode, icons, source: 'production TuiApp', returns: ['project','graph','cancel'], cursor: '首中尾' });
  });
  process.stdout.write('captured ' + size + ' ' + mode + ' ' + icons + '\n');
}
await run('history',[120,40],'color','nerd',async (s,snap) => {
  await s.waitForText('历史终点'); await snap('history-latest');
  s.writeRaw('\u001b[1;5H'); await s.waitForText('历史起点'); await snap('history-oldest');
  await press(s,'pagedown'); await snap('history-next');
  s.resize({ cols: 50, rows: 40 }); await delay(150); await shot(s,'history-resized',[50,40],'color','nerd');
  await press(s,'esc'); await s.waitForText('历史终点'); await shot(s,'history-return',[50,40],'color','nerd');
});
await run('streaming',[80,24],'color','nerd',async (s,snap) => {
  s.writeRaw('首尾'); await press(s,'left');
  await s.waitForText('流式段落'); await snap('stream-live');
  await press(s,'pageup'); const first = await s.text(); await snap('stream-pinned');
  await delay(1000); const later = await s.text();
  if (!later.includes('会话有更新')) throw new Error('missing streaming update badge');
  if (first.includes('流式段落') && !later.includes('流式段落')) throw new Error('pinned source lost');
  s.resize({ cols: 120, rows: 40 }); await delay(150); await shot(s,'stream-resized',[120,40],'color','nerd');
  await delay(5000); await press(s,'esc'); await s.waitForText('流式段落 99');
  s.writeRaw('中'); await s.waitForText('首中尾'); await shot(s,'stream-finished',[120,40],'color','nerd');
});
writeFileSync(output + '/samples.json',JSON.stringify(samples,null,2)+'\n');
writeFileSync(output + '/checks.json',JSON.stringify(checks,null,2)+'\n');
