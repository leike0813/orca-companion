import { expect, test, vi } from 'vitest';
import { COMMAND_METADATA, searchCommands, boundedQuery, parseSlashInput, type CommandId } from '../../src/interfaces/tui/commands.js';
import { CommandInvocations } from '../../src/interfaces/tui/command-invocations.js';
import type { ControllerCommandResult } from '../../src/application/controller-service.js';
import { initialTuiState, reduceTuiState } from '../../src/interfaces/tui/state.js';
import { createFakePorts, renderTui, settle, frameText, type RenderedTui } from './harness.js';

async function press(app:RenderedTui,key:string){
  app.stdin.write(key);
  if(key==='\u001b')await new Promise<void>(resolve=>setTimeout(resolve,50));
  await settle(4);
}
async function command(app:RenderedTui,id:CommandId){
  await press(app,'\u0010');
  await press(app,id);
  await press(app,'\r');
}

test('目录按中文、别名、子菜单路径做有界 literal 搜索',()=>{
  for(const [query,id] of [['压缩','compact'],['/compact','compact'],['选项 → ASCII','icons-ascii']] as const){
    expect(searchCommands(query)).toContain(id);
  }
  expect(searchCommands('[')).toEqual([]);
  expect([...boundedQuery('🙂'.repeat(300))]).toHaveLength(256);
  for(const id of searchCommands('')){
    const alias=COMMAND_METADATA[id].alias;
    if(alias&&id!=='execution-handoff')expect(parseSlashInput('/'+alias,'route_planning')).toMatchObject({kind:'command',command:id});
  }
});

test('同一目标在途与未知结果不重发，只读核验后才释放',async()=>{
  const calls=new CommandInvocations(),gate=Promise.withResolvers<ControllerCommandResult>(),mutate=vi.fn(()=>gate.promise);
  const first=calls.run('scope:one',mutate);
  expect(await calls.run('scope:one',mutate)).toMatchObject({kind:'rejected',code:'command_in_flight'});
  const ref={kind:'scope' as const,coordinationScopeId:'scope-1',revision:7,controlState:'paused' as const};
  gate.resolve({kind:'unknown',code:'lost',message:'lost',resultRef:ref});
  await first;
  expect(await calls.run('scope:one',mutate)).toMatchObject({kind:'unknown'});
  const read=vi.fn(()=>Promise.resolve({kind:'accepted' as const,revision:7,summary:'受理',resultRef:ref}));
  expect(await calls.verify(read)).toMatchObject({kind:'accepted'});
  expect(read).toHaveBeenCalledWith(expect.objectContaining({resultRef:ref}));
  expect(mutate).toHaveBeenCalledTimes(1);
  expect(calls.unresolved()).toEqual([]);
});

test('无权威引用的异常保持待核验，重建界面不自动重试',async()=>{
  const calls=new CommandInvocations(),mutate=vi.fn(()=>Promise.reject(Error('lost response')));
  expect(await calls.run('compact:one',mutate)).toMatchObject({kind:'unknown'});
  await calls.run('compact:one',mutate);
  await calls.verify(()=>Promise.resolve({kind:'rejected',code:'wrong_scope',message:'查询未执行'}));
  await calls.verify(result=>Promise.resolve(result));
  expect(calls.unresolved()).toHaveLength(1);
  expect(mutate).toHaveBeenCalledTimes(1);
  expect(new CommandInvocations().unresolved()).toEqual([]);
});

test('退出确认返回原审阅栏目与滚动，默认动作始终返回',()=>{
  let state=reduceTuiState(initialTuiState,{kind:'review-view',tab:3,scroll:9,action:1});
  state=reduceTuiState(state,{kind:'confirmation-requested',pending:{kind:'exit'}});
  expect(state.reviewAction).toBe(0);
  state=reduceTuiState(state,{kind:'confirmation-requested',pending:{kind:'cancel'}});
  state=reduceTuiState(state,{kind:'confirmation-dismissed'});
  expect(state.pendingConfirmation?.kind).toBe('exit');
  state=reduceTuiState(state,{kind:'confirmation-dismissed'});
  expect([state.reviewTab,state.reviewScroll,state.reviewAction]).toEqual([3,9,1]);
});

test('目录与选项独立搜索逐层返回，保留聊天正文和光标',async()=>{
  const fake=createFakePorts(),app=renderTui(fake.ports);
  try{
    await settle();
    await press(app,'首尾');await press(app,'\u001b[D');
    await command(app,'options');
    expect(frameText(app)).toContain('当前图标');
    await press(app,'ASCII');await press(app,'\r');
    expect(fake.executeCount()).toBe(0);
    await press(app,'\u001b');
    expect(frameText(app)).toContain('搜索 › options');
    await press(app,'\u001b');await press(app,'中');
    expect(frameText(app)).toContain('首中尾');
  }finally{app.unmount();fake.closeInputStore();}
});

test('目录空结果回车不执行，不修改普通草稿',async()=>{
  const fake=createFakePorts(),app=renderTui(fake.ports);
  try{
    await settle();await press(app,'草稿');
    await command(app,'compact');
    // 首次确实调用 compact；然后打开空结果查询。
    expect(fake.executeCount()).toBe(1);
    await press(app,'\u0010');await press(app,'[没有匹配');await press(app,'\r');
    expect(fake.executeCount()).toBe(1);expect(frameText(app)).toContain('没有匹配项');
    await press(app,'\u001b');expect(frameText(app)).toContain('草稿');
  }finally{app.unmount();fake.closeInputStore();}
});

test.each(['rejected','unknown'] as const)('slash 的 %s 结果保留完整原输入',async kind=>{
  const fake=createFakePorts({executeResult:{kind,code:'blocked',message:'本次结果未接受'}}),app=renderTui(fake.ports);
  try{
    await settle();await press(app,'/compact');await press(app,'\r');await press(app,'\r');
    expect(fake.executeCount()).toBe(1);expect(frameText(app)).toContain('/compact');
    if(kind==='unknown'){await press(app,'\r');expect(fake.executeCount()).toBe(1);}
  }finally{app.unmount();fake.closeInputStore();}
});

test.each(['unavailable','failed'] as const)('命令受理后刷新 %s 保留 slash，核验只重读状态',async mode=>{
  const fake=createFakePorts();let unreadable=false;
  const execute=vi.fn(()=>{unreadable=true;return Promise.resolve({kind:'accepted' as const,revision:8,summary:'已受理'});});
  const snapshot:typeof fake.ports.snapshot=session=>unreadable?(mode==='failed'?Promise.reject(Error('snapshot failed')):Promise.resolve({kind:'failed',code:'unavailable',message:'snapshot unavailable'})):fake.ports.snapshot(session);
  const app=renderTui({...fake.ports,execute,snapshot});
  try{
    await settle();await press(app,'/compact');await press(app,'\r');await press(app,'\r');
    expect(frameText(app)).toContain('/compact');await press(app,'\r');expect(execute).toHaveBeenCalledTimes(1);
    unreadable=false;await command(app,'verify-command-results');expect(execute).toHaveBeenCalledTimes(1);
    await press(app,'\u001b');expect(frameText(app)).toContain('/compact');
  }finally{app.unmount();fake.closeInputStore();}
});

test('compact 迟到受理不清除调用后新增的输入',async()=>{
  const fake=createFakePorts(),gate=Promise.withResolvers<ControllerCommandResult>();
  const execute=vi.fn(()=>gate.promise),app=renderTui({...fake.ports,execute});
  try{
    await settle();await press(app,'/compact');await press(app,'\r');await press(app,'\r');
    await press(app,'后来输入');gate.resolve({kind:'accepted',revision:null,summary:'受理'});await settle();
    expect(frameText(app)).toContain('/compact后来输入');expect(execute).toHaveBeenCalledTimes(1);
  }finally{app.unmount();fake.closeInputStore();}
});

test('模型目录绑定明确 Session，迟到查询不覆盖返回后的页面',async()=>{
  const fake=createFakePorts(),gate=Promise.withResolvers<Awaited<ReturnType<typeof fake.ports.modelCatalog.load>>>(),load=vi.fn(()=>gate.promise);
  const app=renderTui({...fake.ports,modelCatalog:{load}});
  try{
    await settle();await command(app,'model-picker');await press(app,'\u001b');
    gate.resolve({options:[{configurationRef:'config-b',model:'B'}],currentConfigurationRef:'config-b',switchable:true,switchBlockReason:null});await settle();
    expect(load).toHaveBeenCalledWith('session-b');
    expect(frameText(app)).not.toContain('Model Picker');expect(fake.executeCount()).toBe(0);
  }finally{app.unmount();fake.closeInputStore();}
});

test('交接精确读取悬挂期间连按只 prepare 一次并打开原提案',async()=>{
  const fake=createFakePorts(),gate=Promise.withResolvers<Awaited<ReturnType<typeof fake.ports.handoff.read>>>();
  const ref={kind:'planning-handoff' as const,coordinationScopeId:'scope-1',proposalId:'delayed-call',revision:3,phase:'prepared' as const};
  const prepareProposal=vi.fn(()=>Promise.resolve({kind:'accepted' as const,revision:7,summary:'受理',resultRef:ref}));
  const read=vi.fn(()=>gate.promise),app=renderTui({...fake.ports,handoff:{...fake.ports.handoff,prepareProposal,read}});
  try{
    await settle();await command(app,'handoff');await press(app,'\r');await press(app,'\r');
    expect(prepareProposal).toHaveBeenCalledTimes(1);
    gate.resolve({proposalId:ref.proposalId,proposalRevision:3,phase:'prepared',sourceSessionId:'session-b',targetSessionId:'session-a',mapRevision:1,planRevision:1,capsuleRef:'capsule-delay'});
    await settle(6);expect(frameText(app)).toContain('delayed-call');expect(read).toHaveBeenCalledWith('delayed-call');
  }finally{app.unmount();fake.closeInputStore();}
});

test.each(['missing','failed'] as const)('已受理交接在读取 %s 时保留原引用，连按不重建提案',async mode=>{
  const fake=createFakePorts();
  const ref={kind:'planning-handoff' as const,coordinationScopeId:'scope-1',proposalId:'prepared-call',revision:3,phase:'prepared' as const};
  const prepareProposal=vi.fn(()=>Promise.resolve({kind:'accepted' as const,revision:7,summary:'受理',resultRef:ref}));
  const read=vi.fn(()=>mode==='missing'?Promise.resolve(null):Promise.reject(Error('read failed')));
  const app=renderTui({...fake.ports,handoff:{...fake.ports.handoff,prepareProposal,read}});
  try{
    await settle();await command(app,'handoff');await press(app,'\r');await press(app,'\r');
    expect(prepareProposal).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith('prepared-call');
    expect(frameText(app)).toContain('核验');
  }finally{app.unmount();fake.closeInputStore();}
});

test('交接审阅精确选择本次 ID，拒绝 stale 时保留所见 revision',async()=>{
  const base={sourceSessionId:'session-b',targetSessionId:'session-a',phase:'prepared' as const,mapRevision:1,planRevision:1,capsuleRef:'capsule-2',proposalRevision:3};
  const fake=createFakePorts({snapshot:{planningHandoffs:[{...base,proposalId:'other'},{...base,proposalId:'this-call'}]}}),cutover=vi.fn(()=>Promise.resolve({kind:'rejected' as const,code:'stale_revision',message:'请重新审阅'}));
  const prepareProposal=vi.fn(()=>Promise.resolve({kind:'accepted' as const,revision:7,summary:'受理',resultRef:{kind:'planning-handoff' as const,coordinationScopeId:'scope-1',proposalId:'this-call',revision:3,phase:'prepared' as const}}));
  const app=renderTui({...fake.ports,handoff:{...fake.ports.handoff,prepareProposal,cutover}});
  try{
    await settle();await command(app,'handoff');await press(app,'\r');
    expect(frameText(app)).toContain('this-call');expect(frameText(app)).not.toContain('提案 other');
    await press(app,'\u001b[C');await press(app,'\r');
    expect(cutover).toHaveBeenCalledWith('this-call',3);expect(frameText(app)).toContain('Handoff Review');expect(frameText(app)).toContain('stale_revision');
  }finally{app.unmount();fake.closeInputStore();}
});
