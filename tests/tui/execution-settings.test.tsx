/**
 * IP-04 的 TUI 行为测试：执行并发设置入口的读取、保存与失败保留。
 *
 * 断言的是用户可观察事实：默认值/当前批准值同时展示、Enter 保存提交的 CAS 输入、保存失败时草稿保留；
 * 不锁定组件内部字段顺序或完整文案。
 */

import { describe, expect, test } from 'vitest';

import { executionSettingsDraftValid } from '../../src/interfaces/tui/components/execution-settings.js';
import type { ExecutionSettingsPort, ExecutionSettingsSaveResult } from '../../src/interfaces/tui/ports.js';
import { chooseCommand, createFakePorts, renderTui, settle } from './harness.js';

function settingsPort(
  save: (input: { expectedRevision: number; maxActiveWorkPackages: number }) => Promise<ExecutionSettingsSaveResult>,
): ExecutionSettingsPort {
  return {
    load: () => Promise.resolve({ kind: 'loaded', settings: {
      revision: 4,
      defaultMaxActiveWorkPackages: 3,
      approvedMaxActiveWorkPackages: 1,
    } }),
    save,
  };
}

describe('执行并发设置', () => {
  test('默认额度必须是正安全整数', () => {
    for (const value of ['1', '3', '5', '9007199254740991']) expect(executionSettingsDraftValid(value)).toBe(true);
    for (const value of ['', '0', '-1', '1.5', '1e3', '9007199254740992']) expect(executionSettingsDraftValid(value)).toBe(false);
  });

  test('打开时展示默认值与当前批准额度，Enter 以 CAS 保存', async () => {
    const fake = createFakePorts();
    const writes: { expectedRevision: number; maxActiveWorkPackages: number }[] = [];
    const rendered = renderTui({
      ...fake.ports,
      executionSettings: settingsPort((input) => {
        writes.push(input);
        return Promise.resolve({ kind: 'saved', revision: 5, defaultMaxActiveWorkPackages: input.maxActiveWorkPackages });
      }),
    });
    try {
      await settle();
      await chooseCommand(rendered, 'execution-settings');
      expect(rendered.lastFrame()).toContain('执行并发设置');
      expect(rendered.lastFrame()).toContain('当前批准额度');
      // 草稿以已保存默认值 3 起始；清空后输入 5。
      rendered.stdin.write('\u007f');
      rendered.stdin.write('5');
      await settle();
      rendered.stdin.write('\r');
      await settle();
      expect(writes).toEqual([{ expectedRevision: 4, maxActiveWorkPackages: 5 }]);
      // 保存不等于生效：留在设置页并提示可显式进入完整审阅。
      expect(rendered.lastFrame()).toContain('已保存');
    } finally {
      rendered.unmount();
      fake.closeInputStore();
    }
  });

  test('保存后显式进入完整 Manifest 审阅，批准仍走既有流程', async () => {
    const fake = createFakePorts();
    const rendered = renderTui({
      ...fake.ports,
      executionSettings: settingsPort((input) =>
        Promise.resolve({ kind: 'saved', revision: 5, defaultMaxActiveWorkPackages: input.maxActiveWorkPackages }),
      ),
    });
    try {
      await settle();
      await chooseCommand(rendered, 'execution-settings');
      rendered.stdin.write('\r');
      await settle();
      rendered.stdin.write('r');
      await settle();
      expect(fake.calls.some((call) => call.name === 'authorization.review')).toBe(true);
      expect(rendered.lastFrame()).toContain('Execution Authorization Review');
    } finally {
      rendered.unmount();
      fake.closeInputStore();
    }
  });

  test('保存失败保留草稿并可重试', async () => {
    const fake = createFakePorts();
    const rendered = renderTui({
      ...fake.ports,
      executionSettings: settingsPort(() =>
        Promise.resolve({ kind: 'rejected', code: 'conflict', message: '项目配置已被其他编辑修改' }),
      ),
    });
    try {
      await settle();
      await chooseCommand(rendered, 'execution-settings');
      rendered.stdin.write('\r');
      await settle();
      expect(rendered.lastFrame()).toContain('conflict');
      expect(rendered.lastFrame()).toContain('默认并行额度');
    } finally {
      rendered.unmount();
      fake.closeInputStore();
    }
  });
});
