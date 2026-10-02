/**
 * MOD-06：输入保护模块（IC-13 的界面侧，Owner: `m2-deliver-planning-tui`）。
 *
 * 把 `UiInputStore` 的同步事务语义封装成界面能直接用的草稿/提交模型：草稿按目标隔离，编辑走合并
 * 窗口，提交前先写固定身份的完整快照。模块只经 `UiInputStore` 读写，不打开数据库、不调用 Orca、
 * 不推进业务状态，也不替用户猜身份。
 *
 * 两条不变量：
 * - 未保存的内存输入永不因载入、并发、失败或结果结算而丢弃；
 * - 提交结果只结清它自己的快照，绝不清掉随后编辑的新内容或另一个目标的草稿。
 */

import {
  conflictKey,
  submissionKey,
  targetDraftKey,
  type UiDraft,
  type UiInputRecord,
  type UiInputStore,
  type UiInputTarget,
  type UiInputValue,
  type UiPasteBlock,
} from '../../../application/ports/ui-input-store.js';

/** 编辑合并窗口：由用户编辑触发，到点后合并保存。 */
export const DRAFT_DEBOUNCE_MS = 250;

export type DraftLoad =
  | { readonly status: 'loaded'; readonly draft: UiDraft }
  | { readonly status: 'absent' }
  /** 载入期间用户已经编辑：丢弃载入值，保留当前输入。 */
  | { readonly status: 'stale' }
  | { readonly status: 'failed'; readonly code: string; readonly message: string };

export type SaveOutcome =
  | { readonly status: 'saved' }
  | { readonly status: 'conflict'; readonly message: string }
  | { readonly status: 'failed'; readonly code: string; readonly message: string };

/** 一次提交的权威结算；`accepted` 表示已确认受理，可直接清掉快照。 */
export type SubmissionOutcome =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string }
  | { readonly kind: 'unknown'; readonly code: string; readonly message: string };

export type PendingSubmission =
  | { readonly status: 'none' }
  | { readonly status: 'active'; readonly submissionId: string; readonly state: 'awaiting' | 'unknown' }
  | { readonly status: 'failed'; readonly code: string; readonly message: string };

export type BeginSubmission =
  | { readonly status: 'started'; readonly submissionId: string }
  | { readonly status: 'lane-busy'; readonly submissionId: string; readonly state: 'awaiting' | 'unknown' }
  | { readonly status: 'failed'; readonly code: string; readonly message: string };

export type InputRecordListing =
  | {
      readonly status: 'ok';
      readonly records: readonly UiInputRecord[];
      readonly invalidRecords: readonly { readonly key: string; readonly revision: number }[];
      readonly usage: { readonly records: number; readonly bytes: number };
    }
  | { readonly status: 'failed'; readonly code: string; readonly message: string };

export type InputProtection = {
  /** 只读载入持久草稿；用户已编辑时返回 `stale`，绝不覆盖当前输入。 */
  readonly load: (target: UiInputTarget) => DraftLoad;
  /** 用户编辑：更新内存草稿并启动/重置合并窗口。 */
  readonly edit: (target: UiInputTarget, text: string) => void;
  /** 粘贴：追加正文与载荷并立即保存，不等待合并窗口。 */
  readonly paste: (target: UiInputTarget, text: string) => SaveOutcome;
  /** 立即保存全部未保存草稿（切 Session、退出回答、正常退出前）。 */
  readonly flushAll: () => SaveOutcome;
  readonly hasUnsaved: () => boolean;
  /** 用户明确同意丢弃后才调用；只清内存脏标记，不删任何持久记录，也不写库。 */
  readonly discardUnsaved: () => void;
  /** 该目标当前的完整内存草稿（含正文、光标与粘贴载荷）；没有 slot 时为 `null`。 */
  readonly draftOf: (target: UiInputTarget) => UiDraft | null;
  /** 命令成功结清该次输入：删除持久草稿并清空内存 slot（用户明确动作，不是静默丢弃）。 */
  readonly clearInput: (target: UiInputTarget) => SaveOutcome;
  /** 当前编辑代际：异步结果只允许结清代际未变的草稿。 */
  readonly generation: (target: UiInputTarget) => number;
  /** 草稿是否处于「冲突待解」：双方内容已保留，等待用户显式选择。 */
  readonly isConflicted: (target: UiInputTarget) => boolean;
  /** 用户显式选择某一版：把它变成该目标的当前草稿并解除冲突。 */
  readonly adoptRecord: (record: UiInputRecord) => SaveOutcome;
  /** 清除已提交且未再编辑的草稿记录；仍有未保存改动时拒绝清除。 */
  readonly clearDraft: (target: UiInputTarget) => SaveOutcome;
  /** 该 Session 是否已有等待确认或不可核验的提交（单活跃提交 lane）。 */
  readonly pendingSubmission: (coordinationScopeId: string, coordinatorSessionId: string) => PendingSubmission;
  readonly beginSubmission: (input: {
    readonly target: UiInputTarget;
    readonly draft: UiDraft;
    readonly submissionId: string;
  }) => BeginSubmission;
  readonly settleSubmission: (input: {
    readonly target: UiInputTarget;
    readonly submissionId: string;
    readonly outcome: SubmissionOutcome;
  }) => SaveOutcome;
  readonly list: (coordinationScopeId: string) => InputRecordListing;
  /** 用户核验后的状态回写；`not-found` 保持未决，不改写记录。返回回写是否真实落盘。 */
  readonly markVerified: (input: {
    readonly key: string;
    readonly status: 'not-found' | 'conflict' | 'unverifiable';
    readonly reason: string | null;
  }) => SaveOutcome;
  readonly removeRecord: (key: string, revision: number) => SaveOutcome;
  /** 卸载时取消计时器；不关闭宿主打开的 store，也不写库。 */
  readonly dispose: () => void;
};

export type InputProtectionOptions = {
  readonly store: UiInputStore;
  readonly debounceMs?: number;
  readonly makeBlockId?: () => string;
  /** 合并窗口自动保存失败时的通知；显式保存由调用方读返回值。 */
  readonly onSaveOutcome?: (outcome: SaveOutcome) => void;
};

type Slot = {
  readonly target: UiInputTarget;
  readonly key: string;
  revision: number;
  revisionLoaded: boolean;
  text: string;
  cursor: number;
  pasteBlocks: readonly UiPasteBlock[];
  dirty: boolean;
  /** 并发冲突后置位：阻止后续静默覆盖库内版本，直到用户显式选择。 */
  conflicted: boolean;
};

function randomId(): string {
  return globalThis.crypto.randomUUID();
}

/** 目标的规范绑定串：用于核对库内记录的 target 与请求目标逐字段一致，防止串 Scope/Session。 */
function targetCanonical(target: UiInputTarget): string {
  return JSON.stringify([
    target.kind,
    target.coordinationScopeId,
    target.coordinatorSessionId,
    target.kind === 'answer' ? target.interactionId : null,
    target.kind === 'answer' ? target.expectedRevision : null,
  ]);
}

export function createInputProtection(options: InputProtectionOptions): InputProtection {
  const { store } = options;
  const debounceMs = options.debounceMs ?? DRAFT_DEBOUNCE_MS;
  const makeBlockId = options.makeBlockId ?? randomId;
  const slots = new Map<string, Slot>();
  /**
   * 每个目标的编辑代际。
   *
   * 它与 slot 生命周期解耦：slot 被删除（提交受理、命令结清）后归零会让旧异步结果误以为草稿没有
   * 变过，从而清掉用户新输入，因此这里单调递增且从不删除。
   */
  const generations = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  function bumpGeneration(target: UiInputTarget): void {
    const key = targetDraftKey(target);
    generations.set(key, (generations.get(key) ?? 0) + 1);
  }

  function cancelTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function schedule(): void {
    cancelTimer();
    timer = setTimeout(() => {
      timer = null;
      const outcome = flushAll();
      if (outcome.status !== 'saved') {
        options.onSaveOutcome?.(outcome);
      }
    }, debounceMs);
  }

  function ensureSlot(target: UiInputTarget): Slot {
    const key = targetDraftKey(target);
    const existing = slots.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const created: Slot = {
      target,
      key,
      revision: 0,
      revisionLoaded: false,
      text: '',
      cursor: 0,
      pasteBlocks: [],
      dirty: false,
      conflicted: false,
    };
    slots.set(key, created);
    return created;
  }

  function ensureRevision(slot: Slot): SaveOutcome | null {
    if (slot.revisionLoaded) {
      return null;
    }
    const read = store.read(slot.key);
    if (read.kind === 'failed') {
      return { status: 'failed', code: read.code, message: read.message };
    }
    slot.revision = read.revision;
    slot.revisionLoaded = true;
    return null;
  }

  /**
   * 冲突时把本机版本另存为冲突副本；库内版本留在原 key，交用户在记录管理里选择。
   *
   * 副本 key 每次随机：同一 DB revision 上可能有多个写入者的不同正文，共用 key 会互相覆盖。
   */
  function backupConflict(slot: Slot): SaveOutcome {
    const written = store.write({
      key: conflictKey(slot.target, randomId()),
      expectedRevision: 0,
      record: {
        kind: 'conflict',
        target: slot.target,
        draft: { text: slot.text, cursor: slot.cursor, pasteBlocks: slot.pasteBlocks },
      },
    });
    if (written.kind === 'saved') {
      return { status: 'saved' };
    }
    if (written.kind === 'failed') {
      return { status: 'failed', code: written.code, message: written.message };
    }
    return { status: 'failed', code: 'conflict_backup_conflict', message: '冲突副本写入冲突' };
  }

  function writeDraft(slot: Slot): SaveOutcome {
    const value: UiInputValue = {
      kind: 'draft',
      target: slot.target,
      draft: { text: slot.text, cursor: slot.cursor, pasteBlocks: slot.pasteBlocks },
    };
    const written = store.write({ key: slot.key, expectedRevision: slot.revision, record: value });
    if (written.kind === 'saved') {
      slot.revision = written.record.revision;
      slot.dirty = false;
      return { status: 'saved' };
    }
    if (written.kind === 'failed') {
      return { status: 'failed', code: written.code, message: written.message };
    }
    const backup = backupConflict(slot);
    if (backup.status !== 'saved') {
      // 本机内容既没落盘也没备份：保持 dirty 并如实报告失败，绝不报告成功。
      return {
        status: 'failed',
        code: backup.status === 'failed' ? backup.code : 'conflict_backup_conflict',
        message: `并发写入冲突且本机内容未能备份：${backup.message}`,
      };
    }
    // 双方都已保留：不采用库内 revision、不清除 dirty，阻止后续编辑静默覆盖别人的版本。
    slot.conflicted = true;
    return { status: 'conflict', message: '并发写入冲突：双方内容已保留，请在输入记录管理中显式选择' };
  }

  function saveSlot(slot: Slot): SaveOutcome {
    if (slot.conflicted) {
      return { status: 'conflict', message: '草稿处于冲突待解状态：请在输入记录管理中显式选择保留哪一版' };
    }
    return ensureRevision(slot) ?? writeDraft(slot);
  }

  function flushAll(): SaveOutcome {
    cancelTimer();
    let first: SaveOutcome = { status: 'saved' };
    for (const slot of slots.values()) {
      if (!slot.dirty) {
        continue;
      }
      const outcome = saveSlot(slot);
      if (outcome.status !== 'saved' && first.status === 'saved') {
        first = outcome;
      }
    }
    return first;
  }

  function saveOne(target: UiInputTarget): SaveOutcome {
    // 不取消全局合并计时器：它可能还欠着其他 dirty slot 一次自动保存。
    const slot = slots.get(targetDraftKey(target));
    return slot === undefined ? { status: 'saved' } : saveSlot(slot);
  }

  return {
    load(target) {
      const slot = ensureSlot(target);
      if (slot.dirty) {
        return { status: 'stale' };
      }
      const read = store.read(slot.key);
      if (read.kind === 'failed') {
        return { status: 'failed', code: read.code, message: read.message };
      }
      slot.revision = read.revision;
      slot.revisionLoaded = true;
      const record = read.record;
      if (record === null || record.kind === 'submission') {
        slot.text = '';
        slot.cursor = 0;
        slot.pasteBlocks = [];
        slot.dirty = false;
        return { status: 'absent' };
      }
      if (targetCanonical(record.target) !== targetCanonical(target)) {
        // 库内记录的绑定与请求目标不一致：fail closed，不把它读成这个目标的草稿。
        return { status: 'failed', code: 'record_binding_mismatch', message: '库内草稿的目标绑定与请求不一致' };
      }
      slot.text = record.draft.text;
      slot.cursor = record.draft.cursor;
      slot.pasteBlocks = record.draft.pasteBlocks;
      slot.dirty = false;
      return { status: 'loaded', draft: record.draft };
    },
    edit(target, text) {
      const slot = ensureSlot(target);
      slot.text = text;
      slot.cursor = text.length;
      bumpGeneration(target);
      slot.dirty = true;
      schedule();
    },
    paste(target, text) {
      const slot = ensureSlot(target);
      slot.text = `${slot.text}${text}`;
      slot.cursor = slot.text.length;
      slot.pasteBlocks = [...slot.pasteBlocks, { id: makeBlockId(), text }];
      bumpGeneration(target);
      slot.dirty = true;
      return saveOne(target);
    },
    flushAll,
    hasUnsaved: () => [...slots.values()].some((slot) => slot.dirty),
    discardUnsaved() {
      cancelTimer();
      for (const slot of slots.values()) {
        slot.dirty = false;
      }
    },
    draftOf(target) {
      const slot = slots.get(targetDraftKey(target));
      return slot === undefined
        ? null
        : { text: slot.text, cursor: slot.cursor, pasteBlocks: slot.pasteBlocks };
    },
    clearInput(target) {
      cancelTimer();
      const slot = slots.get(targetDraftKey(target));
      if (slot === undefined) {
        return { status: 'saved' };
      }
      const failure = ensureRevision(slot);
      if (failure !== null) {
        // 读不到 revision 就不能删：保留内存输入并如实报告失败。
        return failure;
      }
      const removed = store.remove({ key: slot.key, expectedRevision: slot.revision });
      if (removed.kind === 'removed') {
        slots.delete(slot.key);
        return { status: 'saved' };
      }
      if (removed.kind === 'failed') {
        return { status: 'failed', code: removed.code, message: removed.message };
      }
      slot.revision = removed.revision;
      return { status: 'conflict', message: '草稿已被并发修改，未删除持久记录（输入仍保留）' };
    },
    generation: (target) => generations.get(targetDraftKey(target)) ?? 0,
    isConflicted: (target) => slots.get(targetDraftKey(target))?.conflicted ?? false,
    adoptRecord(record) {
      const slot = ensureSlot(record.target);
      // 恢复会覆盖该目标的当前草稿，因此先把未保存/冲突中的内存输入落盘或进入冲突待解；
      // 处理不掉时整个恢复失败，绝不丢掉用户刚编辑的内容。
      if (slot.conflicted) {
        // 已进入冲突待解：当前内存版本（可能冲突后又被编辑）再存一份副本，失败就不覆盖。
        const preserved = backupConflict(slot);
        if (preserved.status !== 'saved') {
          return preserved;
        }
      } else if (slot.dirty) {
        const saved = saveSlot(slot);
        if (saved.status !== 'saved') {
          return saved;
        }
      }
      const read = store.read(slot.key);
      if (read.kind === 'failed') {
        return { status: 'failed', code: read.code, message: read.message };
      }
      // 冲突副本与提交快照的正文都能恢复为该目标的草稿；提交记录本身保留稳定身份，不删除。
      const current = read.record;
      if (current !== null && current.kind !== 'submission' && current.draft.text === record.draft.text) {
        // 恢复的正是库内当前版本：无需覆盖，也就无需备份。
        slot.revision = read.revision;
      } else {
        if (current !== null && current.kind !== 'submission') {
          // 覆盖前先把库内当前版本（另一方）另存为冲突副本，保证选择后双方都还在。
          const backup = store.write({
            key: conflictKey(record.target, randomId()),
            expectedRevision: 0,
            record: { kind: 'conflict', target: record.target, draft: current.draft },
          });
          if (backup.kind !== 'saved') {
            return { status: 'failed', code: 'conflict_backup_failed', message: '未能备份库内版本，未覆盖' };
          }
        }
        const written = store.write({
          key: slot.key,
          expectedRevision: read.revision,
          record: { kind: 'draft', target: record.target, draft: record.draft },
        });
        if (written.kind === 'failed') {
          return { status: 'failed', code: written.code, message: written.message };
        }
        if (written.kind === 'conflict') {
          return { status: 'conflict', message: '恢复时发生并发写入，未覆盖' };
        }
        slot.revision = written.record.revision;
      }
      slot.revisionLoaded = true;
      slot.text = record.draft.text;
      slot.cursor = record.draft.cursor;
      slot.pasteBlocks = record.draft.pasteBlocks;
      slot.dirty = false;
      slot.conflicted = false;
      bumpGeneration(record.target);
      return { status: 'saved' };
    },
    clearDraft(target) {
      const slot = slots.get(targetDraftKey(target));
      if (slot === undefined) {
        return { status: 'saved' };
      }
      if (slot.dirty) {
        return { status: 'conflict', message: '草稿仍有未保存改动，未清除' };
      }
      const failure = ensureRevision(slot);
      if (failure !== null) {
        return failure;
      }
      const removed = store.remove({ key: slot.key, expectedRevision: slot.revision });
      if (removed.kind === 'removed') {
        slots.delete(slot.key);
        return { status: 'saved' };
      }
      if (removed.kind === 'failed') {
        return { status: 'failed', code: removed.code, message: removed.message };
      }
      slot.revision = removed.revision;
      return { status: 'conflict', message: '草稿已被并发修改，未清除' };
    },
    pendingSubmission(coordinationScopeId, coordinatorSessionId) {
      const listed = store.list(coordinationScopeId);
      if (listed.kind === 'failed') {
        return { status: 'failed', code: listed.code, message: listed.message };
      }
      for (const record of listed.records) {
        if (
          record.kind === 'submission' &&
          record.target.coordinatorSessionId === coordinatorSessionId &&
          (record.status === 'awaiting' || record.status === 'unknown')
        ) {
          return { status: 'active', submissionId: record.submissionId, state: record.status };
        }
      }
      return { status: 'none' };
    },
    beginSubmission({ target, draft, submissionId }) {
      const lane = this.pendingSubmission(target.coordinationScopeId, target.coordinatorSessionId);
      if (lane.status === 'failed') {
        return { status: 'failed', code: lane.code, message: lane.message };
      }
      if (lane.status === 'active') {
        return { status: 'lane-busy', submissionId: lane.submissionId, state: lane.state };
      }
      const key = submissionKey(target, submissionId);
      const read = store.read(key);
      if (read.kind === 'failed') {
        // 读不到当前 revision 就不能用 0 去覆盖：失败关闭，绝不盲写。
        return { status: 'failed', code: read.code, message: read.message };
      }
      const written = store.write({
        key,
        expectedRevision: read.revision,
        record: { kind: 'submission', target, draft, submissionId, status: 'awaiting', reason: null },
      });
      if (written.kind === 'saved') {
        return { status: 'started', submissionId };
      }
      if (written.kind === 'failed') {
        return { status: 'failed', code: written.code, message: written.message };
      }
      return { status: 'failed', code: 'submission_conflict', message: '提交快照写入冲突，未发起调用' };
    },
    settleSubmission({ target, submissionId, outcome }) {
      const key = submissionKey(target, submissionId);
      const read = store.read(key);
      if (read.kind === 'failed') {
        return { status: 'failed', code: read.code, message: read.message };
      }
      const record = read.record;
      if (record === null) {
        return { status: 'saved' };
      }
      if (targetCanonical(record.target) !== targetCanonical(target)) {
        return { status: 'failed', code: 'record_binding_mismatch', message: '提交快照的目标绑定与请求不一致' };
      }
      if (outcome.kind === 'accepted') {
        // 已确认受理：立即删除快照，不等恢复流程或界面渲染。
        const removed = store.remove({ key, expectedRevision: read.revision });
        if (removed.kind === 'removed') {
          return { status: 'saved' };
        }
        if (removed.kind === 'failed') {
          return { status: 'failed', code: removed.code, message: removed.message };
        }
        return { status: 'conflict', message: '提交快照已被并发修改，未清理' };
      }
      if (record.kind !== 'submission') {
        return { status: 'saved' };
      }
      const written = store.write({
        key,
        expectedRevision: read.revision,
        record: {
          kind: 'submission',
          target: record.target,
          draft: record.draft,
          submissionId: record.submissionId,
          status: outcome.kind === 'rejected' ? 'rejected' : 'unknown',
          reason: `${outcome.code}: ${outcome.message}`,
        },
      });
      if (written.kind === 'saved') {
        return { status: 'saved' };
      }
      if (written.kind === 'failed') {
        return { status: 'failed', code: written.code, message: written.message };
      }
      return { status: 'conflict', message: '提交状态回写冲突，原身份保持待核验' };
    },
    list(coordinationScopeId) {
      const listed = store.list(coordinationScopeId);
      if (listed.kind === 'failed') {
        return { status: 'failed', code: listed.code, message: listed.message };
      }
      return {
        status: 'ok',
        records: listed.records,
        invalidRecords: listed.invalidRecords,
        usage: listed.usage,
      };
    },
    markVerified({ key, status, reason }) {
      if (status === 'not-found') {
        // 尚未落地：保留未决状态，不伪造结论。
        return { status: 'saved' };
      }
      const read = store.read(key);
      if (read.kind === 'failed') {
        return { status: 'failed', code: read.code, message: read.message };
      }
      const record = read.record;
      if (record === null || record.kind !== 'submission') {
        return { status: 'saved' };
      }
      const written = store.write({
        key,
        expectedRevision: read.revision,
        record: {
          kind: 'submission',
          target: record.target,
          draft: record.draft,
          submissionId: record.submissionId,
          status: status === 'conflict' ? 'conflict' : 'unknown',
          reason,
        },
      });
      if (written.kind === 'saved') {
        return { status: 'saved' };
      }
      if (written.kind === 'failed') {
        return { status: 'failed', code: written.code, message: written.message };
      }
      return { status: 'conflict', message: '核验状态回写冲突' };
    },
    removeRecord(key, revision) {
      const removed = store.remove({ key, expectedRevision: revision });
      if (removed.kind === 'removed') {
        slots.delete(key);
        return { status: 'saved' };
      }
      if (removed.kind === 'failed') {
        return { status: 'failed', code: removed.code, message: removed.message };
      }
      return { status: 'conflict', message: '记录已被并发修改，未删除' };
    },
    dispose: cancelTimer,
  };
}
