// Reuse the measured production reader/App benchmark without modifying its historical assets.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const output = 'artifacts/project-statusline';
mkdirSync(output, { recursive: true });
const source = readFileSync('artifacts/bounded-transcript/benchmark.mjs', 'utf8')
  .replace("const output = 'artifacts/bounded-transcript'", "const output = 'artifacts/project-statusline'")
  .replace("baseline: 'b15ff20d4fe7d42a218c7259fb0ebc793f24d2ae'", "baseline: '82f6a77'")
  .replaceAll("'../../dist/", "'./dist/");
// This is a new evidence payload, not a rewrite of the existing benchmark.
execFileSync(process.execPath, ['--input-type=module', '-e', source], { cwd: process.cwd(), stdio: 'inherit' });
writeFileSync(output + '/benchmark-scope.txt',
  'Current production App and reader; shared bounded-transcript benchmark workload.\n' +
  'No external model, Orca, tracker or user preferences are used.\n');
