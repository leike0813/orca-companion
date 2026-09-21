import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'vitest';

import {
  proveCodexTranscript,
  inspectCodexTranscript,
  type CodexSessionStartReport,
} from '../../../src/adapters/agents/codex-transcript.js';
import { bindCodexSessionFromStartReport } from '../../../src/adapters/agents/session-binding.js';
import type { DispatchId, WorkerTaskId } from '../../../src/application/dto/identity.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(): {
  readonly root: string;
  readonly codexHome: string;
  readonly workspace: string;
  readonly transcriptPath: string;
  readonly sessionId: string;
  readonly report: CodexSessionStartReport;
} {
  const root = mkdtempSync(join(tmpdir(), 'orca-codex-transcript.'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  const codexHome = join(workspace, '.codex');
  const sessions = join(codexHome, 'sessions', '2026', '09', '21');
  const sessionId = '01a0c283-e05a-7671-a3f9-2d2aceac3400';
  const transcriptPath = join(sessions, `rollout-2026-09-21T13-50-17-${sessionId}.jsonl`);
  mkdirSync(sessions, { recursive: true });
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: workspace } })}\n`,
    'utf8',
  );
  return {
    root,
    codexHome,
    workspace,
    transcriptPath,
    sessionId,
    report: {
      sessionId,
      transcriptPath,
      codexHome,
      cwd: workspace,
      observedAt: '2026-09-21T05:50:20.000Z',
    },
  };
}

function prove(created: ReturnType<typeof fixture>, report: CodexSessionStartReport = created.report) {
  return proveCodexTranscript({
    report,
    workspace: created.workspace,
    dispatchStartedAt: '2026-09-21T05:50:00.000Z',
    bindingDeadlineAt: '2026-09-21T05:51:00.000Z',
  });
}

test('唯一 rollout 的文件名、session_meta、workspace 与 Dispatch 时间窗一致时签发本地引用', () => {
  const created = fixture();
  const result = prove(created);

  expect(result.kind).toBe('proven');
  if (result.kind === 'proven') {
    expect(result.proof.providerSessionId).toBe(created.sessionId);
    expect(result.proof.transcriptRef).toBe(created.transcriptPath);
  }

  const binding = bindCodexSessionFromStartReport({
    facts: {
      harness: 'codex',
      role: 'validator',
      workerTaskId: 'task-1' as WorkerTaskId,
      dispatchId: 'dispatch-1' as DispatchId,
      attemptId: 'attempt-1',
    },
    report: created.report,
    workspace: created.workspace,
    dispatchStartedAt: '2026-09-21T05:50:00.000Z',
    bindingDeadlineAt: '2026-09-21T05:51:00.000Z',
  });
  expect(binding.kind).toBe('bound');
});

test('缺字段、时间窗外、metadata 冲突、workspace 冲突或多候选都返回 transcript_unavailable', () => {
  const created = fixture();
  const otherWorkspace = join(created.root, 'other-workspace');
  mkdirSync(otherWorkspace);

  const cases: CodexSessionStartReport[] = [
    { ...created.report, sessionId: null },
    { ...created.report, observedAt: '2026-09-21T05:52:00.000Z' },
    { ...created.report, cwd: otherWorkspace },
  ];
  for (const report of cases) {
    expect(prove(created, report).kind).toBe('transcript_unavailable');
  }

  writeFileSync(
    created.transcriptPath,
    `${JSON.stringify({ type: 'session_meta', payload: { id: 'different-session', cwd: created.workspace } })}\n`,
    'utf8',
  );
  expect(prove(created).kind).toBe('transcript_unavailable');

  writeFileSync(
    created.transcriptPath,
    `${JSON.stringify({ type: 'session_meta', payload: { id: created.sessionId, cwd: created.workspace } })}\n`,
    'utf8',
  );
  const duplicateDir = join(created.codexHome, 'sessions', '2026', '09', '22');
  mkdirSync(duplicateDir, { recursive: true });
  writeFileSync(
    join(duplicateDir, `rollout-duplicate-${created.sessionId}.jsonl`),
    `${JSON.stringify({ type: 'session_meta', payload: { id: created.sessionId, cwd: created.workspace } })}\n`,
    'utf8',
  );
  expect(prove(created).kind).toBe('transcript_unavailable');
});

test('Adapter 根据实际 JSONL 读取结果给出 complete 或带定位缺口的 partial', async () => {
  const created = fixture();
  appendFileSync(created.transcriptPath, `${JSON.stringify({ ordinal: 1, type: 'event' })}\n`, 'utf8');

  const complete = await inspectCodexTranscript(created.transcriptPath);
  expect(complete.kind).toBe('covered');
  if (complete.kind === 'covered') {
    expect(complete.evidence.coverage).toBe('complete');
    expect(complete.evidence.gaps).toEqual([]);
  }

  appendFileSync(created.transcriptPath, '{broken-json\n', 'utf8');
  const partial = await inspectCodexTranscript(created.transcriptPath);
  expect(partial.kind).toBe('covered');
  if (partial.kind === 'covered') {
    expect(partial.evidence.coverage).toBe('partial');
    expect(partial.evidence.gaps).toHaveLength(1);
    expect(partial.evidence.lastCompleteEventRef).toBe('ordinal:1');
  }
});
