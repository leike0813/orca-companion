import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import process from 'node:process';
import {fileURLToPath, URL} from 'node:url';
import {openRepositoryCoordinationStore} from '../../../dist/src/bootstrap/composition.js';
const entry=fileURLToPath(new URL('../../../dist/src/interfaces/cli/main.js',import.meta.url));
const fixture=JSON.parse(readFileSync(process.argv[2],'utf8'));
const opened=await openRepositoryCoordinationStore({repositoryPath:fixture.fixture,readOnly:true});
assert.equal(opened.kind,'opened');
try {
  const scope=opened.store.query({kind:'scope',coordinationScopeId:fixture.coordinationScopeId});
  assert.equal(scope.kind,'scope');
  assert.equal(scope.scope?.controlState,'paused','只允许在已暂停现场启动阅读探针');
} finally { opened.close(); }
const socket='graph-basis-read-'+process.pid, session='read';
const env={...process.env,XDG_CONFIG_HOME:fixture.fixture+'-xdg',PATH:process.env.HOME+'/.cache/orca-acceptance/acceptance-bin:'+process.env.PATH};
for(const key of Object.keys(env)) if(/^ORCA_(?:TERMINAL|WORKER|TASK|RUN)(?:_|$)/u.test(key))delete env[key];
const tmux=(...args)=>{const r=spawnSync('/usr/bin/tmux',['-L',socket,'-f','/dev/null',...args],{encoding:'utf8',env,timeout:10000});return r;};
const sleep=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
const capture=()=>tmux('capture-pane','-p','-t',session).stdout;
const wait=(predicate,ms=10000)=>{const end=Date.now()+ms;let frame;do{frame=capture();if(predicate(frame))return frame;sleep(100);}while(Date.now()<end);throw new Error('frame timeout\n'+frame);};
const changed=(key,prior=capture(),ms=2000)=>{tmux('send-keys','-t',session,key);try{return wait(f=>f!==prior,ms);}catch{return capture();}};
const ready=f=>f.includes('项目面板 · 总览 · 详情')&&!f.includes('正在读取项目详情');
const compact=t=>t.replace(/[\s│┃|─╭╮╰╯]/gu,'');
const report={fixture:fixture.fixture,readOnlyUiIntents:true,
  purpose:'重新启动前台 Controller 后只读浏览；启动本身会取得 Runtime Lease',
  observedAt:new Date().toISOString(),pages:[],keys:[]};
const key=k=>{report.keys.push(k);tmux('send-keys','-t',session,k);};
try{
assert.equal(tmux('new-session','-d','-s',session,'-x','80','-y','80','-c',fixture.fixture,`${JSON.stringify(process.execPath)} ${JSON.stringify(entry)}`).status,0);
wait(f=>f.includes('普通消息'),60000);key('C-b');let frame=wait(f=>f.includes('项目面板'));
for(let i=0;i<12&&!/› [^\n]*工作记录/u.test(frame);i++)frame=changed('Down',frame);
assert.match(frame,/› [^\n]*工作记录/u);key('Enter');frame=wait(ready);
let found=false;
for(let page=0;page<200;page++){
let all=frame,unchanged=0;
for(let down=0;down<400;down++){
const next=changed('Down',frame,250);
if(next===frame){if(++unchanged>=2)break;continue;}
unchanged=0;frame=next;all+='\n'+frame;
}
report.pages.push({page,text:all});
if(compact(all).includes('finalizer.verdict')){found=true;}
if(!frame.includes('PgDn 读取后续字段'))break;
const prior=frame;key('NPage');frame=wait(f=>f!==prior&&ready(f));
}
report.finalizerVerdictVisible=found;
report.recoveryVisible=report.pages.some(p=>compact(p.text).includes('recoveries.0.status:recovered'));
writeFileSync(process.argv[3],JSON.stringify(report,null,2)+'\n',{flag:'wx'});
assert(found,'finalizer.verdict must be visible after paging');
process.stdout.write(JSON.stringify({pages:report.pages.length,finalizerVerdictVisible:found,recoveryVisible:report.recoveryVisible,output:process.argv[3]})+'\n');
}finally{tmux('send-keys','-t',session,'C-c');sleep(500);tmux('kill-server');}
