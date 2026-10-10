/**
 * IP-08：Route Map 初始化的 GitHub tracker adapter 与生产工厂
 * （Owner: simplify-ledger-lab-lifecycle IP-08）。
 *
 * 这里只做三件事：按精确的 owner/repo 读候选、读一张 issue、创建一张 issue。目标仓库由装配层用公开的
 * gh repo view 解析后注入，命令一律带 --repo，不靠 cwd 推断远端；调用以参数数组交给既有进程边界，
 * 不经 shell，也不拼接命令字符串。adapter 不保存凭据，错误只带回 stderr 的有界片段。
 *
 * 读路径与创建路径的失败语义故意不同：读失败没有副作用可对账，一律「tracker 不可用」；创建失败只有
 * 进程没起来或被明确拒绝才能证明没有副作用，其它一切都归 unknown，交给应用层保留未决标记。
 *
 * 生产工厂把 tracker 接缝与记录 store 装成窄端口；bootstrap 只需要一次调用，不需要知道内部形状。
 */

import {
  DEFAULT_OUTPUT_LIMITS,
  runProcess,
  type OutputLimits,
  type ProcessResult,
  type ProcessRunner,
  type ProcessStream,
} from '../orca-cli/process-runner.js';
import { createRouteMapInitializationRecordStore } from '../storage/route-map-initialization.js';
import {
  createRouteMapInitializationPort,
  isRouteMapRepository,
  ROUTE_MAP_LIST_LIMIT,
  type RouteMapCandidate,
  type RouteMapCandidateList,
  type RouteMapInitializationPort,
  type RouteMapIssueBody,
  type RouteMapTarget,
  type RouteMapTrackerBackend,
  type RouteMapTrackerResult,
} from '../../application/planning/route-map-initialization.js';

const DEFAULT_EXECUTABLE = 'gh';
const DEFAULT_TIMEOUT_MS = 20_000;

/** stderr 片段上限：够定位问题，又不把整段输出带进错误消息。 */
const ERROR_SNIPPET_LIMIT = 200;

const NOT_FOUND_MARKERS: readonly string[] = ['could not resolve', 'not found'];
const AUTHORIZATION_MARKERS: readonly string[] = ['authentication', 'http 401', 'http 403', 'permission'];

export type GhRouteMapInitializationOptions = {
  /** 形如 owner/repo 的精确目标；由 readRepositoryIdentity 解析，不是用户输入。 */
  readonly repository: string;
  /** 完整 branch ref，例如 refs/heads/main；记录按它隔离。 */
  readonly fullBranchRef: string;
  readonly gitCommonDir: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** 缺省为 gh。 */
  readonly ghCommand?: string;
  /** 缺省为 runProcess；测试注入自己的进程边界。 */
  readonly runner?: ProcessRunner;
  readonly timeoutMs?: number;
  readonly limits?: OutputLimits;
};

export type RepositoryIdentity = {
  readonly owner: string;
  readonly repo: string;
  readonly nameWithOwner: string;
};

// ---------------------------------------------------------------------------
// 进程调用与结果分类
// ---------------------------------------------------------------------------

type GhCall =
  | { readonly kind: 'completed'; readonly stdout: ProcessStream }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unauthorized'; readonly message: string }
  | { readonly kind: 'unreachable'; readonly message: string }
  | { readonly kind: 'unknown'; readonly message: string };

/** 进程边界只需要这几项；解析仓库身份因此不必先构造一个完整的初始化选项。 */
type GhInvocationOptions = Pick<
  GhRouteMapInitializationOptions,
  'cwd' | 'env' | 'ghCommand' | 'runner' | 'timeoutMs' | 'limits'
>;

async function runGh(options: GhInvocationOptions, args: readonly string[]): Promise<ProcessResult> {
  const runner = options.runner ?? runProcess;
  return await runner({
    executable: options.ghCommand ?? DEFAULT_EXECUTABLE,
    args,
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    limits: options.limits ?? DEFAULT_OUTPUT_LIMITS,
  });
}

function boundedSnippet(text: string): string {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  return normalized.length === 0 ? '(stderr 为空)' : normalized.slice(0, ERROR_SNIPPET_LIMIT);
}

function matchesAny(haystack: string, markers: readonly string[]): boolean {
  return markers.some((marker) => haystack.includes(marker));
}

/**
 * 读路径的归类：没有副作用可对账，因此除「issue 不存在」外一切都归不可用，用户可显式重试。
 *
 * 截断的输出无法证明内容完整，按 unknown 处理而不是假装读到。
 */
function classifyRead(result: ProcessResult): GhCall {
  if (result.kind === 'unavailable') {
    return { kind: 'unreachable', message: result.message };
  }
  if (result.kind === 'unknown') {
    return { kind: 'unknown', message: 'gh 调用超时或被取消' };
  }
  if (result.exitCode === 0) {
    return result.stdout.truncated
      ? { kind: 'unknown', message: 'gh 输出被截断' }
      : { kind: 'completed', stdout: result.stdout };
  }
  const stderr = result.stderr.text.toLowerCase();
  const snippet = boundedSnippet(result.stderr.text);
  if (matchesAny(stderr, NOT_FOUND_MARKERS)) {
    return { kind: 'not_found' };
  }
  if (matchesAny(stderr, AUTHORIZATION_MARKERS)) {
    return { kind: 'unauthorized', message: 'gh 授权/权限错误：' + snippet };
  }
  return { kind: 'unreachable', message: 'gh 退出码 ' + String(result.exitCode) + '：' + snippet };
}

/**
 * 创建路径的归类：只有进程没起来或被明确拒绝才能证明没有副作用，其余一律 unknown。
 *
 * 这是整套纪律里唯一不能乐观的地方——一次不确定的创建必须留给应用层对账，而不是自动重发。
 */
function classifyCreate(result: ProcessResult): GhCall {
  if (result.kind === 'unavailable') {
    return { kind: 'unreachable', message: result.message };
  }
  if (result.kind === 'unknown') {
    return { kind: 'unknown', message: 'gh 创建调用超时或被取消，无法证明是否已创建' };
  }
  if (result.exitCode === 0) {
    return result.stdout.truncated
      ? { kind: 'unknown', message: 'gh 输出被截断' }
      : { kind: 'completed', stdout: result.stdout };
  }
  const stderr = result.stderr.text.toLowerCase();
  const snippet = boundedSnippet(result.stderr.text);
  return matchesAny(stderr, AUTHORIZATION_MARKERS)
    ? { kind: 'unauthorized', message: 'gh 授权/权限错误：' + snippet }
    : { kind: 'unknown', message: 'gh 退出码 ' + String(result.exitCode) + '：' + snippet };
}

// ---------------------------------------------------------------------------
// 窄校验器
// ---------------------------------------------------------------------------

function parseJsonObject(text: string): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch {
    return null;
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function issueNumberField(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function parseCandidate(value: unknown): RouteMapCandidate | null {
  const record =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  if (record === null) {
    return null;
  }
  const number = issueNumberField(record, 'number');
  const title = stringField(record, 'title');
  const url = stringField(record, 'url');
  return number === null || title === null || url === null ? null : { number, title, url };
}

function failure<T>(call: Exclude<GhCall, { readonly kind: 'completed' }>): RouteMapTrackerResult<T> {
  switch (call.kind) {
    case 'not_found':
      return { kind: 'failed', code: 'not_found', message: 'issue 不存在' };
    case 'unauthorized':
      return { kind: 'failed', code: 'unauthorized', message: call.message };
    case 'unreachable':
      return { kind: 'failed', code: 'unreachable', message: call.message };
    case 'unknown':
      return { kind: 'failed', code: 'unknown', message: call.message };
  }
}

function ok<T>(value: T): RouteMapTrackerResult<T> {
  return { kind: 'ok', value };
}

// ---------------------------------------------------------------------------
// RouteMapTrackerBackend
// ---------------------------------------------------------------------------

export function createGhRouteMapBackend(options: GhRouteMapInitializationOptions): RouteMapTrackerBackend {
  const { repository } = options;
  // 精确目标：创建后的核验也必须落在同一仓库，因此可接受的 URL 形态在这一处固定下来。
  const issueUrlPrefix = 'https://github.com/' + repository + '/issues/';

  return {
    async listCandidates(): Promise<RouteMapTrackerResult<RouteMapCandidateList>> {
      const call = classifyRead(
        await runGh(options, [
          'issue',
          'list',
          '--repo',
          repository,
          '--state',
          'open',
          '--json',
          'number,title,url,body',
          '--limit',
          String(ROUTE_MAP_LIST_LIMIT),
        ]),
      );
      if (call.kind !== 'completed') {
        return failure(call);
      }
      let value: unknown;
      try {
        value = JSON.parse(call.stdout.text.trim());
      } catch {
        return { kind: 'failed', code: 'malformed', message: 'gh issue list 的输出不是合法 JSON' };
      }
      if (!Array.isArray(value)) {
        return { kind: 'failed', code: 'malformed', message: 'gh issue list 的输出不是数组' };
      }
      const candidates: (RouteMapCandidate & { readonly body: string })[] = [];
      for (const entry of value) {
        const candidate = parseCandidate(entry);
        if (candidate === null) {
          return { kind: 'failed', code: 'malformed', message: 'gh issue list 的条目缺少 number/title/url' };
        }
        const body = typeof entry === 'object' && entry !== null && !Array.isArray(entry)
          ? (entry as Record<string, unknown>)['body']
          : null;
        if (typeof body !== 'string') {
          return { kind: 'failed', code: 'malformed', message: 'gh issue list 条目缺少 body' };
        }
        candidates.push({ ...candidate, body });
      }
      // 触到上限就无法证明某个 issue 不存在，因此如实标记结果集不完整。
      return ok({ candidates, exhaustive: candidates.length < ROUTE_MAP_LIST_LIMIT });
    },

    async readIssue(number: number): Promise<RouteMapTrackerResult<RouteMapIssueBody>> {
      const call = classifyRead(
        await runGh(options, ['issue', 'view', String(number), '--repo', repository, '--json', 'number,title,url,body']),
      );
      if (call.kind !== 'completed') {
        return failure(call);
      }
      const record = parseJsonObject(call.stdout.text);
      if (record === null) {
        return { kind: 'failed', code: 'malformed', message: 'gh issue view 的输出不是 JSON 对象' };
      }
      const readNumber = issueNumberField(record, 'number');
      const title = stringField(record, 'title');
      const url = stringField(record, 'url');
      const body = record['body'];
      if (readNumber === null || title === null || url === null || typeof body !== 'string') {
        return { kind: 'failed', code: 'malformed', message: 'gh issue view 的输出缺少 number/title/url/body' };
      }
      return ok({ number: readNumber, title, url, body });
    },

    /**
     * 创建一张 issue，并立刻用公开读命令核验它落在目标仓库且标题一致。
     *
     * 核验失败时归 unknown：issue 可能已经存在，必须交给应用层保留未决标记去对账，绝不当成没创建。
     */
    async createIssue(input: {
      readonly title: string;
      readonly body: string;
    }): Promise<RouteMapTrackerResult<RouteMapTarget>> {
      const call = classifyCreate(
        await runGh(options, [
          'issue',
          'create',
          '--repo',
          repository,
          '--title',
          input.title,
          '--body',
          input.body,
        ]),
      );
      if (call.kind !== 'completed') {
        return failure(call);
      }
      const url = call.stdout.text.trim();
      if (!url.startsWith(issueUrlPrefix)) {
        return { kind: 'failed', code: 'unknown', message: 'gh issue create 未返回目标仓库的 issue URL' };
      }
      const verified = classifyRead(await runGh(options, ['issue', 'view', url, '--json', 'number,title,url,body']));
      if (verified.kind !== 'completed') {
        return { kind: 'failed', code: 'unknown', message: '创建后无法核验新 issue' };
      }
      const record = parseJsonObject(verified.stdout.text);
      const number = record === null ? null : issueNumberField(record, 'number');
      const title = record === null ? null : stringField(record, 'title');
      const verifiedUrl = record === null ? null : stringField(record, 'url');
      const verifiedBody = record?.['body'];
      if (number === null || title !== input.title || verifiedUrl === null || !verifiedUrl.startsWith(issueUrlPrefix) ||
          typeof verifiedBody !== 'string' || verifiedBody !== input.body) {
        return { kind: 'failed', code: 'unknown', message: '创建后无法核验新 issue 的身份' };
      }
      return ok({ number, url: verifiedUrl });
    },
  };
}

// ---------------------------------------------------------------------------
// 仓库身份与生产工厂
// ---------------------------------------------------------------------------

/**
 * 用公开的 gh repo view 解析当前仓库的精确身份。
 *
 * 这是「精确目标」的唯一来源：装配层拿到 owner/repo 后注入 Route Map 端口，因此初始化流程既不需要、
 * 也不接受用户手写的远端字符串。
 */
export async function readRepositoryIdentity(
  options: GhInvocationOptions,
): Promise<
  | { readonly kind: 'ok'; readonly value: RepositoryIdentity }
  | { readonly kind: 'failed'; readonly message: string }
> {
  const call = classifyRead(await runGh(options, ['repo', 'view', '--json', 'nameWithOwner']));
  if (call.kind !== 'completed') {
    return {
      kind: 'failed',
      message: '无法解析仓库身份：' + (call.kind === 'not_found' ? '当前目录不属于任何仓库' : call.message),
    };
  }
  const record = parseJsonObject(call.stdout.text);
  const nameWithOwner = record === null ? null : stringField(record, 'nameWithOwner');
  if (nameWithOwner === null || !isRouteMapRepository(nameWithOwner)) {
    return { kind: 'failed', message: 'gh repo view 未返回 owner/repo 形态的仓库身份' };
  }
  const [owner, repo] = nameWithOwner.split('/');
  return { kind: 'ok', value: { owner: owner ?? '', repo: repo ?? '', nameWithOwner } };
}

/**
 * 生产工厂：装配 tracker 接缝与未决创建记录，产出启动配置流程使用的窄端口。
 *
 * 输入全部是可信装配输入（精确仓库身份、完整 branch ref、Git common dir、进程边界）；内部形状不对
 * 装配者直接报错，不返回一个半可用的端口。
 */
export function createGhRouteMapInitialization(options: GhRouteMapInitializationOptions): RouteMapInitializationPort {
  if (!isRouteMapRepository(options.repository)) {
    throw new Error('repository 必须是 owner/repo 形态的精确仓库身份');
  }
  if (typeof options.fullBranchRef !== 'string' || options.fullBranchRef.trim().length === 0) {
    throw new Error('fullBranchRef 不能为空');
  }
  if (typeof options.gitCommonDir !== 'string' || options.gitCommonDir.trim().length === 0) {
    throw new Error('gitCommonDir 不能为空');
  }
  return createRouteMapInitializationPort({
    repository: options.repository,
 fullBranchRef: options.fullBranchRef,
    backend: createGhRouteMapBackend(options),
    records: createRouteMapInitializationRecordStore({
      gitCommonDir: options.gitCommonDir,
      repository: options.repository,
      fullBranchRef: options.fullBranchRef,
    }),
  });
}
