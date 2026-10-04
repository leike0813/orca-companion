import { z } from 'zod';
import { CONTROL_STATES } from '../../domain/coordination/mode.js';
import { PLANNING_HANDOFF_PHASES, EXECUTION_HANDOFF_PHASES } from '../ports/branch-coordination-store.js';
const scope = { coordinationScopeId: z.string().min(1) };
const revision = z.number().int().nonnegative();
/** References to existing authoritative facts, never a second command ledger. */
export const commandResultRefSchema = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('scope'),...scope,revision,controlState:z.enum(CONTROL_STATES)}).strict(),
  z.object({kind:z.literal('session-model'),...scope,coordinatorSessionId:z.string().min(1),configurationRef:z.string().min(1),revision}).strict(),
  z.object({kind:z.literal('planning-handoff'),...scope,proposalId:z.string().min(1),revision,phase:z.enum(PLANNING_HANDOFF_PHASES)}).strict(),
  z.object({kind:z.literal('execution-handoff'),...scope,handoffId:z.string().min(1),revision,phase:z.enum(EXECUTION_HANDOFF_PHASES)}).strict(),
  z.object({kind:z.literal('authorization'),...scope,authorizationId:z.string().min(1),version:revision}).strict(),
]);
export type CommandResultRef = z.infer<typeof commandResultRefSchema>;
export type ReviewSection = { readonly id: string; readonly label: string; readonly fields: readonly { readonly label:string; readonly value:string; readonly group?:string }[] };
