import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync} from 'node:fs';
import {pathToFileURL,URL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const root=process.cwd(), output=process.argv[2] ?? '/tmp/companion-worker-ui'; mkdirSync(output,{recursive:true});
const require=createRequire(root+'/package.json');
const {launchTerminal}=await import(require.resolve('tuistory'));
const local=createRequire(require.resolve('tuistory'));
const modulePath=local.resolve('ghostty-opentui/image');
const {renderTerminalToImage}=await import(modulePath);
const {StyleFlags}=await import(new URL('./ffi.js',pathToFileURL(modulePath)));
const {displayWidth}=await import(pathToFileURL(root+'/dist/src/interfaces/tui/render/width.js'));
async function shot(s,name,key){ await s.text(); const d=s.getTerminalData(); const lines=d.lines.slice(-d.rows); const cells={...d,lines:lines.map(l=>({...l,spans:l.spans.flatMap(span=>Array.from(span.text,c=>({...span,text:c,width:displayWidth(c),...((span.flags&StyleFlags.INVERSE)!==0?{fg:span.fg??'#c0caf5',bg:span.bg??'#1a1b26'}:{})})))}))};writeFileSync(output+'/'+name+'-'+key+'.txt',lines.map(l=>l.spans.map(x=>x.text).join('').trimEnd()).join('\n'));writeFileSync(output+'/'+name+'-'+key+'.png',await renderTerminalToImage(cells)); }
async function press(s,key){await s.press(key);await delay(140);}
for(const [cols,rows] of [[120,40],[80,24],[50,40]])for(const mode of ['color','no-color'])for(const icons of ['nerd','ascii']){
const key=[cols+'x'+rows,mode,icons].join('-');const env={...process.env,TERM:'xterm-256color',NODE_NO_WARNINGS:'1',ORCA_COMPANION_TUI_ICONS:icons,FORCE_COLOR:mode==='color'?'1':'0'};if(mode==='no-color')env.NO_COLOR='1';else delete env.NO_COLOR;
const s=await launchTerminal({command:process.execPath,cwd:root,cols,rows,env,args:['scripts/tui-preview.mjs','alignment-planning']});
try{await s.waitForText('普通消息');s.writeRaw('首尾');await press(s,'left');await shot(s,'workspace',key);await press(s,['ctrl','p']);s.writeRaw('model-picker');await delay(180);await press(s,'enter');await s.waitForText('Model Picker');await shot(s,'roles',key);await press(s,'e');await s.waitForText('连接名称');await shot(s,'coordinator',key);await press(s,'esc');await press(s,'down');await press(s,'down');await press(s,'enter');await s.waitForText('选择模型');await delay(200);await press(s,'down');await shot(s,'worker',key);await press(s,'tab');await press(s,'right');await shot(s,'effort',key);await press(s,'esc');await press(s,'e');await press(s,'right');await delay(200);await shot(s,'harness',key);await press(s,'tab');s.writeRaw('中文/native-exact-id');await delay(200);await shot(s,'manual',key);await press(s,'esc');await press(s,'esc');await press(s,'esc');s.writeRaw('中');await s.waitForText('首中尾');await shot(s,'returned',key);console.log(key);
}catch(e){console.log(key,e.message);await shot(s,'failure',key);throw e;}finally{s.close();}}
import process from 'node:process';
import console from 'node:console';
