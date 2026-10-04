import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { openRepositoryCoordinationStore } from '../../../dist/src/bootstrap/composition.js';

assert.equal(process.argv.length, 5, 'usage: read-inspector-reconciliation.mjs <fixture.json> <work-package-id> <new-report.json>');
const fixture = JSON.parse(readFileSync(resolve(process.argv[2]), 'utf8'));
const target = process.argv[3];
const opened = await openRepositoryCoordinationStore({ repositoryPath: fixture.fixture, readOnly: true });
assert.equal(opened.kind, 'opened');
let record;
try {
  const scope = opened.store.query({ kind: 'scope', coordinationScopeId: fixture.coordinationScopeId });
  assert.equal(scope.scope.controlState, 'paused');
  const result = opened.store.query({ kind: 'baseline-reconciliations', coordinationScopeId: fixture.coordinationScopeId });
  record = result.reconciliations.find(entry => entry.workPackageId === target);
  assert.equal(record?.state, 'verified');
} finally { opened.close(); }

const socket = `graph-basis-inspector-read-${process.pid}`;
const session = 'read';
const env = { ...process.env, XDG_CONFIG_HOME: fixture.fixture + '-xdg',
  PATH: process.env.HOME + '/.cache/orca-acceptance/acceptance-bin:' + process.env.PATH };
for (const key of Object.keys(env)) {
  if (/^ORCA_(?:TERMINAL|WORKER|TASK|RUN)(?:_|$)/u.test(key)) delete env[key];
}
const tmux = args => spawnSync('/usr/bin/tmux', ['-L', socket, '-f', '/dev/null', ...args],
  { encoding: 'utf8', env, timeout: 10000 });
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const capture = () => tmux(['capture-pane', '-p', '-t', session]).stdout;
const compact = text => text.replace(/[\s│┃|─╭╮╰╯]/gu, '');
const wait = (predicate, ms = 10000) => {
  const deadline = Date.now() + ms;
  let frame;
  do { frame = capture(); if (predicate(frame)) return frame; sleep(100); } while (Date.now() < deadline);
  throw new Error('frame timeout');
};
const key = name => tmux(['send-keys', '-t', session, name]);
const changed = (name, before, ms = 3000) => {
  key(name);
  const deadline = Date.now() + ms;
  let frame;
  do { frame = capture(); if (frame !== before) return frame; sleep(100); } while (Date.now() < deadline);
  return frame;
};
try {
  const entry = resolve('dist/src/interfaces/cli/main.js');
  assert.equal(tmux(['new-session', '-d', '-s', session, '-x', '220', '-y', '80', '-c', fixture.fixture,
    `${JSON.stringify(process.execPath)} ${JSON.stringify(entry)}`]).status, 0);
  wait(frame => frame.includes('普通消息'), 60000);
  key('C-g');
  let frame = wait(text => text.includes('Graph Inspector'));
  frame = changed('Tab', frame);
  frame = changed('Tab', frame);
  for (let step = 0; step < 8 && !compact(frame).includes(`节点:${target}`); step++) frame = changed('Down', frame);
  assert(compact(frame).includes(`节点:${target}`), 'exact current node must be selected');
  frame = changed('Tab', frame);
  frame = changed('Enter', frame);
  const frames = [frame];
  let unchanged = 0;
  for (let step = 0; step < 100; step++) {
    const next = changed('Down', frame, 250);
    if (next === frame) { if (++unchanged >= 2) break; }
    else { unchanged = 0; frame = next; frames.push(frame); }
  }
  const rendered = frames.map(compact).join('\n');
  assert(rendered.includes(`reconcile:canonical_advance·required${record.requiredBaselineHead}`));
  const report = { observedAt: new Date().toISOString(), fixture: fixture.fixture, workPackageId: target,
    readOnlyUiIntents: true, purpose: 'paused foreground restart and Inspector reading; startup acquires Runtime Lease',
    requiredBaselineHead: record.requiredBaselineHead, observedHead: record.observedHead,
    severity: 'canonical_advance', exactCurrentNodeSelected: true, reconciliationVisible: true, frames };
  writeFileSync(resolve(process.argv[4]), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(JSON.stringify({ workPackageId: target, reconciliationVisible: true }) + '\n');
} finally { key('C-c'); sleep(500); tmux(['kill-server']); }
