import { expect, test } from 'vitest';

import { projectContextObservation, projectContextStatus } from '../../src/application/tui/project-presentation.js';

const binding = {
  coordinatorSessionId: 'session-current',
  modelConfigurationRef: 'model-config-current',
  effectiveInputRevision: 7,
  contextWindow: 200_000,
};

const observation = {
  status: 'available' as const,
  used: 42,
  capacity: 128_000,
  observationId: 'observation-1',
  coordinatorSessionId: 'session-current',
  modelConfigurationRef: 'model-config-current',
  effectiveInputRevision: 7,
};

test('projects exact context only for the current session, model configuration and effective input', () => {
  expect(projectContextObservation(observation, binding)).toEqual(observation);
  expect(projectContextObservation(observation, { ...binding, coordinatorSessionId: 'session-other' }))
    .toEqual({ status: 'unavailable' });
  expect(projectContextObservation(observation, { ...binding, modelConfigurationRef: 'model-config-other' }))
    .toEqual({ status: 'unavailable' });
  expect(projectContextObservation(observation, { ...binding, effectiveInputRevision: 8 }))
    .toEqual({ status: 'unavailable' });
});

test('missing, malformed and impossible context measurements remain unavailable', () => {
  expect(projectContextObservation(null, binding)).toEqual({ status: 'unavailable' });
  expect(projectContextObservation({ ...observation, used: 128_001 }, binding)).toEqual({ status: 'unavailable' });
  expect(projectContextObservation(observation, { ...binding, coordinatorSessionId: null }))
    .toEqual({ status: 'unavailable' });
});

const lastRequest = { stepId: 'step-9', configurationRef: 'model-config-current' as string | null,
  usage: { inputTokens: 12_000, outputTokens: 300, totalTokens: 12_300 } };

test('the exact current measurement wins over the last request usage of the same configuration', () => {
  expect(projectContextStatus(observation, lastRequest, binding)).toEqual(observation);
});

test('without a current measurement the last request usage is shown with its own bindings', () => {
  expect(projectContextStatus(null, lastRequest, binding)).toEqual({
    status: 'last_request',
    inputTokens: 12_000,
    outputTokens: 300,
    totalTokens: 12_300,
    capacity: 200_000,
    coordinatorSessionId: 'session-current',
    modelConfigurationRef: 'model-config-current',
    stepId: 'step-9',
  });
  expect(projectContextStatus(null, { ...lastRequest, usage: null }, binding))
    .toEqual({ status: 'unavailable' });
});

test('usage measured under another configuration or with an unknown window never borrows a capacity', () => {
  expect(projectContextStatus(null, { ...lastRequest, configurationRef: 'model-config-other' }, binding))
    .toEqual({ status: 'unavailable' });
  expect(projectContextStatus(null, null, binding)).toEqual({ status: 'unavailable' });
  expect(projectContextStatus(null, lastRequest, { ...binding, coordinatorSessionId: null }))
    .toEqual({ status: 'unavailable' });
  expect(projectContextStatus(null, lastRequest, { ...binding, contextWindow: null })).toMatchObject({
    status: 'last_request', capacity: null,
  });
  // 未取得 usage 或不知道它属于哪套配置时，明确不可用而不是借当前配置的窗口。
  expect(projectContextStatus(null, { ...lastRequest, configurationRef: null }, binding))
    .toEqual({ status: 'unavailable' });
});
