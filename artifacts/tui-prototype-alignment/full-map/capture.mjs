import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync} from 'node:fs';
import {pathToFileURL, URL} from 'node:url';
import {setTimeout} from 'node:timers';
import process from 'node:process';
import {displayWidth as sourceWidth} from '../../../dist/src/interfaces/tui/render/width.js';
const root=process.cwd(), output=root+'/artifacts/tui-prototype-alignment/full-map';
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
for(const size of [[120,40],[80,24],[50,40]])for(const mode of ['color','no-color']) await run('alignment',size,mode,async s=>{
 const snap=name=>shot(s,name,size,mode);
 await snap('blocked-workspace');await press(s,['ctrl','t']);await snap('tool-expanded');await press(s,['ctrl','t']);
 s.writeRaw('首尾');await press(s,'left');
 await press(s,['ctrl','b']);await snap('project-overview');
 await press(s,'down');await press(s,'enter');await snap('project-budget');await press(s,'esc');
 await press(s,'down');await press(s,'down');await press(s,'enter');await snap('project-identity');for(let i=0;i<8;i++)await s.press('down');await snap('project-identity-scroll');await press(s,'esc');
 await press(s,'down');await press(s,'enter');await snap('project-work');await press(s,'esc');
 await press(s,'tab');await snap('project-pending');await press(s,'down');await press(s,'down');await press(s,'enter');await snap('project-other-question');await press(s,'esc');
 await press(s,'tab');await snap('project-events');await press(s,'enter');await snap('project-event-detail');await press(s,'esc');await press(s,'esc');
 await press(s,['ctrl','a']);await press(s,'delete');await press(s,'delete');s.writeRaw('/proj');await pause();await snap('slash');await press(s,'enter');await snap('slash-adopted');await press(s,'enter');await s.waitForText('项目面板');await snap('slash-executed');await press(s,'esc');
 await command(s,'answer');await s.waitForText('回答 1/2');await snap('answer-options');await press(s,'tab');s.writeRaw('中文自由回答');await pause();await snap('answer-free');await press(s,'esc');await snap('answer-return');
 await press(s,['ctrl','p']);await snap('commands');await press(s,'esc');
 await command(s,'session-picker');await snap('sessions');await press(s,'esc');
 await command(s,'model-picker');await snap('models');await press(s,'esc');
 await command(s,'authorize-execution');await snap('authorization');await press(s,'tab');for(let i=0;i<9;i++)await s.press('down');await snap('authorization-record');await press(s,'esc');
 await command(s,'execution-handoff');await snap('handoff-recipient');await press(s,'enter');await s.waitForText('Execution Handoff Review');await snap('handoff');await press(s,'tab');await snap('handoff-record');await press(s,'esc');
 await command(s,'cancel');await snap('cancel');await press(s,'tab');await snap('cancel-record');await press(s,'n');
 await command(s,'exit');await snap('exit');await press(s,'tab');await snap('exit-record');await press(s,'n');
 await press(s,['ctrl','g']);await snap('inspector');await press(s,'right');await snap('inspector-relations');await press(s,'down');await press(s,'enter');await snap('inspector-relation-selected');
 await press(s,'enter');await snap('inspector-evidence');await press(s,'tab');await snap('inspector-scope');await press(s,'tab');await snap('inspector-identity');await press(s,'esc');await press(s,'esc');
 await command(s,'options');await snap('options');await press(s,'down');await press(s,'enter');await press(s,'esc');
 await snap('workspace-ascii');await press(s,['ctrl','g']);await snap('inspector-ascii');await press(s,'esc');
 process.stdout.write('full-map captured '+size+' '+mode+'\n');
});
for(const scene of ['planning','execution','empty','disabled','alignment-planning'])for(const size of [[120,40],[80,24],[50,40]])for(const mode of ['color','no-color']) await run(scene,size,mode,async s=>{
 await shot(s,scene+'-workspace',size,mode);
 if(scene==='alignment-planning'){
 await command(s,'handoff');await press(s,'down');await press(s,'enter');await s.waitForText('Handoff Review');await shot(s,'planning-handoff',size,mode);await press(s,'tab');await shot(s,'planning-handoff-record',size,mode);await press(s,'esc');
 }
});
writeFileSync(output+'/samples.json',JSON.stringify(records,null,2));
