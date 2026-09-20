import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { expect, test } from 'vitest';

import {
  buildBoundedModelInput,
  capsuleTextOf,
  carryOpaqueNativeWindow,
  ContextMaintenanceError,
  deriveContextCapsule,
  reinjectAuthoritativeFacts,
  reinjectInstructions,
  reinjectToolSchema,
  fromDurableMessage,
  toDurableMessage,
} from '../../src/workflow/coordinator/context.js';
import type { HistorySegment } from '../../src/workflow/coordinator/state.js';

const STEPS = [
  { stepId: 'step-1', messages: [{ role: 'user', content: '开始规划' }] },
  { stepId: 'step-2', messages: [{ role: 'assistant', content: '先读地图' }] },
  { stepId: 'step-3', messages: [{ role: 'assistant', content: '登记一条 Decision Ticket' }] },
];

function estimate(segments: readonly HistorySegment[]): number {
  return segments.reduce((total, segment) => {
    if (segment.kind === 'capsule') {
      return total + segment.text.length;
    }
    if (segment.kind === 'native-window') {
      return total + segment.items.length * 10;
    }
    return (
      total +
      segment.messages.reduce<number>((sum, message) => {
        if (typeof message === 'string') {
          return sum + message.length;
        }
        const content = (message as { readonly content?: unknown }).content;
        return sum + (typeof content === 'string' ? content.length : 0);
      }, 0)
    );
  }, 0);
}

test('Capsule 从已提交历史派生，是带判别标记的可移植派生视图', () => {
  const capsule = deriveContextCapsule({ fromStepId: 'step-1', toStepId: 'step-2', steps: STEPS });

  expect(capsule.kind).toBe('derived_context_capsule');
  expect(capsule.capsuleId).toBe('capsule:step-1..step-2');
  expect(capsule.replacedFromStepId).toBe('step-1');
  expect(capsule.replacedToStepId).toBe('step-2');
  expect(capsule.text).toContain('derived context capsule');
  expect(capsule.text).toContain('- user: 开始规划');
  expect(capsule.text).toContain('- assistant: 先读地图');
  // 同样的输入派生同样的 Capsule：派生是确定性的。
  expect(deriveContextCapsule({ fromStepId: 'step-1', toStepId: 'step-2', steps: STEPS })).toEqual(capsule);
});

test('Capsule 派生失败时阻塞，而不是猜测裁剪边界', () => {
  expect(() => deriveContextCapsule({ fromStepId: 'step-9', toStepId: 'step-9', steps: STEPS })).toThrow(
    ContextMaintenanceError,
  );
});

test('出现无法安全归类的历史项时阻塞并保持原状', () => {
  const withUnknown = [
    ...STEPS,
    { stepId: 'step-4', messages: [{ role: 'moderator', content: '未知角色' }] as readonly unknown[] },
  ];

  expect(() => deriveContextCapsule({ fromStepId: 'step-1', toStepId: 'step-4', steps: withUnknown })).toThrow(
    /无法安全归类的角色/,
  );

  const withFunction = [
    { stepId: 'step-1', messages: [() => undefined] as readonly unknown[] },
  ];
  expect(() => deriveContextCapsule({ fromStepId: 'step-1', toStepId: 'step-1', steps: withFunction })).toThrow(
    ContextMaintenanceError,
  );
});

test('原生压缩项逐字携带，Companion 不解析也不改写', () => {
  const items = [
    { itemId: 'enc-1', position: 0, mediaType: 'application/octet-stream', opaque: { blob: 'AAAA' } },
    { itemId: 'enc-2', position: 1, mediaType: 'application/octet-stream', opaque: { blob: 'BBBB' } },
  ];

  const carried = carryOpaqueNativeWindow({ ownerRef: 'provider:generation-2', items }, { required: true });

  expect(carried).toEqual(items);
  expect(carried[0]?.opaque).toEqual({ blob: 'AAAA' });
});

test('Committed Model Step 持久化并还原完整 tool calls', () => {
  const response = new AIMessage({
    content: '读取文件',
    tool_calls: [{ id: 'call-1', name: 'read', args: { path: 'CONTEXT.md' }, type: 'tool_call' }],
  });

  const durable = toDurableMessage(response);
  expect(durable.toolCalls).toEqual(response.tool_calls);
  const restored = fromDurableMessage(durable);
  expect(restored).toBeInstanceOf(AIMessage);
  expect((restored as AIMessage).tool_calls).toEqual(response.tool_calls);
});

test('原生项不可用且没有迁移路径时阻塞，不用自行构造的内容替代', () => {
  expect(() => carryOpaqueNativeWindow(null, { required: true })).toThrow(ContextMaintenanceError);
  expect(carryOpaqueNativeWindow(null, { required: false })).toEqual([]);
});

test('原生压缩项在实际模型输入中逐字往返，不改写为 Companion 消息', () => {
  const opaque = { type: 'provider_compaction', encrypted: 'AAAA' };
  const input = buildBoundedModelInput({
    segments: [{
      kind: 'native-window',
      ownerRef: 'provider:generation-2',
      items: [{ itemId: 'enc-1', position: 0, mediaType: 'application/octet-stream', opaque }],
    }],
    estimate,
    fixedOverhead: 0,
    budgetTokens: 10_000,
    native: { kind: 'unavailable', reason: '已存在原生窗口' },
    shaken: false,
    instructions: ['你是 Coordinator'],
    toolSchema: [],
    authoritativeFacts: [],
  });

  expect(input.messages.at(-1)).toBe(opaque);
});

test('instructions、tool schema 与最新事实按当前配置重新注入', () => {
  expect(reinjectInstructions(['你是 Coordinator'])).toEqual(['你是 Coordinator']);
  expect(reinjectToolSchema([{ name: 'read', description: '有界读取', schema: { type: 'object' } }])).toEqual([
    { name: 'read', description: '有界读取', schema: { type: 'object' } },
  ]);
  expect(reinjectAuthoritativeFacts(['HEAD=abc123'])).toEqual(['HEAD=abc123']);

  // 当前值不可用时阻塞：用被压缩区间里的旧副本会让事实滞后。
  expect(() => reinjectInstructions(null)).toThrow(ContextMaintenanceError);
  expect(() => reinjectToolSchema(null)).toThrow(ContextMaintenanceError);
  expect(() => reinjectAuthoritativeFacts(null)).toThrow(ContextMaintenanceError);
});

const SEGMENTS: readonly HistorySegment[] = [
  { kind: 'messages', stepId: 'step-1', messages: [{ role: 'assistant', content: 'a'.repeat(600) }] },
  { kind: 'messages', stepId: 'step-2', messages: [{ role: 'assistant', content: 'b'.repeat(600) }] },
  { kind: 'messages', stepId: 'step-3', messages: [new AIMessage('刚刚提交的响应')] },
];

function buildInput(budgetTokens: number) {
  return buildBoundedModelInput({
    segments: SEGMENTS,
    estimate,
    fixedOverhead: 0,
    budgetTokens,
    native: { kind: 'unavailable', reason: 'provider 不支持' },
    shaken: false,
    instructions: ['你是 Coordinator，只做协调'],
    toolSchema: [],
    authoritativeFacts: ['HEAD=abc123'],
  });
}

test('模型输入只含 Capsule 与保留区间，被取代区间的原始消息不在其中', () => {
  const input = buildInput(700);

  expect(input.compaction.kind).toBe('compacted');
  if (input.compaction.kind === 'compacted') {
    expect(input.compaction.path).toBe('context_capsule');
  }
  const rendered = input.messages
    .map((message) =>
      typeof message === 'object' && message !== null && 'text' in message && typeof message.text === 'string'
        ? message.text
        : '',
    )
    .join('\n');
  expect(rendered).toContain('derived context capsule');
  expect(rendered).not.toContain('a'.repeat(600));
  // 保留区间仍然逐条出现。
  expect(rendered).toContain('刚刚提交的响应');
});

test('压缩之后仍按当前配置重新注入 instructions 与最新权威事实', () => {
  const input = buildInput(700);

  // 系统内容是唯一一条前导消息，所以按整块断言包含关系而不是逐条相等。
  const systemTexts = input.messages
    .filter((message) => message instanceof SystemMessage)
    .map((message) => message.text)
    .join('\n\n');
  expect(systemTexts).toContain('你是 Coordinator，只做协调');
  expect(systemTexts).toContain('[authoritative fact] HEAD=abc123');
});

test('已提交的真实消息对象按原样进入输入，角色形状不被改写', () => {
  const input = buildBoundedModelInput({
    segments: [{ kind: 'messages', stepId: 'step-1', messages: [new HumanMessage('用户问题')] }],
    estimate,
    fixedOverhead: 0,
    budgetTokens: 10_000,
    native: { kind: 'unavailable', reason: 'provider 不支持' },
    shaken: false,
    instructions: ['你是 Coordinator'],
    toolSchema: [],
    authoritativeFacts: [],
  });

  const human = input.messages.find((message) => message instanceof HumanMessage);
  expect(human?.content).toBe('用户问题');
});

test('超过有界范围且已用过一次 Shake 时以显式状态结束，不静默截断', () => {
  const input = buildBoundedModelInput({
    segments: SEGMENTS,
    estimate,
    fixedOverhead: 0,
    budgetTokens: 10,
    native: { kind: 'unavailable', reason: 'provider 不支持' },
    shaken: true,
    instructions: ['你是 Coordinator'],
    toolSchema: [],
    authoritativeFacts: [],
  });

  expect(input.compaction.kind).toBe('context_exhausted');
});

test('无法安全归类时上下文维护抛出阻塞错误，由节点转成 blocked 而不是截断', () => {
  expect(() =>
    buildBoundedModelInput({
      segments: [{ kind: 'messages', stepId: 'step-1', messages: [{ role: 'moderator', content: 'x' }] }],
      estimate,
      fixedOverhead: 0,
      budgetTokens: 1,
      native: { kind: 'unavailable', reason: 'provider 不支持' },
      shaken: false,
      instructions: ['你是 Coordinator'],
      toolSchema: [],
      authoritativeFacts: [],
    }),
  ).toThrow(ContextMaintenanceError);
});

test('Capsule 文本是结构化可移植文本，不依赖 provider 对象', () => {
  expect(
    capsuleTextOf('capsule:x', [
      { stepId: 'step-1', role: 'user', content: '问题' },
      { stepId: 'step-2', role: 'assistant', content: '答复' },
    ]),
  ).toBe('[derived context capsule capsule:x]\n- user: 问题\n- assistant: 答复');
});

test('Capsule 确有压缩：超长内容被显式截断并标注原文所在 step', () => {
  const capsule = deriveContextCapsule({ fromStepId: 'step-1', toStepId: 'step-2', steps: STEPS });
  const long = deriveContextCapsule({
    fromStepId: 'step-1',
    toStepId: 'step-1',
    steps: [{ stepId: 'step-1', messages: [{ role: 'assistant', content: 'z'.repeat(2_000) }] }],
  });

  expect(capsule.text).not.toContain('truncated');
  expect(long.text).toContain('truncated');
  expect(long.text).toContain('原文见 step-1');
  expect(long.text.length).toBeLessThan(2_000);
});

test('系统内容合并成唯一的前导 system 消息，Capsule 不得插进对话', () => {
  const input = buildInput(700);

  // Anthropic 只接受第一条为 system（第二条即报错 "System messages are only permitted as the
  // first passed message"），所以所有系统内容必须汇总成一条。
  const systemIndexes = input.messages
    .map((message, index) => (message instanceof SystemMessage ? index : -1))
    .filter((index) => index >= 0);
  expect(systemIndexes).toEqual([0]);

  const first = input.messages[0];
  expect(first).toBeInstanceOf(SystemMessage);
  const preamble = first instanceof SystemMessage ? first.text : '';
  expect(preamble).toContain('你是 Coordinator');
  expect(preamble).toContain('[authoritative fact] HEAD=abc123');
  expect(preamble).toContain('derived context capsule');
});

test('历史里出现的 system 消息被上提到前导块，不打乱对话顺序', () => {
  const input = buildBoundedModelInput({
    segments: [
      { kind: 'messages', stepId: 'step-1', messages: [{ role: 'user', content: '第一个问题' }] },
      { kind: 'messages', stepId: 'step-2', messages: [{ role: 'system', content: '中途注入的约束' }] },
      { kind: 'messages', stepId: 'step-3', messages: [{ role: 'assistant', content: '第一个答复' }] },
    ],
    estimate,
    fixedOverhead: 0,
    budgetTokens: 10_000,
    native: { kind: 'unavailable', reason: 'provider 不支持' },
    shaken: false,
    instructions: ['你是 Coordinator'],
    toolSchema: [],
    authoritativeFacts: [],
  });

  const roles = input.messages.map((message) =>
    message instanceof SystemMessage ? 'system' : message instanceof AIMessage ? 'assistant' : 'user',
  );
  // 中途注入的 system 约束被上提进唯一的前导块，对话顺序保持不变。
  expect(roles).toEqual(['system', 'user', 'assistant']);
  const first = input.messages[0];
  expect(first instanceof SystemMessage ? first.text : '').toContain('中途注入的约束');
});
