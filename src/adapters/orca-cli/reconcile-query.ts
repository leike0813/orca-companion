/**
 * IP-2 / IC-02 / D2：Orca `request-show` 的对账查询载荷映射（Owner: `m1-recover-execution`）。
 *
 * 对账能力已由前驱完整实现，本模块**不重复**它的判定：封闭的 `ExecutionQuery` 联合里已有
 * `{ operation: 'request-show'; requestId }`，三值映射在 IC-02 的 `reconcileOperation` 中：
 *
 * - `completed` → `settled`（外部系统记录了确定结果，即「已接受」）；
 * - `pending` / `absent` → `blocked`（未决，保持 lane 阻塞）；
 * - 没有 `backendRequestId` → `blocked(no_backend_request_id)`，不发起查询。
 *
 * 这里承担的是 adapter 侧的那一半：把 Orca 的原始 `request-show` 载荷验证成**闭集**的请求状态。
 * 未知枚举、缺失必填字段与非对象载荷一律 fail closed；未知状态不会退化成某个默认结论。
 *
 * 关键语义（与 IC-02 一致，不得放宽）：`absent` 明确**不代表请求未发生**，因此它只是一个「已识别
 * 但未结」的状态，绝不在 adapter 层被降级成「已拒绝」。
 *
 * 本模块不依赖 operation catalog，也不依赖应用层，因此可以被 catalog 复用而不形成循环依赖。
 */

/** Orca `request-show` 目前公开的请求状态闭集。 */
export const REQUEST_SHOW_STATES = ['completed', 'pending', 'absent'] as const;

export type RequestState = (typeof REQUEST_SHOW_STATES)[number];

export type RequestShowResult = {
  readonly requestId: string;
  readonly state: RequestState;
  readonly interpretation: string | null;
};

/** 与 catalog 的 `OperationParse` 结构相同；在这里本地声明以免反向依赖 catalog。 */
export type RequestShowParse =
  | { readonly ok: true; readonly value: RequestShowResult }
  | { readonly ok: false; readonly message: string };

function invalid(message: string): RequestShowParse {
  return { ok: false, message };
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' ? value : null;
}

/**
 * 校验并归一化一条 `request-show` 结果。
 *
 * 失败消息与行为保持前驱逐字不变，使 adapter contract test 的既有断言继续成立。
 */
export function readRequestShow(result: unknown): RequestShowParse {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    return invalid('request show: 结果不是对象');
  }
  const record = result as Record<string, unknown>;
  const requestId = readString(record, 'requestId');
  const state = readString(record, 'state');
  if (requestId === null || state === null) {
    return invalid('request show: 缺少 requestId 或 state');
  }
  if (!(REQUEST_SHOW_STATES as readonly string[]).includes(state)) {
    return invalid(`request show: 未知 state ${state}`);
  }
  return {
    ok: true,
    value: { requestId, state: state as RequestState, interpretation: readString(record, 'interpretation') },
  };
}
