import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { WorkerHarnessLaunchInput, PreparedHarnessTerminal } from '../../application/ports/worker-harness.js';
import type { PreparedTerminalStrategy } from '../../application/worker-launch.js';
import { workerModelSelectionSchema } from '../../domain/model-configuration.js';
import { CODEX_MODEL_DESCRIPTOR_VERSION, codexModelLaunchCommand, writeCodexModelLaunch } from './codex-model-launcher.js';
import { assertReadOnlyExecutionWrapperAvailable } from './read-only-execution-wrapper.js';
import { readReportingText } from './worker-harness-reporting.js';

export type CandidateResume = { readonly sessionId: string; readonly originalStateRoot: string; readonly transcriptRef: string };

export function candidateSessionPaths(harness: string, root: string, launchId: string) {
  const stateRoot = join(root, harness, createHash('sha256').update(launchId).digest('hex').slice(0, 20));
  return { stateRoot, reporterPath: join(stateRoot, 'session-start.mjs'), reportPath: join(stateRoot, 'session-start.jsonl') };
}

export function installCandidateReporter(paths: { readonly reporterPath: string; readonly reportPath: string }, source: string): void {
  mkdirSync(dirname(paths.reporterPath), { recursive: true, mode: 0o700 });
  try {
    if (readReportingText(paths.reporterPath, 65536) !== source) throw new Error('Worker reporter content conflicts');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    writeFileSync(paths.reporterPath, source, { flag: 'wx', mode: 0o600 });
  }
}

/** Candidate adapters use the same terminal descriptor and OS boundary as registered Workers. */
export function prepareCandidateLaunch(options: {
  readonly harness: string;
  readonly executable: string;
  readonly input: WorkerHarnessLaunchInput;
  readonly resume?: CandidateResume;
  readonly arguments: (workspace: string) => readonly string[];
  readonly reporterSource: (reportPath: string, runtimeReportPath: string) => string;
  readonly checkSetup: () => void | Promise<void>;
  readonly verifyResume?: (workspace: string, resume: CandidateResume) => Promise<void>;
}): PreparedTerminalStrategy<PreparedHarnessTerminal> {
  if (!options.input.launchId || !workerModelSelectionSchema.safeParse(options.input.modelSelection).success) {
    throw new Error('Worker launch/model selection invalid');
  }
  const title = `orca-companion:${options.harness}:${createHash('sha256').update(options.input.launchId).digest('hex').slice(0, 20)}`;
  return {
    // Orca worker-start submits the preamble; another Enter can consume or clear that input.
    kind: 'prepared_terminal', harness: options.harness, activation: 'none', title,
    prepare: async ({ worktreePath }) => {
      if (!isAbsolute(worktreePath) || (options.input.stateRoot !== undefined && !isAbsolute(options.input.stateRoot))) {
        throw new Error('Worker workspace/artifacts must be absolute paths');
      }
      await options.checkSetup();
      if (options.resume !== undefined) {
        if (options.verifyResume === undefined) throw new Error('Resume identity verifier missing');
        await options.verifyResume(worktreePath, options.resume);
      }
      const readOnly = options.input.sandboxMode === 'read-only' || options.input.sandboxMode === 'read-only-local-control';
      if (readOnly) await assertReadOnlyExecutionWrapperAvailable();
      const paths = candidateSessionPaths(options.harness, options.input.stateRoot ?? join(worktreePath, '.companion'), options.input.launchId);
      const reporterPath = options.input.sessionStartReporterPath ?? paths.reporterPath;
      const stateRoot = dirname(reporterPath);
      const reportPath = join(dirname(reporterPath), 'session-start.jsonl');
      const runtimeReportPath = join(dirname(reporterPath), 'native-runtime.json');
      mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
      installCandidateReporter({ reporterPath, reportPath }, options.reporterSource(reportPath, runtimeReportPath));
      const launch = writeCodexModelLaunch({ stateRoot, descriptor: {
        version: CODEX_MODEL_DESCRIPTOR_VERSION, executable: options.executable, harness: options.harness,
        args: options.arguments(worktreePath), reporterPath, runtimeReportPath,
        ...(options.resume === undefined ? {} : { expectedStateRoot: options.resume.originalStateRoot }),
        ...(readOnly ? { readOnly: { workspace: worktreePath, stateRoot } } : {}),
      } });
      return { title, stateRoot, command: codexModelLaunchCommand(launch) };
    },
  };
}
