/** Capture the user-approved #52 design. Run pnpm build first; no behavior test suite. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { launchTerminal } from 'tuistory';
import { displayWidth } from '../../dist/src/interfaces/tui/render/width.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = new URL('./final/', import.meta.url);
mkdirSync(output, { recursive: true });
const fromTuistory = createRequire(createRequire(import.meta.url).resolve('tuistory'));
const imageModule = fromTuistory.resolve('ghostty-opentui/image');
const { renderTerminalToImage } = await import(imageModule);
const { StyleFlags } = await import(new URL('./ffi.js', pathToFileURL(imageModule)));
const records = [];

async function shot(session, name, size) {
  await session.text();
  const data = session.getTerminalData();
  const lines = data.lines.slice(-data.rows);
  const text = lines.map((line) => line.spans.map((span) => span.text).join('').trimEnd()).join('\n');
  const filename = `${name}-${size.join('x')}`;
  writeFileSync(new URL(`${filename}.txt`, output), text + '\n');
  const cells = { ...data, lines: lines.map((line) => ({ ...line, spans: line.spans.flatMap((span) =>
    Array.from(span.text, (character) => ({ ...span, text: character, width: displayWidth(character),
      ...((span.flags & StyleFlags.INVERSE) !== 0 ? { fg: span.fg ?? '#c0caf5', bg: span.bg ?? '#1a1b26' } : {}),
    }))),
  })) };
  writeFileSync(new URL(`${filename}.png`, output), await renderTerminalToImage(cells));
  records.push({ name, columns: size[0], rows: size[1], png: `${filename}.png`, text: `${filename}.txt` });
}

async function tap(session, key) { await session.press(key); await sleep(60); }
async function command(session, query) {
  await tap(session, ['ctrl', 'p']); await session.type(query); await tap(session, 'enter');
}
async function closeDialog(session) { await tap(session, 'esc'); await tap(session, 'esc'); }
async function run(scene, size, body, standalone = false) {
  const env = { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '1', ORCA_COMPANION_TUI_ICONS: 'nerd' };
  delete env.NO_COLOR;
  const session = await launchTerminal({ command: process.execPath, cwd: root, cols: size[0], rows: size[1], env,
    args: ['scripts/tui-preview.mjs', standalone ? '--graph-prototype' : '--dialog-prototype', scene, ...(standalone ? ['adaptive'] : [])],
  });
  try { await session.text(); await body(session); } finally { session.close(); }
}

for (const size of [[120, 40], [80, 24], [50, 40]]) {
  await run('planning', size, async (session) => {
    await tap(session, ['ctrl', 'p']); await shot(session, 'commands', size); await tap(session, 'esc');
    await tap(session, ['ctrl', 's']); await tap(session, 'down'); await shot(session, 'sessions', size); await tap(session, 'esc');
    await command(session, 'model'); await shot(session, 'models', size);
    await tap(session, 'down'); await tap(session, 'down'); await tap(session, 'enter');
    await shot(session, 'planner-model-menu', size); await tap(session, 'enter'); await shot(session, 'planner-effort', size);
    await tap(session, 'esc'); await closeDialog(session);
    await command(session, 'Execution Authorization');
    for (const [index, name] of ['overview', 'permissions', 'budget', 'scope', 'full'].entries()) {
      if (index > 0) await tap(session, 'tab');
      await shot(session, `authorization-${name}`, size);
    }
    await closeDialog(session);
    await command(session, 'Handoff'); await shot(session, 'handoff-target', size); await tap(session, 'enter');
    for (const [index, name] of ['overview', 'responsibilities', 'binding'].entries()) {
      if (index > 0) await tap(session, 'tab');
      await shot(session, `handoff-${name}`, size);
    }
    await tap(session, 'esc'); await closeDialog(session);
    await command(session, 'Cancel'); await shot(session, 'cancel-return', size);
    await tap(session, 'right'); await shot(session, 'cancel-confirm', size);
    await tap(session, 'tab'); await shot(session, 'cancel-identity', size); await closeDialog(session);
    await tap(session, ['ctrl', 'c']); await shot(session, 'exit', size); await tap(session, 'esc');
  });
  process.stdout.write(`Saved planning ${size.join('x')}\n`);
  await run('execution', size, async (session) => {
    await shot(session, 'sidebar-nerd', size); await tap(session, ['ctrl', 'g']);
    for (const [index, name] of ['evidence', 'scope', 'identity'].entries()) {
      if (index > 0) await tap(session, 'tab');
      await shot(session, `inspector-${name}-nerd`, size);
    }
    await tap(session, 'esc'); await command(session, '选项'); await shot(session, 'options-nerd', size);
    await tap(session, 'down'); await tap(session, 'enter'); await shot(session, 'options-ascii', size);
    await closeDialog(session); await shot(session, 'sidebar-ascii', size);
    await tap(session, ['ctrl', 'g']); await shot(session, 'inspector-ascii', size);
  });
  process.stdout.write(`Saved execution ${size.join('x')}\n`);
  if (size[0] >= 60) await run('execution', size, async (session) => {
    await shot(session, 'standalone-nerd', size); await tap(session, 'o'); await shot(session, 'standalone-options', size);
    await tap(session, 'down'); await tap(session, 'enter'); await shot(session, 'standalone-ascii', size);
  }, true);
}
writeFileSync(new URL('samples.json', output), JSON.stringify({ ticket: 52, capturedAt: new Date().toISOString(),
  renderer: 'tuistory PTY + ghostty-opentui bundled JetBrainsMono Nerd Font and CJK fallback', samples: records }, null, 2) + '\n');
process.stdout.write(`Saved ${records.length} final PNG/text pairs\n`);
