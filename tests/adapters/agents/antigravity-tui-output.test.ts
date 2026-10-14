import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { createAntigravityTuiOutput } from '../../../src/adapters/agents/antigravity-tui-output.js';
import { codexModelLaunchCommand, writeCodexModelLaunch } from '../../../src/adapters/agents/codex-model-launcher.js';

const protocol = '\x1b[?2004h\x1b[>4;2m\x1b[=1;1u';
function filter(text: string | Buffer, chunkSize: number) {
  const chunks: Buffer[] = [];
  const output = createAntigravityTuiOutput(bytes => chunks.push(Buffer.from(bytes)));
  const bytes = typeof text === 'string' ? Buffer.from(text) : text;
  for (let at = 0; at < bytes.length; at += chunkSize) output.push(bytes.subarray(at, at + chunkSize));
  output.end();
  return Buffer.concat(chunks);
}

describe('Antigravity TUI protocol transport', () => {
  test.each([1, 7, 4096])('filters only repeated settings and preserves text/controls (%i-byte chunks)', size => {
    const body = '中文🌊\r\n\x1b[H\x1b[2J';
    expect(filter(protocol + protocol + body + protocol + protocol, size)).toEqual(Buffer.from(protocol + body + protocol));
  });
  test.each(['\x1b]', '\x1bP', '\x1bX', '\x1b^', '\x1b_'])('does not filter protocol-looking bytes inside %j strings', opening => {
    const text = opening + '中文' + protocol + protocol + '\x1b\\' + protocol + protocol;
    expect(filter(text, 1)).toEqual(Buffer.from(opening + '中文' + protocol + protocol + '\x1b\\' + protocol));
  });
  test('preserves raw C1 strings and UTF-8 continuation bytes', () => {
    const bytes = Buffer.concat([Buffer.from([0x9d]), Buffer.from('Ü' + protocol + protocol), Buffer.from([0x9c]), Buffer.from(protocol + protocol)]);
    expect(filter(bytes, 1)).toEqual(Buffer.concat([Buffer.from([0x9d]), Buffer.from('Ü' + protocol + protocol), Buffer.from([0x9c]), Buffer.from(protocol)]));
  });
  test.each(['\x1b[?2004l', '\x1b[>4m', '\x1b[<1u', '\x1b[?1049l', '\x1b[?1049h', '\x1b]title\x07', '\x1b[?200'])('preserves other tokens and truncated output %j', other => {
    const text = protocol + other;
    expect(filter(text, 1)).toEqual(Buffer.from(text));
  });
  test('bounded oversized tokens disable filtering without dropping bytes', () => {
    const text = '\x1b[' + '1;'.repeat(100) + 'm' + protocol + protocol;
    expect(filter(text, 3)).toEqual(Buffer.from(text));
  });
  test('flushes a stalled partial token and preserves all later bytes', async () => {
    const chunks: Buffer[] = [];
    const output = createAntigravityTuiOutput(bytes => chunks.push(Buffer.from(bytes)));
    output.push(Buffer.from('\x1b['));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(Buffer.concat(chunks)).toEqual(Buffer.from('\x1b['));
    output.push(Buffer.from('?2004h' + protocol + protocol)); output.end();
    expect(Buffer.concat(chunks)).toEqual(Buffer.from('\x1b[?2004h' + protocol + protocol));
  });
});

describe('generated native TUI launcher', () => {
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'ocp-agy-tui-'));
    const native = join(root, 'native.mjs');
    writeFileSync(native, `const value = ${JSON.stringify(protocol + protocol)};
process.stdout.write(value);
process.stdout.write(JSON.stringify({ tty: !!process.stdin.isTTY && !!process.stdout.isTTY, args: process.argv.slice(2) }) + '\\n');
`);
    const args = [native, '中文🌊\n$()\'literal'];
    const descriptor = { version: 2 as const, executable: process.execPath, args, harness: 'antigravity', outputProtocol: 'antigravity-tui' as const };
    return { root, args, descriptor, ...writeCodexModelLaunch({ stateRoot: root, descriptor }) };
  }
  test.each(['pipe', 'wrong-harness', 'unknown-protocol'])('refuses %s before launching the native process', mode => {
    const f = fixture();
    writeFileSync(f.descriptorPath, JSON.stringify({ ...f.descriptor,
      ...(mode === 'wrong-harness' ? { harness: 'codex' } : mode === 'unknown-protocol' ? { outputProtocol: 'unknown' } : {}) }));
    const result = spawnSync(process.execPath, [f.launcherPath, f.descriptorPath], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
  });
  const scriptAvailable = process.platform === 'linux' && spawnSync('script', ['--version'], { timeout: 2000 }).status === 0;
  test.skipIf(!scriptAvailable)('executes generated source with a native PTY and literal arguments', () => {
    const f = fixture();
    const result = spawnSync('script', ['-qec', codexModelLaunchCommand(f), '--echo', 'never', '/dev/null'], { encoding: 'utf8', timeout: 5000 });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.startsWith(protocol)).toBe(true);
    const observed: unknown = JSON.parse(result.stdout.slice(protocol.length).trim());
    expect(observed).toEqual({ tty: true, args: f.args.slice(1) });
  });
});
