import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

import { modelDefinitionSchema, providerConnectionSchema } from '../../domain/model-configuration.js';
import type { ProviderLibraryRecord, ProviderLibraryStore, ProviderLibraryStoreResult } from '../../application/ports/provider-library-store.js';

export const PROVIDER_LIBRARY_FILENAME = 'providers.json';
export const MAX_PROVIDER_LIBRARY_BYTES = 8 * 1024 * 1024;
export const MAX_PROVIDER_LIBRARY_ENTRIES = 10_000;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const schema = z.strictObject({ schemaVersion: z.literal(1), revision: z.number().int().nonnegative().safe(), connections: z.array(providerConnectionSchema).max(MAX_PROVIDER_LIBRARY_ENTRIES), models: z.array(modelDefinitionSchema).max(MAX_PROVIDER_LIBRARY_ENTRIES) });
const fail = (code: string): ProviderLibraryStoreResult => ({ kind: 'rejected', code, message: code === 'revision_conflict' ? 'Provider library revision conflict' : 'Provider library unavailable or invalid' });

export function providerLibraryPath(options: { path?: string; environment?: Readonly<Record<string, string | undefined>>; homeDirectory?: string } = {}): string {
  if (options.path !== undefined) return resolve(options.path);
  const xdg = (options.environment ?? process.env)['XDG_CONFIG_HOME'];
  return join(typeof xdg === 'string' && isAbsolute(xdg) ? xdg : join(options.homeDirectory ?? homedir(), '.config'), 'orca-companion', PROVIDER_LIBRARY_FILENAME);
}

export class FileProviderLibraryStore implements ProviderLibraryStore {
  private readonly path: string;
  private readonly directory: string;
  constructor(options: { path?: string; environment?: Readonly<Record<string, string | undefined>>; homeDirectory?: string } = {}) {
    this.path = providerLibraryPath(options);
    this.directory = dirname(this.path);
  }
  load(): ProviderLibraryStoreResult {
    const unsafe = this.checkDirectory(true);
    if (unsafe !== null) return unsafe;
    try {
      const stats = lstatSync(this.path);
      if (stats.isSymbolicLink() || !stats.isFile()) return fail('store_invalid');
      if ((stats.mode & 0o077) !== 0) return fail('permission_denied');
      if (stats.size > MAX_PROVIDER_LIBRARY_BYTES) return fail('store_too_large');
      const fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let contents: string;
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.size > MAX_PROVIDER_LIBRARY_BYTES || (opened.mode & 0o077) !== 0) return fail(opened.size > MAX_PROVIDER_LIBRARY_BYTES ? 'store_too_large' : 'store_invalid');
        const buffer = Buffer.allocUnsafe(opened.size);
        let offset = 0;
        while (offset < buffer.length) {
          const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
          if (count === 0) break;
          offset += count;
        }
        if (readSync(fd, Buffer.alloc(1), 0, 1, opened.size) > 0) return fail('store_too_large');
        contents = buffer.subarray(0, offset).toString('utf8');
      } finally { closeSync(fd); }
      const parsed = schema.safeParse(JSON.parse(contents) as unknown);
      if (!parsed.success || new Set(parsed.data.connections.map((x) => x.connectionRef)).size !== parsed.data.connections.length || new Set(parsed.data.models.map((x) => x.modelRef)).size !== parsed.data.models.length) return fail('store_invalid');
      const connections = new Map(parsed.data.connections.map((x) => [x.connectionRef, x]));
      if (parsed.data.models.some((x) => !connections.has(x.connectionRef))) return fail('store_invalid');
      if (parsed.data.connections.length + parsed.data.models.length > MAX_PROVIDER_LIBRARY_ENTRIES) return fail('store_invalid');
      return { kind: 'loaded', library: parsed.data };
    } catch (error) {
      return fail((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'store_invalid');
    }
  }
  save(input: { expectedRevision: number; next: ProviderLibraryRecord }): ProviderLibraryStoreResult {
    const dir = this.checkDirectory(false);
    if (dir !== null) return dir;
    let lock: number;
    try { lock = openSync(`${this.path}.lock`, 'wx', FILE_MODE); } catch (error) { return fail((error as NodeJS.ErrnoException).code === 'EEXIST' ? 'lock_busy' : 'write_failed'); }
    try {
      const current = this.load();
      if (current.kind === 'rejected' && current.code !== 'missing') return current;
      const revision = current.kind === 'loaded' ? current.library.revision : 0;
      if (revision !== input.expectedRevision) return fail('revision_conflict');
      if (input.next.revision !== revision + 1 || input.next.schemaVersion !== 1) return fail('store_invalid');
      const checked = schema.safeParse(input.next);
      if (!checked.success || new Set(input.next.connections.map((x) => x.connectionRef)).size !== input.next.connections.length || new Set(input.next.models.map((x) => x.modelRef)).size !== input.next.models.length) return fail('store_invalid');
      const knownConnections = new Set([...(current.kind === 'loaded' ? current.library.connections : []).map((x) => x.connectionRef), ...input.next.connections.map((x) => x.connectionRef)]);
      const knownModels = new Map([...(current.kind === 'loaded' ? current.library.models : []).map((x) => [x.modelRef, x] as const)]);
      for (const model of input.next.models) { if (!knownConnections.has(model.connectionRef)) return fail('store_invalid'); const old = knownModels.get(model.modelRef); if (old !== undefined && JSON.stringify(old) !== JSON.stringify(model)) return fail('store_invalid'); }
      const priorConnections = current.kind === 'loaded' ? current.library.connections : [];
      const priorModels = current.kind === 'loaded' ? current.library.models : [];
      if (input.next.connections.length < priorConnections.length || input.next.models.length < priorModels.length || priorConnections.some((x, i) => JSON.stringify(x) !== JSON.stringify(input.next.connections[i])) || priorModels.some((x, i) => JSON.stringify(x) !== JSON.stringify(input.next.models[i]))) return fail('store_invalid');
      const payload = `${JSON.stringify(input.next)}\n`;
      if (Buffer.byteLength(payload) > MAX_PROVIDER_LIBRARY_BYTES || input.next.connections.length + input.next.models.length > MAX_PROVIDER_LIBRARY_ENTRIES) return fail('limit_exceeded');
      const tmp = `${this.path}.${randomUUID()}.tmp`;
      try {
        writeFileSync(tmp, payload, { encoding: 'utf8', mode: FILE_MODE, flag: 'wx' });
        const fd = openSync(tmp, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
        renameSync(tmp, this.path);
        const dirFd = openSync(this.directory, 'r'); try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
      } catch {
        try { unlinkSync(tmp); } catch { /* best-effort temporary-file cleanup */ }
        return fail('write_failed');
      }
      const readback = this.load();
      return readback.kind === 'loaded' && JSON.stringify(readback.library) === JSON.stringify(input.next) ? readback : fail('write_failed');
    } finally {
      try { unlinkSync(`${this.path}.lock`); } catch { /* lock may already be gone */ }
      try { closeSync(lock); } catch { /* the write result is already determined */ }
    }
  }
  private checkDirectory(allowMissing: boolean): ProviderLibraryStoreResult | null {
    try {
      if (!allowMissing) mkdirSync(this.directory, { recursive: true, mode: DIRECTORY_MODE });
      const stat = lstatSync(this.directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return fail('store_invalid');
      if ((stat.mode & 0o077) !== 0) return fail('permission_denied');
      return null;
    }
    catch (error) { return allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : fail('permission_denied'); }
  }
}
