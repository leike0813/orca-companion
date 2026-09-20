/**
 * IC-02：`ExecutionBackend` port、ExecutionScope 与封闭操作目录
 * （Owner: `m0-orca-control-baseline`）。
 *
 * 调用方只能提交这里登记的 operation variant；argv 构造、JSON parser、输出上限与可变性登记在
 * `src/adapters/orca-cli/operation-catalog.ts`，因此 Application 层不出现任何 CLI flag。
 *
 * 身份规则：`backendIdentityRef` 是不透明的协调身份引用，adapter 把它解析成当前 runtime 作用域的
 * terminal handle；handle 不进入 DTO、不落盘。变更操作的身份来自 controller 签发的 ExecutionScope，
 * 模型与 Worker 不能填写 scope、身份、Run、consumer generation 或 operation identity。
 */

import type {
  ExecutionQueryResult,
  OperationOutcome,
} from '../dto/operation-outcome.js';

export type ExecutionAuthority =
  | { readonly kind: 'route_planning' }
  | {
      readonly kind: 'execution_coordination';
      readonly graphGeneration: number;
      readonly authorizationId: string;
      readonly runId: string;
      readonly consumerGeneration: number;
    };

export type ExecutionScope = {
  readonly coordinationScopeId: string;
  readonly coordinatorSessionId: string;
  readonly runtimeIncarnationId: string;
  readonly fencingGeneration: number;
  readonly backendIdentityRef: string;
  readonly operationId: string;
  readonly target: { readonly kind: string; readonly id: string };
  readonly expectedRevision: number;
  readonly timeoutMs: number;
  readonly authority: ExecutionAuthority;
};

/** 只读操作。不产生副作用，因此没有 scope，也不产生 `unknown` 处置。 */
export type ExecutionQuery =
  | { readonly operation: 'version' }
  | { readonly operation: 'status' }
  | { readonly operation: 'host-list' }
  | { readonly operation: 'worktree-current' }
  | { readonly operation: 'terminal-list'; readonly worktree?: string; readonly limit?: number }
  | { readonly operation: 'terminal-show'; readonly terminal: string }
  | {
      readonly operation: 'terminal-read';
      readonly terminal: string;
      readonly cursor?: number;
      readonly limit?: number;
      readonly screen?: boolean;
    }
  | {
      readonly operation: 'terminal-wait';
      readonly terminal: string;
      readonly waitFor: 'exit' | 'tui-idle';
      readonly timeoutMs: number;
    }
  | { readonly operation: 'run-list'; readonly limit?: number; readonly cursor?: string }
  | { readonly operation: 'run-show'; readonly runId: string }
  | { readonly operation: 'run-current'; readonly backendIdentityRef: string }
  | {
      readonly operation: 'task-list';
      readonly backendIdentityRef: string;
      readonly runId?: string;
      readonly status?: string;
      readonly ready?: boolean;
      readonly brief?: boolean;
    }
  | { readonly operation: 'worker-show'; readonly dispatchId: string }
  | {
      readonly operation: 'worker-read';
      readonly dispatchId: string;
      readonly source?: 'auto' | 'transcript' | 'terminal';
      readonly cursor?: string;
      readonly limit?: number;
    }
  | {
      readonly operation: 'worker-list';
      readonly runId?: string;
      readonly terminalState?: string;
    }
  | {
      readonly operation: 'delivery-read';
      readonly backendIdentityRef: string;
      readonly runId?: string;
      readonly types?: readonly string[];
      readonly wait?: boolean;
      readonly timeoutMs?: number;
      readonly readMode?: 'default' | 'peek' | 'all';
    }
  | { readonly operation: 'request-show'; readonly requestId: string };

/** 变更操作。身份与 operationId 只能来自 controller 签发的 ExecutionScope。 */
export type ExecutionMutation =
  | {
      readonly operation: 'terminal-create';
      readonly worktree: string;
      readonly title?: string;
      readonly command?: string;
    }
  | { readonly operation: 'run-create'; readonly objective: string; readonly retryRequestId?: string }
  | { readonly operation: 'run-use'; readonly runId: string; readonly takeoverLegacy?: boolean }
  | {
      readonly operation: 'task-create';
      readonly spec: string;
      readonly deps?: readonly string[];
      readonly parentTaskId?: string;
      readonly runId?: string;
      readonly taskTitle?: string;
      readonly displayName?: string;
    }
  | {
      readonly operation: 'task-update';
      readonly taskId: string;
      readonly status: string;
      readonly result?: unknown;
    }
  | {
      readonly operation: 'worker-start';
      readonly taskId: string;
      readonly agent?: string;
      readonly terminal?: string;
      readonly model?: string;
      readonly effort?: string;
      readonly worktree?: string;
      readonly on?: string;
      readonly retryOfDispatchId?: string;
      readonly runId?: string;
      readonly timeoutMs?: number;
    }
  | { readonly operation: 'worker-stop'; readonly dispatchId: string }
  | { readonly operation: 'worker-abandon'; readonly dispatchId: string }
  | { readonly operation: 'worker-release'; readonly dispatchId: string }
  | { readonly operation: 'delivery-ack'; readonly deliveryId: string; readonly runId?: string };

export type ExecutionOperation = ExecutionQuery | ExecutionMutation;

export interface ExecutionBackend {
  query(input: ExecutionQuery): Promise<ExecutionQueryResult>;
  mutate(input: ExecutionMutation, scope: ExecutionScope): Promise<OperationOutcome<unknown>>;
}
