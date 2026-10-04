import type { ControllerCommandResult } from '../../application/controller-service.js';

export type MutationOutcome = ControllerCommandResult & { readonly refreshFailed?: boolean };
export type CommandOutcome = { readonly kind: 'opened' } | MutationOutcome;
/** In-process input guard only. Durable outcomes remain with their original owners. */
export class CommandInvocations {
  private readonly pending = new Map<string, MutationOutcome | null>();
  peek(key: string): MutationOutcome | undefined {
    return this.pending.has(key) ? this.pending.get(key) ?? { kind: 'rejected', code: 'command_in_flight', message: '原调用仍在途，请等待结果' } : undefined;
  }
  async run(key: string, action: () => Promise<MutationOutcome>): Promise<MutationOutcome> {
    const prior=this.peek(key);
    if (prior) return prior;
    if (this.pending.size >= 32) return { kind: 'rejected', code: 'command_capacity', message: '待核验调用已满，请先核验原结果' };
    this.pending.set(key,null);
    let result: MutationOutcome;
    try { result = await action(); }
    catch (error) { result = { kind: 'unknown', code: 'command_unverifiable', message: error instanceof Error ? error.message : String(error) }; }
    if (result.kind === 'unknown' || result.kind === 'accepted' && result.refreshFailed) this.pending.set(key,result);
    else this.pending.delete(key);
    return result;
  }
  unresolved(): readonly { key: string; result: MutationOutcome }[] {
    return [...this.pending].flatMap(([key,result]) => result?.kind === 'unknown' || result?.kind === 'accepted' && result.refreshFailed ? [{key,result}] : []);
  }
  async verify(read: (result: MutationOutcome) => Promise<MutationOutcome>): Promise<MutationOutcome> {
    const entries=this.unresolved();
    if (!entries.length) return {kind:'rejected',code:'no_pending_command',message:'没有待核验命令'};
    for(const {key,result} of entries){
      let verified:MutationOutcome;
      try{verified=await read(result);}catch(error){verified={kind:'unknown',code:'command_unverifiable',message:String(error),...(result.kind==='unknown'&&result.resultRef?{resultRef:result.resultRef}:{})};}
      if(verified.kind==='accepted'&&!verified.refreshFailed)this.pending.delete(key);
      else if(verified.kind==='unknown'||verified.kind==='accepted'&&verified.refreshFailed)this.pending.set(key,verified);
      // A rejected query is not evidence that the original mutation was rejected.
    }
    return this.unresolved()[0]?.result ?? {kind:'accepted',revision:null,summary:'原调用结果已核验'};
  }
}
