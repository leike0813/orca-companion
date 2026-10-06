import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { PreparedTerminalStrategy } from '../../application/worker-launch.js';
import type { WorkerHarnessLaunchInput } from '../../application/ports/worker-harness.js';
import {
  assertLaunchableModelConfiguration, buildCodexModelLaunchDescriptor,
  codexConfigValue, codexModelLaunchCommand, SAFE_CODEX_SESSION_ID, writeCodexModelLaunch,
} from './codex-model-launcher.js';
import { READ_ONLY_EXECUTION_PROFILE } from './read-only-execution-wrapper.js';
import { WORKER_RUNTIME_SOURCE } from './worker-runtime.js';

export const CODEX_HOOK_TRUST_BYPASS_ARG = '--dangerously-bypass-hook-trust';
export const CODEX_UTILITY_PERMISSION_PROFILE = READ_ONLY_EXECUTION_PROFILE;
export type PreparedCodexTerminal = {
  readonly title: string; readonly command: string; readonly stateRoot: string;
};

export function installCodexSessionStartReporter(paths: { readonly reporterPath: string; readonly reportPath: string }): void {
  mkdirSync(dirname(paths.reporterPath), { recursive: true });
  const source = [
    "import { appendFileSync, existsSync } from 'node:fs';",
    "import { homedir } from 'node:os';",
    "import { dirname, isAbsolute, join, resolve } from 'node:path';",
    WORKER_RUNTIME_SOURCE,
    "let input = ''; for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 65536) throw new Error('hook input exceeds limit'); }",
    'const event = JSON.parse(input);',
    "const runtime = nativeWorkerRuntime('codex');",
    'const report = { harness: "codex", sessionId: event.session_id ?? null, transcriptPath: event.transcript_path ?? null, codexHome: runtime.stateRoot, stateRoot: runtime.stateRoot, runtimeRoots: runtime.writableRoots, cwd: event.cwd ?? null, observedAt: new Date().toISOString() };',
    'appendFileSync(' + JSON.stringify(paths.reportPath) + ', JSON.stringify(report) + "\\n", { mode: 0o600 });',
    'process.stdout.write("{}\\n");',
  ].join('\n');
  if (!existsSync(paths.reporterPath) || readFileSync(paths.reporterPath, 'utf8') !== source) {
    writeFileSync(paths.reporterPath, source, { mode: 0o600 });
  }
}
function shellQuote(value: string): string { return "'" + value.replaceAll("'", "'\"'\"'") + "'"; }
function hookArguments(reporterPath: string | undefined): readonly string[] {
  if (reporterPath === undefined) return [];
  if (!isAbsolute(reporterPath)) throw new Error('SessionStart reporter 必须是绝对路径');
  const encoded = codexConfigValue([{
    matcher: 'startup|resume',
    hooks: [{ type: 'command', command: shellQuote(process.execPath) + ' ' + shellQuote(reporterPath), timeout: 10 }],
  }]);
  if (encoded === null) throw new Error('SessionStart hook 无法编码');
  return ['-c', 'hooks.SessionStart=' + encoded];
}
type CodexLaunchInput = WorkerHarnessLaunchInput & { readonly codexExecutable?: string };
function launch(input: CodexLaunchInput, resume?: { readonly sessionId: string; readonly codexHome: string }): PreparedTerminalStrategy<PreparedCodexTerminal> {
  if (!input.launchId) throw new Error('Codex launchId 必须非空');
  const digest = createHash('sha256').update(input.launchId).digest('hex').slice(0, 20);
  const title = 'orca-companion:codex:' + digest;
  return {
    kind: 'prepared_terminal', harness: 'codex', activation: 'submit_draft', title,
    prepare: ({ worktreePath }) => {
      if (!isAbsolute(worktreePath) || (input.stateRoot !== undefined && !isAbsolute(input.stateRoot))) throw new Error('Worker 工件必须使用绝对路径');
      assertLaunchableModelConfiguration(input.modelSelection);
      const hooks = hookArguments(input.sessionStartReporterPath);
      if (resume !== undefined && (!SAFE_CODEX_SESSION_ID.test(resume.sessionId) || !isAbsolute(resume.codexHome))) throw new Error('Codex 原 Session 身份不可核验');
      const stateRoot = join(input.stateRoot ?? join(worktreePath, '.companion', 'codex'), digest);
      const readOnly = input.sandboxMode === 'read-only' || input.sandboxMode === 'read-only-local-control';
      const descriptor = buildCodexModelLaunchDescriptor({
        modelSelection: input.modelSelection,
        baseArguments: [CODEX_HOOK_TRUST_BYPASS_ARG, '--no-daemon', '--no-alt-screen', '--ask-for-approval', 'never', ...hooks],
        sandboxArguments: ['--sandbox', readOnly ? 'danger-full-access' : input.sandboxMode],
        ...(input.codexExecutable === undefined ? {} : { executable: input.codexExecutable }),
        ...(resume === undefined ? {} : { resumeSessionId: resume.sessionId, expectedStateRoot: resume.codexHome }),
      });
      mkdirSync(stateRoot, { recursive: true });
      const paths = writeCodexModelLaunch({ stateRoot, descriptor: {
        ...descriptor,
        runtimeReportPath: join(stateRoot, 'native-runtime.json'),
        ...(readOnly ? { readOnly: { workspace: worktreePath, stateRoot, ...(input.sessionStartReporterPath === undefined ? {} : { reportDirectory: dirname(input.sessionStartReporterPath) }) } } : {}),
      } });
      return Promise.resolve({ title, stateRoot, command: codexModelLaunchCommand(paths) });
    },
  };
}
export function createCodexWorkerLaunch(input: CodexLaunchInput): PreparedTerminalStrategy<PreparedCodexTerminal> {
  return launch(input);
}
export function createCodexResumeLaunch(input: CodexLaunchInput & { readonly sessionId: string; readonly codexHome: string }): PreparedTerminalStrategy<PreparedCodexTerminal> {
  return launch(input, { sessionId: input.sessionId, codexHome: input.codexHome });
}
