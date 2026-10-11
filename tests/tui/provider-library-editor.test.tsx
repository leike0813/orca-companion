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

async function settle(ticks = 5): Promise<void> {
  for (let index = 0; index < ticks; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
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
    // 候选沿定稿只确认独立横向 effort：Enter 到动作区 → 显式选择「应用选择」→ Enter。
    rendered.stdin.write('\r'); await settle();
    rendered.stdin.write('\u001b[C'); await settle();
    rendered.stdin.write('\r'); await settle();
    await settle();
    expect(onSelect).toHaveBeenCalledWith(model.modelRef, null);
    if (scenario === 'unmounted') rendered.unmount();
    else {
      // 走动作行的「返回」：leftArrow 切回返回，Enter 回到模型列表，再编辑查询。
      rendered.stdin.write('\u001b[D');
      await settle();
      rendered.stdin.write('\r');
      await settle();
      rendered.stdin.write('x');
    }
    await settle();
    finishSelection(scenario === 'rejected' ? 'project configuration changed' : undefined);
    await settle();
    expect(onSelected).not.toHaveBeenCalled();
    if (scenario === 'rejected') expect(frameText(rendered)).toContain('save_failed');
    if (scenario !== 'unmounted') expect(frameText(rendered)).toContain('模型候选与手动填写');
  });
});

function editorWith(overrides: { models?: readonly unknown[]; saves?: unknown[]; rejectSave?: boolean } = {}) {
  const saves = overrides.saves ?? [];
  // 与 saveModel 一致：目录没有精确能力来源时，记录保存的是该固定协议的 effort 预设。
  const presetEffort = { values: ['none', 'minimal', 'low', 'medium', 'high'], source: 'OpenAI reasoning.effort', optionPath: 'reasoning.effort' };
  const library = {
    load: () => ({ kind: 'loaded', revision: 1, connections: [connection], models: overrides.models ?? [] }),
    saveModel: (input: { model: string; metadata?: unknown }) => {
      saves.push(input);
      if (overrides.rejectSave) return { kind: 'rejected', code: 'store_busy', message: 'retry explicitly' };
      return { kind: 'saved', revision: 2, model: { modelRef: 'model-manual', connectionRef: connection.connectionRef, model: input.model, effortCapability: presetEffort, metadata: input.metadata } };
    },
  } as unknown as ProviderLibrary;
  const discover = vi.fn(() => Promise.resolve({ models: [candidate], source: 'discovery' as const, catalogVersion: 'test', expired: false }));
  const catalog = {
    presets: () => [],
    candidates: () => ({ models: [candidate], source: 'catalog', catalogVersion: 'test', expired: false }),
    discover,
    refresh: () => Promise.resolve({ kind: 'unchanged' as const, catalogVersion: 'test' }),
  } as unknown as ProviderCatalog;
  return { library, catalog, saves, discover };
}

/** 进入模型列表：选中首个连接。 */
async function openModelList(rendered: ReturnType<typeof render>): Promise<void> {
  rendered.stdin.write('\r'); await settle();
}

describe('ProviderLibraryEditor 手填 exact ID', () => {
  test('Enter 进入声明并保存声明的窗口与模态，不发起目录查询', async () => {
    const { library, catalog, saves, discover } = editorWith();
    const onSelect = vi.fn();
    const rendered = render(createElement(ProviderLibraryEditor, { library, catalog, width: 100, onSelect, onCancel: vi.fn() }));
    await settle();
    await openModelList(rendered);
    for (const character of 'vendor/exact-model-id') { rendered.stdin.write(character); await settle(1); }
    rendered.stdin.write('\r'); await settle();
    // 声明步尚未保存：手填与目录发现是两条独立路径。
    expect(discover).not.toHaveBeenCalled();
    expect(saves).toEqual([]);
    expect(frameText(rendered)).toContain('模型声明');

    rendered.stdin.write('200000'); await settle(1);
    rendered.stdin.write('\t'); await settle(1);          // 输入模态区域
    rendered.stdin.write(' '); await settle(1);           // text 恒在，空格切换无效
    rendered.stdin.write('\u001b[C'); await settle(1);   // image
    rendered.stdin.write(' '); await settle(1);
    rendered.stdin.write('\r'); await settle(1);          // 动作区（默认返回）
    rendered.stdin.write('\u001b[C'); await settle(1);    // 保存模型
    rendered.stdin.write('\r'); await settle();

    expect(saves).toEqual([{ expectedRevision: 1, connectionRef: connection.connectionRef, model: 'vendor/exact-model-id', metadata: { contextWindow: 200000, inputModalities: ['text', 'image'], source: 'user_declared' } }]);
    expect(onSelect).toHaveBeenCalledWith('model-manual', null);
    expect(discover).not.toHaveBeenCalled();
  });

  test('非法窗口或只有一半的声明被拒绝，且保留全部输入', async () => {
    const { library, catalog, saves } = editorWith();
    const rendered = render(createElement(ProviderLibraryEditor, { library, catalog, width: 100, onSelect: vi.fn(), onCancel: vi.fn() }));
    await settle();
    await openModelList(rendered);
    for (const character of 'vendor/exact-model-id') { rendered.stdin.write(character); await settle(1); }
    rendered.stdin.write('\r'); await settle();

    // 完整声明中的非法窗口：校验失败须保留窗口和模态。
    rendered.stdin.write('0'); await settle(1);
    rendered.stdin.write('\t'); await settle(1);
    rendered.stdin.write(' '); await settle(1);
    rendered.stdin.write('\r'); await settle(1);
    rendered.stdin.write('\u001b[C'); await settle(1);
    rendered.stdin.write('\r'); await settle();
    expect(saves).toEqual([]);
    expect(frameText(rendered)).toContain('模型声明');
    expect(frameText(rendered)).toContain('输入模态 text');

    // 窗口为 0 不是正安全整数：修好窗口并补上模态后才能保存。
    expect(frameText(rendered)).toContain('上下文窗口 0');
    rendered.stdin.write('\u007f'); await settle(1);
    rendered.stdin.write('4096'); await settle(1);
    rendered.stdin.write('\t'); await settle(1);
    rendered.stdin.write(' '); await settle(1);
    rendered.stdin.write('\u001b[C'); await settle(1);
    rendered.stdin.write(' '); await settle(1);
    rendered.stdin.write('\r'); await settle(1);
    rendered.stdin.write('\u001b[C'); await settle(1);
    rendered.stdin.write('\r'); await settle();
    expect(saves).toEqual([{ expectedRevision: 1, connectionRef: connection.connectionRef, model: 'vendor/exact-model-id', metadata: { contextWindow: 4096, inputModalities: ['text', 'image'], source: 'user_declared' } }]);
  });

  test('已保存的声明在再次选定同一模型时恢复', async () => {
    const saved = { modelRef: 'model-saved', connectionRef: connection.connectionRef, model: 'vendor/exact-model-id', effortCapability: null,
      metadata: { contextWindow: 32000, inputModalities: ['text'], source: 'user_declared' } };
    const { library, catalog, saves } = editorWith({ models: [saved] });
    const onSelect = vi.fn();
    const rendered = render(createElement(ProviderLibraryEditor, { library, catalog, width: 100, onSelect, onCancel: vi.fn() }));
    await settle();
    await openModelList(rendered);
    for (const character of 'vendor/exact-model-id') { rendered.stdin.write(character); await settle(1); }
    rendered.stdin.write('\r'); await settle();
    expect(frameText(rendered)).toContain('32000');
    expect(frameText(rendered)).toContain('text');

    rendered.stdin.write('\u0009'); await settle(1);   // Tab 依次经过模态与 effort
    rendered.stdin.write('\r'); await settle(1);
    rendered.stdin.write('\u001b[C'); await settle(1);
    rendered.stdin.write('\r'); await settle();
    // 声明与既有记录一致时复用原引用，不追加第二条记录。
    expect(saves).toEqual([]);
    expect(onSelect).toHaveBeenCalledWith('model-saved', null);
  });
  test('同 exact ID 的追加记录按最新明确引用恢复，保存失败保留其声明', async () => {
    const old = { ...model, model: 'vendor/reused', modelRef: 'old',
      metadata: { contextWindow: 32000, inputModalities: ['text'], source: 'user_declared' } };
    const latest = { ...old, modelRef: 'latest', metadata: { ...old.metadata, contextWindow: 16000 } };
    const { library, catalog } = editorWith({ models: [old, latest], rejectSave: true });
    const onSelect = vi.fn();
    const rendered = render(createElement(ProviderLibraryEditor, { library, catalog, width: 100, onSelect, onCancel: vi.fn() }));
    await settle(); await openModelList(rendered);
    rendered.stdin.write('vendor/reused'); await settle();
    rendered.stdin.write('\r'); await settle();
    expect(frameText(rendered)).toContain('16000');
    expect(frameText(rendered)).not.toContain('32000');
    for (let index = 0; index < 5; index++) { rendered.stdin.write('\u007f'); await settle(1); }
    rendered.stdin.write('8000'); await settle();
    rendered.stdin.write('\r'); await settle();
    rendered.stdin.write('\u001b[C'); await settle();
    rendered.stdin.write('\r'); await settle();
    expect(frameText(rendered)).toContain('store_busy');
    expect(frameText(rendered)).toContain('8000');
    expect(frameText(rendered)).toContain('输入模态 text');
    expect(onSelect).not.toHaveBeenCalled();
  });

  test('目录候选用左右键选 effort，并与模型一起交接', async () => {
    const { library, catalog } = editorWith();
    const onSelect = vi.fn();
    const rendered = render(createElement(ProviderLibraryEditor, { library, catalog, width: 100, onSelect, onCancel: vi.fn() }));
    await settle();
    await openModelList(rendered);
    rendered.stdin.write('\u001b[B'); await settle(1);    // 选中目录候选
    rendered.stdin.write('\r'); await settle();          // 目录候选：先保存记录
    rendered.stdin.write('\u001b[C'); await settle(1);    // effort 区域：选择第一个取值
    rendered.stdin.write('\r'); await settle(1);          // 动作区（默认返回）
    rendered.stdin.write('\u001b[C'); await settle(1);    // 应用选择
    rendered.stdin.write('\r'); await settle();
    expect(onSelect).toHaveBeenCalledWith('model-manual', 'none');
  });

  test('既有记录没有可信 effort 来源时不提供 effort', async () => {
    // 旧记录的能力来源为 null：界面不得拿协议预设冒充它已保存的能力。
    const saved = { modelRef: 'model-legacy', connectionRef: connection.connectionRef, model: 'gpt-fixture', effortCapability: null };
    const { library, catalog } = editorWith({ models: [saved] });
    const rendered = render(createElement(ProviderLibraryEditor, { library, catalog, width: 100, onSelect: vi.fn(), onCancel: vi.fn() }));
    await settle();
    await openModelList(rendered);
    rendered.stdin.write('\u001b[B'); await settle(1);   // 选中目录候选（既有记录）
    rendered.stdin.write('\r'); await settle();
    expect(frameText(rendered)).toContain('不适用');
    rendered.stdin.write('\r'); await settle(1);
    rendered.stdin.write('\u001b[C'); await settle(1);
    rendered.stdin.write('\r'); await settle();
    expect(rendered.lastFrame()).not.toBeUndefined();
  });
});
