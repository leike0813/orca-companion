import { describe, expect, test, vi } from 'vitest';

import {
  DEFAULT_TUI_PREFERENCES,
  type TuiPreferences,
  type TuiPreferencesPort,
  type TuiPreferencesSaveInput,
  type TuiPreferencesSaveResult,
} from '../../src/application/configuration/tui-preferences.js';
import { statuslineSettingRows, updateStatuslinePreference } from '../../src/interfaces/tui/components/statusline-settings.js';
import { chooseCommand, createFakePorts, renderTui, settle } from './harness.js';

function preferencesPort(save: (input: TuiPreferencesSaveInput) => Promise<TuiPreferencesSaveResult>): TuiPreferencesPort {
  return {
    load: () => Promise.resolve({ kind: 'loaded', preferences: { ...DEFAULT_TUI_PREFERENCES, revision: 4 }, writable: true, notice: null }),
    save,
  };
}

function saved(input: TuiPreferencesSaveInput, revision: number): TuiPreferencesSaveResult {
  const preferences: TuiPreferences = {
    ...DEFAULT_TUI_PREFERENCES,
    revision,
    ...(input.patch.kind === 'icons' ? { iconMode: input.patch.iconMode } : { statusline: input.patch.statusline }),
  };
  return { kind: 'saved', preferences };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function chooseIconMode(rendered: ReturnType<typeof renderTui>, mode: 'nerd' | 'ascii') {
  const command = mode === 'ascii' ? 'icons-ascii' : 'icons-nerd';
  await chooseCommand(rendered, command);
  rendered.stdin.write('\u001b');
  await new Promise(resolve => setTimeout(resolve, 100));
  await settle();
}

describe('状态栏偏好编辑', () => {
  test('字段顺序、格式切换和默认值遵循当前草稿', () => {
    const defaults = DEFAULT_TUI_PREFERENCES.statusline;
    expect(defaults).toEqual({ modelFormat: 'model', contextFormat: 'used', progressFormat: 'count', budgetKey: 'work-packages', fields: ['graph'] });
    const reordered = updateStatuslinePreference({ ...defaults, fields: ['graph', 'ticket'] }, 'ticket', -1);
    expect(reordered.fields).toEqual(['ticket', 'graph']);
    expect(updateStatuslinePreference(defaults, 'contextFormat', 1).contextFormat).toBe('remaining');
    expect(updateStatuslinePreference(defaults, 'progressFormat', 1).progressFormat).toBe('percent');
    expect(statuslineSettingRows(reordered).slice(3, 5)).toEqual(['ticket', 'graph']);
  });

  test('已接偏好端口时 slash 候选可采用并打开状态栏设置', async () => {
    const fake = createFakePorts();
    const rendered = renderTui({
      ...fake.ports,
      preferences: preferencesPort(input => Promise.resolve(saved(input, 5))),
    });
    try {
      await settle();
      rendered.stdin.write('/statusline');
      await settle();
      expect(rendered.lastFrame()).toContain('命令候选');
      expect(rendered.lastFrame()).not.toContain('用户偏好端口不可用');

      rendered.stdin.write('\t');
      await settle();
      expect(rendered.lastFrame()).toContain('/statusline');
      rendered.stdin.write('\r');
      await settle();
      expect(rendered.lastFrame()).toContain('状态栏设置');
      expect(rendered.lastFrame()).not.toContain('用户偏好端口不可用');
    } finally {
      rendered.unmount();
      fake.closeInputStore();
    }
  });

  test('Enter 在任意行保存格式与有序字段；Esc 丢弃草稿', async () => {
    const fake = createFakePorts();
    const writes: TuiPreferencesSaveInput[] = [];
    const rendered = renderTui({
      ...fake.ports,
      preferences: preferencesPort(input => { writes.push(input); return Promise.resolve(saved(input, 5)); }),
    });
    try {
      await settle();
      await chooseCommand(rendered, 'statusline');
      rendered.stdin.write('\u001b[C');
      await settle();
      for (let index = 0; index < 4; index += 1) { rendered.stdin.write('\u001b[B'); await settle(); }
      rendered.stdin.write(' ');
      await settle();
      rendered.stdin.write('\u001b[D');
      await settle();
      rendered.stdin.write('\r');
      await settle();

      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({ expectedRevision: 4, patch: { kind: 'statusline', statusline: { modelFormat: 'provider-model', fields: ['ticket', 'graph'] } } });
      expect(rendered.lastFrame()).not.toContain('Enter 保存 · Esc 取消');

      await chooseCommand(rendered, 'statusline');
      rendered.stdin.write('\u001b[B');
      await settle();
      rendered.stdin.write('\u001b');
      await new Promise(resolve => setTimeout(resolve, 100));
      await settle();
      await chooseCommand(rendered, 'statusline');
      expect(rendered.lastFrame()).toContain('模型名称：Provider + 模型');
      expect(writes).toHaveLength(1);
    } finally {
      rendered.unmount();
      fake.closeInputStore();
    }
  });

  test('CAS 冲突和保存失败保留草稿，并要求再次明确 Enter', async () => {
    const fake = createFakePorts();
    const writes: TuiPreferencesSaveInput[] = [];
    let count = 0;
    const rendered = renderTui({
      ...fake.ports,
      preferences: preferencesPort(input => {
        writes.push(input);
        count += 1;
        if (count === 1) return Promise.resolve({ kind: 'conflict', preferences: { ...DEFAULT_TUI_PREFERENCES, revision: 5, statusline: { ...DEFAULT_TUI_PREFERENCES.statusline, contextFormat: 'tokens' } } });
        if (count === 2) return Promise.resolve({ kind: 'failed', code: 'write_failed', message: '暂不可写' });
        return Promise.resolve(saved(input, 6));
      }),
    });
    try {
      await settle();
      await chooseCommand(rendered, 'statusline');
      rendered.stdin.write('\u001b[C');
      await settle();
      rendered.stdin.write('\r');
      await settle();
      expect(rendered.lastFrame()).toContain('草稿保留，再按 Enter 明确保存');
      expect(rendered.lastFrame()).toContain('Provider + 模型');

      rendered.stdin.write('\r');
      await settle();
      expect(rendered.lastFrame()).toContain('草稿保留，可重试');
      expect(writes[1]?.expectedRevision).toBe(5);
      expect(writes[1]?.patch).toMatchObject({ kind: 'statusline', statusline: { modelFormat: 'provider-model' } });

      rendered.stdin.write('\r');
      await settle();
      expect(writes).toHaveLength(3);
      expect(rendered.lastFrame()).not.toContain('状态栏设置');
    } finally {
      rendered.unmount();
      fake.closeInputStore();
    }
  });

  test('旧保存回调不覆盖重新打开的设置页或新草稿', async () => {
    const fake = createFakePorts();
    const pending = deferred<TuiPreferencesSaveResult>();
    const rendered = renderTui({
      ...fake.ports,
      preferences: preferencesPort(() => pending.promise),
    });
    try {
      await settle();
      await chooseCommand(rendered, 'statusline');
      rendered.stdin.write('\u001b[C');
      await settle();
      rendered.stdin.write('\r');
      await settle();
      rendered.stdin.write('\u001b');
      await new Promise(resolve => setTimeout(resolve, 100));
      await settle();
      await chooseCommand(rendered, 'statusline');
      rendered.stdin.write('\u001b[B'); await settle();
      rendered.stdin.write('\u001b[B'); await settle();
      rendered.stdin.write('\u001b[C'); await settle();

      pending.reject(new Error('旧请求失败'));
      await settle();
      expect(rendered.lastFrame()).toContain('预览 · 主区域');
      expect(rendered.lastFrame()).toContain('剩余比例');
      expect(rendered.lastFrame()).not.toContain('旧请求失败');
    } finally {
      rendered.unmount();
      fake.closeInputStore();
    }
  });

  test('图标异步保存只清除当前选择的未保存状态，并使用独立分区写入', async () => {
    const fake = createFakePorts();
    const iconWrites: TuiPreferencesSaveInput[] = [];
    const pending = [deferred<TuiPreferencesSaveResult>(), deferred<TuiPreferencesSaveResult>()];
    const rendered = renderTui({
      ...fake.ports,
      preferences: preferencesPort(async input => {
        iconWrites.push(input);
        return pending[iconWrites.length - 1]!.promise;
      }),
    });
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      await settle();
      await chooseIconMode(rendered, 'ascii');
      await vi.waitFor(() => expect(iconWrites).toHaveLength(1));
      await chooseIconMode(rendered, 'nerd');
      await vi.waitFor(() => expect(iconWrites).toHaveLength(2));
      expect(iconWrites.map(write => write.patch)).toEqual([
        { kind: 'icons', iconMode: 'ascii' },
        { kind: 'icons', iconMode: 'nerd' },
      ]);

      pending[0]!.resolve({ kind: 'saved', preferences: { ...DEFAULT_TUI_PREFERENCES, revision: 5, iconMode: 'ascii' } });
      await chooseCommand(rendered, 'options');
      await vi.waitFor(() => expect(rendered.lastFrame()).toContain('图标未保存'));
      expect(rendered.lastFrame()).toContain('当前图标 nerd');
      expect(iconWrites.every(write => write.patch.kind === 'icons')).toBe(true);
      pending[1]!.resolve({ kind: 'conflict', preferences: { ...DEFAULT_TUI_PREFERENCES, revision: 5, iconMode: 'ascii' } });
      await vi.waitFor(() => expect(rendered.lastFrame()).toContain('图标未保存'));
    } finally {
      rendered.unmount();
      fake.closeInputStore();
    }
  });

  test('环境图标覆盖保持临时，不改写已保存偏好', async () => {
    const original = process.env['ORCA_COMPANION_TUI_ICONS'];
    process.env['ORCA_COMPANION_TUI_ICONS'] = 'ascii';
    const fake = createFakePorts();
    const writes: TuiPreferencesSaveInput[] = [];
    const rendered = renderTui({
      ...fake.ports,
      preferences: preferencesPort(input => { writes.push(input); return Promise.resolve(saved(input, 5)); }),
    });
    try {
      await settle();
      await chooseCommand(rendered, 'options');
      expect(rendered.lastFrame()).toContain('当前图标 ascii');
      expect(writes).toHaveLength(0);
    } finally {
      rendered.unmount();
      fake.closeInputStore();
      if (original === undefined) delete process.env['ORCA_COMPANION_TUI_ICONS'];
      else process.env['ORCA_COMPANION_TUI_ICONS'] = original;
    }
  });
});
