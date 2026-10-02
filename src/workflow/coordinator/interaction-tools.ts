import { isUserQuestion } from '../../application/ports/branch-coordination-store.js';
import { MAX_USER_MESSAGE_CHARS } from '../../application/coordinator/user-message.js';
import { asRecord, toolInputSchema, type CoordinatorToolDefinition, type CoordinatorToolCallContext, type CoordinatorToolOutcome } from './tool-definition.js';

export function userQuestionTool(create: (question: unknown, context: CoordinatorToolCallContext) => Promise<CoordinatorToolOutcome> | CoordinatorToolOutcome): CoordinatorToolDefinition {
  return {
    name: 'ask_user', description: '向当前 Session 的用户提出一个问题，可给至多八个选项；用户也可自由回答。创建不会自动挂起。', mutating: true,
    inputSchema: toolInputSchema({
      question: { type: 'string', minLength: 1, maxLength: MAX_USER_MESSAGE_CHARS },
      options: { type: 'array', maxItems: 8, items: toolInputSchema({ label: { type: 'string', minLength: 1 }, description: { type: 'string' } }, ['label']) },
    }, ['question']),
    invoke(input, context) {
      const value = asRecord(input);
      const question = value === null ? null : { text: value['question'], options: value['options'] ?? [] };
      if (value === null || Object.keys(value).some((key) => key !== 'question' && key !== 'options') || !isUserQuestion(question)) {
        return Promise.resolve({ kind: 'rejected', code: 'invalid_question', message: '问题或选项格式无效' });
      }
      return Promise.resolve(create(question, context));
    },
  };
}
