import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { readBaselineGitObservations } from '../../src/adapters/git/baseline-observer.js';
import { baselineObservations } from '../../src/application/execution/baseline-reconciliation.js';

test('真实 Git worktree 的 HEAD、祖先关系和越界 dirty path 均从现场读取', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'baseline-git-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    git('config', 'user.name', 'Verification');
    git('config', 'user.email', 'verification@example.invalid');
    mkdirSync(join(directory, 'src'));
    writeFileSync(join(directory, 'src', 'feature.ts'), 'export const value = 1;\n');
    git('add', '.');
    git('commit', '-qm', 'baseline');
    const requiredBaselineHead = git('rev-parse', 'HEAD');
    writeFileSync(join(directory, 'src', 'feature.ts'), 'export const value = 2;\n');
    mkdirSync(join(directory, 'docs'));
    writeFileSync(join(directory, 'docs', 'outside.md'), 'outside\n');

    const read = await readBaselineGitObservations({ worktreePath: directory, requiredBaselineHead });
    expect(read.kind).toBe('observed');
    if (read.kind !== 'observed') return;
    expect(read.git.observedHead).toBe(requiredBaselineHead);
    expect(read.git.descendantOfRequiredBaseline).toBe(true);
    expect(read.git.dirtyPaths).toEqual(expect.arrayContaining(['src/feature.ts', 'docs/outside.md']));
    const observations = baselineObservations({ envelope: { include: ['src'], exclude: [] }, requiredBaselineHead, git: read.git });
    expect(observations.scopeReconciled).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
