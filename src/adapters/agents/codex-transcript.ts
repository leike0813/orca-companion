/** Codex SessionStart 报告到精确本地 transcript 的证明。 */

import { closeSync, createReadStream, globSync, openSync, readSync, realpathSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { createInterface } from 'node:readline';

import type { TranscriptCoverageEvidence } from '../../application/recovery/recovery-capsule.js';

const SESSION_META_READ_LIMIT = 1024 * 1024;
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type CodexSessionStartReport = {
  readonly sessionId: string | null;
  readonly transcriptPath: string | null;
  readonly codexHome: string | null;
  readonly cwd: string | null;
  readonly observedAt: string | null;
};

export type CodexTranscriptProof = {
  readonly providerSessionId: string;
  readonly transcriptRef: string;
  readonly observedAt: string;
};

export type CodexTranscriptProofResult =
  | { readonly kind: 'proven'; readonly proof: CodexTranscriptProof }
  | { readonly kind: 'transcript_unavailable'; readonly reason: string };

export type CodexTranscriptCoverageResult =
  | { readonly kind: 'covered'; readonly evidence: TranscriptCoverageEvidence }
  | { readonly kind: 'transcript_unavailable'; readonly reason: string };

function unavailable(reason: string): { readonly kind: 'transcript_unavailable'; readonly reason: string } {
  return { kind: 'transcript_unavailable', reason };
}

function instant(value: string | null): number | null {
  if (value === null || value.length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path.length > 0 && path !== '..' && !path.startsWith(`..${sep}`);
}

function firstRecord(path: string): unknown {
  const descriptor = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(SESSION_META_READ_LIMIT);
    const length = readSync(descriptor, buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, length).indexOf(10);
    if (newline < 0 && length === buffer.length) {
      throw new Error('首条 session_meta 超过读取上限');
    }
    const record = buffer.subarray(0, newline < 0 ? length : newline).toString('utf8');
    return JSON.parse(record);
  } finally {
    closeSync(descriptor);
  }
}

function sessionMeta(value: unknown): { readonly id: string; readonly cwd: string } | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record['type'] !== 'session_meta' || typeof record['payload'] !== 'object' || record['payload'] === null) {
    return null;
  }
  const payload = record['payload'] as Record<string, unknown>;
  return typeof payload['id'] === 'string' && typeof payload['cwd'] === 'string'
    ? { id: payload['id'], cwd: payload['cwd'] }
    : null;
}

/**
 * 只在全部身份事实唯一且一致时签发 transcriptRef。
 *
 * SessionStart 在首个模型请求前报告 session、transcript 与 cwd；调用方同时附上实际 CODEX_HOME 和
 * Dispatch 绑定窗口。这里不按 mtime、模糊 cwd 或“最新文件”降级匹配。
 */
export function proveCodexTranscript(input: {
  readonly report: CodexSessionStartReport;
  readonly workspace: string;
  readonly dispatchStartedAt: string;
  readonly bindingDeadlineAt: string;
}): CodexTranscriptProofResult {
  const { report } = input;
  if (
    report.sessionId === null ||
    report.transcriptPath === null ||
    report.codexHome === null ||
    report.cwd === null ||
    report.observedAt === null ||
    !SAFE_SESSION_ID.test(report.sessionId)
  ) {
    return unavailable('SessionStart 缺少可核验的 session ID、CODEX_HOME、transcript path、cwd 或观察时间');
  }

  const observedAt = instant(report.observedAt);
  const startedAt = instant(input.dispatchStartedAt);
  const deadlineAt = instant(input.bindingDeadlineAt);
  if (
    observedAt === null ||
    startedAt === null ||
    deadlineAt === null ||
    deadlineAt < startedAt ||
    observedAt < startedAt ||
    observedAt > deadlineAt
  ) {
    return unavailable('SessionStart 报告不在当前 Dispatch 绑定时间窗内');
  }

  try {
    const codexHome = realpathSync(report.codexHome);
    const sessionsRoot = realpathSync(`${codexHome}/sessions`);
    const transcriptPath = realpathSync(report.transcriptPath);
    const workspace = realpathSync(input.workspace);
    if (!isInside(workspace, codexHome)) {
      return unavailable('CODEX_HOME 不在绑定 workspace 内');
    }
    if (!isInside(sessionsRoot, transcriptPath)) {
      return unavailable('transcript path 不在已上报 CODEX_HOME 的 sessions 目录内');
    }

    const suffix = `-${report.sessionId}.jsonl`;
    if (!basename(transcriptPath).endsWith(suffix)) {
      return unavailable('rollout 文件名中的 session ID 与上报值不一致');
    }

    const candidates = new Set(
      globSync(`sessions/**/rollout-*-${report.sessionId}.jsonl`, { cwd: codexHome }).map((path) =>
        realpathSync(join(codexHome, path)),
      ),
    );
    if (candidates.size !== 1 || !candidates.has(transcriptPath)) {
      return unavailable(`精确 rollout 候选数量必须为 1，实际为 ${candidates.size}`);
    }

    const meta = sessionMeta(firstRecord(transcriptPath));
    if (meta === null || meta.id !== report.sessionId) {
      return unavailable('首条 session_meta.id 与上报 session ID 不一致');
    }
    if (realpathSync(meta.cwd) !== workspace || realpathSync(report.cwd) !== workspace) {
      return unavailable('SessionStart cwd 或 session_meta.cwd 与绑定 workspace 不一致');
    }

    return {
      kind: 'proven',
      proof: {
        providerSessionId: report.sessionId,
        transcriptRef: transcriptPath,
        observedAt: report.observedAt,
      },
    };
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : 'Codex transcript 证明失败');
  }
}

function eventRef(value: unknown, line: number): string {
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record['ordinal'] === 'number' || typeof record['ordinal'] === 'string') {
      return `ordinal:${String(record['ordinal'])}`;
    }
    if (typeof record['timestamp'] === 'string' && record['timestamp'].length > 0) {
      return `timestamp:${record['timestamp']}`;
    }
  }
  return `line:${line}`;
}

/** 只记录事件边界与解析失败，不把 transcript 正文复制进 Capsule 或协调存储。 */
export async function inspectCodexTranscript(transcriptRef: string): Promise<CodexTranscriptCoverageResult> {
  let line = 0;
  let firstEventRef: string | null = null;
  let lastCompleteEventRef: string | null = null;
  try {
    const transcriptPath = realpathSync(transcriptRef);
    const lines = createInterface({ input: createReadStream(transcriptPath, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const raw of lines) {
      line += 1;
      if (raw.length === 0) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        if (firstEventRef === null || lastCompleteEventRef === null) {
          return unavailable('transcript 在首个完整事件前解析失败');
        }
        return {
          kind: 'covered',
          evidence: {
            coverage: 'partial',
            readableRange: {
              transcriptRef: transcriptPath,
              fromEventRef: firstEventRef,
              toEventRef: lastCompleteEventRef,
            },
            gaps: [{ fromEventRef: `line:${line}`, toEventRef: null, reason: 'invalid_json' }],
            lastCompleteEventRef,
          },
        };
      }
      const ref = eventRef(parsed, line);
      firstEventRef ??= ref;
      lastCompleteEventRef = ref;
    }
    if (firstEventRef === null || lastCompleteEventRef === null) {
      return unavailable('transcript 没有完整事件');
    }
    return {
      kind: 'covered',
      evidence: {
        coverage: 'complete',
        readableRange: {
          transcriptRef: transcriptPath,
          fromEventRef: firstEventRef,
          toEventRef: lastCompleteEventRef,
        },
        gaps: [],
        lastCompleteEventRef,
      },
    };
  } catch (error) {
    if (firstEventRef !== null && lastCompleteEventRef !== null) {
      return {
        kind: 'covered',
        evidence: {
          coverage: 'partial',
          readableRange: {
            transcriptRef,
            fromEventRef: firstEventRef,
            toEventRef: lastCompleteEventRef,
          },
          gaps: [{ fromEventRef: `line:${line + 1}`, toEventRef: null, reason: 'read_failed' }],
          lastCompleteEventRef,
        },
      };
    }
    return unavailable(error instanceof Error ? error.message : 'Codex transcript 读取失败');
  }
}
