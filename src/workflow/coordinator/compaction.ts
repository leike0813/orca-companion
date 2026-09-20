/**
 * MOD-03：模型输入的有界化与压缩路径选择
 * （Owner: `m1-run-coordinator-sessions`）。
 *
 * 路径优先级是固定的（D9）：provider-native 压缩 → 派生的 Context Capsule → 一次不带模型调用的
 * 机械 Shake → 显式 `compaction_degraded` 或 `context_exhausted`。不会颠倒顺序，也不会在有原生
 * 能力时先去派 Capsule。
 *
 * 这个模块不自己估算 token：分词属于 provider 的实现细节，因此规模估算由调用方注入。它也不派生
 * Capsule——那需要理解消息语义，由 `context.ts` 以参数形式提供，从而让两个模块保持单向依赖。
 */

import {
  type CapsuleDerivation,
  type CompactionOutcome,
  type CompactionPath,
  type HistorySegment,
  type NativeCompactionAvailability,
  type NativeWindowCarry,
} from './state.js';

/** 超过这个字符数的消息内容会被机械 Shake 视为「重量级」。 */
export const SHAKE_HEAVY_CONTENT_CHARS = 2_000;

/** 机械 Shake 写入的占位符：明确声明原内容可从 checkpoint 按 step 读回。 */
export function shakePlaceholder(stepId: string, characters: number): string {
  return `<omitted ${String(characters)} chars; 原消息可从 checkpoint 的 ${stepId} 读回>`;
}

function messageContentLength(message: unknown): number {
  if (typeof message !== 'object' || message === null) {
    return 0;
  }
  const content = (message as { readonly content?: unknown }).content;
  return typeof content === 'string' ? content.length : 0;
}

function messageRole(message: unknown): string | null {
  if (typeof message !== 'object' || message === null) {
    return null;
  }
  const role = (message as { readonly role?: unknown }).role;
  if (typeof role === 'string') {
    return role;
  }
  const getType = (message as { readonly getType?: unknown }).getType;
  if (typeof getType === 'function') {
    const type = (getType as () => unknown).call(message);
    return typeof type === 'string' ? type : null;
  }
  return null;
}

/**
 * 一次不带模型调用的机械 Shake。
 *
 * 只把重量级内容替换成可恢复占位符：role 保留、其余消息原样不动。因此它永远不改变语义，
 * 也永远不需要模型参与——模型不可用或已溢出时它仍然可行。
 */
export function mechanicalShake(segments: readonly HistorySegment[]): readonly HistorySegment[] {
  return segments.map((segment) => {
    if (segment.kind !== 'messages') {
      return segment;
    }
    let replaced = false;
    const messages = segment.messages.map((message) => {
      const characters = messageContentLength(message);
      if (characters <= SHAKE_HEAVY_CONTENT_CHARS) {
        return message;
      }
      replaced = true;
      const role = messageRole(message) ?? 'user';
      return { role, content: shakePlaceholder(segment.stepId, characters) };
    });
    return replaced ? { kind: 'messages', stepId: segment.stepId, messages } : segment;
  });
}

export type CompactionRequest = {
  readonly segments: readonly HistorySegment[];
  /** 注入的规模估算：compaction 不猜 provider 的分词。 */
  readonly estimate: (segments: readonly HistorySegment[]) => number;
  /** 历史之外的固定开销（instructions、tool schema、最新权威事实）。 */
  readonly fixedOverhead: number;
  readonly budgetTokens: number;
  readonly native: NativeCompactionAvailability;
  /** 是否已经执行过一次机械 Shake；未取得新进展时不得重复。 */
  readonly shaken: boolean;
  /**
   * 把最早的一段历史压缩成 Capsule；返回 `null` 表示这段历史不足以派生 Capsule。
   * 无法安全归类时由实现抛出 `ContextMaintenanceError`，compaction 不吞掉它。
   */
  readonly deriveCapsule: (segments: readonly HistorySegment[]) => CapsuleDerivation | null;
};

export type CompactionResult = {
  readonly outcome: CompactionOutcome;
  /** 本次采用的输入片段；`context_exhausted` 时调用方不得继续请求模型。 */
  readonly segments: readonly HistorySegment[];
};

function totalTokens(request: CompactionRequest, segments: readonly HistorySegment[]): number {
  return request.fixedOverhead + request.estimate(segments);
}

/** 用原生窗口替换掉全部 `messages` 片段：原生压缩是整窗口替换。 */
function nativeWindowSegments(
  segments: readonly HistorySegment[],
  carry: NativeWindowCarry,
): readonly HistorySegment[] {
  const retained = segments.filter((segment) => segment.kind !== 'messages');
  return [
    { kind: 'native-window', ownerRef: carry.ownerRef, items: carry.items },
    ...retained,
  ];
}

function leadingMessageRun(segments: readonly HistorySegment[]): readonly HistorySegment[] {
  const run: HistorySegment[] = [];
  for (const segment of segments) {
    if (segment.kind !== 'messages') {
      break;
    }
    run.push(segment);
  }
  return run;
}

/**
 * 按固定优先级把输入带回有界范围。
 *
 * 调用方必须按返回的 `outcome.kind` 决定是否继续请求：`context_exhausted` 与
 * `compaction_degraded` 都表示「不得继续用当前输入请求」。
 */
export function compactWithNativeFirst(request: CompactionRequest): CompactionResult {
  if (totalTokens(request, request.segments) <= request.budgetTokens) {
    return {
      outcome: {
        kind: 'not_needed',
        path: 'none',
        note: `输入 ${String(totalTokens(request, request.segments))} token 已在预算 ${String(request.budgetTokens)} 内`,
      },
      segments: request.segments,
    };
  }

  let current: readonly HistorySegment[] = request.segments;
  let path: CompactionPath = 'none';

  // 1. provider-native：整窗口替换，不透明项原样携带。
  if (request.native.kind === 'available') {
    const carry = request.native.compact();
    const candidate = nativeWindowSegments(current, carry);
    // 原生窗口对 Companion 是不透明的：它的规模由 provider 报告，不能用本地估算替代。
    const retained = request.estimate(candidate.filter((segment) => segment.kind !== 'native-window'));
    const nativeTotal = request.fixedOverhead + retained + carry.compactedTokens;
    if (nativeTotal <= request.budgetTokens) {
      return {
        outcome: {
          kind: 'compacted',
          path: 'provider_native',
          compactedTokens: nativeTotal,
          note: `使用 provider 原生压缩窗口 ${carry.ownerRef}`,
        },
        segments: candidate,
      };
    }
    path = 'provider_native';
  }

  // 2. Context Capsule：按派生视图表示更早的消息区间。
  const run = leadingMessageRun(current);
  if (run.length > 0) {
    const derived = request.deriveCapsule(current);
    if (derived !== null && derived.replacedCount > 0) {
      const candidate = [derived.segment, ...current.slice(derived.replacedCount)];
      if (totalTokens(request, candidate) <= request.budgetTokens) {
        return {
          outcome: {
            kind: 'compacted',
            path: 'context_capsule',
            compactedTokens: totalTokens(request, candidate),
            note: '使用派生的 Context Capsule 表示更早的消息区间',
          },
          segments: candidate,
        };
      }
      current = candidate;
      path = 'context_capsule';
    }
  }

  // 3. 一次机械 Shake：不调用模型，只在真的取得空间时才算进展。
  if (!request.shaken) {
    const shaken = mechanicalShake(current);
    const gained = request.estimate(current) - request.estimate(shaken);
    if (gained <= 0) {
      return {
        outcome: {
          kind: 'compaction_degraded',
          path,
          reason: '机械 Shake 未取得新进展，不重复执行',
        },
        segments: current,
      };
    }
    if (totalTokens(request, shaken) <= request.budgetTokens) {
      return {
        outcome: {
          kind: 'compacted',
          path: 'mechanical_shake',
          compactedTokens: totalTokens(request, shaken),
          note: '使用一次机械 Shake 恢复有界输入',
        },
        segments: shaken,
      };
    }
    current = shaken;
  }

  return {
    outcome: {
      kind: 'context_exhausted',
      reason: `所有压缩路径均已尝试，输入仍超出预算 ${String(totalTokens(request, current) - request.budgetTokens)} token`,
      stillOverBudget: totalTokens(request, current) - request.budgetTokens,
    },
    segments: current,
  };
}
