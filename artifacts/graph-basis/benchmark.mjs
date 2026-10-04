/**
 * IP-05 graph-basis performance evidence.
 *
 * Run only when the coordinator explicitly releases the performance slot:
 *   pnpm build && node artifacts/graph-basis/benchmark.mjs --run
 *
 * Each case uses a temporary production schema-17 SQLite store and the production
 * GraphBasisService. Input latency is measured from real TuiApp stdin events until
 * Ink emits the resulting frame; store/service/reader helper timings are never
 * reported as UI response latency. Generated databases are removed on exit.
 */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate, setTimeout } from 'node:timers';
import { URL } from 'node:url';
import { openCoordinationStore } from '../../dist/src/adapters/storage/coordination-store.js';
import { SCHEMA_VERSION } from '../../dist/src/adapters/storage/schema.js';
import { createGraphBasisService } from '../../dist/src/application/tui/graph-basis-service.js';
import { parseImplementationPlan } from '../../dist/src/domain/planning/graph-compiler.js';
import { createFakePorts, settle } from '../../dist/tests/tui/harness.js';

const OUT = new URL('./', import.meta.url);
const SAMPLE_COUNT = 100;
const PAGE_SIZE = 20;
const BODY_BYTES = 64 * 1024;
const VIEWPORTS = [
  { columns: 120, rows: 40 },
  { columns: 80, rows: 24 },
  { columns: 50, rows: 40 },
];
const SCALE_CASES = [1_000, 10_000, 100_000].map((count) => ({ label: `${count}-versions`, versions: count, bodyBytes: 0 }));
const BODY_CASES = [1, 5].map((mib) => ({ label: `${mib}-MiB-body`, versions: 1_000, bodyBytes: mib * 1024 * 1024 }));
const CASES = [...SCALE_CASES, ...BODY_CASES];
const round = (value) => Math.round(value * 1000) / 1000;

function distribution(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    p50Ms: round(sorted[Math.floor(sorted.length * 0.5)]),
    p95Ms: round(sorted[Math.ceil(sorted.length * 0.95) - 1]),
    maxMs: round(sorted.at(-1)),
  };
}

function makeNormalizedPlanBody(targetBytes, plan) {
  if (targetBytes === 0) return null;
  const base = { ...plan, workPackages: plan.workPackages.map((item) => ({ ...item, title: '' })) };
  const fixedBytes = Buffer.byteLength(JSON.stringify(base));
  if (targetBytes < fixedBytes) throw new Error('target body is smaller than the normalized plan structure');
  const padded = { ...plan, workPackages: plan.workPackages.map((item) => ({ ...item, title: 'x'.repeat(targetBytes - fixedBytes) })) };
  const parsed = parseImplementationPlan(padded);
  assert.equal(parsed.ok, true, 'large body fixture must be a normalized ImplementationPlan');
  const serialized = JSON.stringify(parsed.value);
  assert.equal(Buffer.byteLength(serialized), targetBytes, 'normalized plan body must have the requested byte length');
  return serialized;
}

function seedVersions(databasePath, count, bodyBytes, plan) {
  const db = new DatabaseSync(databasePath);
  try {
    const schema = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    assert.equal(Number(schema?.value), SCHEMA_VERSION, 'fixture must use the current production schema');
    const initial = db.prepare('SELECT graph_id, graph_generation, graph_json, orca_run_id, map_revision, plan_revision FROM graph_versions WHERE graph_version = 1 LIMIT 1').get();
    assert.ok(initial, 'production graph-history write must create v1');
    const patch = JSON.stringify({
      patchId: 'bench-patch-1', operationId: 'bench-operation-1', baseGraphVersion: 1,
      added: [], revised: [], retired: [], descendants: [], takesOver: [], revisionPendingWorkPackageIds: [],
    });
    const paddedPlan = makeNormalizedPlanBody(bodyBytes, plan);
    const insert = db.prepare(`INSERT INTO graph_versions (
      coordination_scope_id, graph_id, graph_version, graph_generation, record_kind, parent_version,
      map_revision, plan_revision, orca_run_id, graph_json, recorded_at, patch_id, patch_json, initial_plan_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (let version = 2; version <= count; version += 1) {
        insert.run('scope-1', initial.graph_id, version, initial.graph_generation, 'accepted_revision', version - 1,
          initial.map_revision, initial.plan_revision, initial.orca_run_id, initial.graph_json, version,
          `bench-patch-${version}`, patch, null);
      }
      if (paddedPlan !== null) {
        db.prepare('UPDATE graph_versions SET initial_plan_json = ? WHERE graph_id = ? AND graph_version = 1')
          .run(paddedPlan, initial.graph_id);
      }
      db.prepare('UPDATE scope SET graph_version = ? WHERE coordination_scope_id = ?').run(count, 'scope-1');
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }
}

async function waitForFrame(rendered, previousCount, previousFrame) {
  const deadline = performance.now() + 1_500;
  while (rendered.frames.length <= previousCount || rendered.lastFrame() === previousFrame) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for a rendered TuiApp response; frames=${rendered.frames.length}, previous=${previousCount}, tail=${String(rendered.lastFrame()).slice(-180)}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function waitForText(rendered, text) {
  const deadline = performance.now() + 1_500;
  while (!(rendered.lastFrame() ?? '').includes(text)) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for TuiApp text: ${text}; frame=${String(rendered.lastFrame())}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function sendAndMeasure(rendered, key) {
  const beforeCount = rendered.frames.length;
  const beforeFrame = rendered.lastFrame();
  const started = performance.now();
  rendered.stdin.write(key);
  await waitForFrame(rendered, beforeCount, beforeFrame);
  return performance.now() - started;
}

async function openBasisVersions(rendered) {
  // Wait for each production view before sending the next key. A key received
  // while its destination page is still loading is intentionally not replayed.
  await sendAndMeasure(rendered, '\u0007');
  await waitForText(rendered, 'Graph Inspector');
  await sendAndMeasure(rendered, '\r');
  await waitForText(rendered, 'Enter 依据与历史');
  await sendAndMeasure(rendered, '\r');
  await waitForText(rendered, '执行依据与历史图');
  await sendAndMeasure(rendered, '\r');
  await waitForText(rendered, '图版本历史');
  await waitForText(rendered, 'G1·v');
}

async function createRenderedApp(port, viewport) {
  const graph = { graphId: 'graph-1', graphVersion: 1, generation: 1 };
  const fake = createFakePorts({ snapshot: { graph, selectedSessionId: 'session-a', graphTopologies: [{
    graphId: graph.graphId, graphVersion: graph.graphVersion, generation: graph.generation,
    nodes: [{ workPackageId: 'wp-1', title: 'Benchmark package', dependsOn: [], scopeEnvelope: { include: ['src/**'], exclude: [] } }],
    readiness: { generationStatus: 'candidate', authorizationBound: false },
  }] } });
  // Reuse the project's real test adapter and change only its terminal's reported
  // width before a resize event, so the mounted production TuiApp takes each layout path.
  const { renderTui } = await import('../../dist/tests/tui/harness.js');
  const app = renderTui({ ...fake.ports, graphBasis: port });
  Object.defineProperty(app.stdout, 'columns', { configurable: true, value: viewport.columns });
  Object.defineProperty(app.stdout, 'rows', { configurable: true, value: viewport.rows });
  app.stdout.emit('resize');
  await settle(4);
  return { app, close: fake.closeInputStore };
}

async function openInitialPlanBody(app) {
  // Version directory → root → current source directory → initial plan → body.
  await sendAndMeasure(app, '\u001b');
  await waitForText(app, '执行依据与历史图');
  await sendAndMeasure(app, '\u001b[B');
  await sendAndMeasure(app, '\r');
  await waitForText(app, '原始 Implementation Plan');
  await sendAndMeasure(app, '\r');
  const deadline = performance.now() + 1_500;
  while (!(app.lastFrame() ?? '').includes('PgDn 下一段')) {
    if (performance.now() > deadline) throw new Error(`Could not open the production initial-plan body; frame=${String(app.lastFrame())}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function measureCase(root, scenario, includeUi, smokeOnly = false) {
  globalThis.console.log(`[graph-basis] start ${scenario.label}: ${scenario.versions} versions, ${scenario.bodyBytes} body bytes`);
  const directory = mkdtempSync(join(root, 'case-'));
  const databasePath = join(directory, 'coordination.sqlite');
  const opened = openCoordinationStore({ databasePath });
  if (opened.kind !== 'opened') throw new Error(opened.message);
  const store = opened.store;
  const created = store.transact({
    kind: 'initialize-scope', coordinationScopeId: 'scope-1', expectedRevision: 0,
    writer: { coordinatorSessionId: 'session-a', runtimeIncarnationId: 'bootstrap' , fencingGeneration: 0 },
    mode: 'route_planning', controlState: 'active', planningCycleId: 'cycle-1',
    fullBranchRef: 'refs/heads/main', canonicalWorktreePath: directory,
    coordinatorSessionId: 'session-a', coordinatorModelConfigurationRef: 'model-a',
  });
  if (created.kind !== 'committed') throw new Error(`Scope seed failed: ${JSON.stringify(created)}`);
  const bootstrapWriter = { coordinatorSessionId: 'session-a', runtimeIncarnationId: 'session-a-benchmark', fencingGeneration: 0 };
  const lease = store.transact({ kind: 'acquire-runtime-lease', coordinationScopeId: 'scope-1',
    expectedRevision: created.revision, writer: bootstrapWriter, ttlMs: 30_000 });
  if (lease.kind !== 'committed') throw new Error(`Runtime lease seed failed: ${JSON.stringify(lease)}`);
  const leases = store.query({ kind: 'leases', coordinationScopeId: 'scope-1' });
  if (leases.kind !== 'leases') throw new Error('Runtime lease could not be read back');
  const runtimeLease = leases.leases.find((item) => item.kind === 'runtime' && item.coordinatorSessionId === 'session-a');
  if (runtimeLease === undefined) throw new Error('Runtime lease record is missing');
  const writer = { ...bootstrapWriter, fencingGeneration: runtimeLease.fencingGeneration };
  const registered = store.transact({ kind: 'register-session', coordinationScopeId: 'scope-1',
    expectedRevision: lease.revision, writer, coordinatorSessionId: 'session-b',
    coordinatorModelConfigurationRef: 'model-b', lifecycleState: 'active' });
  if (registered.kind !== 'committed') throw new Error(`Session seed failed: ${JSON.stringify(registered)}`);
  const graphId = 'graph-1';
  const graph = {
    graphId, generation: 1, concurrencyLimit: 1,
    workPackages: [{ workPackageId: 'wp-1', title: 'Benchmark package', dependsOn: [],
      scopeEnvelope: { include: ['src/**'], exclude: [] },
      budget: { implementationAttempts: 2, validatorRepairs: 2, graphRevisions: 2, specificationRevisions: 2,
        maxRecoveriesPerWorkerAttempt: 1 } }],
  };
  const plan = { planRevision: 1, destinationRef: { kind: 'destination', id: 'bench-destination', version: 1 },
    workPackages: [{ key: 'bench-package', title: 'Benchmark package', dependsOn: [], scopeEnvelope: graph.workPackages[0].scopeEnvelope,
      requestedBudget: graph.workPackages[0].budget }] };
  const recorded = store.transact({ kind: 'record-graph-version', coordinationScopeId: 'scope-1', expectedRevision: registered.revision,
    writer,
    graphId, generation: 1, graphVersion: 1, recordKind: 'initial', parentVersion: null, mapRevision: 1, planRevision: 1,
    orcaRunId: 'bench-run', graph, patch: null, initialPlan: plan });
  if (recorded.kind !== 'committed') throw new Error(`Graph seed failed: ${JSON.stringify(recorded)}`);
  store.close();
  seedVersions(databasePath, scenario.versions, scenario.bodyBytes, plan);

  const production = openCoordinationStore({ databasePath });
  if (production.kind !== 'opened') throw new Error(production.message);
  const service = createGraphBasisService({ store: production.store, coordinationScopeId: 'scope-1',
    tracker: null, routeMapIssueRef: null, specification: async () => null });
  const rootReadStart = performance.now();
  const coldPage = await service.listVersions({ coordinatorSessionId: 'session-a', after: null });
  const coldReadMs = performance.now() - rootReadStart;
  assert.equal(coldPage.kind, 'read');
  assert.equal(coldPage.value.items.length, PAGE_SIZE);
  const rssBeforeScan = process.memoryUsage().rss;
  const scanStart = performance.now();
  let cursor = null, scanned = 0, pages = 0;
  do {
    const page = await service.listVersions({ coordinatorSessionId: 'session-a', after: cursor });
    assert.equal(page.kind, 'read');
    scanned += page.value.items.length;
    pages += 1;
    cursor = page.value.nextCursor;
  } while (cursor !== null);
  const fullScanMs = performance.now() - scanStart;
  const rssAfterScan = process.memoryUsage().rss;
  assert.equal(scanned, scenario.versions);

  const source = { kind: 'initial_plan', graph: { graphId, generation: 1, version: 1 } };
  let bodyReadMs = null, observedBodyBytes = 0;
  if (scenario.bodyBytes > 0) {
    const bodyStart = performance.now();
    const range = await service.readSource({ coordinatorSessionId: 'session-a', source, sourceVersion: null, offset: 0, maxBytes: BODY_BYTES });
    bodyReadMs = performance.now() - bodyStart;
    assert.equal(range.kind, 'read');
    observedBodyBytes = range.value.byteLength;
    assert.equal(observedBodyBytes, scenario.bodyBytes);
  }

  globalThis.console.log(`[graph-basis] ${scenario.label}: coldPage=${round(coldReadMs)}ms, fullScan=${round(fullScanMs)}ms (${pages} pages/${scanned} records), rssDelta=${rssAfterScan - rssBeforeScan} bytes, bodyRead=${bodyReadMs === null ? 'n/a' : `${round(bodyReadMs)}ms`}`);
  if (!includeUi) {
    production.store.close();
    rmSync(directory, { recursive: true, force: true });
    return { label: scenario.label, versions: scenario.versions, bodyBytes: scenario.bodyBytes,
      coldFirstPageReadMs: round(coldReadMs), fullDirectoryScan: { pages, records: scanned, elapsedMs: round(fullScanMs) },
      rssBytes: { beforeFullScan: rssBeforeScan, afterFullScan: rssAfterScan, delta: rssAfterScan - rssBeforeScan },
      bodyFirstRangeReadMs: bodyReadMs === null ? null : round(bodyReadMs) };
  }

  const viewports = [];
  for (const viewport of (smokeOnly ? VIEWPORTS.slice(0, 1) : VIEWPORTS)) {
    const viewportLabel = `${viewport.columns}x${viewport.rows}`;
    globalThis.console.log(`[graph-basis] ${scenario.label} ${viewportLabel}: start app input and cached navigation samples`);
    const rendered = await createRenderedApp(service, viewport);
    const app = rendered.app;
    try {
      await openBasisVersions(app);
      const versionNavigationMs = [];
      for (let index = 0; index < (smokeOnly ? 2 : SAMPLE_COUNT); index += 1) {
        versionNavigationMs.push(await sendAndMeasure(app, index % 2 === 0 ? '\u001b[B' : '\u001b[A'));
      }
      let bodyNavigationMs = null;
      if (scenario.bodyBytes > 0) {
        await openInitialPlanBody(app);
        await sendAndMeasure(app, '\u001b[6~');
        await sendAndMeasure(app, '\u001b[5~');
        bodyNavigationMs = [];
        for (let index = 0; index < (smokeOnly ? 2 : SAMPLE_COUNT); index += 1) {
          bodyNavigationMs.push(await sendAndMeasure(app, index % 2 === 0 ? '\u001b[6~' : '\u001b[5~'));
        }
      }
  for (let index = 0; index < 8 && !(app.lastFrame() ?? '').includes('输入消息…'); index += 1) {
        app.stdin.write('\u001b');
        await new Promise((resolve) => setTimeout(resolve, 40));
        await settle(2);
  }
  await waitForText(app, '输入消息…');
      const inputMs = [];
      for (let index = 0; index < (smokeOnly ? 2 : SAMPLE_COUNT); index += 1) {
        inputMs.push(await sendAndMeasure(app, String.fromCharCode(97 + index % 26)));
      }
      const measurements = { ...viewport, appInputFrameLatency: distribution(inputMs),
        cachedVersionNavigationLatency: distribution(versionNavigationMs),
        cachedBodyNavigationLatency: bodyNavigationMs === null ? null : distribution(bodyNavigationMs) };
      viewports.push(measurements);
      globalThis.console.log(`[graph-basis] ${scenario.label} ${viewportLabel}: done input p95=${measurements.appInputFrameLatency.p95Ms}ms, version-nav p95=${measurements.cachedVersionNavigationLatency.p95Ms}ms${measurements.cachedBodyNavigationLatency === null ? '' : `, body-nav p95=${measurements.cachedBodyNavigationLatency.p95Ms}ms`}`);
    } finally {
      app.unmount();
      rendered.close();
    }
  }
  production.store.close();
  rmSync(directory, { recursive: true, force: true });
  globalThis.console.log(`[graph-basis] done ${scenario.label}: scan=${round(fullScanMs)}ms, rssDelta=${rssAfterScan - rssBeforeScan} bytes, coldPage=${round(coldReadMs)}ms, bodyRead=${bodyReadMs === null ? 'n/a' : `${round(bodyReadMs)}ms`}`);
  return {
    label: scenario.label, versions: scenario.versions, pageSize: PAGE_SIZE,
    bodyBytes: scenario.bodyBytes, observedBodyBytes, coldFirstPageReadMs: round(coldReadMs),
    fullDirectoryScan: { pages, records: scanned, elapsedMs: round(fullScanMs) },
    rssBytes: { beforeFullScan: rssBeforeScan, afterFullScan: rssAfterScan, delta: rssAfterScan - rssBeforeScan },
    bodyFirstRangeReadMs: bodyReadMs === null ? null : round(bodyReadMs), viewports,
  };
}

function renderMarkdown(report) {
  const rows = report.cases.flatMap((item) => item.viewports.map((viewport) =>
    `| ${item.label} | ${viewport.columns}×${viewport.rows} | ${viewport.appInputFrameLatency.samples} | ${viewport.appInputFrameLatency.p95Ms} | ${viewport.cachedVersionNavigationLatency.p95Ms} | ${viewport.cachedBodyNavigationLatency?.p95Ms ?? '—'} | ${item.coldFirstPageReadMs} | ${item.fullDirectoryScan.elapsedMs} | ${item.rssBytes.delta} |`));
  return `# Graph basis performance evidence\n\n` +
    `Generated: ${report.generatedAt}\n\n` +
    `Command: \`${report.command}\` (exit ${report.exitCode})\n\n` +
    `Environment: Node ${report.environment.node}, platform ${report.environment.platform}/${report.environment.arch}; schema ${report.environment.schemaVersion}; build revision ${report.environment.gitHead}.\n\n` +
    `Latency is measured from a real key written to the mounted production TuiApp stdin until Ink emits its next changed frame. Each viewport records 100 composer-input and 100 cached-version-navigation observations; large-body cases also record 100 cached body-page navigation observations. These are application input responses, not service/helper timings. Viewports are 120×40, 80×24, and 50×40. Cold first-page service read, complete metadata scan, scan RSS delta, and first 64 KiB body read are separate measurements.\n\n` +
    `| Dataset | Viewport | Input samples | App input p95 (ms) | Cached version navigation p95 (ms) | Cached body navigation p95 (ms) | Cold first page (ms) | Full scan (ms) | RSS delta (bytes) |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n${rows.join('\n')}\n\n` +
    `## Body and scan details\n\n` + report.cases.map((item) =>
      `- **${item.label}:** ${item.versions} versions; ${item.fullDirectoryScan.pages} pages; full scan ${item.fullDirectoryScan.elapsedMs} ms; RSS ${item.rssBytes.beforeFullScan} → ${item.rssBytes.afterFullScan} bytes (${item.rssBytes.delta >= 0 ? '+' : ''}${item.rssBytes.delta}); body ${item.observedBodyBytes} bytes; first body range ${item.bodyFirstRangeReadMs ?? 'not applicable'} ms.`).join('\n') +
    `\n\n## Limits\n\n${report.limits.map((item) => `- ${item}`).join('\n')}\n` +
    (report.failure === undefined ? '' : `\n## Incomplete run\n\nStopped in **${report.failure.scenario ?? 'unknown case'}**: ${report.failure.message}\n`);
}

const preflightOnly = process.argv.includes('--preflight');
const smokeOnly = process.argv.includes('--smoke');
if (!process.argv.includes('--run') && !preflightOnly && !smokeOnly) {
  globalThis.console.log('Prepared. Performance slot is closed; rerun this script with --run only after the coordinator releases it.');
  process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), 'graph-basis-benchmark-'));
const started = new Date();
const cases = [];
let activeScenario = null;
try {
  const scenarios = smokeOnly ? CASES.slice(0, 1) : CASES;
  for (const [index, scenario] of scenarios.entries()) {
    activeScenario = scenario;
    globalThis.console.log(`[graph-basis] case ${index + 1}/${CASES.length}`);
    cases.push(await measureCase(root, scenario, !preflightOnly, smokeOnly));
  }
  if (preflightOnly) {
    globalThis.console.log(JSON.stringify({ mode: 'preflight-only-no-ui-samples-no-report', cases }, null, 2));
    process.exitCode = 0;
  } else if (smokeOnly) {
    globalThis.console.log(JSON.stringify({ mode: 'smoke-no-report', cases: cases.length }, null, 2));
  } else {
    const report = {
      generatedAt: started.toISOString(), command: 'node artifacts/graph-basis/benchmark.mjs --run', exitCode: 0,
      environment: { node: process.version, platform: process.platform, arch: process.arch, schemaVersion: SCHEMA_VERSION, gitHead: process.env['GIT_HEAD'] ?? 'not captured' },
      cases,
      limits: [
        'Version rows are synthetic history records inserted into a temporary database after production schema migration and production v1 graph creation; this isolates directory scaling from 100,000 CAS transactions.',
        'Large body fixtures are valid normalized ImplementationPlan JSON, accepted by the production parser and padded through the plan title to exactly 1 or 5 MiB in the schema-17 initial-plan column.',
        'Input latency includes terminal event handling, production TuiApp state update, Ink rendering, and the next changed frame. It excludes terminal hardware flush and human-visible display scanout.',
        'RSS is process-wide and allocator/GC sensitive; the before/after delta is descriptive and may include unrelated runtime allocations.',
        'The report records no claim of isolated CPU unless no competing benchmark workload was active during the released slot.',
      ],
    };
    writeFileSync(new URL('performance.json', OUT), JSON.stringify(report, null, 2) + '\n');
    writeFileSync(new URL('performance.md', OUT), renderMarkdown(report));
    for (const item of cases) {
      for (const viewport of item.viewports) {
        if (viewport.appInputFrameLatency.p95Ms > 100 || viewport.cachedVersionNavigationLatency.p95Ms > 100 ||
          (viewport.cachedBodyNavigationLatency !== null && viewport.cachedBodyNavigationLatency.p95Ms > 100)) process.exitCode = 1;
      }
    }
    report.exitCode = process.exitCode ?? 0;
    writeFileSync(new URL('performance.json', OUT), JSON.stringify(report, null, 2) + '\n');
    writeFileSync(new URL('performance.md', OUT), renderMarkdown(report));
    globalThis.console.log(JSON.stringify({ exitCode: report.exitCode, output: ['artifacts/graph-basis/performance.json', 'artifacts/graph-basis/performance.md'], cases: cases.length }, null, 2));
  }
} catch (error) {
  if (process.argv.includes('--run')) {
    const report = {
      generatedAt: started.toISOString(), command: 'node artifacts/graph-basis/benchmark.mjs --run', exitCode: 1,
      environment: { node: process.version, platform: process.platform, arch: process.arch, schemaVersion: SCHEMA_VERSION, gitHead: process.env['GIT_HEAD'] ?? 'not captured' },
      cases,
      limits: ['Partial evidence only: the active case did not complete all requested UI samples. Completed cases remain valid independent measurements.'],
      failure: { scenario: activeScenario?.label ?? null, message: error instanceof Error ? error.message : String(error) },
    };
    writeFileSync(new URL('performance.json', OUT), JSON.stringify(report, null, 2) + '\n');
    writeFileSync(new URL('performance.md', OUT), renderMarkdown(report));
  }
  throw error;
} finally {
  rmSync(root, { recursive: true, force: true });
}
