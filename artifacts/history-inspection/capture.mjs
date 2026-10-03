import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL, URL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import process from 'node:process';
import { displayWidth } from '../../dist/src/interfaces/tui/render/width.js';
import { COMMAND_IDS } from '../../dist/src/interfaces/tui/components/command-palette.js';
const root = process.cwd(), output = root + '/artifacts/history-inspection'; mkdirSync(output, { recursive: true });
const require = createRequire(root + '/package.json');
const { launchTerminal } = await import(require.resolve('tuistory'));
const local = createRequire(require.resolve('tuistory')), imageModule = local.resolve('ghostty-opentui/image');
const { renderTerminalToImage } = await import(imageModule);
const { StyleFlags } = await import(new URL('./ffi.js', pathToFileURL(imageModule)));
const inspectionOnly = process.argv.includes('--inspection-only');
const baselineNames = new Set(['workspace','project','graph','cancel-review','return-cursor','slash']);
const samples = inspectionOnly ? JSON.parse(readFileSync(output + '/samples.json','utf8')).filter(s => baselineNames.has(s.name)) : [];
const checks = inspectionOnly ? JSON.parse(readFileSync(output + '/checks.json','utf8')).filter(c => c.source === 'production TuiApp') : [];
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
  await press(session, ['ctrl','p']);
  for (let n = 0; n < COMMAND_IDS.indexOf(id); n++) await session.press('down');
  await press(session, 'enter');
}
async function run(size, mode, icons, inspection, body) {
  const env = { ...process.env, TERM: 'xterm-256color', NODE_NO_WARNINGS: '1', ORCA_COMPANION_TUI_ICONS: icons,
    ORCA_COMPANION_HISTORY_INSPECTION: inspection ? '1' : '0', FORCE_COLOR: mode === 'color' ? '1' : '0' };
  if (mode === 'no-color') env.NO_COLOR = '1'; else delete env.NO_COLOR;
  const session = await launchTerminal({ command: process.execPath, cwd: root, cols: size[0], rows: size[1], env, args: ['scripts/tui-preview.mjs', 'alignment'] });
  try { await session.waitForText('普通消息'); await body(session, name => shot(session, name, size, mode, icons)); }
  finally { session.close(); }
}
for (const size of [[120,40], [80,24], [50,40]]) for (const mode of ['color','no-color']) for (const icons of ['nerd','ascii']) {
  if (!inspectionOnly) await run(size, mode, icons, false, async (s, snap) => {
    await snap('workspace'); s.writeRaw('首尾'); await press(s,'left');
    await press(s,['ctrl','b']); await snap('project'); await press(s,'esc');
    await press(s,['ctrl','g']); await snap('graph'); await press(s,'esc');
    await command(s,'cancel'); await snap('cancel-review'); await press(s,'esc');
    s.writeRaw('中'); await s.waitForText('首中尾'); await snap('return-cursor');
    await press(s,['ctrl','e']); for (let n=0;n<3;n++) await press(s,'backspace'); s.writeRaw('/'); await delay(100); await snap('slash');
    checks.push({ size, mode, icons, source: 'production TuiApp', returns: ['project','graph','cancel'], cursor: '首中尾' });
  });
  await run(size, mode, icons, true, async (s, snap) => {
    await s.waitForText('最新输入'); await snap('activity-compact');
    s.writeRaw('首尾'); await press(s, 'left');
    await press(s,['ctrl','t']); await snap('activity-detailed'); await press(s,['ctrl','t']);
    s.writeRaw('\u001bOS'); await s.waitForText('↑/↓ 选择活动'); await snap('activity-navigation');
    await press(s,'up'); await s.waitForText('↑/↓ 选择活动'); await s.waitForText('参数边界'); await snap('activity-query'); await press(s,'esc');
    s.writeRaw('\u001bOR'); await s.waitForText('F3 查找'); s.writeRaw('参数边界');
    await s.waitForText('Enter 向新'); await s.waitForText('参数边界 中文KELVIN'); await snap('search-arguments');
    await press(s,'esc'); s.writeRaw('中'); await s.waitForText('首中尾'); await snap('search-return-cursor');
    await press(s,['ctrl','r']); await s.waitForText('Enter 采用'); await snap('input-history');
    await press(s,'up'); await s.waitForText('历史输入 中文'); await snap('input-history-older'); await press(s,'esc'); await s.waitForText('首中尾'); await snap('input-history-return');
    await press(s,['ctrl','r']); await s.waitForText('Enter 采用'); await press(s,'enter');
    if ((await s.text()).includes('Ctrl+R')) throw new Error('input history was not adopted');
    await snap('input-history-adopted');
    checks.push({ size, mode, icons, source: 'real SQLite / production TuiApp in isolated preview', returns: ['F3','Ctrl+R'], functionKeys: ['F3','F4'], cursor: '首中尾', adoptedWithoutSending: true });
  });
  process.stdout.write('captured ' + size + ' ' + mode + ' ' + icons + '\n');
}
writeFileSync(output + '/samples.json', JSON.stringify(samples, null, 2) + '\n');
writeFileSync(output + '/checks.json', JSON.stringify(checks, null, 2) + '\n');
