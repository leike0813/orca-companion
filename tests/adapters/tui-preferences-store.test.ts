import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import {
  DEFAULT_TUI_PREFERENCES,
  type StatuslinePreferences,
} from '../../src/application/configuration/tui-preferences.js';
import { createTuiPreferencesStore } from '../../src/adapters/storage/tui-preferences-store.js';

let root = '';
let configHome = '';
let filePath = '';

const statusline: StatuslinePreferences = {
  modelFormat: 'provider-model',
  contextFormat: 'remaining',
  progressFormat: 'percent',
  budgetKey: 'recovery',
  fields: ['ticket', 'progress', 'budget'],
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-tui-preferences-'));
  configHome = join(root, 'config');
  filePath = join(configHome, 'orca-companion', 'tui-preferences.json');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test('missing settings load defaults without creating the file', async () => {
  const store = createTuiPreferencesStore({ configHome });

  expect(await store.load()).toEqual({
    kind: 'loaded', preferences: DEFAULT_TUI_PREFERENCES, writable: true, notice: null,
  });
  expect(() => readFileSync(filePath)).toThrow();
});

test('partition saves survive restart and keep the other partition unchanged', async () => {
  const store = createTuiPreferencesStore({ configHome });
  const icons = await store.save({ expectedRevision: 0, patch: { kind: 'icons', iconMode: 'ascii' } });
  if (icons.kind !== 'saved') throw new Error(`expected saved, got ${icons.kind}`);

  const status = await store.save({ expectedRevision: 1, patch: { kind: 'statusline', statusline } });
  if (status.kind !== 'saved') throw new Error(`expected saved, got ${status.kind}`);
  expect(status).toEqual({
    kind: 'saved',
    preferences: { schemaVersion: 1, revision: 2, iconMode: 'ascii', statusline },
  });

  const restarted = createTuiPreferencesStore({ configHome });
  expect(await restarted.load()).toEqual({ kind: 'loaded', preferences: status.preferences, writable: true, notice: null });

  const iconOnly = await restarted.save({ expectedRevision: 2, patch: { kind: 'icons', iconMode: 'nerd' } });
  expect(iconOnly).toMatchObject({ kind: 'saved', preferences: { iconMode: 'nerd', statusline } });
});

test('independent hosts use revision CAS and a conflict returns the latest preferences', async () => {
  const hostA = createTuiPreferencesStore({ configHome });
  const hostB = createTuiPreferencesStore({ configHome });
  const first = await hostA.save({ expectedRevision: 0, patch: { kind: 'icons', iconMode: 'ascii' } });
  if (first.kind !== 'saved') throw new Error(`expected saved, got ${first.kind}`);

  const conflict = await hostB.save({ expectedRevision: 0, patch: { kind: 'statusline', statusline } });
  expect(conflict).toEqual({ kind: 'conflict', preferences: first.preferences });
  expect(await hostB.load()).toMatchObject({ kind: 'loaded', preferences: first.preferences });
});

test.each([
  ['corrupt JSON', '{invalid json'],
  ['future schema', JSON.stringify({ ...DEFAULT_TUI_PREFERENCES, schemaVersion: 2 })],
])('%s loads defaults read-only and cannot overwrite original bytes', async (_label, contents) => {
  mkdirSync(join(configHome, 'orca-companion'), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, contents, 'utf8');
  const store = createTuiPreferencesStore({ configHome });

  expect(await store.load()).toMatchObject({
    kind: 'loaded', preferences: DEFAULT_TUI_PREFERENCES, writable: false,
  });
  expect(await store.save({ expectedRevision: 0, patch: { kind: 'icons', iconMode: 'ascii' } })).toMatchObject({ kind: 'failed' });
  expect(readFileSync(filePath, 'utf8')).toBe(contents);
});

test('unreadable path loads a safe read-only default and saves fail without creating a replacement', async () => {
  const configFile = join(root, 'config-is-file');
  writeFileSync(configFile, 'sentinel');
  const store = createTuiPreferencesStore({ configHome: configFile });

  expect(await store.load()).toMatchObject({ kind: 'loaded', preferences: DEFAULT_TUI_PREFERENCES, writable: false });
  expect(await store.save({ expectedRevision: 0, patch: { kind: 'icons', iconMode: 'ascii' } })).toMatchObject({ kind: 'failed' });
  expect(readFileSync(configFile, 'utf8')).toBe('sentinel');
});

test('duplicate fields fail schema validation and do not change the saved file', async () => {
  const store = createTuiPreferencesStore({ configHome });
  const first = await store.save({ expectedRevision: 0, patch: { kind: 'statusline', statusline } });
  if (first.kind !== 'saved') throw new Error(`expected saved, got ${first.kind}`);
  const before = readFileSync(filePath, 'utf8');

  const invalid = await store.save({
    expectedRevision: 1,
    patch: { kind: 'statusline', statusline: { ...statusline, fields: ['graph', 'graph'] as never } },
  });
  expect(invalid).toMatchObject({ kind: 'failed', code: 'invalid_request' });
  expect(readFileSync(filePath, 'utf8')).toBe(before);
});
