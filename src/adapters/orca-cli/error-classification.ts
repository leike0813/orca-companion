/**
 * D3：Orca 公开错误码到三值处置与失败类别的唯一映射点。
 *
 * 规则（见 `docs/interface-contracts.md` IC-02 与 D3）：
 * - 已登记的确定失败（输入不合法、阶段不允许、scope 错误、旧尝试、能力缺失）是 `accepted`：
 *   Orca 已经记录了一个确定结果，`accepted` 不等于 Worker 完成，也不等于项目可交付。
 * - 能证明请求没有抵达 runtime 时是 `rejected`：本地拒绝、进程没能启动，或 `_meta.runtimeId` 为
 *   `null`（research 已核验：此时请求根本没到 runtime）。
 * - `start_unknown` / `stop_unknown` / `outcome_unknown` / `release_unknown` / `release_pending`
 *   以及抵达 runtime 后的传输类故障是 `unknown`，必须用原 OperationId 对账。
 * - 未登记的错误码 fail closed 为 `unknown`：既不当作确定失败，也不读作「未发生」。
 */

export type FailureCategory =
  | 'invalid_input'
  | 'phase_not_allowed'
  | 'scope_error'
  | 'stale_attempt'
  | 'capability_missing'
  | 'backend_unreachable'
  | 'unrecognized';

export type OrcaFailureClassification =
  | { readonly disposition: 'accepted'; readonly category: FailureCategory }
  | { readonly disposition: 'rejected'; readonly category: FailureCategory }
  | { readonly disposition: 'unknown'; readonly reason: string };

const CATEGORY_BY_CODE: Readonly<Record<string, FailureCategory>> = {
  invalid_argument: 'invalid_input',
  invalid_request: 'invalid_input',
  task_not_startable: 'phase_not_allowed',
  stable_pane_required: 'phase_not_allowed',
  run_required: 'phase_not_allowed',
  nested_worker_depth_exceeded: 'phase_not_allowed',
  already_released: 'phase_not_allowed',
  consumer_fenced: 'scope_error',
  legacy_read_only: 'scope_error',
  run_not_found: 'scope_error',
  task_not_found: 'scope_error',
  dispatch_not_found: 'scope_error',
  terminal_gone: 'scope_error',
  terminal_handle_stale: 'scope_error',
  selector_ambiguous: 'scope_error',
  selector_not_found: 'scope_error',
  no_active_sender_terminal: 'scope_error',
  worker_identity_changed: 'scope_error',
  stale_dispatch: 'stale_attempt',
  inject_rejected: 'capability_missing',
  provider_unsupported: 'capability_missing',
  incompatible_runtime: 'capability_missing',
  method_not_found: 'capability_missing',
  transcript_required: 'capability_missing',
};

/** 公开的不确定状态：它们不是失败，必须进入对账。 */
const UNKNOWN_STATE_CODES: ReadonlySet<string> = new Set([
  'start_unknown',
  'stop_unknown',
  'outcome_unknown',
  'release_unknown',
  'release_pending',
]);

/** 传输类故障：只有在请求已抵达 runtime 时才意味着副作用可能发生。 */
const TRANSPORT_FAILURE_CODES: ReadonlySet<string> = new Set([
  'runtime_unavailable',
  'remote_runtime_unavailable',
  'runtime_timeout',
  'invalid_runtime_response',
]);

/** 进程边界自身的失败码：请求从未抵达后端，统一归类为不可达。 */
const LOCAL_TRANSPORT_CODES: ReadonlySet<string> = new Set([
  'process_spawn_failed',
  'process_timeout',
  'process_cancelled',
]);

export function failureCategoryOf(code: string): FailureCategory {
  if (LOCAL_TRANSPORT_CODES.has(code)) {
    return 'backend_unreachable';
  }
  return CATEGORY_BY_CODE[code] ?? (TRANSPORT_FAILURE_CODES.has(code) ? 'backend_unreachable' : 'unrecognized');
}

/**
 * @param reachedRuntime envelope 的 `_meta.runtimeId` 是否为非 null；`null` 证明请求未抵达 runtime。
 */
export function classifyOrcaFailure(input: {
  readonly code: string;
  readonly reachedRuntime: boolean;
}): OrcaFailureClassification {
  if (UNKNOWN_STATE_CODES.has(input.code)) {
    return { disposition: 'unknown', reason: `${input.code}: Orca 报告了不确定状态，必须按原 OperationId 对账` };
  }
  const category = failureCategoryOf(input.code);
  if (!input.reachedRuntime) {
    return { disposition: 'rejected', category };
  }
  if (TRANSPORT_FAILURE_CODES.has(input.code)) {
    return { disposition: 'unknown', reason: `${input.code}: 请求已抵达 runtime 且响应不可判定` };
  }
  if (category === 'unrecognized') {
    return { disposition: 'unknown', reason: `未登记的错误码 ${input.code}，fail closed` };
  }
  return { disposition: 'accepted', category };
}
