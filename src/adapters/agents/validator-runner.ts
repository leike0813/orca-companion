/**
 * IC-08 / IP-04：Validator 步骤执行的生产 adapter（Owner: `m2-wire-execution-runtime`）。
 *
 * `runValidation` 拥有「验证 → 范围内修复 → 复验」的顺序与准入规则，但每一步都要落到**同一条真实
 * harness session** 上。本模块就是那个 seam：它把可证明的 Session Binding 固定住，只把与之一致的步骤
 * 结论放行出去；任何一步报告了不同的 session、或绑定本身读不到，都按用例已有的 `session_lost` 语义
 * 返回——绝不把新 session 当作原 Validation Attempt 的继续，也绝不把「读不到」写成「验证通过」。
 *
 * 这里不做判定、不读存储、不派发 Worker：角色分离、修复预算、Scope Envelope 与证据覆盖全部仍由
 * `run-validation.ts` 判定，本模块只负责「这一步确实发生在同一条 session 上」这一件事。
 */

import {
  sessionBindingMatches,
  type ValidatorStepRequest,
  type ValidatorStepResult,
  type ValidatorStepRunner,
} from '../../application/run-validation.js';
import type { SessionBinding } from '../../domain/task-contract.js';

/** 读不到 harness session 绑定的事实；给出它即代表「这条验证链不能继续」，而不是一个新的会话。 */
export type ValidatorSessionUnavailable = {
  readonly kind: 'unavailable';
  readonly code: string;
  readonly message: string;
};

/**
 * 可证明的 harness session 绑定来源。
 *
 * 真实实现由 Worker Harness Adapter 提供（含 provider session 身份）；读不到时必须返回
 * `unavailable`，不得用「最近一次使用的 binding」或新建立的会话顶替。
 */
export type ValidatorSessionBindingSource = () => Promise<SessionBindingFact>;

type SessionBindingFact = SessionBinding | ValidatorSessionUnavailable;

/** 读不到与已证明的判别：只有显式标记 `kind: 'unavailable'` 的值算读不到，否则 narrowing 会丢。 */
function isSessionUnavailable(fact: SessionBindingFact): fact is ValidatorSessionUnavailable {
  return 'kind' in fact && fact.kind === 'unavailable';
}

/** 一条已绑定的真实 harness 会话：步骤执行通道本身就要求带出该步观察到的 Session Binding。 */
export type ValidatorHarnessSession = {
  readonly runStep: ValidatorStepRunner;
};

/**
 * 构造 `runValidation` 使用的步骤 runner。
 *
 * 每一步都重新读取绑定：会话可能在修复过程中丢失，因此「上一步成立」不能证明「这一步成立」。
 */
export function createValidatorStepRunner(input: {
  readonly bindSession: ValidatorSessionBindingSource;
  readonly session: ValidatorHarnessSession;
}): ValidatorStepRunner {
  return async (request: ValidatorStepRequest): Promise<ValidatorStepResult> => {
    const bound = await input.bindSession();
    // 绑定读不到、或与本次请求不一致：这条链不能继续，也不允许换一条 session 继续。
    if (isSessionUnavailable(bound)) {
      return {
        kind: 'session_lost',
        reason: `Validator 步骤未落在同一条真实 session 上：${bound.code}: ${bound.message}`,
      };
    }
    if (!sessionBindingMatches(bound, request.sessionBinding)) {
      return {
        kind: 'session_lost',
        reason: 'Validator 步骤未落在同一条真实 session 上：本次请求的 Session Binding 与可证明的 harness session 不一致',
      };
    }
    let step: ValidatorStepResult;
    try {
      step = await input.session.runStep(request);
    } catch (error) {
      return {
        kind: 'step_failed',
        code: 'session_channel_failed',
        message: error instanceof Error ? error.message : 'harness 会话通道抛出了非 Error 值',
      };
    }
    if (step.kind === 'session_lost' || step.kind === 'escalation' || step.kind === 'step_failed') {
      return step;
    }
    return sessionBindingMatches(bound, step.sessionBinding)
      ? step
      : {
          kind: 'session_lost',
          reason:
            'Validator 步骤未落在同一条真实 session 上：步骤结论携带的 Session Binding 与可证明的 harness session 不一致',
        };
  };
}
