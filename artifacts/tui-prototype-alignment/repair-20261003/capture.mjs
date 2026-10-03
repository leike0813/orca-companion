import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync} from 'node:fs';
import {pathToFileURL, URL} from 'node:url';
import {setTimeout} from 'node:timers';
import process from 'node:process';
import {displayWidth as sourceWidth} from '../../../dist/src/interfaces/tui/render/width.js';
const root=process.cwd(), output=root+'/artifacts/tui-prototype-alignment/repair-20261003';
mkdirSync(output,{recursive:true});
const require=createRequire(root+'/package.json');
const {launchTerminal}=await import(require.resolve('tuistory'));
const fromTuistory=createRequire(require.resolve('tuistory'));
const imageModule=fromTuistory.resolve('ghostty-opentui/image');
const {renderTerminalToImage}=await import(imageModule);
const {StyleFlags}=await import(new URL('./ffi.js',pathToFileURL(imageModule)));
const displayWidth=sourceWidth;
const records=[];
async function shot(session,name,size,mode){
  await session.text();const data=session.getTerminalData(), lines=data.lines.slice(-data.rows);
  const text=lines.map(line=>line.spans.map(span=>span.text).join('').trimEnd()).join('\n');
  const stem=name+'-'+size.join('x')+'-'+mode;
  const cells={...data,lines:lines.map(line=>({...line,spans:line.spans.flatMap(span=>Array.from(span.text,character=>({...span,text:character,width:displayWidth(character),...((span.flags&StyleFlags.INVERSE)!==0?{fg:span.fg??'#c0caf5',bg:span.bg??'#1a1b26'}:{})})))}))};
  writeFileSync(output+'/'+stem+'.txt',text+'\n');
  writeFileSync(output+'/'+stem+'.png',await renderTerminalToImage(cells));
  records.push({scenario:name,columns:size[0],rows:size[1],mode,png:stem+'.png',text:stem+'.txt',cursor:data.cursor,cursorVisible:data.cursorVisible});
}
async function run(scene,size,mode,body){
  const env={...process.env,TERM:'xterm-256color',NODE_NO_WARNINGS:'1',ORCA_COMPANION_TUI_ICONS:'nerd',FORCE_COLOR:mode==='color'?'1':'0'};
  if(mode==='no-color')env.NO_COLOR='1';else delete env.NO_COLOR;
  const s=await launchTerminal({command:process.execPath,cwd:root,cols:size[0],rows:size[1],env,args:['scripts/tui-preview.mjs',scene]});
  try {await s.waitForText('普通消息');await body(s);}finally{s.close();}
}


const {COMMAND_IDS}=await import(root+'/dist/src/interfaces/tui/components/command-palette.js');
const pause=()=>new Promise(resolve=>setTimeout(resolve,100));
async function press(s,key){await s.press(key);await pause();}
async function command(s,id){await press(s,['ctrl','p']);for(let i=0;i<COMMAND_IDS.indexOf(id);i++)await s.press('down');await press(s,'enter');}

const checks=[];
async function guard(s,title,name,size,mode) {
 await s.waitForText(title);await shot(s,name+'-before',size,mode);
 for(const key of ['p','b','g']) {
  await press(s,['ctrl',key]);const text=await s.text();
  if(!text.includes(title)||text.includes('Command Palette')||text.includes('Graph Inspector')||text.includes('项目面板'))throw new Error(name+' ctrl+'+key+' penetrated');
 }
 await shot(s,name+'-guarded',size,mode);
 checks.push({scenario:name,size,mode,blocked:['Ctrl+P','Ctrl+B','Ctrl+G']});
 await press(s,'esc');
}
for(const size of [[120,40],[80,24],[50,40]])for(const mode of ['color','no-color']) {
 await run('alignment',size,mode,async s=>{
  const snap=name=>shot(s,name,size,mode);
  s.writeRaw('首尾');await press(s,'left');
  await press(s,['ctrl','b']);await snap('project-overview');
  if(!(await s.text()).includes('需要你处理'))throw new Error('missing handling group');
  await press(s,'down');await press(s,'enter');await snap('project-budget');await press(s,'esc');
  await press(s,'down');await press(s,'down');await snap('project-record-groups');
  if(!(await s.text()).includes('项目资料'))throw new Error('missing project group');
  await press(s,'down');await snap('project-work-selected');await press(s,'enter');await snap('project-work');
  await press(s,'esc');await press(s,'esc');
  await command(s,'authorize-execution');await guard(s,'Execution Authorization Review','authorization',size,mode);
  await command(s,'execution-handoff');await press(s,'enter');await guard(s,'Execution Handoff Review','execution-handoff',size,mode);await press(s,'esc');
  await command(s,'cancel');
  for(const key of ['p','b','g'])await press(s,['ctrl',key]);
  const cancelled=await s.text();if(cancelled.includes('Command Palette')||cancelled.includes('Graph Inspector')||cancelled.includes('项目面板'))throw new Error('confirmation penetrated');
  await snap('cancel-guarded');await press(s,'n');
  await command(s,'options');await press(s,'down');await press(s,'enter');await press(s,'esc');
  await press(s,['ctrl','b']);await snap('project-ascii');await press(s,'esc');
  await press(s,['ctrl','g']);await snap('inspector-ascii');await press(s,'esc');
  s.writeRaw('中');await s.waitForText('首中尾');await snap('return-cursor');
  process.stdout.write('repair captured '+size+' '+mode+'\n');
 });
 await run('alignment-planning',size,mode,async s=>{
  await command(s,'handoff');await press(s,'down');await press(s,'enter');
  await guard(s,'Handoff Review','planning-handoff',size,mode);
  await shot(s,'planning-handoff-return',size,mode);
 });
}
writeFileSync(output+'/samples.json',JSON.stringify(records,null,2));
writeFileSync(output+'/checks.json',JSON.stringify(checks,null,2));
