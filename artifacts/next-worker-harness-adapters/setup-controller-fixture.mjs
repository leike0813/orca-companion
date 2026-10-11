#!/usr/bin/env node
/** Prepare an isolated IP-04 mixed Controller fixture; this script never seeds a Scope or runs a model. */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { randomUUID } from 'node:crypto';

const repository = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const dist = join(repository, 'dist');
const credentialModule = join(dist, 'src', 'adapters', 'storage', 'credential-store.js');
const configModule = join(dist, 'src', 'application', 'configuration', 'project-config.js');
const backendModule = join(dist, 'src', 'adapters', 'orca-cli', 'orca-backend.js');
const scopeModule = join(dist, 'src', 'application', 'ports', 'execution-backend.js');
const acceptanceHelper = join(dist, 'tests', 'support', 'worker-harness-acceptance.js');
const key = process.env['MINIMAX_CN_API_KEY'];

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (process.argv[2] !== '--prepare') {
  fail('Usage: node artifacts/next-worker-harness-adapters/setup-controller-fixture.mjs --prepare');
}
if (typeof key !== 'string' || key.trim().length === 0) fail('MINIMAX_CN_API_KEY is required; its value is never displayed.');
for (const modulePath of [credentialModule, configModule, backendModule, scopeModule, acceptanceHelper]) {
  if (!existsSync(modulePath)) fail('Build the current project first; required compiled project modules are missing.');
}

const root = mkdtempSync(join('/var/tmp', 'orca-ip04-mixed-controller-'));
const project = join(root, 'repo');
const bareRemote = join(root, 'origin.git');
const configHome = join(root, 'coordinator-config');
const name = `ip04-mixed-${randomUUID()}`;
const identityRef = `ip04-controller-setup-${randomUUID()}`;
const orcaExecutable = process.env['ORCA_CLI_COMMAND']?.trim() || 'orca-ide';

function run(executable, args, cwd = root) {
  const childEnv = { ...process.env };
  delete childEnv['MINIMAX_CN_API_KEY'];
  const result = spawnSync(executable, args, { cwd, env: childEnv, encoding: 'utf8', timeout: 120_000 });
  if (result.status !== 0) {
    const detail = (result.stderr ?? '').replaceAll(key, '[redacted]').trim();
    throw new Error(`${executable} ${args[0] ?? ''} failed (${String(result.status)}): ${detail}`);
  }
  return (result.stdout ?? '').trim();
}

function git(cwd, args) {
  return run('git', args, cwd);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

try {
  if (!resolve(root).startsWith('/var/tmp/')) throw new Error('Fixture root escaped /var/tmp.');
  mkdirSync(project, { recursive: true });
  mkdirSync(configHome, { recursive: true, mode: 0o700 });

  const { JsonCredentialStore } = await import(pathToFileURL(credentialModule).href);
  const credentials = new JsonCredentialStore({ environment: { XDG_CONFIG_HOME: configHome } });
  const metadata = credentials.metadata();
  if (metadata.kind !== 'metadata') throw new Error(`Credential store unavailable (${metadata.code}).`);
  const saved = credentials.save({ expectedRevision: metadata.revision, secret: key });
  if (saved.kind !== 'saved') throw new Error(`Credential store write failed (${saved.code}).`);

  const connection = {
    connectionRef: 'ip04-minimax-cn',
    label: 'MiniMax CN IP-04 Coordinator',
    providerId: 'minimax-cn',
    providerIntegration: 'openai-chat',
    baseUrl: 'https://api.minimaxi.com/v1',
    credential: { kind: 'managed', credentialRef: saved.credentialRef },
  };
  const model = 'MiniMax-M3.1-Flash-Preview';
  const roles = [
    ['planner', 'command-code', 'minimax-cn/MiniMax-M3.1-Flash-Preview'],
    ['implementation', 'command-code', 'minimax-cn/MiniMax-M3.1-Flash-Preview'],
    ['validator', 'qwen-code', model],
    ['finalizer', 'qwen-code', model],
    ['recovery_utility', 'qwen-code', model],
  ];
  const config = {
    schemaVersion: 5,
    revision: 0,
    providerConnections: [connection],
    models: [{ modelRef: 'ip04-minimax-model', connectionRef: connection.connectionRef, model, effortCapability: null }],
    coordinatorModels: [{
      configurationRef: 'ip04-minimax-coordinator',
      providerIntegration: connection.providerIntegration,
      model,
      credentialRefs: [saved.credentialRef],
      nativeWindowOwnerRef: null,
      providerConnection: connection,
      modelRef: 'ip04-minimax-model',
      effortCapability: null,
      effort: null,
    }],
    defaultCoordinatorModelRef: 'ip04-minimax-coordinator',
    tracker: { kind: 'github', routeMapIssueNumber: 1 },
    planning: { maxMutations: 8 },
    context: { maxInputTokens: 20000 },
    execution: {
      harness: 'command-code',
      workerProfiles: roles.map(([role, harness, selection]) => ({
        profileRef: `ip04-${role}`,
        role,
        harness,
        modelSelection: { model: selection, effort: null, effortCapability: null, catalogSource: null },
      })),
      workerProfileRefs: Object.fromEntries(roles.map(([role]) => [role, `ip04-${role}`])),
      codexSandbox: 'workspace-write',
      permissions: {
        planner: true, implementation: true, validator: true, finalizer: true,
        gitIntegration: true, dependencyChanges: false,
      },
      limits: {
        maxActiveWorkPackages: 1, maxWorkPackages: 8, integrationReconciliations: 2,
        implementationAttempts: 2, validatorRepairs: 2, graphRevisions: 2,
        specificationRevisions: 2, maxRecoveriesPerWorkerAttempt: 1,
      },
      git: { remotes: ['origin'], refs: ['refs/heads/main'] },
      dependency: { allowDependencyChanges: false, registry: null },
      acceptedRisks: [],
    },
  };
  const { parseProjectConfig } = await import(pathToFileURL(configModule).href);
  const parsed = parseProjectConfig(config);
  if (!parsed.ok) throw new Error(`Generated schema-5 project config failed validation (${parsed.field}).`);

  writeFileSync(join(project, '.gitignore'), '', { mode: 0o644 });
  writeFileSync(join(project, 'README.md'), '# IP-04 mixed native Controller fixture\n', { mode: 0o644 });
  // Native startup learning must not add files outside the approved README task.
  mkdirSync(join(project, '.commandcode'), { recursive: true });
  writeFileSync(join(project, '.commandcode', 'settings.json'), '{"tasteLearning":false}\n', { mode: 0o644 });
  mkdirSync(join(project, 'openspec', 'specs'), { recursive: true });
  mkdirSync(join(project, 'openspec', 'changes', 'archive'), { recursive: true });
  writeFileSync(join(project, 'openspec', 'config.yaml'), 'schema: spec-driven\n', { mode: 0o644 });
  writeFileSync(join(project, 'openspec', 'specs', '.gitkeep'), '');
  writeFileSync(join(project, 'openspec', 'changes', 'archive', '.gitkeep'), '');
  writeFileSync(join(project, 'orca-companion.json'), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o644 });

  git(root, ['init', '-q', '--bare', bareRemote]);
  git(bareRemote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(project, ['init', '-q', '-b', 'main']);
  git(project, ['-c', 'user.email=acceptance@example.invalid', '-c', 'user.name=IP04 acceptance', 'add', '-A']);
  git(project, ['-c', 'user.email=acceptance@example.invalid', '-c', 'user.name=IP04 acceptance', 'commit', '-q', '-m', 'IP-04 isolated baseline']);
  git(project, ['remote', 'add', 'origin', bareRemote]);
  git(project, ['push', '-q', '-u', 'origin', 'main']);

  const childEnv = { ...process.env };
  delete childEnv['MINIMAX_CN_API_KEY'];
  const { toChildEnvironment } = await import(pathToFileURL(join(dist, 'src', 'interfaces', 'cli', 'main.js')).href);
  const orcaEnv = toChildEnvironment(childEnv);
  const registered = JSON.parse(run(orcaExecutable, ['repo', 'add', '--path', project, '--json'], project));
  if (!isRecord(registered)) throw new Error('Orca repo registration did not return a JSON object.');

  const { createOrcaExecutionBackend } = await import(pathToFileURL(backendModule).href);
  const { buildExecutionScope } = await import(pathToFileURL(scopeModule).href);
  const { createAcceptanceTerminal } = await import(pathToFileURL(acceptanceHelper).href);
  const identity = { handle: undefined };
  const backend = createOrcaExecutionBackend({
    executable: orcaExecutable,
    cwd: project,
    env: orcaEnv,
    resolveIdentityHandle: (ref) => ref === identityRef ? identity.handle : undefined,
  });
  const terminalHandle = await createAcceptanceTerminal(backend, {
    operation: 'terminal-create',
    worktree: `path:${project}`,
    title: `${name}-coordinator`,
    command: 'bash -i',
  }, buildExecutionScope({
    coordinationScopeId: `${identityRef}:scope`,
    coordinatorSessionId: `${identityRef}:session`,
    runtimeIncarnationId: `${identityRef}:incarnation`,
    fencingGeneration: 1,
    backendIdentityRef: identityRef,
    operationId: `${identityRef}:terminal-create`,
    target: { kind: 'work-package', id: `${identityRef}:setup` },
    expectedRevision: 0,
    timeoutMs: 60_000,
    authority: { kind: 'route_planning' },
  }));
  identity.handle = terminalHandle;
  const listed = await backend.query({ operation: 'terminal-list', worktree: `path:${project}`, limit: 100 });
  const inventory = listed.kind === 'accepted' && isRecord(listed.value) ? listed.value : null;
  const terminals = Array.isArray(inventory?.['terminals']) ? inventory['terminals'] : [];
  const matches = terminals.filter((entry) => isRecord(entry) && entry['handle'] === terminalHandle);
  if (inventory?.['truncated'] !== false || matches.length !== 1
    || !isRecord(matches[0]) || matches[0]['connected'] !== true || matches[0]['writable'] !== true) {
    throw new Error('Coordinator terminal receipt could not be independently confirmed by terminal-list.');
  }

  process.stdout.write([
    `root=${root}`,
    `repo=${project}`,
    `configstate=${configHome}`,
    `coordinator_terminal_receipt_id=${terminalHandle}`,
    `ORCA_COMPANION_IP04_MIXED_CONTROLLER=1`,
    `ORCA_COMPANION_IP04_MIXED_CONTROLLER_REPO=${project}`,
    `ORCA_COMPANION_IP04_MIXED_CONTROLLER_IDENTITY=${terminalHandle}`,
    `ORCA_COMPANION_IP04_MIXED_CONTROLLER_CONFIG_HOME=${configHome}`,
  ].join('\n') + '\n');
} catch (error) {
  const message = error instanceof Error ? error.message : 'unknown fixture setup error';
  fail(`Fixture setup failed; retained root=${root}; ${message}`);
}
