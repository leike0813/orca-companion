import type { CoordinatorSessionId } from '../../application/dto/identity.js';
import type { CheckpointWriteResult } from '../../application/coordinator/runtime-guard.js';
import type {
  CommittedMessageEntry,
  CoordinatorSessionState,
  MechanicalShakeArtifact,
  NativeCompactedWindowOwner,
  NativeWindowItemRef,
  PortableContextCapsule,
} from '../../domain/coordinator/session-state.js';
import {
  mechanicalShakeSourceRevision,
  resolveMechanicalShake,
  shakenStepIds,
} from './compaction.js';
import {
  buildBoundedModelInput,
  type BoundedModelInput,
  type ToolSchemaEntry,
} from './context.js';
import type { HistorySegment, NativeCompactionAvailability } from './state.js';

/** Capsule/native ownership is preserved when either launch profile assembles model input. */
export function historySegmentsFromState(state: CoordinatorSessionState): readonly HistorySegment[] {
  const capsule = state.contextMaterial?.capsule ?? null;
  const native = state.contextMaterial?.nativeWindowOwner ?? null;
  const covered = new Set<string>();
  if (capsule !== null) {
    const from = state.committedMessages.findIndex(entry => entry.stepId === capsule.replacedFromStepId);
    const to = state.committedMessages.findLastIndex(entry => entry.stepId === capsule.replacedToStepId);
    if (from >= 0 && to >= from) {
      for (const entry of state.committedMessages.slice(from, to + 1)) covered.add(entry.entryId);
    }
  }
  const grouped: HistorySegment[] = [];
  if (native !== null) grouped.push({ kind: 'native-window', ownerRef: native.ownerRef, items: native.items });
  if (capsule !== null && native === null) grouped.push({
    kind: 'capsule', capsuleId: capsule.capsuleId, text: capsule.text,
    replacedFromStepId: capsule.replacedFromStepId, replacedToStepId: capsule.replacedToStepId,
  });
  let current: { kind: 'messages'; stepId: string; messages: CommittedMessageEntry[] } | null = null;
  for (const entry of state.committedMessages) {
    if (covered.has(entry.entryId)) continue;
    if (current === null || current.stepId !== entry.stepId) {
      current = { kind: 'messages', stepId: entry.stepId, messages: [] };
      grouped.push(current);
    }
    current.messages.push(entry);
  }
  return grouped;
}

/** Existing budget heuristic; never a measured context percentage or model window. */
export function estimateHistoryTokens(segments: readonly HistorySegment[]): number {
  return segments.reduce((total, segment) => {
    if (segment.kind === 'capsule') return total + Math.ceil(segment.text.length / 4);
    if (segment.kind === 'native-window') return total;
    return total + segment.messages.reduce<number>((sum, message) => {
      const content = (message as { readonly content?: unknown }).content;
      return sum + (typeof content === 'string' ? Math.ceil((content.length + 16) / 4) : 0);
    }, 0);
  }, 0);
}

/**
 * provider 原生压缩能力的最小结构。
 *
 * 与 adapter 的 `NativeCompactionCapability` 同形，因此 bootstrap 可以直接把解析结果传进来，而
 * workflow 不必依赖 adapter 类型。
 */
export type NativeCompactionPort = {
  readonly compact: (input: {
    readonly messages: readonly unknown[];
    readonly tools: readonly unknown[];
    readonly signal?: AbortSignal;
  }) => Promise<{
    readonly ownerRef: string;
    readonly items: readonly NativeWindowItemRef[];
    readonly compactedTokens: number;
  } | null>;
};

/** 写入一次压缩结论所需的 checkpoint 能力；两个宿主打开的是同一个 store，因此共用这份形状。 */
export type CompactionPersistencePort = {
  readonly updateCheckpoint: (
    id: CoordinatorSessionId,
    patch: Partial<Pick<CoordinatorSessionState, 'graphPosition' | 'lastCompactionOutcome'>>,
  ) => CheckpointWriteResult;
  readonly savePortableCapsule: (id: CoordinatorSessionId, capsule: PortableContextCapsule) => CheckpointWriteResult;
  readonly saveNativeWindowOwner: (id: CoordinatorSessionId, owner: NativeCompactedWindowOwner) => CheckpointWriteResult;
  readonly saveMechanicalShake: (id: CoordinatorSessionId, artifact: MechanicalShakeArtifact) => CheckpointWriteResult;
  readonly clearMechanicalShake: (id: CoordinatorSessionId) => CheckpointWriteResult;
};

/** 判定原生压缩可用性所需的宿主事实；预算与固定开销由宿主给出，本模块不发明模型窗口。 */
export type NativeCompactionRequest = {
  readonly configurationRef: string;
  readonly fixedOverhead: number;
  readonly budgetTokens: number;
  readonly nativeCompaction: NativeCompactionPort | null;
  readonly instructions: readonly string[];
  readonly toolSchema: readonly ToolSchemaEntry[];
  readonly authoritativeFacts: readonly string[];
  readonly currentWork?: { readonly workKind: string; readonly summary: string } | null;
  /** 本次模型调用已中止；此时不得发起任何可选的 provider 调用。 */
  readonly aborted?: boolean;
  readonly signal?: AbortSignal;
};

/** 追加组装一次有界模型输入所需的会话事实。 */
export type SessionBoundedInputRequest = NativeCompactionRequest & {
  readonly state: CoordinatorSessionState;
  /** 已提交历史的累计序号；它是 Shake 边界身份的一部分。 */
  readonly tailSequence: number;
};

/** 组装结果；`shakeBoundary` 与压缩结论一起构成下一次可重放的同一结论。 */
export type SessionBoundedInput = {
  readonly input: BoundedModelInput;
  readonly shakeBoundary: string;
};

/**
 * provider 原生压缩的可用性。
 *
 * 只有集成显式提供能力、输入确实超预算且本次调用未被中止时才尝试；provider 看到的是未压缩的
 * 完整有效输入，因此先用一个不触发压缩的预算把消息组装出来再交给它。返回 `null` 或抛错一律按
 * unavailable 处理，绝不退化成「假装压过」。
 */
export async function nativeCompactionAvailabilityFor(request: NativeCompactionRequest, segments: readonly HistorySegment[]): Promise<NativeCompactionAvailability> {
  if (request.nativeCompaction === null) {
    return { kind: 'unavailable', reason: 'provider 集成未提供原生压缩能力' };
  }
  if (estimateHistoryTokens(segments) + request.fixedOverhead <= request.budgetTokens) {
    return { kind: 'unavailable', reason: '当前有效输入已在预算内' };
  }
  if (request.aborted === true || request.signal?.aborted === true) {
    return { kind: 'unavailable', reason: '本次模型调用已中止' };
  }
  // ponytail: 组装两次（探测 + 真正输入）；provider 压缩端点是真实网络调用，本地拼装占比可忽略。
  const probe = buildBoundedModelInput({
    segments,
    estimate: estimateHistoryTokens,
    fixedOverhead: request.fixedOverhead,
    budgetTokens: Number.MAX_SAFE_INTEGER,
    native: { kind: 'unavailable', reason: 'probe' },
    shaken: true,
    configurationRef: request.configurationRef,
    instructions: request.instructions,
    toolSchema: request.toolSchema,
    authoritativeFacts: request.authoritativeFacts,
    ...(request.currentWork === undefined ? {} : { currentWork: request.currentWork }),
  });
  try {
    const compacted = await request.nativeCompaction.compact({
      messages: probe.messages,
      tools: probe.toolSchema,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    if (compacted === null) {
      return { kind: 'unavailable', reason: 'provider 本次未返回原生压缩窗口' };
    }
    return {
      kind: 'available',
      compact: () => ({
        ownerRef: compacted.ownerRef,
        items: compacted.items,
        compactedTokens: compacted.compactedTokens,
      }),
    };
  } catch {
    return { kind: 'unavailable', reason: 'provider 原生压缩调用失败' };
  }
}

/**
 * 按稳定边界组装一次有界模型输入。
 *
 * 顺序与生产一致：先按 provider 能力取原生窗口，再按稳定边界决定是否复用已保存的机械 Shake
 * 产物；同一历史 / configuration / Capsule 边界至多尝试一次 Shake，重启后仍读到同一结论。
 */
export async function buildSessionBoundedInput(request: SessionBoundedInputRequest): Promise<SessionBoundedInput> {
  const material = request.state.contextMaterial ?? null;
  const shakeBoundary = mechanicalShakeSourceRevision({
    tailSequence: request.tailSequence,
    configurationRef: request.configurationRef,
    capsuleId: material?.capsule?.capsuleId ?? null,
    nativeOwnerRef: material?.nativeWindowOwner?.ownerRef ?? null,
  });
  const resolution = resolveMechanicalShake({
    artifact: material?.mechanicalShake ?? null,
    sourceRevision: shakeBoundary,
    segments: historySegmentsFromState(request.state),
  });
  const native = await nativeCompactionAvailabilityFor(request, resolution.segments);
  const input = buildBoundedModelInput({
    segments: resolution.segments,
    estimate: estimateHistoryTokens,
    fixedOverhead: request.fixedOverhead,
    budgetTokens: request.budgetTokens,
    native,
    shaken: resolution.kind === 'reapplied',
    configurationRef: request.configurationRef,
    instructions: request.instructions,
    toolSchema: request.toolSchema,
    authoritativeFacts: request.authoritativeFacts,
    ...(request.currentWork === undefined ? {} : { currentWork: request.currentWork }),
  });
  return { input, shakeBoundary };
}

/**
 * 落盘本次压缩结论、Capsule、原生窗口与机械 Shake 产物。
 *
 * 写失败一律抛出：结论无法持久化时继续请求模型，会留下一条重启后无法复现的输入。边界变化时
 * 清除陈旧的 Shake 产物， Capsule 仍以 checkpoint 中的权威原文为准。
 */
export function persistBoundedCompaction(input: {
  readonly checkpoints: CompactionPersistencePort;
  readonly coordinatorSessionId: CoordinatorSessionId;
  readonly state: CoordinatorSessionState;
  readonly built: BoundedModelInput;
  readonly shakeBoundary: string;
}): CoordinatorSessionState {
  if (input.built.compaction.kind === 'not_needed' && input.state.lastCompactionOutcome?.kind === 'not_needed') {
    return input.state;
  }
  const next: CoordinatorSessionState = { ...input.state, lastCompactionOutcome: input.built.compaction };
  const saved = input.checkpoints.updateCheckpoint(input.coordinatorSessionId, { lastCompactionOutcome: input.built.compaction });
  if (saved.kind === 'failed') throw new Error(`无法持久化压缩结论：${saved.message}`);
  const capsuleSegment = input.built.segments.find((segment) => segment.kind === 'capsule');
  if (capsuleSegment !== undefined && capsuleSegment.kind === 'capsule') {
    const capsuleSaved = input.checkpoints.savePortableCapsule(input.coordinatorSessionId, {
      kind: 'derived_context_capsule',
      capsuleId: capsuleSegment.capsuleId,
      replacedFromStepId: capsuleSegment.replacedFromStepId,
      replacedToStepId: capsuleSegment.replacedToStepId,
      text: capsuleSegment.text,
    });
    if (capsuleSaved.kind === 'failed') throw new Error(`无法持久化压缩 Capsule：${capsuleSaved.message}`);
  }
  const nativeSegment = input.built.segments.find((segment) => segment.kind === 'native-window');
  if (nativeSegment !== undefined && nativeSegment.kind === 'native-window') {
    const nativeSaved = input.checkpoints.saveNativeWindowOwner(input.coordinatorSessionId, {
      ownerRef: nativeSegment.ownerRef,
      items: [...nativeSegment.items],
    });
    if (nativeSaved.kind === 'failed') throw new Error(`无法持久化原生上下文：${nativeSaved.message}`);
  }
  const existingShake = input.state.contextMaterial?.mechanicalShake ?? null;
  if (input.built.compaction.kind === 'compacted' && input.built.compaction.path === 'mechanical_shake') {
    const shakeSaved = input.checkpoints.saveMechanicalShake(input.coordinatorSessionId, {
      sourceRevision: input.shakeBoundary,
      shakenStepIds: shakenStepIds(historySegmentsFromState(input.state)),
    });
    if (shakeSaved.kind === 'failed') throw new Error(`无法持久化机械 Shake 产物：${shakeSaved.message}`);
  } else if (existingShake !== null && existingShake.sourceRevision !== input.shakeBoundary) {
    const cleared = input.checkpoints.clearMechanicalShake(input.coordinatorSessionId);
    if (cleared.kind === 'failed') throw new Error(`无法清除陈旧的机械 Shake 产物：${cleared.message}`);
  }
  return next;
}

/**
 * 结论是否允许继续请求模型。
 *
 * `context_exhausted` 与 `compaction_degraded` 都表示当前输入不可用：调用方必须在发出请求之前
 * 停下，而不是把超预算的输入交给 provider。
 */
export function contextFailureOf(compaction: BoundedModelInput['compaction']): string | null {
  if (compaction.kind === 'context_exhausted') return `上下文已耗尽：${compaction.reason}`;
  if (compaction.kind === 'compaction_degraded') return `上下文压缩未取得进展：${compaction.reason}`;
  return null;
}
