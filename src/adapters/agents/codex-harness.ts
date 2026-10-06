import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { WorkerHarness } from '../../application/ports/worker-harness.js';
import { createCodexWorkerLaunch, createCodexResumeLaunch, installCodexSessionStartReporter } from './codex-launch.js';
import { proveCodexTranscript, inspectCodexTranscript } from './codex-transcript.js';
import { probeHarnessReadOnlyWorker } from './read-only-execution-wrapper.js';
import { queryWorkerModels } from './worker-model-catalog.js';

export const codexHarness: WorkerHarness = {
  id: 'codex',
  prepareLaunch: createCodexWorkerLaunch,
  prepareReadOnlyLaunch: (input) => createCodexWorkerLaunch({ ...input, sandboxMode: 'read-only-local-control' }),
  probe: (modelSelection) => probeHarnessReadOnlyWorker('codex', modelSelection),
  queryModels: (input) => queryWorkerModels({ ...input, harness: 'codex' }),
  prepareResume: (input) => createCodexResumeLaunch({ ...input, codexHome: input.originalStateRoot }),
  sessionPaths: (root, launchId) => {
    const stateRoot = join(root, 'codex');
    const id = createHash('sha256').update(launchId).digest('hex').slice(0, 20);
    return { stateRoot, reporterPath: join(stateRoot, 'reporters', `${id}.mjs`), reportPath: join(stateRoot, 'reporters', `${id}.jsonl`) };
  },
  installReporter: installCodexSessionStartReporter,
  proveSession: (input) => Promise.resolve(proveCodexTranscript({
    ...input,
    report: { ...input.report, codexHome: input.report.codexHome ?? null },
    expectedCodexHome: input.expectedStateRoot,
  })),
  inspectTranscript: inspectCodexTranscript,
};
