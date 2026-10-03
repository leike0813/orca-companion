import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync} from 'node:fs';
import {pathToFileURL, URL} from 'node:url';
import process from 'node:process';
import {setTimeout} from 'node:timers';
const root=process.cwd(), output=root+'/artifacts/tui-prototype-alignment/full-map';
mkdirSync(output,{recursive:true});
const require=createRequire(root+'/package.json');
const {launchTerminal}=await import(require.resolve('tuistory'));
const fromTuistory=createRequire(require.resolve('tuistory'));
const imageModule=fromTuistory.resolve('ghostty-opentui/image');
const {renderTerminalToImage}=await import(imageModule);
const {StyleFlags}=await import(new URL('./ffi.js',pathToFileURL(imageModule)));
const {displayWidth}=await import(root+'/dist/src/interfaces/tui/render/width.js');
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


import {readFileSync} from 'node:fs';
const {COMMAND_IDS}=await import(root+'/dist/src/interfaces/tui/components/command-palette.js');
const pause=()=>new Promise(resolve=>setTimeout(resolve,100));
async function press(s,key){await s.press(key);await pause();}
async function waitCursor(s,column){
 for(let i=0;i<30;i++){
  await s.text();const d=s.getTerminalData();
  if(d.cursorVisible&&d.cursor[0]===column)return;
  await new Promise(resolve=>setTimeout(resolve,200));
 }
 throw new Error('Native cursor did not settle at column '+column);
}
async function command(s,id){await press(s,['ctrl','p']);for(let i=0;i<COMMAND_IDS.indexOf(id);i++)await s.press('down');await press(s,'enter');}
for(const size of [[120,40],[80,24],[50,40]])for(const mode of ['color','no-color']) await run('alignment',size,mode,async s=>{
 s.writeRaw('原草稿中文abc');await pause();await press(s,'left');
 await command(s,'answer');await s.waitForText('回答 1/2');await shot(s,'answer-options',size,mode);
 await press(s,'tab');s.writeRaw('中文自由回答');await press(s,['alt','enter']);s.writeRaw('第二行');await pause();await shot(s,'answer-free',size,mode);
 await press(s,'esc');await s.waitForText('原草稿中文abc');await waitCursor(s,14);await shot(s,'answer-return',size,mode);
 await press(s,['ctrl','a']);for(let i=0;i<8;i++)await s.press('delete');s.writeRaw('/proj');await pause();await press(s,'enter');await press(s,'enter');await s.waitForText('项目面板');await shot(s,'slash-executed',size,mode);
 process.stdout.write('answer/cursor '+size+' '+mode+'\n');
});
await run('alignment',[120,40],'color',async s=>{
 s.writeRaw('首尾');await pause();await press(s,'left');await press(s,['ctrl','b']);for(let i=0;i<3;i++)await s.press('down');await press(s,'enter');
 for(const size of [[120,40],[80,24],[50,40]]){
  s.resize({cols:size[0],rows:size[1]});await pause();await s.text();await shot(s,'resize-project',size,'color');
 }
 await press(s,'esc');await press(s,'esc');await press(s,['ctrl','g']);await press(s,'enter');await press(s,'tab');
 for(const size of [[50,40],[80,24],[120,40]]){
  s.resize({cols:size[0],rows:size[1]});await pause();await s.text();await shot(s,'resize-inspector',size,'color');
 }
 await press(s,'esc');await press(s,'esc');s.writeRaw('中');await pause();await s.waitForText('首中尾');await waitCursor(s,6);await shot(s,'resize-return',[120,40],'color');
});
const before=JSON.parse(readFileSync(output+'/samples.json','utf8')),replaced=new Set(records.map(record=>record.png));
writeFileSync(output+'/samples.json',JSON.stringify([...before.filter(record=>!replaced.has(record.png)),...records],null,2));
