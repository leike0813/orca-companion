/**
 * IC-13：UI 输入存储的同步窄端口（Owner: `protect-tui-input`）。
 *
 * 这里保存的只是「用户还没送出的输入」：聊天草稿、回答草稿、粘贴载荷、待核验提交与冲突副本。
 * 它不写 Coordinator checkpoint 或 Branch Coordination State，也不进任何授权队列，因此这里没有
 * 跨库事务、没有模型恢复，也没有后台清理线程。
 *
 * 调用约定：
 * - 每条记录各自持有独立 key（JSON 元组字符串），同一目标因此可以同时保留草稿与待核验提交；
 * - 写入与删除都携带调用方读到的 `expectedRevision`，新 revision 只能由 store 在同一事务内推进；
 * - revision 按 key 单调，ABA 由该 key 的 revision 与 tombstone 保证；全库单调的序号只服务列表
 *   的稳定顺序，不参与 CAS，也不进入合同；
 * - 四个方法同步返回结果联合而不抛异常：读写、列举、删除以及已关闭的 store 都用 `failed` 报告；
 * - 未知字段、未知 schema 版本与无法解析的既有记录一律 fail closed，不猜测、不降级、不静默丢弃。
 *
 * `close` 属于 adapter 生命周期、由宿主拥有，所以只在 `UiInputStoreHandle` 上，不在本端口。
 */

/** 普通消息的目标：某个 Scope 下某个 Session 的输入。 */
export type UiMessageTarget = {
  readonly kind: 'message';
  readonly coordinationScopeId: string;
  readonly coordinatorSessionId: string;
};

/** 回答的目标：除 Scope/Session 外还绑定 InteractionId 与回答时读到的 revision。 */
export type UiAnswerTarget = {
  readonly kind: 'answer';
  readonly coordinationScopeId: string;
  readonly coordinatorSessionId: string;
  readonly interactionId: string;
  readonly expectedRevision: number;
};

export type UiInputTarget = UiMessageTarget | UiAnswerTarget;

/** 粘贴载荷：全文同时展开进 `UiDraft.text`，这里保留块身份供后续编辑批次使用。 */
export type UiPasteBlock = {
  readonly id: string;
  readonly text: string;
};

export type UiDraft = {
  readonly text: string;
  readonly cursor: number;
  readonly pasteBlocks: readonly UiPasteBlock[];
};

export const UI_SUBMISSION_STATUSES = ['awaiting', 'unknown', 'rejected', 'conflict'] as const;

export type UiSubmissionStatus = (typeof UI_SUBMISSION_STATUSES)[number];

/** 仍占用「单活跃提交」等待位的状态：拒绝与冲突保留记录但已经释放等待位。 */
export const UI_ACTIVE_SUBMISSION_STATUSES = ['awaiting', 'unknown'] as const satisfies readonly UiSubmissionStatus[];

export type UiInputValue =
  | { readonly kind: 'draft'; readonly target: UiInputTarget; readonly draft: UiDraft }
  | { readonly kind: 'conflict'; readonly target: UiInputTarget; readonly draft: UiDraft }
  | {
      readonly kind: 'submission';
      readonly target: UiInputTarget;
      readonly draft: UiDraft;
      readonly submissionId: string;
      readonly status: UiSubmissionStatus;
      readonly reason: string | null;
    };

/** 落盘记录：值与它自己的 key、revision 一起读回，调用方不需要另存一份 key。 */
export type UiInputRecord = UiInputValue & {
  readonly key: string;
  readonly revision: number;
};

/**
 * 容量计量与不可读记录。
 *
 * `usage` 计量的是**整库**（上限按仓库计算），`records`/`invalidRecords` 只覆盖被列举的那个
 * Scope；容量逼近时界面据此提示清理，所以它不能只反映当前 Scope。
 */
export type UiInputUsage = {
  readonly records: number;
  readonly bytes: number;
};

/** 存在但无法解析的记录：只报告身份，保留原行等待用户显式删除。 */
export type UiInputInvalidRecord = {
  readonly key: string;
  readonly revision: number;
};

export type UiInputStoreFailure = {
  readonly kind: 'failed';
  readonly code: string;
  readonly message: string;
};

export type UiInputReadResult =
  | { readonly kind: 'record'; readonly record: UiInputRecord | null; readonly revision: number }
  | UiInputStoreFailure;

export type UiInputListResult =
  | {
      readonly kind: 'records';
      readonly records: readonly UiInputRecord[];
      readonly invalidRecords: readonly UiInputInvalidRecord[];
      readonly usage: UiInputUsage;
    }
  | UiInputStoreFailure;

export type UiInputWriteResult =
  | { readonly kind: 'saved'; readonly record: UiInputRecord }
  | { readonly kind: 'conflict'; readonly current: UiInputRecord | null; readonly revision: number }
  | UiInputStoreFailure;

export type UiInputRemoveResult =
  | { readonly kind: 'removed'; readonly revision: number }
  | { readonly kind: 'conflict'; readonly current: UiInputRecord | null; readonly revision: number }
  | UiInputStoreFailure;

export type UiInputWriteInput = {
  readonly key: string;
  readonly expectedRevision: number;
  readonly record: UiInputValue;
};

export type UiInputRemoveInput = {
  readonly key: string;
  readonly expectedRevision: number;
};

export type UiInputStore = {
  read(key: string): UiInputReadResult;
  list(coordinationScopeId: string): UiInputListResult;
  write(input: UiInputWriteInput): UiInputWriteResult;
  remove(input: UiInputRemoveInput): UiInputRemoveResult;
};

/** adapter 生命周期由宿主拥有：只有装配方拿得到 `close`。 */
export type UiInputStoreHandle = UiInputStore & {
  readonly close: () => void;
};

export type UiInputLimits = {
  readonly maxRecords: number;
  readonly maxBytes: number;
};

/** 起始双上限：256 条有效记录、32 MiB UTF-8 正文/粘贴载荷；不做自动淘汰。 */
export const DEFAULT_UI_INPUT_LIMITS: UiInputLimits = {
  maxRecords: 256,
  maxBytes: 32 * 1024 * 1024,
};

/** 普通消息草稿的 key：同一 Session 只有一条。 */
function messageDraftKey(target: UiMessageTarget): string {
  return JSON.stringify(['draft', target.coordinationScopeId, target.coordinatorSessionId]);
}

/** 回答草稿的 key：同一交互的不同 expected revision 各自独立，永不自动改绑。 */
function answerDraftKey(target: UiAnswerTarget): string {
  return JSON.stringify([
    'draft',
    target.coordinationScopeId,
    target.coordinatorSessionId,
    target.interactionId,
    target.expectedRevision,
  ]);
}

/**
 * 目标当前草稿的 key。
 *
 * 草稿、冲突副本与提交各自持有独立 key，因此同一目标可以同时留有草稿与待核验提交。
 */
export function targetDraftKey(target: UiInputTarget): string {
  return target.kind === 'message' ? messageDraftKey(target) : answerDraftKey(target);
}

/** 提交快照的 key；`submissionId` 是稳定身份，重试必须复用它而不是换一个。 */
export function submissionKey(target: UiInputTarget, submissionId: string): string {
  return JSON.stringify([
    'submission',
    target.coordinationScopeId,
    target.coordinatorSessionId,
    submissionId,
  ]);
}

/** 冲突副本的 key；`conflictId` 由调用方给出，用于保留被覆盖的另一版本。 */
export function conflictKey(target: UiInputTarget, conflictId: string): string {
  return JSON.stringify([
    'conflict',
    target.coordinationScopeId,
    target.coordinatorSessionId,
    conflictId,
  ]);
}
