/**
 * 会话维护、模型配置与 Route Planning Handoff（IP-11，`tui/session-interactions`）。
 *
 * 断言的是可观察事实：Command Palette 触发的 intent 种类与次数、压缩 blocker 是否可见、
 * `context_exhausted` 是否阻止新调用、模型切换准入判决、以及 Handoff Review 的展示行与 cutover。
 */

import { describe, expect, test, vi } from 'vitest';
import { createElement } from 'react';

import {
  ModelPicker,
  modelSwitchAdmission,
} from '../../src/interfaces/tui/components/model-picker.js';
import {
  HandoffReview,
  handoffReviewRows,
} from '../../src/interfaces/tui/components/handoff-review.js';
import { compactionLabel } from '../../src/interfaces/tui/components/status-line.js';
import type { ControllerPlanningHandoffView } from '../../src/application/controller-service.js';
import type { ModelCatalog } from '../../src/interfaces/tui/ports.js';
import {
  createFakePorts,
  frameText,
  renderComponent,
  renderTui,
  settle,
  type RenderedTui,
} from './harness.js';

async function pressKey(rendered: RenderedTui, input: string): Promise<void> {
  rendered.stdin.write(input);
  await settle(2);
}

/** 打开 Command Palette 并选中第 `index` 个命令后执行。 */
async function runPaletteCommand(rendered: RenderedTui, index: number): Promise<void> {
  await pressKey(rendered, '\u0010');
  for (let step = 0; step < index; step += 1) {
    await pressKey(rendered, '\u001b[B');
  }
  await pressKey(rendered, '\r');
}

describe('/compact', () => {
  test('从 Command Palette 触发时提交一次 compact-session', async () => {
    const fake = createFakePorts();
    const rendered = renderTui(fake.ports);
    await settle();

    await pressKey(rendered, '\u0010');
    expect(frameText(rendered)).toContain('/compact');

    // paletteSelection 0 = compact
    await pressKey(rendered, '\r');

    expect(fake.executeIntents).toHaveLength(1);
    const intent = fake.executeIntents[0];
    expect(intent?.kind).toBe('compact-session');
    if (intent?.kind === 'compact-session') {
      expect(intent.coordinatorSessionId).toBe('session-b');
      expect(intent.reason).toBe('user-requested');
    }

    rendered.unmount();
  });

  test('宿主不支持压缩时显示结构化 blocker，不显示成功', async () => {
    const fake = createFakePorts({
      executeResult: {
        kind: 'rejected',
        code: 'compaction_unavailable',
        message: '宿主未提供面向 Session 的压缩请求能力',
      },
    });
    const rendered = renderTui(fake.ports);
    await settle();

    await runPaletteCommand(rendered, 0);

    const frame = frameText(rendered);
    // 结构化 blocker 可见（状态行按可用宽度裁切，因此只断言错误码这一稳定片段）。
    expect(frame).toContain('compaction_unavailable');
    // fail closed：没有伪造的压缩成功结果。
    expect(frame).not.toContain('compacted(');

    rendered.unmount();
  });

  test('compaction_degraded 作为非阻塞告警持续可见', async () => {
    const fake = createFakePorts({
      snapshot: {
        compaction: {
          status: 'compaction_degraded',
          path: null,
          reason: '预算仍然超限',
          stillOverBudget: 2,
        },
      },
    });
    const rendered = renderTui(fake.ports);
    await settle();

    // 告警文案是 Controller 投影的直接映射（不经过终端裁切）。
    expect(
      compactionLabel({
        status: 'compaction_degraded',
        path: null,
        reason: '预算仍然超限',
        stillOverBudget: 2,
      }),
    ).toBe('compaction_degraded: 预算仍然超限');

    const frame = frameText(rendered);
    expect(frame).toContain('compaction_degraded');
    // 降级是告警，不是耗尽：composer 不被禁用。
    expect(frame).not.toContain('已停止发起新的模型调用');

    rendered.unmount();
  });
});

/**
 * `context_exhausted` 必须禁用该 Session 的 composer 提交：界面不得再发起新的模型调用。
 * 提示部分当前可见；「提交不产生 intent」是 spec 要求但实现未满足，见最终报告。
 */
describe('context_exhausted 停止新调用', () => {
  test('显示耗尽原因，且提交不产生任何 intent', async () => {
    const fake = createFakePorts({
      snapshot: {
        compaction: {
          status: 'context_exhausted',
          path: null,
          reason: '超预算',
          stillOverBudget: 1,
        },
      },
    });
    const rendered = renderTui(fake.ports);
    await settle();

    const frame = frameText(rendered);
    expect(frame).toContain('context_exhausted');
    expect(frame).toContain('已停止发起新的模型调用');
    expect(
      compactionLabel({
        status: 'context_exhausted',
        path: null,
        reason: '超预算',
        stillOverBudget: 1,
      }),
    ).toBe('context_exhausted: 超预算');

    rendered.stdin.write('continue');
    await settle(2);
    // 先确认草稿确实进入 composer，避免「提交了空草稿」造成的假绿。
    expect(frameText(rendered)).toContain('continue');
    rendered.stdin.write('\r');
    await settle();

    expect(fake.executeIntents.map((intent) => intent.kind)).toEqual([]);

    rendered.unmount();
  });
});

describe('Model Picker 准入', () => {
  test('switchable:false 时准入拒绝，并在界面显示原因', () => {
    const catalog: ModelCatalog = {
      options: [{ configurationRef: 'config-b', model: 'model-b' }],
      currentConfigurationRef: 'config-a',
      switchable: false,
      switchBlockReason: 'Coordinator Session 正在运行模型',
    };
    const admission = modelSwitchAdmission(catalog);
    expect(admission.allowed).toBe(false);
    expect(admission.reason).toBe('Coordinator Session 正在运行模型');

    // 没有候选配置同样不可提交。
    expect(modelSwitchAdmission({ ...catalog, options: [] }).allowed).toBe(false);

    const rendered = renderComponent(
      createElement(ModelPicker, {
        catalog,
        rejection: null,
        selectedIndex: 0,
        onSelect: vi.fn(),
        availableWidth: 100,
      }),
    );
    const frame = frameText(rendered);
    expect(frame).toContain('Model Picker');
    expect(frame).toContain('config-b');
    expect(frame).toContain('正在运行模型');
  });

  test('switchable:true 时提交一次 switch-model-configuration', async () => {
    const fake = createFakePorts({
      models: [
        { configurationRef: 'config-a', model: 'model-a' },
        { configurationRef: 'config-b', model: 'model-b' },
      ],
    });
    const rendered = renderTui(fake.ports);
    await settle();

    // paletteSelection 1 = model-picker
    await runPaletteCommand(rendered, 1);
    expect(frameText(rendered)).toContain('Model Picker');
    expect(frameText(rendered)).toContain('config-b');
    expect(fake.calls.filter((call) => call.name === 'modelCatalog')).toHaveLength(1);

    // 下移到 config-b 后提交。
    await pressKey(rendered, '\u001b[B');
    await pressKey(rendered, '\r');

    expect(fake.executeIntents).toHaveLength(1);
    const intent = fake.executeIntents[0];
    expect(intent?.kind).toBe('switch-model-configuration');
    if (intent?.kind === 'switch-model-configuration') {
      expect(intent.coordinatorSessionId).toBe('session-b');
      expect(intent.nextConfigurationRef).toBe('config-b');
    }

    rendered.unmount();
  });

  /**
   * IP-11 要求「准入不满足时禁用提交」。当前 `app.tsx` 的 `handleModelKey`/`selectModel`
   * 只读取 `catalog.options`，不读取 `modelSwitchAdmission`，因此仍会发出意图——预期失败。
   */
  test('switchable:false 时 Model Picker 不提交切换（IP-11 要求）', async () => {
    const catalog: ModelCatalog = {
      options: [{ configurationRef: 'config-b', model: 'model-b' }],
      currentConfigurationRef: 'config-a',
      switchable: false,
      switchBlockReason: 'Coordinator Session 正在运行模型',
    };
    const fake = createFakePorts();
    const ports = { ...fake.ports, modelCatalog: { load: () => Promise.resolve(catalog) } };
    const rendered = renderTui(ports);
    await settle();

    await runPaletteCommand(rendered, 1);
    expect(frameText(rendered)).toContain('正在运行模型');

    await pressKey(rendered, '\u001b[B');
    await pressKey(rendered, '\r');

    expect(fake.executeIntents.map((entry) => entry.kind)).toEqual([]);

    rendered.unmount();
  });
});

describe('Handoff Review', () => {
  const proposal: ControllerPlanningHandoffView = {
    proposalId: 'h-1',
    sourceSessionId: 'session-b',
    targetSessionId: 'session-c',
    phase: 'prepared',
    mapRevision: 3,
    planRevision: 2,
    capsuleRef: 'capsule-1',
    proposalRevision: 1,
  };

  test('展示 Capsule 摘要、Target 与待转移责任', () => {
    const rows = handoffReviewRows(proposal, 'session-b').join('\n');
    expect(rows).toContain('capsule-1');
    expect(rows).toContain('target session-c');
    expect(rows).toContain('source session-b');
    expect(rows).toContain('待转移规划责任: session-b');

    const rendered = renderComponent(
      createElement(HandoffReview, {
        proposal,
        responsibleSessionId: 'session-b',
        onConfirm: vi.fn(),
        onCancel: vi.fn(),
        availableWidth: 120,
      }),
    );
    const frame = frameText(rendered);
    expect(frame).toContain('Handoff Review');
    expect(frame).toContain('capsule-1');
    expect(frame).toContain('session-c');
  });

  test('capsuleRef:null 时显示 fail-closed 提示', () => {
    const noCapsule: ControllerPlanningHandoffView = { ...proposal, capsuleRef: null };
    const rows = handoffReviewRows(noCapsule, 'session-b').join('\n');
    expect(rows).toContain('fail closed');

    const rendered = renderComponent(
      createElement(HandoffReview, {
        proposal: noCapsule,
        responsibleSessionId: 'session-b',
        onConfirm: vi.fn(),
        onCancel: vi.fn(),
        availableWidth: 120,
      }),
    );
    const frame = frameText(rendered);
    expect(frame).toContain('Capsule 不可用');
    expect(frame).toContain('fail closed');
  });

  test('prepare → Review → cutover 后自动选中 Target', async () => {
    const fake = createFakePorts({ snapshot: { planningHandoffs: [proposal] } });
    const rendered = renderTui(fake.ports);
    await settle();

    // paletteSelection 2 = handoff
    await runPaletteCommand(rendered, 2);

    expect(fake.calls.some((call) => call.name === 'handoff.prepare')).toBe(true);
    const review = frameText(rendered);
    expect(review).toContain('Handoff Review');
    expect(review).toContain('h-1');
    expect(review).toContain('capsule-1');
    // Review 期间不产生任何其他写。
    expect(fake.calls.some((call) => call.name === 'handoff.cutover')).toBe(false);

    await pressKey(rendered, '\r');

    expect(fake.calls.filter((call) => call.name === 'handoff.cutover').map((call) => call.detail)).toEqual([
      'h-1',
    ]);
    const after = frameText(rendered);
    // cutover 后进入 Target 的等待下一条 Prompt 状态。
    expect(after).toContain('cutover');
    expect(after).toContain('Target');
    expect(after).not.toContain('Handoff Review');

    rendered.unmount();
  });
});
