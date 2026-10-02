import { expect, test } from 'vitest';
import { userQuestionTool } from '../../src/workflow/coordinator/interaction-tools.js';
import type { OperationId } from '../../src/application/dto/identity.js';

test('ask_user 验证一题、唯一选项、有界正文并转发可信操作身份', async () => {
  const calls: unknown[] = [];
  const tool = userQuestionTool((question, context) => { calls.push({ question, context }); return Promise.resolve({ kind: 'ok', value: 'saved' }); });
  const context = { operationId: 'op-question' as OperationId, mapOperationId: null };
  for (const input of [{ question: '' }, { question: '问题', scope: 'forged' }, { question: '问题', options: [{ label: '同' }, { label: '同' }] },
    { question: 'x'.repeat(20001) }, { question: '问题', options: Array.from({ length: 9 }, (_, index) => ({ label: String(index) })) }]) {
    expect(await tool.invoke(input, context)).toMatchObject({ kind: 'rejected', code: 'invalid_question' });
  }
  expect(calls).toHaveLength(0);
  expect(await tool.invoke({ question: '怎么继续？', options: [{ label: '继续', description: '完成实现' }] }, context)).toMatchObject({ kind: 'ok' });
  expect(calls).toEqual([{ question: { text: '怎么继续？', options: [{ label: '继续', description: '完成实现' }] }, context }]);
});
