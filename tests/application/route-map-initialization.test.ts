import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRouteMapInitializationPort,
  emptyRouteMapBody,
  type RouteMapTrackerBackend,
} from '../../src/application/planning/route-map-initialization.js';
import { createRouteMapInitializationRecordStore } from '../../src/adapters/storage/route-map-initialization.js';

let root = '';
const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

function setup(backend: RouteMapTrackerBackend) {
  root = mkdtempSync(join(tmpdir(), 'route-map-init-'));
  roots.push(root);
  const records = createRouteMapInitializationRecordStore({
    gitCommonDir: root, repository: 'acme/project', fullBranchRef: 'refs/heads/main',
  });
  return { records, port: createRouteMapInitializationPort({
    repository: 'acme/project', fullBranchRef: 'refs/heads/main', backend, records,
  }) };
}

function backend(overrides: Partial<RouteMapTrackerBackend> = {}): RouteMapTrackerBackend {
  return {
    listCandidates: () => Promise.resolve({ kind: 'ok', value: { candidates: [], exhaustive: true } }),
    readIssue: () => Promise.resolve({ kind: 'failed', code: 'not_found', message: '' }),
    createIssue: () => Promise.resolve({ kind: 'failed', code: 'unknown', message: 'unknown' }),
    ...overrides,
  };
}

describe('Route Map initialization', () => {
  it('verifies an empty created map and reconciles only the same operation marker', async () => {
    let body = '', creates = 0;
    const target = { number: 4, url: 'https://github.com/acme/project/issues/4' };
    const transport = backend({
      createIssue: input => { body = input.body; creates++; return Promise.resolve({ kind: 'failed', code: 'unknown', message: 'lost response' }); },
      listCandidates: () => Promise.resolve({ kind: 'ok', value: { exhaustive: true, candidates: [
        { ...target, title: 'Route Map', body },
        { number: 5, title: 'Route Map', url: 'https://github.com/acme/project/issues/5', body: emptyRouteMapBody() },
      ] } }),
      readIssue: () => Promise.resolve({ kind: 'ok', value: { ...target, title: 'Route Map', body } }),
    });
    const { port } = setup(transport);
    expect(await port.create()).toMatchObject({ kind: 'failed', code: 'create_unresolved' });
    expect(await port.create()).toEqual({ kind: 'ok', value: target });
    expect(await port.create()).toEqual({ kind: 'ok', value: target });
    expect(creates).toBe(1);
    expect(body).toContain(emptyRouteMapBody());
    expect(body).toContain('orca-companion-route-map-operation:');
  });
  it('keeps an unknown create pending and never mutates again', async () => {
    let creates = 0;
    const { port, records } = setup(backend({
      createIssue: () => { creates++; return Promise.resolve({ kind: 'failed', code: 'unknown', message: 'lost response' }); },
    }));
    expect((await port.create()).kind).toBe('failed');
    expect((await port.create()).kind).toBe('failed');
    expect(creates).toBe(1);
    const record = records.read();
    expect(record.kind === 'ok' && record.value?.issue).toBeNull();
  });

  it('accepts an empty Route Map body and rejects the wrong GitHub target', async () => {
    const { port } = setup(backend({
      readIssue: (number) => Promise.resolve({ kind: 'ok', value: {
        number, title: 'Route Map', url: 'https://github.com/acme/project/issues/' + number,
        body: emptyRouteMapBody(),
      } }),
    }));
    expect((await port.select(2)).kind).toBe('ok');
    const wrong = setup(backend({ readIssue: (number) => Promise.resolve({ kind: 'ok', value: {
      number, title: 'Route Map', url: 'https://github.com/other/project/issues/' + number,
      body: emptyRouteMapBody(),
    } }) }));
    expect(await wrong.port.select(2)).toMatchObject({ kind: 'failed', code: 'target_mismatch' });
  });

  it('isolates branches, reuses a pending operation and rejects a stale writer', async () => {
    let creates = 0;
    const { port, records } = setup(backend({ createIssue: () => {
      creates++; return Promise.resolve({ kind: 'ok', value: { number: 1, url: 'https://github.com/acme/project/issues/1' } });
    } }));
    const otherBranch = createRouteMapInitializationRecordStore({
      gitCommonDir: root, repository: 'acme/project', fullBranchRef: 'refs/heads/other',
    });
    expect(otherBranch.read()).toMatchObject({ kind: 'ok', value: null });
    const begun = records.begin({ repository: 'acme/project', fullBranchRef: 'refs/heads/main', title: 'Route Map' });
    if (begun.kind !== 'ok') throw new Error(begun.message);
    expect(await port.create()).toMatchObject({ kind: 'failed', code: 'create_unresolved' });
    expect(creates).toBe(0);
    const target = { number: 1, url: 'https://github.com/acme/project/issues/1' };
    const input = { operationId: begun.value.operationId, expectedRevision: begun.value.revision, issue: target };
    expect(records.recordIssue(input).kind).toBe('ok');
    expect(records.recordIssue({ ...input, issue: { number: 2, url: 'https://github.com/acme/project/issues/2' } }))
      .toMatchObject({ kind: 'failed', code: 'record_conflict' });
    expect(records.read()).toMatchObject({ kind: 'ok', value: { issue: target } });
  });
});
