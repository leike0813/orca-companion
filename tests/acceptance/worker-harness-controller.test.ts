/**
 * IP-04: mixed native Worker Harnesses through the real foreground Controller.
 *
 * Requires a one-shot schema-5 project with a dedicated Orca identity, exact
 * planning/validation profiles, and a local bare `origin`. Planner and
 * Implementation run on the harness selected by
 * ORCA_COMPANION_IP04_MIXED_CONTROLLER_PLANNING_HARNESS (default command-code,
 * only command-code/antigravity accepted on a real run); Validator, Finalizer
 * and Recovery Utility stay on Qwen. This file is inert unless explicitly
 * enabled; it never creates or cleans up that fixture.
 */
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { buildExecutionScope, type ExecutionBackend, type WorktreeListResult } from '../../src/application/ports/execution-backend.js';
import { openRepositoryCoordinationStore } from '../../src/bootstrap/composition.js';
import { createForegroundPlanningHost, type ForegroundPlanningHost } from '../../src/bootstrap/foreground-planning-runtime.js';
import { createOrcaDoctorProbe, type DoctorProbe } from '../../src/bootstrap/doctor.js';
import { createOrcaExecutionBackend } from '../../src/adapters/orca-cli/orca-backend.js';
import type { RunSummary, TerminalListResult, WorkerShowResult } from '../../src/adapters/orca-cli/operation-catalog.js';
import { runProcess } from '../../src/adapters/orca-cli/process-runner.js';
import { parseProjectConfig } from '../../src/application/configuration/project-config.js';
import type { IssueTrackerGateway } from '../../src/application/planning/route-map-service.js';
import { emptyRouteMapBody } from '../../src/application/planning/route-map-initialization.js';
import { qwenHarness } from '../../src/adapters/agents/qwen-harness.js';
import { HARNESS_MATRIX, resolveAcceptancePlan, installAcceptanceCandidates } from '../support/worker-harness-acceptance.js';
import { REAL_LOOP_SINGLE_PLAN, seedRealExecutionScope } from '../support/real-execution-scope.js';
import { toChildEnvironment } from '../../src/interfaces/cli/main.js';
import type { CoordinationScopeId } from '../../src/application/dto/identity.js';

const ENABLED = process.env['ORCA_COMPANION_IP04_MIXED_CONTROLLER'] === '1';
const PROJECT = process.env['ORCA_COMPANION_IP04_MIXED_CONTROLLER_REPO'] ?? '';
const IDENTITY = process.env['ORCA_COMPANION_IP04_MIXED_CONTROLLER_IDENTITY'] ?? '';
const MODEL = 'MiniMax-M3.1-Flash-Preview';
const CONFIG_HOME = process.env['ORCA_COMPANION_IP04_MIXED_CONTROLLER_CONFIG_HOME'] ?? '';
const SCOPE_ID = process.env['ORCA_COMPANION_IP04_MIXED_CONTROLLER_SCOPE'] ?? '';
const FIXTURE_ANSWER = process.env['ORCA_COMPANION_IP04_MIXED_CONTROLLER_ANSWER'] ?? '';
const MAX_TRANSCRIPT_BYTES = 1024 * 1024;
const PLANNING_HARNESS = process.env['ORCA_COMPANION_IP04_MIXED_CONTROLLER_PLANNING_HARNESS']?.trim() || 'command-code';
if (ENABLED && !['command-code', 'antigravity'].includes(PLANNING_HARNESS)) {
  throw new Error(`ORCA_COMPANION_IP04_MIXED_CONTROLLER_PLANNING_HARNESS 只接受 command-code 或 antigravity：${PLANNING_HARNESS}`);
}
const PLANNING_MODEL = HARNESS_MATRIX.find((entry) => entry.harness === PLANNING_HARNESS)?.modelSelection.model ?? '';
const HARNESS_SELECTION = `${PLANNING_HARNESS},qwen-code`;
const EXPECTED_PROFILES: Readonly<Record<'planner' | 'implementation' | 'validator' | 'finalizer' | 'recovery_utility',
  readonly [string, string]>> = {
  planner: [PLANNING_HARNESS, PLANNING_MODEL],
  implementation: [PLANNING_HARNESS, PLANNING_MODEL],
  validator: ['qwen-code', MODEL],
  finalizer: ['qwen-code', MODEL],
  recovery_utility: ['qwen-code', MODEL],
};
const candidatePlan = resolveAcceptancePlan({
  ...process.env,
  ORCA_COMPANION_REAL_ACCEPTANCE: '1',
  ORCA_COMPANION_REAL_ACCEPTANCE_HARNESSES: HARNESS_SELECTION,
});
const restoreCandidates = ENABLED && candidatePlan.kind === 'run'
  ? installAcceptanceCandidates(candidatePlan)
  : () => undefined;
afterAll(() => restoreCandidates());

async function completed(executable: string, args: readonly string[], cwd: string): Promise<string> {
  const result = await runProcess({ executable, args, cwd, env: toChildEnvironment(process.env), timeoutMs: 30_000 });
  if (result.kind !== 'completed' || result.exitCode !== 0) {
    throw new Error(`${executable} ${args[0] ?? ''} failed (${result.kind})`);
  }
  return result.stdout.text.trim();
}

async function controllerSnapshot(host: ForegroundPlanningHost) {
  const loaded = await host.ports.snapshot(null);
  if (loaded.kind !== 'snapshot') throw new Error(`Controller snapshot unavailable: ${loaded.code}`);
  return loaded.snapshot;
}

function progress(message: string): void {
  process.stdout.write(`[IP-04] ${message}\n`);
}

function writeControllerEvidence(value: Readonly<Record<string, unknown>>): { readonly json: string; readonly markdown: string } {
  const directory = join(process.cwd(), 'artifacts', 'next-worker-harness-adapters');
  mkdirSync(directory, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(/[-:.]/gu, '');
  const stem = `controller-${stamp}-${randomUUID()}`;
  const json = join(directory, `${stem}.json`);
  const markdown = join(directory, `${stem}.md`);
  const serialized = JSON.stringify(value, null, 2) + '\n';
  writeFileSync(json, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  const summary = [
    '# Mixed Controller acceptance evidence',
    '',
    `- Result: ${String(value['result'])}`,
    `- Scope: ${String(value['coordinationScopeId'])}`,
    `- Run: ${String(value['orcaRunId'])}`,
    `- Profiles: ${String(value['profiles'])}`,
    `- Verdict: ${String(value['verdictKind'])} (${String(value['verdictId'])})`,
    `- Bindings: ${String(value['bindingCount'])}; recoveries: ${String(value['recoveryCount'])}; settlements: ${String(value['settlementCount'])}`,
    `- Evidence JSON: ${json}`,
    '',
    'Contains identity references and status/budget summaries only; no environment values or transcript content.',
    '',
  ].join('\n');
  writeFileSync(markdown, summary, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return { json, markdown };
}

function fixtureTracker(routeMapIssueNumber: number): IssueTrackerGateway {
  const unavailable = { kind: 'unavailable', message: 'No external tracker is configured for this isolated fixture.' } as const;
  const rejected = { kind: 'rejected', code: 'fixture_tracker_read_only', message: 'Fixture tracker writes are disabled.' } as const;
  return {
    readIssue: (ref) => Promise.resolve(ref.kind === 'route-map' && ref.id === String(routeMapIssueNumber)
      ? { kind: 'read', issue: { ref, title: 'IP-04 isolated Route Map', body: emptyRouteMapBody(), state: 'open', assignees: [] } }
      : unavailable),
    readIssueSummary: () => Promise.resolve(unavailable),
    readIssueBody: () => Promise.resolve(unavailable),
    updateIssueBody: () => Promise.resolve(rejected),
    assignIssue: () => Promise.resolve(rejected),
  };
}

function hostEnvironment(): Readonly<Record<string, string>> {
  const env: Record<string, string> = { ...toChildEnvironment(process.env), ...(CONFIG_HOME.length > 0 ? { XDG_CONFIG_HOME: CONFIG_HOME } : {}) };
  delete env['MINIMAX_CN_API_KEY'];
  return env;
}

function readBoundedTranscript(path: string): string | null {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.size === 0 || stats.size > MAX_TRANSCRIPT_BYTES) return null;
    const bytes = Buffer.alloc(MAX_TRANSCRIPT_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, length);
      if (count === 0) break;
      length += count;
    }
    if (length === 0 || length > MAX_TRANSCRIPT_BYTES) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return check();
}

async function readExistingScope(input: {
  readonly project: string;
  readonly env: Readonly<Record<string, string>>;
  readonly scopeId: string;
  readonly config: Extract<ReturnType<typeof parseProjectConfig>, { ok: true }>['value'];
  readonly backend: ExecutionBackend;
}): Promise<{ readonly coordinationScopeId: CoordinationScopeId; readonly coordinatorSessionId: string; readonly orcaRunId: string; readonly paused: boolean }> {
  const opened = await openRepositoryCoordinationStore({ repositoryPath: input.project, env: input.env, readOnly: true });
  if (opened.kind !== 'opened') throw new Error('Cannot open coordination store for exact Scope recovery');
  try {
    const scopes = opened.store.query({ kind: 'scopes' });
    if (scopes.kind !== 'scopes' || scopes.scopes.length !== 1 || scopes.scopes[0]?.coordinationScopeId !== input.scopeId) {
      throw new Error(`Expected exactly the requested Scope ${input.scopeId} in this fixture`);
    }
    const scope = scopes.scopes[0];
    if (scope.mode !== 'execution_coordination' || !['paused', 'active'].includes(scope.controlState)
      || scope.authorizationId === null || scope.authorizationVersion === null
      || scope.graphId === null || scope.graphVersion === null) {
      throw new Error(`Requested Scope is not an authorized recoverable execution Scope (mode=${scope.mode}, state=${scope.controlState})`);
    }
    if (scope.fullBranchRef !== await completed('git', ['symbolic-ref', 'HEAD'], input.project)
      || scope.canonicalWorktreePath === null
      || realpathSync(scope.canonicalWorktreePath) !== realpathSync(input.project)) {
      throw new Error('Requested Scope is bound to a different repository or branch');
    }
    const snapshot = opened.store.query({ kind: 'snapshot', coordinationScopeId: scope.coordinationScopeId });
    if (snapshot.kind !== 'snapshot' || snapshot.snapshot.executionHandoffs.length !== 0) {
      throw new Error('Requested Scope snapshot is unreadable or has an unexpected execution handoff');
    }
    const sessions = opened.store.query({ kind: 'sessions', coordinationScopeId: scope.coordinationScopeId });
    const registration = sessions.kind === 'sessions' && sessions.sessions.length === 1 ? sessions.sessions[0] : undefined;
    if (registration === undefined || registration.lifecycleState === 'blocked'
      || registration.coordinatorModelConfigurationRef !== input.config.defaultCoordinatorModelRef) {
      throw new Error('Scope Session is missing, blocked, or bound to a different Coordinator configuration');
    }
    const authorization = opened.store.query({ kind: 'authorization', coordinationScopeId: scope.coordinationScopeId,
      authorizationId: scope.authorizationId });
    if (authorization.kind !== 'authorization' || authorization.authorization === null
      || authorization.authorization.authorizationVersion !== scope.authorizationVersion) {
      throw new Error('Scope authorization record/version cannot be proven');
    }
    const manifest = authorization.authorization.manifest;
    for (const role of ['planner', 'implementation', 'validator', 'finalizer'] as const) {
      const profile = manifest.workerProfiles.find((entry) => entry.role === role);
      const [harness, model] = EXPECTED_PROFILES[role];
      if (profile === undefined || profile.profileRef.id !== input.config.execution.workerProfileRefs[role]
        || profile.harness !== harness || profile.modelSelection.model !== model) {
        throw new Error(`Scope authorization does not retain the configured ${role} profile`);
      }
    }
    const recovery = manifest.recoveryUtilityProfile;
    const [recoveryHarness, recoveryModel] = EXPECTED_PROFILES.recovery_utility;
    if (recovery === null || recovery.profileRef.id !== input.config.execution.workerProfileRefs.recovery_utility
      || recovery.harness !== recoveryHarness || recovery.modelSelection.model !== recoveryModel) {
      throw new Error('Scope authorization does not retain the configured recovery utility profile');
    }
    const generationRead = opened.store.query({ kind: 'graph-generation', coordinationScopeId: scope.coordinationScopeId,
      graphId: scope.graphId });
    const generation = generationRead.kind === 'graph-generation' ? generationRead.generation : null;
    if (generation === null || generation.status !== 'active' || generation.orcaRunId !== manifest.orcaRunId) {
      throw new Error('Scope graph generation does not match its original authorization Run');
    }
    const graphRead = opened.store.query({ kind: 'graph-version', coordinationScopeId: scope.coordinationScopeId,
      graphId: scope.graphId, graphVersion: scope.graphVersion });
    if (graphRead.kind !== 'graph-version' || graphRead.version === null
      || graphRead.version.generation !== generation.generation || graphRead.version.orcaRunId !== generation.orcaRunId) {
      throw new Error('Scope graph version does not match its original generation and Run');
    }
    const runResult = await input.backend.query({ operation: 'run-show', runId: generation.orcaRunId });
    const run: RunSummary | null = runResult.kind === 'accepted' ? runResult.value as RunSummary : null;
    if (run === null || run.runId !== generation.orcaRunId || !Number.isSafeInteger(run.consumerGeneration)
      || run.coordinatorHandle !== IDENTITY || run.legacy) {
      throw new Error('Original Orca Run identity/consumer generation could not be proven');
    }
    return { coordinationScopeId: scope.coordinationScopeId,
      coordinatorSessionId: registration.coordinatorSessionId, orcaRunId: generation.orcaRunId,
      paused: scope.controlState === 'paused' };
  } finally {
    opened.close();
  }
}

async function resumePausedScope(host: ForegroundPlanningHost): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await host.ports.execute({ kind: 'scope-control', action: 'resume' });
    if (result.kind === 'accepted') return;
    if (result.kind !== 'rejected' || result.code !== 'execution_in_flight' || attempt === 2) {
      throw new Error(`Scope resume rejected: ${result.kind === 'rejected' ? `${result.code}: ${result.message}` : JSON.stringify(result)}`);
    }
    progress(`resume deferred by execution_in_flight: ${result.message}; retrying the same resume once`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

async function runtimeLeaseExpired(project: string, env: Readonly<Record<string, string>>, scopeId: CoordinationScopeId): Promise<boolean> {
  const opened = await openRepositoryCoordinationStore({ repositoryPath: project, env, readOnly: true });
  if (opened.kind !== 'opened') return false;
  try {
    const snapshot = opened.store.query({ kind: 'snapshot', coordinationScopeId: scopeId });
    return snapshot.kind === 'snapshot' && !snapshot.snapshot.leases.some((lease) => lease.kind === 'runtime'
      && lease.releasedAt === null && lease.expiresAt !== null && lease.expiresAt > Date.now());
  } finally {
    opened.close();
  }
}

async function validatorHasRecoveryMaterial(input: {
  readonly project: string;
  readonly env: Readonly<Record<string, string>>;
  readonly backend: ExecutionBackend;
  readonly scopeId: CoordinationScopeId;
  readonly dispatchId: string;
}): Promise<boolean> {
  const opened = await openRepositoryCoordinationStore({ repositoryPath: input.project, env: input.env, readOnly: true });
  if (opened.kind !== 'opened') return false;
  try {
    const result = opened.store.query({ kind: 'snapshot', coordinationScopeId: input.scopeId });
    if (result.kind !== 'snapshot') return false;
    const segment = result.snapshot.sessionSegments.find((entry) => entry.dispatchId === input.dispatchId
      && entry.role === 'validator' && entry.transcriptReferenceable && entry.lastTranscriptRef !== null);
    if (segment === undefined) return false;
    const bindings = result.snapshot.materializationBindings.filter((entry) => entry.identity === 'issued'
      && entry.workerTaskId === segment.workerTaskId && entry.attemptId === segment.attemptId && entry.role === 'validator');
    const binding = bindings.length === 1 ? bindings[0] : undefined;
    if (binding?.workerTaskId !== segment.workerTaskId || binding.worktreeId === null) return false;
    const worktrees = await input.backend.query({ operation: 'worktree-list', repo: `path:${input.project}`, limit: 1_000 });
    if (worktrees.kind !== 'accepted') return false;
    const worktreeList = worktrees.value as WorktreeListResult;
    if (worktreeList.truncated) return false;
    const worktree = worktreeList.worktrees.find((entry) => entry.worktreeId === binding.worktreeId);
    if (worktree === undefined || !worktree.path.startsWith('/')) return false;
    const transcriptRef = segment.lastTranscriptRef;
    if (transcriptRef === null || transcriptRef.length === 0) return false;
    const idPrefix = `session-binding:${encodeURIComponent(input.dispatchId)}:`;
    if (!segment.sessionBindingId.startsWith(idPrefix)) return false;
    const providerSessionId = decodeURIComponent(segment.sessionBindingId.slice(idPrefix.length));
    const identity = await qwenHarness.readTranscriptIdentity({ transcriptRef, workspace: worktree.path });
    if (!('providerSessionId' in identity) || identity.providerSessionId !== providerSessionId) return false;
    const coverage = await qwenHarness.inspectTranscript(transcriptRef);
    if (coverage.kind !== 'covered' || coverage.evidence.coverage !== 'complete'
      || coverage.evidence.readableRange.transcriptRef !== transcriptRef) return false;
    const transcript = readBoundedTranscript(transcriptRef);
    if (transcript === null) return false;
    let hasUser = false;
    let hasAssistant = false;
    for (const line of transcript.split('\n')) {
      if (line.length === 0) continue;
      const record: unknown = JSON.parse(line);
      if (typeof record !== 'object' || record === null || Array.isArray(record)) return false;
      const row = record as Record<string, unknown>;
      if (row['sessionId'] !== providerSessionId) return false;
      hasUser ||= row['type'] === 'user';
      hasAssistant ||= row['type'] === 'assistant';
    }
    return hasUser && hasAssistant;
  } catch {
    return false;
  } finally {
    opened.close();
  }
}

async function requestValidatorInterruption(input: {
  readonly backend: ExecutionBackend;
  readonly project: string;
  readonly env: Readonly<Record<string, string>>;
  readonly scopeId: CoordinationScopeId;
  readonly runId: string;
  readonly identity: string;
  readonly dispatchId: string;
}): Promise<void> {
  const opened = await openRepositoryCoordinationStore({ repositoryPath: input.project, env: input.env, readOnly: true });
  if (opened.kind !== 'opened') throw new Error('Cannot read the isolated coordination store');
  try {
    const scopeRead = opened.store.query({ kind: 'scope', coordinationScopeId: input.scopeId });
    const snapshotRead = opened.store.query({ kind: 'snapshot', coordinationScopeId: input.scopeId });
    if (scopeRead.kind !== 'scope' || scopeRead.scope === null || snapshotRead.kind !== 'snapshot') {
      throw new Error('Cannot prove the active Scope before stopping its validator');
    }
    const scope = scopeRead.scope;
    const runtime = snapshotRead.snapshot.leases.find((lease) => lease.kind === 'runtime'
      && lease.releasedAt === null && lease.expiresAt !== null && lease.expiresAt > Date.now());
    const generation = snapshotRead.snapshot.graphGenerations.find((entry) => entry.graphId === scope.graphId);
    const runResult = await input.backend.query({ operation: 'run-show', runId: input.runId });
    const run: RunSummary | null = runResult.kind === 'accepted' ? runResult.value as RunSummary : null;
    const consumerGeneration = run?.consumerGeneration;
    if (runtime === undefined || generation === undefined || scope.authorizationId === null
      || run === null || run.runId !== input.runId || run.coordinatorHandle !== input.identity || run.legacy
      || typeof consumerGeneration !== 'number' || !Number.isSafeInteger(consumerGeneration) || scope.graphId === null) {
      throw new Error('Validator stop lacks current runtime, Run, graph or authorization proof');
    }
    const outcome = await input.backend.mutate({ operation: 'worker-stop', dispatchId: input.dispatchId }, buildExecutionScope({
      coordinationScopeId: input.scopeId,
      coordinatorSessionId: runtime.coordinatorSessionId,
      runtimeIncarnationId: runtime.runtimeIncarnationId,
      fencingGeneration: runtime.fencingGeneration,
      backendIdentityRef: input.identity,
      operationId: `ip04-mixed-controller-stop:${randomUUID()}` as import('../../src/application/dto/identity.js').OperationId,
      target: { kind: 'worker-dispatch', id: input.dispatchId },
      expectedRevision: scope.revision,
      timeoutMs: 60_000,
      authority: {
        kind: 'execution_coordination', graphGeneration: generation.generation,
        authorizationId: scope.authorizationId, runId: input.runId, consumerGeneration,
      },
    }));
    if (outcome.kind !== 'accepted') throw new Error(`Validator interruption was not confirmed (${outcome.kind})`);
    const shown = await input.backend.query({ operation: 'worker-show', dispatchId: input.dispatchId });
    const worker = shown.kind === 'accepted' ? shown.value as WorkerShowResult : null;
    const binding = snapshotRead.snapshot.materializationBindings.find((entry) => entry.role === 'validator'
      && entry.orcaTaskId === worker?.taskId);
    if (worker?.exactWorker !== true || worker.dispatchId !== input.dispatchId || binding === undefined) {
      throw new Error('Cannot prove the exact Validator after its stop request');
    }
    if (worker.observationStatus !== 'exited') {
      // Prepared terminals are external to worker-stop; the fixture must close its own exact resource.
      if (worker.agentTerminalHandle === null) throw new Error('Validator terminal is unavailable for interruption');
      const closed = await input.backend.mutate({ operation: 'terminal-close', terminal: worker.agentTerminalHandle },
        buildExecutionScope({ coordinationScopeId: input.scopeId, coordinatorSessionId: runtime.coordinatorSessionId,
          runtimeIncarnationId: runtime.runtimeIncarnationId, fencingGeneration: runtime.fencingGeneration,
          backendIdentityRef: input.identity, operationId: `ip04-mixed-controller-close:${input.dispatchId}` as import('../../src/application/dto/identity.js').OperationId,
          target: { kind: 'terminal', id: worker.agentTerminalHandle }, expectedRevision: scope.revision, timeoutMs: 60_000,
          authority: { kind: 'execution_coordination', graphGeneration: generation.generation,
            authorizationId: scope.authorizationId, runId: input.runId, consumerGeneration } }));
      if (closed.kind !== 'accepted') throw new Error(`Validator terminal close was not confirmed (${closed.kind})`);
      if (typeof closed.value === 'object' && closed.value !== null && 'ok' in closed.value && closed.value.ok === false) {
        throw new Error('Validator terminal close recorded a definite failure');
      }
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const observed = await input.backend.query({ operation: 'worker-show', dispatchId: input.dispatchId });
        const stopped = observed.kind === 'accepted' ? observed.value as WorkerShowResult : null;
        if (stopped?.exactWorker !== true || stopped.dispatchId !== input.dispatchId || stopped.taskId !== worker.taskId) {
          throw new Error('Validator identity changed while confirming interruption');
        }
        if (stopped.observationStatus === 'exited') return;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error('Exact Validator exit remains unconfirmed after terminal close');
    }
  } finally {
    opened.close();
  }
}

async function hasRecordedValidatorInterruption(backend: ExecutionBackend, env: Readonly<Record<string, string>>,
  scopeId: CoordinationScopeId): Promise<boolean> {
  const opened = await openRepositoryCoordinationStore({ repositoryPath: PROJECT, env, readOnly: true });
  if (opened.kind !== 'opened') throw new Error('Cannot verify the existing Validator interruption');
  try {
    const read = opened.store.query({ kind: 'snapshot', coordinationScopeId: scopeId });
    if (read.kind !== 'snapshot') return false;
    for (const recovery of read.snapshot.recoveries.filter((entry) => entry.role === 'validator')) {
      const segment = read.snapshot.sessionSegments.find((entry) => entry.segmentId === recovery.sourceSegmentId &&
        entry.dispatchId === recovery.sourceDispatchId && entry.attemptId === recovery.businessAttemptId);
      const binding = segment === undefined ? undefined : read.snapshot.materializationBindings.find((entry) =>
        entry.role === 'validator' && entry.workerTaskId === segment.workerTaskId && entry.attemptId === segment.attemptId);
      if (binding?.orcaTaskId == null) continue;
      const shown = await backend.query({ operation: 'worker-show', dispatchId: recovery.sourceDispatchId });
      const worker = shown.kind === 'accepted' ? shown.value as WorkerShowResult : null;
      if (worker?.exactWorker === true && worker.observationStatus === 'exited' &&
        worker.taskId === binding.orcaTaskId && worker.dispatchId === recovery.sourceDispatchId) return true;
    }
    return false;
  } finally { opened.close(); }
}

describe.skipIf(!ENABLED || PROJECT.length === 0 || IDENTITY.length === 0 || CONFIG_HOME.length === 0)('IP-04 mixed Harness Controller acceptance', () => {
  test('mixed native roles, Recovery Utility, deliverable verdict and restart identity', async () => {
    expect(PROJECT.startsWith('/')).toBe(true);
    expect(IDENTITY.trim().length).toBeGreaterThan(0);
    if (PLANNING_HARNESS === 'command-code') {
      const nativeSettings: unknown = JSON.parse(readFileSync(join(PROJECT, '.commandcode', 'settings.json'), 'utf8'));
      expect(nativeSettings, 'fixture disables native project learning before Worker launch').toMatchObject({ tasteLearning: false });
    }
    const rawConfig: unknown = JSON.parse(readFileSync(join(PROJECT, 'orca-companion.json'), 'utf8'));
    const parsed = parseProjectConfig(rawConfig);
    expect(parsed.ok, 'isolated fixture must have valid schema-5 project config').toBe(true);
    if (!parsed.ok) throw new Error(`Fixture project config rejected: ${parsed.field}`);
    const config = parsed.value;
    const expected = EXPECTED_PROFILES;
    for (const role of Object.keys(expected) as (keyof typeof expected)[]) {
      const [harness, model] = expected[role];
      const ref = config.execution.workerProfileRefs[role];
      const profile = config.execution.workerProfiles.find((entry) => entry.profileRef === ref && entry.role === role);
      expect(profile?.harness, `${role} harness`).toBe(harness);
      expect(profile?.modelSelection.model, `${role} approved model`).toBe(model);
    }

    const env = toChildEnvironment(process.env);
    const remote = await completed('git', ['remote', 'get-url', 'origin'], PROJECT);
    const localRemote = remote.startsWith('/') ? remote : remote.startsWith('file://') ? fileURLToPath(remote) : '';
    expect(localRemote, 'origin must be a local bare integration remote').not.toBe('');
    expect(await completed('git', ['-C', localRemote, 'rev-parse', '--is-bare-repository'], PROJECT)).toBe('true');

    const backend = createOrcaExecutionBackend({
      cwd: PROJECT, env,
      resolveIdentityHandle: (ref) => Promise.resolve(ref === IDENTITY ? IDENTITY : undefined),
    });
    const inventory = await backend.query({ operation: 'terminal-list', worktree: `path:${PROJECT}`, limit: 100 });
    if (inventory.kind !== 'accepted') throw new Error('Cannot verify the dedicated Coordinator terminal');
    const listed = inventory.value as TerminalListResult;
    const workspaceInventory = await backend.query({ operation: 'worktree-list', repo: `path:${PROJECT}`, limit: 100 });
    if (workspaceInventory.kind !== 'accepted') throw new Error('Cannot verify the fixture worktree');
    const worktrees = workspaceInventory.value as WorktreeListResult;
    const workspace = worktrees.worktrees.find((entry) => realpathSync(entry.path) === realpathSync(PROJECT));
    const terminal = listed.terminals.find((entry) => entry.handle === IDENTITY);
    if (listed.truncated || worktrees.truncated || workspace === undefined
      || terminal === undefined || !terminal.connected || !terminal.writable
      || terminal.worktreeId !== workspace.worktreeId) {
      throw new Error('Dedicated Coordinator terminal is not live in the exact fixture');
    }
    // Explicit public identity remains usable when Orca loses the terminal's UI surface.
    const nativeProbe = createOrcaDoctorProbe({ cwd: PROJECT, env: hostEnvironment(),
      executable: process.env['ORCA_CLI_COMMAND'] ?? 'orca-ide',
      identityWorktreePath: PROJECT, coordinatorIdentityRef: IDENTITY });
    const orcaProbe: DoctorProbe = {
      readOrcaVersion: nativeProbe.readOrcaVersion, readRuntime: nativeProbe.readRuntime,
      readHosts: nativeProbe.readHosts, readCoordinatorIdentity: nativeProbe.readCoordinatorIdentity,
      readPublicCommands: nativeProbe.readPublicCommands,
    };
    const seeded = SCOPE_ID.length > 0
      ? await readExistingScope({ project: PROJECT, env, scopeId: SCOPE_ID, config, backend })
      : await seedRealExecutionScope({
        workspace: PROJECT,
        identity: IDENTITY,
        coordinatorModelConfigurationRef: config.defaultCoordinatorModelRef,
        coordinationScopeId: `ip04-mixed-controller-${randomUUID()}`,
        objective: 'IP-04 mixed native Controller acceptance: preserve README title "IP-04 mixed native Controller fixture" and add the exact sentence "This fixture verifies mixed Command Code and Qwen worker coordination." No badges or other files.',
        plan: { ...REAL_LOOP_SINGLE_PLAN, workPackages: REAL_LOOP_SINGLE_PLAN.workPackages.map((workPackage) => ({
          ...workPackage,
          title: 'Preserve README H1 "IP-04 mixed native Controller fixture"; add exactly one ASCII sentence below it: "This fixture verifies mixed Command Code and Qwen worker coordination." No badges or other files.',
        })) },
        env: { ...env },
        limits: config.execution.limits,
      });
    let host = await createForegroundPlanningHost({ repositoryPath: PROJECT, env: hostEnvironment(), orcaProbe,
      trackerFactory: () => fixtureTracker(config.tracker.routeMapIssueNumber) });
    try {
      const readiness = host.readiness();
      expect(readiness.blocker, `Host readiness blocker: ${JSON.stringify(readiness.blocker)}`).toBeNull();
      progress('host ready');
      const home = await host.ports.scopeSetup.resolveHome();
      expect(home.kind).toBe('restore');
      if (SCOPE_ID.length > 0) {
        await resumePausedScope(host);
        progress('existing authorized Scope restored');
        if (FIXTURE_ANSWER.length > 0) {
          if (host.ports.questions === undefined) throw new Error('Pending interaction port is unavailable');
          const questions = await host.ports.questions({ kind: 'pending-interactions', coordinatorSessionId: seeded.coordinatorSessionId });
          if (questions.kind !== 'pending-interactions' || questions.interactions.length !== 1 || questions.nextCursor !== null) {
            throw new Error('Explicit fixture answer requires exactly one pending interaction');
          }
          const question = questions.interactions[0]!;
          const answered = await host.ports.execute({ kind: 'answer-pending-interaction',
            coordinatorSessionId: seeded.coordinatorSessionId, interactionId: question.interactionId,
            expectedRevision: question.expectedRevision, submissionId: `ip04-fixture-answer:${question.interactionId}`,
            answer: FIXTURE_ANSWER });
          if (answered.kind !== 'accepted') throw new Error(`Fixture answer failed: ${JSON.stringify(answered)}`);
          progress('explicit fixture requirement answered');
        }
        const retried = await host.ports.execute({ kind: 'retry-session', coordinatorSessionId: seeded.coordinatorSessionId });
        if (retried.kind !== 'accepted') throw new Error(`Explicit fixture Session retry failed: ${JSON.stringify(retried)}`);
        progress('existing Session explicitly retried');
      } else {
        const review = await host.ports.executionAuthorization.review();
        expect(review.kind, 'authorization review must be actionable').toBe('review');
        if (review.kind !== 'review') throw new Error('Mixed profile authorization is not reviewable');
        expect(review.review.gate.ready, `Authorization review blockers: ${JSON.stringify(review.review.gate.blockers)}`).toBe(true);
        const approved = await host.ports.executionAuthorization.approve({
          fingerprint: review.review.fingerprint, expectedRevision: review.review.scopeRevision,
        });
        expect(approved.kind, approved.kind === 'rejected'
          ? `Authorization approval rejected: ${approved.code}: ${approved.message}`
          : JSON.stringify(approved)).toBe('accepted');
        progress('execution authorized');
      }
      let interrupted = SCOPE_ID.length > 0 && await hasRecordedValidatorInterruption(backend, env, seeded.coordinationScopeId);
      const reportedRoles = new Set<string>();
      let recoveryReported = false;
      let lastDiagnostic = '';
      const deadline = Date.now() + 60 * 60_000;
      let current = await controllerSnapshot(host);
      while (Date.now() < deadline && current.finalizer.verdict === null) {
        const openInteractions = current.interactions.filter((entry) => entry.state === 'open')
          .map(({ interactionId, state }) => ({ interactionId, state }));
        const diagnostic = JSON.stringify({ blockers: current.blockers,
          pendingInteractions: openInteractions });
        if ((current.blockers.length > 0 || openInteractions.length > 0) && diagnostic !== lastDiagnostic) {
          progress(`Controller blockers/interactions: ${diagnostic}`);
          lastDiagnostic = diagnostic;
        }
        if (openInteractions.length > 0) {
          throw new Error(`Controller requires user interaction: ${JSON.stringify(openInteractions)}`);
        }
        for (const worker of current.workers) {
          if (!reportedRoles.has(worker.role)) {
            reportedRoles.add(worker.role);
            progress(`role dispatched: ${worker.role}`);
          }
        }
        if (!recoveryReported && current.recoveries.some((entry) => entry.status === 'recovered')) {
          recoveryReported = true;
          progress('validator recovery completed');
        }
        const validator = current.workers.find((worker) => worker.role === 'validator' && worker.liveness !== 'exited');
        const recoveryMaterialReady = validator !== undefined && await validatorHasRecoveryMaterial({
          project: PROJECT, env, backend, scopeId: seeded.coordinationScopeId, dispatchId: validator.dispatchId,
        });
        if (!interrupted && validator !== undefined && recoveryMaterialReady) {
          progress(`interrupting exact Validator ${validator.dispatchId} with complete native history`);
          await requestValidatorInterruption({ backend, project: PROJECT, env, identity: IDENTITY,
            scopeId: seeded.coordinationScopeId, runId: seeded.orcaRunId, dispatchId: validator.dispatchId });
          interrupted = true;
        }
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        current = await controllerSnapshot(host);
      }
      expect(interrupted, 'the Validator must be interrupted to exercise native Recovery Utility dispatch').toBe(true);
      const acceptedVerdict = current.finalizer.verdict;
      expect(acceptedVerdict?.kind, 'a blocker is not a successful acceptance').toBe('deliverable');
      if (acceptedVerdict === null) throw new Error('Controller final verdict is missing');
      expect(current.blockers).toEqual([]);
      progress(`final verdict: ${acceptedVerdict.kind}`);

      const opened = await openRepositoryCoordinationStore({ repositoryPath: PROJECT, env, readOnly: true });
      if (opened.kind !== 'opened') throw new Error('Cannot inspect persisted acceptance facts');
      let beforeRestart: string;
      try {
        const snapshot = opened.store.query({ kind: 'snapshot', coordinationScopeId: seeded.coordinationScopeId });
        if (snapshot.kind !== 'snapshot') throw new Error('Cannot read execution snapshot');
        const bindings = snapshot.snapshot.materializationBindings.filter((entry) => entry.identity === 'issued');
        const profileRefFor = (role: keyof typeof expected) => config.execution.workerProfileRefs[role];
        for (const binding of bindings) {
          const role = binding.recoveryUtilityRole ?? binding.role;
          if (role === null) continue;
          const expectedProfile = profileRefFor(role);
          expect(binding.authorizationId).toBe(snapshot.snapshot.scope.authorizationId);
          expect(binding.authorizationVersion).not.toBeNull();
          expect(binding.workerProfileRef?.id).toBe(expectedProfile);
        }
        for (const role of ['planner', 'implementation', 'validator', 'finalizer'] as const) {
          expect(bindings.some((entry) => entry.role === role && entry.workerTaskId !== null && entry.dispatchId !== null)).toBe(true);
        }
        expect(bindings.some((entry) => entry.recoveryUtilityRole === 'recovery_utility'
          && entry.workerProfileRef?.id === config.execution.workerProfileRefs.recovery_utility)).toBe(true);
        expect(snapshot.snapshot.recoveries.some((entry) => entry.status === 'recovered' && entry.consumedBudget === 1)).toBe(true);
        expect(snapshot.snapshot.deliverySettlements.some((entry) => entry.role === 'finalizer')).toBe(true);
        beforeRestart = JSON.stringify({ bindings, recoveries: snapshot.snapshot.recoveries,
          settlements: snapshot.snapshot.deliverySettlements, budgets: current.budgets });
      } finally {
        opened.close();
      }

      host.close();
      const leaseExpired = await waitFor(() => runtimeLeaseExpired(PROJECT, env, seeded.coordinationScopeId), 35_000);
      expect(leaseExpired).toBe(true);
      host = await createForegroundPlanningHost({ repositoryPath: PROJECT, env: hostEnvironment(), orcaProbe,
        trackerFactory: () => fixtureTracker(config.tracker.routeMapIssueNumber) });
      const restarted = await controllerSnapshot(host);
      expect(restarted.finalizer.verdict?.kind).toBe('deliverable');
      const reopened = await openRepositoryCoordinationStore({ repositoryPath: PROJECT, env, readOnly: true });
      if (reopened.kind !== 'opened') throw new Error('Cannot re-read persisted acceptance facts after restart');
      try {
        const snapshot = reopened.store.query({ kind: 'snapshot', coordinationScopeId: seeded.coordinationScopeId });
        if (snapshot.kind !== 'snapshot') throw new Error('Cannot read restarted execution snapshot');
        expect(JSON.stringify({ bindings: snapshot.snapshot.materializationBindings.filter((entry) => entry.identity === 'issued'),
          recoveries: snapshot.snapshot.recoveries, settlements: snapshot.snapshot.deliverySettlements,
          budgets: restarted.budgets })).toBe(beforeRestart);
        progress('Controller restart retained bindings, settlements, recoveries and budgets');
        const finalizerVerdict = snapshot.snapshot.deliveryVerdicts.at(-1);
        if (finalizerVerdict === undefined) throw new Error('Accepted finalizer verdict reference is missing');
        const bindings = snapshot.snapshot.materializationBindings.filter((entry) => entry.identity === 'issued');
        const evidence = writeControllerEvidence({
          result: 'passed',
          observedAt: new Date().toISOString(),
          coordinationScopeId: seeded.coordinationScopeId,
          orcaRunId: seeded.orcaRunId,
          profiles: `planner/implementation=${PLANNING_HARNESS} (${PLANNING_MODEL}); validator/finalizer/recovery_utility=qwen-code (${MODEL})`,
          verdictId: finalizerVerdict.verdictId,
          verdictKind: finalizerVerdict.verdict.kind,
          verdictRefs: finalizerVerdict.verdict.kind === 'deliverable' ? finalizerVerdict.verdict.evidenceRefs : [],
          bindingCount: bindings.length,
          bindings: bindings.map(({ workPackageId, role, recoveryUtilityRole, workerTaskId, dispatchId, attemptId,
            authorizationId, authorizationVersion, workerProfileRef, orcaTaskId }) => ({ workPackageId, role,
            recoveryUtilityRole, workerTaskId, dispatchId, attemptId, authorizationId, authorizationVersion,
            workerProfileRef, orcaTaskId })),
          recoveries: snapshot.snapshot.recoveries.map(({ recoveryId, workerTaskId, sourceDispatchId,
            replacementDispatchId, status, consumedBudget }) => ({ recoveryId, workerTaskId, sourceDispatchId,
            replacementDispatchId, status, consumedBudget })),
          recoveryCount: snapshot.snapshot.recoveries.length,
          settlements: snapshot.snapshot.deliverySettlements.map(({ role, workerTaskId, dispatchId, attemptId,
          orcaResultRef, outcome, validationVerdict }) => ({ role, workerTaskId, dispatchId, attemptId,
          orcaResultRef, outcome, validationVerdict })),
          settlementCount: snapshot.snapshot.deliverySettlements.length,
          budgetCounters: restarted.budgets,
          restartPreserved: true,
        });
        progress(`evidence saved: ${evidence.json}`);
      } finally {
        reopened.close();
      }
    } finally {
      host.close();
    }
  }, 3_600_000);
});
