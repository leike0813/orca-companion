import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createWorkerHarness } from '../../application/ports/worker-harness.js';
import { createCodexWorkerLaunch, createCodexResumeLaunch, installCodexSessionStartReporter } from './codex-launch.js';
import { proveCodexTranscript, inspectCodexTranscript, readCodexTranscriptIdentity } from './codex-transcript.js';
import { probeHarnessReadOnlyWorker } from './read-only-execution-wrapper.js';
import { queryWorkerModels } from './worker-model-catalog.js';

export const codexHarness = createWorkerHarness({
  id: 'codex',
  prepareLaunch: createCodexWorkerLaunch,
  prepareReadOnlyLaunch: (input) => createCodexWorkerLaunch({ ...input, sandboxMode: 'read-only-local-control' }),
  probe: (modelSelection) => probeHarnessReadOnlyWorker('codex', modelSelection),
  queryModels: (input) => queryWorkerModels({ ...input, harness: 'codex' }),
  prepareResume: (input) => createCodexResumeLaunch({ ...input, codexHome: input.originalStateRoot }),
  readTranscriptIdentity: (input) => Promise.resolve(readCodexTranscriptIdentity(input)),
  recoveryInstructions: () => [
    '用一个 Node 脚本一次读完所有非空行并 JSON.parse 每一行，只按脚本输出结论；不要倾泻正文或重复读取同一段。',
    '事件引用规则：记录自带 ordinal 字段时用 ordinal:<值>；否则有非空 timestamp 时用 timestamp:<值>；都没有时用 line:<行号>（行号从 1 起）。',
  ],
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
});
