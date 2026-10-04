/**
 * IC-06 / IP-A4：`SpecificationProvider` 端口（Owner: `m1-admit-work-package-specifications`）。
 *
 * 这个端口只回答两件事：某个 worktree 里的工具原生 Specification Unit 是什么，以及某个角色的工件
 * 转换是否就绪。它不写业务状态、不做 plugin registry、不解析 OpenSpec 的 artifact 图语义；M1 只有
 * 一个产品实现，注册机制属于投机设计。
 *
 * 读取失败一律以结构化拒绝表达；adapter 不得用「最近修改」「当前工作目录」或终端输出替代真实读取。
 */

import type {
  RoleTransitionQuery,
  RoleTransitionState,
  SpecificationUnitLocator,
  SpecificationUnitSnapshot,
} from '../../domain/task-contract.js';

export type SpecificationReadFailure = {
  readonly code: string;
  readonly message: string;
};

export type SpecificationReadResult<T> =
  | { readonly kind: 'read'; readonly value: T }
  | { readonly kind: 'rejected'; readonly failure: SpecificationReadFailure };

/** 原生 Specification Unit 的只读目录：一次最多一页，调用方按 `after` 游标继续。 */
export const SPECIFICATION_FILE_PAGE_SIZE = 20;

/** 单次正文读取的字节上限；超过即拒绝，而不是截断成一段看似完整的正文。 */
export const SPECIFICATION_BODY_MAX_BYTES = 64 * 1024;

/** 目录里的一条工件记录；`sourceVersion` 是不透明版本令牌，原样回传即可固定一次阅读。 */
export type SpecificationFileEntry = {
  /** change 目录内的 POSIX 相对路径。 */
  readonly path: string;
  readonly sourceVersion: string;
  readonly byteLength: number;
};

export type SpecificationFileListing = {
  readonly items: readonly SpecificationFileEntry[];
  /** 下一页游标；`null` 表示已到目录末尾。 */
  readonly nextCursor: string | null;
};

export type SpecificationFileListingQuery = {
  readonly locator: SpecificationUnitLocator;
  /** 已接纳的契约内容版本；契约内容变化即拒绝，追踪变化不影响契约工件。 */
  readonly contractRevision: number;
  readonly after: string | null;
};

/** 一次 UTF-8 范围读取的结果；`end` 是继续阅读所需的下一个 offset，`byteLength` 是完整文件字节数。 */
export type SpecificationFileRange = {
  readonly text: string;
  readonly sourceVersion: string;
  readonly offset: number;
  readonly end: number;
  readonly byteLength: number;
};

export type SpecificationFileRangeQuery = {
  readonly locator: SpecificationUnitLocator;
  readonly contractRevision: number;
  /** change 目录内的 POSIX 相对路径；越出 unit 或 worktree 一律拒绝。 */
  readonly path: string;
  /** 已看到的文件版本；`null` 表示接受当前版本，非匹配值说明来源已变。 */
  readonly sourceVersion: string | null;
  readonly offset: number;
  readonly maxBytes: number;
};

export interface SpecificationProvider {
  /** provider 标识与版本；进入 Spec Binding，用于判断绑定是否仍由同一工具语义解释。 */
  readonly providerId: string;
  readonly providerVersion: string;
  /** 读取 worktree 内的工具原生 Specification Unit。 */
  readUnit(input: SpecificationUnitLocator): Promise<SpecificationReadResult<SpecificationUnitSnapshot>>;
  /** 读取某角色的工件转换状态；只读，不触发转换。 */
  readRoleTransition(
    input: RoleTransitionQuery,
  ): Promise<SpecificationReadResult<RoleTransitionState>>;
  /**
   * 有界列出原生规格工件。这是显式打开：只有这一次读取并计算内容版本，之后的翻页与滚动只核对
   * 可信文件元数据。provider 不支持只读浏览时缺席，由调用方以明确拒绝表达，不静默降级。
   */
  readFiles?(
    input: SpecificationFileListingQuery,
  ): Promise<SpecificationReadResult<SpecificationFileListing>>;
  /** 读取某个工件的 UTF-8 范围；正文上限 `SPECIFICATION_BODY_MAX_BYTES`，不截断。 */
  readFileRange?(
    input: SpecificationFileRangeQuery,
  ): Promise<SpecificationReadResult<SpecificationFileRange>>;
}
