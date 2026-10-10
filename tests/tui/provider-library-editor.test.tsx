import { cleanup, render } from 'ink-testing-library';
import { createElement } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { ProviderCatalog } from '../../src/application/configuration/provider-catalog.js';
import type { ProviderLibrary } from '../../src/application/configuration/provider-library.js';
import { ProviderLibraryEditor } from '../../src/interfaces/tui/components/provider-library-editor.js';

const connection = {
  connectionRef: 'connection-1', label: 'OpenAI', providerId: 'openai', providerIntegration: 'openai-chat',
  baseUrl: 'https://api.openai.com/v1', credential: { kind: 'managed', credentialRef: 'credential-1' },
};
const model = { modelRef: 'model-1', connectionRef: connection.connectionRef, model: 'gpt-fixture', effortCapability: null };
const candidate = {
  id: model.model, label: model.model, providerId: 'openai', protocol: 'openai-chat' as const,
  effortCapability: null, contextWindow: null,
};
afterEach(cleanup);

function frameText(rendered: ReturnType<typeof render>): string {
  return rendered.lastFrame() ?? '';
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('ProviderLibraryEditor', () => {
  test.each(['rejected', 'edited', 'unmounted'] as const)('does not hand off a pending selection after %s', async (scenario) => {
    let finishSelection!: (message: string | void) => void;
    const onSelect = vi.fn(() => new Promise<string | void>((resolve) => { finishSelection = resolve; }));
    const onSelected = vi.fn();
    const library = {
      load: () => ({ kind: 'loaded', revision: 1, connections: [connection], models: [model] }),
    } as unknown as ProviderLibrary;
    const catalog = {
      presets: () => [],
      candidates: () => ({ models: [candidate], source: 'catalog', catalogVersion: 'test', expired: false }),
      discover: () => Promise.resolve({ models: [candidate], source: 'discovery', catalogVersion: 'test', expired: false }),
      refresh: () => Promise.resolve({ kind: 'unchanged', catalogVersion: 'test' }),
    } as unknown as ProviderCatalog;
    const rendered = render(createElement(ProviderLibraryEditor, {
      library, catalog, width: 100, onSelect, onSelected, onCancel: vi.fn(),
    }));
    await settle();
    rendered.stdin.write('\r'); await settle();
    rendered.stdin.write('\u001b[B'); await settle();
    rendered.stdin.write('\r'); await settle();
    await settle();
    expect(onSelect).toHaveBeenCalledWith(model.modelRef, null);
    if (scenario === 'unmounted') rendered.unmount();
    else rendered.stdin.write('x');
    await settle();
    finishSelection(scenario === 'rejected' ? 'project configuration changed' : undefined);
    await settle();
    expect(onSelected).not.toHaveBeenCalled();
    if (scenario === 'rejected') expect(frameText(rendered)).toContain('save_failed');
    if (scenario !== 'unmounted') {
      expect(frameText(rendered)).toContain('模型候选与手动填写');
      expect(frameText(rendered)).toContain('搜索  x');
    }
  });
});
