import { expect, test } from 'vitest';

import {
  compactWithNativeFirst,
  mechanicalShake,
  SHAKE_HEAVY_CONTENT_CHARS,
  type CompactionRequest,
} from '../../src/workflow/coordinator/compaction.js';
import type { HistorySegment, NativeCompactionAvailability } from '../../src/workflow/coordinator/state.js';

/** 确定性规模估算：按消息内容的字符数计，胶囊按文本长度计。 */
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
        const content = (message as { readonly content?: unknown }).content;
        return sum + (typeof content === 'string' ? content.length : 0);
      }, 0)
    );
  }, 0);
}

function messages(stepId: string, content: string): HistorySegment {
  return { kind: 'messages', stepId, messages: [{ role: 'assistant', content }] };
}

function capsuleSegment(from: string, to: string, text = '[derived capsule]'): Extract<HistorySegment, { kind: 'capsule' }> {
  return {
    kind: 'capsule',
    capsuleId: `capsule:${from}..${to}`,
    text,
    replacedFromStepId: from,
    replacedToStepId: to,
  };
}

function request(overrides: Partial<CompactionRequest> = {}): CompactionRequest {
  return {
    segments: [messages('step-1', 'a'.repeat(400)), messages('step-2', 'b'.repeat(400))],
    estimate,
    fixedOverhead: 0,
    budgetTokens: 1_000,
    native: { kind: 'unavailable', reason: 'provider 不支持原生压缩' },
    shaken: false,
    deriveCapsule: (segments) => {
      const run = segments.filter((segment) => segment.kind === 'messages');
      const first = run[0];
      const last = run[run.length - 1];
      if (first === undefined || last === undefined || first === last) {
        return null;
      }
      if (first.kind !== 'messages' || last.kind !== 'messages') {
        return null;
      }
      return {
        replacedCount: run.length,
        segment: capsuleSegment(first.stepId, last.stepId),
      };
    },
    ...overrides,
  };
}

const NATIVE_AVAILABLE = (compactedTokens: number): NativeCompactionAvailability => ({
  kind: 'available',
  compact: () => ({
    ownerRef: 'provider:minimax-m3:generation-1',
    items: [{ itemId: 'enc-1', position: 0, mediaType: 'application/octet-stream', opaque: { blob: 'AAAA' } }],
    compactedTokens,
  }),
});

test('输入已在预算内时不压缩', () => {
  const result = compactWithNativeFirst(request({ budgetTokens: 10_000 }));

  expect(result.outcome.kind).toBe('not_needed');
  expect(result.segments).toHaveLength(2);
});

test('原生压缩可用时优先使用，不先派生 Capsule 或 Shake', () => {
  let capsuleCalls = 0;
  const result = compactWithNativeFirst(
    request({
      budgetTokens: 200,
      native: NATIVE_AVAILABLE(20),
      deriveCapsule: (segments) => {
        capsuleCalls += 1;
        void segments;
        return {
          replacedCount: 2,
          segment: capsuleSegment('step-1', 'step-2'),
        };
      },
    }),
  );

  expect(result.outcome.kind).toBe('compacted');
  if (result.outcome.kind === 'compacted') {
    expect(result.outcome.path).toBe('provider_native');
  }
  expect(capsuleCalls).toBe(0);
  expect(result.segments[0]?.kind).toBe('native-window');
});

test('原生不可用时回退 Capsule，不以超窗历史继续请求', () => {
  const result = compactWithNativeFirst(request({ budgetTokens: 200 }));

  expect(result.outcome.kind).toBe('compacted');
  if (result.outcome.kind === 'compacted') {
    expect(result.outcome.path).toBe('context_capsule');
    expect(result.outcome.compactedTokens).toBeLessThanOrEqual(200);
  }
  expect(result.segments.some((segment) => segment.kind === 'capsule')).toBe(true);
});

test('原生压缩不足以恢复有界输入时继续走 Capsule', () => {
  const result = compactWithNativeFirst(
    request({ budgetTokens: 40, native: NATIVE_AVAILABLE(900) }),
  );

  expect(result.outcome.kind).toBe('compacted');
  if (result.outcome.kind === 'compacted') {
    expect(result.outcome.path).toBe('context_capsule');
  }
});

test('原生与 Capsule 都不足时执行一次机械 Shake，且只执行一次', () => {
  const heavy: HistorySegment[] = [
    messages('step-1', 'a'.repeat(SHAKE_HEAVY_CONTENT_CHARS + 500)),
    messages('step-2', 'b'.repeat(SHAKE_HEAVY_CONTENT_CHARS + 500)),
  ];
  const first = compactWithNativeFirst(
    request({
      segments: heavy,
      budgetTokens: 300,
      deriveCapsule: () => null,
    }),
  );

  expect(first.outcome.kind).toBe('compacted');
  if (first.outcome.kind === 'compacted') {
    expect(first.outcome.path).toBe('mechanical_shake');
  }

  // 已经执行过一次 Shake 且仍未收敛：不再重复，直接以显式状态结束。
  const again = compactWithNativeFirst(
    request({
      segments: heavy,
      budgetTokens: 300,
      shaken: true,
      deriveCapsule: () => null,
    }),
  );
  expect(again.outcome.kind).toBe('context_exhausted');
});

test('机械 Shake 未取得新进展时显式降级，且不调用模型', () => {
  const light: HistorySegment[] = [messages('step-1', 'short'), messages('step-2', 'short')];
  const result = compactWithNativeFirst(
    request({ segments: light, budgetTokens: 1, deriveCapsule: () => null }),
  );

  expect(result.outcome.kind).toBe('compaction_degraded');
  if (result.outcome.kind === 'compaction_degraded') {
    expect(result.outcome.reason).toContain('未取得新进展');
  }
});

test('所有路径都用尽且仍超预算时显式 context_exhausted', () => {
  const heavy: HistorySegment[] = [messages('step-1', 'a'.repeat(SHAKE_HEAVY_CONTENT_CHARS + 500))];
  const result = compactWithNativeFirst(
    request({ segments: heavy, budgetTokens: 10, deriveCapsule: () => null }),
  );

  expect(result.outcome.kind).toBe('context_exhausted');
  if (result.outcome.kind === 'context_exhausted') {
    expect(result.outcome.stillOverBudget).toBeGreaterThan(0);
    expect(result.outcome.reason).toContain('超出预算');
  }
});

test('机械 Shake 把重量级内容换成可恢复占位符，轻量消息原样保留', () => {
  const segments: HistorySegment[] = [
    messages('step-1', 'x'.repeat(SHAKE_HEAVY_CONTENT_CHARS + 1)),
    messages('step-2', 'light'),
  ];

  const shaken = mechanicalShake(segments);
  const first = shaken[0];
  expect(first?.kind).toBe('messages');
  if (first?.kind === 'messages') {
    const content = (first.messages[0] as { readonly content: string }).content;
    expect(content).toContain('omitted');
    expect(content).toContain('step-1');
    expect(content).toContain('checkpoint');
  }
  const second = shaken[1];
  if (second?.kind === 'messages') {
    expect((second.messages[0] as { readonly content: string }).content).toBe('light');
  }
  expect(estimate(shaken)).toBeLessThan(estimate(segments));
});
