/**
 * IP-08：Scope 之前的 Route Map 初始化窄端口（Owner: simplify-ledger-lab-lifecycle IP-08）。
 *
 * 首次配置时还没有 Coordination Scope，用户却已经要决定「用哪张 Route Map issue」。这条路径只回答
 * 三件事：仓库里有哪些候选、用户选定的那张是否真的是 Route Map、以及创建一张只含空章节的地图。
 * 它不创建 Scope、不写 Route Map 章节、不认识 Coordinator Session，也不进入 Coordinator 工具面——
 * 模型看不到这个端口。
 *
 * 创建遵守一次外部副作用的完整纪律：先在 Git common dir 的 Companion 私有目录按完整 branch ref 落盘
 * 稳定操作身份与目标，再调用 tracker。结果不明时标记保持未决；之后的创建只用同一个标记做有界对账，
 * 绝不换身份再发一次创建。对账无法证明原 issue 是否存在时，返回结构化错误请用户直接选择原 issue，
 * 而不是重复创建（AGENTS §8 的 unknown 纪律）。
 */

import {
  ROUTE_MAP_SECTIONS,
  ROUTE_MAP_SECTION_HEADINGS,
  type RouteMapSection,
} from '../../domain/planning/route-map.js';

/** 新建地图的默认标题。 */
export const ROUTE_MAP_ISSUE_TITLE = 'Route Map';

/** 候选列表与有界对账共用的上限；结果触顶时不能据此证明某个 issue 不存在。 */
export const ROUTE_MAP_LIST_LIMIT = 20;

/**
 * 可信仓库身份的形态：owner/repo。
 *
 * 它必须是装配层从 gh repo view 解析出的精确身份，而不是用户输入的远端字符串；命令一律带
 * --repo，不依赖 cwd 推断出的远端。
 */
export const ROUTE_MAP_REPOSITORY_PATTERN = /^[^/\s]+\/[^/\s]+$/;

export function isRouteMapRepository(value: string): boolean {
  return typeof value === 'string' && ROUTE_MAP_REPOSITORY_PATTERN.test(value);
}

const HEADING_LINE = /^##[ \t]+(.+?)[ \t]*$/;

// ---------------------------------------------------------------------------
// 对外结果
// ---------------------------------------------------------------------------

export type RouteMapCandidate = {
  readonly number: number;
  readonly title: string;
  readonly url: string;
};

export type RouteMapTarget = {
  readonly number: number;
  readonly url: string;
};

export type RouteMapInitializationFailureCode =
  | 'invalid_request'
  | 'not_found'
  | 'not_route_map'
  | 'tracker_unavailable'
  | 'target_mismatch'
  | 'create_unresolved'
  | 'record_conflict'
  | 'record_unavailable';

export type RouteMapInitializationResult<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'failed'; readonly code: RouteMapInitializationFailureCode; readonly message: string };

/** 启动配置流程使用的窄端口；issue 编号随后由项目配置保存，本端口不持有任何 Scope 身份。 */
export interface RouteMapInitializationPort {
  /** 目标仓库中的有界候选，最多 ROUTE_MAP_LIST_LIMIT 项。 */
  list(): Promise<RouteMapInitializationResult<readonly RouteMapCandidate[]>>;
  /** 选定既有 issue：必须是精确仓库里的 issue，且正文具备领域定义的固定章节结构。 */
  select(number: number): Promise<RouteMapInitializationResult<RouteMapTarget>>;
  /** 创建一张只含空章节的 Route Map；结果不明时只对账，不再创建。 */
  create(): Promise<RouteMapInitializationResult<RouteMapTarget>>;
}

// ---------------------------------------------------------------------------
// 领域侧的正文规则
// ---------------------------------------------------------------------------

/** 空地图正文：六个章节标题，没有任何业务内容。 */
export function emptyRouteMapBody(): string {
  return ROUTE_MAP_SECTIONS.map((section) => '## ' + ROUTE_MAP_SECTION_HEADINGS[section]).join('\n\n');
}

/**
 * 正文里缺失的章节，按领域顺序返回。
 *
 * 领域解析把「章节为空」与「章节不存在」都读成空串，因此判定一张 issue 是不是 Route Map 只能看章节
 * 标题是否齐全；标题表是领域模块导出的唯一事实源，这里不再复写一份。
 */
export function missingRouteMapSections(body: string): readonly RouteMapSection[] {
  const headings = new Set<string>();
  for (const line of body.split('\n')) {
    const match = HEADING_LINE.exec(line);
    if (match !== null) {
      headings.add((match[1] ?? '').trim().toLowerCase());
    }
  }
  return ROUTE_MAP_SECTIONS.filter(
    (section) => !headings.has(ROUTE_MAP_SECTION_HEADINGS[section].toLowerCase()),
  );
}

// ---------------------------------------------------------------------------
// 内部接缝
// ---------------------------------------------------------------------------

export type RouteMapIssueBody = RouteMapCandidate & { readonly body: string };
export type RouteMapInitializationCandidate = RouteMapIssueBody;

export type RouteMapTrackerFailureCode = 'unauthorized' | 'unreachable' | 'unknown' | 'not_found' | 'malformed';

export type RouteMapTrackerResult<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'failed'; readonly code: RouteMapTrackerFailureCode; readonly message: string };

/** 有界候选查询；exhaustive 为 false 表示结果集触到上限，因此无法证明某个 issue 不存在。 */
export type RouteMapCandidateList = {
  readonly candidates: readonly RouteMapInitializationCandidate[];
  readonly exhaustive: boolean;
};

/** tracker 接缝只覆盖这三个动作；Companion 不接受任意 gh 命令或凭据。 */
export interface RouteMapTrackerBackend {
  listCandidates(): Promise<RouteMapTrackerResult<{ readonly candidates: readonly RouteMapInitializationCandidate[]; readonly exhaustive: boolean }>>;
  readIssue(number: number): Promise<RouteMapTrackerResult<RouteMapIssueBody>>;
  createIssue(input: { readonly title: string; readonly body: string }): Promise<RouteMapTrackerResult<RouteMapTarget>>;
}

/**
 * 未决的创建记录。issue 为 null 表示「已经发出过一次创建，但结果不明」：此后只允许对账同一个操作。
 */
export type RouteMapInitializationRecord = {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly operationId: string;
  readonly repository: string;
  readonly fullBranchRef: string;
  readonly title: string;
  readonly issue: RouteMapTarget | null;
};

/** 记录接缝按完整 branch ref 隔离仓库内的创建身份；它不是通用状态机，只有创建流程使用它。 */
export interface RouteMapInitializationRecordStore {
  read(): RouteMapInitializationResult<RouteMapInitializationRecord | null>;
  /** 只在没有任何记录时落盘；并发写者按冲突拒绝，不覆盖别人的未决标记。 */
  begin(input: {
    readonly repository: string;
    readonly fullBranchRef: string;
    readonly title: string;
  }): RouteMapInitializationResult<RouteMapInitializationRecord>;
  recordIssue(input: {
    readonly operationId: string;
    readonly expectedRevision: number;
    readonly issue: RouteMapTarget;
  }): RouteMapInitializationResult<RouteMapInitializationRecord>;
  /** 只在可证明没有副作用时清除未决标记，让下一次用户显式创建从新操作开始。 */
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

const FAILURE_MESSAGES = {
  invalid_request: 'issue 编号必须是正整数',
  not_found: '该 issue 在目标仓库中不存在',
  not_route_map: '该 issue 不符合 Route Map 的固定章节结构',
  tracker_unavailable: '无法访问 issue tracker',
  target_mismatch: '已记录的 Route Map 创建目标与当前仓库或分支不一致',
  create_unresolved: '存在结果不明的 Route Map 创建尝试，无法证明原 issue 是否已创建',
  record_conflict: 'Route Map 初始化记录已被其他写者更新',
  record_unavailable: 'Route Map 初始化记录不可用',
} satisfies Record<RouteMapInitializationFailureCode, string>;

function ok<T>(value: T): RouteMapInitializationResult<T> {
  return { kind: 'ok', value };
}

function failed<T>(code: RouteMapInitializationFailureCode, detail?: string): RouteMapInitializationResult<T> {
  const message = FAILURE_MESSAGES[code];
  return {
    kind: 'failed',
    code,
    message: detail === undefined || detail.length === 0 ? message : message + '（' + detail + '）',
  };
}

function isIssueNumber(value: number): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isTargetUrl(url: string, repository: string): boolean {
  return url.startsWith('https://github.com/' + repository + '/issues/') &&
    /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/[1-9]\d*$/.test(url);
}

export type RouteMapInitializationDependencies = {
  /** 可信目标仓库，形如 owner/repo；命令不依赖 cwd 推断远端。 */
  readonly repository: string;
  /** 可信完整 branch ref，例如 refs/heads/main；记录按它隔离。 */
  readonly fullBranchRef: string;
  readonly backend: RouteMapTrackerBackend;
  readonly records: RouteMapInitializationRecordStore;
};

export function createRouteMapInitializationPort(
  deps: RouteMapInitializationDependencies,
): RouteMapInitializationPort {
  const { repository, fullBranchRef, backend, records } = deps;

  return {
    async list(): Promise<RouteMapInitializationResult<readonly RouteMapCandidate[]>> {
      const listed = await backend.listCandidates();
      return listed.kind === 'ok'
        ? ok(listed.value.candidates.slice(0, ROUTE_MAP_LIST_LIMIT).map(({ number, title, url }) => ({ number, title, url })))
        : failed('tracker_unavailable', listed.message);
    },

    async select(number: number): Promise<RouteMapInitializationResult<RouteMapTarget>> {
      if (!isIssueNumber(number)) {
        return failed('invalid_request');
      }
      const read = await backend.readIssue(number);
      if (read.kind === 'failed') {
        return read.code === 'not_found' ? failed('not_found') : failed('tracker_unavailable', read.message);
      }
      if (read.value.number !== number) {
        return failed('target_mismatch', 'tracker 返回的 issue 身份与请求不一致');
      }
      if (!isTargetUrl(read.value.url, repository)) return failed('target_mismatch');
      const missing = missingRouteMapSections(read.value.body);
      if (missing.length > 0) {
        return failed(
          'not_route_map',
          '缺少章节 ' + missing.map((section) => ROUTE_MAP_SECTION_HEADINGS[section]).join('、'),
        );
      }
      const target = { number: read.value.number, url: read.value.url };
      const current = records.read();
      if (current.kind === 'failed') return current;
      if (current.value !== null && current.value.issue === null) {
        const settled = records.recordIssue({
          operationId: current.value.operationId,
          expectedRevision: current.value.revision,
          issue: target,
        });
        if (settled.kind === 'failed') return failed('record_conflict', settled.message);
      }
      return ok(target);
    },

    async create(): Promise<RouteMapInitializationResult<RouteMapTarget>> {
      const current = records.read();
      if (current.kind === 'failed') {
        return current;
      }
      let record = current.value;
      if (record === null) {
        const begun = records.begin({ repository, fullBranchRef, title: ROUTE_MAP_ISSUE_TITLE });
        if (begun.kind === 'failed') {
          return begun;
        }
        record = begun.value;
      } else {
        // 记录属于别的仓库或分支时不做任何写入：复制来的 Git 目录不能改写别处的未决标记。
        if (record.repository !== repository || record.fullBranchRef !== fullBranchRef) {
          return failed('target_mismatch');
        }
        if (record.issue !== null) {
          const currentIssue = await backend.readIssue(record.issue.number);
          if (currentIssue.kind !== 'ok' || currentIssue.value.number !== record.issue.number ||
              currentIssue.value.url !== record.issue.url || !isTargetUrl(currentIssue.value.url, repository) ||
              missingRouteMapSections(currentIssue.value.body).length > 0) {
            return failed('create_unresolved', currentIssue.kind === 'failed' ? currentIssue.message : undefined);
          }
          return ok(record.issue);
        }
        const listed = await backend.listCandidates();
        if (listed.kind === 'failed') return failed('create_unresolved', listed.message);
        const marker = '<!-- orca-companion-route-map-operation:' + record.operationId + ' -->';
        const matches = listed.value.candidates.slice(0, ROUTE_MAP_LIST_LIMIT)
          .filter((candidate) => candidate.body.includes(marker) && isTargetUrl(candidate.url, repository));
        if (matches.length !== 1) return failed('create_unresolved');
        const match = matches[0]!;
        if (missingRouteMapSections(match.body).length > 0) return failed('create_unresolved');
        const settled = records.recordIssue({
          operationId: record.operationId,
          expectedRevision: record.revision,
          issue: { number: match.number, url: match.url },
        });
        if (settled.kind === 'failed') return failed('create_unresolved', settled.message);
        return ok({ number: match.number, url: match.url });
      }

      // 标记已经落盘：现在才允许发出唯一一次创建命令。
      const marker = '<!-- orca-companion-route-map-operation:' + record.operationId + ' -->';
      const created = await backend.createIssue({ title: record.title, body: emptyRouteMapBody() + '\n\n' + marker });
      if (created.kind === 'ok') {
        if (!isTargetUrl(created.value.url, repository)) return failed('create_unresolved');
        const settled = records.recordIssue({
          operationId: record.operationId,
          expectedRevision: record.revision,
          issue: created.value,
        });
        // 记录不下来只说明本机没写进去，issue 已经存在于 tracker：不能假装没创建过。
        if (settled.kind === 'failed') return failed('create_unresolved', settled.message);
        const verified = await backend.readIssue(created.value.number);
        if (verified.kind !== 'ok' || verified.value.number !== created.value.number ||
            verified.value.url !== created.value.url || !verified.value.body.includes(marker) ||
            missingRouteMapSections(verified.value.body).length > 0) return failed('create_unresolved');
        return ok(created.value);
      }
      if (created.code === 'unauthorized' || created.code === 'unreachable') {
        // 仅这些 adapter 结果能证明请求未启动或被明确拒绝。
        return failed('tracker_unavailable', created.message);
      }
      return failed('create_unresolved', created.message);
    },
  };
}
