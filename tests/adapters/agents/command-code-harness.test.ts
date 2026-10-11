import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  commandCodeHarness, createCommandCodeResumeLaunch, inspectCommandCodeTranscript,
  proveCommandCodeTranscript, readCommandCodeTranscriptIdentity,
} from '../../../src/adapters/agents/command-code-harness.js';
import { CODEX_MODEL_DESCRIPTOR_FILENAME } from '../../../src/adapters/agents/codex-model-launcher.js';
import type { HarnessSessionReport } from '../../../src/application/ports/worker-harness.js';
import type { WorkerModelSelection } from '../../../src/domain/model-configuration.js';

const selection: WorkerModelSelection = {
  model: 'MiniMax-M2.5', effort: null, effortCapability: null, catalogSource: null,
};
const worktree = '/tmp/command-code-project';
const sessionId = 'cc-session-123';
const entries = [
  { type: 'message', id: 'root', parentId: null, timestamp: '2026-10-11T00:00:00.000Z', message: {} },
  { type: 'message', id: 'active', parentId: 'root', timestamp: '2026-10-11T00:01:00.000Z', message: {} },
  { type: 'message', id: 'other', parentId: 'root', timestamp: '2026-10-11T00:02:00.000Z', message: {} },
];
function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'command-code-adapter-'));
}

function fixture(leafId = 'active') {
  const root = tempRoot();
  const nativeRoot = join(root, '.commandcode');
  const projectRoot = join(nativeRoot, 'projects', 'command-code-project');
  const transcriptPath = join(projectRoot, `${sessionId}.jsonl`);
  const reportPath = join(root, 'companion', 'session-start.jsonl');
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(transcriptPath, [
    JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp: '2026-10-11T00:00:00.000Z', cwd: worktree }),
    ...entries.map((entry) => JSON.stringify(entry)),
  ].join('\n') + '\n');
  writeFileSync(`${transcriptPath}.companion-leaf.json`, JSON.stringify({ sessionId, leafId }) + '\n');
  const report = {
    harness: 'command-code', sessionId, transcriptPath, cwd: worktree,
    observedAt: '2026-10-11T00:03:00.000Z', stateRoot: nativeRoot, runtimeRoots: [nativeRoot],
  };
  writeFileSync(reportPath, JSON.stringify(report) + '\n');
  return { root, nativeRoot, reportPath, transcriptPath, report };
}

describe('command-code adapter', () => {
  test('launches the exact selected model with updates disabled through the shared descriptor', async () => {
    const root = tempRoot();
    const prepared = await commandCodeHarness.prepareLaunch({
      launchId: 'launch-1', modelSelection: selection, sandboxMode: 'workspace-write', stateRoot: join(root, 'state'),
    }).prepare({ worktreePath: worktree });
    const descriptor = JSON.parse(readFileSync(join(prepared.stateRoot, CODEX_MODEL_DESCRIPTOR_FILENAME), 'utf8')) as {
      args: string[]; harness: string;
    };
    expect(descriptor.harness).toBe('command-code');
    expect(descriptor.args).toContain('--no-auto-update');
    expect(descriptor.args).toContain('--local-only');
    expect(descriptor.args.slice(descriptor.args.indexOf('--model') + 1, descriptor.args.indexOf('--model') + 2))
      .toEqual([selection.model]);
    expect(descriptor.args).toContain('--mod');
    expect(prepared.command).toContain(CODEX_MODEL_DESCRIPTOR_FILENAME);
  });

  test('reports the native transcript path and proves its v3 identity without reading a report reference', async () => {
    const valid = fixture();
    const report: HarnessSessionReport = {
      sessionId, transcriptPath: valid.transcriptPath, cwd: worktree, observedAt: valid.report.observedAt,
      stateRoot: valid.nativeRoot, harness: 'command-code', runtimeRoots: [valid.nativeRoot],
    };
    await expect(readCommandCodeTranscriptIdentity({ transcriptRef: valid.transcriptPath, workspace: worktree }))
      .resolves.toEqual({ providerSessionId: sessionId });
    await expect(readCommandCodeTranscriptIdentity({ transcriptRef: valid.reportPath, workspace: worktree }))
      .resolves.toMatchObject({ kind: 'transcript_unavailable' });
    await expect(proveCommandCodeTranscript({
      report, workspace: worktree, expectedStateRoot: valid.nativeRoot,
      dispatchStartedAt: '2026-10-11T00:02:00.000Z', bindingDeadlineAt: '2026-10-11T00:04:00.000Z',
    })).resolves.toMatchObject({ kind: 'proven', proof: { providerSessionId: sessionId, transcriptRef: valid.transcriptPath } });
    await expect(proveCommandCodeTranscript({
      report, workspace: worktree, expectedStateRoot: valid.nativeRoot,
      dispatchStartedAt: '2026-10-11T00:04:00.000Z', bindingDeadlineAt: '2026-10-11T00:05:00.000Z',
    })).resolves.toMatchObject({ kind: 'transcript_unavailable' });
  });

  test('rejects a wrong cwd and follows only the precise active-leaf sidecar', async () => {
    const valid = fixture();
    await expect(readCommandCodeTranscriptIdentity({ transcriptRef: valid.transcriptPath, workspace: '/tmp/other-project' }))
      .resolves.toMatchObject({ kind: 'transcript_unavailable' });
    await expect(inspectCommandCodeTranscript(valid.transcriptPath)).resolves.toMatchObject({
      kind: 'covered', evidence: { readableRange: { fromEventRef: 'root', toEventRef: 'active' }, lastCompleteEventRef: 'active' },
    });
    const otherLeaf = fixture('other');
    await expect(inspectCommandCodeTranscript(otherLeaf.transcriptPath)).resolves.toMatchObject({
      kind: 'covered', evidence: { readableRange: { fromEventRef: 'root', toEventRef: 'other' } },
    });
  });

  test.each(['identity', 'coverage'])('invalid UTF-8 transcript bytes are rejected by %s inspection', async (inspection) => {
    const f = fixture();
    const header = JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd: worktree, metadata: 'x' });
    const malformed = (line: string) => Buffer.concat([
      Buffer.from(line.slice(0, -2), 'utf8'), Buffer.from([0xff]), Buffer.from(`${line.slice(-2)}\n`, 'utf8'),
    ]);
    if (inspection === 'identity') {
      writeFileSync(f.transcriptPath, Buffer.concat([malformed(header), Buffer.from(`${JSON.stringify(entries[0])}\n`)]));
      await expect(readCommandCodeTranscriptIdentity({ transcriptRef: f.transcriptPath, workspace: worktree }))
        .resolves.toMatchObject({ kind: 'transcript_unavailable' });
    } else {
      const root = JSON.stringify({ type: 'message', id: 'root', parentId: null, metadata: 'x' });
      writeFileSync(f.transcriptPath, Buffer.concat([
        Buffer.from(`${JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd: worktree })}\n`),
        malformed(root), Buffer.from(`${entries.slice(1).map((item) => JSON.stringify(item)).join('\n')}\n`),
      ]));
      await expect(inspectCommandCodeTranscript(f.transcriptPath)).resolves.toMatchObject({ kind: 'transcript_unavailable' });
    }
  });

  test('resume uses the original native transcript and verifies its session id and cwd', async () => {
    const original = fixture();
    const strategy = createCommandCodeResumeLaunch({
      launchId: 'resume-1', modelSelection: selection, sandboxMode: 'workspace-write',
      sessionId, originalStateRoot: original.nativeRoot, transcriptRef: original.transcriptPath,
      stateRoot: join(original.root, 'companion', 'resume'),
    });
    const prepared = await strategy.prepare({ worktreePath: worktree });
    expect(prepared.title).toBe(strategy.title);
    const descriptor = JSON.parse(readFileSync(join(prepared.stateRoot, CODEX_MODEL_DESCRIPTOR_FILENAME), 'utf8')) as { args: string[] };
    expect(descriptor.args.slice(descriptor.args.indexOf('--session') + 1, descriptor.args.indexOf('--session') + 2))
      .toEqual([original.transcriptPath]);
    expect(descriptor.args).toContain('--no-auto-update');
  });
});
