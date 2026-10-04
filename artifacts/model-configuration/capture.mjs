import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL, URL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import process from 'node:process';
import { displayWidth } from '../../dist/src/interfaces/tui/render/width.js';

const root = process.cwd(), output = root + '/artifacts/model-configuration/' + (process.argv[2] ?? 'final');
mkdirSync(output, { recursive: true });
const require = createRequire(root + '/package.json');
const { launchTerminal } = await import(require.resolve('tuistory'));
const local = createRequire(require.resolve('tuistory')), modulePath = local.resolve('ghostty-opentui/image');
const { renderTerminalToImage } = await import(modulePath);
const { StyleFlags } = await import(new URL('./ffi.js', pathToFileURL(modulePath)));
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
async function press(session, key) { await session.press(key); await delay(150); }
async function command(session, id) {
  await press(session, ['ctrl', 'p']); session.writeRaw(id); await delay(200); await press(session, 'enter');
}
for (const size of [[120,40],[80,24],[50,40]]) for (const mode of ['color','no-color']) for (const icons of ['nerd','ascii']) {
  const env = { ...process.env, TERM:'xterm-256color', NODE_NO_WARNINGS:'1', ORCA_COMPANION_TUI_ICONS:icons, FORCE_COLOR:mode==='color'?'1':'0' };
  if (mode==='no-color') env.NO_COLOR='1'; else delete env.NO_COLOR;
  const session = await launchTerminal({ command:process.execPath, cwd:root, cols:size[0], rows:size[1], env, args:['scripts/tui-preview.mjs','alignment-planning'] });
  const snap = name => shot(session,name,size,mode,icons);
  try {
    await session.waitForText('普通消息'); session.writeRaw('首尾'); await press(session,'left');
    await snap('workspace');
    await command(session,'model-picker'); await session.waitForText('Model Picker'); await snap('roles');
    await press(session,'down'); await snap('unavailable-role');
    await press(session,'down'); await press(session,'enter'); await session.waitForText('当前区域：模型列表'); await snap('model-menu');
    await press(session,'tab'); await press(session,'right'); await snap('effort');
    await press(session,'tab'); await press(session,'enter'); await session.waitForText('Model Picker');
    await press(session,'e'); await session.waitForText('连接名称'); await snap('editor');
    session.writeRaw('中文连接');
    for(let field=0; field<7; field++) await press(session,'down');
    await press(session,'left'); await snap('harness-login');
    await press(session,'right');
    for(let field=0; field<5; field++) await press(session,'down');
    session.writeRaw('fixture-key-mask-only'); await delay(180); await snap('masked-key');
    if ((await session.text()).includes('fixture-key-mask-only')) throw new Error('editor key was visible');
    await press(session,'enter'); await session.waitForText('尚未应用'); await snap('saved');
    await press(session,'enter'); await session.waitForText('当前区域：模型列表');
    await press(session,'tab'); await press(session,'right'); await press(session,'tab'); await press(session,'right'); await press(session,'enter');
    await session.waitForText('Execution Authorization Review'); await snap('reapproval');
    await press(session,'esc');
    for(let count=0; count<4; count++) await press(session,'esc');
    session.writeRaw('中'); await session.waitForText('首中尾'); await snap('returned-draft');
    await press(session,['ctrl','b']); await snap('project'); await press(session,'esc');
    await press(session,['ctrl','g']); await snap('inspector'); await press(session,'esc');
    await press(session,['ctrl','a']);
    for(let character=0; character<3; character++) await press(session,'delete');
    session.writeRaw('/'); await session.waitForText('命令候选'); await snap('slash-above'); await press(session,'esc');
    if(size[0]===120 && mode==='color' && icons==='nerd') {
      await command(session,'model-picker'); await press(session,'enter');
      for(const resized of [[80,24],[50,40],[120,40]]) { session.resize({cols:resized[0],rows:resized[1]}); await delay(250); await shot(session,'resize-menu',resized,mode,icons); }
    }
    checks.push({ size,mode,icons,defaultReturn:true,saveIndependent:true,explicitReapproval:true,draft:'首中尾',source:'production TuiApp / isolated fixture ports' });
    process.stdout.write('captured '+size+' '+mode+' '+icons+'\n');
  } finally { session.close(); }
}
writeFileSync(output+'/samples.json',JSON.stringify(samples,null,2)+'\n');
writeFileSync(output+'/checks.json',JSON.stringify(checks,null,2)+'\n');
