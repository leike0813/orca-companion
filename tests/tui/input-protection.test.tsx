import { textDraft } from '../../src/interfaces/tui/input/composer-editor.js';
/**
 * 输入保护模块行为（IP-01/IP-03，`tui/input-protection`）。
 *
 * 用真实的内存 `ui.sqlite` 驱动，因此断言的是可观察的持久事实（记录内容、状态、revision、lane），
 * 而不是模块内部结构。重点覆盖：跨重启恢复与隔离、合并保存、并发冲突保双方、容量失败保内存、
 * 单活跃提交、accepted 立即清理、以及显式恢复时备份另一方版本。
 */

import { describe, expect, test } from 'vitest';

import {
  conflictKey,
  submissionKey,
  targetDraftKey,
  type UiInputRecord,
  type UiInputStore,
  type UiInputTarget,
} from '../../src/application/ports/ui-input-store.js';
import { createInputProtection } from '../../src/interfaces/tui/input/input-protection.js';
import type { TuiPorts } from '../../src/interfaces/tui/ports.js';
import type { ControllerCommandResult } from '../../src/application/controller-service.js';
import {
  createFailingInputStore,
  createFakePorts,
  createMemoryInputStore,
  frameText,
  renderTui,
  settle,
  type RenderedTui,
} from './harness.js';

const CTRL_C = '\u0003';
const ENTER = '\r';

async function press(rendered: RenderedTui, keys: string): Promise<void> {
  rendered.stdin.write(keys);
  await settle(4);
}

async function waitFor(
  rendered: RenderedTui,
  predicate: (frame: string) => boolean,
  timeoutMs = 3000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let frame = rendered.lastFrame() ?? '';
  while (!predicate(frame) && Date.now() < deadline) {
    await settle(2);
    frame = rendered.lastFrame() ?? '';
  }
  return frame;
}

/**
 * 等到界面真正可以接收输入。
 *
 * composer 标题会先于 `sessions-loaded` 出现：此时还没有选中 Session，输入会被丢弃。因此先等
 * transcript 已经按选中的 Session 加载，再开始发送按键。
 */
async function ready(rendered: RenderedTui, fake: ReturnType<typeof createFakePorts>): Promise<void> {
  await waitFor(rendered, () => fake.calls.some((call) => call.name === 'transcript'));
  await waitFor(rendered, (frame) => frame.includes('composer · 普通消息'));
}

const targetA: UiInputTarget = { kind: 'message', coordinationScopeId: 'scope-1', coordinatorSessionId: 'session-a' };
const targetB: UiInputTarget = { kind: 'message', coordinationScopeId: 'scope-1', coordinatorSessionId: 'session-b' };
const answerTarget: UiInputTarget = {
  kind: 'answer',
  coordinationScopeId: 'scope-1',
  coordinatorSessionId: 'session-b',
  interactionId: 'i-1',
  expectedRevision: 4,
};

function recordAt(store: UiInputStore, key: string): UiInputRecord | null {
  const read = store.read(key);
  if (read.kind !== 'record') {
    throw new Error(`读取失败：${read.code} ${read.message}`);
  }
  return read.record;
}

function listedRecords(store: UiInputStore, scopeId: string): readonly UiInputRecord[] {
  const listed = store.list(scopeId);
  if (listed.kind !== 'records') {
    throw new Error(`列举失败：${listed.code} ${listed.message}`);
  }
  return listed.records;
}

function draftText(record: UiInputRecord | null): string | null {
  return record === null || record.kind === 'submission' ? null : record.draft.text;
}

describe('草稿持久化、隔离与合并保存', () => {
  test('重启后完整恢复多行中文草稿与粘贴载荷，且多目标互不串', () => {
    const store = createMemoryInputStore();
    const first = createInputProtection({ store });
    first.edit(targetA, textDraft('多行\n中文草稿'));
    expect(first.flushAll().status).toBe('saved');
    expect(first.paste(answerTarget, '粘贴的一段').status).toBe('saved');
    expect(first.paste(answerTarget, '第二段').status).toBe('saved');

    // 重启：新实例从同一个 store 载入。
    const restarted = createInputProtection({ store });
    const loadedA = restarted.load(targetA);
    expect(loadedA.status).toBe('loaded');
    expect(loadedA.status === 'loaded' && loadedA.draft.text).toBe('多行\n中文草稿');

    const loadedAnswer = restarted.load(answerTarget);
    expect(loadedAnswer.status === 'loaded' && loadedAnswer.draft.text).toBe('粘贴的一段第二段');
    expect(loadedAnswer.status === 'loaded' && loadedAnswer.draft.pasteBlocks).toHaveLength(0);

    // 同一 Session 的普通草稿与回答草稿是不同目标，互不影响。
    expect(restarted.load(targetB).status).toBe('absent');
  });

  test('连续编辑只落最后一次内容；粘贴立即保存', async () => {
    const store = createMemoryInputStore();
    const protection = createInputProtection({ store, debounceMs: 20 });
    protection.edit(targetA, textDraft('a'));
    protection.edit(targetA, textDraft('ab'));
    protection.edit(targetA, textDraft('abc'));
    // 合并窗口未到：还没有任何持久记录。
    expect(recordAt(store, targetDraftKey(targetA))).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(draftText(recordAt(store, targetDraftKey(targetA)))).toBe('abc');

    protection.paste(targetB, '立即保存');
    expect(draftText(recordAt(store, targetDraftKey(targetB)))).toBe('立即保存');
  });

  test('载入期间已编辑时返回 stale，绝不覆盖当前输入', () => {
    const store = createMemoryInputStore();
    const seed = createInputProtection({ store });
    seed.edit(targetA, textDraft('旧稿'));
    seed.flushAll();

    const protection = createInputProtection({ store });
    protection.edit(targetA, textDraft('新稿'));
    expect(protection.load(targetA).status).toBe('stale');
    expect(protection.draftOf(targetA)?.text).toBe('新稿');
  });

  test('库内记录绑定与请求目标不一致时 fail closed', () => {
    const store = createMemoryInputStore();
    // 模拟串绑/损坏：session-a 的 key 位置放了一条绑定到 session-b 的草稿。
    store.write({
      key: targetDraftKey(targetA),
      expectedRevision: 0,
      record: { kind: 'draft', target: targetB, draft: { text: '串绑', cursor: 2, pasteBlocks: [] } },
    });
    const protection = createInputProtection({ store });
    const loaded = protection.load(targetA);
    expect(loaded.status).toBe('failed');
    expect(loaded.status === 'failed' && loaded.code).toBe('record_binding_mismatch');
  });

  test('dispose 只取消计时器，不产生任何写入', async () => {
    const store = createMemoryInputStore();
    const protection = createInputProtection({ store, debounceMs: 10 });
    protection.edit(targetA, textDraft('未保存'));
    protection.dispose();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(recordAt(store, targetDraftKey(targetA))).toBeNull();
    expect(protection.hasUnsaved()).toBe(true);
  });
});

describe('并发冲突、容量与恢复保护', () => {
  test('两个实例并发写同一目标：库内版本不被覆盖，本机内容另存为冲突副本', () => {
    const store = createMemoryInputStore();
    const p1 = createInputProtection({ store });
    const p2 = createInputProtection({ store });
    p1.load(targetA);
    p2.load(targetA);

    p1.edit(targetA, textDraft('来自 p1'));
    expect(p1.flushAll().status).toBe('saved');
    p2.edit(targetA, textDraft('来自 p2'));
    const outcome = p2.flushAll();

    expect(outcome.status).toBe('conflict');
    expect(draftText(recordAt(store, targetDraftKey(targetA)))).toBe('来自 p1');
    const conflicts = listedRecords(store, 'scope-1').filter((record) => record.kind === 'conflict');
    expect(conflicts.map((record) => record.draft.text)).toContain('来自 p2');
    // 未静默成功：内存输入保持未保存，且进入冲突待解状态。
    expect(p2.hasUnsaved()).toBe(true);
    expect(p2.isConflicted(targetA)).toBe(true);
    expect(p2.draftOf(targetA)?.text).toBe('来自 p2');
  });

  test('同一目标冲突后继续编辑不会静默覆盖库内版本', () => {
    const store = createMemoryInputStore();
    const p1 = createInputProtection({ store });
    const p2 = createInputProtection({ store });
    p1.load(targetA);
    p2.load(targetA);
    p1.edit(targetA, textDraft('库内'));
    p1.flushAll();
    p2.edit(targetA, textDraft('本地'));
    expect(p2.flushAll().status).toBe('conflict');

    p2.edit(targetA, textDraft('本地改了'));
    const afterEdit = p2.flushAll();
    expect(afterEdit.status).toBe('conflict');
    expect(draftText(recordAt(store, targetDraftKey(targetA)))).toBe('库内');
  });

  test('冲突副本写入失败时保持 dirty 并返回失败，不伪装成功', () => {
    const store = createMemoryInputStore();
    const seeded = createInputProtection({ store });
    const guarded: UiInputStore = {
      read: (key) => store.read(key),
      list: (scopeId) => store.list(scopeId),
      write: (input) =>
        input.key === targetDraftKey(targetA)
          ? store.write(input)
          : { kind: 'failed', code: 'capacity_exceeded', message: '容量已满' },
      remove: (input) => store.remove(input),
    };
    const p2 = createInputProtection({ store: guarded });
    // p2 先读到 revision 0，之后 seeded 写入推进 revision，制造 CAS 不匹配。
    p2.load(targetA);
    seeded.edit(targetA, textDraft('库内'));
    seeded.flushAll();
    p2.edit(targetA, textDraft('本机内容'));
    const outcome = p2.flushAll();

    expect(outcome.status).toBe('failed');
    expect(p2.hasUnsaved()).toBe(true);
    expect(p2.draftOf(targetA)?.text).toBe('本机内容');
  });

  test('写入失败（容量满额）时保留内存输入并如实报告', () => {
    const store = createFailingInputStore('capacity_exceeded');
    const protection = createInputProtection({ store });
    protection.edit(targetA, textDraft('重要输入'));
    const outcome = protection.flushAll();
    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' && outcome.code).toBe('capacity_exceeded');
    expect(protection.hasUnsaved()).toBe(true);
    expect(protection.draftOf(targetA)?.text).toBe('重要输入');
  });

  test('恢复冲突副本前先备份库内另一方版本，选择后双方都还在', () => {
    const store = createMemoryInputStore();
    const p1 = createInputProtection({ store });
    const p2 = createInputProtection({ store });
    p1.load(targetA);
    p2.load(targetA);
    p1.edit(targetA, textDraft('库内版本'));
    p1.flushAll();
    p2.edit(targetA, textDraft('本地版本'));
    expect(p2.flushAll().status).toBe('conflict');

    const conflictRecord = listedRecords(store, 'scope-1').find((record) => record.kind === 'conflict');
    expect(conflictRecord).toBeDefined();
    const adopted = p2.adoptRecord(conflictRecord as UiInputRecord);
    expect(adopted.status).toBe('saved');

    expect(draftText(recordAt(store, targetDraftKey(targetA)))).toBe('本地版本');
    const conflicts = listedRecords(store, 'scope-1')
      .filter((record) => record.kind === 'conflict')
      .map((record) => record.draft.text);
    expect(conflicts).toContain('库内版本');
    expect(p2.isConflicted(targetA)).toBe(false);
    expect(p2.hasUnsaved()).toBe(false);
  });
});

describe('提交快照、单活跃 lane 与结算', () => {
  const draft = { text: '请回复', cursor: 3, pasteBlocks: [] };

  test('连按只产生一条等待位；同一 Session 的第二次提交被拒绝', () => {
    const store = createMemoryInputStore();
    const protection = createInputProtection({ store });
    expect(protection.beginSubmission({ target: targetA, draft, submissionId: 'sub-1' }).status).toBe('started');
    const second = protection.beginSubmission({ target: targetA, draft, submissionId: 'sub-2' });
    expect(second.status).toBe('lane-busy');
    expect(second.status === 'lane-busy' && second.submissionId).toBe('sub-1');
    // 另一个 Session 互不影响。
    expect(protection.beginSubmission({ target: targetB, draft, submissionId: 'sub-3' }).status).toBe('started');
  });

  test('accepted 立即删除快照并释放等待位', () => {
    const store = createMemoryInputStore();
    const protection = createInputProtection({ store });
    protection.beginSubmission({ target: targetA, draft, submissionId: 'sub-1' });
    const settled = protection.settleSubmission({
      target: targetA,
      submissionId: 'sub-1',
      outcome: { kind: 'accepted' },
    });
    expect(settled.status).toBe('saved');
    expect(recordAt(store, submissionKey(targetA, 'sub-1'))).toBeNull();
    expect(protection.pendingSubmission('scope-1', 'session-a').status).toBe('none');
  });

  test('rejected 保留记录并释放等待位，unknown 保留记录继续占用', () => {
    const store = createMemoryInputStore();
    const protection = createInputProtection({ store });

    protection.beginSubmission({ target: targetA, draft, submissionId: 'sub-r' });
    protection.settleSubmission({
      target: targetA,
      submissionId: 'sub-r',
      outcome: { kind: 'rejected', code: 'stale_revision', message: 'revision 已过期' },
    });
    const rejected = recordAt(store, submissionKey(targetA, 'sub-r'));
    expect(rejected?.kind === 'submission' && rejected.status).toBe('rejected');
    expect(protection.pendingSubmission('scope-1', 'session-a').status).toBe('none');

    protection.beginSubmission({ target: targetA, draft, submissionId: 'sub-u' });
    protection.settleSubmission({
      target: targetA,
      submissionId: 'sub-u',
      outcome: { kind: 'unknown', code: 'transport', message: '响应丢失' },
    });
    const lane = protection.pendingSubmission('scope-1', 'session-a');
    expect(lane.status === 'active' && lane.state).toBe('unknown');
  });

  test('核验回写：not-found 保持未决，conflict/unverifiable 更新状态', () => {
    const store = createMemoryInputStore();
    const protection = createInputProtection({ store });
    protection.beginSubmission({ target: targetA, draft, submissionId: 'sub-v' });

    expect(protection.markVerified({ key: submissionKey(targetA, 'sub-v'), status: 'not-found', reason: null }).status).toBe(
      'saved',
    );
    const pending = recordAt(store, submissionKey(targetA, 'sub-v'));
    expect(pending?.kind === 'submission' && pending.status).toBe('awaiting');

    expect(
      protection.markVerified({ key: submissionKey(targetA, 'sub-v'), status: 'unverifiable', reason: '后端不可达' }).status,
    ).toBe('saved');
    const unverified = recordAt(store, submissionKey(targetA, 'sub-v'));
    expect(unverified?.kind === 'submission' && unverified.status).toBe('unknown');
  });

  test('提交记录保留稳定身份：恢复其正文不删除该提交记录', () => {
    const store = createMemoryInputStore();
    const protection = createInputProtection({ store });
    protection.beginSubmission({ target: targetA, draft, submissionId: 'sub-keep' });
    const submission = recordAt(store, submissionKey(targetA, 'sub-keep'));
    expect(submission).not.toBeNull();

    expect(protection.adoptRecord(submission as UiInputRecord).status).toBe('saved');
    expect(draftText(recordAt(store, targetDraftKey(targetA)))).toBe('请回复');
    // 稳定身份仍在：同一条 submission 记录没有被删除或换 id。
    expect(recordAt(store, submissionKey(targetA, 'sub-keep'))).not.toBeNull();
  });

  test('冲突副本 key 每次随机：同一 revision 的两份不同正文不会互相覆盖', () => {
    const store = createMemoryInputStore();
    const p1 = createInputProtection({ store });
    const p2 = createInputProtection({ store });
    const p3 = createInputProtection({ store });
    p1.load(targetA);
    p2.load(targetA);
    p3.load(targetA);
    p1.edit(targetA, textDraft('库内'));
    p1.flushAll();
    p2.edit(targetA, textDraft('第二个写入者'));
    expect(p2.flushAll().status).toBe('conflict');
    p3.edit(targetA, textDraft('第三个写入者'));
    expect(p3.flushAll().status).toBe('conflict');

    const conflicts = listedRecords(store, 'scope-1')
      .filter((record) => record.kind === 'conflict')
      .map((record) => record.draft.text);
    expect(conflicts).toEqual(expect.arrayContaining(['第二个写入者', '第三个写入者']));
    // 两份副本 key 不同，因此都留下了。
    expect(new Set(listedRecords(store, 'scope-1').filter((r) => r.kind === 'conflict').map((r) => r.key)).size).toBe(2);
  });
});

describe('冲突副本 key 语义', () => {
  test('conflictKey 由目标与调用方提供的 conflictId 组成', () => {
    expect(conflictKey(targetA, 'x')).not.toBe(conflictKey(targetB, 'x'));
    expect(conflictKey(targetA, 'x')).not.toBe(conflictKey(targetA, 'y'));
  });
});

describe('TuiApp 输入保护集成（真实组件行为）', () => {
  test('挂载载入既有草稿只读：不产生任何写入', async () => {
    const fake = createFakePorts();
    fake.inputStore.write({
      key: targetDraftKey(targetB),
      expectedRevision: 0,
      record: {
        kind: 'draft',
        target: targetB,
        draft: { text: '既有草稿', cursor: 4, pasteBlocks: [] },
      },
    });
    const rendered = renderTui(fake.ports);
    await ready(rendered, fake);
    await waitFor(rendered, (frame) => frame.includes('既有草稿'));

    expect(fake.calls.filter((call) => call.name === 'inputStore.write')).toEqual([]);
    expect(fake.calls.filter((call) => call.name === 'inputStore.remove')).toEqual([]);
    rendered.unmount();
  });

  test('退出前立即保存：重启后多行草稿完整恢复', async () => {
    const fake = createFakePorts();
    const first = renderTui(fake.ports);
    await ready(first, fake);

    // 粘贴多行（bracketed paste），确认草稿正文真的含换行。
    first.stdin.write('\u001b[200~第一行\n第二行\u001b[201~');
    await waitFor(first, (frame) => frame.includes('第一行'));
    // Ctrl+C 会先立即保存未保存输入，再走退出；这里 onExit 是 no-op。
    await press(first, CTRL_C);
    first.unmount();

    const second = renderTui(fake.ports);
    const frame = await waitFor(second, (text) => text.includes('第二行'));
    expect(frame).toContain('第一行');
    expect(frame).toContain('第二行');
    const stored = recordAt(fake.inputStore, targetDraftKey(targetB));
    expect(draftText(stored)).toBe('第一行\n第二行');
    second.unmount();
  });

  test('提交结果只结清原快照：等待期间的新输入保留', async () => {
    const fake = createFakePorts();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ports: TuiPorts = {
      ...fake.ports,
      execute: (intent) => {
        fake.executeIntents.push(intent);
        return gate.then(
          (): ControllerCommandResult => ({ kind: 'accepted', revision: 1, summary: 'ok' }),
        );
      },
    };
    const rendered = renderTui(ports);
    await ready(rendered, fake);

    await press(rendered, '第一条');
    rendered.stdin.write(ENTER);
    await settle(2);
    // 连按第二次 Enter：等待位已占用，绝不产生第二次请求。
    rendered.stdin.write(ENTER);
    await settle(2);
    expect(fake.executeIntents).toHaveLength(1);
    // 结果还没回来时继续编辑。
    await press(rendered, '第二条');
    release();
    await settle(6);

    // 已受理：原快照被结清，但等待期间的新输入没有被清掉。
    const frame = frameText(rendered);
    expect(frame).toContain('第二条');
    const intent = fake.executeIntents[0];
    expect(intent?.kind === 'send-session-message' && intent.submissionId.length > 0).toBe(true);
    expect(fake.calls.filter((call) => call.name === 'inputStore.remove').length).toBeGreaterThan(0);
    rendered.unmount();
  });

  test('粘贴只插入并立即保存，不触发发送或命令', async () => {
    const fake = createFakePorts();
    const rendered = renderTui(fake.ports);
    await ready(rendered, fake);

    rendered.stdin.write('\u001b[200~粘贴第一行\n粘贴第二行\u001b[201~');
    await waitFor(rendered, (frame) => frame.includes('粘贴第一行'));

    expect(frameText(rendered)).toContain('粘贴第一行');
    expect(fake.executeIntents).toEqual([]);
    const stored = recordAt(fake.inputStore, targetDraftKey(targetB));
    expect(draftText(stored)).toBe('粘贴第一行\n粘贴第二行');
    rendered.unmount();
  });

  test('保存失败保留内存输入，默认留在界面并给出丢弃确认', async () => {
    const fake = createFakePorts({ inputStore: createFailingInputStore('capacity_exceeded') });
    const rendered = renderTui(fake.ports);
    await ready(rendered, fake);

    await press(rendered, '重要草稿');
    // 等到草稿真的进入 composer（选中 Session 已就绪）再触发退出。
    await waitFor(rendered, (frame) => frame.includes('重要草稿'));
    await press(rendered, CTRL_C);

    const frame = await waitFor(rendered, (text) => text.includes('capacity_exceeded'));
    expect(frame).toContain('重要草稿');
    expect(frame).toContain('capacity_exceeded');
    expect(frame).toContain('仍要退出并丢弃');
    rendered.unmount();
  });
});
