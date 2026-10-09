/**
 * IP-03 / D-05：有界只读调试工具的应用端口（Owner: 本 change 的 debug read tools）。
 *
 * 这是 workflow 与真实文件系统之间唯一的契约。端口只声明「一次有界只读调用能做什么、
 * 预算多大、失败怎么表达」，不含任何实现知识：workflow 不认识 `fs` 与 `git`，adapter 也不认识
 * 工具 schema 与模型。两个方向因此各自收敛，改预算不需要改调用方，改 schema 不需要碰磁盘。
 *
 * 结果用 `accepted` / `rejected` 表达而不是抛出：调试工具没有副作用，超时、取消、越界都不是
 * 「结果未知」，不需要走 mutation 的 OperationId 对账。
 */

export type DebugReadResult<T> =
  | { readonly kind: 'accepted'; readonly value: T }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string };

/** 一次调用的可取消性；宿主把 invoke 的 signal 透传进来。 */
export type DebugReadRequest = { readonly signal?: AbortSignal | undefined };

/**
 * 处理量与时间预算。
 *
 * `maxReadBytes` 与 `maxScanBytes` 分开，是因为「单文件读多少」和「一次调用一共读多少」是两个
 * 独立的风险面：前者限制单个结果的大小，后者限制宽目录扫描的总代价。
 */
export type DebugReadLimits = {
  /** 单个文件读取的字节上限。 */
  readonly maxReadBytes: number;
  /** 目录遍历与搜索扫描的条目上限。 */
  readonly maxEntries: number;
  /** 搜索返回的命中行上限。 */
  readonly maxMatches: number;
  /** 搜索一次调用跨所有文件读取的字节上限。 */
  readonly maxScanBytes: number;
  /** 单一工具结果文本的字节上限。 */
  readonly outputMaxBytes: number;
  /** 一次调用的墙钟预算。 */
  readonly timeoutMs: number;
};

export const DEFAULT_DEBUG_READ_LIMITS: DebugReadLimits = {
  maxReadBytes: 64 * 1024,
  maxEntries: 500,
  maxMatches: 100,
  maxScanBytes: 4 * 1024 * 1024,
  outputMaxBytes: 256 * 1024,
  timeoutMs: 10_000,
};

export type DebugReadFileMatch = { readonly path: string; readonly line: number; readonly text: string };

export type DebugReadListFilesInput = { readonly path?: string };
export type DebugReadListFilesValue = { readonly files: readonly string[]; readonly truncated: boolean };

export type DebugReadFileInput = { readonly path: string };
export type DebugReadFileValue = { readonly path: string; readonly content: string; readonly truncated: boolean };

export type DebugReadSearchInput = { readonly pattern: string; readonly path?: string };
export type DebugReadSearchValue = {
  readonly matches: readonly DebugReadFileMatch[];
  readonly scanned: number;
  readonly truncated: boolean;
};

export type DebugReadDiffInput = { readonly path?: string; readonly staged?: boolean };
export type DebugReadDiffValue = { readonly diff: string; readonly truncated: boolean };

export type DebugReadServices = {
  readonly listFiles: (
    input: DebugReadListFilesInput,
    request?: DebugReadRequest,
  ) => Promise<DebugReadResult<DebugReadListFilesValue>>;
  readonly readFile: (
    input: DebugReadFileInput,
    request?: DebugReadRequest,
  ) => Promise<DebugReadResult<DebugReadFileValue>>;
  readonly search: (
    input: DebugReadSearchInput,
    request?: DebugReadRequest,
  ) => Promise<DebugReadResult<DebugReadSearchValue>>;
  readonly gitDiff: (
    input: DebugReadDiffInput,
    request?: DebugReadRequest,
  ) => Promise<DebugReadResult<DebugReadDiffValue>>;
};
