import { z } from 'zod';

const statuslineFields = ['graph', 'ticket', 'work-package', 'progress', 'budget'] as const;

export const StatuslinePreferences = z.strictObject({
  modelFormat: z.enum(['model', 'provider-model']),
  contextFormat: z.enum(['used', 'remaining', 'tokens']),
  progressFormat: z.enum(['count', 'percent']),
  budgetKey: z.enum(['work-packages', 'implementation-attempts', 'recovery']),
  fields: z.array(z.enum(statuslineFields)).refine((fields) => new Set(fields).size === fields.length).readonly(),
});

export type StatuslinePreferences = z.infer<typeof StatuslinePreferences>;

export const TuiPreferences = z.strictObject({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative().safe(),
  iconMode: z.enum(['nerd', 'ascii']),
  statusline: StatuslinePreferences,
});

export type TuiPreferences = z.infer<typeof TuiPreferences>;

export const DEFAULT_TUI_PREFERENCES: TuiPreferences = {
  schemaVersion: 1,
  revision: 0,
  iconMode: 'nerd',
  statusline: {
    modelFormat: 'model',
    contextFormat: 'used',
    progressFormat: 'count',
    budgetKey: 'work-packages',
    fields: ['graph'],
  },
};

export type TuiPreferencesLoad = {
  readonly kind: 'loaded';
  readonly preferences: TuiPreferences;
  readonly writable: boolean;
  readonly notice: string | null;
};

export type TuiPreferencesSaveInput = {
  readonly expectedRevision: number;
  readonly patch:
    | { readonly kind: 'icons'; readonly iconMode: 'nerd' | 'ascii' }
    | { readonly kind: 'statusline'; readonly statusline: StatuslinePreferences };
};

export type TuiPreferencesSaveResult =
  | { readonly kind: 'saved'; readonly preferences: TuiPreferences }
  | { readonly kind: 'conflict'; readonly preferences: TuiPreferences }
  | { readonly kind: 'failed'; readonly code: string; readonly message: string };

export type TuiPreferencesPort = {
  load(): Promise<TuiPreferencesLoad>;
  save(input: TuiPreferencesSaveInput): Promise<TuiPreferencesSaveResult>;
};
