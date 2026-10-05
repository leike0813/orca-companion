/**
 * 集成复验生产 runner 的结构化报告解析回归（change: restore-configurable-execution-concurrency，IP-03）。
 *
 * 公共 worker-done 允许任意 body：报告以严格有界 JSON 放在 body，自带 schema/ids。泛化的 files/summary
 * 不构成通过证据；解析失败一律拒绝，不降级。
 */

import { expect, test } from 'vitest';

import {
  parseRevalidationReport,
  revalidationAdmissionFailure,
  revalidationWriteScopeViolation,
} from '../../src/bootstrap/integration-reconciliation-runtime.js';
import type { EvidenceRecord } from '../../src/domain/worker-report.js';

const TREE = 'a'.repeat(40);
const EXPECTED = { taskId: 'task-1', dispatchId: 'dispatch-1' };

function body(fields: Record<string, unknown>): string {
  return JSON.stringify({ schemaVersion: 1, taskId: 'task-1', dispatchId: 'dispatch-1', filesModified: [], ...fields });
}

test('接受 body 里的结构化复验报告并读回真实证据字段', () => {
  const parsed = parseRevalidationReport(body({
    outcome: 'passed',
    summary: 'merged tree re-verified',
    treeRef: TREE,
    evidence: [{ kind: 'command', coveredPaths: ['src/a.ts'], command: 'pnpm test', outcome: 'passed', summary: 'unit tests pass' }],
  }), EXPECTED);
  expect(parsed).not.toBeNull();
  expect(parsed?.outcome).toBe('passed');
  expect(parsed?.treeRef).toBe(TREE);
  expect(parsed?.evidence[0]).toMatchObject({ kind: 'command', coveredPaths: ['src/a.ts'], command: 'pnpm test', outcome: 'passed' });
});

test('泛化 files/summary 或缺失 schema/ids 的 body 不构成通过证据', () => {
  expect(parseRevalidationReport(JSON.stringify({ outcome: 'succeeded', filesModified: ['src/a.ts'], summary: 'looks fine' }), EXPECTED)).toBeNull();
  expect(parseRevalidationReport(body({ outcome: 'passed' }), EXPECTED)).toBeNull();
  expect(parseRevalidationReport(null, EXPECTED)).toBeNull();
  expect(parseRevalidationReport('not json', EXPECTED)).toBeNull();
});

test('body 自报的 Task/Dispatch 必须与消息身份一致', () => {
  const valid = body({ outcome: 'passed', summary: 's', treeRef: TREE, evidence: [{ kind: 'command', coveredPaths: ['a'], command: 'pnpm test', outcome: 'passed', summary: 's' }] });
  expect(parseRevalidationReport(valid, { taskId: 'other', dispatchId: 'dispatch-1' })).toBeNull();
  expect(parseRevalidationReport(valid, { taskId: 'task-1', dispatchId: 'other' })).toBeNull();
  expect(parseRevalidationReport(valid, EXPECTED)).not.toBeNull();
});

test('缺失或非法的树、outcome、证据都被拒绝', () => {
  const base = { outcome: 'passed', summary: 's', treeRef: TREE, evidence: [{ kind: 'command', coveredPaths: ['a'], command: 'pnpm test', outcome: 'passed', summary: 's' }] };
  expect(parseRevalidationReport(body({ ...base, outcome: '' }), EXPECTED)).toBeNull();
  expect(parseRevalidationReport(body({ ...base, treeRef: 'not-a-tree' }), EXPECTED)).toBeNull();
  expect(parseRevalidationReport(body({ ...base, evidence: [] }), EXPECTED)).toBeNull();
  expect(parseRevalidationReport(body({ ...base, evidence: [{ kind: 'command', coveredPaths: ['a'], command: ' ', outcome: 'passed', summary: 's' }] }), EXPECTED)).toBeNull();
  expect(parseRevalidationReport(body({ ...base, evidence: [{ kind: 'bogus', coveredPaths: ['a'], command: 'pnpm test', outcome: 'passed', summary: 's' }] }), EXPECTED)).toBeNull();
  expect(parseRevalidationReport(body({ ...base, evidence: [{ kind: 'command', coveredPaths: [], command: 'pnpm test', outcome: 'passed', summary: 's' }] }), EXPECTED)).toBeNull();
});

test('filesModified 字段必须存在；缺失即拒绝（无旧 schema 兼容）', () => {
  const base = { outcome: 'passed', summary: 's', treeRef: TREE, evidence: [{ kind: 'command', coveredPaths: ['a'], command: 'pnpm test', outcome: 'passed', summary: 's' }] };
  expect(parseRevalidationReport(body({ ...base, filesModified: [] }), EXPECTED)).not.toBeNull();
  expect(parseRevalidationReport(body({ ...base, filesModified: ['src/domain/a.ts'] }), EXPECTED)).not.toBeNull();
  // 手工构造缺字段的 body（helper 默认会补）：必须拒绝。
  const missing = JSON.stringify({ schemaVersion: 1, taskId: 'task-1', dispatchId: 'dispatch-1', ...base });
  expect(parseRevalidationReport(missing, EXPECTED)).toBeNull();
});

test('报告准入：范围外读取放行，范围外修改/冲突拒绝', () => {
  const envelope = { include: ['src/domain'], exclude: [] };
  // canonical 导入的范围外文件出现在读取覆盖里（只读复验），但未被修改 → 放行。
  const evidence: EvidenceRecord[] = [
    { evidenceId: 'e1', kind: 'inspection', coveredPaths: ['src/other/a.ts'], command: null, summary: 'read canonical import', outcome: 'passed' },
  ];
  const report = { outcome: 'passed', summary: 's', treeRef: TREE, filesModified: [] as readonly string[], evidence };
  expect(revalidationAdmissionFailure(envelope, [], report)).toBeNull();
  // 声明修改范围外路径 → 拒绝（这就是原 false positive 之外的真实越权情形）。
  expect(revalidationAdmissionFailure(envelope, [], { ...report, filesModified: ['src/other/a.ts'] })).toMatch(/超出授权范围/);
  // 范围外冲突 → 拒绝。
  expect(revalidationAdmissionFailure(envelope, ['src/other/a.ts'], report)).toMatch(/超出授权范围/);
  // 与普通 Worker 共用流程目录规则：更新规格工件和工具状态不算项目越界。
  const pipelinePaths = ['openspec/changes/unit/tasks.md', 'openspec/config.yaml', '.codex/report.json', '.agents/skills/worker/SKILL.md'];
  expect(revalidationAdmissionFailure(envelope, pipelinePaths, { ...report, filesModified: pipelinePaths })).toBeNull();
  // 通过结论却带失败证据记录 → 拒绝。
  expect(
    revalidationAdmissionFailure(envelope, [], { ...report, evidence: [{ ...evidence[0]!, outcome: 'failed' }] }),
  ).toMatch(/失败记录/);
  // 前置冲突 guard 与最终准入共用同一判定。
  expect(revalidationWriteScopeViolation(envelope, ['src/domain/a.ts'])).toBeNull();
  expect(revalidationWriteScopeViolation(envelope, ['src/other/a.ts'])).toMatch(/超出授权范围/);
});
