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


const pause=()=>new Promise(resolve=>setTimeout(resolve,100));
async function press(s,key){await s.press(key);await pause();}


for(const size of [[120,40],[80,24],[50,40]])for(const mode of ['color','no-color'])await run('alignment',size,mode,async s=>{
 await press(s,['ctrl','b']);await shot(s,'post-review-overview',size,mode);
 for(let step=0;step<4;step++)await press(s,'down');await shot(s,'post-review-work-selected',size,mode);
});
writeFileSync(output+'/post-review-samples.json',JSON.stringify(records,null,2));
