/**
 * 有界输入记录管理（IP-01/IP-03，`tui/input-protection` 的记录管理 Requirement）。
 *
 * 断言可观察事实：列表有界、正文视口有界、读取只读不写、恢复把记录正文放回 composer、
 * 核验 accepted 立即清理、删除需要二次确认。
 */

import { describe, expect, test } from 'vitest';

import {
  conflictKey,
  submissionKey,
  targetDraftKey,
  type UiInputRecord,
  type UiInputTarget,
} from '../../src/application/ports/ui-input-store.js';
import {
  INPUT_MANAGER_BODY_ROWS,
  INPUT_MANAGER_VISIBLE_ROWS,
  InputRecordManager,
  inputManagerBodyLines,
  type InputManagerEntry,
  type InputRecordManagerView,
} from '../../src/interfaces/tui/components/input-record-manager.js';
import { COMMAND_IDS } from '../../src/interfaces/tui/components/command-palette.js';
import {
  createFakePorts,
  frameText,
  renderComponent,
  renderTui,
  settle,
  type RenderedTui,
} from './harness.js';

const CTRL_P = '\u0010';
const ARROW_DOWN = '\u001b[B';
const ENTER = '\r';
const ESCAPE = '\u001b';

function msgTarget(coordinatorSessionId: string): UiInputTarget {
  return { kind: 'message', coordinationScopeId: 'scope-1', coordinatorSessionId };
}

function makeDraftRecord(index: number, text: string): UiInputRecord {
  return {
    key: `draft-key-${String(index)}`,
    revision: index + 1,
    kind: 'draft',
    target: msgTarget('session-a'),
    draft: { text, cursor: text.length, pasteBlocks: [] },
  };
}

function makeView(entries: readonly InputManagerEntry[], overrides: Partial<InputRecordManagerView> = {}): InputRecordManagerView {
  return {
    entries,
    usage: { records: entries.length, bytes: 128 },
    selectedIndex: 0,
    bodyScroll: 0,
    bodyFocus: false,
    feedback: null,
    confirmDelete: false,
    ...overrides,
  };
}

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

/** 从 Command Palette 打开输入记录管理。 */
async function openInputs(rendered: RenderedTui): Promise<void> {
  await press(rendered, CTRL_P);
  for (let step = 0; step < COMMAND_IDS.indexOf('input-record-manager'); step += 1) {
    await press(rendered, ARROW_DOWN);
  }
  await press(rendered, ENTER);
}

function listed(fake: ReturnType<typeof createFakePorts>) {
  const result = fake.inputStore.list('scope-1');
  if (result.kind !== 'records') {
    throw new Error(`列举失败：${result.code} ${result.message}`);
  }
  return result.records;
}

describe('记录管理展示有界', () => {
  test('列表最多渲染 20 行并提示滚动', () => {
    const entries: InputManagerEntry[] = Array.from({ length: 25 }, (_, index) => ({
      kind: 'record' as const,
      record: makeDraftRecord(index, `第 ${String(index)} 条`),
    }));
    const rendered = renderComponent(
      <InputRecordManager view={makeView(entries)} availableWidth={100} />,
    );
    const rows = frameText(rendered).split('\n').filter((line) => line.includes('· draft ·'));
    expect(rows).toHaveLength(INPUT_MANAGER_VISIBLE_ROWS);
    expect(frameText(rendered)).toContain('列表滚动');
    rendered.unmount();
  });

  test('正文视口有界：只返回视口行数，滚动后从对应行开始', () => {
    const text = Array.from({ length: 1000 }, (_, index) => `line-${String(index)}`).join('\n');
    const entries: InputManagerEntry[] = [{ kind: 'record', record: makeDraftRecord(0, text) }];

    const head = inputManagerBodyLines(makeView(entries), 40);
    expect(head).toHaveLength(INPUT_MANAGER_BODY_ROWS);
    expect(head[0]).toBe('line-0');

    const scrolled = inputManagerBodyLines(makeView(entries, { bodyScroll: 5 }), 40);
    expect(scrolled[0]).toBe('line-5');
  });

  test('不可读记录只显示身份并标注只能删除', () => {
    const entries: InputManagerEntry[] = [{ kind: 'invalid', key: 'broken-1', revision: 9 }];
    const rendered = renderComponent(
      <InputRecordManager view={makeView(entries)} availableWidth={100} />,
    );
    const frame = frameText(rendered);
    expect(frame).toContain('不可读记录 rev=9');
    expect(frame).toContain('只能删除');
    rendered.unmount();
  });

  test('删除二次确认提示可见', () => {
    const entries: InputManagerEntry[] = [{ kind: 'record', record: makeDraftRecord(0, '草稿') }];
    const rendered = renderComponent(
      <InputRecordManager view={makeView(entries, { confirmDelete: true })} availableWidth={100} />,
    );
    expect(frameText(rendered)).toContain('确认删除选中记录');
    rendered.unmount();
  });
});

describe('记录管理经容器执行', () => {
  test('挂载载入既有草稿只读，不产生写入', async () => {
    const fake = createFakePorts();
    fake.inputStore.write({
      key: targetDraftKey(msgTarget('session-b')),
      expectedRevision: 0,
      record: {
        kind: 'draft',
        target: msgTarget('session-b'),
        draft: { text: '既有草稿正文', cursor: 6, pasteBlocks: [] },
      },
    });
    const rendered = renderTui(fake.ports);
    await waitFor(rendered, (frame) => frame.includes('既有草稿正文'));

    expect(fake.calls.filter((call) => call.name === 'inputStore.write')).toEqual([]);
    expect(fake.calls.filter((call) => call.name === 'inputStore.remove')).toEqual([]);
    rendered.unmount();
  });

  test('从 Command Palette 打开记录管理并核验 accepted 后立即清理', async () => {
    const fake = createFakePorts({
      submissionStatus: () =>
        Promise.resolve({ kind: 'accepted', ref: { kind: 'user-message', id: 'entry:user:sub-1' } }),
    });
    fake.inputStore.write({
      key: submissionKey(msgTarget('session-b'), 'sub-1'),
      expectedRevision: 0,
      record: {
        kind: 'submission',
        target: msgTarget('session-b'),
        draft: { text: '待核验内容', cursor: 5, pasteBlocks: [] },
        submissionId: 'sub-1',
        status: 'awaiting',
        reason: null,
      },
    });
    const rendered = renderTui(fake.ports);
    await waitFor(rendered, (frame) => frame.includes('composer · 普通消息'));

    await openInputs(rendered);
    const opened = await waitFor(rendered, (frame) => frame.includes('输入记录管理'));
    expect(opened).toContain('sub-1');
    expect(opened).toContain('awaiting');

    await press(rendered, 'v');
    const verified = await waitFor(rendered, (frame) => frame.includes('已受理'));
    expect(verified).toContain('已受理');
    expect(fake.calls.some((call) => call.name === 'submissionStatus')).toBe(true);
    expect(listed(fake).some((record) => record.kind === 'submission')).toBe(false);

    rendered.unmount();
  });

  test('删除需要二次确认：第一次只提问，y 之后才删除', async () => {
    const fake = createFakePorts();
    fake.inputStore.write({
      key: targetDraftKey(msgTarget('session-a')),
      expectedRevision: 0,
      record: {
        kind: 'draft',
        target: msgTarget('session-a'),
        draft: { text: '待删除草稿', cursor: 5, pasteBlocks: [] },
      },
    });
    const rendered = renderTui(fake.ports);
    await waitFor(rendered, (frame) => frame.includes('composer · 普通消息'));

    await openInputs(rendered);
    await waitFor(rendered, (frame) => frame.includes('待删除草稿'));

    await press(rendered, 'd');
    expect(await waitFor(rendered, (frame) => frame.includes('确认删除选中记录'))).toContain('确认删除选中记录');
    // 只提问，还没有删除。
    expect(listed(fake).some((record) => record.kind !== 'submission')).toBe(true);

    await press(rendered, 'n');
    expect(frameText(rendered)).not.toContain('确认删除选中记录');
    expect(listed(fake).some((record) => record.kind !== 'submission')).toBe(true);

    await press(rendered, 'd');
    await waitFor(rendered, (frame) => frame.includes('确认删除选中记录'));
    await press(rendered, 'y');
    expect(await waitFor(rendered, (frame) => frame.includes('记录已删除'))).toContain('记录已删除');
    expect(listed(fake)).toEqual([]);

    rendered.unmount();
  });

  test('恢复冲突副本：正文回到当前 composer，且库内另一方版本被备份保留', async () => {
    const fake = createFakePorts();
    fake.inputStore.write({
      key: conflictKey(msgTarget('session-b'), 'c1'),
      expectedRevision: 0,
      record: {
        kind: 'conflict',
        target: msgTarget('session-b'),
        draft: { text: '冲突副本正文', cursor: 6, pasteBlocks: [] },
      },
    });
    fake.inputStore.write({
      key: targetDraftKey(msgTarget('session-b')),
      expectedRevision: 0,
      record: {
        kind: 'draft',
        target: msgTarget('session-b'),
        draft: { text: '库内当前正文', cursor: 6, pasteBlocks: [] },
      },
    });
    const rendered = renderTui(fake.ports);
    await waitFor(rendered, (frame) => frame.includes('库内当前正文'));

    await openInputs(rendered);
    await waitFor(rendered, (frame) => frame.includes('冲突副本正文'));
    await press(rendered, 'r');
    expect(await waitFor(rendered, (frame) => frame.includes('已把 conflict 记录的正文恢复'))).toContain(
      '已把 conflict 记录的正文恢复',
    );

    await press(rendered, ESCAPE);
    await settle(2);
    expect(frameText(rendered)).toContain('冲突副本正文');
    // 被覆盖的库内版本另存为冲突副本，双方都还在。
    const texts = listed(fake)
      .filter((record) => record.kind === 'conflict')
      .map((record) => record.draft.text);
    expect(texts).toContain('库内当前正文');

    rendered.unmount();
  });
});

