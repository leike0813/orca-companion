import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL, URL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import process from 'node:process';
import { displayWidth } from '../../dist/src/interfaces/tui/render/width.js';

const root = process.cwd(), output = root + '/artifacts/command-reviews';
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
  session.writeRaw(id); await delay(150);
  await press(session, 'enter');
}
for (const size of [[120,40],[80,24],[50,40]]) for (const mode of ['color','no-color']) for (const icons of ['nerd','ascii']){
  const env={...process.env,TERM:'xterm-256color',NODE_NO_WARNINGS:'1',ORCA_COMPANION_TUI_ICONS:icons,FORCE_COLOR:mode==='color'?'1':'0'};
  if(mode==='no-color')env.NO_COLOR='1';else delete env.NO_COLOR;
  const session=await launchTerminal({command:process.execPath,cwd:root,cols:size[0],rows:size[1],env,args:['scripts/tui-preview.mjs','alignment-planning']});
  const snap=name=>shot(session,name,size,mode,icons);
  try{
    await session.waitForText('普通消息');
    session.writeRaw('首尾');await press(session,'left');
    await press(session,['ctrl','p']);session.writeRaw('选项');await delay(180);await snap('directory-search');
    await press(session,'enter');session.writeRaw('ASCII');await delay(180);await snap('options-search');
    await press(session,'esc');await session.waitForText('搜索 › 选项');
    await press(session,'esc');session.writeRaw('中');await session.waitForText('首中尾');
    await command(session,'session-picker');session.writeRaw('中文');await delay(180);await snap('session-search');await press(session,'esc');await press(session,'esc');
    await command(session,'model-picker');session.writeRaw('模型 B');await delay(180);await snap('model-search');await press(session,'esc');await press(session,'esc');
    await command(session,'authorize-execution');await session.waitForText('[概览]');await snap('authorization-overview');
    if(mode==='color'&&icons==='nerd')for(const tab of ['permissions','budget','workspace','complete']){await press(session,'tab');await snap('authorization-'+tab);}
    await press(session,['ctrl','p']);await press(session,['ctrl','b']);await press(session,['ctrl','g']);
    await session.waitForText('Execution Authorization Review');
    await press(session,['ctrl','c']);await session.waitForText('确认');
    if(mode==='color'&&icons==='nerd')await snap('exit-default-return');
    await press(session,'esc');await session.waitForText('Execution Authorization Review');
    await press(session,'esc');await session.waitForText('搜索 › authorize-execution');await press(session,'esc');
    await command(session,'handoff');await press(session,'enter');await session.waitForText('Handoff Review');await snap('handoff-overview');
    if(mode==='color'&&icons==='nerd')for(const tab of ['responsibility','binding']){await press(session,'tab');await snap('handoff-'+tab);}
    await press(session,'esc');await session.waitForText('选择交接收件方');await press(session,'esc');await press(session,'esc');
    await command(session,'cancel');await session.waitForText('确认');await snap('cancel-default-return');await press(session,'esc');await press(session,'esc');
    if(size[0]===120&&mode==='color'&&icons==='nerd'){
      await press(session,['ctrl','p']);session.writeRaw('压缩');await delay(180);
      for(const resized of [[80,24],[50,40],[120,40]]){session.resize({cols:resized[0],rows:resized[1]});await delay(220);await shot(session,'resize-search',resized,mode,icons);}
    }
    checks.push({size,mode,icons,draftCursorText:'首中尾',directoryQueryReturned:true,reviewBlocksNavigation:true,exitKeepsReview:true,source:'production TuiApp / isolated fixture ports; no model or Orca'});
    process.stdout.write('captured '+size+' '+mode+' '+icons+'\n');
  }finally{session.close();}
}
writeFileSync(output+'/samples.json',JSON.stringify(samples,null,2)+'\n');
writeFileSync(output+'/checks.json',JSON.stringify(checks,null,2)+'\n');
