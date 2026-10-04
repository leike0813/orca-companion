import { expect, test } from 'vitest';

import { projectContextObservation } from '../../src/application/tui/project-presentation.js';

const binding = {
  coordinatorSessionId: 'session-current',
  modelConfigurationRef: 'model-config-current',
  effectiveInputRevision: 7,
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
