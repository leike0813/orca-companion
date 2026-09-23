/**
 * 容器输入路径回归测试（IP-05/IP-07/IP-08）。
 *
 * 这些用例针对一类具体缺陷：组件声明了回调、容器也传了回调，但没有可达的输入路径。因此断言的是
 * 「按键之后可观察到的行为」——工具详情出现、transcript 换到另一个 Session——而不是回调是否存在。
 */

import { describe, expect, test } from 'vitest';

import { createFakePorts, makeTranscript, renderTui, settle } from './harness.js';

const CTRL_P = '\u0010';
const CTRL_T = '\u0014';
const CTRL_A = '\u0001';
const ARROW_DOWN = '\u001b[B';
const ARROW_UP = '\u001b[A';
const ENTER = '\r';

async function press(rendered: ReturnType<typeof renderTui>, keys: string): Promise<void> {
  rendered.stdin.write(keys);
  await settle(4);
}

/** 轮询等待帧满足条件；并行跑整个套件时固定次数的 settle 不足以稳定同步异步加载。 */
async function waitFor(
  rendered: ReturnType<typeof renderTui>,
  predicate: (frame: string) => boolean,
  timeoutMs = 3000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let frame = rendered.lastFrame() ?? '';
  while (!predicate(frame) && Date.now() < deadline) {
    await settle(2);
    frame = rendered.lastFrame() ?? '';
  }
  return frame;
}

describe('容器输入路径', () => {
  test('Ctrl+T 展开最近一条工具记录，再次按下折叠', async () => {
    const fake = createFakePorts();
    const rendered = renderTui(fake.ports);
    await waitFor(rendered, (frame) => frame.includes('先看看地图'));
    expect(rendered.lastFrame()).not.toContain('命中 3 个文件');

    await press(rendered, CTRL_T);
    expect(await waitFor(rendered, (frame) => frame.includes('命中 3 个文件'))).toContain('命中 3 个文件');

    await press(rendered, CTRL_T);
    expect(await waitFor(rendered, (frame) => !frame.includes('命中 3 个文件'))).not.toContain('命中 3 个文件');
    rendered.unmount();
  });

  test('Session Picker 可以用方向键切换并提交选择', async () => {
    const fake = createFakePorts();
    const rendered = renderTui(fake.ports);
    // 默认选中带 Pending Interaction 的 session-b。
    await waitFor(
      rendered,
      () => fake.calls.some((call) => call.name === 'transcript' && call.detail === 'session-b'),
    );

    // Ctrl+P → 下移 3 次到 Session Picker → Enter 打开。
    await press(rendered, CTRL_P);
    for (let index = 0; index < 3; index += 1) {
      await press(rendered, ARROW_DOWN);
    }
    await press(rendered, ENTER);
    expect(rendered.lastFrame()).toContain('Session Picker');

    // 上移到 session-a 并提交。
    await press(rendered, ARROW_UP);
    await press(rendered, ENTER);

    const transcripts = fake.calls.filter((call) => call.name === 'transcript').map((call) => call.detail);
    expect(transcripts).toContain('session-a');
    expect(fake.executeCount()).toBe(0);
    rendered.unmount();
  });

  test('Ctrl+A 在有待答交互时进入绑定 revision 的回答模式', async () => {
    const fake = createFakePorts({
      snapshot: {
        interactions: [
          {
            interactionId: 'i-1',
            ownerCoordinatorSessionId: 'session-b',
            subjectRef: { kind: 'ticket', id: 't-1' },
            expectedRevision: 4,
            state: 'open',
          },
        ],
      },
      transcript: makeTranscript('session-b', [{ role: 'user', content: '请回答', stepId: null }]),
    });
    const rendered = renderTui(fake.ports);
    // 等到 Session 选择落地（InteractionCard 出现不等于选中已应用）。
    await waitFor(
      rendered,
      () => fake.calls.some((call) => call.name === 'transcript' && call.detail === 'session-b'),
    );
    await waitFor(rendered, (frame) => frame.includes('待答'));
    await press(rendered, CTRL_A);
    const frame = await waitFor(rendered, (text) => text.includes('回答 interaction i-1'));
    expect(frame).toContain('回答 interaction i-1');
    expect(frame).toContain('revision 4');
    rendered.unmount();
  });
});
