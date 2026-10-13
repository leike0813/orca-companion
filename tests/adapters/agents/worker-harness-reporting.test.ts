import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { installCandidateReporter } from '../../../src/adapters/agents/candidate-worker-launch.js';
import { maintainReporting, COMPANION_REPORT_HOOK } from '../../../src/adapters/agents/worker-harness-reporting.js';

const concurrent = vi.hoisted(() => ({ target: '', replacement: '' }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
    fs.writeFileSync(...args);
    if (concurrent.target && String(args[0]) === `${concurrent.target}.companion-${process.pid}`) {
      fs.writeFileSync(concurrent.target, concurrent.replacement);
    }
  } };
});
afterEach(() => { concurrent.target = ''; concurrent.replacement = ''; });

test.each(['install', 'uninstall'] as const)('reporter %s preserves a concurrent native config edit', (action) => {
  const root = mkdtempSync(join(tmpdir(), 'ocp-report-race-'));
  const configPath = join(root, 'hooks.json'), entry = { Stop: [] };
  writeFileSync(configPath, JSON.stringify({ user: 1, ...(action === 'uninstall' ? { [COMPANION_REPORT_HOOK]: entry } : {}) }));
  concurrent.target = configPath;
  concurrent.replacement = JSON.stringify({ user: 2 });
  expect(() => maintainReporting({ configPath, entry }, action, root)).toThrow();
  expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({ user: 2 });
});

test('private reporter reuses identical content and refuses conflicts or symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'ocp-report-file-'));
  const reporterPath = join(root, 'report.mjs'), reportPath = join(root, 'report.jsonl');
  installCandidateReporter({ reporterPath, reportPath }, 'original');
  installCandidateReporter({ reporterPath, reportPath }, 'original');
  expect(() => installCandidateReporter({ reporterPath, reportPath }, 'different')).toThrow();
  const linked = join(root, 'linked.mjs');
  symlinkSync(reporterPath, linked);
  expect(() => installCandidateReporter({ reporterPath: linked, reportPath }, 'original')).toThrow();
  expect(readFileSync(reporterPath, 'utf8')).toBe('original');
});
