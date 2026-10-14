/** Remove only idempotent input-protocol reassertions; never synthesize terminal state. */
export function createAntigravityTuiOutput(write: (bytes: Uint8Array) => void) {
  const settings = new Set(['\x1b[?2004h', '\x1b[>4;2m', '\x1b[=1;1u']);
  const seen = new Set<string>();
  let state: 'plain' | 'escape' | 'csi' | 'string' | 'string-escape' = 'plain';
  let pending: number[] = [], osc = false, utf8Remaining = 0, filtering = true;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  const push = (bytes: Uint8Array) => {
    const output: number[] = [];
    const raw = (values: readonly number[]) => { output.push(...values); seen.clear(); };
    for (const byte of bytes) {
      const continuation = utf8Remaining > 0 && byte >= 0x80 && byte <= 0xbf;
      utf8Remaining = continuation ? utf8Remaining - 1 : byte >= 0xc2 && byte <= 0xdf ? 1
        : byte >= 0xe0 && byte <= 0xef ? 2 : byte >= 0xf0 && byte <= 0xf4 ? 3 : 0;
      if (state === 'string' || state === 'string-escape') {
        raw([byte]);
        if (continuation) { state = 'string'; continue; }
        if (byte === 0x9c || (osc && byte === 7) || (state === 'string-escape' && byte === 0x5c)) state = 'plain';
        else state = byte === 0x1b ? 'string-escape' : 'string';
        continue;
      }
      if (state === 'escape' || state === 'csi') {
        if (byte === 0x1b) { raw(pending); pending = [byte]; state = 'escape'; continue; }
        pending.push(byte);
        // Oversized or non-ASCII control tokens disable suppression, preserving every byte.
        if (pending.length > 64 || byte >= 0x80) {
          raw(pending); pending = []; state = 'plain'; filtering = false; continue;
        }
        if (state === 'escape') {
          if (pending.length === 2 && byte === 0x5b) { state = 'csi'; continue; }
          if (pending.length === 2 && [0x5d, 0x50, 0x58, 0x5e, 0x5f].includes(byte)) {
            osc = byte === 0x5d; raw(pending); pending = []; state = 'string'; continue;
          }
          if (byte >= 0x20 && byte <= 0x2f) continue;
        } else if (byte >= 0x20 && byte <= 0x3f) continue;
        const token = Buffer.from(pending).toString('latin1');
        if (filtering && state === 'csi' && settings.has(token)) {
          if (!seen.has(token)) { output.push(...pending); seen.add(token); }
        } else raw(pending);
        pending = []; state = 'plain';
        continue;
      }
      if (!continuation && byte === 0x1b) { pending = [byte]; state = 'escape'; }
      else if (!continuation && byte === 0x9b) { pending = [byte]; state = 'csi'; }
      else {
        raw([byte]);
        if (!continuation && [0x9d, 0x90, 0x98, 0x9e, 0x9f].includes(byte)) {
          osc = byte === 0x9d; state = 'string';
        }
      }
    }
    if (output.length) write(Buffer.from(output));
    if (pending.length === 0 && pendingTimer !== null) { clearTimeout(pendingTimer); pendingTimer = null; }
    if (pending.length && pendingTimer === null) {
      // An unfinished token must reach Orca promptly rather than resemble output silence.
      pendingTimer = setTimeout(() => {
        write(Buffer.from(pending)); pending = []; seen.clear(); state = 'plain'; filtering = false; pendingTimer = null;
      }, 25);
      pendingTimer.unref();
    }
  };
  const end = () => {
    if (pendingTimer !== null) { clearTimeout(pendingTimer); pendingTimer = null; }
    if (pending.length) write(Buffer.from(pending));
    pending = []; seen.clear(); state = 'plain';
  };
  return { push, end };
}

export const ANTIGRAVITY_TUI_OUTPUT_SOURCE = `const createAntigravityTuiOutput = ${createAntigravityTuiOutput.toString()};\n`;
