/**
 * IC-05：Route Planning 的 GitHub issue tracker adapter（Owner: `m1-plan-and-authorize-execution`）。
 *
 * Route Map 与 Decision Ticket 的事实权威在 issue tracker，这里只实现 `IssueTrackerGateway` 这一条接缝：
 * 通过已安装的 `gh` CLI 读写 issue，参数以数组形式交给进程边界——不经 shell，也不拼接命令字符串。
 *
 * `gh` 的文本输出不是稳定契约：字段可能缺失、state 词表可能漂移、正文可能超过输出上限。因此每次响应
 * 都做运行时窄校验，缺字段、类型不符或未知枚举一律 fail closed；结果再按三值语义归类，能证明没有副作用
 * 的失败才是 `rejected`，不能证明的保持 `unknown`，交给调用方用同一 OperationId 对账（D3）。
 *
 * adapter 不保存凭据，也不把 env 的内容写进错误消息：只带回 stderr 的有界片段，够定位问题即可。
 * 实现只使用标准库与既有进程边界，不新增依赖。
 */

import type { EntityRef } from '../../application/dto/identity.js';
import type {
  IssueTrackerGateway,
  TrackerIssue,
  TrackerIssueState,
  TrackerReadOutcome,
  TrackerWriteOutcome,
} from '../../application/planning/route-map-service.js';
import {
  DEFAULT_OUTPUT_LIMITS,
  runProcess,
  type OutputLimits,
  type ProcessResult,
  type ProcessRunner,
  type ProcessStream,
} from '../orca-cli/process-runner.js';

const DEFAULT_EXECUTABLE = 'gh';
const DEFAULT_TIMEOUT_MS = 20_000;

/** 错误消息里 stderr 片段的上限：够定位问题，又不把整段输出或其中的值带出去。 */
const ERROR_SNIPPET_LIMIT = 200;

/** 只有这两种 tracker 引用会触发 `gh` 命令；其余类型在构造 argv 之前就拒绝。 */
const SUPPORTED_REF_KINDS: ReadonlySet<string> = new Set(['decision-ticket', 'route-map']);

const NOT_FOUND_MARKERS: readonly string[] = ['could not resolve to an issue', 'not found'];

/** `gh` 在授权/权限不足时的 stderr 词表；命中即视为可证明未生效。 */
const AUTHORIZATION_MARKERS: readonly string[] = ['authentication', 'auth', 'http 401', 'http 403', 'permission'];

export type GhTrackerOptions = {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly executable?: string;
  readonly runner?: ProcessRunner;
  readonly timeoutMs?: number;
  readonly limits?: OutputLimits;
};

// ---------------------------------------------------------------------------
// 进程调用与结果分类
// ---------------------------------------------------------------------------

async function runGh(options: GhTrackerOptions, args: readonly string[]): Promise<ProcessResult> {
  const runner = options.runner ?? runProcess;
  return await runner({
    executable: options.executable ?? DEFAULT_EXECUTABLE,
    args,
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    limits: options.limits ?? DEFAULT_OUTPUT_LIMITS,
  });
}

/** 一次 `gh` 调用的归类；`completed` 之外的成员都由同一处 stderr 判定得出。 */
type GhRunOutcome =
  | { readonly kind: 'completed'; readonly stdout: ProcessStream }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unauthorized'; readonly message: string }
  | { readonly kind: 'unreachable'; readonly message: string }
  | { readonly kind: 'indeterminate'; readonly reason: 'timeout' | 'cancelled' }
  | { readonly kind: 'failed'; readonly reason: string };

type GhRunFailure = Exclude<GhRunOutcome, { readonly kind: 'completed' }>;

function boundedSnippet(text: string): string {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  return normalized.length === 0 ? '(stderr 为空)' : normalized.slice(0, ERROR_SNIPPET_LIMIT);
}

function matchesAny(haystack: string, markers: readonly string[]): boolean {
  return markers.some((marker) => haystack.includes(marker));
}

/**
 * 退出码与 stderr 的唯一判定点：读、写路径都消费同一个归类，不各自复写字符串匹配。
 *
 * 顺序固定：先认「issue 不存在」，再认授权/权限错误，最后才是无从判断的普通失败。大小写不敏感。
 */
function classifyGhRun(result: ProcessResult): GhRunOutcome {
  if (result.kind === 'unavailable') {
    return { kind: 'unreachable', message: result.message };
  }
  if (result.kind === 'unknown') {
    return { kind: 'indeterminate', reason: result.reason };
  }
  if (result.exitCode === 0) {
    return { kind: 'completed', stdout: result.stdout };
  }
  const stderr = result.stderr.text.toLowerCase();
  const snippet = boundedSnippet(result.stderr.text);
  if (matchesAny(stderr, NOT_FOUND_MARKERS)) {
    return { kind: 'not_found' };
  }
  if (matchesAny(stderr, AUTHORIZATION_MARKERS)) {
    return { kind: 'unauthorized', message: `gh 授权/权限错误（退出码 ${result.exitCode}）：${snippet}` };
  }
  return { kind: 'failed', reason: `gh 退出码 ${result.exitCode}：${snippet}` };
}

function readFailure(failure: GhRunFailure): TrackerReadOutcome {
  switch (failure.kind) {
    case 'not_found':
      return { kind: 'not_found' };
    case 'unauthorized':
      return { kind: 'unavailable', message: failure.message };
    case 'unreachable':
      return { kind: 'unavailable', message: failure.message };
    case 'indeterminate':
      return { kind: 'unknown', reason: failure.reason };
    case 'failed':
      return { kind: 'unavailable', message: failure.reason };
  }
}

function writeFailure(failure: GhRunFailure): TrackerWriteOutcome {
  switch (failure.kind) {
    // gh 无法解析到该 issue 时写入没有生效，但规范只为读操作规定了 not_found 语义；写路径保守归 unknown。
    case 'not_found':
      return { kind: 'unknown', reason: 'gh 报告 issue 不存在，写路径不据此断言结果' };
    case 'unauthorized':
      return { kind: 'rejected', code: 'unauthorized', message: failure.message };
    // 进程没能启动：命令从未抵达 gh，因此可以证明没有副作用，归 rejected 而不是 unknown。
    case 'unreachable':
      return { kind: 'rejected', code: 'spawn_failed', message: failure.message };
    case 'indeterminate':
      return { kind: 'unknown', reason: failure.reason };
    case 'failed':
      return { kind: 'unknown', reason: failure.reason };
  }
}

/**
 * `gh` 的写命令没有稳定的请求凭据：stdout 能解析出顶层字符串 `id` 就顺手带上，解析不出也不影响结果，
 * 更不能因为读不出 id 而把一次成功写入判失败。
 */
function readRequestId(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{')) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  const record = readRecord(value);
  const requestId = record === undefined ? null : readString(record, 'id');
  return requestId ?? undefined;
}

function writeOutcome(classification: GhRunOutcome): TrackerWriteOutcome {
  if (classification.kind !== 'completed') {
    return writeFailure(classification);
  }
  const requestId = readRequestId(classification.stdout.text);
  return requestId === undefined ? { kind: 'accepted' } : { kind: 'accepted', requestId };
}

// ---------------------------------------------------------------------------
// 窄校验器
// ---------------------------------------------------------------------------

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' ? value : null;
}

function readArray(source: Record<string, unknown>, key: string): readonly unknown[] | null {
  const value = source[key];
  return Array.isArray(value) ? value : null;
}

/** 只接受安全正整数：`number` 是票据在 GitHub 上的真实编号，0 或小数都不是。 */
function readPositiveInteger(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function readState(raw: string | null): TrackerIssueState | null {
  if (raw === 'OPEN') {
    return 'open';
  }
  if (raw === 'CLOSED') {
    return 'closed';
  }
  return null;
}

/** 解析 `gh issue view --json ...` 的输出；任何形状不符都 fail closed，绝不半信半疑地读。 */
function parseIssue(ref: EntityRef<string>, stdout: string): TrackerReadOutcome {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    return { kind: 'unknown', reason: 'gh issue view 的标准输出不是合法 JSON' };
  }
  const record = readRecord(value);
  if (record === undefined) {
    return { kind: 'unknown', reason: 'gh issue view 的输出不是 JSON 对象' };
  }
  if (readPositiveInteger(record, 'number') === null) {
    return { kind: 'unknown', reason: 'gh issue view 的 number 不是正整数' };
  }
  const title = readString(record, 'title');
  if (title === null) {
    return { kind: 'unknown', reason: 'gh issue view 缺少字符串 title' };
  }
  const body = readString(record, 'body');
  if (body === null) {
    return { kind: 'unknown', reason: 'gh issue view 缺少字符串 body' };
  }
  const state = readState(readString(record, 'state'));
  if (state === null) {
    return { kind: 'unknown', reason: 'gh issue view 的 state 不是 OPEN 或 CLOSED' };
  }
  const rawAssignees = readArray(record, 'assignees');
  if (rawAssignees === null) {
    return { kind: 'unknown', reason: 'gh issue view 缺少 assignees 数组' };
  }
  const assignees: string[] = [];
  for (const raw of rawAssignees) {
    const entry = readRecord(raw);
    const login = entry === undefined ? null : readString(entry, 'login');
    if (login === null) {
      return { kind: 'unknown', reason: 'gh issue view 的 assignees 条目缺少字符串 login' };
    }
    assignees.push(login);
  }
  const issue: TrackerIssue = { ref, title, body, state, assignees };
  return { kind: 'read', issue };
}

// ---------------------------------------------------------------------------
// IssueTrackerGateway
// ---------------------------------------------------------------------------

const UNSUPPORTED_REF_CODE = 'unsupported_ref';

export async function readIssue(options: GhTrackerOptions, ref: EntityRef<string>): Promise<TrackerReadOutcome> {
  if (!SUPPORTED_REF_KINDS.has(ref.kind)) {
    return { kind: 'unknown', reason: `不支持的 tracker 引用类型 ${ref.kind}` };
  }
  const classification = classifyGhRun(
    await runGh(options, ['issue', 'view', ref.id, '--json', 'number,title,body,state,assignees']),
  );
  if (classification.kind !== 'completed') {
    return readFailure(classification);
  }
  if (classification.stdout.truncated) {
    // 被截断的 JSON 无法证明内容完整，也不能假装读取成功。
    return { kind: 'unknown', reason: '输出被截断' };
  }
  return parseIssue(ref, classification.stdout.text);
}

export async function updateIssueBody(
  options: GhTrackerOptions,
  input: { readonly ref: EntityRef<string>; readonly body: string },
): Promise<TrackerWriteOutcome> {
  if (!SUPPORTED_REF_KINDS.has(input.ref.kind)) {
    return { kind: 'rejected', code: UNSUPPORTED_REF_CODE, message: `不支持的 tracker 引用类型 ${input.ref.kind}` };
  }
  // body 作为 argv 的一个元素传入；runProcess 的 stdio 不带 stdin，不能改用 --body-file -。
  return writeOutcome(classifyGhRun(await runGh(options, ['issue', 'edit', input.ref.id, '--body', input.body])));
}

/** 读操作失败在写路径上的映射：没有写命令发出，可证明未生效的失败是 rejected。 */
function readFailureOnWrite(failure: TrackerReadOutcome): TrackerWriteOutcome {
  switch (failure.kind) {
    case 'read':
      return { kind: 'unknown', reason: '读操作意外返回成功，写路径无法继续' };
    case 'not_found':
      return { kind: 'unknown', reason: '票据不存在，未发出写入命令' };
    case 'unavailable':
      return { kind: 'rejected', code: 'unavailable', message: failure.message };
    case 'unknown':
      return { kind: 'unknown', reason: failure.reason };
  }
}

function describeWriteFailure(outcome: TrackerWriteOutcome): string {
  if (outcome.kind === 'rejected') {
    return `${outcome.code}: ${outcome.message}`;
  }
  return outcome.kind === 'unknown' ? outcome.reason : 'accepted';
}

export async function assignIssue(
  options: GhTrackerOptions,
  input: { readonly ref: EntityRef<string>; readonly assignee: string | null },
): Promise<TrackerWriteOutcome> {
  if (!SUPPORTED_REF_KINDS.has(input.ref.kind)) {
    return { kind: 'rejected', code: UNSUPPORTED_REF_CODE, message: `不支持的 tracker 引用类型 ${input.ref.kind}` };
  }
  if (input.assignee !== null) {
    return writeOutcome(
      classifyGhRun(await runGh(options, ['issue', 'edit', input.ref.id, '--add-assignee', input.assignee])),
    );
  }

  // `gh` 只接受具体 login，因此先读当前 assignees；为空时一次写入都不发。
  const current = await readIssue(options, input.ref);
  if (current.kind !== 'read') {
    return readFailureOnWrite(current);
  }
  if (current.issue.assignees.length === 0) {
    return { kind: 'accepted' };
  }

  let removed = 0;
  for (const login of current.issue.assignees) {
    const outcome = writeOutcome(
      classifyGhRun(await runGh(options, ['issue', 'edit', input.ref.id, '--remove-assignee', login])),
    );
    if (outcome.kind === 'accepted') {
      removed += 1;
      continue;
    }
    if (removed > 0) {
      // 已经部分生效：结果不再完整，不能当作确定失败。
      return {
        kind: 'unknown',
        reason: `已移除 ${removed} 个 assignee 后移除 ${login} 失败：${describeWriteFailure(outcome)}`,
      };
    }
    // 一个都没成功，按退出码分类原样返回。
    return outcome;
  }
  return { kind: 'accepted' };
}

export function createGhTracker(options: GhTrackerOptions): IssueTrackerGateway {
  return {
    readIssue: async (ref) => await readIssue(options, ref),
    updateIssueBody: async (input) => await updateIssueBody(options, input),
    assignIssue: async (input) => await assignIssue(options, input),
  };
}
