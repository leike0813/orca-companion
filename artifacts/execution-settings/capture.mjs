/**
 * Capture the new execution-settings entry (P52 final-dialog seam) at the three finalized tiers.
 * Run pnpm build first. Fixture-only: isolated fake port, defaults 3 / approved 3;
 * saving changes only the default and never auto-authorizes.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { launchTerminal } from 'tuistory';
import { displayWidth } from '../../dist/src/interfaces/tui/render/width.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = new URL('./frames/', import.meta.url);
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
  const filename = name + '-' + size.join('x');
  writeFileSync(new URL(filename + '.txt', output), text + '\n');
  const cells = { ...data, lines: lines.map((line) => ({ ...line, spans: line.spans.flatMap((span) =>
    Array.from(span.text, (character) => ({ ...span, text: character, width: displayWidth(character),
      ...((span.flags & StyleFlags.INVERSE) !== 0 ? { fg: span.fg ?? '#c0caf5', bg: span.bg ?? '#1a1b26' } : {}),
    }))),
  })) };
  writeFileSync(new URL(filename + '.png', output), await renderTerminalToImage(cells));
  records.push({ name, columns: size[0], rows: size[1], png: filename + '.png', text: filename + '.txt' });
}

async function tap(session, key) { await session.press(key); await sleep(60); }
async function run(size, body) {
  const env = { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '1', ORCA_COMPANION_TUI_ICONS: 'nerd' };
  delete env.NO_COLOR;
  const session = await launchTerminal({ command: process.execPath, cwd: root, cols: size[0], rows: size[1], env,
    args: ['scripts/tui-preview.mjs'],
  });
  try { await session.text(); await sleep(1200); await body(session); } finally { session.close(); }
}

for (const size of [[120, 40], [80, 24], [50, 40]]) {
  await run(size, async (session) => {
    // 入口与真实键位一致：命令面板 → 搜索 alias → 执行。
    await tap(session, ['ctrl', 'p']);
    await session.type('concurrency');
    await sleep(400);
    await tap(session, 'enter');
    await sleep(700);
    await shot(session, 'execution-settings-default', size);
    await tap(session, 'backspace');
    await session.type('5');
    await tap(session, 'enter');
    await sleep(700);
    await shot(session, 'execution-settings-saved', size);
    await tap(session, 'r');
    await sleep(1400);
    await shot(session, 'execution-settings-review', size);
    await tap(session, 'esc');
    await tap(session, 'esc');
  });
  process.stdout.write('Saved execution-settings ' + size.join('x') + '\n');
}
writeFileSync(new URL('records.json', output), JSON.stringify(records, null, 2) + '\n');
