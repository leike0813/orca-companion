import { createHash } from 'node:crypto';
import type { CatalogModel, ProviderPreset } from './provider-catalog.js';
import type { EffortCapability, ProviderProtocol } from '../../domain/model-configuration.js';

export type ProviderCatalogData = { version: string; presets: ProviderPreset[]; models: CatalogModel[] };

const protocolByNpm = new Map<string, ProviderProtocol>([
  ['@ai-sdk/openai', 'openai-chat'], ['@ai-sdk/openai-compatible', 'openai-chat'],
  ['@ai-sdk/anthropic', 'anthropic-messages'], ['@ai-sdk/google', 'google-gemini'],
]);
const productPresets: ProviderPreset[] = [
  { id: 'minimax-global', label: 'MiniMax (Global)', protocol: 'anthropic-messages', baseUrl: 'https://api.minimax.io/anthropic', discovery: true },
  { id: 'minimax-cn', label: 'MiniMax (China)', protocol: 'anthropic-messages', baseUrl: 'https://api.minimax.cn/anthropic', discovery: true },
  { id: 'moonshot-global', label: 'Moonshot AI (Global)', protocol: 'openai-chat', baseUrl: 'https://api.moonshot.ai/v1', discovery: true },
  { id: 'moonshot-cn', label: 'Moonshot AI (China)', protocol: 'openai-chat', baseUrl: 'https://api.moonshot.cn/v1', discovery: true },
  { id: 'azure-openai', label: 'Azure OpenAI (deployment endpoint)', protocol: 'openai-chat', baseUrl: null, discovery: false },
  { id: 'groq', label: 'Groq', protocol: 'openai-chat', baseUrl: 'https://api.groq.com/openai/v1', discovery: true },
  { id: 'mistral', label: 'Mistral AI', protocol: 'openai-chat', baseUrl: 'https://api.mistral.ai/v1', discovery: true },
  { id: 'cohere', label: 'Cohere', protocol: 'openai-chat', baseUrl: 'https://api.cohere.ai/compatibility/v1', discovery: false },
];
const presetOverrides: Record<string, Partial<ProviderPreset>> = {
  minimax: { label: 'MiniMax (Global)', baseUrl: 'https://api.minimax.io/anthropic' },
  'minimax-cn': { label: 'MiniMax (China)', baseUrl: 'https://api.minimax.cn/anthropic' },
  moonshotai: { label: 'Moonshot AI (Global)', baseUrl: 'https://api.moonshot.ai/v1' },
  'moonshot-cn': { id: 'moonshot-cn', label: 'Moonshot AI (China)', baseUrl: 'https://api.moonshot.cn/v1' },
};

const effort = (values: string[], source: string, optionPath: string): EffortCapability => ({ values, source, optionPath });
const verifiedEffort = new Map<string, EffortCapability>([
  ['openai\0gpt-5.1', effort(['none', 'low', 'medium', 'high'], 'OpenAI API: gpt-5.1 reasoning effort', 'reasoning.effort')],
]);

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function convertModelsDev(raw: unknown): ProviderCatalogData {
  if (!isRecord(raw)) throw new Error('provider_catalog_invalid');
  const presets: ProviderPreset[] = [], models: CatalogModel[] = [];
  for (const [id, value] of Object.entries(raw)) {
    if (!id || !isRecord(value)) continue;
    const protocol = id === 'openai' ? 'openai-responses' : protocolByNpm.get(String(value['npm']));
    if (!protocol || !Array.isArray(value['env']) || !value['env'].some((entry) => typeof entry === 'string' && entry.endsWith('API_KEY'))) continue;
    const name = typeof value['name'] === 'string' ? value['name'] : id;
    let baseUrl = typeof value['api'] === 'string' && !value['api'].includes('${') ? value['api'] : null;
    if (id === 'openai') baseUrl = 'https://api.openai.com/v1';
    if (id === 'anthropic') baseUrl = 'https://api.anthropic.com';
    if (protocol === 'anthropic-messages' && baseUrl !== null) baseUrl = baseUrl.replace(/\/v1\/?$/, '');
    if (id === 'google') baseUrl = 'https://generativelanguage.googleapis.com';
    const override = presetOverrides[id];
    presets.push({ id, label: name, protocol, baseUrl, discovery: true, ...override });
    if (!isRecord(value['models'])) continue;
    const providerModels: CatalogModel[] = [];
    for (const [modelId, modelValue] of Object.entries(value['models'])) {
      if (!modelId || !isRecord(modelValue)) continue;
      const limit = modelValue['limit'];
      const contextWindow = isRecord(limit) && Number.isSafeInteger(limit['context']) && Number(limit['context']) > 0 ? Number(limit['context']) : null;
      providerModels.push({ id: modelId, label: typeof modelValue['name'] === 'string' ? modelValue['name'] : modelId, providerId: id, protocol,
        effortCapability: verifiedEffort.get(`${id}\0${modelId}`) ?? null, contextWindow });
    }
    models.push(...providerModels);
    if (id === 'openai') {
      presets.push({ id: 'openai-chat', label: 'OpenAI (Chat Completions API)', protocol: 'openai-chat', baseUrl, discovery: true });
      models.push(...providerModels.map((model) => ({ ...model, providerId: 'openai-chat', protocol: 'openai-chat' as const })));
    }
  }
  const byId = new Map(presets.map((preset) => [preset.id, preset]));
  for (const preset of productPresets) {
    const origin = preset.id === 'minimax-global' ? 'minimax' : preset.id === 'moonshot-global' || preset.id === 'moonshot-cn' ? 'moonshotai' : preset.id;
    if (!byId.has(preset.id)) {
      models.push(...models.filter(model => model.providerId === origin && model.protocol === preset.protocol).map(model => ({ ...model, providerId: preset.id })));
    }
    byId.set(preset.id, preset);
  }
  const sortedPresets = [...byId.values()].sort((a, b) => a.label.localeCompare(b.label));
  models.sort((a, b) => a.providerId.localeCompare(b.providerId) || a.id.localeCompare(b.id));
  return { version: `models.dev-${fingerprint({ presets: sortedPresets, models })}`, presets: sortedPresets, models };
}
