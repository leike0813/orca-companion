/**
 * IC-03 的 Operation Intent 记录（Owner: `m1-persist-coordination-state`）。
 *
 * 意图表达「我方是否发起过这次副作用」；外部 receipt 表达「副作用是否落地」。两者只以
 * `operationId` / `backendRequestId` 关联，不互相复制，因此这里不保存 Orca receipt 正文。
 *
 * 意图在任何外部 mutation 之前落盘，`unknown` 结果保留为未决；对账沿用同一
 * `OperationRef`（IC-02），不换 ID 重试。
 */

import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  EntityRef,
  OperationId,
  Revision,
  RuntimeIncarnationId,
} from './identity.js';

export const INTENT_STATES = ['pending', 'settled', 'blocked'] as const;

export type IntentState = (typeof INTENT_STATES)[number];

export const INTENT_OUTCOME_CLASSES = ['accepted', 'rejected'] as const;

export type IntentOutcomeClass = (typeof INTENT_OUTCOME_CLASSES)[number];

export type OperationIntent = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly operationId: OperationId;
  readonly target: EntityRef<string>;
  /** 操作类别（如 `task-create`），与 target 一起构成 mutation lane 的粒度。 */
  readonly operationCategory: string;
  readonly laneKey: string;
  readonly expectedRevision: Revision;
  readonly initiatedBy: {
    readonly coordinatorSessionId: CoordinatorSessionId;
    readonly runtimeIncarnationId: RuntimeIncarnationId;
  };
  readonly state: IntentState;
  /** 只有收尾后的意图才有结果分类；未决与阻塞都是 `null`。 */
  readonly outcomeClass: IntentOutcomeClass | null;
  readonly backendRequestId: string | null;
  readonly blockingReason: string | null;
  readonly createdAt: number;
  readonly settledAt: number | null;
};

/**
 * mutation lane 的粒度是「目标对象 + 操作类别」，不是全局：不确定性只限制相关通路。
 * 以 JSON 数组编码而不是分隔符拼接：kind / id / category 都可能含任意字符，而 NUL 之类的
 * 控制字符会在读取时被 SQLite 的 C 字符串接口截断，从而让拼接键无法还原。
 */
export function laneKeyOf(target: EntityRef<string>, operationCategory: string): string {
  return JSON.stringify([target.kind, target.id, operationCategory]);
}
