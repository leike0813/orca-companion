import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { createElement } from 'react';
import { cleanup, render } from 'ink-testing-library';
import { ModelSettingsEditor } from '../dist/src/interfaces/tui/components/model-settings-editor.js';
import { EMPTY_MODEL_SETTINGS_EDIT } from '../dist/src/interfaces/tui/state.js';

const root = new globalThis.URL('../artifacts/coordinator-provider-tui/', import.meta.url);
const connection = { connectionRef: 'review-connection', label: 'OpenAI 主连接', providerId: 'openai', providerIntegration: 'openai-responses', baseUrl: 'https://api.openai.com/v1', credential: { kind: 'managed', credentialRef: '11111111-1111-4111-8111-111111111111' } };
const models = ['gpt-test', 'gpt-pro', 'gpt-mini', 'gpt-reasoning'].map(id => ({ id, label: id, providerId: 'openai', protocol: 'openai-responses', effortCapability: null, contextWindow: null }));
const common = { ...EMPTY_MODEL_SETTINGS_EDIT, connections: [connection], connectionRef: connection.connectionRef, label: connection.label, providerId: connection.providerId, providerIntegration: connection.providerIntegration, baseUrl: connection.baseUrl, selectedIndex: 0 };
const scenes = {
  'model-candidates': { ...common, stage: 'models', catalogResult: { models, source: 'catalog', catalogVersion: 'review', expired: false } },
  connections: { ...common, stage: 'connections' },
  'connection-key': { ...common, stage: 'connection', secret: 'synthetic-hidden-key', field: 'secret' },
};
await mkdir(root, { recursive: true });
for (const [name, edit] of Object.entries(scenes)) {
  for (const [width, rows] of [[120, 40], [80, 24], [50, 40]]) {
    const element = createElement(ModelSettingsEditor, { edit, notice: null, failing: false, availableWidth: width, rows, identity: 'Coordinator · 模型设置' });
    const instance = render(element);
    Object.defineProperty(instance.stdout, 'columns', { get: () => width });
    instance.rerender(element);
    await setTimeout(40);
    const frame = instance.lastFrame();
    if (!frame || frame.includes('synthetic-hidden-key')) throw new Error('invalid review frame');
    await writeFile(new globalThis.URL(`${name}-${width}x${rows}.txt`, root), frame + '\n');
    instance.unmount();
    cleanup();
  }
}
