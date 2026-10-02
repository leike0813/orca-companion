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
const SHIFT_LEFT = '\u001b[1;2D';
const ARROW_DOWN = '\u001b[B';
const ARROW_UP = '\u001b[A';
const ENTER = '\r';
const OWN_QUESTION = { interactionId: 'i-own', ownerCoordinatorSessionId: 'session-b', subjectRef: { kind: 'ticket', id: 't-own' }, expectedRevision: 4, state: 'open' as const };

async function press(rendered: ReturnType<typeof renderTui>, keys: string): Promise<void> {
  rendered.stdin.write(keys);
  if (keys === '\u001b') await new Promise<void>((resolve) => setTimeout(resolve, 100));
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
  test('Ctrl+A 行首编辑；面板 Esc 恢复聊天光标，overlay 不穿透', async () => {
    const fake = createFakePorts({ snapshot: { interactions: [OWN_QUESTION] } });
    const rendered = renderTui(fake.ports);
    await waitFor(rendered, () => fake.calls.some((call) => call.name === 'transcript'));
    await press(rendered, '首尾');
    await press(rendered, '\u001b[D');
    await press(rendered, '中');
    await press(rendered, SHIFT_LEFT);
    await waitFor(rendered, (frame) => frame.includes('回答 interaction'));
    await press(rendered, '回答草稿');
    await press(rendered, '\u001b');
    await press(rendered, '后');
    expect(rendered.lastFrame()).toContain('首中后尾');
    await press(rendered, CTRL_P);
    await press(rendered, '\u0002');
    await press(rendered, '\u001b');
    await press(rendered, '\u0001');
    await press(rendered, '前');
    await press(rendered, ENTER);
    expect(fake.executeIntents).toMatchObject([{ kind: 'send-session-message', content: '前首中后尾' }]);
    rendered.unmount();
  });

  test('默认选项只选中，Enter 直接提交标签；自由回答的未知结果保留', async () => {
    const fake = createFakePorts({ snapshot: { interactions: [OWN_QUESTION] }, executeResult: { kind: 'unknown', code: 'transport', message: '等待核验' } });
    const ports = { ...fake.ports, questions: async (query: Parameters<NonNullable<typeof fake.ports.questions>>[0]) => {
      const result = await fake.ports.questions!(query);
      return result.kind === 'pending-interaction' && result.interaction ? { ...result, interaction: { ...result.interaction,
        question: { text: '下一步怎么做？', options: [{ label: '继续', description: '完成实现' }, { label: '稍后' }] } } } : result;
    } };
    const rendered = renderTui(ports);
    await waitFor(rendered, () => fake.calls.some((call) => call.name === 'transcript'));
    await press(rendered, SHIFT_LEFT);
    expect(await waitFor(rendered, (frame) => frame.includes('下一步怎么做'))).toContain('下一步怎么做');
    expect(fake.executeIntents).toHaveLength(0);
    await press(rendered, ARROW_DOWN);
    await press(rendered, ENTER);
    expect(fake.executeIntents).toMatchObject([{ kind: 'answer-pending-interaction', answer: '稍后' }]);
    expect(rendered.lastFrame()).toContain('回答 1/1');
    await press(rendered, '\t');
    expect(rendered.lastFrame()).toContain('稍后');
    rendered.unmount();
  });

  test('迟到受理不清空后来编辑的回答或离开面板', async () => {
    const fake = createFakePorts({ snapshot: { interactions: [OWN_QUESTION] } });
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof fake.ports.execute>>>();
    const rendered = renderTui({ ...fake.ports, execute: (intent) => { fake.executeIntents.push(intent); return pending.promise; } });
    await waitFor(rendered, () => fake.calls.some((call) => call.name === 'transcript'));
    await press(rendered, SHIFT_LEFT);
    await waitFor(rendered, (frame) => frame.includes('回答 interaction'));
    await press(rendered, '答案');
    await press(rendered, ENTER);
    await press(rendered, '后续编辑');
    pending.resolve({ kind: 'accepted', revision: 8, summary: '已受理' });
    await settle(6);
    expect(rendered.lastFrame()).toContain('答案后续编辑');
    expect(rendered.lastFrame()).toContain('回答 1/1');
    rendered.unmount();
  });

  test('大粘贴在光标折叠，viewer Esc 恢复位置，发送全文', async () => {
    const fake = createFakePorts({ snapshot: { interactions: [] } });
    const rendered = renderTui(fake.ports);
    await waitFor(rendered, () => fake.calls.some((call) => call.name === 'transcript'));
    await press(rendered, '首尾');
    await press(rendered, '\u001b[D');
    const payload = '中文'.repeat(501) + '\n\n';
    await press(rendered, '\u001b[200~' + payload + '\u001b[201~');
    expect(rendered.lastFrame()).toContain('粘贴 1');
    await press(rendered, CTRL_P);
    // Palette 的 /paste 与 slash 共用入口。
    for (let index = 0; index < 15; index++) await press(rendered, ARROW_DOWN);
    await press(rendered, ENTER);
    expect(rendered.lastFrame()).toContain('粘贴查看');
    await press(rendered, '\u001b');
    await press(rendered, '后');
    await press(rendered, ENTER);
    expect(fake.executeIntents, rendered.lastFrame()).toMatchObject([{ kind: 'send-session-message', content: '首' + payload + '后尾' }]);
    rendered.unmount();
  });

  test('受理后的下一题详情迟到时，不抢占新的聊天输入', async () => {
    const next = { ...OWN_QUESTION, interactionId: 'i-next', expectedRevision: 6 };
    const fake = createFakePorts({ snapshot: { interactions: [OWN_QUESTION, next] } });
    const delayed = Promise.withResolvers<Awaited<ReturnType<NonNullable<typeof fake.ports.questions>>>>();
    let awaitingNext = false;
    const rendered = renderTui({ ...fake.ports, questions: async (query) => {
      if (query.kind === 'pending-interaction' && query.interactionId === next.interactionId) {
        awaitingNext = true;
        return delayed.promise;
      }
      return fake.ports.questions!(query);
    } });
    await waitFor(rendered, () => fake.calls.some((call) => call.name === 'transcript'));
    await press(rendered, SHIFT_LEFT);
    await waitFor(rendered, (frame) => frame.includes('回答 interaction'));
    await press(rendered, '答案');
    await press(rendered, ENTER);
    await waitFor(rendered, () => awaitingNext);
    expect(awaitingNext).toBe(true);
    await press(rendered, '新的聊天');
    delayed.resolve(await fake.ports.questions!({ kind: 'pending-interaction', coordinatorSessionId: 'session-b', interactionId: next.interactionId }));
    await settle(6);
    expect(rendered.lastFrame()).toContain('composer · 普通消息');
    expect(rendered.lastFrame()).toContain('新的聊天');
    expect(rendered.lastFrame()).not.toContain('回答 2/2');
    rendered.unmount();
  });
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

  test('同一批按键里的连续方向键各移动一格（选择光标读同步事实源）', async () => {
    const fake = createFakePorts();
    const rendered = renderTui(fake.ports);
    await waitFor(rendered, (frame) => frame.includes('composer · 普通消息'));

    await press(rendered, CTRL_P);
    await waitFor(rendered, (frame) => frame.includes('Command Palette'));

    // 两次 Down 之间不等待重渲染：按键处理必须读同步的选择索引，否则第二次 Down 会与第一次一样
    // 基于同一个旧索引计算，两次只前进一格（落到 Model Picker）。
    rendered.stdin.write(ARROW_DOWN);
    rendered.stdin.write(ARROW_DOWN);
    const moved = await waitFor(
      rendered,
      (frame) => frame.includes('> Route Planning Handoff') || frame.includes('> Model Picker'),
    );
    expect(moved).toContain('> Route Planning Handoff');

    // 等这一帧的重渲染落地后再提交：`Command Palette` 里也有 "Model Picker" 字面量，因此
    // 断言用覆盖层自身的页脚判断它是否还开着。
    await press(rendered, ENTER);
    const frame = await waitFor(rendered, (text) => text.includes('Handoff Review') || text.includes('Model Picker'));

    expect(frame).toContain('Handoff Review');
    // 覆盖层已经换掉：Command Palette 的页脚不再出现。
    expect(frame).not.toContain('Enter 执行 · Esc 关闭');
    rendered.unmount();
  });

  test('Shift+Left 在有待答交互时进入绑定 revision 的回答模式', async () => {
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
    await press(rendered, SHIFT_LEFT);
    const frame = await waitFor(rendered, (text) => text.includes('回答 interaction i-1'));
    expect(frame).toContain('回答 interaction i-1');
    expect(frame).toContain('revision 4');
    rendered.unmount();
  });
});

/**
 * 严格 slash 表：只要以 `/` 开头就不再是消息。无法作为单个完整命令执行的内容一律提示并保留输入，
 * 绝不回退为普通消息或回答。
 */
const SLASH_REJECTIONS = [
  { label: '未知命令', keys: '/nope', notice: 'unknown_command', preserved: '/nope' },
  { label: '内联参数', keys: '/compact 现在', notice: 'invalid_format', preserved: '/compact 现在' },
  { label: '空白参数', keys: '/help\tx', notice: 'invalid_format', preserved: '/help' },
  { label: '空命令', keys: '/', notice: 'invalid_format', preserved: '/' },
] as const;

describe('严格 slash 分类：错误输入保留且不发送', () => {
  for (const entry of SLASH_REJECTIONS) {
    test(entry.label, async () => {
      const fake = createFakePorts();
      const rendered = renderTui(fake.ports);
      // 等到 Session 选中后再输入：composer 标题会先于 sessions-loaded 出现。
      await waitFor(rendered, () => fake.calls.some((call) => call.name === 'transcript'));
      await waitFor(rendered, (frame) => frame.includes('composer · 普通消息'));

      await press(rendered, entry.label === '空白参数' ? '\u001b[200~' + entry.keys + '\u001b[201~' : entry.keys);
      await press(rendered, ENTER);

      // 既不发送普通消息，也不回答。
      expect(fake.executeIntents).toEqual([]);
      expect(rendered.lastFrame() ?? '').toContain(entry.notice);
      expect(rendered.lastFrame() ?? '').toContain(entry.preserved);
      rendered.unmount();
    });
  }

  test('多行命令：不发送且保留输入', async () => {
    const fake = createFakePorts();
    const rendered = renderTui(fake.ports);
    await waitFor(rendered, () => fake.calls.some((call) => call.name === 'transcript'));
    await waitFor(rendered, (frame) => frame.includes('composer · 普通消息'));

    // 粘贴多行，保证正文里真的有换行而不是被当成两次输入。
    rendered.stdin.write('\u001b[200~/help\n正文\u001b[201~');
    await waitFor(rendered, (frame) => frame.includes('/help'));
    await press(rendered, ENTER);

    expect(fake.executeIntents).toEqual([]);
    const frame = rendered.lastFrame() ?? '';
    expect(frame).toContain('invalid_format');
    expect(frame).toContain('/help');
    rendered.unmount();
  });

  test('回答模式同样严格：错误命令不提交答案、保留待答与草稿', async () => {
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
    await waitFor(
      rendered,
      () => fake.calls.some((call) => call.name === 'transcript' && call.detail === 'session-b'),
    );
    await waitFor(rendered, (frame) => frame.includes('待答'));

    await press(rendered, SHIFT_LEFT);
    await waitFor(rendered, (frame) => frame.includes('回答 interaction i-1'));

    await press(rendered, '/nope');
    await press(rendered, ENTER);

    // 命令不会满足待答问题：没有回答 intent，问题仍待答，命令输入保留。
    expect(fake.executeIntents).toEqual([]);
    const frame = rendered.lastFrame() ?? '';
    expect(frame).toContain('/nope');
    expect(frame).toContain('回答 interaction i-1');
    expect(frame).toContain('ticket:t-1');
    rendered.unmount();
  });
});
